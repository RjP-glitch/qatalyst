-- QAME Super Categories Migration
-- This creates tables for grouping evaluation categories into QAME components

-- Super categories table (Q, A, M, E)
CREATE TABLE IF NOT EXISTS `qame_super_categories` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `code` VARCHAR(10) NOT NULL UNIQUE COMMENT 'Single letter code like Q, A, M, E',
    `name` VARCHAR(100) NOT NULL COMMENT 'Full name like Quality, Appropriateness, etc.',
    `description` TEXT NULL,
    `icon` VARCHAR(50) DEFAULT 'fa-star' COMMENT 'FontAwesome icon class',
    `color` VARCHAR(20) DEFAULT '#1e3a8a' COMMENT 'Hex color code',
    `display_order` INT DEFAULT 0,
    `is_active` TINYINT(1) DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mapping table to link super categories with evaluation_question_categories
CREATE TABLE IF NOT EXISTS `qame_category_mappings` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `super_category_id` INT NOT NULL,
    `category_id` INT NOT NULL,
    `weight` DECIMAL(3,2) DEFAULT 1.00 COMMENT 'Weight for weighted average calculation',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`super_category_id`) REFERENCES `qame_super_categories`(`id`) ON DELETE CASCADE,
    FOREIGN KEY (`category_id`) REFERENCES `evaluation_question_categories`(`id`) ON DELETE CASCADE,
    UNIQUE KEY `unique_mapping` (`super_category_id`, `category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert default QAME super categories
INSERT INTO `qame_super_categories` (`code`, `name`, `description`, `icon`, `color`, `display_order`) VALUES
('Q', 'Quality', 'Content & Delivery Quality', 'fa-star', '#3b82f6', 1),
('A', 'Appropriateness', 'Content Relevance & Suitability', 'fa-bullseye', '#10b981', 2),
('M', 'Management', 'Program & Resource Management', 'fa-gear', '#f59e0b', 3),
('E', 'Effectiveness', 'Learning Impact & Outcomes', 'fa-rocket', '#8b5cf6', 4);

-- Insert default mappings (adjust category_id values based on your existing categories)
-- Q (Quality) = Delivery of Content (id=3)
INSERT INTO `qame_category_mappings` (`super_category_id`, `category_id`) 
SELECT s.id, 3 FROM qame_super_categories s WHERE s.code = 'Q' AND EXISTS (SELECT 1 FROM evaluation_question_categories WHERE id = 3);

-- A (Appropriateness) = Attainment of Objectives (id=2)
INSERT INTO `qame_category_mappings` (`super_category_id`, `category_id`) 
SELECT s.id, 2 FROM qame_super_categories s WHERE s.code = 'A' AND EXISTS (SELECT 1 FROM evaluation_question_categories WHERE id = 2);

-- M (Management) = Program Management and Operations (id=1)
INSERT INTO `qame_category_mappings` (`super_category_id`, `category_id`) 
SELECT s.id, 1 FROM qame_super_categories s WHERE s.code = 'M' AND EXISTS (SELECT 1 FROM evaluation_question_categories WHERE id = 1);

-- E (Effectiveness) = Resource Speaker (id=7)
INSERT INTO `qame_category_mappings` (`super_category_id`, `category_id`) 
SELECT s.id, 7 FROM qame_super_categories s WHERE s.code = 'E' AND EXISTS (SELECT 1 FROM evaluation_question_categories WHERE id = 7);
