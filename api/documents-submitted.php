<?php
/**
 * documents-submitted.php
 * Admin API for school-submitted documents (calendar, tuition, and other types) in checklist page.
 */

declare(strict_types=1);

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';


setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    respond(false, 'Unauthorized', null, 401);
}

requirePermission('school_submissions', $authUser);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';
$pdo = getDB();

$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw) {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $body = $decoded;
        }
    }
    if (!$body && !empty($_POST)) {
        $body = $_POST;
    }
    if (!$action && isset($body['action'])) {
        $action = (string)$body['action'];
    }
}

switch ($method) {
    case 'GET':
        if ($action === 'preview') {
            actionPreview($pdo);
        } elseif ($action === 'download') {
            actionDownload($pdo);
        } elseif ($action === 'list_supporting_uploads') {
            actionListSupportingUploads($pdo);
        } elseif ($action === 'download_supporting_upload') {
            actionDownloadSupportingUpload($pdo);
        } elseif ($action === 'supporting_docs_catalog') {
            actionSupportingDocsCatalog($pdo);
        } else {
            actionList($pdo);
        }
        break;

    case 'POST':
        if ($action === 'update') {
            actionUpdate($pdo, $body, $authUser);
        } elseif ($action === 'approve_edit') {
            actionApproveEdit($pdo, $body, $authUser);
        } else {
            respond(false, 'Unknown action');
        }
        break;

    default:
        respond(false, 'Method not allowed', null, 405);
}
// ────────────────────────────────────────────────────────────
// actionList
// ────────────────────────────────────────────────────────────
function actionList(PDO $pdo): void
{
    $search = trim((string)($_GET['search'] ?? ''));
    $status = trim((string)($_GET['status'] ?? ''));
    $scope  = strtolower(trim((string)($_GET['scope'] ?? 'calendar')));
    $type   = strtolower(trim((string)($_GET['type']  ?? 'all')));
 
    $allowedTypes  = ['all', 'calendar', 'tuition', 'no_tuition', 'permit'];
    $allowedScopes = ['all', 'calendar'];
 
    if (!in_array($type,  $allowedTypes,  true)) { respond(false, 'Invalid type parameter',  null, 422); }
    if (!in_array($scope, $allowedScopes, true)) { respond(false, 'Invalid scope parameter', null, 422); }
 
    $isAllScope = ($scope === 'all');
 
    $sql = "
        SELECT
            ss.id,
            ss.user_id,
            ss.school_id,
            ss.private_school_id,
            ss.district_id,
            ss.calendar_document_id,
            ss.type,
            ss.document_type,
            ss.title,
            ss.file_name,
            ss.file_path,
            ss.file_size,
            ss.status,
            ss.remarks,
            ss.reviewed_by,
            ss.reviewed_at,
            ss.submitted_at,
            ss.updated_at,
            ss.submitted_by,
            ss.date_submitted,
            ss.date_actioned,
            ss.history_json,
            ss.school_year,
            COALESCE(NULLIF(pvs.name, ''), NULLIF(ps.school_name, ''), ss.title) AS school_name,
            COALESCE(
                CONCAT_WS(', ', NULLIF(pvs.street_address,''), NULLIF(pvs.barangay,''), NULLIF(pvs.city,'')),
                ''
            ) AS school_address,
            COALESCE(u.full_name, ss.submitted_by) AS created_by_name,
            scd.payload_json AS cal_payload_json
        FROM school_submissions ss
        LEFT JOIN users u ON u.id = ss.user_id
        LEFT JOIN public_schools ps ON ps.id = ss.school_id
        LEFT JOIN private_schools pvs
            ON pvs.id = ss.private_school_id
        LEFT JOIN school_calendar_documents scd ON scd.id = ss.calendar_document_id
        WHERE 1=1
    ";
 
    $where  = [];
    $params = [];
 
    if ($isAllScope) {
        if ($type !== '' && $type !== 'all') {
            $where[]       = 'LOWER(ss.type) = :type';
            $params[':type'] = $type;
        }
    } else {
        $where[] = "ss.type = 'calendar'";
        $where[] = "(ss.document_type = 'School Calendar' OR ss.document_type IS NULL OR ss.document_type = '')";
    }
 
    if ($status !== '' && strtolower($status) !== 'all') {
        $where[]         = 'ss.status = :status';
        $params[':status'] = $status;
    }
 
    if ($search !== '') {
        $search = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
        $like   = '%' . $search . '%';
        $where[] = "(
            COALESCE(NULLIF(pvs.name, ''), NULLIF(ps.school_name, ''), ss.title) LIKE :s1
            OR ss.submitted_by LIKE :s2
            OR ss.status LIKE :s3
            OR ss.remarks LIKE :s4
            OR ss.type LIKE :s5
            OR ss.document_type LIKE :s6
            OR u.full_name LIKE :s7
        )";
        $params[':s1'] = $like;
        $params[':s2'] = $like;
        $params[':s3'] = $like;
        $params[':s4'] = $like;
        $params[':s5'] = $like;
        $params[':s6'] = $like;
        $params[':s7'] = $like;
    }
 
    if ($where) {
        $sql .= ' AND ' . implode(' AND ', $where);
    }
 
    $sql .= " ORDER BY COALESCE(ss.date_submitted, DATE(ss.submitted_at)) DESC, ss.id DESC";
 
    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (\PDOException $e) {
        error_log('[documents-submitted] actionList join failed: ' . $e->getMessage() . ' — retrying without calendar join');
        $sqlFallback = str_replace(
            [
                "\n            COALESCE(\n                CONCAT_WS(', ', NULLIF(pvs.street_address,''), NULLIF(pvs.barangay,''), NULLIF(pvs.city,'')),\n                ''\n            ) AS school_address,",
                "\n            scd.payload_json AS cal_payload_json",
                "\n        LEFT JOIN school_calendar_documents scd ON scd.id = ss.calendar_document_id",
            ],
            ['', '', ''],
            $sql
        );
        try {
            $stmt2 = $pdo->prepare($sqlFallback);
            $stmt2->execute($params);
            $records = $stmt2->fetchAll(PDO::FETCH_ASSOC);
            foreach ($records as &$rec) { $rec['cal_payload_json'] = null; }
            unset($rec);
        } catch (\PDOException $e2) {
            respond(false, 'Database error: ' . $e2->getMessage(), null, 500);
        }
    }
 
    foreach ($records as &$r) {
        $r['school_name']     = $r['school_name']     ?? ($r['title']        ?? '');
        $r['created_by_name'] = $r['created_by_name'] ?? ($r['submitted_by'] ?? '');
 
        $typeRaw   = strtolower(trim((string)($r['type']          ?? '')));
        $docTypeRaw = trim((string)($r['document_type'] ?? ''));
        if ($docTypeRaw !== '') {
            $r['document_type_label'] = $docTypeRaw;
        } elseif ($typeRaw === 'calendar') {
            $r['document_type_label'] = 'School Calendar';
        } elseif ($typeRaw === 'tuition') {
            $r['document_type_label'] = 'Tuition Fee Document';
        } elseif ($typeRaw === 'no_tuition') {
            $r['document_type_label'] = 'No Tuition Fee Increase';
        } elseif ($typeRaw !== '') {
            $r['document_type_label'] = ucwords(str_replace('_', ' ', $typeRaw));
        } else {
            $r['document_type_label'] = 'Document';
        }
 
        $normalized = strtolower(trim((string)($r['status'] ?? '')));
        $map = [
            'pending'                => 'Pending Review',
            'pending review'         => 'Pending Review',
            'review'                 => 'For Endorsement',
            'endorsed'               => 'For Endorsement',
            'approved'               => 'Approved',
            'rejected'               => 'Returned for Correction',
            'returned for correction'=> 'Returned for Correction',
            'released to school'     => 'Released to School',
            'for endorsement'        => 'For Endorsement',
        ];
        if (isset($map[$normalized])) { $r['status'] = $map[$normalized]; }
 
        if (empty($r['date_submitted']) && !empty($r['submitted_at'])) {
            $r['date_submitted'] = substr((string)$r['submitted_at'], 0, 10);
        }
 
        $r['history']      = json_decode((string)($r['history_json'] ?? '[]'), true) ?: [];
        $r['cal_opening']  = null;
        $r['cal_closing']  = null;
        $r['cal_days']     = null;
        $r['cal_level']    = null;
        $r['school_address'] = null;
 
        if (!empty($r['cal_payload_json'])) {
            $calPayload = json_decode((string)$r['cal_payload_json'], true);
            if (is_array($calPayload)) {
                $form = is_array($calPayload['form'] ?? null) ? $calPayload['form'] : [];
                $r['cal_opening']   = isset($form['f_opening'])     && $form['f_opening']     !== '' ? (string)$form['f_opening']     : null;
                $r['cal_closing']   = isset($form['f_closing'])     && $form['f_closing']     !== '' ? (string)$form['f_closing']     : null;
                $r['cal_level']     = isset($form['f_dept'])        && $form['f_dept']        !== '' ? (string)$form['f_dept']        : null;
                $r['school_address']= isset($form['f_chk_address']) && $form['f_chk_address'] !== '' ? (string)$form['f_chk_address'] : null;
                $daysByMonth = dsComputeSchoolDaysByMonth($calPayload);
                $totalDays   = array_sum(array_map(static fn(array $m): int => (int)($m['days'] ?? 0), $daysByMonth));
                $r['cal_days'] = $totalDays > 0 ? (string)$totalDays : null;
            }
        }
        unset($r['cal_payload_json'], $r['history_json']);
    }
    unset($r);
 
    respond(true, 'OK', ['records' => $records]);
}

function actionPreview(PDO $pdo): void
{
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) {
        respond(false, 'Record ID required');
    }

    // Determine submission type first so we know which document table to join.
    $typeStmt = $pdo->prepare("SELECT type FROM school_submissions WHERE id = :id LIMIT 1");
    $typeStmt->execute([':id' => $id]);
    $typeRow = $typeStmt->fetch(PDO::FETCH_ASSOC);
    if (!$typeRow) {
        respond(false, 'Record not found', null, 404);
    }
    $subType = strtolower(trim((string)($typeRow['type'] ?? '')));

    if (in_array($subType, ['tuition', 'no_tuition'], true)) {
        actionPreviewTuition($pdo, $id);
        return;
    }

    $stmt = $pdo->prepare(
        "SELECT
            ss.calendar_document_id,
            ss.title,
            ss.school_year,
            ss.date_submitted,
            ss.submitted_by,
            scd.payload_json
         FROM school_submissions ss
         LEFT JOIN school_calendar_documents scd ON scd.id = ss.calendar_document_id
         WHERE ss.id = :id AND ss.type = 'calendar'
         LIMIT 1"
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        respond(false, 'Record not found', null, 404);
    }

    $summary = ['has_payload' => false, 'fields' => []];

    if (!empty($row['payload_json'])) {
        $payload = json_decode((string)$row['payload_json'], true);
        if (is_array($payload)) {
            $summary['has_payload'] = true;
            $form = is_array($payload['form'] ?? null) ? $payload['form'] : [];

            $summary['fields'] = [
                'school' => $form['f_school'] ?? '',
                'dept' => $form['f_dept'] ?? '',
                'sid' => $form['f_sid'] ?? '',
                'sy_from' => $form['f_sy1'] ?? '',
                'sy_to' => $form['f_sy2'] ?? '',
                'opening' => $form['f_opening'] ?? '',
                'closing' => $form['f_closing'] ?? '',
                'principal' => $form['f_principal'] ?? '',
            ];

            $savedMarks = is_array($payload['savedMarks'] ?? null) ? $payload['savedMarks'] : [];
            $markCounts = ['holiday' => 0, 'activity' => 0, 'exam' => 0, 'other' => 0];
            foreach ($savedMarks as $dateKey => $markType) {
                $markType = (string)$markType;
                if (isset($markCounts[$markType])) {
                    $markCounts[$markType]++;
                } else {
                    $markCounts['other']++;
                }
            }

            $summary['mark_counts'] = $markCounts;
            $summary['total_marked_days'] = count($savedMarks);
            $summary['total_school_days'] = array_sum(array_map(
                static fn(array $m): int => (int)($m['days'] ?? 0),
                dsComputeSchoolDaysByMonth($payload)
            ));
        }
    }

    respond(true, 'OK', ['summary' => $summary]);
}

// ────────────────────────────────────────────────────────────
// actionPreviewTuition
// Mirrors actionPreview's calendar logic, but for tuition fee
// submissions. school_submissions has no tuition_document_id
// column, so the linked school_tuition_documents row is resolved
// by submission_id (same lookup pattern as actionApproveEdit),
// with a fallback to calendar_document_id for legacy rows where
// that column was reused to store the tuition doc id.
// ────────────────────────────────────────────────────────────
function actionPreviewTuition(PDO $pdo, int $id): void
{
    $subStmt = $pdo->prepare(
        "SELECT ss.id, ss.title, ss.school_year, ss.date_submitted, ss.submitted_by,
                ss.user_id, ss.school_id, ss.private_school_id, ss.calendar_document_id
         FROM school_submissions ss
         WHERE ss.id = :id AND ss.type IN ('tuition', 'no_tuition')
         LIMIT 1"
    );
    $subStmt->execute([':id' => $id]);
    $sub = $subStmt->fetch(PDO::FETCH_ASSOC);

    if (!$sub) {
        respond(false, 'Record not found', null, 404);
    }

    $tuitionDoc = dsFindTuitionDocument($pdo, $sub);

    $summary = ['has_payload' => false, 'fields' => [], 'levels' => []];

    if ($tuitionDoc) {
        $payload = [];
        if (!empty($tuitionDoc['payload_json'])) {
            $decoded = json_decode((string)$tuitionDoc['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $form = is_array($payload['form'] ?? null) ? $payload['form'] : [];
        $summary['has_payload'] = true;
        $summary['fields'] = [
            'school_name'       => $form['school_name']       ?? ($sub['title'] ?? ''),
            'division'          => $form['division']          ?? '',
            'address'           => $form['address']           ?? '',
            'school_id'         => $form['school_id']         ?? '',
            'gov_recog'         => $form['gov_recog']         ?? '',
            'current_sy'        => $form['current_sy']        ?? $tuitionDoc['current_sy']  ?? '',
            'proposed_sy'       => $form['proposed_sy']       ?? $tuitionDoc['proposed_sy'] ?? ($sub['school_year'] ?? ''),
            'increase_pct'      => $form['increase_pct']      ?? $tuitionDoc['increase_pct'] ?? 0,
            'principal'         => $form['principal']         ?? '',
            'principal_contact' => $form['principal_contact'] ?? '',
            'reviewed_by'       => $form['reviewed_by']       ?? '',
        ];
        $summary['mode'] = $tuitionDoc['mode'] ?? 'increase';

        $levelFlags = [
            'kinder' => (bool)($tuitionDoc['has_kinder'] ?? false),
            'elem'   => (bool)($tuitionDoc['has_elem']   ?? false),
            'jhs'    => (bool)($tuitionDoc['has_jhs']    ?? false),
            'shs'    => (bool)($tuitionDoc['has_shs']    ?? false),
        ];

        foreach ($levelFlags as $levelKey => $enabled) {
            if (!$enabled) {
                continue;
            }
            $summary['levels'][$levelKey] = dsBuildTuitionLevelSummary($levelKey, $payload, $summary['mode'], (float)($summary['fields']['increase_pct'] ?? 0), $tuitionDoc);
        }
    }

    respond(true, 'OK', ['summary' => $summary]);
}

// ────────────────────────────────────────────────────────────
// actionDownload
// ────────────────────────────────────────────────────────────
function actionDownload(PDO $pdo): void
{
    $id      = (int)($_GET['id']     ?? 0);
    $format  = strtolower(trim((string)($_GET['format']  ?? 'pdf')));
    $preview = isset($_GET['preview']) && (string)$_GET['preview'] === '1';
 
    if (!$id) { respond(false, 'Record ID required', null, 422); }
    if (!in_array($format, ['pdf', 'word', 'json'], true)) { respond(false, 'Invalid format', null, 422); }

    // Determine submission type first so we know which document table/builder to use.
    $typeStmt = $pdo->prepare("SELECT type FROM school_submissions WHERE id = :id LIMIT 1");
    $typeStmt->execute([':id' => $id]);
    $typeRow = $typeStmt->fetch(PDO::FETCH_ASSOC);
    if (!$typeRow) { respond(false, 'Record not found', null, 404); }
    $subType = strtolower(trim((string)($typeRow['type'] ?? '')));

    if (in_array($subType, ['tuition', 'no_tuition'], true)) {
        actionDownloadTuition($pdo, $id, $format, $preview);
        return;
    }
 
    $stmt = $pdo->prepare(
        "SELECT
            ss.id,
            ss.calendar_document_id,
            ss.title,
            ss.status,
            ss.remarks,
            ss.submitted_by,
            ss.date_submitted,
            ss.school_year,
            COALESCE(ps.name, pvs.name, ss.title) AS school_name,
            COALESCE(NULLIF(u.school_logo, ''), '') AS school_logo,
            scd.payload_json
         FROM school_submissions ss
         LEFT JOIN users u ON u.id = ss.user_id
         LEFT JOIN public_schools ps
             ON ps.id = ss.school_id
             AND LOWER(COALESCE(u.school_type, '')) NOT LIKE '%private%'
         LEFT JOIN private_schools pvs
             ON pvs.id = ss.school_id
             AND LOWER(COALESCE(u.school_type, '')) LIKE '%private%'
         LEFT JOIN school_calendar_documents scd ON scd.id = ss.calendar_document_id
         WHERE ss.id = :id AND ss.type = 'calendar'
         LIMIT 1"
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
 
    if (!$row) { respond(false, 'Record not found', null, 404); }
 
    if (empty($row['calendar_document_id']) && in_array($format, ['pdf', 'word'], true)) {
        respond(false, 'No calendar document is linked to this submission. Cannot export.', null, 422);
    }
 
    $payload = [];
    if (!empty($row['payload_json'])) {
        $decoded = json_decode((string)$row['payload_json'], true);
        if (is_array($decoded)) { $payload = $decoded; }
    }
 
    $base = dsSanitizeFilename((string)($row['school_name'] ?: $row['title'] ?: 'school-calendar'));
 
    // ── json download (backup/export) ────────────────────────────────────
    if ($format === 'json') {
        // Also inject logo so exported JSON files are self-contained
        $logoRaw = dsNormalizeSchoolLogo((string)($row['school_logo'] ?? ''));
        if ($logoRaw !== '') {
            $payload['logoDataUrl'] = $logoRaw;
        }
     
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: ' . ($preview ? 'inline' : 'attachment') . '; filename="' . $base . '-calendar.json"');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        exit;
    }
 
    if ($format === 'pdf' && $preview) {
        // school_logo lives in users.school_logo, not in payload_json.
        // The portal saves logoDataUrl as '' to keep the payload small.
        // Inject it back here so the JS preview can render the logo.
        $logoRaw = dsNormalizeSchoolLogo((string)($row['school_logo'] ?? ''));
        if ($logoRaw !== '') {
            $payload['logoDataUrl'] = $logoRaw;
        }
     
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
 
    if ($format === 'word') {
        $autoload = dirname(__DIR__) . '/vendor/autoload.php';
        if (!file_exists($autoload)) {
            http_response_code(500);
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'message' => 'PhpWord not installed. Run: composer require phpoffice/phpword']);
            exit;
        }
        require_once $autoload;
 
        if (!class_exists('PhpOffice\\PhpWord\\PhpWord')) {
            http_response_code(500);
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'message' => 'PhpWord library not installed.']);
            exit;
        }
 
        try {
            $tmpWordAssets = [];
            $phpWord  = buildCalendarPhpWord($row, $payload, $tmpWordAssets);
            $tmpDocx  = tempnam(sys_get_temp_dir(), 'qatalyst_') . '.docx';
            $writer   = \PhpOffice\PhpWord\IOFactory::createWriter($phpWord, 'Word2007');
            $writer->save($tmpDocx);
 
            foreach ($tmpWordAssets as $p) {
                if (is_string($p) && $p !== '' && file_exists($p)) { @unlink($p); }
            }
 
            if (!file_exists($tmpDocx) || filesize($tmpDocx) === 0) {
                http_response_code(500);
                header('Content-Type: application/json');
                echo json_encode(['success' => false, 'message' => 'Generated DOCX file is empty or missing.']);
                exit;
            }
 
            header('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            header('Content-Disposition: attachment; filename="' . $base . '-calendar.docx"');
            header('Content-Length: ' . (string)filesize($tmpDocx));
            readfile($tmpDocx);
            @unlink($tmpDocx);
        } catch (\Throwable $e) {
            http_response_code(500);
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'message' => 'Word export failed: ' . $e->getMessage()]);
        }
        exit;
    }
 
    // PDF via TCPDF
    $tcpdfPath = dirname(__DIR__) . '/TCPDF/tcpdf.php';
    if (!file_exists($tcpdfPath)) {
        respond(false, 'PDF engine not available on server', null, 500);
    }
    require_once $tcpdfPath;
 
    $tmpLogoForPdf = null;
    $row['school_logo'] = dsPrepareSchoolLogoForTcpdf((string)($row['school_logo'] ?? ''), $tmpLogoForPdf);
    $html = buildCalendarDocHtml($row, $payload);
 
    $pdf = new TCPDF('P', 'mm', 'LEGAL', true, 'UTF-8', false);
    $pdf->SetCreator('QATALYST');
    $pdf->SetAuthor('QATALYST');
    $pdf->SetTitle('School Calendar Submission');
    $pdf->setPrintHeader(false);
    $pdf->setPrintFooter(false);
    $pdf->SetMargins(13, 13, 13);
    $pdf->setCellHeightRatio(1.25);
    $pdf->AddPage();
    $pdf->writeHTML($html, true, false, true, false, '');
    $pdf->Output($base . '-calendar.pdf', $preview ? 'I' : 'D');
 
    if ($tmpLogoForPdf !== null && file_exists($tmpLogoForPdf)) { @unlink($tmpLogoForPdf); }
    exit;
}

// ────────────────────────────────────────────────────────────
// actionDownloadTuition
// Mirrors actionDownload's calendar logic, but for tuition fee
// submissions, using school_tuition_documents instead of
// school_calendar_documents.
// ────────────────────────────────────────────────────────────
function actionDownloadTuition(PDO $pdo, int $id, string $format, bool $preview): void
{
    $subStmt = $pdo->prepare(
        "SELECT
            ss.id,
            ss.calendar_document_id,
            ss.user_id,
            ss.school_id,
            ss.private_school_id,
            ss.title,
            ss.status,
            ss.remarks,
            ss.submitted_by,
            ss.date_submitted,
            ss.school_year,
            COALESCE(ps.name, pvs.name, ss.title) AS school_name,
            COALESCE(NULLIF(u.school_logo, ''), '') AS school_logo
         FROM school_submissions ss
         LEFT JOIN users u ON u.id = ss.user_id
         LEFT JOIN public_schools ps
             ON ps.id = ss.school_id
             AND LOWER(COALESCE(u.school_type, '')) NOT LIKE '%private%'
         LEFT JOIN private_schools pvs
             ON pvs.id = ss.school_id
             AND LOWER(COALESCE(u.school_type, '')) LIKE '%private%'
         WHERE ss.id = :id AND ss.type IN ('tuition', 'no_tuition')
         LIMIT 1"
    );
    $subStmt->execute([':id' => $id]);
    $sub = $subStmt->fetch(PDO::FETCH_ASSOC);

    if (!$sub) { respond(false, 'Record not found', null, 404); }

    $tuitionDoc = dsFindTuitionDocument($pdo, $sub);

    if (!$tuitionDoc && in_array($format, ['pdf', 'word'], true)) {
        respond(false, 'No tuition fee document is linked to this submission. Cannot export.', null, 422);
    }

    $payload = [];
    if ($tuitionDoc && !empty($tuitionDoc['payload_json'])) {
        $decoded = json_decode((string)$tuitionDoc['payload_json'], true);
        if (is_array($decoded)) { $payload = $decoded; }
    }

    $base = dsSanitizeFilename((string)($sub['school_name'] ?: $sub['title'] ?: 'tuition-fee'));

    // ── json (used by the admin preview panel, and as a backup/export) ────
    if ($format === 'json') {
        if (!$tuitionDoc) {
            respond(false, 'Tuition fee document not found for this submission.', null, 404);
        }

        $logoRaw = dsNormalizeSchoolLogo((string)($sub['school_logo'] ?? ''));
        if ($logoRaw !== '') {
            $payload['logoDataUrl'] = $logoRaw;
        }
        $payload['mode']       = $tuitionDoc['mode']        ?? 'increase';
        $payload['has_kinder'] = (bool)($tuitionDoc['has_kinder'] ?? false);
        $payload['has_elem']   = (bool)($tuitionDoc['has_elem']   ?? false);
        $payload['has_jhs']    = (bool)($tuitionDoc['has_jhs']    ?? false);
        $payload['has_shs']    = (bool)($tuitionDoc['has_shs']    ?? false);

        $form = is_array($payload['form'] ?? null) ? $payload['form'] : [];
        $increasePct = (float)($form['increase_pct'] ?? $tuitionDoc['increase_pct'] ?? 0);
        $levels = [];
        foreach (['kinder' => 'has_kinder', 'elem' => 'has_elem', 'jhs' => 'has_jhs', 'shs' => 'has_shs'] as $levelKey => $flagKey) {
            if (!empty($payload[$flagKey])) {
                $levels[$levelKey] = dsBuildTuitionLevelSummary($levelKey, $payload, (string)$payload['mode'], $increasePct, $tuitionDoc);
            }
        }
        $payload['computed_levels'] = $levels;

        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('Content-Disposition: ' . ($preview ? 'inline' : 'attachment') . '; filename="' . $base . '-tuition.json"');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | ($preview ? 0 : JSON_PRETTY_PRINT));
        exit;
    }

    if ($format === 'word') {
        respond(false, 'Word export for tuition fee documents is not available yet. Please use PDF.', null, 422);
    }

    // PDF via TCPDF
    $tcpdfPath = dirname(__DIR__) . '/TCPDF/tcpdf.php';
    if (!file_exists($tcpdfPath)) {
        respond(false, 'PDF engine not available on server', null, 500);
    }
    require_once $tcpdfPath;

    $tmpLogoForPdf = null;
    $sub['school_logo'] = dsPrepareSchoolLogoForTcpdf((string)($sub['school_logo'] ?? ''), $tmpLogoForPdf);
    $html = buildTuitionDocHtml($sub, $tuitionDoc ?? [], $payload);

    $pdf = new TCPDF('P', 'mm', 'LEGAL', true, 'UTF-8', false);
    $pdf->SetCreator('QATALYST');
    $pdf->SetAuthor('QATALYST');
    $pdf->SetTitle('Tuition Fee Submission');
    $pdf->setPrintHeader(false);
    $pdf->setPrintFooter(false);
    $pdf->SetMargins(13, 13, 13);
    $pdf->setCellHeightRatio(1.25);
    $pdf->AddPage();
    $pdf->writeHTML($html, true, false, true, false, '');
    $pdf->Output($base . '-tuition.pdf', $preview ? 'I' : 'D');

    if ($tmpLogoForPdf !== null && file_exists($tmpLogoForPdf)) { @unlink($tmpLogoForPdf); }
    exit;
}

function respond(bool $success, string $message, ?array $data = null, int $code = 200): never
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    $out = ['success' => $success, 'message' => $message];
    if ($data !== null) {
        $out = array_merge($out, $data);
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function dsNormalizeSchoolLogo(string $raw): string
{
    $raw = trim($raw);
    if ($raw === '') {
        return '';
    }

    // Stored values sometimes come prefixed like:
    //   school_logo:data:image/webp;base64,...
    // Strip the field prefix if present.
    $raw = preg_replace('/^\s*school_logo\s*[:=]\s*/i', '', $raw);
    $raw = trim((string)$raw);

    // TCPDF and Word exports are more reliable with PNG/JPG than WEBP.
    // If the logo is stored as WEBP data URL, convert it to PNG data URL.
    if (preg_match('#^data:image/webp;base64,#i', $raw) === 1) {
        $parts = explode(',', $raw, 2);
        $webpBytes = isset($parts[1]) ? base64_decode($parts[1], true) : false;
        if (is_string($webpBytes) && $webpBytes !== '') {
            $pngBytes = null;
            $tmpWebp = null;
            $img = false;

            // Try decoding WEBP bytes.
            if (function_exists('imagecreatefromstring')) {
                $img = @imagecreatefromstring($webpBytes);
            }
            if ($img === false && function_exists('imagecreatefromwebp')) {
                $tmpWebp = tempnam(sys_get_temp_dir(), 'qatalyst_webp_') . '.webp';
                @file_put_contents($tmpWebp, $webpBytes);
                $img = @imagecreatefromwebp($tmpWebp);
            }

            if ($img !== false) {
                // Preserve transparency when present.
                if (function_exists('imagealphablending')) {
                    @imagealphablending($img, true);
                }
                if (function_exists('imagesavealpha')) {
                    @imagesavealpha($img, true);
                }

                ob_start();
                @imagepng($img);
                $pngBytes = ob_get_clean();
                @imagedestroy($img);

                if (is_string($pngBytes) && $pngBytes !== '') {
                    if ($tmpWebp !== null && file_exists($tmpWebp)) {
                        @unlink($tmpWebp);
                    }
                    return 'data:image/png;base64,' . base64_encode($pngBytes);
                }
            }

            // Fallback: Imagick (if available) can convert WEBP even when GD can't.
            if (class_exists('Imagick')) {
                try {
                    $im = new \Imagick();
                    $im->readImageBlob($webpBytes);
                    $im->setImageFormat('png');
                    $pngBytes = $im->getImageBlob();
                    $im->clear();
                    $im->destroy();

                    if (is_string($pngBytes) && $pngBytes !== '') {
                        if ($tmpWebp !== null && file_exists($tmpWebp)) {
                            @unlink($tmpWebp);
                        }
                        return 'data:image/png;base64,' . base64_encode($pngBytes);
                    }
                } catch (\Throwable $t) {
                    // Ignore and fall through.
                }
            }

            if ($tmpWebp !== null && file_exists($tmpWebp)) {
                @unlink($tmpWebp);
            }
        }
    }

    return $raw;
}

function dsNormalizePreviewLogoUrl(string $raw): string
{
    $raw = trim($raw);
    if ($raw === '') {
        return '';
    }
    if (preg_match('#^(data:|https?://|/)#i', $raw) === 1) {
        return $raw;
    }
    return '../' . ltrim($raw, '/');
}

function dsPrepareSchoolLogoForTcpdf(string $raw, ?string &$tmpFileOut = null): string
{
    $tmpFileOut = null;
    $raw = dsNormalizeSchoolLogo($raw);
    if ($raw === '') {
        return '';
    }

    // TCPDF HTML renderer is inconsistent with data: URIs; local files are reliable.
    if (preg_match('#^data:image/(png|jpe?g);base64,#i', $raw, $m) === 1) {
        $ext = strtolower((string)$m[1]);
        if ($ext === 'jpeg') $ext = 'jpg';
        $parts = explode(',', $raw, 2);
        $bytes = isset($parts[1]) ? base64_decode($parts[1], true) : false;
        if (is_string($bytes) && $bytes !== '') {
            $baseTmp = tempnam(sys_get_temp_dir(), 'qatalyst_logo_pdf_');
            if ($baseTmp !== false) {
                $tmp = $baseTmp . '.' . $ext;
                @file_put_contents($tmp, $bytes);
                if (file_exists($tmp) && is_readable($tmp)) {
                    $tmpFileOut = $tmp;
                    return str_replace('\\', '/', $tmp);
                }
            }
        }
        return '';
    }

    // Local web path (/uploads/x.png) or relative path -> resolve to filesystem.
    if (!preg_match('#^https?://#i', $raw)) {
        $candidate = ltrim($raw, '/');
        $abs = realpath(dirname(__DIR__) . DIRECTORY_SEPARATOR . $candidate);
        if (is_string($abs) && $abs !== '' && file_exists($abs) && is_readable($abs)) {
            return str_replace('\\', '/', $abs);
        }
    }

    // Remote URL -> download to temp file.
    if (preg_match('#^https?://#i', $raw) === 1) {
        $urlPath = parse_url($raw, PHP_URL_PATH) ?? '';
        $ext = strtolower(pathinfo((string)$urlPath, PATHINFO_EXTENSION));
        if (!in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'bmp'], true)) $ext = 'png';
        if ($ext === 'jpeg') $ext = 'jpg';

        $bytes = @file_get_contents($raw);
        if (is_string($bytes) && $bytes !== '') {
            $baseTmp = tempnam(sys_get_temp_dir(), 'qatalyst_logo_pdf_');
            if ($baseTmp !== false) {
                $tmp = $baseTmp . '.' . $ext;
                @file_put_contents($tmp, $bytes);
                if (file_exists($tmp) && is_readable($tmp)) {
                    $tmpFileOut = $tmp;
                    return str_replace('\\', '/', $tmp);
                }
            }
        }
        return '';
    }

    return $raw;
}

function actionUpdate(PDO $pdo, array $body, array $authUser): void
{
    $id = (int)($body['id'] ?? 0);
    if (!$id) {
        respond(false, 'Record ID required');
    }

    $sel = $pdo->prepare("SELECT * FROM school_submissions WHERE id = ?");
    $sel->execute([$id]);
    $rec = $sel->fetch(PDO::FETCH_ASSOC);

    if (!$rec) {
        respond(false, 'Record not found', null, 404);
    }

    $newStatus = clean($body['status'] ?? $rec['status']);
    $newRemarks = clean($body['remarks'] ?? ($rec['remarks'] ?? ''));

    $validStatuses = [
        'Pending Review',
        'Approved',
        'Returned for Correction',
        'For Endorsement',
        'Released to School',
        'draft',
    ];
    if (!in_array($newStatus, $validStatuses, true)) {
        respond(false, 'Invalid status value', null, 422);
    }

    $now = date('Y-m-d H:i:s');

    $userName = trim((string)($authUser['full_name'] ?? $authUser['email'] ?? 'Admin'));
    $userId = (int)($authUser['id'] ?? 0);

    $history = json_decode((string)($rec['history_json'] ?? '[]'), true) ?: [];

    if ($newStatus !== (string)$rec['status'] || $newRemarks !== (string)($rec['remarks'] ?? '')) {
        $history[] = [
            'event'      => 'status_update',
            'status'     => $newStatus,
            'by'         => $userName,
            'created_at' => $now,
            'note'       => $newRemarks,
        ];
    }

    $actionedStatuses = ['Approved', 'Returned for Correction', 'For Endorsement', 'Released to School'];
    $statusChanged = $newStatus !== (string)$rec['status'];
    if (in_array($newStatus, $actionedStatuses, true) && $statusChanged) {
        $dateActioned = date('Y-m-d');
    } else {
        $dateActioned = (string)($rec['date_actioned'] ?? null);
    }

    $stmt = $pdo->prepare(
        "UPDATE school_submissions SET
            status = :status,
            remarks = :remarks,
            date_actioned = :date_actioned,
            history_json = :history_json,
            reviewed_by = :reviewed_by,
            reviewed_at = CASE WHEN :chk_status != :old_status THEN NOW() ELSE reviewed_at END,
            updated_at = NOW()
         WHERE id = :id"
    );

    $stmt->execute([
        ':status' => $newStatus,
        ':remarks' => $newRemarks,
        ':date_actioned' => $dateActioned,
        ':history_json' => json_encode($history, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ':reviewed_by' => $userId ?: (int)($rec['reviewed_by'] ?? 0),
        ':chk_status' => $newStatus,
        ':old_status' => (string)$rec['status'],
        ':id' => $id,
    ]);
    
    // ── Audit log ─────────────────────────────────────────────────────────
    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $authUser['role'] ?? 'admin',
        'action'        => 'update_submission_status',
        'module'        => 'documents_submitted',
        'status'        => 'success',
        'description'   => sprintf(
            'Submission ID %d ("%s") status changed from "%s" to "%s"%s',
            $id,
            (string)($rec['title'] ?? 'Untitled'),
            (string)$rec['status'],
            $newStatus,
            $newRemarks !== '' ? ' — Remarks: ' . $newRemarks : ''
        ),
        'document_type' => (string)($rec['document_type'] ?? $rec['type'] ?? ''),
        'file_name'     => (string)($rec['file_name'] ?? ''),
    ]);

    // ── Resolve school ID and type ─────────────────────────────────────────────
    // private_school_id takes priority; fall back to public school_id.
    $isPrivateSchool  = (int)($rec['private_school_id'] ?? 0) > 0;
    $targetSchoolId   = $isPrivateSchool
        ? (int)$rec['private_school_id']
        : (int)($rec['school_id'] ?? 0);

    // ── Sync school tracker on every meaningful status change ─────────────────
    // Maps the online submission workflow to the manual checklist steps so the
    // hardcopy tracker and the online submissions never show conflicting data:
    //
    //  Online status           → Tracker step(s) auto-checked
    //  ─────────────────────────────────────────────────────
    //  Pending Review          → "Received w/ Compliance" (calendar only — marks
    //                            that the school's online submission was received)
    //  For Endorsement         → "Endorsed to RO"
    //  Approved                → "Approved"
    //  Released to School      → "Released"
    //
    // Bug fixes vs the previous version:
    //  1. The INSERT now uses the correct column (private_school_id vs school_id)
    //     depending on school type, matching the lookup in school-portal-tracker.php.
    //  2. "Pending Review" now auto-checks "Received w/ Compliance" for calendar
    //     submissions so the step is never permanently blank for online submitters.
    //  3. The school type is derived from the submission record directly (via
    //     private_school_id presence) instead of a second users query, ensuring
    //     it stays in sync even when the user row is missing.
    if ($statusChanged && $targetSchoolId > 0) {
        try {
            $docType    = strtolower(trim((string)($rec['type'] ?? '')));
            $schoolType = $isPrivateSchool ? 'private' : 'public';
            // The DB column to write into depends on school type — this must match
            // the WHERE clause used by school-portal-tracker.php (schoolIdColumn).
            $schoolIdColumn = $isPrivateSchool ? 'private_school_id' : 'school_id';

            // Category + row definitions per document type
            $trackerMap = match($docType) {
                'calendar'   => ['category_key' => 'school_calendar',  'rows' => ['School Calendar']],
                'tuition'    => ['category_key' => 'tuition_increase',  'rows' => ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS']],
                'no_tuition' => ['category_key' => 'no_increase',       'rows' => ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS']],
                'permit'     => ['category_key' => 'renewal_permit',    'rows' => ['']],
                default      => null,
            };

            // Which tracker step(s) to check for this status transition.
            // 'Pending Review' only applies to the calendar's "Received" step.
            $trackerSteps = match($newStatus) {
                'Pending Review'     => ($docType === 'calendar') ? ['Received w/ Compliance'] : [],
                'For Endorsement'    => ['Endorsed to RO'],
                'Approved'           => ['Approved'],
                'Released to School' => ['Released'],
                default              => [],
            };

            if ($trackerMap !== null && count($trackerSteps) > 0) {
                // Resolve the tracker year — prefer exact school_year match,
                // fall back to the most recent active year.
                $subSchoolYear = trim((string)($rec['school_year'] ?? ''));

                $yrStmt = $pdo->prepare(
                    "SELECT id, school_year FROM school_tracker_years ORDER BY id DESC"
                );
                $yrStmt->execute();
                $allYears = $yrStmt->fetchAll(PDO::FETCH_ASSOC);

                $yearId = 0;
                foreach ($allYears as $yr) {
                    if (trim((string)$yr['school_year']) === $subSchoolYear) {
                        $yearId = (int)$yr['id'];
                        break;
                    }
                }
                // Fallback: first active year, then truly first year
                if (!$yearId) {
                    foreach ($allYears as $yr) {
                        if (!empty($yr['is_active'])) { $yearId = (int)$yr['id']; break; }
                    }
                }
                if (!$yearId && !empty($allYears)) {
                    $yearId = (int)$allYears[0]['id'];
                }

                if ($yearId > 0) {
                    // Prepared statement uses the correct column name for this school type.
                    // ON DUPLICATE KEY UPDATE: only overwrite is_checked if it is currently
                    // 0 (unchecked) — never revert a box that was manually checked earlier.
                    $trkSql = "
                        INSERT INTO school_tracker_checklist
                            ({$schoolIdColumn}, year_id, school_type, category_key, row_label, step_label,
                             is_checked, checked_by, checked_at)
                        VALUES
                            (:school_id, :year_id, :school_type, :cat_key, :row_label, :step_label,
                             1, :user_id, NOW())
                        ON DUPLICATE KEY UPDATE
                            is_checked = 1,
                            checked_by = IF(is_checked = 0, VALUES(checked_by), checked_by),
                            checked_at = IF(is_checked = 0, NOW(), checked_at)";

                    $trkStmt = $pdo->prepare($trkSql);

                    foreach ($trackerSteps as $trackerStep) {
                        foreach ($trackerMap['rows'] as $rowLabel) {
                            $trkStmt->execute([
                                ':school_id'   => $targetSchoolId,
                                ':year_id'     => $yearId,
                                ':school_type' => $schoolType,
                                ':cat_key'     => $trackerMap['category_key'],
                                ':row_label'   => $rowLabel,
                                ':step_label'  => $trackerStep,
                                ':user_id'     => $userId ?: 0,
                            ]);
                        }
                    }
                }
            }
        } catch (\Throwable $trkErr) {
            // Tracker sync failure must never fail the status update itself
            error_log('[documents-submitted] tracker sync error: ' . $trkErr->getMessage()
                . ' at ' . basename($trkErr->getFile()) . ':' . $trkErr->getLine());
        }
    }

    // ── Notify the school when status changes ──────────────────────────────────
    if ($statusChanged && $targetSchoolId > 0) {
        $uStmt = $pdo->prepare("SELECT school_type FROM users WHERE id = :uid LIMIT 1");
        $uStmt->execute([':uid' => (int)($rec['user_id'] ?? 0)]);
        $uRow = $uStmt->fetch(PDO::FETCH_ASSOC);
        $schoolType = (str_contains(strtolower((string)($uRow['school_type'] ?? '')), 'private'))
            ? 'private'
            : 'public';
    
        $typeLabel = match(strtolower(trim((string)($rec['type'] ?? '')))) {
            'calendar' => 'School Calendar',
            'tuition'  => 'Tuition Fee Document',
            'permit'   => 'School Permit',
            default    => 'Document Submission',
        };
    
        $notifTitle = match($newStatus) {
            'Approved'               => $typeLabel . ' Approved',
            'Returned for Correction'=> $typeLabel . ' Returned for Correction',
            'For Endorsement'        => $typeLabel . ' Endorsed',
            'Released to School'     => $typeLabel . ' Released',
            default                  => $typeLabel . ' Status Updated',
        };
    
        $notifMsg = match($newStatus) {
            'Approved'               => 'Your submitted ' . $typeLabel . ' has been approved.',
            'Returned for Correction'=> 'Your submitted ' . $typeLabel . ' has been returned for correction.' . ($newRemarks !== '' ? ' Remarks: ' . $newRemarks : ''),
            'For Endorsement'        => 'Your submitted ' . $typeLabel . ' is now for endorsement.',
            'Released to School'     => 'Your submitted ' . $typeLabel . ' has been released.',
            default                  => 'The status of your ' . $typeLabel . ' has been updated to: ' . $newStatus,
        };
    
        try {
            $nStmt = $pdo->prepare(
                "INSERT INTO school_notifications
                    (school_id, school_type, type, title, message, link, is_read, created_at)
                 VALUES
                    (:sid, :stype, :ntype, :title, :message, :link, 0, NOW())"
            );
            $nStmt->execute([
                ':sid'     => $targetSchoolId,
                ':stype'   => $schoolType,
                ':ntype'   => 'status_update',
                ':title'   => $notifTitle,
                ':message' => $notifMsg,
                ':link'    => 'school-portal-submissions.html',
            ]);
        } catch (\Throwable $notifErr) {
            error_log('[documents-submitted] Failed to insert school notification: ' . $notifErr->getMessage());
        }
    }

    respond(true, 'Submission updated');
}

/* ══════════════════════════════════════════════════════════════════════════
   actionApproveEdit — SDO grants a school permission to edit a submitted doc
   POST { action: 'approve_edit', id: <submission_id> }
   Uses the school_submissions id (what this admin page knows about),
   then looks up the linked school_tuition_documents row to unlock it.
══════════════════════════════════════════════════════════════════════════ */
function actionApproveEdit(PDO $pdo, array $body, array $authUser): void
{
    $submissionId = (int)($body['id'] ?? 0);
    if (!$submissionId) {
        respond(false, 'Record ID required', null, 422);
    }

    $adminId   = (int)($authUser['id'] ?? 0);
    $adminName = trim((string)($authUser['full_name'] ?? $authUser['email'] ?? 'SDO Admin'));

    // ── Fetch the submission row ──
    $sel = $pdo->prepare("SELECT * FROM school_submissions WHERE id = ?");
    $sel->execute([$submissionId]);
    $sub = $sel->fetch(PDO::FETCH_ASSOC);
    if (!$sub) {
        respond(false, 'Submission not found', null, 404);
    }

    $type = strtolower(trim((string)($sub['type'] ?? '')));
    if (!in_array($type, ['tuition', 'no_tuition', 'calendar'], true)) {
        respond(false, 'Edit approval is only supported for tuition and calendar documents.', null, 422);
    }

    $now      = date('Y-m-d H:i:s');
    $schoolId = (int)($sub['private_school_id'] ?? $sub['school_id'] ?? 0);
    $isCalendar = ($type === 'calendar');
    $docTitle = (string)($sub['title'] ?? ($isCalendar ? 'School Calendar' : 'Tuition Fee Document'));

    // ── 1. Append edit_approved event to submission history_json ──
    try {
        $history = json_decode((string)($sub['history_json'] ?? '[]'), true);
        if (!is_array($history)) $history = [];
        $history[] = [
            'event'      => 'edit_approved',
            'status'     => 'draft',
            'by'         => $adminName,
            'created_at' => $now,
            'note'       => '',
        ];
        // Keep school_submissions status as 'Returned for Correction' so the
        // record stays visible on the SDO side. Only the linked document row
        // (school_calendar_documents / school_tuition_documents) is unlocked to
        // 'draft'. When the school re-submits, upsertSchoolCalendar/TuitionSubmission
        // will update school_submissions.status back to 'Pending Review'.
        $pdo->prepare(
            "UPDATE school_submissions
             SET history_json = :hj,
                 updated_at   = NOW()
             WHERE id = :id"
        )->execute([
            ':hj' => json_encode($history, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':id' => $submissionId,
        ]);
    } catch (Throwable $e) {
        error_log('actionApproveEdit update submission: ' . $e->getMessage());
        respond(false, 'Failed to update submission record.', null, 500);
    }

    // ── 2. Unlock the linked document row ──
    // For calendar submissions, the linked doc ID is in calendar_document_id.
    // For tuition submissions, the linked doc ID must be looked up from
    // school_tuition_documents by submission_id, because school_submissions
    // only has a calendar_document_id column (not a tuition_document_id column).
    $linkedDocId = 0;
    if ($isCalendar) {
        $linkedDocId = (int)($sub['calendar_document_id'] ?? 0);
        // Fallback: look up by submission_id in case calendar_document_id is not set
        if (!$linkedDocId) {
            try {
                $lookupStmt = $pdo->prepare(
                    "SELECT id FROM school_calendar_documents
                     WHERE submission_id = :sid
                     ORDER BY id DESC LIMIT 1"
                );
                $lookupStmt->execute([':sid' => $submissionId]);
                $lookupRow = $lookupStmt->fetch(PDO::FETCH_ASSOC);
                if ($lookupRow) {
                    $linkedDocId = (int)$lookupRow['id'];
                }
            } catch (Throwable $e) {
                error_log('actionApproveEdit calendar doc lookup: ' . $e->getMessage());
            }
        }
    } else {
        // Tuition: look up the linked document by submission_id
        try {
            $lookupStmt = $pdo->prepare(
                "SELECT id FROM school_tuition_documents
                 WHERE submission_id = :sid
                 ORDER BY id DESC LIMIT 1"
            );
            $lookupStmt->execute([':sid' => $submissionId]);
            $lookupRow = $lookupStmt->fetch(PDO::FETCH_ASSOC);
            if ($lookupRow) {
                $linkedDocId = (int)$lookupRow['id'];
            }
        } catch (Throwable $e) {
            error_log('actionApproveEdit tuition doc lookup: ' . $e->getMessage());
        }
        // Fallback: calendar_document_id may have been reused to store tuition doc id
        if (!$linkedDocId) {
            $linkedDocId = (int)($sub['calendar_document_id'] ?? 0);
        }
    }

    if ($linkedDocId > 0) {
        try {
            if ($isCalendar) {
                // Unlock the school_calendar_documents row
                $pdo->prepare(
                    "UPDATE school_calendar_documents
                     SET status = 'draft', edit_request_status = 'approved', updated_at = NOW()
                     WHERE id = :id"
                )->execute([':id' => $linkedDocId]);
            } else {
                // Unlock the school_tuition_documents row
                $pdo->prepare(
                    "UPDATE school_tuition_documents
                     SET status = 'draft', edit_request_status = 'approved', updated_at = NOW()
                     WHERE id = :id"
                )->execute([':id' => $linkedDocId]);
            }
        } catch (Throwable $e) {
            // Non-fatal: submission is already updated; log and continue
            error_log('actionApproveEdit update linked doc: ' . $e->getMessage());
        }
    } else {
        error_log('actionApproveEdit: could not resolve linked doc id for submission_id=' . $submissionId . ', type=' . $type);
    }

    // ── 3. Notify the school ──
    if ($schoolId > 0) {
        try {
            // Resolve school_type from the submission's user_id (same pattern as actionUpdate)
            $uStmt = $pdo->prepare("SELECT school_type FROM users WHERE id = :uid LIMIT 1");
            $uStmt->execute([':uid' => (int)($sub['user_id'] ?? 0)]);
            $uRow = $uStmt->fetch(PDO::FETCH_ASSOC);
            $schoolType = (str_contains(strtolower((string)($uRow['school_type'] ?? '')), 'private'))
                ? 'private'
                : 'public';

            $notifTypeLabel = $isCalendar ? 'School Calendar' : 'Tuition Fee Document';
            $notifTitle     = 'Edit Request Approved — ' . $notifTypeLabel;
            $notifMessage   = sprintf(
                'Your request to edit %s "%s" has been approved. You may now log in and make your corrections.',
                strtolower($notifTypeLabel),
                $docTitle
            );

            $pdo->prepare("
                INSERT INTO school_notifications
                    (school_id, school_type, type, title, message, link, is_read, created_at)
                VALUES
                    (:sid, :stype, :ntype, :title, :message, :link, 0, NOW())
            ")->execute([
                ':sid'     => $schoolId,
                ':stype'   => $schoolType,
                ':ntype'   => 'edit_approved',
                ':title'   => $notifTitle,
                ':message' => $notifMessage,
                ':link'    => 'school-portal-submissions.html',
            ]);
        } catch (Throwable $e) {
            error_log('actionApproveEdit notification: ' . $e->getMessage());
        }
    }

    // ── 4. Audit log ──
    $auditAction = $isCalendar ? 'calendar_edit_approved' : 'tuition_edit_approved';
    $auditDocType = $isCalendar ? 'School Calendar' : 'Tuition Fee';
    $auditDesc = $isCalendar
        ? sprintf('Edit request approved for submission id=%d ("%s") — calendar document unlocked for school edits.', $submissionId, $docTitle)
        : sprintf('Edit request approved for submission id=%d ("%s") — tuition document unlocked for school edits.', $submissionId, $docTitle);

    try {
        auditLog([
            'pdo'           => $pdo,
            'user_id'       => $adminId,
            'role'          => $authUser['role'] ?? 'admin',
            'action'        => $auditAction,
            'module'        => 'documents_submitted',
            'status'        => 'success',
            'description'   => $auditDesc,
            'document_type' => $auditDocType,
            'file_name'     => (string)($sub['file_name'] ?? ''),
        ]);
    } catch (Throwable $e) {
        error_log('actionApproveEdit auditLog: ' . $e->getMessage());
    }

    respond(true, 'Edit request approved. The school can now edit this document.', [
        'submission_id'  => $submissionId,
        'linked_doc_id'  => $linkedDocId,
    ]);
}

function clean(mixed $v): string
{
    return trim((string)($v ?? ''));
}

// ────────────────────────────────────────────────────────────
// Tuition fee field definitions
// Mirrors KINDER_FIELDS / ELEM_FIELDS / JHS_FIELDS / SHS_FIELDS in
// school-portal-tuition.js exactly, so server-side totals match what
// the school saw in the builder.
// ────────────────────────────────────────────────────────────
// NOTE: these are deliberately functions, not top-level `const` arrays.
// Top-level `const` statements in PHP are NOT hoisted the way function/class
// declarations are — they execute in normal top-to-bottom script order. The
// request dispatcher above (the `switch ($method)` block, ~line 55) calls
// actionDownload()/actionDownloadTuition() before the script's execution
// pointer would ever reach a `const` declared down here, so referencing it
// from inside that call chain throws "Undefined constant". Wrapping the
// array in a function sidesteps the issue entirely, since function bodies
// aren't evaluated until called, regardless of where they sit in the file.
function dsTuitionFields(): array
{
    return [
    'kinder' => [
        ['key' => 'k_tuition',  'label' => 'Tuition Fee'],
        ['key' => 'k_id',       'label' => 'ID / Insurance'],
        ['key' => 'k_ins',      'label' => 'Insurance'],
        ['key' => 'k_handbook', 'label' => 'Handbook Fee'],
        ['key' => 'k_water',    'label' => 'Water Fee'],
        ['key' => 'k_itm',      'label' => 'Instructional & Test Mat.'],
        ['key' => 'k_med',      'label' => 'Medical Supplies'],
        ['key' => 'k_reg',      'label' => 'Registration Fee'],
        ['key' => 'k_books',    'label' => 'Books'],
        ['key' => 'k_dev',      'label' => 'Development Fee'],
    ],
    'elem' => [
        ['key' => 'e_tuition',  'label' => 'Tuition Fee'],
        ['key' => 'e_id',       'label' => 'ID Card'],
        ['key' => 'e_ins',      'label' => 'Insurance'],
        ['key' => 'e_handbook', 'label' => 'Handbook Fee'],
        ['key' => 'e_lab',      'label' => 'Laboratory Fee'],
        ['key' => 'e_water',    'label' => 'Water Fee'],
        ['key' => 'e_itm',      'label' => 'Instructional & Test Mat.'],
        ['key' => 'e_med',      'label' => 'Medical Supplies'],
        ['key' => 'e_reg',      'label' => 'Registration Fee'],
        ['key' => 'e_books',    'label' => 'Books'],
        ['key' => 'e_paces1',   'label' => 'PACES (1st Sem)'],
        ['key' => 'e_paces2',   'label' => 'PACES (2nd Sem)'],
    ],
    'jhs' => [
        ['key' => 'j_tuition',  'label' => 'Tuition Fee'],
        ['key' => 'j_id',       'label' => 'ID Card'],
        ['key' => 'j_ins',      'label' => 'Insurance'],
        ['key' => 'j_handbook', 'label' => 'Handbook Fee'],
        ['key' => 'j_comp',     'label' => 'Computer Laboratory Fee'],
        ['key' => 'j_water',    'label' => 'Water Fee'],
        ['key' => 'j_itm',      'label' => 'Instructional & Test Mat.'],
        ['key' => 'j_med',      'label' => 'Medical Supplies'],
        ['key' => 'j_reg',      'label' => 'Registration Fee'],
        ['key' => 'j_books',    'label' => 'Books'],
        ['key' => 'j_paces1',   'label' => 'PACES (1st Sem)'],
        ['key' => 'j_paces2',   'label' => 'PACES (2nd Sem)'],
    ],
    'shs' => [
        ['key' => 's_tuition',   'label' => 'Tuition Fee'],
        ['key' => 's11_tuition', 'label' => 'Tuition Fee (Grade 11)'],
        ['key' => 's12_tuition', 'label' => 'Tuition Fee (Grade 12)'],
        ['key' => 's_id',        'label' => 'ID Card'],
        ['key' => 's_ins',       'label' => 'Insurance'],
        ['key' => 's_exam',      'label' => 'Examination Fee'],
        ['key' => 's_sports',    'label' => 'Sports Development / Athletics'],
        ['key' => 's_sid',       'label' => 'Student ID Card (SID)'],
        ['key' => 's_handbook',  'label' => 'Handbook Fee'],
        ['key' => 's_comp',      'label' => 'Computer Laboratory Fee'],
        ['key' => 's_water',     'label' => 'Water Fee'],
        ['key' => 's_itm',       'label' => 'Instructional & Test Mat.'],
        ['key' => 's_med',       'label' => 'Medical Supplies'],
        ['key' => 's_reg',       'label' => 'Registration Fee'],
        ['key' => 's_books',     'label' => 'Books'],
        ['key' => 's_dev',       'label' => 'Development Fee'],
    ],
    ];
}

function dsTuitionLevelLabels(): array
{
    return [
        'kinder' => 'Kindergarten',
        'elem'   => 'Elementary',
        'jhs'    => 'Junior High School',
        'shs'    => 'Senior High School',
    ];
}

/**
 * Resolves the school_tuition_documents row that corresponds to a given
 * school_submissions record.
 *
 * IMPORTANT: school_tuition_documents has NO column that references
 * school_submissions.id (no submission_id, no calendar_document_id
 * equivalent). The only relationship the schema encodes is via the school
 * itself (user_id / private_school_id) plus the school year. A school can
 * have multiple tuition_documents rows over time (e.g. an old submitted one
 * plus a newer draft from an edit request), so the match must also be
 * scoped to status = 'submitted' and, since school_id/private_school_id +
 * proposed_sy + status could still theoretically collide, the most
 * recently updated row is taken.
 */
// ────────────────────────────────────────────────────────────
// dsResolveTuitionDocForSubmission
// Shared lookup for the two supporting-upload actions below. Pulls only
// the columns dsFindTuitionDocument() needs (user_id/school_id/
// private_school_id/school_year/type), then hands off to the same
// resolver actionDownloadTuition() already uses, so "which tuition
// document does this submission belong to" stays defined in one place.
// ────────────────────────────────────────────────────────────
function dsResolveTuitionDocForSubmission(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare(
        "SELECT id, user_id, school_id, private_school_id, title, school_year, type
           FROM school_submissions
          WHERE id = :id AND type IN ('tuition', 'no_tuition')
          LIMIT 1"
    );
    $stmt->execute([':id' => $id]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) {
        respond(false, 'Record not found', null, 404);
    }

    $tuitionDoc = dsFindTuitionDocument($pdo, $sub);
    return [$sub, $tuitionDoc];
}

// ────────────────────────────────────────────────────────────
// dsEnsureTuitionSupportingUploadsTable
// Defensive create — mirrors ensureTuitionSupportingUploadsTable() in
// school-portal-tuition.php. That file is the one actually writing to
// this table; this admin API only ever reads from it, but guards the
// same way in case it's ever hit before that migration has run.
// ────────────────────────────────────────────────────────────
function dsEnsureTuitionSupportingUploadsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_tuition_supporting_uploads (
            id INT(11) NOT NULL AUTO_INCREMENT,
            tuition_document_id INT(11) NOT NULL,
            slug VARCHAR(100) NOT NULL,
            original_filename VARCHAR(255) NOT NULL,
            stored_filename VARCHAR(255) NOT NULL,
            mime_type VARCHAR(150) DEFAULT NULL,
            file_size INT(11) DEFAULT NULL,
            uploaded_by INT(11) NOT NULL,
            uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_tsu_doc_slug (tuition_document_id, slug),
            KEY idx_tsu_document_id (tuition_document_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

// ────────────────────────────────────────────────────────────
// dsTuitionSupportingUploadsDir
// Same physical folder school-portal-tuition.php's
// tuitionSupportingUploadsDir() writes to. Both API files live at the
// same directory depth, so dirname(__DIR__) resolves to the same path.
// ────────────────────────────────────────────────────────────
function dsTuitionSupportingUploadsDir(): string
{
    return dirname(__DIR__) . '/uploads/tuition-supporting-docs';
}

// ────────────────────────────────────────────────────────────
// Calendar supporting uploads helpers (admin-side)
// Mirrors the school-portal handlers' storage location and schema.
// ────────────────────────────────────────────────────────────
function dsEnsureCalendarSupportingUploadsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_calendar_supporting_uploads (
            id INT(11) NOT NULL AUTO_INCREMENT,
            calendar_document_id INT(11) NOT NULL,
            slug VARCHAR(100) NOT NULL,
            original_filename VARCHAR(255) NOT NULL,
            stored_filename VARCHAR(255) NOT NULL,
            mime_type VARCHAR(150) DEFAULT NULL,
            file_size INT(11) DEFAULT NULL,
            uploaded_by INT(11) NOT NULL,
            uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_csu_doc_slug (calendar_document_id, slug),
            KEY idx_csu_document_id (calendar_document_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function dsCalendarSupportingUploadsDir(): string
{
    return dirname(__DIR__) . '/uploads/calendar-supporting-docs';
}

// ────────────────────────────────────────────────────────────
// actionListSupportingUploads
// GET ?action=list_supporting_uploads&id={submission_id}
// Admin-scoped equivalent of handleGetSupportingUploads() in
// school-portal-tuition.php: same table, but no assertOwnsTuitionDocument
// check — this whole file is already gated behind
// requirePermission('school_submissions', $authUser) up top, and the
// submission id -> tuition_document_id resolution below is what scopes
// the result, so an admin can only ever see uploads belonging to the
// submission they're viewing.
// Joined against school_supporting_documents for a friendly label/icon
// (falls back to a prettified slug if that row is missing).
// ────────────────────────────────────────────────────────────
function actionListSupportingUploads(PDO $pdo): void
{
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) { respond(false, 'Record ID required', null, 422); }

    // Load the submission to determine its type and any linked document id
    $stmt = $pdo->prepare("SELECT id, type, calendar_document_id FROM school_submissions WHERE id = :id LIMIT 1");
    $stmt->execute([':id' => $id]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) { respond(false, 'Record not found', null, 404); }

    $type = strtolower(trim((string)($sub['type'] ?? '')));

    // Tuition flow (existing behavior)
    if ($type === 'tuition' || $type === 'no_tuition') {
        [, $tuitionDoc] = dsResolveTuitionDocForSubmission($pdo, $id);
        if (!$tuitionDoc) {
            respond(true, 'No tuition fee document linked to this submission.', ['items' => []]);
        }

        dsEnsureTuitionSupportingUploadsTable($pdo);

        $stmt = $pdo->prepare(
            "SELECT tsu.slug, tsu.original_filename, tsu.mime_type, tsu.file_size, tsu.uploaded_at,
                    sd.label, sd.icon
               FROM school_tuition_supporting_uploads tsu
               LEFT JOIN school_supporting_documents sd ON sd.slug = tsu.slug
              WHERE tsu.tuition_document_id = :did
              ORDER BY tsu.uploaded_at ASC"
        );
        $stmt->execute([':did' => (int)$tuitionDoc['id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $r): array {
            $label = trim((string)($r['label'] ?? ''));
            if ($label === '') {
                $label = ucwords(str_replace(['_', '-'], ' ', (string)$r['slug']));
            }
            return [
                'slug'              => $r['slug'],
                'label'             => $label,
                'icon'              => $r['icon'] ?: 'fa-file',
                'original_filename' => $r['original_filename'],
                'mime_type'         => $r['mime_type'],
                'file_size'         => (int)$r['file_size'],
                'uploaded_at'       => $r['uploaded_at'],
            ];
        }, $rows);

        respond(true, 'Supporting uploads retrieved.', ['items' => $items]);
    }

    // Calendar flow
    if ($type === 'calendar' || !empty($sub['calendar_document_id'])) {
        $calId = (int)($sub['calendar_document_id'] ?? 0);
        if (!$calId) {
            respond(true, 'No calendar document linked to this submission.', ['items' => []]);
        }

        // Ensure table exists and then read uploaded rows
        dsEnsureCalendarSupportingUploadsTable($pdo);

        $stmt = $pdo->prepare(
            "SELECT csu.slug, csu.original_filename, csu.mime_type, csu.file_size, csu.uploaded_at,
                    sd.label, sd.icon
               FROM school_calendar_supporting_uploads csu
               LEFT JOIN school_supporting_documents sd ON sd.slug = csu.slug
              WHERE csu.calendar_document_id = :did
              ORDER BY csu.uploaded_at ASC"
        );
        $stmt->execute([':did' => $calId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $r): array {
            $label = trim((string)($r['label'] ?? ''));
            if ($label === '') {
                $label = ucwords(str_replace(['_', '-'], ' ', (string)$r['slug']));
            }
            return [
                'slug'              => $r['slug'],
                'label'             => $label,
                'icon'              => $r['icon'] ?: 'fa-file',
                'original_filename' => $r['original_filename'],
                'mime_type'         => $r['mime_type'],
                'file_size'         => (int)$r['file_size'],
                'uploaded_at'       => $r['uploaded_at'],
            ];
        }, $rows);

        respond(true, 'Supporting uploads retrieved.', ['items' => $items]);
    }

    // Default: no uploads
    respond(true, 'No supporting documents available for this submission type.', ['items' => []]);
}

// ────────────────────────────────────────────────────────────
// actionSupportingDocsCatalog
// GET ?action=supporting_docs_catalog&doc_type=tuition_increase
// Admin-scoped equivalent of handleSupportingDocsList() in
// school-portal-tuition.php. That file can't be called directly from the
// admin session — it hard-rejects any request whose role isn't a school
// portal user (see its "Access denied. This endpoint is only for school
// portal users." check), regardless of which action is requested. So this
// queries the same school_supporting_documents table directly instead,
// under this file's own requirePermission('school_submissions', $authUser)
// gate. Query and response shape are kept identical to
// handleSupportingDocsList() so the two stay in sync.
// ────────────────────────────────────────────────────────────
function actionSupportingDocsCatalog(PDO $pdo): void
{
    $docType = strtolower(trim((string)($_GET['doc_type'] ?? 'all')));
    if ($docType === '') { $docType = 'all'; }

    try {
        $stmt = $pdo->prepare(
            "SELECT slug, label, hint, icon, display_order
               FROM school_supporting_documents
              WHERE is_active = 1
                AND (doc_type = :doc_type OR doc_type = 'all')
              ORDER BY display_order ASC, id ASC"
        );
        $stmt->execute([':doc_type' => $docType]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (\PDOException $e) {
        // Table may not exist yet in some environments — degrade to an
        // empty catalog rather than a hard error (the caller already
        // merges in its own hardcoded/auto-fulfilled item regardless).
        error_log('[documents-submitted] actionSupportingDocsCatalog failed: ' . $e->getMessage());
        respond(true, 'Supporting documents retrieved.', ['items' => []]);
        return;
    }

    $items = array_map(static function (array $r): array {
        return [
            'id'    => $r['slug'],
            'label' => $r['label'],
            'hint'  => $r['hint'],
            'icon'  => $r['icon'],
        ];
    }, $rows);

    respond(true, 'Supporting documents retrieved.', ['items' => $items]);
}

// ────────────────────────────────────────────────────────────
// actionDownloadSupportingUpload
// GET ?action=download_supporting_upload&id={submission_id}&slug={slug}
// Streams a single supporting-document file for admin review/download.
// Scoped by resolving submission -> its linked school_tuition_documents
// row, then requiring the upload row to belong to THAT
// tuition_document_id — an admin can only ever pull files attached to
// the submission they opened, never an arbitrary id passed in.
// Served inline (not force-download) so PDFs/images open in a new tab
// for quick review; browsers fall back to downloading unsupported types.
// ────────────────────────────────────────────────────────────
function actionDownloadSupportingUpload(PDO $pdo): void
{
    $id   = (int)($_GET['id'] ?? 0);
    $slug = strtolower(trim((string)($_GET['slug'] ?? '')));
    if (!$id || !$slug) { respond(false, 'Record ID and slug are required', null, 422); }

    // Load submission to determine type/calendar linkage
    $stmt = $pdo->prepare("SELECT id, type, calendar_document_id FROM school_submissions WHERE id = :id LIMIT 1");
    $stmt->execute([':id' => $id]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) { respond(false, 'Record not found', null, 404); }

    $type = strtolower(trim((string)($sub['type'] ?? '')));

    // Tuition flow
    if ($type === 'tuition' || $type === 'no_tuition') {
        [, $tuitionDoc] = dsResolveTuitionDocForSubmission($pdo, $id);
        if (!$tuitionDoc) { respond(false, 'No tuition fee document linked to this submission.', null, 404); }

        dsEnsureTuitionSupportingUploadsTable($pdo);

        $stmt = $pdo->prepare(
            "SELECT original_filename, stored_filename, mime_type
               FROM school_tuition_supporting_uploads
              WHERE tuition_document_id = :did AND slug = :slug
              LIMIT 1"
        );
        $stmt->execute([':did' => (int)$tuitionDoc['id'], ':slug' => $slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) { respond(false, 'File not found for this submission.', null, 404); }

        $path = dsTuitionSupportingUploadsDir() . '/' . $row['stored_filename'];
        if (!is_file($path)) { respond(false, 'File not found on server.', null, 404); }

        if (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: ' . ($row['mime_type'] ?: 'application/octet-stream'));
        header('Content-Disposition: inline; filename="' . basename((string)$row['original_filename']) . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    // Calendar flow
    if ($type === 'calendar' || !empty($sub['calendar_document_id'])) {
        $calId = (int)($sub['calendar_document_id'] ?? 0);
        if (!$calId) { respond(false, 'No calendar document linked to this submission.', null, 404); }

        dsEnsureCalendarSupportingUploadsTable($pdo);

        $stmt = $pdo->prepare(
            "SELECT original_filename, stored_filename, mime_type
               FROM school_calendar_supporting_uploads
              WHERE calendar_document_id = :did AND slug = :slug
              LIMIT 1"
        );
        $stmt->execute([':did' => $calId, ':slug' => $slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) { respond(false, 'File not found for this submission.', null, 404); }

        $path = dsCalendarSupportingUploadsDir() . '/' . $row['stored_filename'];
        if (!is_file($path)) { respond(false, 'File not found on server.', null, 404); }

        if (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: ' . ($row['mime_type'] ?: 'application/octet-stream'));
        header('Content-Disposition: inline; filename="' . basename((string)$row['original_filename']) . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    respond(false, 'Supporting uploads not available for this submission type.', null, 404);
}

function dsFindTuitionDocument(PDO $pdo, array $submission): ?array
{
    $userId           = (int)($submission['user_id'] ?? 0);
    $privateSchoolId  = (int)($submission['private_school_id'] ?? 0);
    $schoolId         = (int)($submission['school_id'] ?? 0);
    $schoolYear       = trim((string)($submission['school_year'] ?? ''));

    if ($userId <= 0 && $privateSchoolId <= 0 && $schoolId <= 0) {
        return null;
    }

    $where  = [];
    $params = [];

    if ($privateSchoolId > 0) {
        $where[] = 'private_school_id = :psid';
        $params[':psid'] = $privateSchoolId;
    } elseif ($schoolId > 0) {
        // Public schools may use a different column; school_tuition_documents
        // only has private_school_id today, so fall back to user_id alone.
        $where[] = 'user_id = :uid';
        $params[':uid'] = $userId;
    }

    if ($userId > 0 && !isset($params[':uid'])) {
        $where[] = 'user_id = :uid';
        $params[':uid'] = $userId;
    }

    if ($schoolYear !== '') {
        $where[] = 'proposed_sy = :sy';
        $params[':sy'] = $schoolYear;
    }

    if (!$where) {
        return null;
    }

    // First try the strict match scoped to submitted documents — this is
    // the correct row for a submission that has already been filed.
    try {
        $sql = "SELECT * FROM school_tuition_documents
                WHERE " . implode(' AND ', $where) . "
                AND status = 'submitted'
                ORDER BY updated_at DESC, id DESC
                LIMIT 1";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            return $row;
        }
    } catch (\Throwable $e) {
        error_log('dsFindTuitionDocument submitted-match failed: ' . $e->getMessage());
    }

    // Fallback: no submitted row matched (e.g. status got out of sync) —
    // take the most recently updated tuition document for this school/year
    // regardless of status, so the preview still shows something useful.
    try {
        $sql = "SELECT * FROM school_tuition_documents
                WHERE " . implode(' AND ', $where) . "
                ORDER BY updated_at DESC, id DESC
                LIMIT 1";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            return $row;
        }
    } catch (\Throwable $e) {
        error_log('dsFindTuitionDocument fallback match failed: ' . $e->getMessage());
    }

    return null;
}

/**
 * Builds a per-level (kinder/elem/jhs/shs) fee summary: each fee row with its
 * current/proposed/increase amounts, plus level totals. Per-row math mirrors
 * the computeKinder()/computeElem()/computeJHS()/computeSHS() logic in
 * school-portal-tuition.js: proposed = current * (1 + pct) when mode is
 * 'increase', otherwise proposed = current and increase = 0.
 *
 * school_tuition_documents stores precomputed level totals
 * ({level}_total_curr / {level}_total_prop) alongside payload_json. Those
 * are authoritative (they're exactly what the school saw when they saved),
 * so when present they're used for the displayed totals instead of the
 * sum recomputed from payload_json rows — this avoids any drift if a fee
 * field gets renamed/added later and the row-level reconstruction misses it.
 */
function dsBuildTuitionLevelSummary(string $levelKey, array $payload, string $mode, float $increasePct, array $tuitionDoc = []): array
{
    $levelData = is_array($payload[$levelKey] ?? null) ? $payload[$levelKey] : [];
    $fields    = dsTuitionFields()[$levelKey] ?? [];
    $isIncrease = ($mode !== 'no_increase');
    $pctFraction = $increasePct / 100;

    $rows = [];
    $totalCurr = 0.0;
    $totalProp = 0.0;

    foreach ($fields as $field) {
        $curr = (float)($levelData[$field['key'] . '_curr'] ?? 0);
        if ($curr == 0.0) {
            // Skip fee rows the school never filled in, same as the live
            // preview which only renders fees that have a value.
            continue;
        }
        $prop = $isIncrease ? $curr * (1 + $pctFraction) : $curr;
        $inc  = $prop - $curr;

        $rows[] = [
            'label'    => $field['label'],
            'current'  => round($curr, 2),
            'proposed' => round($prop, 2),
            'increase' => round($inc, 2),
        ];

        $totalCurr += $curr;
        $totalProp += $prop;
    }

    // Custom (school-added) miscellaneous fees, persisted in
    // payload.custom_fees[level] as [{label, fieldId}, ...].
    $customDefs = is_array($payload['custom_fees'][$levelKey] ?? null) ? $payload['custom_fees'][$levelKey] : [];
    foreach ($customDefs as $def) {
        if (!is_array($def)) {
            continue;
        }
        $fieldId = (string)($def['fieldId'] ?? '');
        $label   = (string)($def['label'] ?? 'Other Fee');
        if ($fieldId === '') {
            continue;
        }
        $curr = (float)($levelData[$fieldId . '_curr'] ?? 0);
        if ($curr == 0.0) {
            continue;
        }
        $prop = $isIncrease ? $curr * (1 + $pctFraction) : $curr;
        $inc  = $prop - $curr;

        $rows[] = [
            'label'    => $label,
            'current'  => round($curr, 2),
            'proposed' => round($prop, 2),
            'increase' => round($inc, 2),
        ];

        $totalCurr += $curr;
        $totalProp += $prop;
    }

    // Prefer the stored, authoritative totals from school_tuition_documents
    // when available; fall back to the recomputed sum (e.g. if the column
    // is null for an older row saved before totals were persisted).
    $storedCurrKey = $levelKey . '_total_curr';
    $storedPropKey = $levelKey . '_total_prop';
    if (isset($tuitionDoc[$storedCurrKey]) && $tuitionDoc[$storedCurrKey] !== null) {
        $totalCurr = (float)$tuitionDoc[$storedCurrKey];
    }
    if (isset($tuitionDoc[$storedPropKey]) && $tuitionDoc[$storedPropKey] !== null) {
        $totalProp = (float)$tuitionDoc[$storedPropKey];
    }

    return [
        'label'           => dsTuitionLevelLabels()[$levelKey] ?? ucfirst($levelKey),
        'rows'            => $rows,
        'total_current'   => round($totalCurr, 2),
        'total_proposed'  => round($totalProp, 2),
        'total_increase'  => round($totalProp - $totalCurr, 2),
    ];
}

function dsSanitizeFilename(string $name): string
{
    $clean = preg_replace('/[^A-Za-z0-9._-]+/', '-', trim($name));
    $clean = trim((string)$clean, '-._');
    return $clean !== '' ? $clean : 'school-calendar';
}

function dsEscHtml(string $v): string {
    return htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function dsDaysInMonth(int $year, int $month): int {
    return (int)date('t', strtotime(sprintf('%04d-%02d-01', $year, $month + 1)));
}

/**
 * Mirrors PERIOD_LEVEL_MAP / getPeriodConfigForLevel() in
 * school-portal-calendar.js so the exported PDF groups the 11 academic
 * months into the same Quarters/Trimesters/Semesters structure the
 * school's own builder uses (DepEd convention: SHS/College -> 2
 * semesters, everything else -> 4 quarters, unless the school
 * explicitly overrode it via the Term Structure dropdown).
 */
function dsGetPeriodConfig(string $dept, ?string $override): array
{
    if ($override) {
        $parts = explode(':', $override, 2);
        $type  = $parts[0] ?? '';
        $count = (int)($parts[1] ?? 0);
        if ($type !== '' && $count > 0) {
            $label = $type === 'semester' ? 'SEMESTER' : ($type === 'trimester' ? 'TRIMESTER' : 'QUARTER');
            return ['type' => $type, 'count' => $count, 'label' => $label];
        }
    }

    $d = strtolower(trim($dept));
    $map = [
        ['test' => fn($x) => str_contains($x, 'senior high') || $x === 'shs', 'type' => 'semester', 'count' => 2],
        ['test' => fn($x) => str_contains($x, 'college'),                      'type' => 'semester', 'count' => 2],
        ['test' => fn($x) => str_contains($x, 'kinder'),                       'type' => 'quarter',  'count' => 4],
        ['test' => fn($x) => str_contains($x, 'preschool'),                    'type' => 'quarter',  'count' => 4],
        ['test' => fn($x) => str_contains($x, 'elementary'),                   'type' => 'quarter',  'count' => 4],
        ['test' => fn($x) => str_contains($x, 'junior high') || $x === 'jhs', 'type' => 'quarter',  'count' => 4],
        ['test' => fn($x) => str_contains($x, 'sped'),                         'type' => 'quarter',  'count' => 4],
    ];
    foreach ($map as $rule) {
        if ($rule['test']($d)) {
            $label = $rule['type'] === 'semester' ? 'SEMESTER' : ($rule['type'] === 'trimester' ? 'TRIMESTER' : 'QUARTER');
            return ['type' => $rule['type'], 'count' => $rule['count'], 'label' => $label];
        }
    }
    return ['type' => 'quarter', 'count' => 4, 'label' => 'QUARTER'];
}

/** Splits the 11 academic months as evenly as possible into $count buckets. */
function dsSplitAcadMonths(int $count): array
{
    $total = 11;
    $base  = intdiv($total, $count);
    $extra = $total % $count;
    $parts = [];
    for ($i = 0; $i < $count; $i++) {
        $parts[] = $base + ($i < $extra ? 1 : 0);
    }
    return $parts;
}

function dsComputeSchoolDaysByMonth(array $payload): array
{
    $form = is_array($payload['form'] ?? null) ? $payload['form'] : [];
    $savedMarks = is_array($payload['savedMarks'] ?? null) ? $payload['savedMarks'] : [];
    $legends = is_array($payload['legends'] ?? null) ? $payload['legends'] : [];

    $sy1 = (int)trim((string)($form['f_sy1'] ?? date('Y')));
    $sy2 = (int)trim((string)($form['f_sy2'] ?? ($sy1 + 1)));

    $acadMonths = [
        [$sy1, 5], [$sy1, 6], [$sy1, 7], [$sy1, 8],
        [$sy1, 9], [$sy1, 10], [$sy1, 11],
        [$sy2, 0], [$sy2, 1], [$sy2, 2], [$sy2, 3],
    ];

    $monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    $openingDate = !empty($form['f_opening']) ? new DateTime((string)$form['f_opening']) : null;
    $closingDate = !empty($form['f_closing']) ? new DateTime((string)$form['f_closing']) : null;

    $out = [];
    foreach ($acadMonths as [$y, $m]) {
        $days = dsDaysInMonth($y, $m);
        $count = 0;

        for ($d = 1; $d <= $days; $d++) {
            $dt = new DateTime(sprintf('%04d-%02d-%02d', $y, $m + 1, $d));
            if ($openingDate && $dt < $openingDate) {
                continue;
            }
            if ($closingDate && $dt > $closingDate) {
                continue;
            }

            $dow = (int)$dt->format('w');
            $isWeekend = ($dow === 0 || $dow === 6);
            $key = $y . '-' . $m . '-' . $d;
            $mark = $savedMarks[$key] ?? null;

            if ($mark) {
                $legend = $legends[$mark] ?? null;
                $include = is_array($legend) ? (($legend['includeInSchoolDays'] ?? true) !== false) : true;
                if ($include) {
                    $count++;
                }
            } elseif (!$isWeekend) {
                $count++;
            }
        }

        $out[] = ['name' => $monthNames[$m], 'year' => $y, 'days' => $count];
    }

    return $out;
}

function dsReadCssFile(string $path): string
{
    $css = @file_get_contents($path);
    return is_string($css) ? $css : '';
}

function dsExtractBodyHtml(string $html): string
{
    if (preg_match('/<body[^>]*>(.*)<\/body>/is', $html, $m) === 1) {
        return (string)$m[1];
    }
    return $html;
}

function dsExtractCalendarData(array $row, array $payload): array
{
    $form       = is_array($payload['form']       ?? null) ? $payload['form']       : [];
    $savedMarks = is_array($payload['savedMarks'] ?? null) ? $payload['savedMarks'] : [];
    $legends    = is_array($payload['legends']    ?? null) ? $payload['legends']    : [];
    $months     = dsComputeSchoolDaysByMonth($payload);
    $totalDays  = array_sum(array_map(static fn(array $m): int => (int)($m['days'] ?? 0), $months));

    $sy1 = trim((string)($form['f_sy1'] ?? '2026'));
    $sy2 = trim((string)($form['f_sy2'] ?? '2027'));

    $rawArdName   = (string)($form['f_approved']   ?? $form['f_ard_name']   ?? '---');
    $rawArdPos    = (string)($form['f_app_pos']    ?? $form['f_ard_pos']    ?? '---');
    $rawArdOffice = (string)($form['f_app_org']    ?? $form['f_ard_office'] ?? '---');

    $attachedLines = preg_split('/\r\n|\r|\n/', (string)($form['f_attached'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    if (!$attachedLines) {
        $attachedLines = [
            'Letter of Intent',
            'School Calendar for S.Y. ' . $sy1 . '-' . $sy2,
            'Board Resolution',
            'Photocopy of SEC Registration',
            'Photocopy of Government Recognition/Permit',
        ];
    }

    $sy1Int = (int)$sy1;
    $sy2Int = (int)$sy2;
    $acadMonths = [
        [$sy1Int, 5], [$sy1Int, 6], [$sy1Int, 7], [$sy1Int, 8],
        [$sy1Int, 9], [$sy1Int, 10], [$sy1Int, 11],
        [$sy2Int, 0], [$sy2Int, 1], [$sy2Int, 2], [$sy2Int, 3],
    ];

    return [
        'form'           => $form,
        'savedMarks'     => $savedMarks,
        'legends'        => $legends,
        'months'         => $months,
        'totalDays'      => $totalDays,
        'sy1'            => $sy1,
        'sy2'            => $sy2,
        'syDash'         => $sy1 . '-' . $sy2,
        'syRange'        => $sy1 . '–' . $sy2,
        'school'         => (string)($form['f_school']          ?? $row['school_name'] ?? $row['title'] ?? 'School'),
        'dept'           => (string)($form['f_dept']            ?? 'Elementary School'),
        'periodOverride' => (string)($form['f_period_override'] ?? ''),
        'sid'            => (string)($form['f_sid']             ?? '---'),
        'govRecog'       => (string)($form['f_gov']             ?? ''),
        'principal'      => (string)($form['f_principal']       ?? '---'),
        'principalTitle' => (string)($form['f_principal_title'] ?? 'Principal'),
        'rdName'         => (string)($form['f_rd_name']         ?? 'RONNIE S. MALLARI, PhD, CESO V'),
        'rdPos'          => (string)($form['f_rd_pos']          ?? 'Regional Director'),
        'rdOffice'       => (string)($form['f_rd_office']       ?? 'Office of the Regional Director'),
        'sdsName'        => (string)($form['f_sds_name']        ?? 'ROWENA T. QUIAMBAO, CESO VI'),
        'sdsPos'         => (string)($form['f_sds_pos']         ?? 'Schools Division Superintendent'),
        'sdsOffice'      => (string)($form['f_sds_office']      ?? 'Office of the Schools Division Superintendent'),
        'sdsCity'        => (string)($form['f_sds_city']        ?? 'Baliwag City, Bulacan'),
        'recommending'    => (string)($form['f_recommending'] ?? $form['f_sds_name']   ?? '---'),
        'recommendingPos' => (string)($form['f_rec_pos']      ?? $form['f_sds_pos']    ?? '---'),
        'recommendingOrg' => (string)($form['f_rec_org']      ?? $form['f_sds_office'] ?? '---'),
        'ardName'        => $rawArdName,
        'ardPos'         => $rawArdPos,
        'ardOffice'      => $rawArdOffice,
        'loiP1'          => (string)($form['f_loi_p1']          ?? 'I am writing to express our intent regarding the reopening of classes and respectfully enclose the school calendar for your perusal.'),
        'loiP2'          => (string)($form['f_loi_p2']          ?? 'Our school pledges full cooperation, engagement, and support for a smooth transition and successful resumption of classes.'),
        'loiClosing'     => (string)($form['f_loi_closing']     ?? 'Thank you for your kind attention. May the grace of our Lord be upon you always!'),
        'attachedLines'  => $attachedLines,
        'acadMonths'     => $acadMonths,
        'logoRaw'        => (function () use ($row, $payload): string {
            $logo = dsNormalizeSchoolLogo((string)($row['school_logo'] ?? ''));
            if ($logo === '' && !empty($payload['logoDataUrl'])) {
                $logo = dsNormalizeSchoolLogo((string)$payload['logoDataUrl']);
            }
            return $logo;
        })(),
        'submittedBy'    => (string)($row['submitted_by']   ?? '---'),
        'dateSubmitted'  => (string)($row['date_submitted'] ?? '---'),
        'status'         => (string)($row['status']         ?? '---'),
        'remarks'        => (string)($row['remarks']        ?? ''),
        'openingRaw'     => (string)($form['f_opening'] ?? ''),
        'closingRaw'     => (string)($form['f_closing'] ?? ''),
    ];
}

/**
 * Builds a printable HTML document (for TCPDF) summarizing a tuition fee
 * submission: school info, mode (increase / no increase), and a fee
 * breakdown table per enabled grade level with current / proposed /
 * increase columns and level totals.
 */
function buildTuitionDocHtml(array $sub, array $tuitionDoc, array $payload): string
{
    $e = static fn(?string $v): string => dsEscHtml((string)($v ?? ''));
    $fmt = static function ($n): string {
        return number_format((float)$n, 2);
    };

    $form = is_array($payload['form'] ?? null) ? $payload['form'] : [];
    $schoolName = $form['school_name'] ?? ($sub['school_name'] ?? $sub['title'] ?? '');
    $mode       = (string)($tuitionDoc['mode'] ?? 'increase');
    $isIncrease = ($mode !== 'no_increase');
    $increasePct = (float)($form['increase_pct'] ?? $tuitionDoc['increase_pct'] ?? 0);

    $css = '
<style>
  body { font-family: "Times New Roman", Times, serif; font-size: 10pt; color: #111; margin:0; padding:0; }
  table { border-collapse: collapse; width:100%; }
  .tf-title { font-size:15pt; font-weight:bold; text-align:center; margin-bottom:4pt; }
  .tf-sub   { font-size:10pt; text-align:center; color:#444; margin-bottom:12pt; }
  .tf-info-tbl td { padding:2pt 6pt; font-size:9.5pt; vertical-align:top; }
  .tf-info-tbl .lbl { font-weight:bold; width:32%; }
  .tf-level-title { font-size:11.5pt; font-weight:bold; background:#dde4f0; border:1px solid #888;
                     padding:4pt 8pt; margin-top:14pt; }
  .tf-fee-tbl { margin-top:4pt; }
  .tf-fee-tbl th { border:1px solid #888; background:#eef2fa; padding:4pt 6pt; font-size:9pt; text-align:center; }
  .tf-fee-tbl td { border:1px solid #888; padding:3pt 6pt; font-size:9pt; }
  .tf-fee-tbl td.num { text-align:right; }
  .tf-total-row td { font-weight:bold; background:#e8f0fb; }
  .tf-status { margin-top:14pt; font-size:9.5pt; color:#444; }
</style>';

    $modeLabel = $isIncrease
        ? 'Fee Increase (' . $fmt($increasePct) . '%)'
        : 'Retention of Existing Fees (No Increase)';

    $info = '
    <table class="tf-info-tbl">
        <tr><td class="lbl">School Name</td><td>' . $e((string)$schoolName) . '</td>
            <td class="lbl">School Year (Proposed)</td><td>' . $e((string)($form['proposed_sy'] ?? $sub['school_year'] ?? '')) . '</td></tr>
        <tr><td class="lbl">Division</td><td>' . $e((string)($form['division'] ?? '')) . '</td>
            <td class="lbl">School Year (Current)</td><td>' . $e((string)($form['current_sy'] ?? '')) . '</td></tr>
        <tr><td class="lbl">Address</td><td>' . $e((string)($form['address'] ?? '')) . '</td>
            <td class="lbl">Submission Type</td><td>' . $e($modeLabel) . '</td></tr>
        <tr><td class="lbl">School ID</td><td>' . $e((string)($form['school_id'] ?? '')) . '</td>
            <td class="lbl">Gov. Recognition No.</td><td>' . $e((string)($form['gov_recog'] ?? '')) . '</td></tr>
        <tr><td class="lbl">Principal</td><td>' . $e((string)($form['principal'] ?? '')) . '</td>
            <td class="lbl">Contact No.</td><td>' . $e((string)($form['principal_contact'] ?? '')) . '</td></tr>
        <tr><td class="lbl">Submitted By</td><td>' . $e((string)($sub['submitted_by'] ?? '')) . '</td>
            <td class="lbl">Date Submitted</td><td>' . $e((string)($sub['date_submitted'] ?? '')) . '</td></tr>
    </table>';

    $levelFlags = [
        'kinder' => (bool)($tuitionDoc['has_kinder'] ?? false),
        'elem'   => (bool)($tuitionDoc['has_elem']   ?? false),
        'jhs'    => (bool)($tuitionDoc['has_jhs']    ?? false),
        'shs'    => (bool)($tuitionDoc['has_shs']    ?? false),
    ];

    $levelSections = '';
    $anyLevel = false;
    foreach ($levelFlags as $levelKey => $enabled) {
        if (!$enabled) {
            continue;
        }
        $anyLevel = true;
        $level = dsBuildTuitionLevelSummary($levelKey, $payload, $mode, $increasePct, $tuitionDoc);

        $rowsHtml = '';
        foreach ($level['rows'] as $row) {
            $rowsHtml .= '<tr>
                <td>' . $e($row['label']) . '</td>
                <td class="num">' . $fmt($row['current']) . '</td>
                <td class="num">' . $fmt($row['proposed']) . '</td>
                <td class="num">' . $fmt($row['increase']) . '</td>
            </tr>';
        }
        if ($rowsHtml === '') {
            $rowsHtml = '<tr><td colspan="4" style="text-align:center;color:#777;">No fees entered for this level.</td></tr>';
        }

        $levelSections .= '
        <div class="tf-level-title">' . $e($level['label']) . '</div>
        <table class="tf-fee-tbl">
            <tr><th style="width:46%;">Fee Item</th><th>Current (₱)</th><th>Proposed (₱)</th><th>Increase (₱)</th></tr>
            ' . $rowsHtml . '
            <tr class="tf-total-row">
                <td>TOTAL</td>
                <td class="num">' . $fmt($level['total_current']) . '</td>
                <td class="num">' . $fmt($level['total_proposed']) . '</td>
                <td class="num">' . $fmt($level['total_increase']) . '</td>
            </tr>
        </table>';
    }

    if (!$anyLevel) {
        $levelSections = '<p style="margin-top:14pt;color:#777;">No grade levels were marked in this submission.</p>';
    }

    $statusLine = '<div class="tf-status">Status: ' . $e((string)($sub['status'] ?? '---'))
        . ($sub['remarks'] ? ' &nbsp;|&nbsp; Remarks: ' . $e((string)$sub['remarks']) : '') . '</div>';

    return '<!DOCTYPE html><html><head><meta charset="utf-8">' . $css . '</head><body>'
        . '<div class="tf-title">Tuition and Other School Fees Submission</div>'
        . '<div class="tf-sub">School Year ' . $e((string)($form['proposed_sy'] ?? $sub['school_year'] ?? '')) . '</div>'
        . $info
        . $levelSections
        . $statusLine
        . '</body></html>';
}

function buildCalendarDocHtml(array $row, array $payload): string
{
    $d = dsExtractCalendarData($row, $payload);
    $e = static fn(string $v): string => dsEscHtml($v);

    $monthNames = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
    $dayNames   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

    $openingDate = $d['openingRaw'] !== '' ? new DateTime($d['openingRaw']) : null;
    $closingDate = $d['closingRaw'] !== '' ? new DateTime($d['closingRaw']) : null;

    $css = '
<style>
  body { font-family: "Times New Roman", Times, serif; font-size: 11pt; color: #111; margin:0; padding:0; }
  .page { page-break-after: always; padding: 18mm 18mm 12mm 18mm; }
  .page:last-child { page-break-after: auto; }
  table { border-collapse: collapse; width:100%; }

  .lh-table { width:100%; border-bottom: 2px solid #1a3a6b; margin-bottom:8pt; }
  .lh-logo  { width:50pt; vertical-align:top; text-align:left; padding-top:0; }
  .lh-logo img { width:42pt; height:42pt; object-fit:contain; }
  .lh-spacer { width:50pt; }
  .lh-text  { vertical-align:top; text-align:center; padding:0 6pt; }
  .lh-school { font-size:14pt; font-weight:bold; color:#1a3a6b; line-height:1.2; }
  .lh-dept   { font-size:9pt; color:#333; font-weight:bold; }

  .cover-center { text-align:center; margin-top:120pt; }
  .cover-big    { font-size:36pt; font-weight:bold; color:#0f2d5a; line-height:1.15; }
  .cover-italic { font-size:26pt; font-style:italic; color:#1a3a6b; margin-top:8pt; }
  .cover-sy     { font-size:22pt; font-style:italic; font-weight:bold; color:#1a3a6b; }

  .addressee { font-size:11pt; font-weight:bold; margin-bottom:2pt; }
  .addr-line  { font-size:11pt; }
  .thru-block { text-align:center; margin:10pt 0 10pt 120pt; }
  .thru-name  { font-size:11pt; font-weight:bold; }
  .salutation { margin-top:10pt; }
  .indent     { text-indent:36pt; }
  .attach-list { margin-left:48pt; }
  .attach-list li { margin-bottom:3pt; }
  .sig-section { margin-top:8pt; }
  .sig-label  { font-size:11pt; margin-bottom:18pt; }
  .sig-name   { font-size:11pt; font-weight:bold; border-top:1px solid #444;
                display:inline-block; padding-top:3pt; min-width:160pt; }
  .sig-title  { font-size:10pt; }

  .tbl-title  { font-size:12pt; font-weight:bold; text-align:center; margin-bottom:8pt; }
  .summary-tbl { width:55%; margin:0 auto; border:1px solid #888; }
  .summary-tbl th { background:#dde4f0; border:1px solid #888; padding:5pt 8pt; text-align:center; font-size:10pt; }
  .summary-tbl td { border:1px solid #888; padding:4pt 8pt; font-size:10pt; }
  .summary-tbl td:last-child { text-align:center; font-weight:bold; }
  .term-header td { background:#c8d8f0; font-weight:bold; text-align:center; font-size:10pt; padding:4pt; }
  .total-row td   { background:#e8f0fb; font-weight:bold; }

  .month-layout { width:100%; }
  .month-left   { width:48%; vertical-align:top; padding-right:8pt;
                  border:1px solid #aaa; padding:6pt; font-size:9.5pt; }
  .month-right  { width:48%; vertical-align:top; padding-left:8pt; }
  .month-header { font-size:11pt; font-weight:bold; text-align:center;
                  background:#dde4f0; border:1px solid #aaa; padding:4pt; margin-bottom:4pt; }
  .date-act-hdr { font-weight:bold; border-bottom:1px solid #aaa; font-size:10pt;
                  padding-bottom:2pt; margin-bottom:4pt; }
  .cal-grid     { width:100%; }
  .cal-grid th  { border:1px solid #bbb; padding:3pt; text-align:center; font-size:8pt;
                  background:#eef2fa; font-weight:bold; }
  .cal-grid td  { border:1px solid #bbb; padding:3pt; text-align:center; font-size:8pt; width:13%; }
  .cal-days-row td { border:none; text-align:right; font-size:8.5pt;
                     padding-top:3pt; font-style:italic; }
  .weekend  { color:#999; }
  .mark-x   { color:#cc0000; font-weight:bold; }
  .mark-sq  { color:#333; font-weight:bold; }
  .mark-tri { color:#7a4f00; font-weight:bold; }
  .mark-start, .mark-end, .mark-start-end {
      color:#fff; font-weight:bold; border-radius:8pt;
  }
  .mark-start     { background:#0a1f3d; }
  .mark-end       { background:#991b1b; }
  .mark-start-end { background:#0a1f3d; }
  .mark-custom    { color:#fff; font-weight:bold; border-radius:8pt; }

  .legend-box { border:1px solid #aaa; padding:6pt 10pt; margin-top:10pt; font-size:8.5pt; }
  .legend-box b { font-size:9pt; }
</style>';

    $lh = function() use ($d, $e): string {
        $logo = $d['logoRaw'] !== ''
            ? '<img src="' . $e($d['logoRaw']) . '" width="48" height="48" alt="logo">'
            : '';

        $deptLine = trim((string)($d['dept'] ?? ''));
        if ($deptLine !== '' && preg_match('/\bdepartment\b/i', $deptLine) !== 1) {
            $deptLine .= ' Department';
        }

        $gov = trim((string)($d['govRecog'] ?? ''));
        if ($gov !== '' && preg_match('/gov\.?\s*recog/i', $gov) !== 1) {
            $gov = 'Gov. Recog. No. ' . $gov;
        }

        $meta = 'School ID: ' . $e((string)($d['sid'] ?? '---'));
        if ($gov !== '') {
            $meta .= '&nbsp;' . $e($gov);
        }

        return '
        <table class="lh-table">
            <tr>
            <td class="lh-logo">' . $logo . '</td>
            <td class="lh-text">
                <div class="lh-school">' . $e($d['school']) . '</div>
                <div class="lh-dept">' . $e($deptLine) . '</div>
                <div class="lh-dept">' . $meta . '</div>
            </td>
            <td class="lh-spacer"></td>
            </tr>
        </table>';
    };

    $sig = function(string $label, string $name, string $title) use ($e): string {
        $lines = array_filter(array_map('trim', preg_split('/\\\\n|\n/', $title) ?: [$title]));
        $titleHtml = implode('<br>', array_map(fn($l) => $e($l), $lines));
        return '
        <div class="sig-section">
          ' . ($label ? '<div class="sig-label">' . $e($label) . '</div>' : '') . '
          <div class="sig-name">' . $e($name) . '</div>
          <div class="sig-title">' . $titleHtml . '</div>
        </div>';
    };

    $attachHtml = '';
    foreach ($d['attachedLines'] as $line) {
        $attachHtml .= '<li>' . $e(trim((string)$line)) . '</li>';
    }

    $thruBlock = '
    <div class="thru-block">
      <div class="thru-name">Thru: ' . $e($d['sdsName']) . '</div>
      <div class="addr-line">' . $e($d['sdsPos']) . '</div>
      <div class="addr-line">' . $e($d['sdsOffice']) . '</div>
      <div class="addr-line">' . $e($d['sdsCity']) . '</div>
    </div>';

    $addressee = '
    <div class="addressee">' . $e($d['rdName']) . '</div>
    <div class="addr-line">' . $e($d['rdPos']) . '</div>
    <div class="addr-line">' . $e($d['rdOffice']) . '</div>';

    $pages = '';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      <div class="cover-center">
        <div class="cover-big">Elementary</div>
        <div class="cover-big">School Calendar</div>
        <div class="cover-italic"><em>S.Y. ' . $e($d['syDash']) . '</em></div>
      </div>
    </div>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      ' . $addressee . '
      ' . $thruBlock . '
      <p class="salutation">Dear Sir/Ma\'am,</p>
      <p>Greetings of peace!</p>
      <p class="indent">I respectfully submit herewith to your good office the pertinent
      documents required in preparation for the Opening of Classes for the School Year
      <strong>' . $e($d['syDash']) . '</strong>.</p>
      <p>The following documents are attached:</p>
      <ul class="attach-list">' . $attachHtml . '</ul>
      <p>Thank you for your kind attention. May the grace of our Lord be upon you always!</p>
      <p>Truly yours,</p>
      <br><br>
      ' . $sig('', $d['principal'], $d['principalTitle']) . '
    </div>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      <div class="cover-center">
        <div style="font-size:42pt; font-style:italic; font-family:\'Times New Roman\',serif; color:#111; margin-top:100pt;">
          Letter of Intent
        </div>
      </div>
    </div>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      ' . $addressee . '
      ' . $thruBlock . '
      <p class="salutation">Dear Sir/Ma\'am,</p>
      <p>Greetings of peace!</p>
      <p class="indent">' . $e($d['loiP1']) . '</p>
      <p class="indent">' . $e($d['loiP2']) . '</p>
      <p>' . $e($d['loiClosing']) . '</p>
      <p>Truly yours,</p>
      <br><br>
      ' . $sig('', $d['principal'], $d['principalTitle']) . '
    </div>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      <div class="cover-center">
        <div style="font-size:38pt; font-style:italic; font-family:\'Times New Roman\',serif; color:#111; margin-top:80pt;">
          School Calendar
        </div>
        <div style="font-size:32pt; font-style:italic; font-family:\'Times New Roman\',serif; color:#111;">
          for
        </div>
        <div style="font-size:34pt; font-style:italic; font-weight:bold; font-family:\'Times New Roman\',serif; color:#111;">
          S.Y. ' . $e($d['syDash']) . '
        </div>
      </div>
    </div>';

    $summaryRows = '';
    foreach ($d['months'] as $m) {
        $summaryRows .= '<tr><td style="padding:4pt 8pt;">' . $e($m['name']) . '</td>'
            . '<td style="text-align:center; font-weight:bold; padding:4pt 8pt;">' . (int)$m['days'] . '</td></tr>';
    }
    $summaryRows .= '<tr class="total-row"><td style="text-align:center; padding:4pt 8pt;"><strong>TOTAL</strong></td>'
        . '<td style="text-align:center; padding:4pt 8pt;">' . $d['totalDays'] . '</td></tr>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      <div class="tbl-title">ELEMENTARY SCHOOL CALENDAR<br>FOR SCHOOL YEAR ' . $e($d['syDash']) . '</div>
      <table class="summary-tbl">
        <thead><tr><th style="width:65%;">MONTH</th><th>SCHOOL DAYS</th></tr></thead>
        <tbody>' . $summaryRows . '</tbody>
      </table>
      <br>
      ' . $sig('Prepared By:', $d['principal'], $d['principalTitle']) . '
      <br>
      ' . $sig('Recommending Approval:', $d['recommending'], $d['recommendingPos'] . "\n" . $d['recommendingOrg']) . '
      <br>
      ' . $sig('Approved:', $d['ardName'], $d['ardPos'] . "\n" . $d['ardOffice']) . '
    </div>';

    /* ── Page 7: School Days per Quarter/Trimester/Semester ──────────────
       Grouping is derived from the department/level (or the school's
       explicit Term Structure override), matching TERM_MAP in
       school-portal-calendar.js instead of a fixed 3-way split. */
    $periodCfg  = dsGetPeriodConfig((string)$d['dept'], $d['periodOverride'] !== '' ? $d['periodOverride'] : null);
    $monthCounts = dsSplitAcadMonths($periodCfg['count']);
    $terms = [];
    $idx = 0;
    foreach ($monthCounts as $pIdx => $numMonths) {
        $label = $periodCfg['label'] . ' ' . ($pIdx + 1);
        $terms[$label] = array_slice($d['months'], $idx, $numMonths);
        $idx += $numMonths;
    }

    $termRows = '';
    foreach ($terms as $label => $tMonths) {
        $tot = array_sum(array_map(fn($m) => (int)$m['days'], $tMonths));
        $termRows .= '<tr class="term-header"><td colspan="2">' . $e($label) . '</td></tr>';
        foreach ($tMonths as $m) {
            $termRows .= '<tr><td style="padding:4pt 8pt;">' . $e($m['name']) . '</td>'
                . '<td style="text-align:center; font-weight:bold; padding:4pt 8pt;">' . (int)$m['days'] . '</td></tr>';
        }
        $termRows .= '<tr class="total-row"><td style="text-align:center; padding:3pt 8pt;"><strong>TOTAL</strong></td>'
            . '<td style="text-align:center; padding:3pt 8pt;"><strong>' . $tot . '</strong></td></tr>';
    }
    $termRows .= '<tr class="total-row"><td style="text-align:center; padding:4pt 8pt;"><strong>TOTAL</strong></td>'
        . '<td style="text-align:center; padding:4pt 8pt;"><strong>' . $d['totalDays'] . '</strong></td></tr>';

    $pages .= '
    <div class="page">
      ' . $lh() . '
      <div class="tbl-title">' . strtoupper($e($d['dept'])) . ' SCHOOL CALENDAR<br>FOR SCHOOL YEAR ' . $e($d['syDash']) . '</div>
      <table class="summary-tbl">
        <thead><tr><th style="width:65%;">MONTH</th><th>SCHOOL DAYS</th></tr></thead>
        <tbody>' . $termRows . '</tbody>
      </table>
      <br>
      ' . $sig('Prepared By:', $d['principal'], $d['principalTitle']) . '
      <br>
      ' . $sig('Recommending Approval:', $d['recommending'], $d['recommendingPos'] . "\n" . $d['recommendingOrg']) . '
      <br>
      ' . $sig('Approved:', $d['ardName'], $d['ardPos'] . "\n" . $d['ardOffice']) . '
    </div>';

    $acadMonthChunks = array_chunk($d['acadMonths'], 2);

    $defaultLegendKeys = ['holiday', 'activity', 'exam'];
    $customLegendHtml = '';
    foreach ($d['legends'] as $legKey => $legVal) {
        if (in_array($legKey, $defaultLegendKeys, true) || !is_array($legVal)) {
            continue;
        }
        $legColor = (string)($legVal['color'] ?? '#64748b');
        $legLabel = (string)($legVal['label'] ?? $legKey);
        $customLegendHtml .= '<span style="display:inline-block;width:8pt;height:8pt;border-radius:8pt;background:'
            . $e($legColor) . ';margin-right:3pt;"></span>&nbsp;- ' . $e($legLabel) . '<br>';
    }

    $legend = '
    <div class="legend-box">
      <b>Legend:</b><br>
      X &nbsp;- Declared Holidays<br>
      &#9633; - School activities for teachers, personnel, and other stakeholders<br>
      &#9651; - Administration of Quarter examination<br>
      <span style="display:inline-block;width:8pt;height:8pt;border-radius:8pt;background:#0a1f3d;margin-right:3pt;"></span>&nbsp;- Start of Classes<br>
      <span style="display:inline-block;width:8pt;height:8pt;border-radius:8pt;background:#991b1b;margin-right:3pt;"></span>&nbsp;- End of Classes<br>
      ' . $customLegendHtml . '
    </div>';

    foreach ($acadMonthChunks as $chunk) {
        $gridHtml = '<div class="tbl-title" style="font-size:11pt; margin-bottom:8pt;">
            SCHOOL CALENDAR FOR SCHOOL YEAR ' . $e($d['syDash']) . '
        </div>';

        $gridHtml .= '
        <table style="width:100%; margin-bottom:6pt; border:1px solid #888;">
          <thead>
            <tr>
              <th style="width:8%; border:1px solid #888; padding:4pt; background:#dde4f0; font-size:9pt;">DATE</th>
              <th style="width:52%; border:1px solid #888; padding:4pt; background:#dde4f0; font-size:9pt;">ACTIVITY</th>
              <th style="width:40%; border:1px solid #888; padding:4pt; background:#dde4f0; font-size:9pt;"></th>
            </tr>
          </thead>
        </table>';

        foreach ($chunk as [$y, $m]) {
            $mName   = $monthNames[$m];
            $daysInM = dsDaysInMonth($y, $m);
            $firstDow = (int)(new DateTime(sprintf('%04d-%02d-01', $y, $m + 1)))->format('w');

            $calRows = '<tr>';
            foreach ($dayNames as $dn) {
                $calRows .= '<th>' . $dn . '</th>';
            }
            $calRows .= '</tr><tr>';

            $col = $firstDow;
            for ($pad = 0; $pad < $firstDow; $pad++) {
                $calRows .= '<td></td>';
            }

            for ($day = 1; $day <= $daysInM; $day++) {
                $dt       = new DateTime(sprintf('%04d-%02d-%02d', $y, $m + 1, $day));
                $dow      = (int)$dt->format('w');
                $key      = $y . '-' . $m . '-' . $day;
                $mark     = $d['savedMarks'][$key] ?? null;
                $isWeekend = ($dow === 0 || $dow === 6);
                $isStartDay = $openingDate && $dt->format('Y-m-d') === $openingDate->format('Y-m-d');
                $isEndDay   = $closingDate && $dt->format('Y-m-d') === $closingDate->format('Y-m-d');
                $cls      = $isWeekend ? ' class="weekend"' : '';
                $symbol   = '';

                if ($isStartDay && $isEndDay) {
                    $symbol = ' &#9733;'; $cls = ' class="mark-start-end"';
                } elseif ($isStartDay) {
                    $symbol = ' &#9733;'; $cls = ' class="mark-start"';
                } elseif ($isEndDay) {
                    $symbol = ' &#9632;'; $cls = ' class="mark-end"';
                } elseif ($mark) {
                    $mt = strtolower((string)$mark);
                    if ($mt === 'holiday')  { $symbol = 'x'; $cls = ' class="mark-x"'; }
                    elseif ($mt === 'activity') { $symbol = '&#9633;'; $cls = ' class="mark-sq"'; }
                    elseif ($mt === 'exam') { $symbol = '&#9651;'; $cls = ' class="mark-tri"'; }
                    else {
                        /* Custom user-created legend category — color the
                           day cell with its own swatch, matching the
                           builder's custom-mark-pill design. */
                        $legVal = $d['legends'][$mark] ?? null;
                        $legColor = is_array($legVal) ? (string)($legVal['color'] ?? '#64748b') : '#64748b';
                        $cls = ' class="mark-custom" style="background:' . $e($legColor) . ';"';
                        $symbol = '';
                    }
                }

                $calRows .= '<td' . $cls . '>' . $day . $symbol . '</td>';
                $col++;
                if ($col % 7 === 0 && $day < $daysInM) {
                    $calRows .= '</tr><tr>';
                }
            }
            $rem = (7 - ($col % 7)) % 7;
            for ($r = 0; $r < $rem; $r++) { $calRows .= '<td></td>'; }
            $calRows .= '</tr>';

            $schoolDays = 0;
            foreach ($d['months'] as $mm) {
                if ($mm['name'] === $mName) { $schoolDays = (int)$mm['days']; break; }
            }

            $gridHtml .= '
            <table style="width:100%; border:1px solid #888; margin-bottom:6pt;">
              <tr>
                <td style="width:55%; vertical-align:top; border-right:1px solid #888; padding:0;">
                  <div class="month-header">' . strtoupper($mName) . '</div>
                  <div style="padding:6pt; font-size:9pt; min-height:60pt; color:#555;">
                    (Activities listed in school calendar)
                  </div>
                </td>
                <td style="width:45%; vertical-align:top; padding:4pt 6pt;">
                  <div style="font-size:9pt; font-weight:bold; text-align:center; margin-bottom:4pt;">' . $mName . '</div>
                  <table class="cal-grid">
                    ' . $calRows . '
                    <tr class="cal-days-row"><td colspan="7">Class days: <strong>' . $schoolDays . '</strong></td></tr>
                  </table>
                </td>
              </tr>
            </table>';
        }

        $gridHtml .= $legend;

        $pages .= '<div class="page">' . $gridHtml . '</div>';
    }

    return '<!DOCTYPE html><html><head><meta charset="utf-8">' . $css . '</head><body>' . $pages . '</body></html>';
}
