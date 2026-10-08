-- =====================================================
-- Rating Scales Table Migration
-- Run this in phpMyAdmin or MySQL command line
-- =====================================================

-- Drop table if exists (for fresh install)
DROP TABLE IF EXISTS `rating_scales`;

-- Create rating_scales table
CREATE TABLE `rating_scales` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `scale_type` ENUM('category', 'speaker', 'overall') NOT NULL COMMENT 'category=PMT/Objectives/etc, speaker=Resource Speaker, overall=Overall Score',
  `min_score` decimal(4,2) NOT NULL,
  `max_score` decimal(4,2) NOT NULL,
  `level_of_agreement` varchar(100) NOT NULL,
  `descriptive_equivalent` varchar(100) NOT NULL,
  `display_order` int(11) NOT NULL DEFAULT 1,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  INDEX `idx_scale_type` (`scale_type`),
  INDEX `idx_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- A. For Evaluation of PMT, Objectives, Content Relevance, Meals and Venue
-- =====================================================
INSERT INTO `rating_scales` (`scale_type`, `min_score`, `max_score`, `level_of_agreement`, `descriptive_equivalent`, `display_order`) VALUES
('category', 3.26, 4.00, 'Strongly Agree (SA)', 'Very Satisfactory (VS)', 1),
('category', 2.51, 3.25, 'Agree (A)', 'Satisfactory (S)', 2),
('category', 1.76, 2.50, 'Disagree (D)', 'Unsatisfactory (U)', 3),
('category', 1.00, 1.75, 'Strongly Disagree (SD)', 'Very Unsatisfactory (VU)', 4);

-- =====================================================
-- B. For Resource Speaker
-- =====================================================
INSERT INTO `rating_scales` (`scale_type`, `min_score`, `max_score`, `level_of_agreement`, `descriptive_equivalent`, `display_order`) VALUES
('speaker', 3.26, 4.00, 'Very Satisfied', 'Very Satisfactory (VS)', 1),
('speaker', 2.51, 3.25, 'Somewhat Satisfied', 'Satisfactory (S)', 2),
('speaker', 1.76, 2.50, 'Somewhat Dissatisfied', 'Unsatisfactory (U)', 3),
('speaker', 1.00, 1.75, 'Dissatisfied', 'Very Unsatisfactory (VU)', 4);

-- =====================================================
-- C. Over-all Score
-- =====================================================
INSERT INTO `rating_scales` (`scale_type`, `min_score`, `max_score`, `level_of_agreement`, `descriptive_equivalent`, `display_order`) VALUES
('overall', 3.26, 4.00, 'Excellent', 'Very Satisfactory (VS)', 1),
('overall', 2.51, 3.25, 'Good', 'Satisfactory (S)', 2),
('overall', 1.76, 2.50, 'Average', 'Unsatisfactory (U)', 3),
('overall', 1.00, 1.75, 'Fair', 'Very Unsatisfactory (VU)', 4);

-- Verify data
SELECT scale_type, min_score, max_score, level_of_agreement, descriptive_equivalent 
FROM rating_scales 
ORDER BY scale_type, display_order;
