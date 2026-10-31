// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";

const REFRESHABLE_AUTH_CODES = new Set([
  "notary_missing",
  "notary_expired",
  "notary_invalid",
  "credential_stale",
]);
const AUTH_REFRESH_REQUIRED_TYPE = "hatch:space-action-auth-refresh-required";
const AUTH_REFRESH_RESULT_TYPE = "hatch:space-action-auth-refresh-result";
const AUTH_REFRESH_TIMEOUT_MS = 10_000;

let latestViewerAssertion: string | null = null;
let inFlightRefresh: Promise<string | null> | null = null;

function extractViewerAssertion(urlLike: string | null | undefined): string | null {
  if (typeof urlLike !== "string" || !urlLike) return null;
  try {
    const base = globalThis.location?.href ?? "https://hatch.invalid/";
    const token = new URL(urlLike, base).searchParams.get("viewer_assertion");
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function applyViewerAssertion(input: RequestInfo | URL, assertion: string | null): RequestInfo | URL {
  if (!assertion || typeof input !== "string") return input;
  try {
    const base = globalThis.location?.href ?? "https://hatch.invalid/";
    const url = new URL(input, base);
    url.searchParams.set("viewer_assertion", assertion);
    return url.toString();
  } catch {
    return input;
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      data.type === AUTH_REFRESH_RESULT_TYPE &&
      data.ok === true &&
      typeof data.iframeSrc === "string"
    ) {
      const token = extractViewerAssertion(data.iframeSrc);
      if (token) latestViewerAssertion = token;
    }
  });
}

function requestSingleHostAuthRefresh(reason: string): Promise<string | null> {
  if (typeof window === "undefined" || window.parent === window) {
    return Promise.resolve(null);
  }
  const requestId = `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("space action auth refresh timed out"));
    }, AUTH_REFRESH_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (typeof data !== "object" || data === null || data.type !== AUTH_REFRESH_RESULT_TYPE || data.requestId !== requestId) {
        return;
      }
      cleanup();
      if (data.ok === true) {
        const token = extractViewerAssertion(data.iframeSrc);
        if (token) latestViewerAssertion = token;
        resolve(token);
        return;
      }
      reject(new Error(typeof data.error === "string" && data.error ? data.error : "space action auth refresh failed"));
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: AUTH_REFRESH_REQUIRED_TYPE, reason, requestId }, "*");
  });
}

async function refreshViewerAssertionSingleFlight(reason: string): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const delays = [0, 600, 1200];
    let lastError: unknown = null;
    for (const delayMs of delays) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        const token = await requestSingleHostAuthRefresh(reason);
        if (token) return token;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  })().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function isRefreshableAuthResponse(response: Response): Promise<string | null> {
  if (response.ok) return null;
  try {
    const cloned = response.clone();
    const body = await cloned.json();
    const code = body?.error?.code;
    if (typeof code === "string" && REFRESHABLE_AUTH_CODES.has(code)) {
      return code;
    }
  } catch {
    // Not a JSON auth error body.
  }
  return null;
}

const actionFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const baseFetch = globalThis.fetch;
    const response = await baseFetch(applyViewerAssertion(input, latestViewerAssertion), init);
    const refreshReason = await isRefreshableAuthResponse(response);
    if (!refreshReason) return response;
    try {
      const refreshedToken = await refreshViewerAssertionSingleFlight(refreshReason);
      if (refreshedToken) {
        return await baseFetch(applyViewerAssertion(input, refreshedToken), init);
      }
    } catch {
      // Fall through and return the original response if host refresh could not complete.
    }
    return response;
  },
  { preconnect: globalThis.fetch?.preconnect ?? (() => {}) },
) as typeof globalThis.fetch;

export const api = createActionClient<typeof Actions>({ fetch: actionFetch });

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
