-- A user-uploaded icon is a single image (data URL) used for every artwork
-- slot, instead of a donor companion's animation set.
ALTER TABLE `custom_companions` ADD COLUMN `icon_data_url` text;
