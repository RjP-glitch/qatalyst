<?php
/**
 * School Portal — Notifications API
 *
 * GET  /api/school-portal-notifications.php
 * POST /api/school-portal-notifications.php
 */

date_default_timezone_set('Asia/Manila');

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) {
    ob_end_clean();
}
ob_start();

$base_path = dirname(__DIR__);
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/security.php';
require_once $base_path . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => $msg,
        'data' => $data,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode([
        'success' => false,
        'message' => $msg,
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

function isMissingNotificationsTable($e) {
    if (!($e instanceof Throwable)) {
        return false;
    }

    $msg = strtolower((string)$e->getMessage());
    $code = (string)$e->getCode();

    return $code === '42S02'
        || strpos($msg, 'school_notifications') !== false
        || strpos($msg, 'base table or view not found') !== false
        || strpos($msg, "doesn't exist") !== false;
}

function timeAgo($datetime) {
    $now = new DateTime('now', new DateTimeZone('Asia/Manila'));
    $then = new DateTime($datetime, new DateTimeZone('Asia/Manila'));
    $diff = max(0, (int)($now->getTimestamp() - $then->getTimestamp()));

    if ($diff < 60) return 'Just now';
    if ($diff < 3600) {
        $m = (int)floor($diff / 60);
        return $m . ' min' . ($m > 1 ? 's' : '') . ' ago';
    }
    if ($diff < 86400) {
        $h = (int)floor($diff / 3600);
        return $h . ' hour' . ($h > 1 ? 's' : '') . ' ago';
    }
    if ($diff < 2592000) {
        $d = (int)floor($diff / 86400);
        return $d . ' day' . ($d > 1 ? 's' : '') . ' ago';
    }

    $mo = (int)floor($diff / 2592000);
    return $mo . ' month' . ($mo > 1 ? 's' : '') . ' ago';
}

try {
    $user = authenticate();
    if (!$user) {
        jsonError('Unauthorized. Please sign in.', 401);
    }

    if (($user['account_type'] ?? '') === 'sdo_personnel') {
        jsonError('Access denied.', 403);
    }

    $schoolType = (str_contains(strtolower($user['school_type'] ?? ''), 'private'))
              ? 'private'
              : 'public';

    // Private schools now store their FK in private_school_id; public schools use school_id
    if ($schoolType === 'private') {
        $schoolId = (int)($user['private_school_id'] ?? 0);
    } else {
        $schoolId = (int)($user['school_id'] ?? 0);
    }

    if (!$schoolId) {
        jsonError('No school linked to this account.', 422);
    }

    $db = getDB();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        try {
            $stmtCount = $db->prepare(
                'SELECT COUNT(*) AS cnt
                 FROM school_notifications
                 WHERE school_id = :sid AND school_type = :stype AND is_read = 0'
            );
            $stmtCount->execute([':sid' => $schoolId, ':stype' => $schoolType]);
            $unreadCount = (int)$stmtCount->fetchColumn();

            $stmtList = $db->prepare(
                'SELECT id, type, title, message, link, is_read, created_at
                 FROM school_notifications
                 WHERE school_id = :sid AND school_type = :stype
                 ORDER BY created_at DESC LIMIT 25'
            );
            $stmtList->execute([':sid' => $schoolId, ':stype' => $schoolType]);
            $rows = $stmtList->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            if (isMissingNotificationsTable($e)) {
                jsonSuccess([
                    'unread_count' => 0,
                    'notifications' => [],
                ], 'Notifications table not set up yet.');
            }
            throw $e;
        }

        $notifications = array_map(function ($r) {
            return [
                'id' => (int)$r['id'],
                'type' => $r['type'],
                'title' => $r['title'],
                'message' => $r['message'],
                'link' => $r['link'] ?? '',
                'is_read' => (bool)$r['is_read'],
                'time_ago' => timeAgo($r['created_at']),
            ];
        }, $rows);

        jsonSuccess([
            'unread_count' => $unreadCount,
            'notifications' => $notifications,
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
        $action = $input['action'] ?? '';

        if ($action === 'mark_read') {
            $notifId = (int)($input['notification_id'] ?? 0);
            if (!$notifId) {
                jsonError('notification_id is required.');
            }

            try {
                $stmt = $db->prepare(
                    'UPDATE school_notifications
                     SET is_read = 1
                     WHERE id = :id AND school_id = :sid AND school_type = :stype'
                );
                $stmt->execute([':id' => $notifId, ':sid' => $schoolId, ':stype' => $schoolType]);
            } catch (Throwable $e) {
                if (isMissingNotificationsTable($e)) {
                    jsonSuccess(['notification_id' => $notifId], 'No notifications table yet; marked as read (noop).');
                }
                throw $e;
            }

            jsonSuccess(['notification_id' => $notifId], 'Marked as read.');
        }

        if ($action === 'mark_all_read') {
            try {
                $stmt = $db->prepare(
                    'UPDATE school_notifications
                     SET is_read = 1
                     WHERE school_id = :sid AND school_type = :stype AND is_read = 0'
                );
                $stmt->execute([':sid' => $schoolId, ':stype' => $schoolType]);
            } catch (Throwable $e) {
                if (isMissingNotificationsTable($e)) {
                    jsonSuccess(['marked_at' => date('Y-m-d H:i:s')], 'No notifications table yet; mark-all treated as noop.');
                }
                throw $e;
            }

            jsonSuccess(['marked_at' => date('Y-m-d H:i:s')], 'All notifications marked as read.');
        }

        jsonError('Invalid action.');
    }

    jsonError('Method not allowed.', 405);

} catch (Throwable $e) {
    error_log('school-portal-notifications.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
