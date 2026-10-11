CREATE TABLE `run_pull_requests` (
	`run_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`state` text,
	`is_draft` integer DEFAULT false NOT NULL,
	`linked_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `repository`, `number`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `pull_requests_checked_at` text;