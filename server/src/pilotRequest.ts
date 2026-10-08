// Keep temporary pilot transport failures distinct from rejected prompts.
export class PilotUnavailableError extends Error {}

export function isPilotUnavailable(error: unknown): boolean {
  return error instanceof PilotUnavailableError;
}

// model/list is already filtered by the user's payment/entitlement access.
// A failed or malformed response is unknown access, never an empty catalog.
export async function readPilotModels(baseUrl: string): Promise<Array<{ id: string; display_name: string }>> {
  return pilotRequest(baseUrl, "/models", { method: "GET" }, {
    parse(value: unknown) {
      if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
        throw new Error("Could not read the available models.");
      }
      return value.models.map((model: unknown) => {
        if (!model || typeof model !== "object" || !("modelId" in model) ||
          typeof model.modelId !== "string" || !model.modelId.trim()) {
          throw new Error("Could not read the available models.");
        }
        return { id: model.modelId, display_name: "displayLabel" in model && typeof model.displayLabel === "string"
          ? model.displayLabel : model.modelId };
      });
    },
  });
}

export async function pilotRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  responseSchema: { parse(value: unknown): T },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PilotUnavailableError("Could not connect. Your message can be retried when the connection returns.", { cause });
    }
    const responseText = await response.text();
    if (!response.ok) {
      let message = "";
      let code: string | null = null;
      try {
        const payload: unknown = JSON.parse(responseText);
        if (typeof payload === "object" && payload !== null) {
          const candidate = "error" in payload ? payload.error : "message" in payload ? payload.message : null;
          if (typeof candidate === "string") message = candidate.trim();
          if ("code" in payload && typeof payload.code === "string") code = payload.code;
        }
      } catch {
        message = responseText.trim();
      }
      // These responses explicitly reject admission during pilot startup or
      // disconnection. Validation/model/session errors must remain visible.
      const unavailable = response.status === 503 && (
        code === "pilot_starting" || code === "pilot_down" ||
        /^pilot (?:is resuming sessions|not connected)/i.test(message)
      );
      const error = unavailable
        ? new PilotUnavailableError(message)
        : new Error(message || `Muse Code request failed (${response.status})`);
      if (code) (error as Error & { code?: string }).code = code;
      throw error;
    }
    return responseSchema.parse(JSON.parse(responseText));
  } finally {
    clearTimeout(timeout);
  }
}
