CREATE TABLE `file_points` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`frame` integer DEFAULT 0 NOT NULL
);
