import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newSessionIdentity, randomUuid } from "./sessionWorkspace.ts";

test("new agents get a short opaque workspace independent of their name and full session id", () => {
  const uuid = "5d6f1a7c-0102-4000-9000-a1b2c3d4e5f6";
  const created = newSessionIdentity(uuid, 1234567);
  assert.deepEqual(created, {
    id: "manual-1234567-a1b2c3d4e5f6",
    workspaceRoot: "~/workspace/code/a1b2c3d4e5f6",
  });
  assert.deepEqual(newSessionIdentity(uuid, 1234567), created, "first-prompt retry keeps the same path");
  assert.notEqual(newSessionIdentity("5d6f1a7c-0102-4000-9000-a1b2c3d4e5f7", 1234567).workspaceRoot, created.workspaceRoot);
  assert.equal(created.workspaceRoot.split("/").at(-1).length, 12);
  assert.ok(created.workspaceRoot.startsWith("~/workspace/code/") && !created.workspaceRoot.includes("manual-"));
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("newSessionIdentity(randomUuid(), Date.now())"));
});

test("invalid or non-random UUIDs cannot create a predictable short path", () => {
  assert.throws(() => newSessionIdentity("manual-1234567-a1b2c3d4e5f6", 1));
  assert.throws(() => newSessionIdentity("5d6f1a7c-0102-1000-9000-a1b2c3d4e5f6", 1));
  assert.throws(() => newSessionIdentity("5d6f1a7c-0102-4000-9000-a1b2c3d4e5f6", NaN));
});

test("randomUuid emits unique v4 UUIDs with and without crypto.randomUUID", () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const seen = new Set(Array.from({ length: 200 }, () => randomUuid()));
  assert.equal(seen.size, 200);
  for (const id of seen) assert.match(id, v4);
  // Simulate a non-secure context (e.g. a blob:null preview iframe) where
  // crypto.randomUUID is unavailable: the fallback must still satisfy the
  // session identity validator.
  const cryptoObj = globalThis.crypto;
  const original = cryptoObj.randomUUID;
  cryptoObj.randomUUID = undefined;
  try {
    const fallbackId = randomUuid();
    assert.match(fallbackId, v4);
    assert.ok(newSessionIdentity(fallbackId, 1).workspaceRoot.startsWith("~/workspace/code/"));
  } finally {
    cryptoObj.randomUUID = original;
  }
});
