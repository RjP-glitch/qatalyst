<?php
/**
 * Announcements API — SDO side (management)
 * GET    /api/announcements.php                 -> list (all statuses, for management table)
 * GET    /api/announcements.php?id=5             -> single announcement
 * POST   /api/announcements.php                  -> create
 * PUT    /api/announcements.php                  -> update (expects "id" in body)
 * DELETE /api/announcements.php?id=5             -> delete
 * POST   /api/announcements.php?action=status    -> { id, status }  quick publish/archive/draft toggle
 * POST   /api/announcements.php?action=pin       -> { id, is_pinned } quick pin toggle
 *
 * Permission required: 'announcements' (admins always pass via hasPermission()).
 */

error_reporting(0);
ini_set('display_errors', 0);

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

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

if (($authUser['account_type'] ?? '') === 'portal_user') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'This endpoint is for SDO accounts']);
    exit;
}

// View vs. manage split: any authenticated SDO user can VIEW announcements
// meant for them; only users with the 'announcements' permission can
// create/edit/delete/publish. Enforced per-action below, not blanket here.
$canManage = hasPermission('announcements', $authUser);

$pdo = getDB();

/**
 * Ensure the announcements table exists. Mirrors the defensive pattern used
 * by audit_log.php's auditEnsureTable() so a fresh/older install self-heals.
 */
function announcementsEnsureTable(PDO $pdo): void {
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS announcements (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            title VARCHAR(255) NOT NULL,
            body TEXT NOT NULL,
            audience ENUM('all','sdo_only','school_only') NOT NULL DEFAULT 'all',
            status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
            is_pinned TINYINT(1) NOT NULL DEFAULT 0,
            starts_at DATETIME NULL,
            expires_at DATETIME NULL,
            created_by INT(11) NULL,
            updated_by INT(11) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_status (status),
            KEY idx_audience (audience),
            KEY idx_pinned (is_pinned),
            KEY idx_schedule (starts_at, expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function outRow(array $r): array {
    return [
        'id'         => (int)$r['id'],
        'title'      => $r['title'],
        'body'       => $r['body'],
        'audience'   => $r['audience'],
        'status'     => $r['status'],
        'is_pinned'  => (bool)$r['is_pinned'],
        'starts_at'  => $r['starts_at'],
        'expires_at' => $r['expires_at'],
        'created_by' => $r['created_by'] !== null ? (int)$r['created_by'] : null,
        'created_at' => $r['created_at'],
        'updated_at' => $r['updated_at'],
    ];
}

try {
    announcementsEnsureTable($pdo);
} catch (Throwable $e) {
    dbLog('announcements.php: failed to ensure announcements table exists', $e);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error occurred']);
    ob_end_flush();
    exit;
}

try {
    $method = $_SERVER['REQUEST_METHOD'];
    $action = $_GET['action'] ?? '';

    // ── Quick status/pin toggles ────────────────────────────────────────
    if ($method === 'POST' && $action === 'status') {
        if (!$canManage) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'You do not have permission to manage announcements.']);
            ob_end_flush();
            exit;
        }
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $id = (int)($input['id'] ?? 0);
        $status = (string)($input['status'] ?? '');
        if ($id <= 0 || !in_array($status, ['draft', 'published', 'archived'], true)) {
            throw new Exception('Invalid id or status');
        }
        $stmt = $pdo->prepare("UPDATE announcements SET status = :status, updated_by = :uid WHERE id = :id");
        $stmt->execute([':status' => $status, ':uid' => $authUser['id'], ':id' => $id]);

        auditLog([
            'pdo' => $pdo, 'user_id' => $authUser['id'], 'role' => $authUser['role'] ?? 'system',
            'action' => 'update_status', 'module' => 'announcements', 'status' => 'success',
            'description' => "Set announcement #$id status to $status",
        ]);

        echo json_encode(['success' => true]);
        ob_end_flush();
        exit;
    }

    if ($method === 'POST' && $action === 'pin') {
        if (!$canManage) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'You do not have permission to manage announcements.']);
            ob_end_flush();
            exit;
        }
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $id = (int)($input['id'] ?? 0);
        $pinned = !empty($input['is_pinned']) ? 1 : 0;
        if ($id <= 0) throw new Exception('Invalid id');

        $stmt = $pdo->prepare("UPDATE announcements SET is_pinned = :pinned, updated_by = :uid WHERE id = :id");
        $stmt->execute([':pinned' => $pinned, ':uid' => $authUser['id'], ':id' => $id]);

        auditLog([
            'pdo' => $pdo, 'user_id' => $authUser['id'], 'role' => $authUser['role'] ?? 'system',
            'action' => $pinned ? 'pin' : 'unpin', 'module' => 'announcements', 'status' => 'success',
            'description' => ($pinned ? 'Pinned' : 'Unpinned') . " announcement #$id",
        ]);

        echo json_encode(['success' => true]);
        ob_end_flush();
        exit;
    }

    // ── Standard CRUD ────────────────────────────────────────────────────
    switch ($method) {

        case 'GET':
            if (!empty($_GET['id'])) {
                $stmt = $pdo->prepare("SELECT * FROM announcements WHERE id = :id");
                $stmt->execute([':id' => (int)$_GET['id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    http_response_code(404);
                    echo json_encode(['success' => false, 'message' => 'Not found']);
                    break;
                }
                // Non-managers can only fetch published items meant for SDO
                if (!$canManage && ($row['status'] !== 'published' || $row['audience'] === 'school_only')) {
                    http_response_code(404);
                    echo json_encode(['success' => false, 'message' => 'Not found']);
                    break;
                }
                echo json_encode(['success' => true, 'data' => outRow($row)]);
                break;
            }

            // scope=active is explicitly used by the dashboard banner widget,
            // but view-only users (no 'announcements' permission) always get
            // this scoped result regardless of the param — they never see
            // drafts/archived/other-audience items, management-table or not.
            $wantActiveOnly = ($_GET['scope'] ?? '') === 'active' || !$canManage;

            if ($wantActiveOnly) {
                $stmt = $pdo->prepare(
                    "SELECT id, title, body, audience, status, is_pinned, starts_at, expires_at, created_at
                     FROM announcements
                     WHERE status = 'published'
                       AND audience IN ('all', 'sdo_only')
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
                        'audience'   => $r['audience'],
                        'status'     => $r['status'],
                        'is_pinned'  => (bool)$r['is_pinned'],
                        'starts_at'  => $r['starts_at'],
                        'expires_at' => $r['expires_at'],
                        'created_at' => $r['created_at'],
                    ];
                }, $rows);
                echo json_encode(['success' => true, 'data' => $data, 'can_manage' => $canManage]);
                break;
            }

            // Full management view — only reached when $canManage is true
            $stmt = $pdo->query(
                "SELECT a.*, u.full_name AS created_by_name
                 FROM announcements a
                 LEFT JOIN users u ON u.id = a.created_by
                 ORDER BY a.is_pinned DESC, a.created_at DESC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            $data = array_map(function ($r) {
                $out = outRow($r);
                $out['created_by_name'] = $r['created_by_name'] ?? null;
                return $out;
            }, $rows);

            echo json_encode(['success' => true, 'data' => $data, 'can_manage' => $canManage]);
            break;

        case 'POST':
            if (!$canManage) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'You do not have permission to create announcements.']);
                break;
            }
            $input = json_decode(file_get_contents('php://input'), true) ?: [];

            $title = trim((string)($input['title'] ?? ''));
            $body  = trim((string)($input['body'] ?? ''));
            $audience = (string)($input['audience'] ?? 'all');
            $status   = (string)($input['status'] ?? 'draft');
            $isPinned = !empty($input['is_pinned']) ? 1 : 0;
            $startsAt  = !empty($input['starts_at'])  ? $input['starts_at']  : null;
            $expiresAt = !empty($input['expires_at']) ? $input['expires_at'] : null;

            if ($title === '' || $body === '') {
                throw new Exception('Title and body are required');
            }
            if (!in_array($audience, ['all', 'sdo_only', 'school_only'], true)) {
                throw new Exception('Invalid audience');
            }
            if (!in_array($status, ['draft', 'published', 'archived'], true)) {
                throw new Exception('Invalid status');
            }

            $stmt = $pdo->prepare(
                "INSERT INTO announcements (title, body, audience, status, is_pinned, starts_at, expires_at, created_by, updated_by)
                 VALUES (:title, :body, :audience, :status, :pinned, :starts_at, :expires_at, :created_uid, :updated_uid)"
            );
            $stmt->execute([
                ':title' => substr($title, 0, 255),
                ':body' => $body,
                ':audience' => $audience,
                ':status' => $status,
                ':pinned' => $isPinned,
                ':starts_at' => $startsAt,
                ':expires_at' => $expiresAt,
                ':created_uid' => $authUser['id'],
                ':updated_uid' => $authUser['id'],
            ]);
            $newId = (int)$pdo->lastInsertId();

            auditLog([
                'pdo' => $pdo, 'user_id' => $authUser['id'], 'role' => $authUser['role'] ?? 'system',
                'action' => 'create', 'module' => 'announcements', 'status' => 'success',
                'description' => "Created announcement \"$title\" (#$newId, audience: $audience, status: $status)",
            ]);

            echo json_encode(['success' => true, 'data' => ['id' => $newId]]);
            break;

        case 'PUT':
            if (!$canManage) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'You do not have permission to edit announcements.']);
                break;
            }
            $input = json_decode(file_get_contents('php://input'), true) ?: [];
            $id = (int)($input['id'] ?? 0);
            if ($id <= 0) throw new Exception('Invalid id');

            $title = trim((string)($input['title'] ?? ''));
            $body  = trim((string)($input['body'] ?? ''));
            $audience = (string)($input['audience'] ?? 'all');
            $status   = (string)($input['status'] ?? 'draft');
            $isPinned = !empty($input['is_pinned']) ? 1 : 0;
            $startsAt  = !empty($input['starts_at'])  ? $input['starts_at']  : null;
            $expiresAt = !empty($input['expires_at']) ? $input['expires_at'] : null;

            if ($title === '' || $body === '') {
                throw new Exception('Title and body are required');
            }
            if (!in_array($audience, ['all', 'sdo_only', 'school_only'], true)) {
                throw new Exception('Invalid audience');
            }
            if (!in_array($status, ['draft', 'published', 'archived'], true)) {
                throw new Exception('Invalid status');
            }

            $stmt = $pdo->prepare(
                "UPDATE announcements SET
                    title = :title, body = :body, audience = :audience, status = :status,
                    is_pinned = :pinned, starts_at = :starts_at, expires_at = :expires_at, updated_by = :uid
                 WHERE id = :id"
            );
            $stmt->execute([
                ':title' => substr($title, 0, 255),
                ':body' => $body,
                ':audience' => $audience,
                ':status' => $status,
                ':pinned' => $isPinned,
                ':starts_at' => $startsAt,
                ':expires_at' => $expiresAt,
                ':uid' => $authUser['id'],
                ':id' => $id,
            ]);

            auditLog([
                'pdo' => $pdo, 'user_id' => $authUser['id'], 'role' => $authUser['role'] ?? 'system',
                'action' => 'update', 'module' => 'announcements', 'status' => 'success',
                'description' => "Updated announcement \"$title\" (#$id)",
            ]);

            echo json_encode(['success' => true]);
            break;

        case 'DELETE':
            if (!$canManage) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'You do not have permission to delete announcements.']);
                break;
            }
            $id = (int)($_GET['id'] ?? 0);
            if ($id <= 0) throw new Exception('Invalid id');

            $stmt = $pdo->prepare("SELECT title FROM announcements WHERE id = :id");
            $stmt->execute([':id' => $id]);
            $existing = $stmt->fetch(PDO::FETCH_ASSOC);

            $stmt = $pdo->prepare("DELETE FROM announcements WHERE id = :id");
            $stmt->execute([':id' => $id]);

            auditLog([
                'pdo' => $pdo, 'user_id' => $authUser['id'], 'role' => $authUser['role'] ?? 'system',
                'action' => 'delete', 'module' => 'announcements', 'status' => 'success',
                'description' => "Deleted announcement \"" . ($existing['title'] ?? "#$id") . "\" (#$id)",
            ]);

            echo json_encode(['success' => true]);
            break;

        default:
            http_response_code(405);
            echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    }

    http_response_code($method === 'POST' && $action === '' ? 201 : 200);

} catch (PDOException $e) {
    dbLog('announcements.php: PDOException', $e);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error occurred']);
    auditLog([
        'pdo' => $pdo, 'user_id' => $authUser['id'] ?? null, 'role' => $authUser['role'] ?? 'system',
        'action' => 'error', 'module' => 'announcements', 'status' => 'failed',
        'description' => $e->getMessage(),
    ]);
} catch (Exception $e) {
    dbLog('announcements.php: Exception', $e);
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

ob_end_flush();
