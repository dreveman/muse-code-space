-- Global per-companion statistics, incremented as work happens after this
-- migration lands. Deliberately empty at birth: no backfill from sessions
-- or transcripts, so pre-existing work is never counted.
CREATE TABLE `companion_statistics` (
  `companion_id` text PRIMARY KEY NOT NULL,
  `lines_added` integer NOT NULL DEFAULT 0,
  `lines_removed` integer NOT NULL DEFAULT 0,
  `files_changed` integer NOT NULL DEFAULT 0,
  `tool_calls` integer NOT NULL DEFAULT 0,
  `user_turns` integer NOT NULL DEFAULT 0,
  `runtime_ms` integer NOT NULL DEFAULT 0,
  `last_active_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companion_tracked_prs` (
  `id` text PRIMARY KEY NOT NULL,
  `companion_id` text NOT NULL,
  `repo` text NOT NULL,
  `pr_number` integer NOT NULL,
  `state` text NOT NULL DEFAULT 'open',
  `lines_counted` integer NOT NULL DEFAULT 0,
  `additions` integer,
  `deletions` integer,
  `files_changed` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `merged_at` integer
);
--> statement-breakpoint
CREATE TABLE `companion_counted_sessions` (
  `session_id` text PRIMARY KEY NOT NULL,
  `companion_id` text NOT NULL,
  `counted_at` integer NOT NULL
);
