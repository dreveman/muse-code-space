import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const notice = readFileSync(new URL("./CompanionAccess.tsx", import.meta.url), "utf8");

test("the detail composer suppresses the model notice while connecting", () => {
  // promptConnectionLost is exactly the state the transcript header uses to
  // say the companion "is connecting"; while it holds, the catalog check has
  // not completed and an unavailable verdict would be a guess.
  assert.ok(app.includes("const promptConnectionLost = connectionLost || pilotUnavailable;"));
  assert.ok(app.includes("connecting={connectionLost || pilotUnavailable}"));
  assert.ok(app.includes("{!promptConnectionLost && accessibleModels !== undefined && <CompanionAccessNotice access={detailModelAccess}"));
});

test("the notice itself still reports confirmed states once rendered", () => {
  assert.ok(notice.includes('access.status === "upgrade-required"'));
  assert.ok(notice.includes("This model is unavailable."));
  assert.ok(notice.includes('if (access.status === "ready") return null;'));
});
