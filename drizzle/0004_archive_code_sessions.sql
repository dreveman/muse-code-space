ALTER TABLE `sessions` ADD `archived` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_at` integer;
