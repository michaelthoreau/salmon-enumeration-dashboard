CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`flight_id` text NOT NULL,
	`key` text NOT NULL,
	`etag` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`uploaded_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`key`);