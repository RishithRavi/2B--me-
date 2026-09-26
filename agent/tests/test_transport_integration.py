import asyncio
import json
import pytest
from websockets.asyncio.server import serve
from twobme_agent.transport import Transport, Outbox


def test_websocket_hello_clock_tick_ack(tmp_path):
    async def scenario():
        received = []

        async def server(ws):
            first = json.loads(await ws.recv())
            received.append(first)
            await ws.send(
                json.dumps(
                    {
                        "type": "welcome",
                        "session_id": "session",
                        "device_id": "device",
                        "mode": "monitor",
                    }
                )
            )
            async for raw in ws:
                m = json.loads(raw)
                received.append(m)
                if m["type"] == "clock_ping":
                    await ws.send(
                        json.dumps(
                            {
                                "type": "clock_pong",
                                "t0_ns": m["t0_ns"],
                                "server_ns": m["t0_ns"],
                            }
                        )
                    )
                if m["type"] == "tick":
                    await ws.send(
                        json.dumps(
                            {"type": "trust", "seq": m["seq"], "confidence": 0.9}
                        )
                    )

        out = Outbox(tmp_path / "outbox.sqlite")
        async with serve(server, "127.0.0.1", 0) as endpoint:
            port = endpoint.sockets[0].getsockname()[1]
            t = Transport(
                f"http://127.0.0.1:{port}",
                "TEST_TOKEN",
                {"type": "hello", "run_id": "run", "requested_mode": "monitor"},
                out,
            )
            task = asyncio.create_task(t.run())
            try:
                async with asyncio.timeout(5):
                    while not t.session_id:
                        await asyncio.sleep(0.01)
                    out.put(
                        {
                            "type": "tick",
                            "run_id": "run",
                            "seq": 0,
                            "session_id": "session",
                            "t_end": "2026-01-01T00:00:00.000Z",
                            "flags": {},
                            "blocks": [],
                        }
                    )
                    while out.pending():
                        await asyncio.sleep(0.01)
                assert (
                    received[0]["type"] == "hello"
                    and received[0]["device_token"] == "TEST_TOKEN"
                )
                assert any(m["type"] == "tick" for m in received)
                assert t.hello["resume_session_id"] == "session"
            finally:
                t.stopping = True
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        out.close()

    asyncio.run(scenario())


def test_failed_https_retains_and_success_acks(tmp_path, monkeypatch):
    import httpx

    calls = []
    status = [503]

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            calls.append(kwargs)
            return httpx.Response(status[0], request=httpx.Request("POST", url))

    monkeypatch.setattr("twobme_agent.transport.httpx.AsyncClient", Client)
    out = Outbox(tmp_path / "outbox.sqlite")
    out.put({"run_id": "old", "seq": 7, "session_id": "original", "flags": {}})
    t = Transport("https://example.com", "TEST_TOKEN", {"run_id": "new"}, out)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(t.fallback())
    assert len(out.pending()) == 1
    status[0] = 200
    asyncio.run(t.fallback())
    assert not out.pending()
    assert calls[-1]["json"]["ticks"][0]["session_id"] == "original"
    assert calls[-1]["json"]["ticks"][0]["flags"]["late"]
    out.close()
