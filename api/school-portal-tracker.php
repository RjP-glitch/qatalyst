<?php
/**
 * GET /api/school-portal-tracker.php
 * Returns the school_tracker_checklist rows for the authenticated portal user's
 * school and the active school year, plus the list of available years.
 *
 * Optional query param:
 *   ?year_id=N   override the active year (defaults to most recent active year)
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') jsonError('Method not allowed', 405);

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) jsonError('Unauthorized. Please sign in.', 401);

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType === 'sdo_personnel') {
        jsonError('Access denied.', 403);
    }

    $db = getDB();

    // ── Resolve school ────────────────────────────────────────────────────────
    // Match the same detection logic used by the dashboard: school_type may
    // contain values like "Private School" so use str_contains, not strict ===.
    $schoolType     = strtolower((string)($user['school_type'] ?? ''));
    $isPrivate      = str_contains($schoolType, 'private');
    $schoolIdColumn = $isPrivate ? 'private_school_id' : 'school_id';

    $schoolId = $isPrivate
        ? ((int)($user['private_school_id'] ?? 0) ?: 0)
        : ((int)($user['school_id']         ?? 0) ?: 0);

    if (!$schoolId) jsonError('No school linked to this account.', 422);

    // ── Available years ───────────────────────────────────────────────────────
    $stmtYears = $db->query("
        SELECT id, school_year, label, is_active
        FROM school_tracker_years
        ORDER BY id DESC
    ");
    $years = $stmtYears->fetchAll(PDO::FETCH_ASSOC);

    // ── Resolve year_id ───────────────────────────────────────────────────────
    $requestedYear = isset($_GET['year_id']) ? (int)$_GET['year_id'] : 0;

    // Validate requested year exists
    $validYearIds = array_column($years, 'id');
    if ($requestedYear && !in_array($requestedYear, $validYearIds, true)) {
        jsonError('Invalid year_id.', 400);
    }

    // Default: most recent active year
    if (!$requestedYear) {
        foreach ($years as $y) {
            if ($y['is_active']) { $requestedYear = (int)$y['id']; break; }
        }
        // Fallback: just the first year
        if (!$requestedYear && !empty($years)) {
            $requestedYear = (int)$years[0]['id'];
        }
    }

    if (!$requestedYear) jsonError('No school years configured.', 404);

    // ── Checklist rows for this school + year ─────────────────────────────────
    $stmtChecks = $db->prepare("
        SELECT
            id,
            category_key,
            row_label,
            step_label,
            is_checked,
            checked_at,
            notes
        FROM school_tracker_checklist
        WHERE {$schoolIdColumn} = :school_id
          AND year_id            = :year_id
        ORDER BY id ASC
    ");
    $stmtChecks->execute([':school_id' => $schoolId, ':year_id' => $requestedYear]);
    $rows = $stmtChecks->fetchAll(PDO::FETCH_ASSOC);

    // Cast types
    foreach ($rows as &$r) {
        $r['is_checked'] = (bool)$r['is_checked'];
    }
    unset($r);

    // ── Current year label ────────────────────────────────────────────────────
    $currentYear = null;
    foreach ($years as $y) {
        if ((int)$y['id'] === $requestedYear) { $currentYear = $y; break; }
    }

    jsonSuccess([
        'school_id'    => $schoolId,
        'year_id'      => $requestedYear,
        'current_year' => $currentYear,
        'years'        => $years,
        'checklist'    => $rows,
    ]);

} catch (Throwable $e) {
    error_log(sprintf('school-portal-tracker.php [%s line %d]: %s', basename($e->getFile()), $e->getLine(), $e->getMessage()));
    jsonError('Server error. Please try again.', 500);
}
