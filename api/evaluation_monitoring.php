<?php
/**
 * Evaluation Monitoring API Endpoint
 *
 * GET  ?action=workshops                   → List workshops (for dropdown)
 * GET  ?action=participants&workshop_id=X   → Participant completion data
 * GET  ?action=stats&workshop_id=X          → Summary stats
 * POST ?action=remind                       → Send reminder emails
 * POST ?action=remind_all&workshop_id=X     → Send reminders to ALL incomplete
 */

error_reporting(0);
ini_set('display_errors', 0);

if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';

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

// ---------- auth ----------
function getAuthUser($db) {
    $user = authenticate('sdo_personnel');
    if (!$user) jsonError('Unauthorized', 401);
    return $user;
}

// ---------- routing ----------
$action = isset($_GET['action']) ? $_GET['action'] : '';

try {
    $db = getDB();
    $authUser = getAuthUser($db);

    // Require 'programs' permission for evaluation monitoring
    requirePermission('programs', $authUser);

    // ===== GET — List workshops for dropdown =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'workshops') {
        $stmt = $db->query("
            SELECT w.id, w.title, w.start_date, w.end_date, w.status,
                   (SELECT COUNT(*) FROM workshop_participants wp WHERE wp.workshop_id = w.id) AS total_participants
            FROM workshops w
            ORDER BY w.created_at DESC
        ");
        $workshops = $stmt->fetchAll(PDO::FETCH_ASSOC);
        jsonSuccess($workshops);
    }

    // ===== GET — Participant completion data for a workshop =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'participants') {
        $workshopId = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : 0;
        if (!$workshopId) jsonError('Workshop ID is required');

        $dayFilter = isset($_GET['day_id']) ? intval($_GET['day_id']) : 0;

        // Fetch workshop info
        $stmt = $db->prepare("SELECT id, title, start_date, end_date, total_days FROM workshops WHERE id = :id");
        $stmt->execute([':id' => $workshopId]);
        $workshop = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$workshop) jsonError('Workshop not found', 404);

        // Fetch workshop days
        $stmt = $db->prepare("
            SELECT id, day_number, title, day_date 
            FROM workshop_days 
            WHERE workshop_id = :wid 
            ORDER BY day_number
        ");
        $stmt->execute([':wid' => $workshopId]);
        $days = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Fetch all participants for this workshop
        $stmt = $db->prepare("
            SELECT id, full_name, email, sex, designation, school_office, attendance_status, registered_at
            FROM workshop_participants
            WHERE workshop_id = :wid
            ORDER BY full_name
        ");
        $stmt->execute([':wid' => $workshopId]);
        $participants = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // For each participant, check which days they completed evaluation
        foreach ($participants as &$p) {
            $dayQuery = "
                SELECT er.workshop_day_id, er.submitted_at, wd.day_number, wd.title AS day_title
                FROM evaluation_submissions er
                INNER JOIN workshop_days wd ON er.workshop_day_id = wd.id
                WHERE er.participant_id = :pid AND wd.workshop_id = :wid
            ";
            $params = [':pid' => $p['id'], ':wid' => $workshopId];

            if ($dayFilter) {
                $dayQuery .= " AND er.workshop_day_id = :did";
                $params[':did'] = $dayFilter;
            }

            $stmt2 = $db->prepare($dayQuery);
            $stmt2->execute($params);
            $completedDays = $stmt2->fetchAll(PDO::FETCH_ASSOC);

            $p['completed_days'] = $completedDays;
            $p['total_completed'] = count($completedDays);

            // Determine overall status
            $totalDays = $dayFilter ? 1 : count($days);
            $p['total_days'] = $totalDays;
            $p['completion_pct'] = $totalDays > 0 ? round(($p['total_completed'] / $totalDays) * 100) : 0;

            if ($p['total_completed'] === 0) {
                $p['status'] = 'pending';
            } elseif ($p['total_completed'] >= $totalDays) {
                $p['status'] = 'completed';
            } else {
                $p['status'] = 'partial';
            }

            // Last reminder sent (if tracked in DB, otherwise null)
            $p['last_reminder'] = null;
            try {
                $stmt3 = $db->prepare("
                    SELECT sent_at FROM evaluation_reminders
                    WHERE participant_id = :pid AND workshop_id = :wid
                    ORDER BY sent_at DESC LIMIT 1
                ");
                $stmt3->execute([':pid' => $p['id'], ':wid' => $workshopId]);
                $reminder = $stmt3->fetch(PDO::FETCH_ASSOC);
                $p['last_reminder'] = $reminder ? $reminder['sent_at'] : null;
            } catch (Exception $e) {
                // Table might not exist yet - leave as null
            }
        }

        jsonSuccess([
            'workshop' => $workshop,
            'days' => $days,
            'participants' => $participants
        ]);
    }

    // ===== GET — Summary stats =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'stats') {
        $workshopId = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : 0;
        if (!$workshopId) jsonError('Workshop ID is required');

        // Total participants (all registered participants)
        $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM workshop_participants WHERE workshop_id = :wid");
        $stmt->execute([':wid' => $workshopId]);
        $totalParticipants = (int)$stmt->fetch()['cnt'];

        // Workshop days
        $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM workshop_days WHERE workshop_id = :wid");
        $stmt->execute([':wid' => $workshopId]);
        $totalDays = (int)$stmt->fetch()['cnt'];

        // Per-participant completion counts (days with at least one evaluation)
        // This ensures stats line up exactly with the participant list
        $stmt = $db->prepare("
            SELECT wp.id AS participant_id,
                   COUNT(DISTINCT CASE WHEN wd.workshop_id = ? THEN er.workshop_day_id END) AS days_completed
            FROM workshop_participants wp
            LEFT JOIN evaluation_submissions er ON er.participant_id = wp.id
            LEFT JOIN workshop_days wd ON er.workshop_day_id = wd.id
            WHERE wp.workshop_id = ?
            GROUP BY wp.id
        ");
        $stmt->execute([$workshopId, $workshopId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $completedAtLeastOne = 0;
        $totalEvaluations = 0;
        foreach ($rows as $r) {
            $daysCompleted = (int)$r['days_completed'];
            if ($daysCompleted > 0) {
                $completedAtLeastOne++;
            }
            $totalEvaluations += $daysCompleted;
        }

        // Expected evaluations = participants × days
        $expectedEvaluations = $totalParticipants * $totalDays;

        // Per-day breakdown
        $stmt = $db->prepare("
            SELECT wd.id, wd.day_number, wd.title, wd.day_date,
                   COUNT(DISTINCT er.participant_id) AS completed,
                   :total AS total_participants
            FROM workshop_days wd
            LEFT JOIN evaluation_submissions er ON er.workshop_day_id = wd.id
            WHERE wd.workshop_id = :wid
            GROUP BY wd.id
            ORDER BY wd.day_number
        ");
        $stmt->execute([':wid' => $workshopId, ':total' => $totalParticipants]);
        $dayBreakdown = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($dayBreakdown as &$d) {
            $d['completion_rate'] = $totalParticipants > 0
                ? round(((int)$d['completed'] / $totalParticipants) * 100)
                : 0;
            $d['pending'] = $totalParticipants - (int)$d['completed'];
        }

        // Reminders sent total
        $remindersSent = 0;
        // Note: evaluation_reminders table may not exist yet - skip if not available

        jsonSuccess([
            'total_participants' => $totalParticipants,
            'total_days' => $totalDays,
            'completed_at_least_one' => $completedAtLeastOne,
            'not_started' => $totalParticipants - $completedAtLeastOne,
            'total_evaluations' => $totalEvaluations,
            'expected_evaluations' => $expectedEvaluations,
            'overall_completion_rate' => $expectedEvaluations > 0
                ? round(($totalEvaluations / $expectedEvaluations) * 100)
                : 0,
            'day_breakdown' => $dayBreakdown,
            'reminders_sent' => $remindersSent
        ]);
    }

    // ===== POST — Send reminder emails =====
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);

        // --- Send reminder to specific participants ---
        if ($action === 'remind') {
            $workshopId     = isset($input['workshop_id']) ? intval($input['workshop_id']) : 0;
            $participantIds = isset($input['participant_ids']) ? $input['participant_ids'] : [];

            if (!$workshopId || empty($participantIds)) {
                jsonError('Workshop ID and participant IDs are required');
            }

            // Get workshop title
            $stmt = $db->prepare("SELECT title FROM workshops WHERE id = :id");
            $stmt->execute([':id' => $workshopId]);
            $ws = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$ws) jsonError('Workshop not found', 404);

            // Build evaluation link
            $baseUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http')
                . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
            $evalBase = str_replace('/smme-api/api', '/smme', dirname(dirname($_SERVER['SCRIPT_NAME'])));
            $evaluationLink = $baseUrl . $evalBase . '/evaluation.html?program_id=' . $workshopId;

            require_once $base_path . '/helpers/EmailHelper.php';
            $emailHelper = new EmailHelper();

            $sent = 0;
            $failed = 0;
            $results = [];

            foreach ($participantIds as $pid) {
                $stmt = $db->prepare("SELECT id, full_name, email FROM workshop_participants WHERE id = :id AND workshop_id = :wid");
                $stmt->execute([':id' => intval($pid), ':wid' => $workshopId]);
                $participant = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$participant || empty($participant['email'])) {
                    $failed++;
                    $results[] = ['id' => $pid, 'status' => 'failed', 'reason' => 'No email'];
                    continue;
                }

                $ok = $emailHelper->sendEvaluationReminder(
                    $participant['email'],
                    $participant['full_name'],
                    $ws['title'],
                    $evaluationLink
                );

                if ($ok) {
                    $sent++;
                    $results[] = ['id' => $pid, 'status' => 'sent', 'email' => $participant['email']];

                    // Log the reminder
                    try {
                        $db->prepare("
                            INSERT INTO evaluation_reminders (workshop_id, participant_id, sent_by, sent_at)
                            VALUES (:wid, :pid, :uid, NOW())
                        ")->execute([':wid' => $workshopId, ':pid' => $pid, ':uid' => $authUser['id']]);
                    } catch (Exception $e) {
                        // table may not exist, ignore
                    }
                } else {
                    $failed++;
                    $results[] = ['id' => $pid, 'status' => 'failed', 'reason' => 'Email delivery failed'];
                }
            }

            jsonSuccess([
                'sent' => $sent,
                'failed' => $failed,
                'results' => $results
            ], "Sent $sent reminder(s)" . ($failed ? ", $failed failed" : ''));
        }

        // --- Send reminders to ALL incomplete participants ---
        if ($action === 'remind_all') {
            $workshopId = isset($input['workshop_id']) ? intval($input['workshop_id']) : 0;
            $dayId      = isset($input['day_id']) ? intval($input['day_id']) : 0;

            if (!$workshopId) jsonError('Workshop ID is required');

            // Get workshop
            $stmt = $db->prepare("SELECT title FROM workshops WHERE id = :id");
            $stmt->execute([':id' => $workshopId]);
            $ws = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$ws) jsonError('Workshop not found', 404);

            // Find all participants who haven't completed the eval
            if ($dayId) {
                // Incomplete for a specific day
                $stmt = $db->prepare("
                    SELECT wp.id, wp.full_name, wp.email
                    FROM workshop_participants wp
                    WHERE wp.workshop_id = :wid
                      AND wp.id NOT IN (
                          SELECT er.participant_id FROM evaluation_submissions er
                          WHERE er.workshop_day_id = :did
                      )
                      AND wp.email IS NOT NULL AND wp.email != ''
                ");
                $stmt->execute([':wid' => $workshopId, ':did' => $dayId]);
            } else {
                // Incomplete for ANY day (haven't completed all days)
                $dayCount = $db->prepare("SELECT COUNT(*) as cnt FROM workshop_days WHERE workshop_id = :wid");
                $dayCount->execute([':wid' => $workshopId]);
                $totalDays = (int)$dayCount->fetch()['cnt'];

                $stmt = $db->prepare("
                    SELECT wp.id, wp.full_name, wp.email,
                           (SELECT COUNT(DISTINCT er.workshop_day_id)
                            FROM evaluation_submissions er
                            INNER JOIN workshop_days wd ON er.workshop_day_id = wd.id
                            WHERE er.participant_id = wp.id AND wd.workshop_id = :wid2
                           ) AS days_completed
                    FROM workshop_participants wp
                    WHERE wp.workshop_id = :wid
                      AND wp.email IS NOT NULL AND wp.email != ''
                    HAVING days_completed < :total
                ");
                $stmt->execute([':wid' => $workshopId, ':wid2' => $workshopId, ':total' => $totalDays]);
            }

            $incomplete = $stmt->fetchAll(PDO::FETCH_ASSOC);

            if (empty($incomplete)) {
                jsonSuccess(['sent' => 0, 'failed' => 0], 'All participants have completed their evaluations!');
            }

            // Build evaluation link
            $baseUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http')
                . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
            $evalBase = str_replace('/smme-api/api', '/smme', dirname(dirname($_SERVER['SCRIPT_NAME'])));
            $evaluationLink = $baseUrl . $evalBase . '/evaluation.html?program_id=' . $workshopId;

            require_once $base_path . '/helpers/EmailHelper.php';
            $emailHelper = new EmailHelper();

            $sent = 0;
            $failed = 0;

            foreach ($incomplete as $p) {
                $ok = $emailHelper->sendEvaluationReminder(
                    $p['email'],
                    $p['full_name'],
                    $ws['title'],
                    $evaluationLink
                );

                if ($ok) {
                    $sent++;
                    try {
                        $db->prepare("
                            INSERT INTO evaluation_reminders (workshop_id, participant_id, sent_by, sent_at)
                            VALUES (:wid, :pid, :uid, NOW())
                        ")->execute([':wid' => $workshopId, ':pid' => $p['id'], ':uid' => $authUser['id']]);
                    } catch (Exception $e) { /* ignore */ }
                } else {
                    $failed++;
                }
            }

            jsonSuccess([
                'sent' => $sent,
                'failed' => $failed,
                'total_incomplete' => count($incomplete)
            ], "Sent $sent reminder(s) to incomplete participants" . ($failed ? ", $failed failed" : ''));
        }

        jsonError('Unknown action');
    }

    jsonError('Unknown action or method');

} catch (Exception $e) {
    jsonError('Server error: ' . $e->getMessage(), 500);
}
