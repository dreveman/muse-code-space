import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newSessionIdentity } from "./sessionWorkspace.ts";

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
  assert.ok(app.includes("newSessionIdentity(crypto.randomUUID(), Date.now())"));
});

test("invalid or non-random UUIDs cannot create a predictable short path", () => {
  assert.throws(() => newSessionIdentity("manual-1234567-a1b2c3d4e5f6", 1));
  assert.throws(() => newSessionIdentity("5d6f1a7c-0102-1000-9000-a1b2c3d4e5f6", 1));
  assert.throws(() => newSessionIdentity("5d6f1a7c-0102-4000-9000-a1b2c3d4e5f6", NaN));
});
