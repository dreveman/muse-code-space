import type { PilotItem } from "./pilotEvents";

export type ToolRef = { id: string; byteLen: number; availability: string; mediaType: string | null; kind: string | null };
export type PatchSummary = { files: number; added: number; removed: number };
export type ToolDetails = {
  tool: string | null;
  status: string | null;
  args: string | null;
  output: string | null;
  failureReason: string | null;
  truncated: boolean;
  outputRef: ToolRef | null;
  patchRef: ToolRef | null;
  patchSummary: PatchSummary | null;
};

function validRef(ref: PilotItem["outputRef"] | unknown): ToolRef | null {
  if (!ref || typeof ref !== "object") return null;
  const value = ref as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || !Number.isSafeInteger(value.byteLen) || (value.byteLen as number) < 0) return null;
  return { id: value.id, byteLen: value.byteLen as number,
    availability: typeof value.availability === "string" ? value.availability : "unknown",
    mediaType: typeof value.mediaType === "string" ? value.mediaType : null,
    kind: typeof value.kind === "string" ? value.kind : null };
}
function validPatchSummary(value: unknown): PatchSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (![record.files, record.added, record.removed].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return null;
  return { files: record.files as number, added: record.added as number, removed: record.removed as number };
}

export function toolDetailsFromItem(item: PilotItem): ToolDetails {
  return {
    tool: item.tool ?? null,
    status: item.status ?? null,
    args: item.args ?? null,
    output: item.visibleOutput ?? null,
    failureReason: item.failureReason ?? null,
    truncated: item.truncated === true,
    outputRef: validRef(item.outputRef),
    patchRef: validRef(item.patchRef),
    patchSummary: validPatchSummary(item.patchSummary),
  };
}

export function parseToolDetails(raw: string | null): ToolDetails | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      tool: typeof value.tool === "string" ? value.tool : null,
      status: typeof value.status === "string" ? value.status : null,
      args: typeof value.args === "string" ? value.args : null,
      output: typeof value.output === "string" ? value.output : null,
      failureReason: typeof value.failureReason === "string" ? value.failureReason : null,
      truncated: value.truncated === true,
      outputRef: validRef(value.outputRef),
      patchRef: validRef(value.patchRef),
      patchSummary: validPatchSummary(value.patchSummary),
    };
  } catch { return null; }
}
