<?php
// Admin-only: list school submissions (optionally filtered by type).

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

$role = strtolower(trim((string)($authUser['role'] ?? '')));
if ($role !== 'admin') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied']);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
    exit;
}

$search = trim((string)($_GET['search'] ?? ''));
$status = trim((string)($_GET['status'] ?? ''));
$type = trim((string)($_GET['type'] ?? ''));
$page = max(1, (int)($_GET['page'] ?? 1));
$limit = (int)($_GET['limit'] ?? 50);
if ($limit < 1) $limit = 1;
if ($limit > 200) $limit = 200;
$offset = ($page - 1) * $limit;

$where = [];
$params = [];

if ($type !== '') {
    $where[] = 'ss.type = :type';
    $params[':type'] = $type;
}

if ($status !== '') {
    $where[] = 'ss.status = :status';
    $params[':status'] = $status;
}

if ($search !== '') {
    $where[] = '(ss.title LIKE :search OR ss.file_name LIKE :search OR u.email LIKE :search OR s.name LIKE :search OR ss.status LIKE :search OR ss.type LIKE :search)';
    $params[':search'] = '%' . $search . '%';
}

$whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

try {
        $pdo = getDB();

        $calendarDocsTable = $pdo->query("SHOW TABLES LIKE 'school_calendar_documents'");
        if ($calendarDocsTable && $calendarDocsTable->fetchColumn()) {
                $pdo->exec(
                        "DELETE ss FROM school_submissions ss
                         LEFT JOIN school_calendar_documents scd
                             ON scd.id = CAST(SUBSTRING_INDEX(ss.file_path, ':', -1) AS UNSIGNED)
                            AND scd.user_id = ss.user_id
                         WHERE ss.type = 'calendar'
                             AND ss.file_path LIKE 'school_calendar_documents:%'
                             AND scd.id IS NULL"
                );
        }

    $countStmt = $pdo->prepare(
        "SELECT COUNT(*)
         FROM school_submissions ss
         LEFT JOIN users u ON u.id = ss.user_id
         LEFT JOIN schools s ON s.id = ss.school_id
         $whereSql"
    );
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $dataStmt = $pdo->prepare(
        "SELECT ss.id, ss.user_id, ss.school_id, ss.type, ss.title, ss.file_name, ss.file_path,
                ss.status, ss.remarks, ss.submitted_at, ss.reviewed_by, ss.reviewed_at,
                u.email AS user_email, u.full_name AS user_name,
                s.name AS school_name,
                ru.full_name AS reviewed_by_name
         FROM school_submissions ss
         LEFT JOIN users u ON u.id = ss.user_id
         LEFT JOIN schools s ON s.id = ss.school_id
         LEFT JOIN users ru ON ru.id = ss.reviewed_by
         $whereSql
         ORDER BY ss.submitted_at DESC
         LIMIT :limit OFFSET :offset"
    );

    foreach ($params as $key => $value) {
        $dataStmt->bindValue($key, $value);
    }
    $dataStmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $dataStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $dataStmt->execute();

    $rows = $dataStmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($rows as &$row) {
        $row['id'] = (int)$row['id'];
        $row['user_id'] = (int)$row['user_id'];
        $row['school_id'] = $row['school_id'] !== null ? (int)$row['school_id'] : null;
        $row['reviewed_by'] = $row['reviewed_by'] !== null ? (int)$row['reviewed_by'] : null;
    }
    unset($row);

    echo json_encode([
        'success' => true,
        'data' => $rows,
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'total_pages' => (int)ceil($total / $limit),
        ],
    ]);
} catch (PDOException $e) {
    error_log('[admin-calendar-submissions.php] DB error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error. Please try again.']);
} catch (Throwable $e) {
    error_log('[admin-calendar-submissions.php] Error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unexpected error. Please try again.']);
}
