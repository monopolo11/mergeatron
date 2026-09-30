CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`pr_number` text NOT NULL,
	`pr_url` text NOT NULL,
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`permalink` text,
	`round` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_repo_pr_number_unique` ON `review_requests` (`repo`,`pr_number`);--> statement-breakpoint
ALTER TABLE `settings` ADD `review_channel` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `review_request_message` text DEFAULT 'Review requested {{mentions}}
[{{repo}}#{{pr_number}}]({{pr_url}}) {{pr_title}}
{{note}}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `second_pass_message` text DEFAULT 'Round {{round}}: second pass requested {{mentions}}
{{note}}' NOT NULL;