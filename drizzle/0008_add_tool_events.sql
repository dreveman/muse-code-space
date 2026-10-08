CREATE TABLE output_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'stdout' CHECK (kind IN ('stdout', 'stderr', 'system', 'result', 'user', 'tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO output_events_new (id, session_id, kind, content, created_at)
SELECT id, session_id, kind, content, created_at FROM output_events;
--> statement-breakpoint
DROP TABLE output_events;
--> statement-breakpoint
ALTER TABLE output_events_new RENAME TO output_events;
--> statement-breakpoint
CREATE INDEX output_events_session_id_idx ON output_events(session_id, id);
