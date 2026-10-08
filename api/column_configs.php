<?php
// ═══════════════════════════════════════════════════════════════════════════════
// column_configs.php — CRUD API for saved column-mapping configurations
// ═══════════════════════════════════════════════════════════════════════════════

// SECURITY: Secure CORS configuration
require_once __DIR__ . '/../config/security.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Require 'settings' permission for column config management
requirePermission('settings', $authUser);

try {
    $pdo    = getDB();
    $method = $_SERVER['REQUEST_METHOD'];

    // ── Ensure the table exists ──────────────────────────────────────────────
    $pdo->exec("CREATE TABLE IF NOT EXISTS `column_configs` (
        `id`           INT AUTO_INCREMENT PRIMARY KEY,
        `name`         VARCHAR(255) NOT NULL,
        `description`  VARCHAR(500) DEFAULT NULL,
        `config_json`  LONGTEXT     NOT NULL,
        `sheet_count`  TINYINT      DEFAULT 0,
        `column_count` INT          DEFAULT 0,
        `created_at`   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        `updated_at`   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY `uq_config_name` (`name`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // ═════════════════════════════════════════════════════════════════════════
    // GET  — list all configs (summary) or fetch one by ?id=N
    // ═════════════════════════════════════════════════════════════════════════
    if ($method === 'GET') {
        if (!empty($_GET['id'])) {
            $stmt = $pdo->prepare("SELECT * FROM column_configs WHERE id = ?");
            $stmt->execute([(int) $_GET['id']]);
            $row = $stmt->fetch();
            if (!$row) {
                echo json_encode(['success' => false, 'message' => 'Config not found.']);
                exit;
            }
            $row['config'] = json_decode($row['config_json'], true);
            unset($row['config_json']);
            echo json_encode(['success' => true, 'config' => $row]);
        } else {
            // Return list without the heavy config_json blob
            // but include the 'file' field for auto-matching
            $rows = $pdo->query(
                "SELECT id, name, description, sheet_count, column_count, created_at, updated_at,
                        JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.file')) as file
                   FROM column_configs ORDER BY updated_at DESC"
            )->fetchAll();
            echo json_encode(['success' => true, 'configs' => $rows]);
        }
        exit;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // POST — create a new config
    // ═════════════════════════════════════════════════════════════════════════
    if ($method === 'POST') {
        $body = json_decode(file_get_contents('php://input'), true);
        $name   = trim($body['name'] ?? '');
        $desc   = trim($body['description'] ?? '');
        $config = $body['config'] ?? null;

        if (!$name)   { echo json_encode(['success' => false, 'message' => 'Name is required.']); exit; }
        if (!$config || empty($config['sheets'])) {
            echo json_encode(['success' => false, 'message' => 'Config with sheets data is required.']); exit;
        }

        $sheets      = $config['sheets'];
        $sheetCount  = count($sheets);
        $columnCount = 0;
        foreach ($sheets as $cols) { $columnCount += count($cols); }

        $stmt = $pdo->prepare(
            "INSERT INTO column_configs (name, description, config_json, sheet_count, column_count)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                description  = VALUES(description),
                config_json  = VALUES(config_json),
                sheet_count  = VALUES(sheet_count),
                column_count = VALUES(column_count)"
        );
        $stmt->execute([$name, $desc, json_encode($config), $sheetCount, $columnCount]);

        $id = $pdo->lastInsertId();
        // If UPSERT updated instead of inserted, fetch the existing id
        if (!$id) {
            $id = $pdo->query("SELECT id FROM column_configs WHERE name = " . $pdo->quote($name))->fetchColumn();
        }

        echo json_encode(['success' => true, 'message' => 'Configuration saved.', 'id' => (int) $id]);
        exit;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PUT — rename / update description
    // ═════════════════════════════════════════════════════════════════════════
    if ($method === 'PUT') {
        $body = json_decode(file_get_contents('php://input'), true);
        $id   = (int) ($body['id'] ?? 0);
        $name = trim($body['name'] ?? '');
        $desc = trim($body['description'] ?? '');

        if (!$id || !$name) {
            echo json_encode(['success' => false, 'message' => 'ID and name are required.']); exit;
        }

        $stmt = $pdo->prepare("UPDATE column_configs SET name = ?, description = ? WHERE id = ?");
        $stmt->execute([$name, $desc, $id]);

        echo json_encode(['success' => true, 'message' => 'Configuration updated.']);
        exit;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // DELETE — remove a config by ?id=N
    // ═════════════════════════════════════════════════════════════════════════
    if ($method === 'DELETE') {
        $id = (int) ($_GET['id'] ?? 0);
        if (!$id) { echo json_encode(['success' => false, 'message' => 'ID is required.']); exit; }

        $stmt = $pdo->prepare("DELETE FROM column_configs WHERE id = ?");
        $stmt->execute([$id]);

        echo json_encode(['success' => true, 'message' => 'Configuration deleted.']);
        exit;
    }

    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server error: ' . $e->getMessage()]);
}
?>