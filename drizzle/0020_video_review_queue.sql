ALTER TABLE `files` ADD `review_status` text NOT NULL DEFAULT 'not_reviewed';
ALTER TABLE `files` ADD `review_rating` integer;
ALTER TABLE `files` ADD `reviewed_by` text;
ALTER TABLE `files` ADD `reviewed_at` integer;
ALTER TABLE `files` ADD `hidden` integer NOT NULL DEFAULT 0;
