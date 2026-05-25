CREATE TABLE `labeling_task_points` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
