import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isAsymmetricHorizontalSafeArea,
  parseDeviceQuirksMode,
  resolveIphoneDuoLandscapeQuirk,
} from "./deviceQuirks.ts";

test("detects asymmetric horizontal safe areas and activates iPhone Duo landscape quirk", () => {
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 0, bottom: 0, left: 0 }), false);
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 59, bottom: 21, left: 59 }), false, "symmetric iPhone landscape");
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 0, bottom: 21, left: 47 }), true, "asymmetric iPhone Duo");
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 47, bottom: 21, left: 0 }), true, "asymmetric iPhone Duo right");

  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isLandscape: true,
      insets: { top: 0, right: 0, bottom: 21, left: 47 },
    }),
    true,
  );
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      insets: { top: 47, right: 0, bottom: 34, left: 0 },
    }),
    false,
    "portrait (left=0, right=0) does not add the landscape right border",
  );
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isLandscape: false,
      insets: { top: 0, right: 0, bottom: 21, left: 47 },
    }),
    true,
    "asymmetric horizontal inset activates even when the remaining WebView width beside the native pane is narrower than innerHeight",
  );
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "off",
      isIos: true,
      insets: { top: 0, right: 0, bottom: 21, left: 47 },
    }),
    false,
    "mode=off disables the quirk",
  );
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "force-iphone-duo",
      isIos: false,
      isLandscape: false,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }),
    true,
    "force-iphone-duo enables the quirk regardless of DevTools dock width",
  );
  assert.equal(parseDeviceQuirksMode("off"), "off");
  assert.equal(parseDeviceQuirksMode("force-iphone-duo"), "force-iphone-duo");
  assert.equal(parseDeviceQuirksMode("anything-else"), "auto");

  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(
    css.includes(':root[data-quirk-iphone-duo="true"] .console-layout') &&
      css.includes("border-right: 1px solid var(--border);"),
    "iPhone Duo landscape quirk adds a right-side border separator on .console-layout",
  );
});
