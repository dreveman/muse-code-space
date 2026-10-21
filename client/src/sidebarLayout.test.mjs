// Regression test for the sidebar session-row layout: the last-active time
// sits all the way on the right, after the status dot and title.
// Run: node --test client/src/sidebarLayout.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("session time renders after the status dot and title", () => {
  const timeIndex = app.indexOf('<time className="session-time"');
  const dotIndex = app.indexOf('<StatusMark visual={visual} />');
  const titleIndex = app.indexOf('<span className="session-title">{displayTitle}</span>');
  assert.ok(timeIndex !== -1 && dotIndex !== -1 && titleIndex !== -1);
  assert.ok(dotIndex < titleIndex, "status dot must come before the title");
  assert.ok(titleIndex < timeIndex, "time must come last (rightmost)");
});

test("optional summary appears below the sidebar name", () => {
  assert.ok(app.includes('${summary ? " has-summary" : ""}${visual === "unread" ? " unread" : ""}'), "rows grow only when a summary exists");
  assert.ok(app.includes('{summary && <span className="session-summary" title={summary}>{summary}</span>}'));
  assert.ok(/\.session-row\.has-summary\s*\{[^}]*min-height:\s*46px/.test(css));
  assert.ok(/\.session-summary\s*\{[^}]*font:\s*400 10px/.test(css), "summary is smaller and quieter than the name");
});

test("sessions header lives above the sidebar list only", () => {
  const railIndex = app.indexOf('className="session-rail"');
  const headerIndex = app.indexOf('className="command-bar"');
  const detailIndex = app.indexOf('className="detail-pane"');
  assert.ok(railIndex !== -1 && headerIndex !== -1 && detailIndex !== -1);
  assert.ok(railIndex < headerIndex, "sessions header must render inside the sidebar rail");
  assert.ok(headerIndex < detailIndex, "sessions header must not span above the transcript view");
});

test("rail resizes independently while chat content centers", () => {
  assert.ok(
    /\.console-layout\s*\{[^}]*grid-template-columns:\s*clamp\(244px, var\(--sidebar-width, 316px\)/.test(css),
    "sidebar column has a clamped, adjustable width",
  );
  assert.ok(app.includes('label="Resize companion sidebar and chat"'), "sidebar divider can be dragged");
  assert.ok(
    /\.output-stream,\s*\.terminal-prompt,\s*\.transcript-empty\s*\{[^}]*max-width:\s*860px[^}]*margin-inline:\s*auto/.test(css),
    "chat reading content must center at a fixed measure",
  );
});

test("row grid gives the last column to the time", () => {
  const rule = css.match(/\.session-row-select\s*\{[^}]*\}/);
  assert.ok(rule, "expected a .session-row-select rule");
  assert.ok(
    /grid-template-columns:\s*10px\s+minmax\(0,\s*1fr\)\s+auto/.test(rule[0]),
    "last grid column must be auto (time), after the dot and title",
  );
});

test("chat boxes ease from square/full width to rounded as the chat centers", () => {
  const composer = css.match(/^\.terminal-composer\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.ok(/border:\s*1px solid/.test(composer), "input has a top border at every width");
  assert.ok(/--chat-side-border:\s*clamp\(0px, \(100cqw - 860px\) \/ 2, 1px\)/.test(css), "side borders appear with the first gap beside the 860px box");
  assert.ok(/border-left-width:\s*var\(--chat-side-border/.test(css) && /border-right-width:\s*var\(--chat-side-border/.test(css));
  assert.ok(/\.transcript\s*\{\s*container:\s*transcript \/ inline-size;/.test(css), "the transcript is the size container");
  assert.ok(!css.includes("@container transcript (min-width"), "no hard switch");
  const vars = css.match(/^\.transcript\s*\{[^}]*--chat-round:[^}]*\}/m)?.[0] ?? "";
  for (const name of ["--chat-round", "--chat-inset-top", "--chat-inset-bottom"]) {
    assert.ok(new RegExp(`${name}:\\s*clamp\\(0px, \\(100cqw - 880px\\)`).test(vars), `${name} ramps with the column width`);
  }
  assert.ok(/\.terminal-composer\s*\{[^}]*border-radius:\s*var\(--chat-round/.test(css));
  assert.ok(/\.output-event\.user, \.output-event\.tool, \.output-event\.agents, \.output-event\.message\s*\{\s*border-radius:\s*var\(--chat-round/.test(css), "tool runs round as one unified block");
  assert.ok(app.includes('className="output-event tool"'), "consecutive tools share one unified .output-event.tool container");
  // The ramp: ~4px at a 902px column, the full 11px from 940px.
  const radius = (w) => Math.min(11, Math.max(0, (w - 880) * 0.1834));
  assert.ok(radius(902) > 3 && radius(902) < 5 && radius(902) < radius(950) && radius(950) === 11);
});
