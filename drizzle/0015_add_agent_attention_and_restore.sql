ALTER TABLE `sessions` ADD `needs_user_input` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `restored_at` integer;
--> statement-breakpoint
-- Older code advanced updated_at on every poll and on unrelated edits.
-- Rebuild it from the last recorded prompt or reply so existing agents get
-- accurate "Updated" order immediately after this migration.
UPDATE `sessions`
SET `updated_at` = COALESCE(
  (SELECT MAX(`created_at`) FROM `output_events`
   WHERE `session_id` = `sessions`.`id`
     AND (`kind` IN ('user', 'stdout', 'message')
       OR (`kind` = 'system' AND (`content` LIKE 'You answered "%'
         OR `content` LIKE 'The agent is waiting for your input%')))),
  `started_at`
);
