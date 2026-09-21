ALTER TABLE `rules` ADD `events` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `rules` SET `events` = json_array(`event`);