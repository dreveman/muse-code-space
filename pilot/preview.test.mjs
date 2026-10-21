// Run: node --test pilot/preview.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleHtmlForSrcdocPreview,
  capturePreviewScreenshot,
  createPreviewWsManager,
  discoverWorkspaceListeningPorts,
  isAllowedPreviewPort,
  normalizePreviewSubpath,
  parseLsofListeningPorts,
  probeLocalPort,
  proxyPreviewHttpRequest,
  rewriteCssForPreview,
  rewriteHtmlForPreview,
  rewriteJsForPreview,
  rewriteLocationHeader,
  rewriteSetCookieHeader,
  transformEsModuleForSrcdoc,
} from "./preview.mjs";

test("isAllowedPreviewPort admits unprivileged loopback ports and rejects service/privileged ports", () => {
  assert.equal(isAllowedPreviewPort(5173), true);
  assert.equal(isAllowedPreviewPort(4173), true);
  assert.equal(isAllowedPreviewPort(3000), true);
  assert.equal(isAllowedPreviewPort(80), false);
  assert.equal(isAllowedPreviewPort(443), false);
  assert.equal(isAllowedPreviewPort(18791), false);
  assert.equal(isAllowedPreviewPort(18792), false);
  assert.equal(isAllowedPreviewPort(18793), false);
  assert.equal(isAllowedPreviewPort(18790), false);
  assert.equal(isAllowedPreviewPort(65536), false);
});

test("normalizePreviewSubpath guards against authority smuggling and preserves query strings", () => {
  assert.equal(normalizePreviewSubpath(""), "/");
  assert.equal(normalizePreviewSubpath("src/main.ts?t=123"), "/src/main.ts?t=123");
  assert.equal(normalizePreviewSubpath("//evil.example.com/a"), "/");
  assert.equal(normalizePreviewSubpath("///sub/page"), "/sub/page");
  assert.equal(normalizePreviewSubpath("https://evil.example.com/a"), "/");
});

test("rewriteLocationHeader keeps redirects inside the session preview root", () => {
  const base = "/assets/__preview/s-1";
  assert.equal(rewriteLocationHeader("/login?next=%2F", 5173, base), "/assets/__preview/s-1/login?next=%2F");
  assert.equal(rewriteLocationHeader("http://127.0.0.1:5173/dashboard#top", 5173, base), "/assets/__preview/s-1/dashboard#top");
  assert.equal(rewriteLocationHeader("http://localhost:5173/app/", 5173, base), "/assets/__preview/s-1/app/");
  assert.equal(rewriteLocationHeader("https://external.example.com/oauth", 5173, base), "https://external.example.com/oauth");
});

test("rewriteSetCookieHeader scopes cookies to the preview base path and strips Domain", () => {
  const base = "/assets/__preview/s-1";
  const rewritten = rewriteSetCookieHeader("sid=abc123; Path=/; Domain=localhost; HttpOnly", base);
  assert.equal(rewritten, "sid=abc123; HttpOnly; Path=/assets/__preview/s-1/; SameSite=Lax");
});

test("rewriteHtmlForPreview, rewriteJsForPreview, and rewriteCssForPreview rewrite root-relative paths", () => {
  const base = "/assets/__preview/s-1";
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script type="module" src="/@vite/client"></script></head><body><a href="/about">About</a><script type="module">import "/src/main.js";</script></body></html>`;
  const outHtml = rewriteHtmlForPreview(html, base, "s-1", 5173);
  assert.ok(outHtml.includes('href="/assets/__preview/s-1/style.css"'));
  assert.ok(outHtml.includes('src="/assets/__preview/s-1/@vite/client"'));
  assert.ok(outHtml.includes('href="/assets/__preview/s-1/about"'));
  assert.ok(outHtml.includes('import "/assets/__preview/s-1/src/main.js"'));
  assert.ok(outHtml.includes('data-code-space-preview="1"'));

  const js = `import { createHotContext } from "/@vite/client";\nimport App from "/src/App.jsx";\nconst dep = await import("/node_modules/.vite/deps/react.js?v=1");`;
  const outJs = rewriteJsForPreview(js, base);
  assert.ok(outJs.includes('from "/assets/__preview/s-1/@vite/client"'));
  assert.ok(outJs.includes('from "/assets/__preview/s-1/src/App.jsx"'));
  assert.ok(outJs.includes('import("/assets/__preview/s-1/node_modules/.vite/deps/react.js?v=1")'));

  const css = `body { background: url(/bg.png); }\n@import "/reset.css";`;
  const outCss = rewriteCssForPreview(css, base);
  assert.ok(outCss.includes("url(/assets/__preview/s-1/bg.png)"));
  assert.ok(outCss.includes('@import "/assets/__preview/s-1/reset.css"'));
});

test("discoverWorkspaceListeningPorts filters listening ports to processes in the session workspace", async () => {
  const lsofListeners = ["p101", "cnode", "n127.0.0.1:5173", "p202", "cpython3", "n*:8000", "p303", "cother", "n127.0.0.1:9000"].join("\n");
  assert.deepEqual(parseLsofListeningPorts(lsofListeners), [
    { pid: 101, command: "node", port: 5173 },
    { pid: 202, command: "python3", port: 8000 },
    { pid: 303, command: "other", port: 9000 },
  ]);

  const ports = await discoverWorkspaceListeningPorts({
    workspaceRoot: "/tmp/ws/session-a",
    exec: async (cmd, args) => {
      if (cmd === "lsof" && args.includes("-sTCP:LISTEN")) return lsofListeners;
      if (cmd === "ps") return "101 100\n202 101\n303 1\n";
      if (cmd === "lsof" && args.includes("cwd")) {
        return ["p100", "n/tmp/ws/session-a", "p202", "n/tmp/ws/session-a/sub", "p303", "n/tmp/ws/other"].join("\n");
      }
      return "";
    },
  });
  assert.deepEqual(ports, [
    { pid: 101, command: "node", port: 5173 },
    { pid: 202, command: "python3", port: 8000 },
  ]);
});

test("proxyPreviewHttpRequest and createPreviewWsManager proxy HTTP, redirects, cookies, and WebSockets over loopback", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "/hello",
        "set-cookie": "session=xyz; Path=/; Domain=localhost",
      });
      res.end();
      return;
    }
    if (req.url === "/echo" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString("utf8") }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><head></head><body><script type="module" src="/main.js"></script></body></html>');
  });

  const upgradeSockets = new Set();
  server.on("upgrade", (req, socket) => {
    upgradeSockets.add(socket);
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const proto = req.headers["sec-websocket-protocol"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : "") +
        "\r\n",
    );
    // Send a greeting text frame ("connected")
    const payload = Buffer.from('{"type":"connected"}', "utf8");
    const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    socket.write(frame);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    assert.equal(await probeLocalPort(port), true);

    const htmlRes = await proxyPreviewHttpRequest({
      port,
      method: "GET",
      path: "/",
      previewBasePath: "/assets/__preview/s1",
      sessionId: "s1",
    });
    assert.equal(htmlRes.reachable, true);
    assert.equal(htmlRes.status, 200);
    const decodedHtml = Buffer.from(htmlRes.bodyBase64, "base64").toString("utf8");
    assert.ok(decodedHtml.includes('src="/assets/__preview/s1/main.js"'));

    const redirectRes = await proxyPreviewHttpRequest({
      port,
      method: "GET",
      path: "/redirect",
      previewBasePath: "/assets/__preview/s1",
      sessionId: "s1",
    });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.location, "/assets/__preview/s1/hello");
    assert.match(redirectRes.headers["set-cookie"], /Path=\/assets\/__preview\/s1\//);

    const postRes = await proxyPreviewHttpRequest({
      port,
      method: "POST",
      path: "/echo",
      bodyBase64: Buffer.from("ping-body", "utf8").toString("base64"),
      previewBasePath: "/assets/__preview/s1",
      sessionId: "s1",
    });
    assert.equal(postRes.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(postRes.bodyBase64, "base64").toString("utf8")), {
      method: "POST",
      body: "ping-body",
    });

    const wsMgr = createPreviewWsManager();
    const opened = wsMgr.open({ sessionId: "s1", clientId: "c1", port, path: "/", protocols: ["vite-hmr"] });
    assert.equal(opened.ok, true);
    await new Promise((r) => setTimeout(r, 80));
    const polled = wsMgr.poll({ sessionId: "s1", since: {} });
    assert.ok(polled.events.some((e) => e.event === "open" && e.protocol === "vite-hmr"));
    assert.ok(polled.events.some((e) => e.event === "message" && e.data === '{"type":"connected"}'));
    wsMgr.closeAllForSession("s1");
  } finally {
    for (const s of upgradeSockets) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("capturePreviewScreenshot saves a preview image in the workspace and returns a clickable Markdown link", async () => {
  const wsDir = mkdtempSync(join(tmpdir(), "preview-shot-test-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>Demo App</title></head><body><h1>Hello Screenshot</h1><p>Ready on loopback</p></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const res = await capturePreviewScreenshot({
      workspaceRoot: wsDir,
      port,
      path: "/",
      title: "Demo App",
    });
    assert.equal(res.ok, true);
    assert.equal(res.port, port);
    assert.match(res.imagePath, /^\.code-space\/preview-\d+\.(?:png|svg)$/);
    assert.equal(res.markdown, `[![Demo App (:${port})](${res.imagePath})](http://127.0.0.1:${port}/)`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(wsDir, { recursive: true, force: true });
  }
});

test("bundleHtmlForSrcdocPreview inlines CSS, ES module graphs, and CSP nonces for cvm-frame srcdoc", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body { background: #111; }");
      return;
    }
    if (req.url === "/src/util.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end('export const greeting = "Hello from ES module";');
      return;
    }
    if (req.url === "/src/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end('import { greeting } from "./util.js"; document.title = greeting;');
      return;
    }
    if (req.url === "/redirect-me") {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script type="module" src="/@vite/client"></script></head><body><script type="module" src="/src/main.js"></script></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const res = await proxyPreviewHttpRequest({
      port,
      method: "GET",
      path: "/redirect-me",
      previewBasePath: "__srcdoc__",
      sessionId: "sess-cvm",
    });
    assert.equal(res.reachable, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-preview-final-path"], "/");
    const bundled = Buffer.from(res.bodyBase64, "base64").toString("utf8");
    assert.ok(bundled.includes('<style data-preview-href="/style.css">body { background: #111; }</style>'));
    assert.ok(bundled.includes('window.__cs_define("/src/util.js"'));
    assert.ok(bundled.includes('window.__cs_define("/src/main.js"'));
    assert.ok(bundled.includes('window.__cs_require("/src/main.js")'));
    assert.ok(bundled.includes('nonce="__CS_CSP_NONCE__"'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


