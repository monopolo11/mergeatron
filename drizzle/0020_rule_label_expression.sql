PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`repos` text DEFAULT '[]' NOT NULL,
	`reviewer` text,
	`channel` text,
	`allow_bots` integer DEFAULT true NOT NULL,
	`skip_self_review` integer DEFAULT true NOT NULL,
	`filters` text DEFAULT '{"reasons":[],"labels":"","states":[],"teams":[],"rerunOnPush":true}' NOT NULL,
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
INSERT INTO `__new_rules`("id", "name", "enabled", "events", "repos", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "live_prompt_version", "preset_id", "created_at", "updated_at") SELECT "id", "name", "enabled", "events", "repos", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "live_prompt_version", "preset_id", "created_at", "updated_at" FROM `rules`;--> statement-breakpoint
DROP TABLE `rules`;--> statement-breakpoint
ALTER TABLE `__new_rules` RENAME TO `rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Labels (any or all of), allLabels and notLabels become one expression: `(a or b) and !c and !d`.
-- Labels that would not parse back as themselves are quoted. Staged in $.pos and $.neg.
UPDATE `rules` SET `filters` = json_set(`filters`,
	'$.pos', (SELECT group_concat(CASE WHEN `value` GLOB '*[ (),!"]*' OR lower(`value`) IN ('and', 'or') OR lower(`value`) GLOB 'not:*' THEN '"' || `value` || '"' ELSE `value` END,
		CASE WHEN json_extract(`rules`.`filters`, '$.allLabels') THEN ' and ' ELSE ' or ' END) FROM json_each(`rules`.`filters`, '$.labels')),
	'$.neg', (SELECT group_concat('!' || CASE WHEN `value` GLOB '*[ (),!"]*' OR lower(`value`) IN ('and', 'or') OR lower(`value`) GLOB 'not:*' THEN '"' || `value` || '"' ELSE `value` END,
		' and ') FROM json_each(`rules`.`filters`, '$.notLabels'))
) WHERE json_type(`filters`, '$.labels') = 'array';--> statement-breakpoint
UPDATE `rules` SET `filters` = json_remove(json_set(`filters`, '$.labels', CASE
	WHEN json_extract(`filters`, '$.neg') IS NULL THEN coalesce(json_extract(`filters`, '$.pos'), '')
	WHEN json_extract(`filters`, '$.pos') IS NULL THEN json_extract(`filters`, '$.neg')
	WHEN json_array_length(`filters`, '$.labels') > 1 AND NOT coalesce(json_extract(`filters`, '$.allLabels'), 0) THEN '(' || json_extract(`filters`, '$.pos') || ') and ' || json_extract(`filters`, '$.neg')
	ELSE json_extract(`filters`, '$.pos') || ' and ' || json_extract(`filters`, '$.neg')
END), '$.allLabels', '$.notLabels', '$.pos', '$.neg') WHERE json_type(`filters`, '$.labels') = 'array';
