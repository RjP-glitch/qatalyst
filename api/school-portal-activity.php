<?php
/**
 * GET /api/school-portal-activity.php
 * Returns recent audit activity for the authenticated school portal user.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) {
    ob_end_clean();
}
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

function jsonSuccess(array $data, string $message = 'Success', int $code = 200, array $extra = []): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode(array_merge([
        'success' => true,
        'message' => $message,
        'data' => $data,
    ], $extra), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError(string $message, int $code = 400): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode([
        'success' => false,
        'message' => $message,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function addOrLikeFilter(string $field, string $rawValue, string $paramPrefix, array &$where, array &$params): void {
    $parts = array_values(array_filter(array_map('trim', explode(',', $rawValue)), static function ($item) {
        return $item !== '';
    }));

    if (!$parts) {
        return;
    }

    $clauses = [];
    foreach ($parts as $index => $part) {
        $key = ':' . $paramPrefix . $index;
        $clauses[] = "LOWER($field) LIKE $key";
        $params[$key] = '%' . strtolower($part) . '%';
    }

    if (count($clauses) === 1) {
        $where[] = $clauses[0];
        return;
    }

    $where[] = '(' . implode(' OR ', $clauses) . ')';
}

$user = null;

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        jsonError('Method not allowed', 405);
    }

    $user = authenticate();
    if (!$user) {
        jsonError('Unauthorized. Please sign in.', 401);
    }

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $search = trim((string)($_GET['search'] ?? ''));
    $action = trim((string)($_GET['action'] ?? ''));
    $status = trim((string)($_GET['status'] ?? ''));
    $from = trim((string)($_GET['from'] ?? ''));
    $to = trim((string)($_GET['to'] ?? ''));

    $page = max(1, (int)($_GET['page'] ?? 1));
    $limit = (int)($_GET['limit'] ?? 50);
    if ($limit < 1) $limit = 1;
    if ($limit > 200) $limit = 200;
    $offset = ($page - 1) * $limit;

    $pdo = getDB();
    auditEnsureTable($pdo);

    $where = ['(user_id = :user_id OR target_user_id = :target_user_id)'];
    $params = [':user_id' => (int)$user['id'], ':target_user_id' => (int)$user['id']];
    $link = portalSchoolLink($user);
    if (portalSchoolIsApproved($user) && $link) {
        // Shared school/document decisions are visible; other people's account changes are private.
        $where = ["(user_id = :user_id OR target_user_id = :target_user_id OR (school_id = :linked_school_id AND school_type = :school_type AND (entity_type IN ('public_schools', 'private_schools', 'school_signatories', 'calendar_legends') OR module = 'school-portal-profile-update')))"];
        $params[':linked_school_id'] = $link['id'];
        $params[':school_type'] = $link['table'] === 'private_schools' ? 'private' : 'public';
    }

    if ($search !== '') {
        $parts = [];
        foreach (['action', 'module', 'status', 'description', 'document_type', 'file_name', 'actor_name', 'request_id'] as $index => $field) {
            $key = ':search' . $index; $parts[] = "$field LIKE $key"; $params[$key] = '%' . $search . '%';
        }
        $where[] = '(' . implode(' OR ', $parts) . ')';
    }
    if ($action !== '') {
        addOrLikeFilter('action', $action, 'action', $where, $params);
    }
    if ($status !== '') {
        addOrLikeFilter('status', $status, 'status', $where, $params);
    }
    if ($from !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) {
        $where[] = 'created_at >= :from';
        $params[':from'] = $from . ' 00:00:00';
    }
    if ($to !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
        $where[] = 'created_at <= :to';
        $params[':to'] = $to . ' 23:59:59';
    }

    $whereSql = 'WHERE ' . implode(' AND ', $where);

    $countStmt = $pdo->prepare(
        "SELECT COUNT(*)
         FROM audit_logs
         $whereSql"
    );
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $stmt = $pdo->prepare(
        "SELECT id, user_id, actor_name, account_type, action, module, status, description, document_type, file_name, created_at,
            entity_type, entity_id, request_id, details_json
         FROM audit_logs
         $whereSql
         ORDER BY id DESC
         LIMIT :limit OFFSET :offset"
    );
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value);
    }
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['details'] = json_decode($row['details_json'] ?? 'null', true);
        if ((int)$row['user_id'] !== (int)$user['id'] && $row['module'] === 'school-portal-profile-update' && isset($row['details']['records'])) {
            $row['details']['records'] = array_values(array_filter($row['details']['records'], fn($record) => $record['table'] !== 'users'));
        }
        unset($row['details_json']);
    }
    unset($row);
    jsonSuccess($rows, 'Success', 200, [
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'total_pages' => (int)ceil($total / $limit),
        ],
    ]);
} catch (Throwable $e) {
    error_log('school-portal-activity.php error: ' . $e->getMessage());
    auditLog([
        'user_id' => $user ? (int)($user['id'] ?? 0) : null,
        'role' => $user && isset($user['role']) ? $user['role'] : 'portal_user',
        'action' => 'error',
        'module' => 'school_portal',
        'status' => 'failed',
        'description' => 'school-portal-activity.php error: ' . $e->getMessage(),
        'school_id' => !empty($user['school_id']) ? (int)$user['school_id'] : null,
    ]);
    jsonError('Server error. Please try again.', 500);
}
