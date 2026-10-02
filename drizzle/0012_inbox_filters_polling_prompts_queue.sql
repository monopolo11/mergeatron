CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `rules` ADD `filters` text DEFAULT '{"reasons":[],"labels":[],"allLabels":false,"states":[],"teams":[],"rerunOnPush":true}' NOT NULL;--> statement-breakpoint
ALTER TABLE `rules` ADD `max_concurrent` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `action` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `polling` text DEFAULT '{"github":{"enabled":true,"minutes":3},"linear":{"enabled":true,"minutes":3}}' NOT NULL;