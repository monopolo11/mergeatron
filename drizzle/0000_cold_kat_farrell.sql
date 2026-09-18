CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`event` text NOT NULL,
	`repos` text DEFAULT '[]' NOT NULL,
	`reviewer` text,
	`project_id` text,
	`workspace` text DEFAULT 'worktree' NOT NULL,
	`model` text,
	`prompt` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`repo` text NOT NULL,
	`status` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`thread_id` text,
	`thread_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_delivery_id_rule_id_unique` ON `runs` (`delivery_id`,`rule_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`runtime_mode` text NOT NULL
);
