ALTER TABLE `runs` ADD `source` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `author` text;--> statement-breakpoint
UPDATE `runs` SET `source` = 'manual' WHERE `rule_id` = 'manual';--> statement-breakpoint
UPDATE `runs` SET `source` = 'slack' WHERE `event` LIKE 'slack.%';--> statement-breakpoint
UPDATE `runs` SET `author` = coalesce(json_extract(`context`, '$.pr_author'), json_extract(`context`, '$.issue_author'), json_extract(`context`, '$.sender')) WHERE `context` IS NOT NULL;
