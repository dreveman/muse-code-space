// Shared by the client and server; no runtime or database imports.
type CompanionModel = {
  model: { preferredId: string; ifUnavailable: string };
};

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
