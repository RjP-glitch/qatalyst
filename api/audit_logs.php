<?php
// Admin-only audit log API (read-only).

error_reporting(E_ALL);
ini_set('display_errors', 0);

if (ob_get_level()) {
    ob_end_clean();
}
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

function jsonError(string $message, int $code = 400): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function jsonSuccess(array $data, array $extra = []): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code(200);
    echo json_encode(array_merge(['success' => true], $extra, ['data' => $data]));
    exit;
}

$user = authenticate();
if (!$user) {
    jsonError('Unauthorized', 401);
}

requirePermission('audit_logs', $user);

$pdo = getDB();
auditEnsureTable($pdo);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET') {
    jsonError('Method not allowed', 405);
}

$list = trim((string)($_GET['list'] ?? ''));
$search = trim((string)($_GET['search'] ?? ''));
$roleFilter = trim((string)($_GET['role'] ?? ''));
$action = trim((string)($_GET['action'] ?? ''));
$module = trim((string)($_GET['module'] ?? ''));
$status = trim((string)($_GET['status'] ?? ''));
$from = trim((string)($_GET['from'] ?? ''));
$to = trim((string)($_GET['to'] ?? ''));
$userId = trim((string)($_GET['user_id'] ?? ''));
$schoolId = trim((string)($_GET['school_id'] ?? ''));
$schoolTypeFilter = trim((string)($_GET['school_type'] ?? ''));

if ($list === 'schools') {
    $stmt = $pdo->prepare(
        "SELECT id, school_name AS name, 'public' AS type FROM public_schools WHERE active = 1
         UNION ALL
         SELECT id, name, 'private' AS type FROM private_schools WHERE active = 1
         ORDER BY name ASC"
    );
    $stmt->execute();
    jsonSuccess($stmt->fetchAll(PDO::FETCH_ASSOC));
}

$page = max(1, (int)($_GET['page'] ?? 1));
$limit = (int)($_GET['limit'] ?? 50);
if ($limit < 1) $limit = 1;
if ($limit > 200) $limit = 200;
$offset = ($page - 1) * $limit;

$where = [];
$params = [];

if ($search !== '') {
    $searchTerm = '%' . $search . '%';
    $where[] = "(al.role LIKE :search1 OR al.action LIKE :search2 OR al.module LIKE :search3 OR al.status LIKE :search4 OR al.ip_address LIKE :search5 OR al.description LIKE :search6 OR CAST(al.user_id AS CHAR) LIKE :search7 OR COALESCE(ps.school_name, pvs.name) LIKE :search8)";
    $params[':search1'] = $searchTerm;
    $params[':search2'] = $searchTerm;
    $params[':search3'] = $searchTerm;
    $params[':search4'] = $searchTerm;
    $params[':search5'] = $searchTerm;
    $params[':search6'] = $searchTerm;
    $params[':search7'] = $searchTerm;
    $params[':search8'] = $searchTerm;
}
if ($roleFilter !== '') {
    $where[] = 'al.role = :role';
    $params[':role'] = $roleFilter;
}
if ($action !== '') {
    $where[] = 'al.action = :action';
    $params[':action'] = $action;
}
if ($module !== '') {
    $where[] = 'al.module = :module';
    $params[':module'] = $module;
}
if ($status !== '') {
    $where[] = 'al.status = :status';
    $params[':status'] = $status;
}
if ($userId !== '' && ctype_digit($userId)) {
    $where[] = 'al.user_id = :user_id';
    $params[':user_id'] = (int)$userId;
}
if ($schoolId !== '' && ctype_digit($schoolId)) {
    // public_schools.id and private_schools.id are separate sequences and can
    // collide, so the filter must respect which table the id came from.
    if ($schoolTypeFilter === 'private') {
        $where[] = 'u.private_school_id = :school_id AND u.school_type = :school_type_filter';
        $params[':school_type_filter'] = 'private';
        $params[':school_id'] = (int)$schoolId;
    } elseif ($schoolTypeFilter === 'public') {
        $where[] = 'u.school_id = :school_id AND u.school_type = :school_type_filter';
        $params[':school_type_filter'] = 'public';
        $params[':school_id'] = (int)$schoolId;
    } else {
        // Backward compatibility: no type provided, match either column.
        // Uses two distinct placeholders since PDO (non-emulated prepares)
        // does not support reusing the same named placeholder twice.
        $where[] = '(u.school_id = :school_id_a OR u.private_school_id = :school_id_b)';
        $params[':school_id_a'] = (int)$schoolId;
        $params[':school_id_b'] = (int)$schoolId;
    }
}
if ($from !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) {
    $where[] = 'al.created_at >= :from';
    $params[':from'] = $from . ' 00:00:00';
}
if ($to !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
    $where[] = 'al.created_at <= :to';
    $params[':to'] = $to . ' 23:59:59';
}

$whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

if (isset($_GET['export']) && $_GET['export'] === 'csv') {
    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)$user['id'],
        'role' => $user['role'] ?? 'admin',
        'action' => 'export',
        'module' => 'audit_logs',
        'status' => 'success',
        'description' => 'Exported audit logs as CSV',
    ]);
    $stmt = $pdo->prepare(
        "SELECT al.id, al.user_id, u.school_id,
                COALESCE(ps.school_name, pvs.name) AS school_name,
                al.role, al.action, al.module, al.status,
                al.description, al.ip_address, al.created_at
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         LEFT JOIN public_schools ps 
                ON ps.id = u.school_id AND u.account_type = 'portal_user' 
                   AND u.school_type = 'public'
         LEFT JOIN private_schools pvs 
                ON pvs.id = u.private_school_id AND u.account_type = 'portal_user' 
                   AND u.school_type = 'private'
         $whereSql
         ORDER BY al.id DESC"
    );
    $stmt->execute($params);

    if (ob_get_level()) {
        ob_end_clean();
    }
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="audit_logs_' . date('Ymd_His') . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['id', 'user_id', 'school_id', 'school_name', 'role', 'action', 'module', 'status', 'description', 'ip_address', 'created_at']);
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        fputcsv($out, $row);
    }
    fclose($out);
    exit;
}

$countStmt = $pdo->prepare(
    "SELECT COUNT(*)
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     LEFT JOIN public_schools ps 
            ON ps.id = u.school_id AND u.account_type = 'portal_user' 
               AND u.school_type = 'public'
     LEFT JOIN private_schools pvs 
            ON pvs.id = u.private_school_id AND u.account_type = 'portal_user' 
               AND u.school_type = 'private'
     $whereSql"
);
$countStmt->execute($params);
$total = (int)$countStmt->fetchColumn();

$dataStmt = $pdo->prepare(
    "SELECT al.id, al.user_id, u.school_id,
            COALESCE(ps.school_name, pvs.name) AS school_name,
            al.role, al.action, al.module, al.status,
            al.description, al.ip_address, al.created_at,
            al.ip_address AS ip_raw
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     LEFT JOIN public_schools ps 
            ON ps.id = u.school_id AND u.account_type = 'portal_user' 
               AND u.school_type = 'public'
     LEFT JOIN private_schools pvs 
            ON pvs.id = u.private_school_id AND u.account_type = 'portal_user' 
               AND u.school_type = 'private'
     $whereSql
     ORDER BY al.id DESC
     LIMIT :limit OFFSET :offset"
);
foreach ($params as $key => $value) {
    $dataStmt->bindValue($key, $value);
}
$dataStmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$dataStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
$dataStmt->execute();

$rows = $dataStmt->fetchAll(PDO::FETCH_ASSOC);

jsonSuccess($rows, [
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'total' => $total,
        'total_pages' => (int)ceil($total / $limit),
    ]
]);
