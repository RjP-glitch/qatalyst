<?php
/**
 * Announcements API — School Portal side (read-only view)
 * GET /api/school-portal-announcements.php
 *
 * Returns published announcements visible to portal users:
 *   - audience IN ('all', 'school_only')
 *   - status = 'published'
 *   - starts_at is null or in the past
 *   - expires_at is null or in the future
 * Pinned items first, then newest first.
 *
 * NOTE: filename is intentionally prefixed "school-portal-" so
 * auth_middleware.php's $isPortalRequest detection picks the correct
 * (school_session_token) cookie automatically.
 */

error_reporting(0);
ini_set('display_errors', 0);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// Any authenticated portal user can view announcements — no special
// permission required, mirroring how school-portal-dashboard.php works.
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

if (($authUser['account_type'] ?? '') !== 'portal_user') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'This endpoint is for school portal accounts']);
    exit;
}

try {
    $pdo = getDB();

    // Defensive: table may not exist yet on an older install
    $exists = $pdo->query("SHOW TABLES LIKE 'announcements'")->fetch();
    if (!$exists) {
        echo json_encode(['success' => true, 'data' => []]);
        ob_end_flush();
        exit;
    }

    $stmt = $pdo->prepare(
        "SELECT id, title, body, is_pinned, starts_at, expires_at, created_at
         FROM announcements
         WHERE status = 'published'
           AND audience IN ('all', 'school_only')
           AND (starts_at IS NULL OR starts_at <= NOW())
           AND (expires_at IS NULL OR expires_at >= NOW())
         ORDER BY is_pinned DESC, created_at DESC
         LIMIT 50"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $data = array_map(function ($r) {
        return [
            'id'         => (int)$r['id'],
            'title'      => $r['title'],
            'body'       => $r['body'],
            'is_pinned'  => (bool)$r['is_pinned'],
            'starts_at'  => $r['starts_at'],
            'expires_at' => $r['expires_at'],
            'created_at' => $r['created_at'],
        ];
    }, $rows);

    http_response_code(200);
    echo json_encode(['success' => true, 'data' => $data]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error occurred']);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

ob_end_flush();
