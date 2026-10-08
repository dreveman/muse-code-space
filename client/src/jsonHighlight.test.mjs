import{test}from'node:test';import assert from'node:assert/strict';import{formatJsonTranscript,tokenizeJson}from'./jsonHighlight.ts';
const details={args:'{"path":"x"}',output:'{"ok":true,"count":2,"items":["x"]}',failureReason:null,truncated:false,outputRef:null,patchRef:null,patchSummary:null,tool:'mystery',status:'completed'};
test('unknown JSON outputs format and highlight keys, values, numbers and literals as text nodes',()=>{
 const text=formatJsonTranscript(details,details.output);assert.ok(text.includes('"ok": true'));
 const tokens=tokenizeJson(text);assert.equal(tokens.map(t=>t.text).join(''),text);
 for(const kind of ['key','string','number','literal'])assert.ok(tokens.some(t=>t.kind===kind),kind);
});
test('malformed or oversized JSON remains plain output',()=>{
 assert.equal(formatJsonTranscript(details,'42')?.includes('Output:\n42'),true);
 assert.equal(formatJsonTranscript(details,'{broken'),null);
 assert.equal(formatJsonTranscript(details,'x'.repeat(200001)),null);
});
