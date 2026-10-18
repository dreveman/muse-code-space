import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  // Canonical agent identity; the session label lives in sessionSummary.
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  workspaceRoot: text("workspace_root"),
  // Repo picked in the composer before the first message (`owner/repo`).
  // Stored so a queued first-prompt retry clones the same repo; the pilot
  // clones it into workspaceRoot before the session starts. Null: the
  // companion starts in a blank generated folder.
  repoSlug: text("repo_slug"),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "failed", "stopped"],
  })
    .notNull()
    .default("queued"),
  // Legacy turn result / failure text. Not the assistant-authored session summary.
  summary: text("summary"),
  sessionSummary: text("session_summary"),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Increment on each visible agent/pilot output, including tool updates in
  // place. Only reaching the bottom advances the seen watermark.
  outputRevision: integer("output_revision").notNull().default(0),
  seenOutputRevision: integer("seen_output_revision").notNull().default(0),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  // Restoring an old agent moves it to Active without fabricating a new
  // prompt/reply in updatedAt. A pending question is Priority: Needs you.
  restoredAt: integer("restored_at", { mode: "timestamp_ms" }),
  needsUserInput: integer("needs_user_input", { mode: "boolean" }).notNull().default(false),
  pilotSessionId: text("pilot_session_id"),
  // No pilot id yet: the original prompt is durably queued. This is also a
  // bounded retry lease; if a worker dies mid-attempt, it expires.
  pilotRetryAt: integer("pilot_retry_at", { mode: "timestamp_ms" }),
  // Preserve whether the caller picked a model; null means use the pilot's
  // catalog default rather than our placeholder modelId.
  requestedModelId: text("requested_model_id"),
  pilotSeq: integer("pilot_seq").notNull().default(0),
  pilotBackendId: text("pilot_backend_id"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  modelId: text("model_id").notNull().default("muse-spark-1.3"),
  reasoningEffort: text("reasoning_effort", {
    enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  })
    .notNull()
    .default("high"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const projectReferences = sqliteTable("project_references", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  target: text("target").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const codingModels = sqliteTable("coding_models", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  sortOrder: integer("sort_order").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const outputEvents = sqliteTable("output_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["stdout", "stderr", "system", "result", "user", "tool", "agents", "message", "thinking", "pr_monitor"] })
    .notNull()
    .default("stdout"),
  content: text("content").notNull(),
  // System notices and errors share a kind; severity is explicit so arbitrary
  // model/transport failures render red without guessing from their wording.
  systemIsError: integer("system_is_error", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Tool rows: the pilot item id (one row per tool call, updated in place
  // from inProgress to its terminal revision) and when it started/finished.
  itemId: text("item_id"),
  // Full visible tool arguments/output and an optional stored-output ref.
  // Existing tool rows remain readable with this column null.
  toolDetails: text("tool_details"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});
