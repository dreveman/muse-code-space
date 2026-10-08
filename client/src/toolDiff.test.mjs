import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{parseStructuredPatch,parseUnifiedDiff,diffDisplayLines,PATCH_LIMIT_BYTES}from'./toolDiff.ts';
const fixture=readFileSync(new URL('../../dev/fixtures/edit-patch.json',import.meta.url),'utf8');

test('observed real Muse patch schema yields file headers, hunk and +/- lines',()=>{
 const doc=parseStructuredPatch(fixture);assert.ok(doc);assert.equal(doc.source,'patch');assert.equal(doc.files[0].path,'test.rs');
 assert.deepEqual(diffDisplayLines(doc).map(r=>r.kind),['file','file','hunk','remove','add','add']);
 assert.equal(diffDisplayLines(doc)[2].text,'@@ -1,1 +1,2 @@');
 assert.deepEqual(diffDisplayLines(doc).slice(3).map(r=>r.lineNumber),[1,1,2],'deletions use old line numbers; additions use new ones');
 assert.equal(parseStructuredPatch(fixture.replace('"test.rs"','"/Users/private/muse/test.rs"')).files[0].path,'test.rs');
});

test('malformed, oversized and inconsistent structured patches fall back rather than fabricate changes',()=>{
 assert.equal(parseStructuredPatch('not json'),null);
 assert.equal(parseStructuredPatch(JSON.stringify({files:[{path:'x',hunks:[{oldStart:1,oldLines:2,newStart:1,newLines:0,lines:['-x']}]}]})),null);
 assert.equal(parseStructuredPatch(' '.repeat(PATCH_LIMIT_BYTES+1)),null);
 assert.equal(parseStructuredPatch(JSON.stringify({files:[{path:'bad\nname',hunks:[]}]})),null);
});

test('diff presentation keeps prefixes, light/dark-compatible colors, and a raw escape hatch',()=>{
 const css=readFileSync(new URL('./theme.css',import.meta.url),'utf8');
 const component=readFileSync(new URL('./RenderedToolDiff.tsx',import.meta.url),'utf8');
 const app=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
 assert.ok(css.includes('.tool-diff-line.add { background: #def1e1; color: #1d4323; }'), 'added rows match the reference background and foreground exactly');
 assert.ok(css.includes('.tool-diff-line.remove { background: #f6d6d9; color: #701416; }'), 'removed rows match the reference background and foreground exactly');
 assert.ok(component.includes('row.text.slice(1)')&&!component.includes('dangerouslySetInnerHTML'));
 assert.ok(component.includes('source === "patch" && first && /^@@ -1') && component.includes('codeLanguageForPath(file.path)'), 'only verified first hunks with a known lexical start can be highlighted');
 assert.ok(component.includes('highlightCode(oldText, file.path, "light")') && component.includes('highlightCode(newText, file.path, "light")'), 'old/new sides tokenize separately against the light diff backgrounds');
 assert.ok(component.includes('index < (first?.lines.length ?? 0)'), 'later hunks always fall back to plain text');
 assert.ok(component.includes('tabIndex={0}') && component.includes('row.lineNumber'), 'all diff lines are in one keyboard-scrollable pane with visible line numbers');
 assert.ok(component.includes('row.kind !== "file" && row.kind !== "hunk"'), 'raw diff headers are omitted');
 assert.ok(!component.includes('rows.slice(') && !component.includes('Show all') && !component.includes('Show fewer'), 'no second diff expansion or collapse control');
 assert.ok(/\.tool-diff\s*\{[^}]*max-height:\s*min\(420px, 48dvh\);[^}]*overflow:\s*auto/.test(css));
 assert.ok(/\.tool-diff\s*\{[^}]*overscroll-behavior-x:\s*contain;\s*overscroll-behavior-y:\s*auto/.test(css), 'vertical gestures chain to the transcript at either edge');
 assert.ok(/\.terminal-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(css), 'the chat itself still contains overscroll within the app');
 assert.ok(component.includes('numberDigits + 1') && component.includes('{row.lineNumber ?? ""}'), 'gutter fits exactly one sign plus the widest number');
 assert.ok(css.includes('grid-template-columns: var(--diff-gutter-width, 3ch) max-content; column-gap: 1ch'), 'one character separates the number and code');
 const gutter = css.match(/\.tool-diff-gutter\s*\{[^}]*\}/)?.[0] ?? '';
 assert.ok(gutter.includes('color: inherit') && gutter.includes('text-align: right') && !/background:|padding:|border:/.test(gutter), 'sign and line numbers inherit the exact row foreground and background');
 assert.ok(/\.output-event\.tool\s*\{[^}]*--tool-output-bg:\s*color-mix\(/.test(css), 'the shared raw-output color is defined on the tool box');
 assert.ok(/\.tool-transcript\s*\{[^}]*background:\s*var\(--tool-output-bg\)/.test(css), 'raw output uses the shared color');
 assert.ok(/\.tool-diff\s*\{[^}]*border:\s*1px solid var\(--tool-output-bg\)/.test(css), 'diff border exactly matches the raw-output box color');
 assert.ok(!app.includes('"View raw output"') && !app.includes('"View diff"'));
 assert.ok(app.includes('RAW_TOOL_OUTPUT_KEY = "muse-code-space:raw-tool-output"') && app.includes('showRawToolOutput={showRawToolOutput}'), 'raw mode is a shared persisted view preference');
 assert.ok(app.includes('manuallyOpenedRef.current || patchInView') && app.includes('new IntersectionObserver('), 'manual expansion fetches immediately while default-expanded offscreen rows wait');
 const menu=readFileSync(new URL('./WireDebug.tsx',import.meta.url),'utf8');
 assert.ok(menu.indexOf('label="Show raw tool output"') < menu.indexOf('label={panelVisible ? "Hide wire log" : "Show wire log"}'));
});

test('strict unified text diff supports multiple files and no-newline markers',()=>{
 const raw=['diff --git a/one.ts b/one.ts','--- a/one.ts','+++ b/one.ts','@@ -1 +1 @@','-old','+new','\\ No newline at end of file','diff --git a/two.ts b/two.ts','--- a/two.ts','+++ b/two.ts','@@ -1,2 +1,2 @@',' context','-a','+b'].join('\n');
 const doc=parseUnifiedDiff(raw);assert.ok(doc);assert.equal(doc.files.length,2);assert.deepEqual(diffDisplayLines(doc).filter(r=>r.kind==='meta').map(r=>r.text),['\\ No newline at end of file']);
 assert.deepEqual(diffDisplayLines(doc).slice(-3).map(r=>r.lineNumber),[1,2,2]);
 assert.equal(parseUnifiedDiff('The edit might produce:\n'+raw),null,'unrelated preamble is not proof of a diff');
 assert.equal(parseUnifiedDiff(raw.replace('@@ -1 +1 @@','@@ -1,2 +1 @@')),null,'invalid hunk counts fall back');
 assert.equal(parseUnifiedDiff('--- a/file\n+++ b/file\nnot a hunk'),null);
});
