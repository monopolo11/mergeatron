-- Repositories, reasons, states, teams and the label expression become one filter expression:
-- `repo:a and reason:assigned and (state:Todo or state:"In Progress") and team:ENG and (bug or p0)`.
-- Values outside [A-Za-z0-9_./-] are quoted, their own quotes escaped as \"; a label expression holding `or` or a comma is parenthesized when other terms join it.
-- Each present part gets an ` and ` prefix and substr drops the first; concat_ws needs SQLite 3.44, newer than some macOS system builds.
UPDATE `rules` SET `filters` = json_object('query', substr(
	coalesce(' and ' || (SELECT CASE WHEN count(*) > 1 THEN '(' ELSE '' END || group_concat('repo:' || CASE WHEN `value` GLOB '*[^A-Za-z0-9_./-]*' THEN '"' || replace(`value`, '"', '\"') || '"' ELSE `value` END, ' or ') || CASE WHEN count(*) > 1 THEN ')' ELSE '' END FROM json_each(`rules`.`repos`)), '') ||
	coalesce(' and ' || (SELECT CASE WHEN count(*) > 1 THEN '(' ELSE '' END || group_concat('reason:' || CASE WHEN `value` GLOB '*[^A-Za-z0-9_./-]*' THEN '"' || replace(`value`, '"', '\"') || '"' ELSE `value` END, ' or ') || CASE WHEN count(*) > 1 THEN ')' ELSE '' END FROM json_each(`rules`.`filters`, '$.reasons')), '') ||
	coalesce(' and ' || (SELECT CASE WHEN count(*) > 1 THEN '(' ELSE '' END || group_concat('state:' || CASE WHEN `value` GLOB '*[^A-Za-z0-9_./-]*' THEN '"' || replace(`value`, '"', '\"') || '"' ELSE `value` END, ' or ') || CASE WHEN count(*) > 1 THEN ')' ELSE '' END FROM json_each(`rules`.`filters`, '$.states')), '') ||
	coalesce(' and ' || (SELECT CASE WHEN count(*) > 1 THEN '(' ELSE '' END || group_concat('team:' || CASE WHEN `value` GLOB '*[^A-Za-z0-9_./-]*' THEN '"' || replace(`value`, '"', '\"') || '"' ELSE `value` END, ' or ') || CASE WHEN count(*) > 1 THEN ')' ELSE '' END FROM json_each(`rules`.`filters`, '$.teams')), '') ||
	coalesce(' and ' || CASE WHEN trim(coalesce(json_extract(`rules`.`filters`, '$.labels'), '')) = '' THEN NULL
		WHEN (json_array_length(`rules`.`repos`) + json_array_length(`rules`.`filters`, '$.reasons') + json_array_length(`rules`.`filters`, '$.states') + json_array_length(`rules`.`filters`, '$.teams') > 0) AND (lower(' ' || trim(coalesce(json_extract(`rules`.`filters`, '$.labels'), '')) || ' ') GLOB '* or *' OR trim(coalesce(json_extract(`rules`.`filters`, '$.labels'), '')) GLOB '*,*') THEN '(' || trim(coalesce(json_extract(`rules`.`filters`, '$.labels'), '')) || ')'
		ELSE trim(coalesce(json_extract(`rules`.`filters`, '$.labels'), '')) END, ''),
	6), 'rerunOnPush', json(CASE WHEN coalesce(json_extract(`filters`, '$.rerunOnPush'), 1) THEN 'true' ELSE 'false' END));--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`reviewer` text,
	`channel` text,
	`allow_bots` integer DEFAULT true NOT NULL,
	`skip_self_review` integer DEFAULT true NOT NULL,
	`filters` text DEFAULT '{"query":"","rerunOnPush":true}' NOT NULL,
	`max_concurrent` integer DEFAULT 3 NOT NULL,
	`project_id` text,
	`workspace` text DEFAULT 'worktree' NOT NULL,
	`model` text,
	`prompt` text NOT NULL,
	`live_prompt_version` integer DEFAULT 1 NOT NULL,
	`preset_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_rules`("id", "name", "enabled", "events", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "live_prompt_version", "preset_id", "created_at", "updated_at") SELECT "id", "name", "enabled", "events", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "live_prompt_version", "preset_id", "created_at", "updated_at" FROM `rules`;--> statement-breakpoint
DROP TABLE `rules`;--> statement-breakpoint
ALTER TABLE `__new_rules` RENAME TO `rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `parent` text;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `children` text DEFAULT '[]' NOT NULL;