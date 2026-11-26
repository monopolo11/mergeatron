ALTER TABLE `rules` ADD `workflow` text;--> statement-breakpoint
ALTER TABLE `run_actions` ADD `workflow` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `workflow_run_id` text;