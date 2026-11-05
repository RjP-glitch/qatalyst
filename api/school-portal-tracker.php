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

function normalizePortalTrackerSchoolYear(string $value): string {
    $value = preg_replace('/^SY\s*/i', '', trim($value));
    return preg_replace('/\s*[\x{2010}-\x{2015}\x{2212}-]\s*/u', '-', $value);
}

function portalSubmissionWorkflow(string $status): array {
    $key = strtolower(trim(str_replace(['_', '-'], ' ', $status)));
    $key = preg_replace('/\s+/', ' ', $key);
    $rank = match ($key) {
        'review', 'endorsed', 'for endorsement' => 1,
        'approved' => 2,
        'released', 'released to school' => 3,
        default => 0,
    };
    $canonical = match ($rank) {
        1 => 'For Endorsement',
        2 => 'Approved',
        3 => 'Released to School',
        default => in_array($key, ['returned', 'rejected', 'returned for correction'], true)
            ? 'Returned for Correction'
            : 'Pending Review',
    };
    return [$canonical, $rank];
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

    // SDO workflow status is stored in school_submissions, not in the manual
    // checklist table. Add the submitted document's workflow cells so portal
    // schools see the same Endorsed / Approved / Released progress as the SDO.
    $yearNameStmt = $db->prepare('SELECT school_year FROM school_tracker_years WHERE id = :id');
    $yearNameStmt->execute([':id' => $requestedYear]);
    $targetYear = normalizePortalTrackerSchoolYear((string)($yearNameStmt->fetchColumn() ?: ''));
    $latestActiveYearId = (int)$db->query(
        'SELECT id FROM school_tracker_years WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
    )->fetchColumn();
    $submissionSchoolWhere = $isPrivate
        ? '(private_school_id = :school_id OR (private_school_id IS NULL AND school_id = :legacy_school_id))'
        : 'school_id = :school_id';
    $subStmt = $db->prepare(
        "SELECT id, type, document_type, status, school_year, updated_at, reviewed_at
         FROM school_submissions
         WHERE {$submissionSchoolWhere}
         ORDER BY COALESCE(updated_at, submitted_at) DESC, id DESC"
    );
    $subParams = [':school_id' => $schoolId];
    if ($isPrivate) $subParams[':legacy_school_id'] = $schoolId;
    $subStmt->execute($subParams);
    $claimedCategories = [];
    $claimedTuitionMode = null;
    foreach ($subStmt->fetchAll(PDO::FETCH_ASSOC) as $submission) {
        $rawStatus = strtolower(trim((string)($submission['status'] ?? '')));
        if ($rawStatus === 'draft') continue;

        $submissionYear = normalizePortalTrackerSchoolYear((string)($submission['school_year'] ?? ''));
        if ($submissionYear !== $targetYear && !($submissionYear === '' && $requestedYear === $latestActiveYearId)) continue;

        $type = strtolower(trim((string)($submission['type'] ?? '')));
        $documentType = strtolower(trim((string)($submission['document_type'] ?? '')));
        $category = null;
        $rowLabels = [''];
        if ($type === 'calendar') {
            $category = 'school_calendar';
            $rowLabels = ['School Calendar'];
        } elseif ($type === 'tuition' || $type === 'no_tuition') {
            $category = ($type === 'no_tuition' || str_contains($documentType, 'no increase'))
                ? 'no_increase'
                : 'tuition_increase';
            $rowLabels = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
        } elseif ($type === 'permit') {
            $category = 'renewal_permit';
        }
        if (in_array($category, ['tuition_increase', 'no_increase'], true)) {
            if ($claimedTuitionMode !== null && $claimedTuitionMode !== $category) continue;
            $claimedTuitionMode = $category;
        }
        if ($category === null || isset($claimedCategories[$category])) continue;
        $claimedCategories[$category] = true;

        [$workflowStatus, $rank] = portalSubmissionWorkflow((string)$submission['status']);
        $steps = [];
        if ($category === 'school_calendar'
            && in_array($workflowStatus, ['Pending Review', 'For Endorsement', 'Approved', 'Released to School'], true)) {
            $steps[] = 'Received w/ Compliance';
        }
        if ($rank >= 1) $steps[] = 'Endorsed to RO';
        if ($rank >= 2) $steps[] = 'Approved';
        if ($rank >= 3) $steps[] = 'Released';

        $allSteps = $category === 'school_calendar'
            ? ['Received w/ Compliance', 'Endorsed to RO', 'Approved', 'Released']
            : ['Endorsed to RO', 'Approved', 'Released'];
        foreach ($rowLabels as $rowLabel) {
            foreach ($allSteps as $stepLabel) {
                $checked = in_array($stepLabel, $steps, true);
                $rows[] = [
                    'id' => null,
                    'category_key' => $category,
                    'row_label' => $rowLabel,
                    'step_label' => $stepLabel,
                    'is_checked' => $checked,
                    'checked_at' => $checked ? ($submission['reviewed_at'] ?: $submission['updated_at']) : null,
                    'notes' => null,
                    'source' => 'submission',
                ];
            }
        }
    }

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
