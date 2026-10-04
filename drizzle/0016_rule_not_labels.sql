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
	`filters` text DEFAULT '{"reasons":[],"labels":[],"allLabels":false,"notLabels":[],"states":[],"teams":[],"rerunOnPush":true}' NOT NULL,
	`max_concurrent` integer DEFAULT 3 NOT NULL,
	`project_id` text,
	`workspace` text DEFAULT 'worktree' NOT NULL,
	`model` text,
	`prompt` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_rules`("id", "name", "enabled", "events", "repos", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "created_at", "updated_at") SELECT "id", "name", "enabled", "events", "repos", "reviewer", "channel", "allow_bots", "skip_self_review", "filters", "max_concurrent", "project_id", "workspace", "model", "prompt", "created_at", "updated_at" FROM `rules`;--> statement-breakpoint
DROP TABLE `rules`;--> statement-breakpoint
ALTER TABLE `__new_rules` RENAME TO `rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
UPDATE `rules` SET `filters` = json_set(`filters`, '$.notLabels', json('[]')) WHERE json_type(`filters`, '$.notLabels') IS NULL;