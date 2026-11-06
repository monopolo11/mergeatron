ALTER TABLE `inbox_items` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `sentry_limit` integer DEFAULT 100 NOT NULL;