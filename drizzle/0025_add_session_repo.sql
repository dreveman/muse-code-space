-- Repo picked before a companion's first message (owner/repo), cloned by
-- the pilot into the session workspace before it starts. Null for the
-- default blank generated workspace.
ALTER TABLE sessions ADD COLUMN repo_slug TEXT;
