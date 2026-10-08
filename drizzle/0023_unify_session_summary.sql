ALTER TABLE `sessions` RENAME COLUMN `agent_summary` TO `session_summary`;
--> statement-breakpoint
UPDATE `sessions` SET `session_summary` = COALESCE(NULLIF(TRIM(`task_title`), ''), `session_summary`);
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `task_title`;
--> statement-breakpoint
DROP TABLE `agent_icons`;
