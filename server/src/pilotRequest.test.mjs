import { test } from "node:test";
import assert from "node:assert/strict";
import { pilotRequest, isPilotUnavailable, readPilotModels } from "./pilotRequest.ts";

const schema = { parse: (value) => value };
const request = () => pilotRequest("http://pilot.invalid", "/sessions/test/turns", { method: "POST", body: "{}" }, schema);

test("a refused pilot connection is retryable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(request, (error) => isPilotUnavailable(error));
});

for (const payload of [
  { error: "pilot is resuming sessions", code: "pilot_starting" },
  { error: "pilot not connected", code: "pilot_down" },
  { error: "pilot not connected" },
]) {
  test(`temporary pilot rejection is retryable: ${payload.code ?? "legacy response"}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload, { status: 503 }));
    await assert.rejects(request, (error) => isPilotUnavailable(error));
  });
}

for (const [status, payload] of [
  [400, { error: "Invalid model", code: "invalid_model" }],
  [404, { error: "unknown session", code: "unknown_session" }],
  [503, { error: "existing session could not be recovered", code: "recovery_failed" }],
  [500, { error: "Unexpected failure" }],
]) {
  test(`a real rejection is not silently retried: ${payload.error}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload, { status }));
    await assert.rejects(request, (error) => {
      assert.equal(isPilotUnavailable(error), false);
      assert.equal(error.message, payload.error);
      if (payload.code) assert.equal(error.code, payload.code);
      return true;
    });
  });
}

test("invalid successful responses are not misclassified as disconnection", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(request, (error) => !isPilotUnavailable(error));
});

test("a successful pilot response keeps its parsed payload", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ turnId: "turn-1" }));
  assert.deepEqual(await request(), { turnId: "turn-1" });
});

test("model access reads only the pilot's already-filtered model catalog", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "http://pilot.invalid/models");
    assert.equal(init.method, "GET");
    return Response.json({ models: [{ modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder 1.0" }] });
  });
  assert.deepEqual(await readPilotModels("http://pilot.invalid"),
    [{ id: "muse-wonder-1.0", display_name: "Muse Wonder 1.0" }]);
});

test("a successfully empty model catalog stays empty", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ models: [] }));
  assert.deepEqual(await readPilotModels("http://pilot.invalid"), []);
});

for (const value of [{}, { models: null }, { models: [{}] }, { models: [{ modelId: "" }] }]) {
  test(`a malformed model catalog is not treated as missing entitlement: ${JSON.stringify(value)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(() => readPilotModels("http://pilot.invalid"), /Could not read/);
  });
}

test("offline model discovery stays unknown rather than returning no models", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => readPilotModels("http://pilot.invalid"), isPilotUnavailable);
});
