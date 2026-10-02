-- The polling column keeps its old default (no sentry key): rows always carry polling, and Store.getSettings fills in sources added later.
ALTER TABLE `settings` ADD `sentry_filters` text DEFAULT '{"projects":[],"environments":[],"tags":[]}' NOT NULL;
