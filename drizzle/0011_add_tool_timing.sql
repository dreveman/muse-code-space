ALTER TABLE `output_events` ADD `item_id` text;
--> statement-breakpoint
ALTER TABLE `output_events` ADD `started_at` integer;
--> statement-breakpoint
ALTER TABLE `output_events` ADD `finished_at` integer;
--> statement-breakpoint
CREATE INDEX `output_events_item_idx` ON `output_events` (`session_id`, `item_id`);
