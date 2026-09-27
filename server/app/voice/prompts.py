"""Persisted, single-use prompt pool. It contains only generated prompt audio."""

import asyncio
import json
import os
import uuid
from pathlib import Path

from hearsay.phrases import new_phrase


def atomic_write(path: Path, content: bytes):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class PromptPool:
    def __init__(self, directory: Path, synthesize):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.manifest = directory / "pool.json"
        self.synthesize = synthesize
        self.lock = asyncio.Lock()
        self.entries = json.loads(self.manifest.read_text()) if self.manifest.exists() else []
        for entry in self.entries:
            uuid.UUID(entry["id"])
            if not isinstance(entry["used"], bool) or len(entry["phrase"].split()) != 5:
                raise ValueError("invalid prompt manifest")

    def _save(self):
        atomic_write(self.manifest, json.dumps(self.entries).encode())

    async def _top_up(self):
        available = sum(not e["used"] for e in self.entries)
        if available >= 20:
            return
        for _ in range(50 - available):
            phrase = new_phrase()
            identifier = str(uuid.uuid4())
            audio = await self.synthesize(phrase)
            atomic_write(self.directory / f"{identifier}.mp3", audio)
            self.entries.append({"id": identifier, "phrase": phrase, "used": False})
            self._save()

    async def warmup(self):
        async with self.lock:
            await self._top_up()

    async def claim(self):
        async with self.lock:
            # Persist consumption before returning. A restart must never reissue a used phrase.
            await self._top_up()
            entry = next(e for e in self.entries if not e["used"])
            entry["used"] = True
            self._save()
            return entry["id"], entry["phrase"]

    def audio(self, identifier):
        identifier = str(uuid.UUID(identifier))
        return (self.directory / f"{identifier}.mp3").read_bytes()
