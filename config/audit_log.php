<?php
/**
 * Shared audit logging helpers.
 *
 * Usage:
 *   require_once dirname(__DIR__) . '/config/audit_log.php';
 *   $pdo = getDB();
 *   auditEnsureTable($pdo);
 *   auditLog([
 *       'pdo' => $pdo,
 *       'user_id' => 1,
 *       'role' => 'admin',
 *       'action' => 'login',
 *       'module' => 'auth',
 *       'status' => 'success',
 *       'description' => 'User logged in',
 *   ]);
 */

if (!function_exists('auditEnsureTable')) {
    function auditEnsureTable(PDO $pdo): void {
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS audit_logs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id INT UNSIGNED NULL,
                role VARCHAR(32) NOT NULL,
                action VARCHAR(64) NOT NULL,
                module VARCHAR(64) NOT NULL,
                status VARCHAR(32) NOT NULL,
                description TEXT NULL,
                document_type VARCHAR(128) NULL,
                file_name VARCHAR(255) NULL,
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_audit_user_id (user_id),
                KEY idx_audit_role (role),
                KEY idx_audit_action (action),
                KEY idx_audit_module (module),
                KEY idx_audit_status (status),
                KEY idx_audit_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );

        // Migrate installs whose audit_logs table was created before
        // document_type/file_name existed — auditLog() below always inserts
        // into these columns, so a table missing them causes every insert to
        // throw (silently, since auditLog() swallows errors by design).
        $col = $pdo->query("SHOW COLUMNS FROM audit_logs LIKE 'document_type'")->fetch();
        if (!$col) {
            $pdo->exec("ALTER TABLE audit_logs
                ADD COLUMN document_type VARCHAR(128) NULL AFTER description,
                ADD COLUMN file_name VARCHAR(255) NULL AFTER document_type");
        }
    }
}

if (!function_exists('auditClientIp')) {
    function auditClientIp(): ?string {
        $forwarded = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
        if ($forwarded !== '') {
            $parts = explode(',', $forwarded);
            $candidate = trim($parts[0]);
            if ($candidate !== '') {
                return $candidate;
            }
        }

        $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
        return $remote !== '' ? $remote : null;
    }
}

if (!function_exists('auditLog')) {
    function auditLog(array $payload): void {
        $pdo = $payload['pdo'] ?? null;
        if (!$pdo instanceof PDO) {
            return;
        }

        try {
            auditEnsureTable($pdo);

            $stmt = $pdo->prepare(
                'INSERT INTO audit_logs (user_id, role, action, module, status, description, document_type, file_name, ip_address)
                 VALUES (:user_id, :role, :action, :module, :status, :description, :document_type, :file_name, :ip_address)'
            );
            $userId = null;
            if (isset($payload['user_id']) && is_numeric($payload['user_id'])) {
                $userId = (int)$payload['user_id'];
            }

            $ip = trim((string)($payload['ip_address'] ?? ''));
            if ($ip === '') {
                $ip = auditClientIp();
            }

            $stmt->execute([
                ':user_id' => $userId,
                ':role' => substr((string)($payload['role'] ?? 'system'), 0, 32),
                ':action' => substr((string)($payload['action'] ?? 'unknown'), 0, 64),
                ':module' => substr((string)($payload['module'] ?? 'system'), 0, 64),
                ':status' => substr((string)($payload['status'] ?? 'success'), 0, 32),
                ':description' => (string)($payload['description'] ?? ''),
                ':ip_address' => $ip,
                ':document_type' => isset($payload['document_type']) ? substr((string)$payload['document_type'], 0, 128) : null,
                ':file_name'     => isset($payload['file_name'])     ? substr((string)$payload['file_name'], 0, 255)     : null,
            ]);
        } catch (Throwable $e) {
            // Never block business flow due to audit logging failures —
            // but do leave a trace, or a broken audit trail (like the
            // missing-column issue this just fixed) goes unnoticed forever.
            error_log('auditLog() failed: ' . $e->getMessage());
        }
    }
}
