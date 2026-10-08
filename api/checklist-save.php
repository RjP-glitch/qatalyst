<?php
/**
 * checklist-save.php — Save Compliance Report to Database
 *
 * POST JSON body:
 *   checklistType     string  'tuition_increase'|'no_increase'|'school_calendar'
 *   complianceScore   int     0–100
 *   overallStatus     string  'COMPLIANT'|'NON-COMPLIANT'|'NEEDS REVIEW'
 *   aiSummary         string
 *   matchedData       object  {schoolName, location, syApplied, govRecogNo, ...}
 *   items             array   [{id, text, found, remark}, ...]
 *   fileName          string  original uploaded filename
 *   calendarDaysFound int|null  only present for school_calendar type
 *
 * Returns:
 *   { success: true, report_id: <int> }
 *   { success: false, message: '<reason>' }
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ── Auth ──────────────────────────────────────────────────────────────────────
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

// ── Read + validate body ──────────────────────────────────────────────────────
$raw = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!$body || !is_array($body)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid JSON body.']);
    exit;
}

$checklistType   = trim($body['checklistType']   ?? '');
$complianceScore = (int)($body['complianceScore'] ?? 0);
$overallStatus   = trim($body['overallStatus']    ?? 'NEEDS REVIEW');
$aiSummary       = trim($body['aiSummary']        ?? '');
$matchedData     = $body['matchedData']           ?? [];
$items           = $body['items']                 ?? [];
$fileName        = trim($body['fileName']         ?? '');
$calendarDays    = isset($body['calendarDaysFound']) && is_numeric($body['calendarDaysFound'])
                     ? (int)$body['calendarDaysFound']
                     : null;

$allowedTypes = ['tuition_increase', 'no_increase', 'school_calendar'];
if (!in_array($checklistType, $allowedTypes, true)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid checklist type.']);
    exit;
}

$allowedStatuses = ['COMPLIANT', 'NON-COMPLIANT', 'NEEDS REVIEW'];
if (!in_array($overallStatus, $allowedStatuses, true)) {
    $overallStatus = 'NEEDS REVIEW';
}

$complianceScore = max(0, min(100, $complianceScore));

// ── Map checklist type to school_submissions.type enum ────────────────────────
$submissionTypeMap = [
    'tuition_increase' => 'tuition',
    'no_increase'      => 'tuition',
    'school_calendar'  => 'calendar',
];
$submissionType = $submissionTypeMap[$checklistType];

// ── Extract common fields ─────────────────────────────────────────────────────
$schoolName = trim($matchedData['schoolName'] ?? '');
$syApplied  = trim($matchedData['syApplied']  ?? '');
$location   = trim($matchedData['location']   ?? '');

// ── Determine school_id / district_id from users table if available ───────────
$userId     = (int)($authUser['id'] ?? 0);
$schoolId   = isset($authUser['school_id'])   ? (int)$authUser['school_id']   : null;
$districtId = isset($authUser['district_id']) ? (int)$authUser['district_id'] : null;

// ── Build a descriptive title ─────────────────────────────────────────────────
$typeLabel = [
    'tuition_increase' => 'Tuition Fee Increase',
    'no_increase'      => 'No Increase',
    'school_calendar'  => 'School Calendar',
][$checklistType];

$title = trim($schoolName
    ? "{$typeLabel} — {$schoolName}" . ($syApplied ? " ({$syApplied})" : '')
    : "{$typeLabel} Compliance Check"
);

// ── Encode JSON blobs ─────────────────────────────────────────────────────────
$itemsJson  = json_encode($items,       JSON_UNESCAPED_UNICODE);
$fieldsJson = json_encode($matchedData, JSON_UNESCAPED_UNICODE);

// ── Extra metadata for calendar submissions ───────────────────────────────────
// We embed the calendar-specific details into the remarks column of school_submissions
// and into extra columns in checklist_results.
$remarks = "Compliance Score: {$complianceScore}%  |  Status: {$overallStatus}";
if ($checklistType === 'school_calendar' && $calendarDays !== null) {
    $inRange  = ($calendarDays >= 200 && $calendarDays <= 220);
    $rangeMsg = $inRange ? 'within 200–220 range' : 'OUT OF 200–220 range';
    $remarks .= " | Calendar Days Found: {$calendarDays} ({$rangeMsg})";
}

try {
    $pdo = getDB();   // your existing helper — adjust if named differently
    auditEnsureTable($pdo);

    $auditChecklist = static function ($status, $description) use ($pdo, $authUser): void {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)($authUser['id'] ?? 0),
            'role' => (string)($authUser['role'] ?? 'viewer'),
            'action' => 'checklist_save',
            'module' => 'checklist',
            'status' => (string)$status,
            'description' => (string)$description,
        ]);
    };

    $pdo->beginTransaction();

    // ── 1. Insert into school_submissions ─────────────────────────────────────
    $stmtSub = $pdo->prepare("
        INSERT INTO school_submissions
            (user_id, school_id, district_id, type, title, file_name, file_path,
             file_size, status, remarks, reviewed_by, reviewed_at, submitted_at)
        VALUES
            (:user_id, :school_id, :district_id, :type, :title, :file_name, :file_path,
             NULL, :status, :remarks, :reviewed_by, NOW(), NOW())
    ");

    // Map overall status to school_submissions.status enum
    $submissionStatus = match ($overallStatus) {
        'COMPLIANT'     => 'approved',
        'NON-COMPLIANT' => 'rejected',
        default         => 'review',
    };

    $stmtSub->execute([
        ':user_id'     => $userId,
        ':school_id'   => $schoolId,
        ':district_id' => $districtId,
        ':type'        => $submissionType,
        ':title'       => $title,
        ':file_name'   => $fileName ?: 'manual_entry',
        ':file_path'   => '',   // no physical file stored via this route
        ':status'      => $submissionStatus,
        ':remarks'     => $remarks,
        ':reviewed_by' => $userId,
    ]);

    $submissionId = (int)$pdo->lastInsertId();

    // ── 2. Insert into checklist_results ─────────────────────────────────────
    $stmtRes = $pdo->prepare("
        INSERT INTO checklist_results
            (submission_id, checklist_type, compliance_score, overall_status,
             ai_summary, school_name, sy_applied, location,
             calendar_days_found, items_json, fields_json, created_by)
        VALUES
            (:submission_id, :checklist_type, :compliance_score, :overall_status,
             :ai_summary, :school_name, :sy_applied, :location,
             :calendar_days_found, :items_json, :fields_json, :created_by)
    ");

    $stmtRes->execute([
        ':submission_id'      => $submissionId,
        ':checklist_type'     => $checklistType,
        ':compliance_score'   => $complianceScore,
        ':overall_status'     => $overallStatus,
        ':ai_summary'         => $aiSummary,
        ':school_name'        => $schoolName,
        ':sy_applied'         => $syApplied,
        ':location'           => $location,
        ':calendar_days_found'=> $calendarDays,
        ':items_json'         => $itemsJson,
        ':fields_json'        => $fieldsJson,
        ':created_by'         => $userId,
    ]);

    $reportId = (int)$pdo->lastInsertId();

    $pdo->commit();

    $auditChecklist(
        'success',
        'Checklist report saved | checklist_type=' . $checklistType . ' | submission_id=' . $submissionId . ' | report_id=' . $reportId . ' | overall_status=' . $overallStatus
    );

    echo json_encode([
        'success'       => true,
        'report_id'     => $reportId,
        'submission_id' => $submissionId,
        'message'       => 'Report saved successfully.',
    ]);

} catch (PDOException $e) {
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if (isset($pdo) && $pdo instanceof PDO) {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)($authUser['id'] ?? 0),
            'role' => (string)($authUser['role'] ?? 'viewer'),
            'action' => 'checklist_save',
            'module' => 'checklist',
            'status' => 'failed',
            'description' => 'Checklist save failed (DB error) | checklist_type=' . $checklistType . ' | error=' . substr($e->getMessage(), 0, 180),
        ]);
    }
    // Log full error server-side but never expose it to the client
    error_log('[checklist-save.php] DB error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error. Please try again.']);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if (isset($pdo) && $pdo instanceof PDO) {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)($authUser['id'] ?? 0),
            'role' => (string)($authUser['role'] ?? 'viewer'),
            'action' => 'checklist_save',
            'module' => 'checklist',
            'status' => 'failed',
            'description' => 'Checklist save failed (runtime error) | checklist_type=' . $checklistType . ' | error=' . substr($e->getMessage(), 0, 180),
        ]);
    }
    // TEMP DEBUG — remove before production
    error_log('[checklist-save.php] Error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]); // remove after debug
}