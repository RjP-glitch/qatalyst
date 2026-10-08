<?php
/**
 * /api/school-portal-permit.php
 *
 * Dedicated School Permit (DECS Form No. GPR-3) submission endpoint.
 *
 * A single permit "application" can be made up of MULTIPLE files (e.g. one
 * PDF per requirement) OR a single combined file (the whole package merged
 * into one PDF/Word document). Every uploaded file is stored as its own row
 * in `school_submissions` (type = 'permit'), and all files that belong to
 * the same application share a `permit_batch_id` recorded in history_json so
 * they can be grouped back together as one "submission" in the UI.
 *
 * Routing:
 *   GET  (no action)         — list this user's permit applications, grouped by batch
 *   POST ?action=upload      — upload one application (1+ files) as a new batch
 *   POST ?action=edit        — edit application details, and/or add/replace files in a batch
 *   POST ?action=delete_file — delete a single file from a batch
 *   POST ?action=delete      — delete an entire application (all files in a batch)
 *
 * All actions require an authenticated portal_user session.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

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

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ---- Helpers -----------------------------------------------------------------

function jsonSuccess($data = [], $msg = 'Success', $code = 200): void {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError($msg, $code = 400): void {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

function normalizePermitStatus(?string $status): string {
    $value = strtolower(trim((string)$status));
    $map = [
        'pending review'          => 'pending',
        'under review'            => 'review',
        'returned for correction' => 'returned',
    ];
    return $map[$value] ?? $value;
}

const MAX_FILES_PER_BATCH = 20;
const MAX_FILE_BYTES      = 10 * 1024 * 1024; // 10MB per file
// Documents (Board Resolution, statements, TCT, etc.) plus images — some GPR-3
// requirements (e.g. "Pictures of classrooms, labs, library...") are photos,
// not documents, so both families need to be accepted here.
const ALLOWED_EXTENSIONS  = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];

// ---- Auth (shared by all actions) -------------------------------------------

try {
    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) jsonError('Unauthorized. Please sign in.', 401);

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType === 'sdo_personnel') {
        jsonError('Access denied. SDO personnel accounts use the main system dashboard.', 403);
    }
    if ($accountType !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $userId = (int)$user['id'];
    $method = $_SERVER['REQUEST_METHOD'];
    $action = strtolower(trim($_GET['action'] ?? ''));

    // ---- Route ---------------------------------------------------------------

    if ($method === 'GET' && $action === '') {
        handlePermitList($user, $userId);
    } elseif ($method === 'POST' && $action === 'upload') {
        handlePermitUpload($user, $userId);
    } elseif ($method === 'POST' && $action === 'edit') {
        handlePermitEdit($user, $userId);
    } elseif ($method === 'POST' && $action === 'delete_file') {
        handlePermitDeleteFile($user, $userId);
    } elseif ($method === 'POST' && $action === 'delete') {
        handlePermitDeleteBatch($user, $userId);
    } else {
        jsonError('Method or action not allowed.', 405);
    }

} catch (Throwable $e) {
    error_log(sprintf('school-portal-permit.php [line %d]: %s', $e->getLine(), $e->getMessage()));
    jsonError('Server error. Please try again.', 500);
}

// ---- Shared: GPR-3 checklist definition ---------------------------------------
//
// The checklist requirements now live in the `permit_checklist_items` table
// (see migrations/permit_checklist_items.sql) so SDO admins can add, edit,
// reorder, or retire requirements without a code deploy. gpr3ChecklistDefinition()
// reads from that table; gpr3ChecklistDefinitionFallback() is the old hardcoded
// copy, kept only as a safety net in case the table is missing/empty (e.g. the
// migration hasn't been run yet) so the checklist step never breaks.

function gpr3ChecklistDefinition(PDO $db): array {
    try {
        $stmt = $db->query("
            SELECT section_name, section_order, always_required, app_types,
                   item_key, label, item_order
            FROM permit_checklist_items
            WHERE is_active = 1
            ORDER BY section_order ASC, item_order ASC, id ASC
        ");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('gpr3ChecklistDefinition: falling back to hardcoded checklist — ' . $e->getMessage());
        $rows = [];
    }

    if (!$rows) {
        return gpr3ChecklistDefinitionFallback();
    }

    $sections = [];
    foreach ($rows as $row) {
        $sectionName = (string)$row['section_name'];
        if (!isset($sections[$sectionName])) {
            $always = (bool)$row['always_required'];
            $appTypes = array_values(array_filter(array_map('trim', explode(',', (string)($row['app_types'] ?? '')))));
            $sections[$sectionName] = [
                'section' => $sectionName,
                'order'   => (int)$row['section_order'],
                'always'  => $always,
                'items'   => [],
            ];
            if (!$always) $sections[$sectionName]['appTypes'] = $appTypes;
        }
        $sections[$sectionName]['items'][] = [
            'id'    => $row['item_key'],
            'label' => $row['label'],
        ];
    }

    $result = array_values($sections);
    usort($result, fn($a, $b) => $a['order'] <=> $b['order']);
    foreach ($result as &$section) unset($section['order']);
    return $result;
}

function gpr3ChecklistDefinitionFallback(): array {
    return [
        [
            'section' => 'For All Applicants',
            'always'  => true,
            'items'   => [
                ['id' => 'board_resolution',      'label' => 'Board Resolution — certified by the Corporate Secretary'],
                ['id' => 'stmt_philosophy',       'label' => 'Statement of Philosophy and Goals of the course'],
                ['id' => 'stmt_demand',           'label' => 'Statement on demand for graduates'],
                ['id' => 'stmt_students',         'label' => 'Statement on prospective students'],
                ['id' => 'stmt_existing_schools', 'label' => 'Statement on existing schools offering the same course within the province/city'],
                ['id' => 'admin_list',            'label' => 'List of school administrators — educationally qualified, full-time, salaries per standard'],
                ['id' => 'non_teaching_list',     'label' => 'List of academic non-teaching personnel — qualified with valid contracts'],
                ['id' => 'athletics_list',        'label' => 'List of athletic facilities, equipment, supplies and materials'],
                ['id' => 'school_bond',           'label' => 'School Bond documents properly submitted'],
                ['id' => 'proposed_budget',       'label' => 'Proposed budget for the succeeding school year — approved by Board'],
            ],
        ],
        [
            'section'  => 'For New Schools or Schools with Recent Changes',
            'always'   => false,
            'appTypes' => ['new_school', 'recognition'],
            'items'    => [
                ['id' => 'articles_of_inc',   'label' => "Articles of Incorporation & By-Laws — in school's name, SEC-registered"],
                ['id' => 'tct',                'label' => "Transfer Certificate of Title (TCT) — in school's name, total area adequate"],
                ['id' => 'lease_or_affidavit', 'label' => 'Contract of Lease or Affidavit of Ownership'],
                ['id' => 'location_desc',      'label' => 'Location description — far from noise, unpleasant odor, and dust'],
                ['id' => 'campus_plan',        'label' => 'Campus development & landscaping plans'],
                ['id' => 'building_ownership', 'label' => "Document(s) of Ownership of school building(s)"],
                ['id' => 'cert_occupancy',     'label' => 'Certificate of Occupancy — signed by proper city/municipal authorities'],
                ['id' => 'school_pictures',    'label' => 'Pictures of classrooms, labs, library, medical/dental, canteen'],
            ],
        ],
        [
            'section'  => 'For New Courses / Programs',
            'always'   => false,
            'appTypes' => ['new_course'],
            'items'    => [
                ['id' => 'retirement_plan',     'label' => 'Copy of Retirement Plan — registered with the SEC'],
                ['id' => 'financial_statement', 'label' => 'Latest Financial Statement — certified by independent CPA'],
                ['id' => 'proposed_curriculum', 'label' => 'Proposed Curriculum — per DepEd standards, approved by DepEd'],
                ['id' => 'tuition_fees',        'label' => 'Proposed tuition and other school fees — approved per DepEd guidelines'],
                ['id' => 'new_teaching_staff',  'label' => 'List of new teaching/academic staff — qualified, valid contracts'],
                ['id' => 'lab_facilities',      'label' => 'List of laboratory facilities, equipment, furniture, supplies'],
                ['id' => 'library_holdings',    'label' => 'List of library holdings — certified by school head'],
                ['id' => 'inspection_fee',      'label' => 'Inspection and Application Fees paid'],
            ],
        ],
    ];
}

// ---- Action: LIST -------------------------------------------------------------

/**
 * GET /api/school-portal-permit.php
 *
 * Returns this user's permit applications. Each application is one or more
 * files that share a permit_batch_id, grouped into a single object so the
 * frontend can render "1 application = 1 card" even when it has many files.
 */
function handlePermitList(array $user, int $userId): void {
    $db = getDB();

    $schoolType      = strtolower(trim((string)($user['school_type'] ?? '')));
    $isPrivate       = str_contains($schoolType, 'private');
    $privateSchoolId = ((int)($user['private_school_id'] ?? 0) ?: null);
    $publicSchoolId  = ((int)($user['school_id'] ?? 0) ?: null);

    if (!$privateSchoolId && !$publicSchoolId) {
        jsonError('No school linked to your account. Please contact your administrator.', 403);
    }

    $schoolScopeSQL    = '';
    $schoolScopeParams = [];
    if ($isPrivate && $privateSchoolId) {
        $schoolScopeSQL = 'private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } elseif (!$isPrivate && $publicSchoolId) {
        $schoolScopeSQL = 'school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId && $publicSchoolId) {
        $schoolScopeSQL = '(private_school_id = :private_school_id OR school_id = :school_id)';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId) {
        $schoolScopeSQL = 'private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } else {
        $schoolScopeSQL = 'school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    }

    $search = trim($_GET['search'] ?? '');
    $where  = ["type = 'permit'", $schoolScopeSQL];
    $params = $schoolScopeParams;

    if ($search !== '') {
        $where[]           = '(title LIKE :search OR file_name LIKE :search)';
        $params[':search'] = '%' . $search . '%';
    }

    $whereSQL = implode(' AND ', $where);

    $stmt = $db->prepare("
        SELECT id, title, file_name, file_path, file_size, status, remarks,
               indorsement_count, submitted_at, updated_at, school_year,
               document_type, history_json
        FROM school_submissions
        WHERE {$whereSQL}
        ORDER BY submitted_at DESC
        LIMIT 500
    ");
    foreach ($params as $key => $val) { $stmt->bindValue($key, $val); }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Group rows by permit_batch_id (fall back to a per-row pseudo-batch for
    // legacy rows uploaded before batching existed, so nothing is lost).
    $batches = [];
    foreach ($rows as $row) {
        $meta = [];
        if (!empty($row['history_json'])) {
            $decoded = json_decode((string)$row['history_json'], true);
            $meta = extractGpr3Meta($decoded);
        }
        $batchId = trim((string)($meta['permit_batch_id'] ?? ''));
        if ($batchId === '') $batchId = 'legacy-' . $row['id'];

        if (!isset($batches[$batchId])) {
            $batches[$batchId] = [
                'batch_id'        => $batchId,
                'school_name'     => $meta['school_name']     ?? '',
                'address'         => $meta['address']         ?? '',
                'course'          => $meta['course']          ?? '',
                'curriculum_year' => $meta['curriculum_year'] ?? '',
                'app_type'        => $meta['app_type']         ?? '',
                'app_type_label'  => $meta['app_type_label']   ?? ($row['document_type'] ?? ''),
                'gov_authority'   => $meta['gov_authority']    ?? '',
                'school_year'     => $row['school_year']       ?? ($meta['school_year'] ?? ''),
                'checklist'       => is_array($meta['checklist'] ?? null) ? $meta['checklist'] : [],
                'submission_mode' => $meta['submission_mode']  ?? (count($rows) > 1 ? 'multiple' : 'single'),
                'status'          => normalizePermitStatus($row['status'] ?? ''),
                'remarks'         => $row['remarks'] ?? '',
                'submitted_at'    => $row['submitted_at'],
                'updated_at'      => $row['updated_at'],
                'files'           => [],
            ];
        }

        // A batch is only as "done" as its least-resolved file; surface the
        // most actionable status (returned/review > pending > approved).
        $rank = ['returned' => 3, 'rejected' => 3, 'review' => 2, 'pending' => 1, 'approved' => 0, 'endorsed' => 0];
        $curStatus = normalizePermitStatus($row['status'] ?? '');
        $curRank   = $rank[$curStatus] ?? 1;
        $bestRank  = $rank[$batches[$batchId]['status']] ?? 1;
        if ($curRank > $bestRank) {
            $batches[$batchId]['status']  = $curStatus;
            $batches[$batchId]['remarks'] = $row['remarks'] ?? '';
        }
        if (strtotime((string)$row['submitted_at']) > strtotime((string)$batches[$batchId]['submitted_at'])) {
            $batches[$batchId]['submitted_at'] = $row['submitted_at'];
        }

        $batches[$batchId]['files'][] = [
            'id'                => (int)$row['id'],
            'file_name'         => $row['file_name'],
            'file_path'         => $row['file_path'],
            'file_size'         => (int)$row['file_size'],
            'status'            => $curStatus,
            'remarks'           => $row['remarks'] ?? '',
            'indorsement_count' => (int)$row['indorsement_count'],
            'submitted_at'      => $row['submitted_at'],
            'requirement_label' => $meta['file_label'] ?? '',
        ];
    }

    $applications = array_values($batches);
    usort($applications, fn($a, $b) => strtotime((string)$b['submitted_at']) <=> strtotime((string)$a['submitted_at']));

    jsonSuccess([
        'applications' => $applications,
        'checklist_definition' => gpr3ChecklistDefinition($db),
    ]);
}

// ---- Shared upload validation ------------------------------------------------

function validatePermitFile(array $file): string {
    if ((int)$file['error'] !== UPLOAD_ERR_OK) {
        $uploadErrors = [
            UPLOAD_ERR_INI_SIZE   => 'A file exceeds the server upload limit.',
            UPLOAD_ERR_FORM_SIZE  => 'A file exceeds the form size limit.',
            UPLOAD_ERR_PARTIAL    => 'A file was only partially uploaded.',
            UPLOAD_ERR_NO_FILE    => 'No file uploaded.',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary upload folder.',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write an uploaded file.',
            UPLOAD_ERR_EXTENSION  => 'Upload blocked by server extension.',
        ];
        jsonError($uploadErrors[(int)$file['error']] ?? 'Upload failed.', 400);
    }

    $fileSize = (int)($file['size'] ?? 0);
    if ($fileSize <= 0)               jsonError("File \"{$file['name']}\" appears to be empty.", 400);
    if ($fileSize > MAX_FILE_BYTES)   jsonError("File \"{$file['name']}\" is too large. Maximum size is 10MB per file.", 413);

    $originalName = sanitizeFilename((string)($file['name'] ?? ''));
    if ($originalName === '') jsonError('Invalid filename.', 400);

    if (!isAllowedFileExtension($originalName, ALLOWED_EXTENSIONS)) {
        jsonError("File \"{$originalName}\" is not an allowed type. Only PDF, DOC, DOCX, JPG, and PNG are accepted.", 422);
    }
    if (!validateFileMimeType((string)$file['tmp_name'], $originalName)) {
        jsonError("File \"{$originalName}\" content does not match its extension.", 422);
    }

    return $originalName;
}

function storePermitFile(array $file, string $originalName, int $userId): array {
    $basePath  = dirname(__DIR__);
    $uploadDir = $basePath . '/api/uploads/school_submissions/' . $userId;
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
        jsonError('Could not initialize upload directory.', 500);
    }

    $ext        = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    $storedName = sprintf('permit_%d_%s.%s', time(), bin2hex(random_bytes(8)), $ext);
    $absPath    = $uploadDir . '/' . $storedName;

    if (!move_uploaded_file((string)$file['tmp_name'], $absPath)) {
        jsonError("Failed to store file \"{$originalName}\".", 500);
    }

    return [
        'relative_path' => 'api/uploads/school_submissions/' . $userId . '/' . $storedName,
        'size'          => (int)$file['size'],
    ];
}

// ---- Action: UPLOAD -----------------------------------------------------------

/**
 * POST /api/school-portal-permit.php?action=upload
 *
 * Accepts EITHER:
 *   - files[]        — multiple files, one per requirement / document (multipart array)
 *   - file            — a single combined file (whole package merged)
 * Plus:
 *   - permit_meta     — JSON: school info + checklist + app type
 *   - school_year     — string
 *   - file_labels     — optional JSON array of labels matching files[] order
 *
 * Every file becomes its own school_submissions row (type=permit), all sharing
 * a freshly generated permit_batch_id so they're grouped as one application.
 */
function handlePermitUpload(array $user, int $userId): void {
    $submitterName = trim((string)($user['full_name'] ?? $user['email'] ?? 'School'));

    $files = [];
    if (!empty($_FILES['files']) && is_array($_FILES['files']['name'] ?? null)) {
        $count = count($_FILES['files']['name']);
        if ($count > MAX_FILES_PER_BATCH) {
            jsonError('Too many files. Maximum is ' . MAX_FILES_PER_BATCH . ' files per application.', 413);
        }
        for ($i = 0; $i < $count; $i++) {
            if ((int)$_FILES['files']['error'][$i] === UPLOAD_ERR_NO_FILE) continue;
            $files[] = [
                'name'     => $_FILES['files']['name'][$i],
                'type'     => $_FILES['files']['type'][$i],
                'tmp_name' => $_FILES['files']['tmp_name'][$i],
                'error'    => $_FILES['files']['error'][$i],
                'size'     => $_FILES['files']['size'][$i],
            ];
        }
    } elseif (!empty($_FILES['file']) && isset($_FILES['file']['error'])) {
        $files[] = $_FILES['file'];
    }

    if (empty($files)) jsonError('No file(s) uploaded.', 400);

    $permitMetaRaw = trim($_POST['permit_meta'] ?? '');
    if ($permitMetaRaw === '') jsonError('Application details are required.', 422);
    $permitMeta = json_decode($permitMetaRaw, true);
    if (!is_array($permitMeta)) jsonError('Invalid application details.', 422);

    $schoolName = trim((string)($permitMeta['school_name'] ?? ''));
    $appType    = trim((string)($permitMeta['app_type'] ?? ''));
    $schoolYear = trim($_POST['school_year'] ?? '');
    if ($schoolName === '') jsonError('School name is required.', 422);
    if ($appType === '')    jsonError('Application type is required.', 422);
    if ($schoolYear === '') jsonError('School year is required.', 422);

    $fileLabelsRaw = trim($_POST['file_labels'] ?? '');
    $fileLabels    = [];
    if ($fileLabelsRaw !== '') {
        $decodedLabels = json_decode($fileLabelsRaw, true);
        if (is_array($decodedLabels)) $fileLabels = $decodedLabels;
    }

    // Validate every file BEFORE storing any of them (all-or-nothing).
    $originalNames = [];
    foreach ($files as $i => $f) {
        $originalNames[$i] = validatePermitFile($f);
    }

    $districtId      = !empty($user['district_id']) ? (int)$user['district_id'] : null;
    $schoolTypeRaw   = $user['school_type'] ?? null;
    $isPrivate       = str_contains(strtolower((string)($schoolTypeRaw ?? '')), 'private');
    $schoolId        = $isPrivate ? null : ((int)($user['school_id'] ?? 0) ?: null);
    $privateSchoolId = $isPrivate ? ((int)($user['private_school_id'] ?? 0) ?: null) : null;

    $appLabel  = trim((string)($permitMeta['app_type_label'] ?? ''));
    $batchId   = bin2hex(random_bytes(12));
    $submittedAt = date('Y-m-d H:i:s');
    $title     = 'School Permit — ' . $schoolName . ($schoolYear ? ' (' . $schoolYear . ')' : '');
    $mode      = count($files) > 1 ? 'multiple' : 'single';

    $pdo = getDB();
    $pdo->beginTransaction();
    $insertedIds = [];

    try {
        foreach ($files as $i => $f) {
            $stored = storePermitFile($f, $originalNames[$i], $userId);

            $historyJson = buildGpr3HistoryJson([
                'submitted_at'     => $submittedAt,
                'permit_batch_id'  => $batchId,
                'submission_mode'  => $mode,
                'file_label'       => trim((string)($fileLabels[$i] ?? '')),
                'school_name'      => $schoolName,
                'address'          => $permitMeta['address']         ?? '',
                'course'           => $permitMeta['course']          ?? '',
                'curriculum_year'  => $permitMeta['curriculum_year'] ?? '',
                'app_type'         => $appType,
                'app_type_label'   => $appLabel,
                'gov_authority'    => $permitMeta['gov_authority']   ?? '',
                'school_year'      => $schoolYear,
                'checklist'        => $permitMeta['checklist']       ?? [],
            ], $submittedAt, $submitterName);

            $stmt = $pdo->prepare("
                INSERT INTO school_submissions
                    (user_id, school_id, private_school_id, district_id, type, title, file_name, file_path, file_size,
                     document_type, school_year, history_json, status, submitted_at)
                VALUES
                    (:user_id, :school_id, :private_school_id, :district_id, 'permit', :title, :file_name, :file_path, :file_size,
                     :document_type, :school_year, :history_json, 'pending', :submitted_at)
            ");
            $stmt->execute([
                ':user_id'           => $userId,
                ':school_id'         => $schoolId,
                ':private_school_id' => $privateSchoolId,
                ':district_id'       => $districtId,
                ':title'             => $title,
                ':file_name'         => $originalNames[$i],
                ':file_path'         => $stored['relative_path'],
                ':file_size'         => $stored['size'],
                ':document_type'     => $appLabel ?: null,
                ':school_year'       => $schoolYear,
                ':history_json'      => $historyJson,
                ':submitted_at'      => $submittedAt,
            ]);
            $insertedIds[] = (int)$pdo->lastInsertId();
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('school-portal-permit.php upload failed: ' . $e->getMessage());
        jsonError('Failed to save the application. Please try again.', 500);
    }

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_upload',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => "School Permit application submitted | batch={$batchId} | files=" . count($files) . ' | mode=' . $mode,
        'document_type' => 'School Permit',
        'file_name'     => implode(', ', $originalNames),
    ]);

    jsonSuccess([
        'batch_id'       => $batchId,
        'submission_ids' => $insertedIds,
        'file_count'     => count($files),
    ], 'School Permit application submitted successfully.');
}

// ---- Shared: history_json helpers ---------------------------------------------

/**
 * Reads the gpr3_submission metadata out of a decoded history_json value,
 * regardless of shape:
 *   - legacy shape:  {"gpr3_submission": {...}}                (plain object)
 *   - current shape: [{"event":"submitted","gpr3_submission":{...}}, ...]  (array)
 * Always returns an array (possibly empty).
 */
function extractGpr3Meta($decoded): array {
    if (!is_array($decoded)) return [];
    if (isset($decoded['gpr3_submission']) && is_array($decoded['gpr3_submission'])) {
        return $decoded['gpr3_submission'];
    }
    foreach ($decoded as $entry) {
        if (is_array($entry) && isset($entry['gpr3_submission']) && is_array($entry['gpr3_submission'])) {
            return $entry['gpr3_submission'];
        }
    }
    return [];
}

/**
 * Builds the history_json array for a brand-new permit submission row.
 * Always an array of event entries (never a bare object) — this is what
 * lets documents-submitted.php's actionUpdate() safely append status_update
 * entries later with `$history[] = [...]` without turning the JSON into a
 * mixed-key object (which the front-end's Array.isArray() check would then
 * silently treat as empty history).
 */
function buildGpr3HistoryJson(array $meta, string $submittedAt, string $by): string {
    $entries = [[
        'event'           => 'submitted',
        'created_at'      => $submittedAt,
        'by'              => $by,
        'gpr3_submission' => $meta,
    ]];
    return json_encode($entries, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * Updates the gpr3_submission metadata inside an existing history_json value
 * while preserving every other entry already in it (e.g. status_update events
 * appended later by an admin) and normalising legacy object-shaped history
 * into the array shape going forward.
 */
function updateGpr3HistoryJson(?string $existingHistoryJson, array $newMeta, string $fallbackSubmittedAt, string $fallbackBy): string {
    $existing = [];
    if ($existingHistoryJson) {
        $decoded = json_decode($existingHistoryJson, true);
        if (is_array($decoded)) $existing = $decoded;
    }

    // Normalise legacy object shape ({"gpr3_submission": {...}}) into an array first.
    if (isset($existing['gpr3_submission']) && is_array($existing['gpr3_submission'])) {
        $existing = [[
            'event'           => 'submitted',
            'created_at'      => $existing['gpr3_submission']['submitted_at'] ?? $fallbackSubmittedAt,
            'by'              => $fallbackBy,
            'gpr3_submission' => $existing['gpr3_submission'],
        ]];
    }

    // Guard against any other unexpected shape (e.g. malformed JSON) — start fresh.
    if (!is_array($existing) || array_keys($existing) !== range(0, count($existing) - 1)) {
        $existing = [];
    }

    $found = false;
    foreach ($existing as &$entry) {
        if (is_array($entry) && isset($entry['gpr3_submission'])) {
            $entry['gpr3_submission'] = $newMeta;
            $found = true;
            break;
        }
    }
    unset($entry);

    if (!$found) {
        array_unshift($existing, [
            'event'           => 'submitted',
            'created_at'      => $newMeta['submitted_at'] ?? $fallbackSubmittedAt,
            'by'              => $fallbackBy,
            'gpr3_submission' => $newMeta,
        ]);
    }

    return json_encode($existing, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

// ---- Shared: fetch + ownership-check a batch ----------------------------------

function fetchPermitBatch(PDO $pdo, int $userId, string $batchId): array {
    $stmt = $pdo->prepare("SELECT * FROM school_submissions WHERE type = 'permit' AND user_id = :uid");
    $stmt->execute([':uid' => $userId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $matched = [];
    foreach ($rows as $row) {
        $meta = [];
        if (!empty($row['history_json'])) {
            $decoded = json_decode((string)$row['history_json'], true);
            $meta = extractGpr3Meta($decoded);
        }
        $rowBatch = trim((string)($meta['permit_batch_id'] ?? ''));
        if ($rowBatch === '') $rowBatch = 'legacy-' . $row['id'];
        if ($rowBatch === $batchId) $matched[] = $row;
    }
    return $matched;
}

// ---- Action: EDIT --------------------------------------------------------------

/**
 * POST /api/school-portal-permit.php?action=edit
 *
 * Edits the shared application details (school info / checklist) across every
 * file in the batch, and optionally adds new files or replaces one existing
 * file (by submission id). Only allowed while every file in the batch is
 * still pending or under review.
 */
function handlePermitEdit(array $user, int $userId): void {
    $submitterName = trim((string)($user['full_name'] ?? $user['email'] ?? 'School'));

    $batchId = trim($_POST['batch_id'] ?? '');
    if ($batchId === '') jsonError('Missing application reference.', 400);

    $pdo  = getDB();
    $rows = fetchPermitBatch($pdo, $userId, $batchId);
    if (empty($rows)) jsonError('Application not found.', 404);

    foreach ($rows as $row) {
        $status = strtolower(trim($row['status'] ?? ''));
        if (!in_array($status, ['pending', 'pending review', 'review', 'under review', 'returned', 'returned for correction'], true)) {
            jsonError('This application can no longer be edited because it has already been processed.', 403);
        }
    }

    $permitMetaRaw = trim($_POST['permit_meta'] ?? '');
    $schoolYear    = trim($_POST['school_year'] ?? '');

    if ($permitMetaRaw === '') jsonError('Application details are required.', 422);
    $permitMeta = json_decode($permitMetaRaw, true);
    if (!is_array($permitMeta)) jsonError('Invalid application details.', 422);

    $schoolName = trim((string)($permitMeta['school_name'] ?? ''));
    $appType    = trim((string)($permitMeta['app_type'] ?? ''));
    if ($schoolName === '') jsonError('School name is required.', 422);
    if ($appType === '')    jsonError('Application type is required.', 422);
    if ($schoolYear === '') jsonError('School year is required.', 422);

    $appLabel = trim((string)($permitMeta['app_type_label'] ?? ''));
    $title    = 'School Permit — ' . $schoolName . ($schoolYear ? ' (' . $schoolYear . ')' : '');

    // Resubmitting a returned application sends it back to pending so the
    // SDO sees it as awaiting review again, rather than leaving it stuck
    // showing "Returned" even after the requested correction was made.
    $wasReturned = false;
    foreach ($rows as $row) {
        if (in_array(strtolower(trim($row['status'] ?? '')), ['returned', 'returned for correction'], true)) { $wasReturned = true; break; }
    }

    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $existingMeta = extractGpr3Meta(json_decode((string)($row['history_json'] ?? ''), true));

            $existingMeta['school_name']     = $schoolName;
            $existingMeta['address']         = $permitMeta['address']         ?? '';
            $existingMeta['course']          = $permitMeta['course']          ?? '';
            $existingMeta['curriculum_year'] = $permitMeta['curriculum_year'] ?? '';
            $existingMeta['app_type']        = $appType;
            $existingMeta['app_type_label']  = $appLabel;
            $existingMeta['gov_authority']   = $permitMeta['gov_authority']   ?? '';
            $existingMeta['school_year']     = $schoolYear;
            $existingMeta['checklist']       = $permitMeta['checklist']       ?? [];

            $updatedHistoryJson = updateGpr3HistoryJson(
                $row['history_json'] ?? null,
                $existingMeta,
                $row['submitted_at'] ?? date('Y-m-d H:i:s'),
                $submitterName
            );

            if ($wasReturned) {
                $pdo->prepare("
                    UPDATE school_submissions
                    SET title = :title, school_year = :school_year, document_type = :document_type,
                        history_json = :history_json, status = 'pending', remarks = NULL, updated_at = NOW()
                    WHERE id = :id AND user_id = :uid
                ")->execute([
                    ':title'         => $title,
                    ':school_year'   => $schoolYear,
                    ':document_type' => $appLabel ?: null,
                    ':history_json'  => $updatedHistoryJson,
                    ':id'            => $row['id'],
                    ':uid'           => $userId,
                ]);
            } else {
                $pdo->prepare("
                    UPDATE school_submissions
                    SET title = :title, school_year = :school_year, document_type = :document_type,
                        history_json = :history_json, updated_at = NOW()
                    WHERE id = :id AND user_id = :uid
                ")->execute([
                    ':title'         => $title,
                    ':school_year'   => $schoolYear,
                    ':document_type' => $appLabel ?: null,
                    ':history_json'  => $updatedHistoryJson,
                    ':id'            => $row['id'],
                    ':uid'           => $userId,
                ]);
            }
        }

        // Optionally add brand-new files to this batch (files[] only — replacing
        // a single existing file is handled by uploading a new one + delete_file).
        if (!empty($_FILES['files']) && is_array($_FILES['files']['name'] ?? null)) {
            $count = count($_FILES['files']['name']);
            $fileLabelsRaw = trim($_POST['file_labels'] ?? '');
            $fileLabels    = [];
            if ($fileLabelsRaw !== '') {
                $decodedLabels = json_decode($fileLabelsRaw, true);
                if (is_array($decodedLabels)) $fileLabels = $decodedLabels;
            }

            $districtId      = !empty($user['district_id']) ? (int)$user['district_id'] : null;
            $schoolTypeRaw   = $user['school_type'] ?? null;
            $isPrivate       = str_contains(strtolower((string)($schoolTypeRaw ?? '')), 'private');
            $schoolId        = $isPrivate ? null : ((int)($user['school_id'] ?? 0) ?: null);
            $privateSchoolId = $isPrivate ? ((int)($user['private_school_id'] ?? 0) ?: null) : null;
            $submittedAt     = date('Y-m-d H:i:s');

            for ($i = 0; $i < $count; $i++) {
                if ((int)$_FILES['files']['error'][$i] === UPLOAD_ERR_NO_FILE) continue;
                $f = [
                    'name'     => $_FILES['files']['name'][$i],
                    'type'     => $_FILES['files']['type'][$i],
                    'tmp_name' => $_FILES['files']['tmp_name'][$i],
                    'error'    => $_FILES['files']['error'][$i],
                    'size'     => $_FILES['files']['size'][$i],
                ];
                $originalName = validatePermitFile($f);
                $stored = storePermitFile($f, $originalName, $userId);

                $historyJson = buildGpr3HistoryJson([
                    'submitted_at'    => $submittedAt,
                    'permit_batch_id' => $batchId,
                    'submission_mode' => 'multiple',
                    'file_label'      => trim((string)($fileLabels[$i] ?? '')),
                    'school_name'     => $schoolName,
                    'address'         => $permitMeta['address']         ?? '',
                    'course'          => $permitMeta['course']          ?? '',
                    'curriculum_year' => $permitMeta['curriculum_year'] ?? '',
                    'app_type'        => $appType,
                    'app_type_label'  => $appLabel,
                    'gov_authority'   => $permitMeta['gov_authority']   ?? '',
                    'school_year'     => $schoolYear,
                    'checklist'       => $permitMeta['checklist']       ?? [],
                ], $submittedAt, $submitterName);

                $pdo->prepare("
                    INSERT INTO school_submissions
                        (user_id, school_id, private_school_id, district_id, type, title, file_name, file_path, file_size,
                         document_type, school_year, history_json, status, submitted_at)
                    VALUES
                        (:user_id, :school_id, :private_school_id, :district_id, 'permit', :title, :file_name, :file_path, :file_size,
                         :document_type, :school_year, :history_json, 'pending', :submitted_at)
                ")->execute([
                    ':user_id'           => $userId,
                    ':school_id'         => $schoolId,
                    ':private_school_id' => $privateSchoolId,
                    ':district_id'       => $districtId,
                    ':title'             => $title,
                    ':file_name'         => $originalName,
                    ':file_path'         => $stored['relative_path'],
                    ':file_size'         => $stored['size'],
                    ':document_type'     => $appLabel ?: null,
                    ':school_year'       => $schoolYear,
                    ':history_json'      => $historyJson,
                    ':submitted_at'      => $submittedAt,
                ]);
            }
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('school-portal-permit.php edit failed: ' . $e->getMessage());
        jsonError('Failed to update the application. Please try again.', 500);
    }

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_edit',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => "School Permit application updated | batch={$batchId}",
        'document_type' => 'School Permit',
        'file_name'     => $title,
    ]);

    jsonSuccess(['batch_id' => $batchId], 'Application updated successfully.');
}

// ---- Action: DELETE FILE -------------------------------------------------------

/**
 * POST /api/school-portal-permit.php?action=delete_file
 * Removes a single file from a batch (JSON body: { id }).
 */
function handlePermitDeleteFile(array $user, int $userId): void {
    $body = json_decode(file_get_contents('php://input'), true);
    $id   = (int)($body['id'] ?? 0);
    if (!$id) jsonError('Invalid file ID.', 400);

    $pdo  = getDB();
    $stmt = $pdo->prepare("SELECT * FROM school_submissions WHERE id = :id AND user_id = :uid AND type = 'permit' LIMIT 1");
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) jsonError('File not found.', 404);

    $status = strtolower(trim($row['status'] ?? ''));
    if (!in_array($status, ['pending', 'pending review', 'review', 'under review', 'returned', 'returned for correction'], true)) {
        jsonError('Only pending, under-review, or returned files can be removed.', 403);
    }

    $basePath = dirname(__DIR__);
    $absPath  = $basePath . '/' . $row['file_path'];
    if (file_exists($absPath)) @unlink($absPath);

    if (in_array($status, ['returned', 'returned for correction'], true)) {
        // Removing a flagged file is itself a correction — put the remaining
        // files in this batch back into the review queue.
        $batchId = '';
        if (!empty($row['history_json'])) {
            $decoded = json_decode((string)$row['history_json'], true);
            $meta    = extractGpr3Meta($decoded);
            $batchId = trim((string)($meta['permit_batch_id'] ?? ''));
        }
        if ($batchId !== '') {
            foreach (fetchPermitBatch($pdo, $userId, $batchId) as $siblingRow) {
                if ((int)$siblingRow['id'] === $id) continue; // being deleted below
                $pdo->prepare("UPDATE school_submissions SET status = 'pending', remarks = NULL WHERE id = :id AND user_id = :uid")
                    ->execute([':id' => $siblingRow['id'], ':uid' => $userId]);
            }
        }
    }

    $pdo->prepare("DELETE FROM school_submissions WHERE id = :id AND user_id = :uid")
        ->execute([':id' => $id, ':uid' => $userId]);

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_delete',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => "School Permit file removed | submission_id={$id} | file={$row['file_name']}",
        'document_type' => 'School Permit',
        'file_name'     => $row['file_name'],
    ]);

    jsonSuccess(['id' => $id], 'File removed successfully.');
}

// ---- Action: DELETE BATCH -------------------------------------------------------

/**
 * POST /api/school-portal-permit.php?action=delete
 * Removes an entire application — every file in the batch (JSON body: { batch_id }).
 */
function handlePermitDeleteBatch(array $user, int $userId): void {
    $body    = json_decode(file_get_contents('php://input'), true);
    $batchId = trim($body['batch_id'] ?? '');
    if ($batchId === '') jsonError('Missing application reference.', 400);

    $pdo  = getDB();
    $rows = fetchPermitBatch($pdo, $userId, $batchId);
    if (empty($rows)) jsonError('Application not found.', 404);

    foreach ($rows as $row) {
        $status = strtolower(trim($row['status'] ?? ''));
        if (!in_array($status, ['pending', 'pending review', 'review', 'under review', 'returned', 'returned for correction'], true)) {
            jsonError('Only pending, under-review, or returned applications can be deleted.', 403);
        }
    }

    $basePath = dirname(__DIR__);
    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $absPath = $basePath . '/' . $row['file_path'];
            if (file_exists($absPath)) @unlink($absPath);
            $pdo->prepare("DELETE FROM school_submissions WHERE id = :id AND user_id = :uid")
                ->execute([':id' => $row['id'], ':uid' => $userId]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('school-portal-permit.php delete batch failed: ' . $e->getMessage());
        jsonError('Failed to delete the application. Please try again.', 500);
    }

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_delete',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => "School Permit application deleted | batch={$batchId} | files=" . count($rows),
        'document_type' => 'School Permit',
        'file_name'     => implode(', ', array_column($rows, 'file_name')),
    ]);

    jsonSuccess(['batch_id' => $batchId], 'Application deleted successfully.');
}
