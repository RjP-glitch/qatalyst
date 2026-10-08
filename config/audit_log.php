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
        static $ready;
        $ready ??= new SplObjectStorage();
        if ($ready->contains($pdo)) return;
        // MySQL DDL implicitly commits. Never run schema changes inside a business transaction.
        if ($pdo->inTransaction()) return;
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
        $columns = array_column($pdo->query('SHOW COLUMNS FROM audit_logs')->fetchAll(PDO::FETCH_ASSOC), 'Field');
        $additions = [
            'document_type' => 'VARCHAR(128) NULL', 'file_name' => 'VARCHAR(255) NULL',
            'actor_name' => 'VARCHAR(255) NULL', 'account_type' => 'VARCHAR(32) NULL',
            'school_type' => 'VARCHAR(16) NULL', 'school_id' => 'INT UNSIGNED NULL',
            'school_name' => 'VARCHAR(255) NULL', 'target_user_id' => 'INT UNSIGNED NULL',
            'entity_type' => 'VARCHAR(64) NULL', 'entity_id' => 'VARCHAR(64) NULL',
            'details_json' => 'LONGTEXT NULL', 'request_id' => 'VARCHAR(32) NULL',
        ];
        foreach ($additions as $name => $definition) {
            if (!in_array($name, $columns, true)) $pdo->exec("ALTER TABLE audit_logs ADD COLUMN `$name` $definition");
        }
        $ready->attach($pdo);
        try {
            $triggers = array_column($pdo->query("SHOW TRIGGERS LIKE 'audit_logs'")->fetchAll(PDO::FETCH_ASSOC), 'Trigger');
            foreach (['update' => 'UPDATE', 'delete' => 'DELETE'] as $suffix => $event) {
                $name = 'audit_logs_no_' . $suffix;
                if (!in_array($name, $triggers, true)) $pdo->exec("CREATE TRIGGER `$name` BEFORE $event ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable'");
            }
        } catch (Throwable $e) { error_log('Audit history protection needs database TRIGGER permission: ' . $e->getMessage()); }
    }
}

require_once __DIR__ . '/audit_operations.php';

if (!function_exists('auditClientIp')) {
    function auditClientIp(): ?string {
        $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
        return filter_var($remote, FILTER_VALIDATE_IP) ? $remote : null;
    }
}

if (!function_exists('auditLog')) {
    function auditLog(array $payload): void {
        $pdo = $payload['pdo'] ?? (function_exists('getDB') ? getDB() : null);
        if (!$pdo instanceof PDO) {
            return;
        }

        try {
            auditEnsureTable($pdo);

            $context = $GLOBALS['audit_operation_context'] ?? [];
            $actor = $payload['actor'] ?? null;
            if (!$actor && !empty($payload['user_id'])) {
                $lookup = $pdo->prepare('SELECT id, full_name, role, account_type, school_type, school_id, private_school_id FROM users WHERE id = ?');
                $lookup->execute([(int)$payload['user_id']]);
                $actor = $lookup->fetch(PDO::FETCH_ASSOC) ?: [];
            }
            $actor = is_array($actor) ? $actor : [];
            $school = $payload['school'] ?? ($context['school'] ?? auditSchoolSnapshot($pdo, $actor));
            static $requestId;
            $requestId ??= bin2hex(random_bytes(16));

            $stmt = $pdo->prepare(
                'INSERT INTO audit_logs (user_id, role, action, module, status, description, document_type, file_name, ip_address,
                    actor_name, account_type, school_type, school_id, school_name, target_user_id, entity_type, entity_id, details_json, request_id)
                 VALUES (:user_id, :role, :action, :module, :status, :description, :document_type, :file_name, :ip_address,
                    :actor_name, :account_type, :school_type, :school_id, :school_name, :target_user_id, :entity_type, :entity_id, :details_json, :request_id)'
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
                ':actor_name' => substr((string)($actor['full_name'] ?? $payload['actor_name'] ?? ''), 0, 255) ?: null,
                ':account_type' => $actor['account_type'] ?? null,
                ':school_type' => $school['type'] ?? null,
                ':school_id' => $school['id'] ?? null,
                ':school_name' => $school['name'] ?? null,
                ':target_user_id' => $payload['target_user_id'] ?? $context['target_user_id'] ?? null,
                ':entity_type' => $payload['entity_type'] ?? $context['entity_type'] ?? null,
                ':entity_id' => $payload['entity_id'] ?? $context['entity_id'] ?? null,
                ':details_json' => isset($payload['details']) ? json_encode(auditSafeData($payload['details']), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null,
                ':request_id' => $requestId,
            ]);
        } catch (Throwable $e) {
            // Never block business flow due to audit logging failures —
            // but do leave a trace, or a broken audit trail (like the
            // missing-column issue this just fixed) goes unnoticed forever.
            error_log('auditLog() failed: ' . $e->getMessage());
        }
    }
}
