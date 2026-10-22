-- Per-checkout commit author override (name/email) picked with the repo
-- in the composer; the pilot applies it as repo-local git config after
-- cloning. Null for sessions that use the global git identity.
ALTER TABLE sessions ADD COLUMN git_author_name TEXT;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN git_author_email TEXT;
