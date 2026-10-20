-- Per-session dev-server preview port on the pilot host (127.0.0.1:<port>).
-- Null until the user attaches the Preview tab to a port.
ALTER TABLE sessions ADD COLUMN preview_port INTEGER;
