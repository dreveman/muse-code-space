import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchMetric, searchPreviewForTool } from "./searchOutput.ts";
import { toolPresentation } from "./toolPresentation.ts";

// Shape captured from a real Muse 1.4.4 `search` call in an isolated Code
// Space agent: context uses `-line-`, matches `:line:`, and zero hits is "".
const output = 'alpha.txt-1-ALPHA before\nalpha.txt:2:MCS_SEARCH_PROBE first\nalpha.txt-3-ALPHA after\nbeta.txt-1-BETA before\nbeta.txt:2:MCS_SEARCH_PROBE second\nbeta.txt-3-BETA after';
const details = (result = output, more = {}) => ({ tool: 'search', status: 'completed', args: JSON.stringify({ pattern: 'MCS_SEARCH_PROBE', paths: ['.'], output_mode: 'text', context_before: 1, context_after: 1 }), output: result, failureReason: null, truncated: false, outputRef: null, patchRef: null, patchSummary: null, ...more });

test('real native text search rows group by file without counting context as matches', () => {
  const preview = searchPreviewForTool(details());
  assert.deepEqual(preview.groups, [
    { path: 'alpha.txt', lines: [{ number: 1, text: 'ALPHA before', context: true }, { number: 2, text: 'MCS_SEARCH_PROBE first', context: false }, { number: 3, text: 'ALPHA after', context: true }] },
    { path: 'beta.txt', lines: [{ number: 1, text: 'BETA before', context: true }, { number: 2, text: 'MCS_SEARCH_PROBE second', context: false }, { number: 3, text: 'BETA after', context: true }] },
  ]);
  assert.equal(searchMetric(preview), '2 matches · 2 files');
  const p = toolPresentation({ label: 'Ran search', details: details(), running: false, workspaceRoot: '/workspace' });
  assert.equal(p.name, 'Searched'); assert.equal(p.detail, '“MCS_SEARCH_PROBE”'); assert.equal(p.view, 'search'); assert.equal(p.metric, '2 matches · 2 files');
});

test('zero matches is shown honestly, but incomplete results never say no matches', () => {
  assert.equal(searchMetric(searchPreviewForTool(details(''))), 'No matches');
  assert.equal(searchPreviewForTool(details('', { truncated: true })), null);
  assert.equal(searchPreviewForTool(details('', { outputRef: { availability: 'available', byteLen: 100 } })), null);
  const bounded = searchPreviewForTool(details('alpha.txt:2:MCS_SEARCH_PROBE\n[search traversal bounded: reason=max_matches, visited_entries=2, searched_files=1, skipped_dirs=0, skipped_files=0, matches=1]'));
  assert.ok(bounded.partial); assert.equal(searchMetric(bounded), '1+ matches · 1+ files');
  assert.equal(bounded.notes.length, 1);
});

test('files and JSONL modes work; invalid bytes and unexpected lines fall back to raw output', () => {
  const files = searchPreviewForTool(details('alpha.txt\nbeta.txt', { args: JSON.stringify({pattern:'MCS',output_mode:'files_with_matches'}) }));
  assert.equal(files.mode, 'files'); assert.equal(searchMetric(files), '2 files');
  const json = searchPreviewForTool(details('{"type":"match","path":"alpha.txt","line_number":2,"text":"MCS"}\n{"type":"context_after","path":"alpha.txt","line_number":3,"text":"after"}', { args: JSON.stringify({pattern:'MCS',output_mode:'json'}) }));
  assert.equal(searchMetric(json), '1 match · 1 file'); assert.equal(json.groups[0].lines[1].context, true);
  assert.equal(searchPreviewForTool(details('{"type":"match","path":"a.txt","line_number":2,"bytes":"/w=="}', { args: JSON.stringify({pattern:'MCS',output_mode:'json'}) })), null);
  for (const bad of ['unknown search result', 'a.txt:1:line:2:ambiguous', 'a.txt:0:invalid line']) assert.equal(searchPreviewForTool(details(bad)), null);
  assert.equal(searchPreviewForTool(details(output, { status: 'failed', failureReason: 'bad pattern' })), null);
});

test('the search view and raw fallback remain separately reachable', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('presentation.view === "search" && !showRawToolOutput ? searchPreviewForTool(displayDetails) : null'));
  assert.ok(app.includes('<ToolSearchView preview={searchPreview} />'));
  assert.ok(app.includes('!filePreview && !imagePreview && !skillPreview && !searchPreview && !agentList'));
});
