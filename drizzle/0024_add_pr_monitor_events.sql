-- PR monitoring rows are persistent transcript entries updated in place by
-- monitor id. Rebuild the kind CHECK constraint to allow 'pr_monitor' while
-- preserving all columns (including tool_details and system_is_error) and indexes.
CREATE TABLE output_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'stdout' CHECK (kind IN ('stdout', 'stderr', 'system', 'result', 'user', 'tool', 'agents', 'message', 'thinking', 'pr_monitor')),
  content TEXT NOT NULL,
  system_is_error INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  item_id TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  tool_details TEXT
);
--> statement-breakpoint
INSERT INTO output_events_new (id, session_id, kind, content, system_is_error, created_at, item_id, started_at, finished_at, tool_details)
SELECT id, session_id, kind, content, system_is_error, created_at, item_id, started_at, finished_at, tool_details FROM output_events;
--> statement-breakpoint
DROP TABLE output_events;
--> statement-breakpoint
ALTER TABLE output_events_new RENAME TO output_events;
--> statement-breakpoint
CREATE INDEX output_events_session_id_idx ON output_events(session_id, id);
--> statement-breakpoint
CREATE INDEX output_events_item_idx ON output_events(session_id, item_id);
