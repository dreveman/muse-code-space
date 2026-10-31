CREATE TABLE `ui_state` (
  `id` text PRIMARY KEY NOT NULL,
  `selected_session_id` text,
  `selected_companion_id` text,
  `mobile_list_open` integer NOT NULL DEFAULT 1,
  `details_open` integer NOT NULL DEFAULT 0,
  `soul_open` integer NOT NULL DEFAULT 0,
  `spotify_setup_open` integer NOT NULL DEFAULT 0,
  `spotify_client_id` text,
  `spotify_started_state` text,
  `updated_at` integer NOT NULL
);
