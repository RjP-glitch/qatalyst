<?php
/**
 * get-indorsement-status.php
 * GET — returns how many indorsements are saved for a given school + type
 *
 * Called by indorsement-generator.js → _indLoadSavedStatus()
 * Query params:
 *   school_id  int     (required)
 *   type       string  (required)  e.g. school_calendar
 *
 * Response: { count: int }
 */

ini_set('display_errors', 0);
error_reporting(E_ALL);
ini_set('log_errors', 1);

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
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

// ── Method guard ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// ── Params ────────────────────────────────────────────────────────────────────
$schoolId        = intval($_GET['school_id']        ?? 0);
$privateSchoolId = intval($_GET['private_school_id'] ?? 0);
$type            = trim($_GET['type']               ?? '');
$indNumber       = intval($_GET['ind_number']        ?? 0);

if ((!$schoolId && !$privateSchoolId) || !$type) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'school_id (or private_school_id) and type are required']);
    exit;
}

// ── Query ─────────────────────────────────────────────────────────────────────
try {
    $pdo = getDB();

    // Build WHERE — match on private_school_id if available, fall back to school_id
    $where  = 'type = :type';
    $params = [':type' => $type];

    if ($privateSchoolId) {
        $where           .= ' AND private_school_id = :psid';
        $params[':psid']  = $privateSchoolId;
    } else {
        $where            .= ' AND school_id = :sid';
        $params[':sid']    = $schoolId;
    }

    // If a specific ind_number was requested, filter to just that number
    if ($indNumber > 0) {
        $where           .= ' AND ind_number = :ind_number';
        $params[':ind_number'] = $indNumber;
    }

    $stmt = $pdo->prepare("
        SELECT COUNT(*) AS cnt
        FROM school_indorsements
        WHERE {$where}
    ");
    $stmt->execute($params);

    $row   = $stmt->fetch(PDO::FETCH_ASSOC);
    $count = (int) ($row['cnt'] ?? 0);

    echo json_encode([
        'count'  => $count,
        'exists' => $count > 0,
    ]);

} catch (Throwable $e) {
    error_log('get-indorsement-status.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
}
