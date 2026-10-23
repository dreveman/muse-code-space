// Shared by the client and server; no runtime or database imports.
type CompanionModel = {
  model: { preferredId: string; ifUnavailable: string };
};

export type CompanionStats = {
  speed: number;
  thoughtfulness: number;
  creativity: number;
  initiative: number;
};

type ModelStatsParams = { depth: number; creativity: number; speedBase: number; drive: number };

// Parameters that drive the ratings formula. Ratings are derived, never
// authored: a companion's model and effort fully determine its bars.
const MODEL_STATS_PARAMS: Readonly<Record<string, ModelStatsParams>> = {
  "muse-spark-1.3": { depth: 1, creativity: 2, speedBase: 5, drive: 3 },
  "muse-wonder-1.0": { depth: 3, creativity: 4, speedBase: 4, drive: 4.5 },
  "muse-wonder-full-1.0": { depth: 4, creativity: 4, speedBase: 2, drive: 2 },
};
const NEUTRAL_MODEL_PARAMS: ModelStatsParams = { depth: 2, creativity: 3, speedBase: 3, drive: 3 };

function modelStatsParams(modelId: string): ModelStatsParams {
  const exact = MODEL_STATS_PARAMS[modelId];
  if (exact) return exact;
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes("wonder-full") || normalized.includes("wonder_full")) return MODEL_STATS_PARAMS["muse-wonder-full-1.0"]!;
  if (normalized.includes("wonder")) return MODEL_STATS_PARAMS["muse-wonder-1.0"]!;
  if (normalized.includes("spark")) return MODEL_STATS_PARAMS["muse-spark-1.3"]!;
  return NEUTRAL_MODEL_PARAMS;
}

const EFFORT_THINKING: Readonly<Record<string, number>> = {
  none: 0, minimal: 0, low: 0.2, medium: 0.4, high: 0.6, xhigh: 0.8, max: 1, ultra: 1,
};

const clampStat = (value: number) => Math.min(5, Math.max(1, Math.round(value)));

export function computeCompanionStats(modelId: string, effort: string): CompanionStats {
  const params = modelStatsParams(modelId);
  const t = EFFORT_THINKING[effort.trim().toLowerCase()] ?? EFFORT_THINKING.medium!;
  return {
    speed: clampStat(params.speedBase - 4 * t),
    thoughtfulness: clampStat(params.depth + 2 * t),
    creativity: clampStat(params.creativity + 0.5 * t),
    initiative: clampStat(params.drive + (1 - t)),
  };
}

export const MUSE_MODEL_BILLING_URL = "https://dev.meta.ai/billing";
export const PAID_COMPANION_MODELS: Readonly<Record<string, string>> = {
  "muse-wonder-1.0": "Muse Wonder 1.0",
  "muse-wonder-full-1.0": "Muse Wonder Full 1.0",
};

export function modelUpgradeMessage(modelId: string): string {
  return `${PAID_COMPANION_MODELS[modelId] ?? modelId} requires an upgrade. Manage your access at ${MUSE_MODEL_BILLING_URL}`;
}

export type CompanionModelAccess =
  | { status: "ready"; modelId: string }
  | { status: "upgrade-required" }
  | { status: "unavailable" };

export function companionModelAccess(
  companion: CompanionModel,
  models: readonly { id: string }[] | undefined,
): CompanionModelAccess {
  const preferred = companion.model.preferredId;
  const available = models?.find((model) => model.id === preferred);
  if (available) return { status: "ready", modelId: available.id };
  if (companion.model.ifUnavailable === "upgrade-required") {
    return models === undefined ? { status: "unavailable" } : { status: "upgrade-required" };
  }
  if (companion.model.ifUnavailable === "use-catalog-default") {
    return { status: "ready", modelId: models?.[0]?.id ?? preferred };
  }
  return { status: "unavailable" };
}

export function orderCompanionsByAccess<T extends CompanionModel>(
  companions: readonly T[],
  models: readonly { id: string }[] | undefined,
): T[] {
  return [...companions].sort((a, b) =>
    Number(companionModelAccess(a, models).status !== "ready") -
    Number(companionModelAccess(b, models).status !== "ready"));
}
