<?php
/**
 * checklist-results.php — Fetch Saved Compliance Records
 *
 * GET  → returns paginated list of checklist_results rows
 *   ?limit=50&offset=0   (optional, defaults shown)
 *
 * Returns:
 *   { success: true, records: [...], total: <int> }
 *   { success: false, message: '<reason>' }
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ── Auth ──────────────────────────────────────────────────────────────────────
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

// ── Only allow GET ────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
    exit;
}

// ── Pagination params ─────────────────────────────────────────────────────────
$limit  = min((int)($_GET['limit']  ?? 100), 200);
$offset = max((int)($_GET['offset'] ?? 0),   0);

try {
    $pdo = getDB();

    // Total count
    $stmtCount = $pdo->prepare("SELECT COUNT(*) FROM checklist_results");
    $stmtCount->execute();
    $total = (int)$stmtCount->fetchColumn();

    // Fetch rows — newest first
    $stmt = $pdo->prepare("
        SELECT
            cr.id,
            cr.submission_id,
            cr.checklist_type,
            cr.compliance_score,
            cr.overall_status,
            cr.ai_summary,
            cr.school_name,
            cr.sy_applied,
            cr.location,
            cr.calendar_days_found,
            cr.calendar_in_range,
            cr.items_json,
            cr.fields_json,
            cr.created_by,
            cr.created_at,
            u.full_name AS created_by_name
        FROM checklist_results cr
        LEFT JOIN users u ON u.id = cr.created_by
        ORDER BY cr.created_at DESC
        LIMIT :limit OFFSET :offset
    ");
    $stmt->bindValue(':limit',  $limit,  PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Cast numeric fields so JSON encodes them correctly
    foreach ($rows as &$row) {
        $row['id']                 = (int)$row['id'];
        $row['submission_id']      = $row['submission_id'] !== null ? (int)$row['submission_id'] : null;
        $row['compliance_score']   = (int)$row['compliance_score'];
        $row['calendar_days_found']= $row['calendar_days_found'] !== null ? (int)$row['calendar_days_found'] : null;
        $row['calendar_in_range']  = (bool)$row['calendar_in_range'];
        $row['created_by']         = (int)$row['created_by'];
        // items_json and fields_json are stored as JSON strings — leave as-is;
        // the frontend will parse them when it needs to render a detail view.
    }
    unset($row);

    echo json_encode([
        'success' => true,
        'records' => $rows,
        'total'   => $total,
        'limit'   => $limit,
        'offset'  => $offset,
    ]);

} catch (PDOException $e) {
    error_log('[checklist-results.php] DB error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error. Please try again.']);
} catch (Throwable $e) {
    error_log('[checklist-results.php] Error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unexpected error. Please try again.']);
}
