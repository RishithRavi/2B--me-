import assert from "node:assert/strict";
import { test } from "node:test";

import { boundsFor, isMode, parseArgs, sameOrigin, shellPolicy } from "./geometry";

const display = { x: 0, y: 0, width: 1512, height: 982 };
const work = { x: 0, y: 25, width: 1512, height: 890 };

test("pill sits top-right inside the work area", () => {
  assert.deepEqual(boundsFor("pill", display, work), { x: 1512 - 320 - 12, y: 25 + 12, width: 320, height: 84 });
});

test("panel is centered in the work area", () => {
  const b = boundsFor("panel", display, work);
  assert.equal(b.x, Math.round((1512 - 420) / 2));
  assert.equal(b.y, Math.round(25 + (890 - 540) / 2));
});

test("details expands the pill in place: top-right, clamped to the work area height", () => {
  assert.deepEqual(boundsFor("details", display, work), { x: 1512 - 400 - 12, y: 25 + 12, width: 400, height: 700 });
  const short = { x: 0, y: 25, width: 1280, height: 600 };
  const b = boundsFor("details", display, short);
  assert.equal(b.height, 600 - 24);
  assert.equal(b.x + b.width, 1280 - 12);
});

test("prompt and lock cover the whole display", () => {
  assert.deepEqual(boundsFor("prompt", display, work), display);
  assert.deepEqual(boundsFor("lock", { ...display, x: 1512 }, work), { ...display, x: 1512 });
});

test("isMode guards IPC input", () => {
  assert.ok(isMode("lock"));
  assert.ok(isMode("details"));
  assert.ok(!isMode("fullscreen"));
  assert.ok(!isMode(42));
});

test("parseArgs: flag, env and default", () => {
  assert.deepEqual(parseArgs([], {}), { url: "https://2bme.tech", dev: false, hardLock: false });
  assert.deepEqual(parseArgs(["--dev", "--url=http://localhost:3000/overlay"], {}), {
    url: "http://localhost:3000",
    dev: true,
    hardLock: false,
  });
  assert.equal(parseArgs([], { TWOBME_URL: "https://staging.2bme.tech", TWOBME_HARD_LOCK: "1" }).hardLock, true);
});

test("sameOrigin", () => {
  assert.ok(sameOrigin("https://2bme.tech/verify?c=1", "https://2bme.tech"));
  assert.ok(!sameOrigin("https://evil.example/2bme.tech", "https://2bme.tech"));
  assert.ok(!sameOrigin("not a url", "https://2bme.tech"));
});

test("shellPolicy: no app menu ever; DevTools only with --dev", () => {
  const prod = parseArgs(["--devtools"], {});
  assert.deepEqual(shellPolicy(prod, ["--devtools"]), { devTools: false, openDevToolsOnStart: false, applicationMenu: null });
  const dev = parseArgs(["--dev", "--devtools"], {});
  assert.deepEqual(shellPolicy(dev, ["--dev", "--devtools"]), { devTools: true, openDevToolsOnStart: true, applicationMenu: null });
  assert.equal(shellPolicy(parseArgs(["--dev"], {}), ["--dev"]).openDevToolsOnStart, false);
});
