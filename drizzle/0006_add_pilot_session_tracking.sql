ALTER TABLE `sessions` ADD `pilot_session_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `pilot_seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `model_id` text DEFAULT 'muse-spark-1.3' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `reasoning_effort` text DEFAULT 'high' NOT NULL;
