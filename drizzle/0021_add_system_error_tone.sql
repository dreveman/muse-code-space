-- A system row can be a neutral recovery notice or a turn/start failure.
-- Record the tone explicitly rather than guessing from arbitrary error text.
ALTER TABLE `output_events` ADD `system_is_error` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Recognize known historical failure messages without recoloring normal
-- restart, stop, answer or workflow notices.
UPDATE `output_events` SET `system_is_error` = 1
WHERE `kind` = 'system' AND (
  `content` LIKE 'Agent could not start:%' OR
  `content` LIKE 'The backend restarted and the turn did not resume.%' OR
  `content` LIKE 'Automatic recovery failed%' OR
  `content` LIKE 'Turn stalled%' OR
  `content` LIKE 'Sending your answer to the agent failed%' OR
  `content` LIKE 'Sending your answer to the companion failed%' OR
  `content` LIKE 'Muse Code reported an error%'
);
