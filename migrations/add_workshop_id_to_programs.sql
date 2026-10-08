-- Migration: Add workshop_id and source_type to evaluation_programs
-- Purpose: Allow linking Excel-imported records to workshops and track data source

ALTER TABLE `evaluation_programs`
  ADD COLUMN `workshop_id` INT(11) DEFAULT NULL
    COMMENT 'FK to workshops.id — links this record to a workshop'
    AFTER `id`,
  ADD COLUMN `source_type` ENUM('excel','online','merged') NOT NULL DEFAULT 'excel'
    COMMENT 'Where the data came from: excel import, online evaluation, or merged'
    AFTER `workshop_id`;

-- Index for faster lookup by workshop_id
ALTER TABLE `evaluation_programs`
  ADD INDEX `idx_ep_workshop_id` (`workshop_id`);
