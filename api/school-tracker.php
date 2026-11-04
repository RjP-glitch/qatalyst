<?php
/**
 * school-tracker.php
 * REST-style API for the Document Tracking System — Private School
 * Application and Request checklist.
 *
 * Supported actions (via GET ?action=):
 *   GET  load              ?year_id=N&school_type=private|public  — load checkbox states
 *   GET  years                                                     — list all school years
 *   GET  check_year_empty  ?year_id=N                             — check if year has records
 *   POST save                                                      — upsert one or many cells
 *   POST add_year                                                  — insert a new school year
 *   POST delete_year                                               — delete an empty year
 *
 * All responses: JSON  { success: bool, ... }
 * All endpoints require authentication + 'checklist' permission.
 *
 * CHANGELOG:
 *   - load: now returns { is_checked, checked_at, checked_by_name } per cell
 *     so the front-end can display timestamps next to each checkbox.
 *   - save: accepts optional custom_timestamp (ISO string) per cell to allow
 *     manual override of checked_at from the UI timestamp editor.
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

// ── helpers ──────────────────────────────────────────────────────────────────
function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError(string $msg, int $code = 400): void {
    jsonOut(['success' => false, 'message' => $msg], $code);
}

function isValidQuarterKey($q): bool {
    return is_string($q) && preg_match('/^Q[1-4]$/', $q);
}

/**
 * Extracts a quarter key (Q1..Q4) from the notes column.
 * Notes may be JSON (preferred) or plain text.
 */
function quarterFromNotes($notes): ?string {
    if ($notes === null) return null;
    $s = trim((string)$notes);
    if ($s === '') return null;

    $decoded = json_decode($s, true);
    if (is_array($decoded)) {
        $q = $decoded['q'] ?? ($decoded['quarter'] ?? null);
        if (isValidQuarterKey($q)) return $q;
    }

    if (preg_match('/\bQ([1-4])\b/i', $s, $m)) {
        return 'Q' . (int)$m[1];
    }
    if (preg_match('/\b([1-4])(?:st|nd|rd|th)?\s*quarter\b/i', $s, $m)) {
        return 'Q' . (int)$m[1];
    }
    return null;
}

/**
 * Returns the schools table name for the given school_type.
 * Defaults to 'private_schools' for backwards compatibility.
 */
function schoolsTable(string $schoolType): string {
    return $schoolType === 'public' ? 'public_schools' : 'private_schools';
}

/**
 * Convert an online submission status into the tracker cells it owns.
 * Submission status is authoritative for these workflow categories; other
 * tracker categories continue to be maintained manually.
 */
function submissionTrackerMapping(array $submission): ?array {
    $type = strtolower(trim((string)($submission['type'] ?? '')));
    $docType = strtolower(trim((string)($submission['document_type'] ?? '')));
    $status = strtolower(trim((string)($submission['status'] ?? '')));

    // Drafts are not submissions and must not hide an SDO-created
    // endorsement from the tracker when no submitted record exists.
    if ($status === 'draft') return null;

    $category = null;
    $rows = [''];
    if ($type === 'calendar') {
        $category = 'school_calendar';
        $rows = ['School Calendar'];
    } elseif ($type === 'tuition' || $type === 'no_tuition') {
        $isNoIncrease = $type === 'no_tuition' || str_contains($docType, 'no increase');
        $category = $isNoIncrease ? 'no_increase' : 'tuition_increase';
        $rows = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
    } elseif ($type === 'permit') {
        $category = 'renewal_permit';
    }
    if ($category === null) return null;

    $statusMap = [
        'pending' => 'Pending Review',
        'pending review' => 'Pending Review',
        'review' => 'For Endorsement',
        'endorsed' => 'For Endorsement',
        'for endorsement' => 'For Endorsement',
        'approved' => 'Approved',
        'released' => 'Released to School',
        'released to school' => 'Released to School',
        'rejected' => 'Returned for Correction',
        'returned for correction' => 'Returned for Correction',
        'draft' => 'draft',
    ];
    $status = $statusMap[$status] ?? $status;
    $rank = [
        'Pending Review' => 0,
        'Returned for Correction' => 0,
        'draft' => 0,
        'For Endorsement' => 1,
        'Approved' => 2,
        'Released to School' => 3,
    ];
    $currentRank = $rank[$status] ?? 0;
    $steps = [];
    if ($type === 'calendar') {
        if (in_array($status, ['Pending Review', 'For Endorsement', 'Approved', 'Released to School'], true)) {
            $steps[] = 'Received w/ Compliance';
        }
        if ($currentRank >= 1) $steps[] = 'Endorsed to RO';
        if ($currentRank >= 2) $steps[] = 'Approved';
        if ($currentRank >= 3) $steps[] = 'Released';
    } else {
        if ($currentRank >= 1) $steps[] = 'Endorsed to RO';
        if ($currentRank >= 2) $steps[] = 'Approved';
        if ($currentRank >= 3) $steps[] = 'Released';
    }

    return ['category' => $category, 'rows' => $rows, 'steps' => $steps];
}

/** Map a saved indorsement to tracker steps when no online submission exists. */
function indorsementTrackerMapping(array $indorsement): ?array {
    $type = strtolower(trim((string)($indorsement['type'] ?? '')));
    $indNumber = (int)($indorsement['ind_number'] ?? 0);
    if ($indNumber < 1) return null;

    $category = null;
    $rows = [''];
    if ($type === 'school_calendar') {
        $category = 'school_calendar';
        $rows = ['School Calendar'];
    } elseif ($type === 'tuition_increase') {
        $category = 'tuition_increase';
        $rows = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
    } elseif ($type === 'no_increase') {
        $category = 'no_increase';
        $rows = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
    } elseif ($type === 'school_permit') {
        $category = 'renewal_permit';
    }
    if ($category === null) return null;

    $steps = $indNumber >= 3 ? ['Endorsed to RO', 'Approved'] : ['Endorsed to RO'];
    if ($category === 'school_calendar') array_unshift($steps, 'Received w/ Compliance');
    return ['category' => $category, 'rows' => $rows, 'steps' => $steps];
}

function normalizeTrackerSchoolYear(string $value): string {
    $value = preg_replace('/^SY\s*/i', '', trim($value));
    return preg_replace('/\s*[\x{2010}-\x{2015}\x{2212}-]\s*/u', '-', $value);
}

function hasSubmissionsForTrackerYear(PDO $pdo, int $yearId): bool {
    $yearStmt = $pdo->prepare('SELECT school_year FROM school_tracker_years WHERE id = :id');
    $yearStmt->execute([':id' => $yearId]);
    $targetYear = normalizeTrackerSchoolYear((string)($yearStmt->fetchColumn() ?: ''));
    $latestActiveYearId = (int)$pdo->query('SELECT id FROM school_tracker_years WHERE is_active = 1 ORDER BY id DESC LIMIT 1')->fetchColumn();
    $stmt = $pdo->query('SELECT school_year FROM school_submissions');
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $submissionYear) {
        $normalized = normalizeTrackerSchoolYear((string)$submissionYear);
        if ($normalized === $targetYear || ($normalized === '' && $yearId === $latestActiveYearId)) return true;
    }
    return false;
}

// ── router ───────────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $body = $raw ? (json_decode($raw, true) ?? []) : [];
}

try {
    $pdo = getDb();

    // ── GET years ──────────────────────────────────────────────────────────
    if ($method === 'GET' && $action === 'years') {
        $stmt = $pdo->query(
            "SELECT id, school_year, label, is_active
             FROM school_tracker_years
             WHERE is_active = 1
             ORDER BY school_year ASC"
        );
        jsonOut(['success' => true, 'years' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    // ── GET load ───────────────────────────────────────────────────────────
    // Now returns checked_at and checked_by_name so the front-end can show
    // timestamps next to each checkbox without an extra round-trip.
    if ($method === 'GET' && $action === 'load') {
        $yearId     = filter_input(INPUT_GET, 'year_id', FILTER_VALIDATE_INT);
        $schoolType = isset($_GET['school_type']) && $_GET['school_type'] === 'public' ? 'public' : 'private';

        if (!$yearId) jsonError('year_id is required');

        $tbl = schoolsTable($schoolType);

        $stmt = $pdo->prepare(
            "SELECT s.id                   AS school_id,
                    c.category_key,
                    c.row_label,
                    c.step_label,
                    c.is_checked,
                    c.notes,
                    c.checked_at,
                    u.full_name            AS checked_by_name
             FROM   school_tracker_checklist c
             JOIN   `{$tbl}` s ON s.id = c.private_school_id
             LEFT JOIN users u ON u.id = c.checked_by
             WHERE  c.year_id    = :year_id
               AND  c.school_type = :school_type
               AND  s.active = 1
             ORDER BY s.id, c.category_key, c.row_label, c.step_label"
        );
        $stmt->execute([
            ':year_id'     => $yearId,
            ':school_type' => $schoolType,
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Build data map:
        //   data[school_id][composite_key] = { checked: bool, ts: "ISO string or null", by: "name or null", q: "Q1..Q4 or null" }
        $data = [];
        foreach ($rows as $row) {
            $sid = (int)$row['school_id'];
            $key = $row['category_key'] . '|' . $row['row_label'] . '|' . $row['step_label'];
            if (!isset($data[$sid])) $data[$sid] = [];
            $q = quarterFromNotes($row['notes'] ?? null);
            $data[$sid][$key] = [
                'checked' => (bool)$row['is_checked'],
                // If a quarter is set, treat it as quarter-only and prefer not to show an exact timestamp.
                'ts'      => $q ? null : ($row['checked_at'] ?: null),
                'by'      => $row['checked_by_name'] ?: null,
                'q'       => $q,
            ];
        }

        // Overlay the online-submission workflow categories from their source
        // records. The most recently updated submission owns each school/year/
        // category; all of that category's tracker cells become read-only.
        $yearStmt = $pdo->prepare('SELECT school_year FROM school_tracker_years WHERE id = :id');
        $yearStmt->execute([':id' => $yearId]);
        $trackerYear = normalizeTrackerSchoolYear((string)($yearStmt->fetchColumn() ?: ''));
        $latestActiveYearId = (int)$pdo->query('SELECT id FROM school_tracker_years WHERE is_active = 1 ORDER BY id DESC LIMIT 1')->fetchColumn();
        $schoolIdColumn = $schoolType === 'private' ? 'private_school_id' : 'school_id';
        $subStmt = $pdo->prepare(
            "SELECT id, {$schoolIdColumn} AS target_school_id, type, document_type,
                    status, school_year, updated_at, reviewed_at
             FROM school_submissions
             WHERE {$schoolIdColumn} IS NOT NULL AND {$schoolIdColumn} > 0
             ORDER BY COALESCE(updated_at, submitted_at) DESC, id DESC"
        );
        $subStmt->execute();
        $managedCells = [];
        $claimedCategories = [];
        $submittedTuitionCategory = [];
        foreach ($subStmt->fetchAll(PDO::FETCH_ASSOC) as $submission) {
            $submissionYear = normalizeTrackerSchoolYear((string)($submission['school_year'] ?? ''));
            if ($submissionYear !== $trackerYear && !($submissionYear === '' && $yearId === $latestActiveYearId)) continue;
            $mapping = submissionTrackerMapping($submission);
            if ($mapping === null) continue;

            $sid = (int)$submission['target_school_id'];
            $category = $mapping['category'];
            if (in_array($category, ['tuition_increase', 'no_increase'], true)) {
                if (isset($submittedTuitionCategory[$sid]) && $submittedTuitionCategory[$sid] !== $category) continue;
                $submittedTuitionCategory[$sid] = $category;
            }
            $claim = $sid . '|' . $category;
            if (isset($claimedCategories[$claim])) continue;
            $claimedCategories[$claim] = true;
            if (!isset($data[$sid])) $data[$sid] = [];
            if (!isset($managedCells[$sid])) $managedCells[$sid] = [];

            $allSteps = $category === 'school_calendar'
                ? ['Received w/ Compliance', 'Endorsed to RO', 'Approved', 'Released']
                : ['Endorsed to RO', 'Approved', 'Released'];
            foreach ($mapping['rows'] as $rowLabel) {
                foreach ($allSteps as $stepLabel) {
                    $key = $category . '|' . $rowLabel . '|' . $stepLabel;
                    $isChecked = in_array($stepLabel, $mapping['steps'], true);
                    $data[$sid][$key] = [
                        'checked' => $isChecked,
                        'ts' => $isChecked ? ($submission['reviewed_at'] ?: $submission['updated_at']) : null,
                        'by' => null,
                        'q' => null,
                        'source' => 'submission',
                    ];
                    $managedCells[$sid][] = $key;
                }
            }
        }

        // If there is no online submission for a category, use the saved
        // endorsement as the tracker source so admin-created endorsements are
        // visible in the same summary and their status cells stay read-only.
        $endorsementSchoolColumn = $schoolType === 'private' ? 'private_school_id' : 'school_id';
        $endorsementSchoolWhere = $schoolType === 'private'
            ? '(private_school_id IS NOT NULL AND private_school_id > 0 OR (private_school_id IS NULL AND school_id IS NOT NULL AND school_id > 0))'
            : '(school_id IS NOT NULL AND school_id > 0)';
        $indStmt = $pdo->prepare(
            "SELECT id, {$endorsementSchoolColumn} AS target_school_id, school_id,
                    private_school_id, type, ind_number, school_year,
                    COALESCE(updated_at, created_at) AS status_at
             FROM school_indorsements
             WHERE {$endorsementSchoolWhere}
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC"
        );
        $indStmt->execute();
        foreach ($indStmt->fetchAll(PDO::FETCH_ASSOC) as $indorsement) {
            $indYear = normalizeTrackerSchoolYear((string)($indorsement['school_year'] ?? ''));
            if ($indYear !== $trackerYear) continue;
            $mapping = indorsementTrackerMapping($indorsement);
            if ($mapping === null) continue;

            $sid = (int)($indorsement['target_school_id'] ?? 0);
            if ($schoolType === 'private' && empty($indorsement['private_school_id'])) {
                $sid = (int)($indorsement['school_id'] ?? 0); // legacy private indorsements
            }
            if (!$sid) continue;
            $category = $mapping['category'];
            if (in_array($category, ['tuition_increase', 'no_increase'], true)) {
                if (isset($submittedTuitionCategory[$sid]) && $submittedTuitionCategory[$sid] !== $category) continue;
                $submittedTuitionCategory[$sid] = $category;
            }
            $claim = $sid . '|' . $category;
            if (isset($claimedCategories[$claim])) continue;
            $claimedCategories[$claim] = true;
            if (!isset($data[$sid])) $data[$sid] = [];
            if (!isset($managedCells[$sid])) $managedCells[$sid] = [];

            $allSteps = $category === 'school_calendar'
                ? ['Received w/ Compliance', 'Endorsed to RO', 'Approved', 'Released']
                : ['Endorsed to RO', 'Approved', 'Released'];
            foreach ($mapping['rows'] as $rowLabel) {
                foreach ($allSteps as $stepLabel) {
                    $key = $category . '|' . $rowLabel . '|' . $stepLabel;
                    $isChecked = in_array($stepLabel, $mapping['steps'], true);
                    $data[$sid][$key] = [
                        'checked' => $isChecked,
                        'ts' => $isChecked ? ($indorsement['status_at'] ?: null) : null,
                        'by' => null,
                        'q' => null,
                        'source' => 'endorsement',
                    ];
                    $managedCells[$sid][] = $key;
                }
            }
        }

        // The current tuition mode is authoritative. Hide and lock any old
        // manually saved checks in the opposite mode so legacy marks cannot
        // overlap the school's newer submission or keep the wrong mode locked.
        $tuitionRows = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
        $tuitionSteps = ['Endorsed to RO', 'Approved', 'Released'];
        foreach ($submittedTuitionCategory as $sid => $activeCategory) {
            $oppositeCategory = $activeCategory === 'no_increase' ? 'tuition_increase' : 'no_increase';
            if (!isset($data[$sid])) $data[$sid] = [];
            if (!isset($managedCells[$sid])) $managedCells[$sid] = [];
            foreach ($tuitionRows as $rowLabel) {
                foreach ($tuitionSteps as $stepLabel) {
                    $key = $oppositeCategory . '|' . $rowLabel . '|' . $stepLabel;
                    $data[$sid][$key] = [
                        'checked' => false,
                        'ts' => null,
                        'by' => null,
                        'q' => null,
                        'source' => 'tuition_mode',
                    ];
                    if (!in_array($key, $managedCells[$sid], true)) $managedCells[$sid][] = $key;
                }
            }
        }

        jsonOut(['success' => true, 'year_id' => $yearId, 'data' => $data, 'managed_cells' => $managedCells]);
    }

    // ── GET check_year_empty ───────────────────────────────────────────────
    if ($method === 'GET' && $action === 'check_year_empty') {
        $yearId = filter_input(INPUT_GET, 'year_id', FILTER_VALIDATE_INT);
        if (!$yearId) jsonError('year_id is required');

        $stmt = $pdo->prepare(
            "SELECT COUNT(*) AS cnt
             FROM school_tracker_checklist
             WHERE year_id = ? AND is_checked = 1"
        );
        $stmt->execute([$yearId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        $hasSubmissions = hasSubmissionsForTrackerYear($pdo, (int)$yearId);
        jsonOut(['success' => true, 'empty' => ((int)$row['cnt'] === 0 && !$hasSubmissions)]);
    }

    // ── POST save ──────────────────────────────────────────────────────────
    // Accepts cells as:
    //   { "cat|row|step": true }          — simple bool (backwards compat)
    //   { "cat|row|step": { checked: true, ts: "2025-06-01T09:30:00" } } — with custom timestamp
    //   { "cat|row|step": { checked: true, q: "Q2" } } — quarter-only (no exact date)
    if ($method === 'POST' && $action === 'save') {
        $yearId     = isset($body['year_id'])     ? (int)$body['year_id']   : 0;
        $schoolId   = isset($body['school_id'])   ? (int)$body['school_id'] : 0;
        $schoolType = isset($body['school_type']) && $body['school_type'] === 'public' ? 'public' : 'private';
        $cells      = $body['cells'] ?? [];

        if (!$yearId)   jsonError('year_id is required');
        if (!$schoolId) jsonError('school_id is required');
        if (!is_array($cells) || empty($cells)) jsonError('cells must be a non-empty object');

        $tbl = schoolsTable($schoolType);

        $chkStmt = $pdo->prepare("SELECT id FROM `{$tbl}` WHERE id = :id AND active = 1");
        $chkStmt->execute([':id' => $schoolId]);
        if (!$chkStmt->fetch()) jsonError('Invalid school_id', 404);

        $yrStmt = $pdo->prepare("SELECT id FROM school_tracker_years WHERE id = :id");
        $yrStmt->execute([':id' => $yearId]);
        if (!$yrStmt->fetch()) jsonError('Invalid year_id', 404);

        // Enforce the read-only submission mapping server-side too, including
        // saves from a tracker tab that was opened before a school submitted.
        $yearNameStmt = $pdo->prepare('SELECT school_year FROM school_tracker_years WHERE id = :id');
        $yearNameStmt->execute([':id' => $yearId]);
        $targetYear = normalizeTrackerSchoolYear((string)($yearNameStmt->fetchColumn() ?: ''));
        $latestActiveYearId = (int)$pdo->query('SELECT id FROM school_tracker_years WHERE is_active = 1 ORDER BY id DESC LIMIT 1')->fetchColumn();
        $schoolIdColumn = $schoolType === 'private' ? 'private_school_id' : 'school_id';
        $managedStmt = $pdo->prepare(
            "SELECT type, document_type, status, school_year
             FROM school_submissions
             WHERE {$schoolIdColumn} = :school_id
             ORDER BY COALESCE(updated_at, submitted_at) DESC, id DESC"
        );
        $managedStmt->execute([':school_id' => $schoolId]);
        $managedCellKeys = [];
        $managedCategories = [];
        $submittedTuitionCategory = null;
        $submittedTuitionCheckedCategory = null;
        foreach ($managedStmt->fetchAll(PDO::FETCH_ASSOC) as $submission) {
            $submissionYear = normalizeTrackerSchoolYear((string)($submission['school_year'] ?? ''));
            if ($submissionYear !== $targetYear && !($submissionYear === '' && $yearId === $latestActiveYearId)) continue;
            $mapping = submissionTrackerMapping($submission);
            if ($mapping === null || isset($managedCategories[$mapping['category']])) continue;
            if (in_array($mapping['category'], ['tuition_increase', 'no_increase'], true)) {
                if ($submittedTuitionCategory !== null && $submittedTuitionCategory !== $mapping['category']) continue;
                $submittedTuitionCategory = $mapping['category'];
                if ($submittedTuitionCheckedCategory === null && !empty($mapping['steps'])) {
                    $submittedTuitionCheckedCategory = $mapping['category'];
                }
            }
            $managedCategories[$mapping['category']] = true;
            $steps = $mapping['category'] === 'school_calendar'
                ? ['Received w/ Compliance', 'Endorsed to RO', 'Approved', 'Released']
                : ['Endorsed to RO', 'Approved', 'Released'];
            foreach ($mapping['rows'] as $rowLabel) {
                foreach ($steps as $stepLabel) {
                    $managedCellKeys[$mapping['category'] . '|' . $rowLabel . '|' . $stepLabel] = true;
                }
            }
        }

        // A saved endorsement also owns its workflow cells when there is no
        // matching online submission, so direct API saves cannot override it.
        $indSchoolCondition = $schoolType === 'private'
            ? '(private_school_id = :school_id OR (private_school_id IS NULL AND school_id = :legacy_school_id))'
            : '(school_id = :school_id AND private_school_id IS NULL)';
        $indStmt = $pdo->prepare(
            "SELECT type, ind_number, school_year, private_school_id
             FROM school_indorsements
             WHERE {$indSchoolCondition}
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC"
        );
        $indParams = [':school_id' => $schoolId];
        if ($schoolType === 'private') $indParams[':legacy_school_id'] = $schoolId;
        $indStmt->execute($indParams);
        foreach ($indStmt->fetchAll(PDO::FETCH_ASSOC) as $indorsement) {
            if (normalizeTrackerSchoolYear((string)($indorsement['school_year'] ?? '')) !== $targetYear) continue;
            $mapping = indorsementTrackerMapping($indorsement);
            if ($mapping === null || isset($managedCategories[$mapping['category']])) continue;
            if (in_array($mapping['category'], ['tuition_increase', 'no_increase'], true)) {
                if ($submittedTuitionCategory !== null && $submittedTuitionCategory !== $mapping['category']) continue;
                $submittedTuitionCategory = $mapping['category'];
                if ($submittedTuitionCheckedCategory === null && !empty($mapping['steps'])) {
                    $submittedTuitionCheckedCategory = $mapping['category'];
                }
            }
            $managedCategories[$mapping['category']] = true;
            $steps = $mapping['category'] === 'school_calendar'
                ? ['Received w/ Compliance', 'Endorsed to RO', 'Approved', 'Released']
                : ['Endorsed to RO', 'Approved', 'Released'];
            foreach ($mapping['rows'] as $rowLabel) {
                foreach ($steps as $stepLabel) {
                    $managedCellKeys[$mapping['category'] . '|' . $rowLabel . '|' . $stepLabel] = true;
                }
            }
        }

        // Ignore legacy checked cells from the opposite tuition mode whenever
        // a current submission or saved endorsement establishes the active mode.
        if ($submittedTuitionCategory !== null) {
            $oppositeCategory = $submittedTuitionCategory === 'no_increase' ? 'tuition_increase' : 'no_increase';
            foreach (['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'] as $rowLabel) {
                foreach (['Endorsed to RO', 'Approved', 'Released'] as $stepLabel) {
                    $managedCellKeys[$oppositeCategory . '|' . $rowLabel . '|' . $stepLabel] = true;
                }
            }
        }

        // Enforce mutually exclusive tuition modes against the final saved
        // checkbox state, while still allowing admins to clear existing marks.
        $tuitionCellState = [];
        $existingTuitionStmt = $pdo->prepare(
            "SELECT category_key, row_label, step_label
             FROM school_tracker_checklist
             WHERE year_id = :year_id
               AND school_type = :school_type
               AND is_checked = 1
               AND category_key IN ('tuition_increase', 'no_increase')
               AND " . ($schoolType === 'private' ? 'private_school_id' : 'school_id') . " = :school_id"
        );
        $existingTuitionStmt->execute([
            ':year_id' => $yearId,
            ':school_type' => $schoolType,
            ':school_id' => $schoolId,
        ]);
        foreach ($existingTuitionStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $key = $row['category_key'] . '|' . $row['row_label'] . '|' . $row['step_label'];
            if ($submittedTuitionCategory !== null && str_starts_with($key, $oppositeCategory . '|')) continue;
            $tuitionCellState[$key] = true;
        }
        foreach ($cells as $compositeKey => $cellValue) {
            if (isset($managedCellKeys[$compositeKey])) continue;
            $parts = explode('|', (string)$compositeKey, 3);
            if (count($parts) !== 3 || !in_array($parts[0], ['tuition_increase', 'no_increase'], true)) continue;
            $isChecked = is_array($cellValue) ? !empty($cellValue['checked']) : (bool)$cellValue;
            if ($isChecked) $tuitionCellState[$compositeKey] = true;
            else unset($tuitionCellState[$compositeKey]);
        }
        $hasIncrease = false;
        $hasNoIncrease = false;
        foreach (array_keys($tuitionCellState) as $key) {
            if (str_starts_with($key, 'tuition_increase|')) $hasIncrease = true;
            if (str_starts_with($key, 'no_increase|')) $hasNoIncrease = true;
        }
        if ($submittedTuitionCheckedCategory === 'tuition_increase') $hasIncrease = true;
        if ($submittedTuitionCheckedCategory === 'no_increase') $hasNoIncrease = true;
        if ($hasIncrease && $hasNoIncrease) {
            jsonError('Increase and No Increase tuition statuses cannot both be marked. Clear all checked boxes in one section before saving.', 409);
        }

        // Detect whether checked_at can be NULL (some deployments may have stricter schemas).
        $checkedAtNullable = true;
        try {
            $col = $pdo->query(
                "SELECT IS_NULLABLE
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'school_tracker_checklist'
                   AND COLUMN_NAME = 'checked_at'")
                ->fetch(PDO::FETCH_ASSOC);
            if ($col && isset($col['IS_NULLABLE'])) {
                $checkedAtNullable = (strtoupper((string)$col['IS_NULLABLE']) === 'YES');
            }
        } catch (Throwable $e) {
            // If we can't detect it, assume nullable (existing behaviour in most setups).
            $checkedAtNullable = true;
        }

                // Single upsert that allows:
                // - checked_at = NULL (unchecked or quarter-only)
                // - checked_at = explicit datetime string
                // - notes to store quarter metadata
                $upsert = $pdo->prepare(
                        "INSERT INTO school_tracker_checklist
                             (school_id, private_school_id, year_id, school_type, category_key, row_label, step_label, is_checked, checked_by, checked_at, notes)
                         VALUES
                             (:school_id, :private_school_id, :year_id, :school_type, :cat, :row, :step, :checked, :user, :ts, :notes)
                         ON DUPLICATE KEY UPDATE
                             private_school_id = VALUES(private_school_id),
                             is_checked = VALUES(is_checked),
                             checked_by = VALUES(checked_by),
                             checked_at = VALUES(checked_at),
                             notes      = VALUES(notes)"
                );

        $pdo->beginTransaction();
        try {
            foreach ($cells as $compositeKey => $cellValue) {
                if (isset($managedCellKeys[$compositeKey])) continue;
                $parts = explode('|', $compositeKey, 3);
                if (count($parts) !== 3) continue;

                [$catKey, $rowLabel, $stepLabel] = $parts;
                $catKey    = mb_substr($catKey,    0, 60);
                $rowLabel  = mb_substr($rowLabel,  0, 100);
                $stepLabel = mb_substr($stepLabel, 0, 100);

                // Support both the old bool format and the new {checked, ts, q} object format
                if (is_array($cellValue)) {
                    $isChecked       = !empty($cellValue['checked']);
                    $customTimestamp = isset($cellValue['ts']) ? (string)$cellValue['ts'] : null;
                    $quarterKey      = isset($cellValue['q']) ? strtoupper(trim((string)$cellValue['q'])) : null;
                } else {
                    $isChecked       = (bool)$cellValue;
                    $customTimestamp = null;
                    $quarterKey      = null;
                }

                if (!isValidQuarterKey($quarterKey)) {
                    $quarterKey = null;
                }

                // Validate custom timestamp — must be a parseable date string
                if ($customTimestamp !== null) {
                    $parsed = strtotime($customTimestamp);
                    if ($parsed === false) {
                        $customTimestamp = null; // fall back to NOW()
                    } else {
                        // Normalise to MySQL DATETIME format
                        $customTimestamp = date('Y-m-d H:i:s', $parsed);
                    }
                }

                // Decide what to store
                $checkedAt = null;
                $notes     = null;
                if (!$isChecked) {
                    $checkedAt = $checkedAtNullable ? null : date('Y-m-d H:i:s');
                    $notes = null;
                } else if ($quarterKey !== null && $customTimestamp === null) {
                    // Quarter-only: no exact date/time.
                    $checkedAt = $checkedAtNullable ? null : date('Y-m-d H:i:s');
                    $notes = json_encode(['q' => $quarterKey], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                } else if ($customTimestamp !== null) {
                    // Exact timestamp
                    $checkedAt = $customTimestamp;
                    $notes = null;
                } else {
                    // Default behaviour: stamp when saved
                    $checkedAt = date('Y-m-d H:i:s');
                    $notes = null;
                }

                $base = [
                    ':school_id'        => $schoolId,
                    ':private_school_id' => $schoolId,
                    ':year_id'          => $yearId,
                    ':school_type' => $schoolType,
                    ':cat'         => $catKey,
                    ':row'         => $rowLabel,
                    ':step'        => $stepLabel,
                    ':checked'     => $isChecked ? 1 : 0,
                    ':user'        => $authUser['id'] ?? null,
                    ':ts'          => $checkedAt,
                    ':notes'       => $notes,
                ];

                $upsert->execute($base);
            }
            $pdo->commit();
            jsonOut(['success' => true, 'saved' => count($cells)]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    // ── POST add_year ──────────────────────────────────────────────────────
    if ($method === 'POST' && $action === 'add_year') {
        $sy    = trim((string)($body['school_year'] ?? ''));
        $label = trim((string)($body['label']       ?? ''));

        if (!$sy) jsonError('school_year is required');
        if (!preg_match('/^\d{4}-\d{4}$/', $sy)) {
            jsonError('school_year must be in YYYY-YYYY format (e.g. 2026-2027)');
        }

        $ins = $pdo->prepare(
            "INSERT INTO school_tracker_years (school_year, label, created_by, is_active)
             VALUES (:sy, :label, :user, 1)
             ON DUPLICATE KEY UPDATE label = VALUES(label), is_active = 1"
        );
        $ins->execute([
            ':sy'    => $sy,
            ':label' => $label ?: 'SY ' . $sy,
            ':user'  => $authUser['id'] ?? null,
        ]);

        $yearStmt = $pdo->prepare(
            'SELECT id, school_year, label FROM school_tracker_years WHERE school_year = :sy AND is_active = 1'
        );
        $yearStmt->execute([':sy' => $sy]);
        $year = $yearStmt->fetch(PDO::FETCH_ASSOC);
        if (!$year) jsonError('Could not activate the school year.', 500);
        jsonOut([
            'success' => true,
            'already_exists' => $ins->rowCount() === 0,
            'year'    => $year,
        ]);
    }

    // ── POST delete_year ───────────────────────────────────────────────────
    if ($method === 'POST' && $action === 'delete_year') {
        $yearId = isset($body['year_id']) ? (int)$body['year_id'] : 0;
        if (!$yearId) jsonError('year_id is required');

        // Double-check on the server: refuse if any checked records exist
        $chk = $pdo->prepare(
            "SELECT COUNT(*) AS cnt
             FROM school_tracker_checklist
             WHERE year_id = ? AND is_checked = 1"
        );
        $chk->execute([$yearId]);
        $row = $chk->fetch(PDO::FETCH_ASSOC);

        if ((int)$row['cnt'] > 0 || hasSubmissionsForTrackerYear($pdo, $yearId)) {
            jsonError('Cannot delete this year — it still has tracking records or school submissions.', 409);
        }

        // Delete any unchecked rows for this year, then the year itself
        $pdo->prepare("DELETE FROM school_tracker_checklist WHERE year_id = ?")->execute([$yearId]);
        $pdo->prepare("UPDATE school_tracker_years SET is_active = 0 WHERE id = ?")->execute([$yearId]);

        jsonOut(['success' => true]);
    }

    jsonError('Unknown action: ' . htmlspecialchars($action));

} catch (Throwable $e) {
    error_log('school-tracker.php error: ' . $e->getMessage());
    jsonError('Server error — please try again.', 500);
}
