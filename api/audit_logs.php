<?php
// Read-only SDO audit review and export.
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';
header('Content-Type: application/json; charset=utf-8');
setCorsHeaders(); setSecurityHeaders(); handlePreflight();
function jsonError(string $message, int $code = 400): void {
    http_response_code($code); echo json_encode(['success' => false, 'message' => $message]); exit;
}
function jsonSuccess(array $data, array $extra = []): void {
    echo json_encode(['success' => true, 'data' => $data] + $extra, JSON_INVALID_UTF8_SUBSTITUTE); exit;
}
$user = authenticate('sdo_personnel');
if (!$user) jsonError('Unauthorized', 401);
requirePermission('audit_logs', $user);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') jsonError('Method not allowed', 405);
$pdo = getDB();
auditEnsureTable($pdo);
if (($_GET['list'] ?? '') === 'health') {
    $triggers = array_column($pdo->query("SHOW TRIGGERS LIKE 'audit_logs'")->fetchAll(PDO::FETCH_ASSOC), 'Trigger');
    jsonSuccess(['history_protected' => in_array('audit_logs_no_update', $triggers, true) && in_array('audit_logs_no_delete', $triggers, true)]);
}
if (($_GET['list'] ?? '') === 'schools') {
    $stmt = $pdo->query("SELECT id, school_name AS name, 'public' AS type FROM public_schools
        UNION SELECT id, name, 'private' AS type FROM private_schools
        UNION SELECT school_id AS id, school_name AS name, school_type AS type FROM audit_logs WHERE school_id IS NOT NULL AND school_name IS NOT NULL
        ORDER BY name");
    jsonSuccess($stmt->fetchAll(PDO::FETCH_ASSOC));
}
if (($_GET['list'] ?? '') === 'filters') {
    $filters = [];
    foreach (['action', 'module', 'role', 'status'] as $field) $filters[$field] = $pdo->query("SELECT DISTINCT `$field` FROM audit_logs ORDER BY `$field`")->fetchAll(PDO::FETCH_COLUMN);
    jsonSuccess($filters);
}
$schoolIdSql = "COALESCE(al.school_id, CASE WHEN u.school_type = 'private' THEN u.private_school_id ELSE u.school_id END)";
$schoolTypeSql = 'COALESCE(al.school_type, CAST(u.school_type AS CHAR CHARACTER SET utf8mb4)) COLLATE utf8mb4_unicode_ci';
$schoolNameSql = 'COALESCE(al.school_name, ps.school_name, pvs.name)';
$actorNameSql = 'COALESCE(al.actor_name, u.full_name)';
$accountTypeSql = 'COALESCE(al.account_type, CAST(u.account_type AS CHAR CHARACTER SET utf8mb4)) COLLATE utf8mb4_unicode_ci';
$joins = "FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    LEFT JOIN public_schools ps ON ps.id = u.school_id AND u.account_type = 'portal_user' AND u.school_type = 'public'
    LEFT JOIN private_schools pvs ON pvs.id = u.private_school_id AND u.account_type = 'portal_user' AND u.school_type = 'private'";
$where = []; $params = [];
$search = trim((string)($_GET['search'] ?? ''));
if ($search !== '') {
    $parts = [];
    foreach (['al.role', 'al.action', 'al.module', 'al.status', 'al.ip_address', 'al.description', 'CAST(al.user_id AS CHAR)', $schoolNameSql, $actorNameSql, 'al.entity_id', 'al.request_id', 'al.details_json'] as $index => $field) {
        $key = ':search' . $index; $parts[] = "CONVERT($field USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE $key"; $params[$key] = '%' . $search . '%';
    }
    $where[] = '(' . implode(' OR ', $parts) . ')';
}
foreach (['role', 'action', 'module', 'status', 'user_id'] as $field) {
    if (isset($_GET[$field]) && $_GET[$field] !== '') { $where[] = "al.$field = :$field"; $params[':' . $field] = $_GET[$field]; }
}
if (!empty($_GET['account_type']) && in_array($_GET['account_type'], ['portal_user', 'sdo_personnel'], true)) {
    $where[] = "$accountTypeSql = :account_type"; $params[':account_type'] = $_GET['account_type'];
}
if (!empty($_GET['school_id']) && ctype_digit((string)$_GET['school_id'])) {
    $where[] = "$schoolIdSql = :school_id"; $params[':school_id'] = (int)$_GET['school_id'];
    if (in_array($_GET['school_type'] ?? '', ['public', 'private'], true)) {
        $where[] = "$schoolTypeSql = :school_type"; $params[':school_type'] = $_GET['school_type'];
    }
}
foreach (['from', 'to'] as $field) {
    if (!empty($_GET[$field]) && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $_GET[$field])) {
        $where[] = 'al.created_at ' . ($field === 'from' ? '>=' : '<=') . " :$field";
        $params[':' . $field] = $_GET[$field] . ($field === 'from' ? ' 00:00:00' : ' 23:59:59');
    }
}
$whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
$select = "SELECT al.id, al.user_id, $actorNameSql AS actor_name, $accountTypeSql AS account_type,
    $schoolIdSql AS school_id, $schoolTypeSql AS school_type, $schoolNameSql AS school_name,
    al.role, al.action, al.module, al.status, al.description, al.document_type, al.file_name, al.ip_address,
    al.created_at, al.target_user_id, al.entity_type, al.entity_id, al.details_json, al.request_id ";
if (($_GET['export'] ?? '') === 'csv') {
    auditLog(['pdo' => $pdo, 'actor' => $user, 'user_id' => $user['id'], 'role' => $user['role'],
        'action' => 'export', 'module' => 'audit_logs', 'status' => 'success', 'description' => 'Exported filtered audit logs as CSV',
        'details' => ['filters' => array_intersect_key($_GET, array_flip(['search', 'role', 'action', 'module', 'status', 'user_id', 'school_id', 'school_type', 'account_type', 'from', 'to']))]]);
    $stmt = $pdo->prepare($select . $joins . $whereSql . ' ORDER BY al.id DESC');
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="audit_logs_' . date('Ymd_His') . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['id', 'user_id', 'actor_name', 'account_type', 'school_id', 'school_type', 'school_name', 'role', 'action', 'module', 'status', 'description', 'document_type', 'file_name', 'ip_address', 'created_at', 'target_user_id', 'entity_type', 'entity_id', 'details_json', 'request_id']);
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        foreach ($row as &$cell) if (is_string($cell) && preg_match('/^[=+@\-\t\r]/', $cell)) $cell = "'" . $cell;
        unset($cell); fputcsv($out, $row);
    }
    fclose($out); exit;
}
$page = max(1, (int)($_GET['page'] ?? 1));
$limit = max(1, min(200, (int)($_GET['limit'] ?? 50)));
$stmt = $pdo->prepare('SELECT COUNT(*) ' . $joins . $whereSql); $stmt->execute($params);
$total = (int)$stmt->fetchColumn();
$stmt = $pdo->prepare($select . $joins . $whereSql . ' ORDER BY al.id DESC LIMIT :limit OFFSET :offset');
foreach ($params as $key => $value) $stmt->bindValue($key, $value);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT); $stmt->bindValue(':offset', ($page - 1) * $limit, PDO::PARAM_INT);
$stmt->execute();
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
foreach ($rows as &$row) { $row['details'] = json_decode($row['details_json'] ?? 'null', true); unset($row['details_json']); }
unset($row);
jsonSuccess($rows, ['pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total, 'total_pages' => (int)ceil($total / $limit)]]);
