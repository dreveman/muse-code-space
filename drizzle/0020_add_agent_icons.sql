-- Images are optional agent metadata. Store them separately so list/get
-- session queries never pull large data URLs into the transcript payload.
CREATE TABLE `agent_icons` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `idle_data_url` text NOT NULL,
  `working_data_url` text NOT NULL,
  `revision` integer NOT NULL DEFAULT 1,
  `updated_at` integer NOT NULL
);
