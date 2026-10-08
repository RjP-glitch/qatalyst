<?php
/**
 * settings_api.php
 *
 * GET  settings_api.php  → returns all settings as JSON
 * POST settings_api.php  → saves posted JSON config back to DB
 */

// SECURITY: Secure CORS configuration
require_once '../config/security.php';
require_once '../config/database.php';
require_once '../config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for settings (write requires permission)
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// All settings access requires 'settings' permission (both read and write)
requirePermission('settings', $authUser);

$pdo = getDB();

// ─── GET — return all settings ────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'GET') {

    // GET ?action=record_list → list records that have a settings snapshot
    if (isset($_GET['action']) && $_GET['action'] === 'record_list') {
        $stmt = $pdo->query("
            SELECT id, title, source_filename, created_at,
                   CASE WHEN settings_snapshot IS NOT NULL THEN 1 ELSE 0 END AS has_snapshot
            FROM evaluation_programs
            ORDER BY created_at DESC
        ");
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['success' => true, 'records' => $records]);
        exit;
    }

    // GET ?action=record_snapshot&id=X → return the snapshot for a specific record
    if (isset($_GET['action']) && $_GET['action'] === 'record_snapshot' && isset($_GET['id'])) {
        $id   = (int)$_GET['id'];
        $stmt = $pdo->prepare("SELECT title, settings_snapshot FROM evaluation_programs WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Record not found.']);
            exit;
        }
        if (!$row['settings_snapshot']) {
            // No snapshot saved — fall back to current eval_settings
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'This record has no saved settings snapshot (imported before this feature was added).']);
            exit;
        }
        $snapshot = json_decode($row['settings_snapshot'], true);
        echo json_encode(['success' => true, 'title' => $row['title'], 'settings' => $snapshot]);
        exit;
    }

    // Default GET — return current eval_settings
    $rows = $pdo->query("SELECT setting_key, setting_value FROM eval_settings ORDER BY id")
                ->fetchAll(PDO::FETCH_ASSOC);
    $out = [];
    foreach ($rows as $row) {
        $out[$row['setting_key']] = json_decode($row['setting_value'], true);
    }
    echo json_encode(['success' => true, 'settings' => $out]);
    exit;
}

// ─── POST — save settings ─────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = file_get_contents('php://input');
    $data = json_decode($body, true);

    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid JSON body.']);
        exit;
    }

    // respondent_info_cols now includes participant_type
    $allowed = [
        'categories', 'speaker_slots', 'speaker_criteria',
        'feedback_columns', 'respondent_info_cols',
        'excluded_keywords', 'scale_candidates',
        'result_thresholds', 'skip_sheets',
        'sheet_overrides',
    ];

    $stmt = $pdo->prepare(
        "INSERT INTO eval_settings (setting_key, setting_value)
         VALUES (:k, :v)
         ON DUPLICATE KEY UPDATE setting_value = :v2, updated_at = NOW()"
    );

    $pdo->beginTransaction();
    try {
        foreach ($allowed as $key) {
            if (!array_key_exists($key, $data)) continue;
            $encoded = json_encode($data[$key], JSON_UNESCAPED_UNICODE);
            $stmt->execute([':k' => $key, ':v' => $encoded, ':v2' => $encoded]);
        }
        $pdo->commit();
        echo json_encode(['success' => true, 'message' => 'Settings saved.']);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
?>