CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`flight_id` text NOT NULL,
	`shape` text NOT NULL,
	`label` text DEFAULT 'fish' NOT NULL,
	`fish_count` integer DEFAULT 1 NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`geometry` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`modified_at` integer NOT NULL,
	`deleted_at` integer
);
