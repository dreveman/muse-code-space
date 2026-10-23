-- User-created companions. Built-in companions stay in companions/catalog.json;
-- only customs are stored here. Ratings are computed from model_id + effort.
CREATE TABLE `custom_companions` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `icon_id` text NOT NULL,
  `character` text NOT NULL DEFAULT '',
  `role` text NOT NULL DEFAULT '',
  `description` text NOT NULL DEFAULT '',
  `skills` text NOT NULL DEFAULT '[]',
  `trade_off` text NOT NULL DEFAULT '',
  `soul` text NOT NULL DEFAULT '',
  `model_id` text NOT NULL DEFAULT 'muse-spark-1.3',
  `effort` text NOT NULL DEFAULT 'medium',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
