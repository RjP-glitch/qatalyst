-- Create user_files table for file management feature
-- Run this migration to enable the Files tab in Settings

CREATE TABLE IF NOT EXISTS `user_files` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `file_name` VARCHAR(255) NULL COMMENT 'Legacy: Original filename (deprecated)',
    `stored_name` VARCHAR(255) NULL COMMENT 'Legacy: Stored filename (deprecated)',
    `file_size` BIGINT NULL COMMENT 'Legacy: File size (deprecated)',
    `file_path` VARCHAR(500) NULL COMMENT 'Legacy: Full path (deprecated)',
    `files` JSON DEFAULT NULL COMMENT 'Array of file objects: [{file_name, stored_name, file_size, file_path}]',
    `uploaded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `item_no` VARCHAR(50) DEFAULT NULL,
    `location` VARCHAR(255) DEFAULT NULL COMMENT 'Auto-filled with upload directory path',
    `headings` VARCHAR(255) DEFAULT NULL,
    `unit` VARCHAR(100) DEFAULT NULL,
    `nature_of_event` VARCHAR(255) DEFAULT NULL,
    `status` VARCHAR(50) DEFAULT 'Pending',
    `qame_report` VARCHAR(255) DEFAULT NULL,
    `computation_files` TEXT DEFAULT NULL,
    
    INDEX `idx_user_files_user` (`user_id`),
    INDEX `idx_user_files_uploaded` (`uploaded_at`),
    
    CONSTRAINT `fk_user_files_user` 
        FOREIGN KEY (`user_id`) 
        REFERENCES `users`(`id`) 
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
