CREATE TABLE `run_actions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`skip_self_review` integer NOT NULL,
	`project_id` text,
	`workspace` text NOT NULL,
	`model_instance_id` text,
	`model_id` text,
	`preset_id` text,
	`max_concurrent` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preset_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_actions_project_idx` ON `run_actions` (`project_id`);--> statement-breakpoint
CREATE INDEX `run_actions_preset_idx` ON `run_actions` (`preset_id`);--> statement-breakpoint
CREATE INDEX `run_actions_model_idx` ON `run_actions` (`model_id`,`model_instance_id`);--> statement-breakpoint
CREATE TABLE `run_prompts` (
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`owner` text NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`run_id`, `position`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner`,`owner_id`,`version`) REFERENCES `prompt_versions`(`owner`,`owner_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_prompts_version_idx` ON `run_prompts` (`owner`,`owner_id`,`version`);--> statement-breakpoint
ALTER TABLE `runs` ADD `model_instance_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `rating` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `feedback` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `rated_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `settled_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `elapsed_ms` integer;--> statement-breakpoint
CREATE INDEX `runs_rule_status_idx` ON `runs` (`rule_id`,`status`);--> statement-breakpoint
CREATE INDEX `runs_created_at_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `runs_model_idx` ON `runs` (`model_id`,`model_instance_id`);--> statement-breakpoint
INSERT INTO `run_actions` (`run_id`, `name`, `skip_self_review`, `project_id`, `workspace`, `model_instance_id`, `model_id`, `preset_id`, `max_concurrent`)
SELECT `id`, coalesce(json_extract(`action`, '$.name'), `rule_name`), coalesce(json_extract(`action`, '$.skipSelfReview'), 1), json_extract(`action`, '$.projectId'),
  coalesce(json_extract(`action`, '$.workspace'), 'worktree'), json_extract(`action`, '$.model.instanceId'), json_extract(`action`, '$.model.model'),
  (SELECT `id` FROM `prompts` WHERE `id` = json_extract(`runs`.`action`, '$.presetId')), coalesce(json_extract(`action`, '$.maxConcurrent'), 0)
FROM `runs` WHERE `action` IS NOT NULL;--> statement-breakpoint
INSERT INTO `run_prompts` (`run_id`, `position`, `owner`, `owner_id`, `version`)
SELECT `runs`.`id`, 0, 'rule', `rules`.`id`, `rules`.`live_prompt_version` FROM `runs` JOIN `rules` ON `rules`.`id` = `runs`.`rule_id`
WHERE `runs`.`status` = 'queued' AND `runs`.`action` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `action`;