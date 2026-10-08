<?php
/**
 * Notifications API Endpoint
 * GET /api/notifications.php - Get notification counts and recent submissions
 * POST /api/notifications.php - Mark notifications as read
 */
date_default_timezone_set('Asia/Manila');

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

$base_path = dirname(__DIR__);
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/security.php';
require_once $base_path . '/config/auth_middleware.php';
require_once $base_path . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ---------- helpers ----------
function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    // Authenticate user
    $user = authenticate();
    if (!$user) {
        jsonError('Unauthorized', 401);
    }

    // Admin-side notifications are for SDO personnel accounts only.
    if (($user['account_type'] ?? '') !== 'sdo_personnel') {
        jsonError('Access denied.', 403);
    }

    $db = getDB();
    $user_id = $user['id'];

    // ─── GET: Fetch notification counts ───────────────────────────────────
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {

        // Get user's last notification check time
        $stmt = $db->prepare("SELECT last_notification_check FROM users WHERE id = ?");
        $stmt->execute([$user_id]);
        $userData = $stmt->fetch(PDO::FETCH_ASSOC);
        $lastCheck = $userData['last_notification_check'] ?? '1970-01-01 00:00:00';

        auditEnsureTable($db);

        // Count new items since last check:
        // calendar submissions + directory updates (audit_logs)
        $stmt = $db->prepare("
            SELECT
                (SELECT COUNT(*)
                 FROM school_submissions
                 WHERE type IN ('calendar', 'tuition', 'permit')
                   AND submitted_at > :lc2)
                +
                (SELECT COUNT(*)
                 FROM audit_logs al
                 INNER JOIN users su ON su.id = al.user_id
                 WHERE su.account_type = 'portal_user'
                   AND al.action = 'update_profile'
                   AND al.module = 'school_portal'
                   AND al.status = 'success'
                                     AND (
                                                al.description LIKE '%public_schools#%'
                                         OR al.description LIKE '%private_schools#%'
                                         OR al.description LIKE '%public_schools:%'
                                         OR al.description LIKE '%private_schools:%'
                                     )
                   AND al.created_at > :lc3)
            AS total_count
        ");
        $stmt->execute([':lc2' => $lastCheck, ':lc3' => $lastCheck]);
        $newCount = (int)$stmt->fetchColumn();

        // Get recent 20 items: calendar submissions + directory updates
        $stmt = $db->prepare("
            SELECT *
            FROM (

                -- Calendar submissions from school portal
                SELECT
                    ss.id,
                    ss.submitted_at,
                    TIMESTAMPDIFF(SECOND, ss.submitted_at, NOW()) AS seconds_ago,
                    NULL                AS participant_name,
                    NULL                AS participant_id,
                    NULL                AS day_label,
                    NULL                AS workshop_id,
                    NULL                AS workshop_title,
                    COALESCE(pvs.name, ss.created_by_name, 'A school') AS school_name,
                    ss.calendar_document_id,
                    ss.title            AS submission_title,
                    'calendar'          AS notification_type,
                    CASE WHEN ss.submitted_at > :lc4 THEN 1 ELSE 0 END AS is_new
                FROM school_submissions ss
                LEFT JOIN private_schools pvs ON pvs.id = ss.private_school_id
                WHERE ss.type = 'calendar'

                UNION ALL

                -- Tuition fee submissions from school portal
                SELECT
                    ss.id,
                    ss.submitted_at,
                    TIMESTAMPDIFF(SECOND, ss.submitted_at, NOW()) AS seconds_ago,
                    NULL                AS participant_name,
                    NULL                AS participant_id,
                    NULL                AS day_label,
                    NULL                AS workshop_id,
                    NULL                AS workshop_title,
                    COALESCE(pvs.name, ss.created_by_name, 'A school') AS school_name,
                    ss.calendar_document_id,
                    ss.title            AS submission_title,
                    'tuition'           AS notification_type,
                    CASE WHEN ss.submitted_at > :lc6 THEN 1 ELSE 0 END AS is_new
                FROM school_submissions ss
                LEFT JOIN private_schools pvs ON pvs.id = ss.private_school_id
                WHERE ss.type = 'tuition'

                UNION ALL

                -- School Permit submissions from school portal
                -- FIX: this block was missing entirely, so permit submissions
                -- never showed up in admin notifications even though they were
                -- being saved correctly to school_submissions with type='permit'.
                SELECT
                    ss.id,
                    ss.submitted_at,
                    TIMESTAMPDIFF(SECOND, ss.submitted_at, NOW()) AS seconds_ago,
                    NULL                AS participant_name,
                    NULL                AS participant_id,
                    NULL                AS day_label,
                    NULL                AS workshop_id,
                    NULL                AS workshop_title,
                    COALESCE(pvs.name, ss.created_by_name, 'A school') AS school_name,
                    ss.calendar_document_id,
                    ss.title            AS submission_title,
                    'permit'            AS notification_type,
                    CASE WHEN ss.submitted_at > :lc7 THEN 1 ELSE 0 END AS is_new
                FROM school_submissions ss
                LEFT JOIN private_schools pvs ON pvs.id = ss.private_school_id
                WHERE ss.type = 'permit'

                UNION ALL

                -- Directory/Profile edits from school portal (audit_logs)
                SELECT
                    al.id,
                    al.created_at        AS submitted_at,
                    TIMESTAMPDIFF(SECOND, al.created_at, NOW()) AS seconds_ago,
                    su.full_name         AS participant_name,
                    NULL                AS participant_id,
                    NULL                AS day_label,
                    NULL                AS workshop_id,
                    NULL                AS workshop_title,
                    COALESCE(pvs2.name, 'A school') AS school_name,
                    NULL                AS calendar_document_id,
                    'Directory updated' AS submission_title,
                    'directory_update'  AS notification_type,
                    CASE WHEN al.created_at > :lc5 THEN 1 ELSE 0 END AS is_new
                FROM audit_logs al
                INNER JOIN users su ON su.id = al.user_id
                LEFT JOIN private_schools pvs2 ON pvs2.id = su.private_school_id
                WHERE su.account_type = 'portal_user'
                  AND al.action = 'update_profile'
                  AND al.module = 'school_portal'
                  AND al.status = 'success'
                                    AND (
                                             al.description LIKE '%public_schools#%'
                                        OR al.description LIKE '%private_schools#%'
                                        OR al.description LIKE '%public_schools:%'
                                        OR al.description LIKE '%private_schools:%'
                                    )

            ) combined
            ORDER BY submitted_at DESC
            LIMIT 20
        ");
        $stmt->execute([
            ':lc4' => $lastCheck,
            ':lc5' => $lastCheck,
            ':lc6' => $lastCheck,
            ':lc7' => $lastCheck,
        ]);
        $recent = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Format each item for the frontend
        foreach ($recent as &$item) {
            $item['time_ago'] = timeAgoFromSeconds((int)$item['seconds_ago']);
            $item['is_new']   = (bool)$item['is_new'];
            unset($item['seconds_ago']);
        }
        unset($item);

        jsonSuccess([
            'unread_count' => $newCount,
            'recent'       => $recent,
            'last_check'   => $lastCheck,
        ]);
    }

    // ─── POST: Mark notifications as read ─────────────────────────────────
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);
        $action = $input['action'] ?? 'mark_read';

        if ($action === 'mark_read') {
            // Update user's last notification check time
            $stmt = $db->prepare("UPDATE users SET last_notification_check = NOW() WHERE id = ?");
            $stmt->execute([$user_id]);

            jsonSuccess(['marked_at' => date('Y-m-d H:i:s')], 'Notifications marked as read');
        }

        // action=create is called by the school portal JS after a submission.
        // Notifications here are driven by querying school_submissions on GET,
        // so no extra insert is needed — just acknowledge the call.
        if ($action === 'create') {
            jsonSuccess([], 'Notification noted');
        }

        jsonError('Invalid action');
    }

    jsonError('Method not allowed', 405);

} catch (Throwable $e) {
    error_log('Notifications Error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    jsonError('Server error', 500);
}

/**
 * Convert seconds elapsed to human-readable "time ago" string
 */
function timeAgoFromSeconds($seconds) {
    $seconds = max(0, (int)$seconds);

    $years = (int) floor($seconds / (365 * 24 * 60 * 60));
    if ($years > 0) return $years . ' year' . ($years > 1 ? 's' : '') . ' ago';

    $months = (int) floor($seconds / (30 * 24 * 60 * 60));
    if ($months > 0) return $months . ' month' . ($months > 1 ? 's' : '') . ' ago';

    $days = (int) floor($seconds / (24 * 60 * 60));
    if ($days > 0) return $days . ' day' . ($days > 1 ? 's' : '') . ' ago';

    $hours = (int) floor($seconds / (60 * 60));
    if ($hours > 0) return $hours . ' hour' . ($hours > 1 ? 's' : '') . ' ago';

    $minutes = (int) floor($seconds / 60);
    if ($minutes > 0) return $minutes . ' min' . ($minutes > 1 ? 's' : '') . ' ago';

    return 'Just now';
}