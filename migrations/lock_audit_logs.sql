-- ============================================================
-- Migration: Make audit_logs immutable
-- Blocks UPDATE and DELETE to keep logs write-only append
-- ============================================================

-- Ensure audit_logs exists (matches config/audit_log.php)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL,
  role VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  module VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  description TEXT NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user_id (user_id),
  KEY idx_audit_role (role),
  KEY idx_audit_action (action),
  KEY idx_audit_module (module),
  KEY idx_audit_status (status),
  KEY idx_audit_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER //

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Audit logs are immutable';
END//

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Audit logs are immutable';
END//

DELIMITER ;
