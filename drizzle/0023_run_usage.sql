CREATE TABLE `run_usage` (
	`run_id` text PRIMARY KEY NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`models` text NOT NULL,
	`session_ids` text NOT NULL,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_usage_cost_idx` ON `run_usage` (`cost_usd`);--> statement-breakpoint
ALTER TABLE `settings` ADD `usage_includes_delegated_tasks` integer DEFAULT true NOT NULL;