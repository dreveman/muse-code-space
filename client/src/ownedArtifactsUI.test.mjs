import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const side = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("floating controls only offer durable agent-written files in a menu", () => {
  assert.ok(app.includes('api.listOwnedArtifacts({ session_id: selectedId ?? "" })'));
  assert.ok(app.includes('detailQuery.data?.session?.output_revision ?? 0'), "updates as completed writes enter the transcript");
  assert.ok(app.includes('<OwnedArtifactMenu paths={ownedFiles} onOpen={(path) => openFileTab(detailSession.id, path)} />'));
  assert.ok(!app.includes('askToOpenFile('), "the arbitrary-path prompt was removed");
  assert.ok(side.includes('if (paths.length === 0) return null'), "the button is hidden without owned files");
  assert.ok(side.includes('role="menu" aria-label="Companion artifacts"') && side.includes('role="menuitem"'), "the button opens an artifact selector");
  assert.ok(side.includes('aria-label="Open companion artifact" title="Open companion artifact"'));
  assert.ok(/\.chat-floating-actions\s*\{[^}]*display:\s*flex/.test(css), "artifact controls fit beside terminal and menu");
});
