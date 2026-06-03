CREATE TABLE `georef_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`flight_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_images` integer,
	`output_key` text,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
