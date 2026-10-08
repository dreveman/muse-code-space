import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  resolvePilotUrl: {
    request: z.object({}),
    response: z.object({ baseUrl: z.string().url() }),
    timeoutMs: 5_000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  resolvePilotUrl() {
    const runtime = globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    };
    const configured = runtime.process?.env?.MUSE_CODE_SPACE_PILOT_URL?.trim();
    return {
      baseUrl: (configured || "http://127.0.0.1:18791").replace(/\/+$/, ""),
    };
  },
});
