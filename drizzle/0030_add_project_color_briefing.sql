-- Projects gain a color (for color-coded pickers/lists) and a PROJECT.md
-- agent briefing (goals, constraints, working notes) sent to agents as-is.
ALTER TABLE `projects` ADD COLUMN `color` text NOT NULL DEFAULT '#8a8a8a';
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `briefing` text NOT NULL DEFAULT '';
