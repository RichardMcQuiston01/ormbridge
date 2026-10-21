ALTER TABLE `users` RENAME COLUMN `name` TO `full_name`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `nickname`;--> statement-breakpoint
ALTER TABLE `posts` ADD `published` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` RENAME TO `articles`;
