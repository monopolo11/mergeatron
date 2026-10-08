CREATE TABLE `rule_generations` (
	`rule_id` text NOT NULL,
	`item_key` text NOT NULL,
	`generation` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `item_key`),
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade
);
