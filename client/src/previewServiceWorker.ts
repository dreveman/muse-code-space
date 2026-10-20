// Same-origin Service Worker & URL helpers for the session Preview tab.
//
// In production, the Space SDK bundles `client/src/main.tsx` into a single JS
// file under `./assets/chunk-<hash>.js`. By registering that same bundle script
// as a Service Worker (whose default allowed scope is `./assets/`), every
// request inside `<iframe src="./assets/__preview/<sessionId>/...">` is
// intercepted same-origin and tunneled through the authenticated `previewProxy`
// action to the pilot's loopback proxy (`127.0.0.1:<port>`).
// In `dev/server.ts`, the HTTP server also handles `/assets/__preview/<id>/*`
// and `/__preview/<id>/*` directly as a fallback.

export function isServiceWorkerContext(): boolean {
  return (
    typeof window === "undefined" &&
    typeof self !== "undefined" &&
    "ServiceWorkerGlobalScope" in self
  );
}

/** Build the same-origin preview root URL for a session (`.../assets/__preview/<sessionId>/`). */
export function previewRootUrlForSession(sessionId: string): string {
  const encoded = encodeURIComponent(sessionId);
  if (typeof window === "undefined") return `/assets/__preview/${encoded}/`;
  const base = new URL("./", window.location.href);
  return new URL(`assets/__preview/${encoded}/`, base).toString();
}

/** Extract `{ sessionId, basePath, subpath }` from a preview URL pathname. */
export function parsePreviewRequestPathname(pathname: string): {
  sessionId: string;
  basePath: string;
  subpath: string;
} | null {
  const match = pathname.match(/^(.*?\/(?:assets\/)?__preview\/([^/]+))(\/.*)?$/);
  if (!match) return null;
  const basePath = match[1]!;
  let sessionId = "";
  try {
    sessionId = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  const subpath = match[3] || "/";
  return { sessionId, basePath, subpath };
}

function bytesToBase64Sw(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function base64ToBytesSw(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

let swRegistrationPromise: Promise<boolean> | null = null;
let swRegistrationDone = false;

export function isPreviewServiceWorkerReady(): boolean {
  return swRegistrationDone;
}

/** Register the current bundle as a Service Worker for `./assets/__preview/*`. */
export function ensurePreviewServiceWorkerRegistered(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    swRegistrationDone = true;
    return Promise.resolve(false);
  }
  if (swRegistrationPromise) return swRegistrationPromise;
  swRegistrationPromise = (async () => {
    try {
      const scriptEl = document.querySelector<HTMLScriptElement>('script[type="module"][src*="chunk-"]');
      const scriptSrc = scriptEl?.src;
      if (!scriptSrc) return false;
      const scriptUrl = new URL(scriptSrc, window.location.href);
      const scopeUrl = new URL("./", scriptUrl);
      const reg = await navigator.serviceWorker.register(scriptUrl.toString(), {
        scope: scopeUrl.pathname,
      });
      if (reg.installing || reg.waiting) {
        await new Promise<void>((resolve) => {
          const worker = reg.installing ?? reg.waiting;
          if (!worker) {
            resolve();
            return;
          }
          const timer = window.setTimeout(resolve, 1500);
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              window.clearTimeout(timer);
              resolve();
            }
          });
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      swRegistrationDone = true;
    }
  })();
  return swRegistrationPromise;
}

export function installPreviewServiceWorker(): void {
  const sw = self as unknown as {
    skipWaiting: () => Promise<void>;
    clients: { claim: () => Promise<void> };
    location: Location;
    addEventListener: (type: string, listener: (event: any) => void) => void;
  };

  sw.addEventListener("install", (event) => {
    event.waitUntil(sw.skipWaiting());
  });

  sw.addEventListener("activate", (event) => {
    event.waitUntil(sw.clients.claim());
  });

  sw.addEventListener("fetch", (event) => {
    const req: Request = event.request;
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return;
    }
    if (url.origin !== sw.location.origin) return;

    let target = parsePreviewRequestPathname(url.pathname);
    if (!target && req.referrer) {
      try {
        const refUrl = new URL(req.referrer);
        if (refUrl.origin === sw.location.origin) {
          const refTarget = parsePreviewRequestPathname(refUrl.pathname);
          if (
            refTarget &&
            !url.pathname.endsWith("/actions") &&
            url.pathname !== "/__dev/events" &&
            !/\/chunk-[a-z0-9]+\.(?:js|css)$/i.test(url.pathname)
          ) {
            target = {
              sessionId: refTarget.sessionId,
              basePath: refTarget.basePath,
              subpath: url.pathname,
            };
          }
        }
      } catch {
        // ignore invalid referrer
      }
    }
    if (!target) return;

    const fullPath = `${target.subpath}${url.search}`;
    const actionsUrl = new URL("../actions", new URL("./", sw.location.href)).toString();

    event.respondWith(
      (async () => {
        let bodyBase64: string | null = null;
        if (req.method !== "GET" && req.method !== "HEAD") {
          try {
            const buf = new Uint8Array(await req.arrayBuffer());
            if (buf.length > 0) bodyBase64 = bytesToBase64Sw(buf);
          } catch {
            bodyBase64 = null;
          }
        }
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });

        try {
          const actionRes = await fetch(actionsUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "previewProxy",
              args: {
                session_id: target.sessionId,
                method: req.method,
                path: fullPath,
                headers,
                bodyBase64,
                previewBasePath: target.basePath,
              },
              actionCallId: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            }),
          });
          const payload = (await actionRes.json()) as {
            data?: {
              reachable: boolean;
              status: number;
              statusText: string;
              headers: Record<string, string>;
              bodyBase64: string;
              error: string | null;
            };
            error?: unknown;
          };
          const data = payload?.data;
          if (!data) {
            return new Response("Preview proxy unavailable.", { status: 502 });
          }
          if (!data.reachable && data.error) {
            return new Response(data.error, {
              status: 502,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }
          const bodyBytes = base64ToBytesSw(data.bodyBase64);
          const resHeaders = new Headers();
          for (const [k, v] of Object.entries(data.headers ?? {})) {
            try {
              resHeaders.set(k, v);
            } catch {
              // ignore restricted response headers
            }
          }
          resHeaders.set("cache-control", "no-store");
          const status = data.status >= 100 && data.status <= 599 ? data.status : 200;
          return new Response(
            status === 204 || status === 304 || req.method === "HEAD" ? null : bodyBytes,
            {
              status,
              statusText: data.statusText || "",
              headers: resHeaders,
            },
          );
        } catch (err) {
          return new Response(`Preview error: ${String((err as Error)?.message ?? err)}`, {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
  });
}
