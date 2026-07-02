ALTER TABLE `files` ADD `review_status` text DEFAULT 'not_reviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE `files` ADD `review_rating` integer;--> statement-breakpoint
ALTER TABLE `files` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `files` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `files` ADD `hidden` integer DEFAULT 0 NOT NULL;
