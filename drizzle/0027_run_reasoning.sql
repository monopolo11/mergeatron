ALTER TABLE `runs` ADD `reasoning` text;--> statement-breakpoint
UPDATE `runs` SET `reasoning` = (
  SELECT CASE WHEN json_type(o.value, '$.value') = 'text' THEN json_extract(o.value, '$.value') END
  FROM `run_actions` a, json_each(a.model_options) o
  WHERE a.run_id = `runs`.id AND json_extract(o.value, '$.id') IN ('effort', 'reasoningEffort')
  ORDER BY o.key
  LIMIT 1
) WHERE `model_id` IS NOT NULL;
