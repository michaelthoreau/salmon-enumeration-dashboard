CREATE TABLE `file_geofence_tags` (
	`file_id` text NOT NULL,
	`geofence_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `geofences` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`geometry` text NOT NULL,
	`color` text DEFAULT '#ef4444' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);T
