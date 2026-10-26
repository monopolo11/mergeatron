CREATE TABLE `queue_pause` (
	`id` integer PRIMARY KEY NOT NULL,
	`paused_at` text NOT NULL,
	`resume_at` text,
	`reason` text NOT NULL,
	`run_id` text,
	`thread_url` text
);
