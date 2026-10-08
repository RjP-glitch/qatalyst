<?php
/**
 * /api/school-portal-submissions.php
 *
 * Unified school portal submissions endpoint.
 *
 * Routing:
 *   GET  (no action)         — list submissions + stats (all types)
 *   POST ?action=upload      — disabled here; each document type has its own dedicated tool
 *   POST ?action=edit        — disabled here; each document type has its own dedicated tool
 *   POST ?action=delete      — delete a pending/review submission (any type)
 *
 * All actions require an authenticated portal_user session.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ---- Helpers -----------------------------------------------------------------

function jsonSuccess($data = [], $msg = 'Success', $code = 200): void {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError($msg, $code = 400): void {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Normalize raw DB status values to the canonical set used by the frontend.
 * Single source of truth — the JS frontend no longer needs its own copy.
 */
function normalizeSubmissionStatus(?string $status): string {
    $value = strtolower(trim((string)$status));
    $map = [
        'pending review' => 'pending',
        'under review'   => 'review',
    ];
    return $map[$value] ?? $value;
}

// Allowed enum values — prevents SQL injection via filter params
const ALLOWED_TYPES    = ['tuition', 'no_tuition', 'calendar', 'permit'];
const ALLOWED_STATUSES = ['pending', 'approved', 'rejected', 'endorsed', 'review'];

const TYPE_LABELS = [
    'tuition'    => 'Tuition Fee Increase',
    'no_tuition' => 'No Tuition Fee Increase',
    'calendar'   => 'School Calendar',
    'permit'     => 'School Permit',
];

// ---- Auth (shared by all actions) -------------------------------------------

try {
    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) jsonError('Unauthorized. Please sign in.', 401);

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType === 'sdo_personnel') {
        jsonError('Access denied. SDO personnel accounts use the main system dashboard.', 403);
    }
    if ($accountType !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $userId = (int)$user['id'];
    $method = $_SERVER['REQUEST_METHOD'];
    $action = strtolower(trim($_GET['action'] ?? ''));

    // ---- Route ---------------------------------------------------------------

    if ($method === 'GET' && $action === '') {
        handleList($user, $userId);
    } elseif ($method === 'POST' && $action === 'upload') {
        handleUpload($user, $userId);
    } elseif ($method === 'POST' && $action === 'edit') {
        handleEdit($user, $userId);
    } elseif ($method === 'POST' && $action === 'delete') {
        handleDelete($user, $userId);
    } else {
        jsonError('Method or action not allowed.', 405);
    }

} catch (Throwable $e) {
    error_log(sprintf('school-portal-submissions.php [line %d]: %s', $e->getLine(), $e->getMessage()));
    jsonError('Server error. Please try again.', 500);
}

// ---- Action: LIST ------------------------------------------------------------

/**
 * GET /api/school-portal-submissions.php
 *
 * Returns the full submissions list + stats for the authenticated school portal user.
 *
 * Optional query params:
 *   ?type=tuition|no_tuition|calendar|permit
 *   ?status=pending|approved|rejected|endorsed|review
 *   ?search=keyword
 *   ?limit=N    (default 200, hard cap 500)
 *   ?offset=N
 */
function handleList(array $user, int $userId): void {
    $db = getDB();

    // Resolve school scope robustly. Some accounts/sessions have incomplete
    // school_type metadata, so we support fallback matching on both columns.
    $schoolType       = strtolower(trim((string)($user['school_type'] ?? '')));
    $isPrivate        = str_contains($schoolType, 'private');
    $privateSchoolId  = ((int)($user['private_school_id'] ?? 0) ?: null);
    $publicSchoolId   = ((int)($user['school_id'] ?? 0) ?: null);

    if (!$privateSchoolId && !$publicSchoolId) {
        jsonError('No school linked to your account. Please contact your administrator.', 403);
    }

    $resolvedSchoolId = $isPrivate
        ? ($privateSchoolId ?: $publicSchoolId)
        : ($publicSchoolId ?: $privateSchoolId);

    $schoolScopeSQL = '';
    $schoolScopeParams = [];
    if ($isPrivate && $privateSchoolId) {
        $schoolScopeSQL = 'ss.private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } elseif (!$isPrivate && $publicSchoolId) {
        $schoolScopeSQL = 'ss.school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId && $publicSchoolId) {
        $schoolScopeSQL = '(ss.private_school_id = :private_school_id OR ss.school_id = :school_id)';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId) {
        $schoolScopeSQL = 'ss.private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } else {
        $schoolScopeSQL = 'ss.school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    }

    $filterType   = $_GET['type']   ?? null;
    $filterStatus = $_GET['status'] ?? null;
    $search       = trim($_GET['search'] ?? '');
    $limit        = min((int)($_GET['limit']  ?? 200), 500);
    $offset       = max((int)($_GET['offset'] ?? 0),   0);

    if ($filterType   && !in_array($filterType,   ALLOWED_TYPES,    true)) jsonError('Invalid type filter.',   400);
    if ($filterStatus && !in_array($filterStatus, ALLOWED_STATUSES, true)) jsonError('Invalid status filter.', 400);

    // Scope to the school so all portal users of the same school see the full history
    $where  = [$schoolScopeSQL];
    $params = $schoolScopeParams;

    if ($filterType) {
        $where[]             = 'ss.type = :doc_type';
        $params[':doc_type'] = $filterType;
    }
    if ($filterStatus) {
        if ($filterStatus === 'pending') {
            $where[] = "LOWER(TRIM(ss.status)) IN ('pending', 'pending review')";
        } elseif ($filterStatus === 'review') {
            $where[] = "LOWER(TRIM(ss.status)) IN ('review', 'under review')";
        } else {
            $where[]           = 'LOWER(TRIM(ss.status)) = :status';
            $params[':status'] = $filterStatus;
        }
    }
    if ($search !== '') {
        $where[]           = '(ss.title LIKE :search OR ss.file_name LIKE :search)';
        $params[':search'] = '%' . $search . '%';
    }

    $whereSQL = implode(' AND ', $where);

    // Stats (always for the full school, ignoring active filters)
    $statsScopeSQL = str_replace('ss.', '', $schoolScopeSQL);
    $stmtStats = $db->prepare("
        SELECT
            COUNT(*)                                                                             AS total,
            SUM(LOWER(TRIM(status)) = 'approved')                                               AS approved,
            SUM(LOWER(TRIM(status)) IN ('pending', 'pending review', 'review', 'under review')) AS pending,
            SUM(LOWER(TRIM(status)) = 'endorsed')                                               AS endorsed
        FROM school_submissions
        WHERE {$statsScopeSQL}
    ");
    $stmtStats->execute($schoolScopeParams);
    $counts = $stmtStats->fetch(PDO::FETCH_ASSOC);

    $stats = [
        'total'    => (int)($counts['total']    ?? 0),
        'approved' => (int)($counts['approved'] ?? 0),
        'pending'  => (int)($counts['pending']  ?? 0),
        'endorsed' => (int)($counts['endorsed'] ?? 0),
    ];

    $stmt = $db->prepare("
        SELECT
            ss.id, ss.type, ss.title, ss.file_name, ss.status, ss.file_path,
            ss.indorsement_count, ss.remarks, ss.submitted_at, ss.updated_at,
            ss.school_year, ss.document_type, ss.history_json
        FROM school_submissions ss
        WHERE {$whereSQL}
        ORDER BY ss.submitted_at DESC
        LIMIT :limit OFFSET :offset
    ");
    foreach ($params as $key => $val) {
        $stmt->bindValue($key, $val);
    }
    $stmt->bindValue(':limit',  $limit,  PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($rows as &$row) {
        $row['status']            = normalizeSubmissionStatus($row['status'] ?? '');
        $row['type_label']        = TYPE_LABELS[$row['type']] ?? ucfirst($row['type']);
        $row['indorsement_count'] = (int)$row['indorsement_count'];
    }
    unset($row);

    // Dedicated count params so later changes to $params cannot affect the count query
    $countParams = $params;
    $stmtCount   = $db->prepare("SELECT COUNT(*) FROM school_submissions ss WHERE {$whereSQL}");
    $stmtCount->execute($countParams);
    $totalFiltered = (int)$stmtCount->fetchColumn();

    jsonSuccess([
        'school_id'   => $resolvedSchoolId,
        'school_type' => $user['school_type'] ?? null,
        'stats'       => $stats,
        'submissions' => $rows,
        'pagination'  => [
            'total'  => $totalFiltered,
            'limit'  => $limit,
            'offset' => $offset,
        ],
    ]);
}

// ---- Action: UPLOAD ----------------------------------------------------------

/**
 * POST /api/school-portal-submissions.php?action=upload
 */
function handleUpload(array $user, int $userId): void {
    // All document categories now upload through their own dedicated tool/endpoint:
    //   - School Calendar  → school-portal-calendar.php
    //   - Tuition Fee      → school-portal-tuition.php
    //   - School Permit    → school-portal-permit.php
    // This shared endpoint only lists and deletes submissions across all types.
    jsonError('Invalid document type for upload. Use the dedicated tool for this document category.', 422);
}

// ---- Action: EDIT ------------------------------------------------------------

/**
 * POST /api/school-portal-submissions.php?action=edit
 * Only the owner can edit, and only while status is pending or review.
 */
function handleEdit(array $user, int $userId): void {
    // All document categories are now managed by their own dedicated tool:
    //   - School Calendar  → school-portal-calendar.php
    //   - Tuition Fee      → school-portal-tuition.php
    //   - School Permit    → school-portal-permit.php
    // This shared endpoint only lists and deletes submissions across all types.
    jsonError('This document category is managed by its dedicated tool. Please edit it there.', 422);
}

// ---- Action: DELETE ----------------------------------------------------------

/**
 * POST /api/school-portal-submissions.php?action=delete
 * Only the owner can delete, and only while status is pending or review.
 */
function handleDelete(array $user, int $userId): void {
    $body = json_decode(file_get_contents('php://input'), true);
    $id   = (int)($body['id'] ?? 0);
    if (!$id) jsonError('Invalid submission ID.', 400);

    $pdo = getDB();

    $stmt = $pdo->prepare("SELECT * FROM school_submissions WHERE id = :id AND user_id = :uid LIMIT 1");
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) jsonError('Submission not found.', 404);

    $status = strtolower(trim($sub['status'] ?? ''));
    if (!in_array($status, ['pending', 'pending review', 'review', 'under review'], true)) {
        jsonError('Only pending or under-review submissions can be deleted.', 403);
    }

    $basePath = dirname(__DIR__);
    $absPath  = $basePath . '/' . $sub['file_path'];
    if (file_exists($absPath)) @unlink($absPath);

    $pdo->prepare("DELETE FROM school_submissions WHERE id = :id AND user_id = :uid")
        ->execute([':id' => $id, ':uid' => $userId]);

    $typeLabel = TYPE_LABELS[$sub['type'] ?? ''] ?? ucfirst($sub['type'] ?? 'unknown');
    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_delete',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => "Submission deleted | submission_id={$id} | title={$sub['title']} | type={$sub['type']}",
        'document_type' => $typeLabel,
        'file_name'     => $sub['file_name'],
    ]);

    jsonSuccess(['id' => $id], 'Submission deleted successfully.');
}
