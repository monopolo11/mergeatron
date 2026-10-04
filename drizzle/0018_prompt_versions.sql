CREATE TABLE `prompt_versions` (
	`owner` text NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`note` text,
	`source` text DEFAULT 'ui' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `owner_id`, `version`)
);
--> statement-breakpoint
ALTER TABLE `prompts` ADD `live_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `rules` ADD `live_prompt_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
INSERT INTO `prompt_versions` (`owner`, `owner_id`, `version`, `body`, `source`, `created_at`) SELECT 'preset', `id`, 1, `body`, 'ui', `updated_at` FROM `prompts`;--> statement-breakpoint
INSERT INTO `prompt_versions` (`owner`, `owner_id`, `version`, `body`, `source`, `created_at`) SELECT 'rule', `id`, 1, `prompt`, 'ui', `updated_at` FROM `rules`;
