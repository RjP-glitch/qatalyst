-- Migration: Create signatories table for QAME report configuration
-- Run this SQL to add signatories settings table

CREATE TABLE IF NOT EXISTS `report_signatories` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `setting_name` varchar(100) NOT NULL DEFAULT 'default' COMMENT 'Configuration name',
  
  -- Organization Info
  `org_country` varchar(100) DEFAULT 'Republic of the Philippines',
  `org_department` varchar(100) DEFAULT 'Department of Education',
  `org_division` varchar(150) DEFAULT 'Schools Division of Pampanga',
  `org_section` varchar(150) DEFAULT 'Schools Governance and Operations Division (SGOD)',
  `org_unit` varchar(150) DEFAULT 'Social Mobilization and Networking Section',
  
  -- Prepared by
  `prepared_name` varchar(150) DEFAULT NULL,
  `prepared_title` varchar(150) DEFAULT NULL,
  
  -- Checked by
  `checked_name` varchar(150) DEFAULT NULL,
  `checked_title` varchar(150) DEFAULT NULL,
  
  -- Noted by (up to 3 signatories)
  `noted1_name` varchar(150) DEFAULT NULL,
  `noted1_title` varchar(150) DEFAULT NULL,
  `noted2_name` varchar(150) DEFAULT NULL,
  `noted2_title` varchar(150) DEFAULT NULL,
  `noted3_name` varchar(150) DEFAULT NULL,
  `noted3_title` varchar(150) DEFAULT NULL,
  
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_setting_name` (`setting_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default signatories (update these with your actual values)
INSERT INTO `report_signatories` (
  `setting_name`,
  `org_country`, `org_department`, `org_division`, `org_section`, `org_unit`,
  `prepared_name`, `prepared_title`,
  `checked_name`, `checked_title`,
  `noted1_name`, `noted1_title`,
  `noted2_name`, `noted2_title`,
  `noted3_name`, `noted3_title`,
  `is_active`
) VALUES (
  'default',
  'Republic of the Philippines',
  'Department of Education',
  'Schools Division of Pampanga',
  'Schools Governance and Operations Division (SGOD)',
  'Social Mobilization and Networking Section',
  'TIFFANY JOY P. GONZALES', 'EPS II-SMME',
  'CECILLE E. CRUZ', 'SEPS-SMME',
  'MA. AUREA RHODORA DC. GERONIMO, PhD', 'Chief Education Supervisor-SGOD',
  'ERWIN JOHN F. SANTOS, CESE', 'Assistant Schools Division Superintendent',
  'ROWENA T. QUIAMBAO, CESO VI', 'Schools Division Superintendent',
  1
) ON DUPLICATE KEY UPDATE 
  `org_country` = VALUES(`org_country`),
  `updated_at` = current_timestamp();
