import type { ToolDetails } from "../../server/src/toolDetails";
import { searchMetric, searchPreviewForTool } from "./searchOutput.ts";
// Read/write file views use only verified tool output (read_file) or the
// accepted write_file argument. Unknown/failed calls keep their raw view.
export type FileLine = { number: number; text: string };
export type FilePreview = { lines: FileLine[]; bytes: number; partial: boolean; path: string | null };
const MAX_FILE_PREVIEW_BYTES = 256 * 1024;
const MAX_FILE_PREVIEW_LINES = 10_000;

function contentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
function safePreview(lines: FileLine[], bytes: number, partial: boolean, path: string | null): FilePreview | null {
  if (lines.length > MAX_FILE_PREVIEW_LINES || bytes > MAX_FILE_PREVIEW_BYTES) return null;
  return { lines, bytes, partial, path };
}
export function filePreviewForTool(details: ToolDetails | null): FilePreview | null {
  if (!details || details.status !== "completed" || details.failureReason) return null;
  if (details.tool?.toLowerCase() === "read_file" || details.tool?.toLowerCase() === "read") {
    const output = details.output;
    if (!output || output.length > MAX_FILE_PREVIEW_BYTES || !/^Read text file `[^`\n]+`\.\r?\n/.test(output)) return null;
    const header = /^Read text file `([^`\n]+)`\.\r?\n/.exec(output);
    const body = output.slice(header![0].length);
    const lines: FileLine[] = [];
    for (const row of contentLines(body)) {
      const match = /^(\d+)\|(.*)$/.exec(row);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 ||
          (lines.length > 0 && Number(match[1]) !== lines.at(-1)!.number + 1)) return null;
      lines.push({ number: Number(match[1]), text: match[2]! });
    }
    return safePreview(lines, new TextEncoder().encode(lines.map(line => line.text).join("\n")).length, details.truncated, header![1] ?? null);
  }
  if (details.tool?.toLowerCase() === "write_file") {
    if (!details.args || details.args.length > MAX_FILE_PREVIEW_BYTES * 2) return null;
    let content: unknown;
    try { content = (JSON.parse(details.args) as { content?: unknown }).content; } catch { return null; }
    if (typeof content !== "string") return null;
    const bytes = new TextEncoder().encode(content).length;
    // Only render the submitted content as the written file when Muse's
    // completed result confirms that exact byte count.
    const confirmation = /^wrote (\d+) bytes to /i.exec(details.output ?? "");
    if (!confirmation || Number(confirmation[1]) !== bytes) return null;
    let path: unknown;
    try { path = (JSON.parse(details.args) as { path?: unknown }).path; } catch { return null; }
    return safePreview(contentLines(content).map((text, i) => ({ number: i + 1, text })), bytes, false, typeof path === "string" ? path : null);
  }
  return null;
}
export type ImagePreview = { path: string };
// Binary raster images have no verified text wrapper, so they can never be
// a numbered file view. A completed read of one gets a thumbnail instead,
// loaded from the workspace like Markdown images. SVG is deliberately not
// here: its reads return source text and keep the numbered view above.
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export function imagePreviewForTool(details: ToolDetails | null): ImagePreview | null {
  if (!details || details.status !== "completed" || details.failureReason) return null;
  const tool = details.tool?.toLowerCase();
  if (tool !== "read_file" && tool !== "read") return null;
  if (filePreviewForTool(details)) return null;
  if (!details.args || details.args.length > 200_000) return null;
  let path: unknown;
  try { path = (JSON.parse(details.args) as { path?: unknown }).path; } catch { return null; }
  if (typeof path !== "string" || !path || path.length > 1000 || /[\x00-\x1f\x7f<>]/.test(path) || /^\w+:\/\//.test(path)) return null;
  const ext = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) ? { path } : null;
}
export type SkillPreview = { name: string; scope: string | null; description: string | null; body: string; lines: number; bytes: number };
// A loaded skill is a Markdown document the agent is about to follow, so a
// completed read_skill gets a rendered-Markdown view (see ToolEvent), never
// a numbered file view. Parsing fails closed: no usable name in the args,
// or no body in the output, keeps the generic raw view.
export function skillPreviewForTool(details: ToolDetails | null): SkillPreview | null {
  if (!details || details.status !== "completed" || details.failureReason) return null;
  if (details.tool?.toLowerCase() !== "read_skill") return null;
  const output = details.output;
  if (!output || output.length > MAX_FILE_PREVIEW_BYTES) return null;
  if (!details.args || details.args.length > 200_000) return null;
  let rawName: unknown;
  try { rawName = (JSON.parse(details.args) as { name?: unknown }).name; } catch { return null; }
  if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 200 || /[\x00-\x1f\x7f]/.test(rawName)) return null;
  const argName = rawName.trim();
  let body = output.replace(/\r\n/g, "\n");
  let name = argName.split(/[:\\/]/).at(-1) ?? argName;
  let description: string | null = null;
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (frontmatter) {
    for (const row of frontmatter[1]!.split("\n")) {
      const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(row);
      if (!field) continue;
      const value = field[2]!.trim().replace(/^["']|["']$/g, "");
      if (field[1] === "name" && value) name = value;
      if (field[1] === "description" && value) description = value.slice(0, 300);
    }
    body = body.slice(frontmatter[0].length).replace(/^\n+/, "");
  }
  if (!body.trim()) return null;
  const scope = argName.includes(":") ? argName.split(":")[0]! : null;
  const lines = body.split("\n").length;
  if (lines > MAX_FILE_PREVIEW_LINES) return null;
  return { name, scope, description, body, lines, bytes: new TextEncoder().encode(body).length };
}
export function fileMetric(preview: FilePreview): string {
  const more = preview.partial ? "+" : "";
  if (preview.bytes >= 10 * 1024) return `${Math.round(preview.bytes / 1024)}${more} KB`;
  return `${preview.lines.length}${more} ${preview.lines.length === 1 && !preview.partial ? "line" : "lines"}`;
}

export type ToolViewKind = "plain" | "json" | "diff" | "file" | "command" | "agent-list" | "search" | "skill";
export type ToolPresentation = { adapterId: string; name: string; detail: string | null; view: ToolViewKind; showDuration: boolean; metric: string | null; command: string | null; emphasizeName: boolean };
export type ToolContext = { label: string; details: ToolDetails | null; running: boolean; workspaceRoot: string };

type ToolAdapter = {
  id: string;
  tools: ReadonlySet<string>;
  label: (ctx: ToolContext, args: Record<string, unknown> | null, failed: boolean) => Pick<ToolPresentation, "name" | "detail">;
  view: ToolViewKind;
  /** Opt out only when timing adds no useful signal; all tools show it by default. */
  showDuration?: boolean;
  metric?: (ctx: ToolContext) => string | null;
  command?: (args: Record<string, unknown> | null) => string | null;
  emphasizeName?: (ctx: ToolContext) => boolean;
};

const NAME_LIMIT = 120;
function parseArgs(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > 200_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function displayPath(value: unknown, root: string): string | null {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\x00-\x1f\x7f<>]/.test(value) || /^\w+:\/\//.test(value)) return null;
  // A path outside this workspace may include a username or secret location;
  // use only its basename. Keep useful relative paths within the workspace.
  const path = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value.startsWith("/") ? value.split("/").at(-1)! : value;
  if (!path || path.startsWith("../") || path.includes("/../") || path.length > NAME_LIMIT || !/^[\p{L}\p{N} _./~-]+$/u.test(path)) return null;
  return path;
}
function actionLabel(verb: string, past: string, failed: string, ctx: ToolContext, args: Record<string, unknown> | null): Pick<ToolPresentation, "name" | "detail"> {
  const problem = !!ctx.details?.failureReason || /^(failed|rejected|cancelled|canceled)$/i.test(ctx.details?.status ?? "");
  return { name: ctx.running ? verb : problem ? failed : past, detail: displayPath(args?.path, ctx.workspaceRoot) };
}
const fileStat = (ctx: ToolContext) => { const preview = filePreviewForTool(ctx.details); return preview ? fileMetric(preview) : null; };
function bashDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= 140 && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}
function bashCommand(args: Record<string, unknown> | null): string | null {
  const command = args?.command;
  return typeof command === "string" && command.length <= 200_000 ? command : null;
}
function nonzeroBashExit(ctx: ToolContext): boolean {
  if (ctx.running) return false;
  const reason = ctx.details?.failureReason ?? "";
  const match = /\bprocess exited with status ([1-9]\d*)\b/i.exec(reason);
  return match !== null;
}
function searchPattern(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  return `“${value.length > 90 ? `${value.slice(0, 87)}…` : value}”`;
}
function skillDetail(args: Record<string, unknown> | null): string | null {
  const name = args?.name;
  if (typeof name !== "string") return null;
  const text = name.trim();
  return text && text.length <= 120 && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}
const skillStat = (ctx: ToolContext) => {
  const preview = skillPreviewForTool(ctx.details);
  if (!preview) return null;
  if (preview.bytes >= 10 * 1024) return `${Math.round(preview.bytes / 1024)} KB`;
  return `${preview.lines} ${preview.lines === 1 ? "line" : "lines"}`;
};
function messageFailed(ctx: ToolContext): boolean {
  return !ctx.running && (!!ctx.details?.failureReason || /^(failed|rejected|cancelled|canceled)$/i.test(ctx.details?.status ?? "") ||
    /^Not delivered:/i.test(ctx.details?.output?.trim() ?? ""));
}
function shortDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || /[\x00-\x1f\x7f]/.test(text)) return null;
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}
function githubAction(verb: string, past: string, detail: string | null, ctx: ToolContext, failed: boolean): Pick<ToolPresentation, "name" | "detail"> {
  // GitHub tool errors carry a "Failed:" prefix (MCP isError does not
  // reliably surface as a failed status), like send_message's marker.
  const problem = failed || /^Failed:/i.test(ctx.details?.output?.trim() ?? "");
  return { name: ctx.running ? verb : problem ? `${verb} failed` : past, detail };
}
function githubPrDetail(args: Record<string, unknown> | null): string | null {
  return typeof args?.number === "number" && Number.isInteger(args.number) && args.number > 0 ? `#${args.number}` : null;
}
function githubListDetail(args: Record<string, unknown> | null): string | null {
  return shortDetail(args?.repo) ?? (typeof args?.state === "string" && args.state !== "open" ? args.state : null);
}
function githubMonitorDetail(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const rawList = [
    ...(Array.isArray(args.pr_ids) ? args.pr_ids : []),
    ...(Array.isArray(args.numbers) ? args.numbers : []),
    ...(args.number !== undefined ? [args.number] : []),
  ];
  const labels: string[] = [];
  for (const item of rawList) {
    const num = typeof item === "number"
      ? item
      : typeof item === "string"
        ? Number(item.trim().replace(/^.*#/, ""))
        : NaN;
    if (Number.isInteger(num) && num > 0) {
      const label = `PR #${num}`;
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels.length > 0 ? labels.join(", ") : null;
}
function githubMonitorLabel(ctx: ToolContext, args: Record<string, unknown> | null, failed: boolean): Pick<ToolPresentation, "name" | "detail"> {
  const stopping = args?.stop === true || args?.action === "unsubscribe";
  return githubAction(
    stopping ? "Stopping monitoring" : "Starting monitoring",
    stopping ? "Stopped monitoring" : "Started monitoring",
    githubMonitorDetail(args),
    ctx,
    failed,
  );
}
const adapters: readonly ToolAdapter[] = [
  { id: "bash", tools: new Set(["bash"]), label: (ctx, args) => ({ name: ctx.running ? "Running bash" : "Ran bash", detail: bashDescription(args?.description) }), view: "command", command: bashCommand, emphasizeName: nonzeroBashExit },
  { id: "read", tools: new Set(["read_file", "read"]), label: (ctx, args) => actionLabel("Reading", "Read", "Read failed", ctx, args), view: "file", showDuration: false, metric: fileStat },
  { id: "write", tools: new Set(["write_file"]), label: (ctx, args) => actionLabel("Writing", "Wrote", "Write failed", ctx, args), view: "file", showDuration: false, metric: fileStat },
  { id: "edit", tools: new Set(["edit_file", "edit"]), label: (ctx, args) => actionLabel("Editing", "Edited", "Edit failed", ctx, args), view: "diff", showDuration: false },
  { id: "search", tools: new Set(["search"]), label: (ctx, args, failed) => ({ name: ctx.running ? "Searching" : failed ? "Search failed" : "Searched", detail: searchPattern(args?.pattern) }), view: "search", metric: (ctx) => { const preview = searchPreviewForTool(ctx.details); return preview ? searchMetric(preview) : null; } },
  { id: "skill", tools: new Set(["read_skill"]), label: (ctx, args) => ({ name: ctx.running ? "Reading skill" : ctx.details?.failureReason || /^(failed|rejected|cancelled|canceled)$/i.test(ctx.details?.status ?? "") ? "Read skill failed" : "Read skill", detail: skillDetail(args) }), view: "skill", showDuration: false, metric: skillStat },
  { id: "message", tools: new Set(["mcp__code_space__send_message"]), label: (ctx) => ({ name: ctx.running ? "Sending message" : messageFailed(ctx) ? "Message failed" : "Sent message", detail: null }), view: "plain", emphasizeName: messageFailed },
  { id: "agents", tools: new Set(["mcp__code_space__list_agents"]), label: (ctx) => actionLabel("Listing agents", "Listed agents", "Listing agents failed", ctx, null), view: "agent-list", showDuration: false },
  { id: "github-create-pr", tools: new Set(["mcp__code_space__github_create_pr"]), label: (ctx, args, failed) => githubAction("Creating pull request", "Created pull request", shortDetail(args?.title), ctx, failed), view: "plain" },
  { id: "github-pr-status", tools: new Set(["mcp__code_space__github_pr_status"]), label: (ctx, args, failed) => githubAction("Checking pull request", "Checked pull request", githubPrDetail(args), ctx, failed), view: "plain", showDuration: false },
  { id: "github-list-prs", tools: new Set(["mcp__code_space__github_list_prs"]), label: (ctx, args, failed) => githubAction("Listing pull requests", "Listed pull requests", githubListDetail(args), ctx, failed), view: "plain", showDuration: false },
  { id: "github-monitor-pr", tools: new Set(["mcp__code_space__github_monitor_pr"]), label: githubMonitorLabel, view: "plain", showDuration: false },
  {
    id: "preview-screenshot",
    tools: new Set(["mcp__code_space__preview_screenshot"]),
    label: (ctx, args, failed) =>
      githubAction(
        "Capturing preview",
        "Captured preview",
        typeof args?.port === "number" ? `:${args.port}${typeof args.path === "string" && args.path !== "/" ? args.path : ""}` : shortDetail(args?.title),
        ctx,
        failed,
      ),
    view: "plain",
    showDuration: false,
  },
];

function compactTool(label: string): string {
  return label.split(" · ", 1)[0]?.trim() || "tool";
}
export function toolPresentation(ctx: ToolContext): ToolPresentation {
  if (!ctx.details?.tool) {
    // Rows saved before tool IDs were persisted retain their original label.
    const [name, ...detail] = ctx.label.split(" · ");
    return { adapterId: "legacy", name: name || "tool", detail: detail.join(" · ") || null, view: "plain", showDuration: true, metric: null, command: null, emphasizeName: false };
  }
  const rawTool = (ctx.details.tool?.trim() || compactTool(ctx.label)).replace(/[\x00-\x1f\x7f]/g, "").slice(0, NAME_LIMIT) || "tool";
  const tool = rawTool.toLocaleLowerCase();
  const failed = !!ctx.details?.failureReason || /^(failed|rejected|cancelled|canceled)$/i.test(ctx.details?.status ?? "");
  const adapter = adapters.find((entry) => entry.tools.has(tool));
  if (adapter) {
    const args = parseArgs(ctx.details?.args);
    const label = adapter.label(ctx, args, failed);
    return { adapterId: adapter.id, ...label, view: adapter.view, showDuration: adapter.showDuration ?? true,
      metric: adapter.metric?.(ctx) ?? null, command: adapter.command?.(args) ?? null, emphasizeName: adapter.emphasizeName?.(ctx) ?? false };
  }
  // Unknown tools are still named, never silently hidden. If their result is
  // JSON the expanded view gets token-level syntax highlighting.
  const name = ctx.running ? `Running ${rawTool}` : failed ? `Failed ${rawTool}` : `Ran ${rawTool}`;
  let view: ToolViewKind = "plain";
  const output = ctx.details?.output;
  if (output && output.length <= 200_000) {
    try { JSON.parse(output); view = "json"; } catch { /* plain output */ }
  }
  return { adapterId: "generic", name, detail: null, view, showDuration: true, metric: null, command: null, emphasizeName: false };
}
