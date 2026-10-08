-- Migration: Add settings_snapshot column to evaluation_programs
-- This stores the eval_settings configuration used at the time of import
-- so users can later load/copy settings from any previously saved record.

ALTER TABLE `evaluation_programs`
  ADD COLUMN `settings_snapshot` LONGTEXT DEFAULT NULL
  COMMENT 'JSON snapshot of eval_settings used at import time'
  AFTER `source_filename`;
