ALTER TABLE `rules` ADD `skip_self_review` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `github_login` text;