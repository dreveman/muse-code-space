// Run: node --test client/src/previewTab.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCspNonceToSrcdocHtml,
  parsePreviewRequestPathname,
  previewRootUrlForSession,
} from "./previewServiceWorker.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const side = readFileSync(path.join(root, "SidePanel.tsx"), "utf8");
const preview = readFileSync(path.join(root, "PreviewPanel.tsx"), "utf8");
const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");

test("parsePreviewRequestPathname extracts sessionId, basePath, and subpath", () => {
  assert.deepEqual(parsePreviewRequestPathname("/assets/__preview/sess-1/src/main.ts"), {
    sessionId: "sess-1",
    basePath: "/assets/__preview/sess-1",
    subpath: "/src/main.ts",
  });
  assert.deepEqual(parsePreviewRequestPathname("/spaces/v2/code-space/assets/__preview/s%201/"), {
    sessionId: "s 1",
    basePath: "/spaces/v2/code-space/assets/__preview/s%201",
    subpath: "/",
  });
  assert.equal(parsePreviewRequestPathname("/actions"), null);
  assert.equal(previewRootUrlForSession("abc"), "/assets/__preview/abc/");
  assert.equal(
    applyCspNonceToSrcdocHtml('<script nonce="__CS_CSP_NONCE__">1</script>', "n-123"),
    '<script nonce="n-123">1</script>',
  );
  assert.equal(
    applyCspNonceToSrcdocHtml('<script nonce="__CS_CSP_NONCE__">1</script>', null),
    "<script>1</script>",
  );
});

test("applyCspNonceToSrcdocHtml rewrites only script opening tags, never script bodies", () => {
  // Previewing Code Space in itself inlines this function's own regexes into
  // the srcdoc. A document-wide replace deleted the placeholder there,
  // leaving `html.replace(//g, …)` — `//` comments out the rest of the line,
  // so the enclosing `if (nonce) {` block failed with Unexpected token '}'.
  const body = 'const a = html.replace(/nonce="__CS_CSP_NONCE__"/g, "x"); const b = html.replace(/\\s*nonce="__CS_CSP_NONCE__"/g, "");';
  const doc = `<script nonce="__CS_CSP_NONCE__">${body}</script><script type="module" nonce="__CS_CSP_NONCE__">2</script><p>nonce="__CS_CSP_NONCE__"</p>`;
  assert.equal(
    applyCspNonceToSrcdocHtml(doc, null),
    `<script>${body}</script><script type="module">2</script><p>nonce="__CS_CSP_NONCE__"</p>`,
  );
  assert.equal(
    applyCspNonceToSrcdocHtml(doc, "n-123"),
    `<script nonce="n-123">${body}</script><script type="module" nonce="n-123">2</script><p>nonce="__CS_CSP_NONCE__"</p>`,
  );
  // The preserved body must still parse as JavaScript.
  assert.doesNotThrow(() => new Function(body));
});

test("Preview tab lives in SidePanel with port control, reload button, status states, and WebSocket HMR bridge", () => {
  assert.ok(side.includes('kind: "preview"'), "SideTab includes preview kind");
  assert.ok(side.includes('if (tab.kind === "preview") return "Preview"'), "tab label is Preview");
  assert.ok(app.includes("<NewPreviewButton"), "floating toolbar includes preview toggle button");
  assert.ok(preview.includes('aria-label="Reload preview"'), "Preview tab has a reload button");
  assert.ok(preview.includes("No server listening on 127.0.0.1:"), "dead port surfaces an explicit message with the port named");
  assert.ok(preview.includes("Server on 127.0.0.1:"), "exited server surfaces an explicit exited state");
  assert.ok(preview.includes("code-space:preview-ws-cmd"), "WebSocket HMR bridge is wired");
  assert.ok(actions.includes("setPreviewPort:") && actions.includes("listPreviewPorts:") && actions.includes("previewProxy:") && actions.includes("previewWs:"));
  assert.ok(actions.includes("readSessionImage:"), "readSessionImage action is defined for workspace Markdown images");
  assert.ok(app.includes("MarkdownLinkedImage") && app.includes("markdown-preview-card"), "clickable preview screenshot cards are rendered in Markdown");
});
