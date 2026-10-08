-- Migration: create column_configs table
-- Stores saved column mapping configurations for quick reuse

CREATE TABLE IF NOT EXISTS `column_configs` (
    `id`          INT AUTO_INCREMENT PRIMARY KEY,
    `name`        VARCHAR(255) NOT NULL,
    `description` VARCHAR(500) DEFAULT NULL,
    `config_json` LONGTEXT     NOT NULL COMMENT 'Full JSON config: {sheets, file, exported_at}',
    `sheet_count` TINYINT      DEFAULT 0,
    `column_count` INT         DEFAULT 0,
    `created_at`  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uq_config_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
