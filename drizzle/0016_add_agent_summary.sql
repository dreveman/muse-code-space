-- The older `summary` column holds run results and failure text; it is
-- reset/replaced by turns. A transcript-based agent description must be
-- optional and independent of that lifecycle.
ALTER TABLE `sessions` ADD `agent_summary` text;
