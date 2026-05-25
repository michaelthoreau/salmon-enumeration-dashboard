CREATE TABLE `labeling_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`x1` real NOT NULL,
	`y1` real NOT NULL,
	`x2` real NOT NULL,
	`y2` real NOT NULL,
	`frame` integer DEFAULT 0 NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
