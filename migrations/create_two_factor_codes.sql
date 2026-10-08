-- =====================================================
-- Two-Factor Authentication Codes Table Migration
-- Run this in phpMyAdmin or MySQL command line
-- =====================================================

-- Drop table if exists (for fresh install)
DROP TABLE IF EXISTS `two_factor_codes`;

-- Create two_factor_codes table
CREATE TABLE `two_factor_codes` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int(10) UNSIGNED NOT NULL,
  `code` varchar(10) NOT NULL COMMENT '6-digit verification code',
  `temp_token` varchar(100) NOT NULL COMMENT 'Temporary token for 2FA session',
  `attempts` int(11) NOT NULL DEFAULT 0 COMMENT 'Number of verification attempts',
  `is_used` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Whether code has been used/invalidated',
  `expires_at` datetime NOT NULL COMMENT 'Code expiration time',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  INDEX `idx_temp_token` (`temp_token`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_expires` (`expires_at`),
  CONSTRAINT `fk_2fa_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- Clean up expired codes periodically (optional event)
-- =====================================================
-- If you want automatic cleanup, enable MySQL events and run:
-- CREATE EVENT IF NOT EXISTS cleanup_expired_2fa_codes
-- ON SCHEDULE EVERY 1 HOUR
-- DO DELETE FROM two_factor_codes WHERE expires_at < NOW() OR is_used = 1;
