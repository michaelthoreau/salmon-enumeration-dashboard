CREATE TABLE `odm_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`flight_id` text NOT NULL,
	`odm_uuid` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`output_key` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
