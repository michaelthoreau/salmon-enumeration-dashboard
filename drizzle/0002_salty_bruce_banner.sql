DROP INDEX "api_keys_key_hash_unique";--> statement-breakpoint
DROP INDEX "files_key_unique";--> statement-breakpoint
DROP INDEX "invites_email_unique";--> statement-breakpoint
DROP INDEX "projects_name_unique";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE `odm_tasks` ALTER COLUMN "status" TO "status" text NOT NULL DEFAULT 'uploading';--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_email_unique` ON `invites` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `odm_tasks` ADD `total_images` integer;