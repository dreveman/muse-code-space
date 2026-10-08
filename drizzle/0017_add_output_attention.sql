-- Start with historical transcripts treated as already seen. New replies,
-- tool revisions, and visible notices advance output_revision from zero;
-- reading to the bottom advances seen_output_revision separately.
ALTER TABLE `sessions` ADD `output_revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `seen_output_revision` integer NOT NULL DEFAULT 0;
