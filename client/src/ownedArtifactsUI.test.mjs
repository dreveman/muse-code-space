import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const side = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("floating controls only offer durable agent-written files in a menu", () => {
  assert.ok(app.includes('api.listOwnedArtifacts({ session_id: selectedId ?? "" })'));
  assert.ok(!app.includes("output_revision ?? 0"), "the query key must not churn per streamed event (that unmounted the button)");
  assert.ok(app.includes('queryKey: ["owned-artifacts", selectedId]') && app.includes("placeholderData: keepPreviousData"), "previous files stay visible during refetch: no flicker");
  assert.ok(app.includes('<OwnedArtifactMenu paths={ownedFiles} onOpen={openFileTabForDetail} />'));
  assert.ok(!app.includes('askToOpenFile('), "the arbitrary-path prompt was removed");
  assert.ok(side.includes('if (paths.length === 0) return null'), "the button is hidden without owned files");
  assert.ok(side.includes('role="menu" aria-label="Companion artifacts"') && side.includes('role="menuitem"'), "the button opens an artifact selector");
  assert.ok(side.includes('aria-label="Open companion artifact" title="Open companion artifact"'));
  assert.ok(/\.chat-floating-actions\s*\{[^}]*display:\s*flex/.test(css), "artifact controls fit beside terminal and menu");
});
