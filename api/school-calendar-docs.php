<?php
/**
 * school-calendar-docs.php
 * Lightweight API to list school_calendar_documents for export purposes.
 *
 * GET ?action=list&school_year=2026-2027
 *   Returns: { success: true, data: [ { id, private_school_id, school_year, payload_json, ... } ] }
 *
 * Requires authentication + 'checklist' permission (same as school-indorsements.php).
 */

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

function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $pdo    = getDb();
    $method = $_SERVER['REQUEST_METHOD'];
    $action = $_GET['action'] ?? 'list';

    if ($method === 'GET' && $action === 'list') {

        $where  = [];
        $params = [];

        $sy = isset($_GET['school_year']) ? trim($_GET['school_year']) : '';
        if ($sy !== '' && $sy !== 'all') {
            // payload_json contains f_sy1 and f_sy2 (e.g. "2026" and "2027")
            // We match by the title or by JSON values — use a LIKE on the full payload
            // OR join against private_schools via private_school_id.
            // Most reliable: filter by the year columns embedded in payload_json.
            [$y1, $y2] = array_pad(explode('-', $sy, 2), 2, '');
            if ($y1 && $y2) {
                $where[]       = '(payload_json LIKE :sy_like OR title LIKE :title_like)';
                $params[':sy_like']    = '%"f_sy1":"' . $y1 . '"%"f_sy2":"' . $y2 . '"%';
                $params[':title_like'] = '%' . $sy . '%';
            }
        }

        // Also support filtering by private_school_id
        $psid = filter_input(INPUT_GET, 'private_school_id', FILTER_VALIDATE_INT);
        if ($psid) {
            $where[]               = 'cd.private_school_id = :psid';
            $params[':psid']       = $psid;
        }

        $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        $stmt = $pdo->prepare(
            "SELECT
                cd.id,
                cd.user_id,
                cd.private_school_id,
                cd.title,
                cd.payload_json,
                cd.status,
                cd.created_at,
                cd.updated_at,
                ps.name        AS school_name,
                ps.school_id_no
             FROM school_calendar_documents cd
             LEFT JOIN private_schools ps ON ps.id = cd.private_school_id
             {$whereSql}
             ORDER BY cd.updated_at DESC"
        );
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Cast IDs, leave payload_json as string (front-end parses it)
        foreach ($rows as &$r) {
            $r['id']                = (int)$r['id'];
            $r['user_id']           = (int)$r['user_id'];
            $r['private_school_id'] = $r['private_school_id'] !== null ? (int)$r['private_school_id'] : null;
        }
        unset($r);

        jsonOut(['success' => true, 'data' => $rows, 'total' => count($rows)]);
    }

    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Unknown action']);

} catch (Throwable $e) {
    error_log('school-calendar-docs.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server error — please try again.']);
}
