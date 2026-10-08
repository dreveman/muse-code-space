-- Keep the compact tool row label in content. The expanded transcript is
-- recorded separately; older tool rows have no captured details.
ALTER TABLE `output_events` ADD `tool_details` text;
