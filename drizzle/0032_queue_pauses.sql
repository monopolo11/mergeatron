CREATE TABLE `queue_pauses` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`paused_at` text NOT NULL,
	`resume_at` text,
	`reason` text NOT NULL,
	`run_id` text,
	`thread_url` text
);
