// On phone-width screens the side panel is a full-screen view with a
// back button, not a vertical split. Run: node --test client/src/mobileSidePanel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const side = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("opening a terminal or artifact enters the mobile side view only when narrow", () => {
  assert.ok(app.includes("if (isNarrow) setMobileSideOpen(true);"), "open actions switch views at narrow widths");
  assert.ok(app.includes('"mobile-side-view"') && app.includes("hasSidePanel && mobileSideOpen"), "layout class is gated on an open panel");
  assert.ok(app.includes("if (!isNarrow) setMobileSideOpen(false);"), "leaving narrow widths restores the split");
});

test("the side view is full-screen with a back button to the conversation", () => {
  assert.ok(side.includes('aria-label="Back to conversation"') && side.includes("onBack"), "tab strip leads with a back button");
  assert.ok(app.includes("onBack={() => setMobileSideOpen(false)}"));
  const mobile = css.slice(css.indexOf("@media (max-width: 779px)"));
  assert.ok(mobile.includes(".mobile-side-view .detail-split > .transcript { display: none; }"), "transcript yields the screen");
  assert.ok(mobile.includes(".mobile-detail-view .side-panel"), "returning to the conversation hides the side panel");
  assert.ok(mobile.includes(".mobile-side-view .side-panel"), "panel fills the screen");
  assert.ok(mobile.includes(".mobile-side-view .session-rail { display: none; }"));
});

test("desktop split behavior is unchanged", () => {
  const desktop = css.slice(css.indexOf("@media (min-width: 780px)"));
  assert.ok(desktop.includes(".detail-split.with-side-panel"), "side-by-side split remains on wide screens");
});
