import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectIphoneDevice,
  isAsymmetricHorizontalSafeArea,
  parseDeviceQuirksMode,
  resolveIphoneDuoLandscapeQuirk,
} from "./deviceQuirks.ts";

test("detects iPhone Duo landscape quirk when right safe-area inset is 0 or asymmetric", () => {
  assert.equal(detectIphoneDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(detectIphoneDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }), false);

  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 0, bottom: 0, left: 0 }), false);
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 59, bottom: 21, left: 59 }), false, "symmetric iPhone landscape");
  assert.equal(isAsymmetricHorizontalSafeArea({ top: 0, right: 0, bottom: 21, left: 47 }), true, "asymmetric iPhone Duo");

  // iPhone Duo in landscape: left=0, right=0, bottom=0 -> activates!
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isIphone: true,
      isLandscape: true,
      viewportWidth: 867,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }),
    true,
    "iPhone Duo in landscape with left=0, right=0, bottom=0 activates the right border",
  );

  // iPhone Duo folded in portrait (native sidebar still on the right):
  // width=382, height=678, top=0, right=0, bottom=0, left=0 -> activates!
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isIphone: true,
      isLandscape: false,
      viewportWidth: 382,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }),
    true,
    "iPhone Duo folded in portrait with right native sidebar (insets all 0) activates the right border",
  );

  // iPhone Duo in portrait: bottom=34 -> does NOT activate.
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isIphone: true,
      isLandscape: false,
      viewportWidth: 400,
      insets: { top: 47, right: 0, bottom: 34, left: 0 },
    }),
    false,
    "portrait (bottom=34) does not add the landscape right border",
  );

  // Standard full-bleed iPhone in landscape: left=59, right=59 -> does NOT activate.
  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "auto",
      isIos: true,
      isIphone: true,
      isLandscape: true,
      viewportWidth: 844,
      insets: { top: 0, right: 59, bottom: 21, left: 59 },
    }),
    false,
    "standard full-bleed iPhone in landscape has symmetric non-zero right inset",
  );

  assert.equal(
    resolveIphoneDuoLandscapeQuirk({
      mode: "off",
      isIos: true,
      isIphone: true,
      isLandscape: true,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
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
