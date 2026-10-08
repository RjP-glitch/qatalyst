<?php
/**
 * school-portal-tuition.php
 * REST-style endpoint for Tuition Fee Builder documents.
 *
 * GET    ?action=load&id=N          → load one document (owned by session user)
 * GET    ?action=list               → list all documents for session user
 * POST   action=save                → upsert (create or update) a document
 * POST   action=submit&id=N         → change status draft→submitted + create school_submission
 * POST   action=delete&id=N         → soft-delete (draft only)
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) {
    ob_end_clean();
}
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonSuccess(array $data = [], string $message = 'Success', int $code = 200): void
{
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode([
        'success' => true,
        'message' => $message,
        'data'    => $data,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError(string $message, int $code = 400, array $data = []): void
{
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    $response = [
        'success' => false,
        'message' => $message,
    ];
    if (!empty($data)) {
        $response['data'] = $data;
    }
    echo json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// ── Schema helpers ────────────────────────────────────────────────────────────

function tableHasColumn(PDO $pdo, string $table, string $column): bool
{
    $allowedTables = [
        'school_tuition_documents',
        'school_submissions',
        'school_notifications',
    ];

    if (!in_array($table, $allowedTables, true)) {
        error_log("tableHasColumn: rejected unlisted table '{$table}'");
        return false;
    }

    $stmt = $pdo->prepare(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME   = :tbl
           AND COLUMN_NAME  = :col"
    );
    $stmt->execute([':tbl' => $table, ':col' => $column]);
    return (bool) $stmt->fetchColumn();
}

function getStatusValueForSchoolSubmission(PDO $pdo): string
{
    $stmt = $pdo->prepare("SHOW COLUMNS FROM `school_submissions` LIKE 'status'");
    $stmt->execute();
    $row  = $stmt->fetch(PDO::FETCH_ASSOC);
    // FIX #5: use stripos + trim to handle case/spacing variants in ENUM definition
    $type = strtolower(trim((string) ($row['Type'] ?? '')));

    if (stripos($type, 'pending review') !== false) {
        return 'Pending Review';
    }
    return 'pending';
}

function ensureTuitionDocumentsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_tuition_documents (
            id                 INT(11)        NOT NULL AUTO_INCREMENT,
            user_id            INT(11)        NOT NULL,
            private_school_id  INT(11)        DEFAULT NULL,
            title              VARCHAR(255)   NOT NULL,
            mode               ENUM('increase','no_increase') NOT NULL DEFAULT 'increase',
            increase_pct       DECIMAL(5,2)   DEFAULT NULL,
            current_sy         VARCHAR(20)    NOT NULL DEFAULT '',
            proposed_sy        VARCHAR(20)    NOT NULL DEFAULT '',
            has_kinder         TINYINT(1)     NOT NULL DEFAULT 1,
            has_elem           TINYINT(1)     NOT NULL DEFAULT 1,
            has_jhs            TINYINT(1)     NOT NULL DEFAULT 1,
            has_shs            TINYINT(1)     NOT NULL DEFAULT 0,
            payload_json       LONGTEXT       NOT NULL,
            kinder_total_curr  DECIMAL(12,2)  DEFAULT NULL,
            kinder_total_prop  DECIMAL(12,2)  DEFAULT NULL,
            elem_total_curr    DECIMAL(12,2)  DEFAULT NULL,
            elem_total_prop    DECIMAL(12,2)  DEFAULT NULL,
            jhs_total_curr     DECIMAL(12,2)  DEFAULT NULL,
            jhs_total_prop     DECIMAL(12,2)  DEFAULT NULL,
            shs_total_curr     DECIMAL(12,2)  DEFAULT NULL,
            shs_total_prop     DECIMAL(12,2)  DEFAULT NULL,
            status             ENUM('draft','submitted','Pending Review','returned','returned_for_correction') NOT NULL DEFAULT 'draft',
            active_step        TINYINT(1)     NOT NULL DEFAULT 1,
            created_at         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_std_user_id    (user_id),
            KEY idx_std_updated_at (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );


    // FIX: Expand status ENUM to include 'Pending Review' and returned statuses
    // for schools that already have the table with the old ENUM('draft','submitted').
    try {
        $pdo->exec(
            "ALTER TABLE `school_tuition_documents`
             MODIFY COLUMN `status`
             ENUM('draft','submitted','Pending Review','returned','returned_for_correction')
             NOT NULL DEFAULT 'draft'"
        );
    } catch (Throwable $enumEx) {
        // Log but do not throw — idempotent if ENUM already contains these values.
        error_log('ensureTuitionDocumentsTable ENUM expand: ' . $enumEx->getMessage());
    }

    // FIX #15: Add missing columns for schools that already have the table
    // without has_elem / has_shs / elem_* / shs_* columns.
    $columnsToAdd = [
        'has_elem'        => "TINYINT(1) NOT NULL DEFAULT 1 AFTER has_kinder",
        'has_shs'         => "TINYINT(1) NOT NULL DEFAULT 0 AFTER has_jhs",
        'elem_total_curr' => "DECIMAL(12,2) DEFAULT NULL AFTER kinder_total_prop",
        'elem_total_prop' => "DECIMAL(12,2) DEFAULT NULL AFTER elem_total_curr",
        'shs_total_curr'  => "DECIMAL(12,2) DEFAULT NULL AFTER jhs_total_prop",
        'shs_total_prop'  => "DECIMAL(12,2) DEFAULT NULL AFTER shs_total_curr",
        // BUG FIX: persist whether an edit-request is currently pending so the
        // "Request Edit Approval" button can correctly show "Request Pending"
        // after a page reload instead of resetting and allowing duplicates.
        'edit_request_status' => "VARCHAR(20) NOT NULL DEFAULT 'none' AFTER active_step",
    ];
    foreach ($columnsToAdd as $col => $definition) {
        if (!tableHasColumn($pdo, 'school_tuition_documents', $col)) {
            try {
                $pdo->exec("ALTER TABLE `school_tuition_documents` ADD COLUMN `{$col}` {$definition}");
            } catch (Throwable $alterEx) {
                // Ignore "Duplicate column" (1060) — another request may have added it
                // between the tableHasColumn check and this ALTER TABLE.
                if (strpos($alterEx->getMessage(), '1060') === false &&
                    stripos($alterEx->getMessage(), 'Duplicate column') === false) {
                    throw $alterEx;  // re-throw genuine schema errors
                }
            }
        }
    }
}

/**
 * Creates the admin-editable "Supporting Documents Checklist" table if it
 * doesn't exist yet, and seeds it with the 5 items that used to be
 * hardcoded in school-portal-tuition.js (TF_SUPPORTING_DOCS).
 *
 * Admins can add/edit/remove rows directly in the database — no code
 * changes needed. See supporting_documents_table.sql for the full schema
 * and example INSERTs (e.g. items scoped to a specific doc_type).
 */
function ensureSupportingDocumentsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_supporting_documents (
            id              INT(11)        NOT NULL AUTO_INCREMENT,
            doc_type        VARCHAR(50)    NOT NULL DEFAULT 'all',
            slug            VARCHAR(60)    NOT NULL,
            label           VARCHAR(255)   NOT NULL,
            hint            VARCHAR(500)   DEFAULT NULL,
            icon            VARCHAR(50)    NOT NULL DEFAULT 'fa-file',
            display_order   INT(11)        NOT NULL DEFAULT 0,
            is_active       TINYINT(1)     NOT NULL DEFAULT 1,
            created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_doctype_slug (doc_type, slug),
            KEY idx_doctype_active_order (doc_type, is_active, display_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // Seed once. If the table is empty (first install), insert the 5
    // items that previously lived in the frontend JS. Safe to leave in —
    // it no-ops once rows exist.
    $count = (int) $pdo->query('SELECT COUNT(*) FROM school_supporting_documents')->fetchColumn();
    if ($count === 0) {
        $seed = $pdo->prepare(
            'INSERT INTO school_supporting_documents
                (doc_type, slug, label, hint, icon, display_order, is_active)
             VALUES (:doc_type, :slug, :label, :hint, :icon, :display_order, 1)'
        );
        $rows = [
            ['all', 'sd_copies', '3 printed copies of the Comparative Schedule / Breakdown of School Fees',
                'Print the PDF exported from this builder — 3 sets, placed in one (1) folder.', 'fa-print', 10],
            ['all', 'sd_minutes', 'Minutes of consultation with Student Government and parents',
                'Include the attendance sheet and signatures of participants/attendees.', 'fa-users', 20],
            ['all', 'sd_alloc', 'Notarized Allocation Program of Expenditures',
                'A notarized breakdown of how collected tuition fees will be spent.', 'fa-file-contract', 30],
            ['all', 'sd_financial', 'CPA-certified Financial Statement',
                'Shows the financial status of the school, certified by a Certified Public Accountant.', 'fa-file-invoice-dollar', 40],
            ['all', 'sd_sec', 'Latest SEC Certificate of Registration',
                'Proof that the school is a legitimately registered corporation with the SEC.', 'fa-certificate', 50],
        ];
        foreach ($rows as [$docType, $slug, $label, $hint, $icon, $order]) {
            $seed->execute([
                ':doc_type'      => $docType,
                ':slug'          => $slug,
                ':label'         => $label,
                ':hint'          => $hint,
                ':icon'          => $icon,
                ':display_order' => $order,
            ]);
        }
    }
}

function ensureTuitionSupportingUploadsTable(PDO $pdo): void
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

function assertOwnsTuitionDocument(PDO $pdo, int $userId, int $documentId): array
{
    $stmt = $pdo->prepare("SELECT id, user_id FROM school_tuition_documents WHERE id = :id LIMIT 1");
    $stmt->execute([':id' => $documentId]);
    $doc = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$doc || (int) $doc['user_id'] !== $userId) {
        jsonError('Tuition document not found or access denied.', 404);
    }
    return $doc;
}

function tuitionSupportingUploadsDir(): string
{
    $dir = dirname(__DIR__) . '/uploads/tuition-supporting-docs';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

function handleUploadSupportingDocument(PDO $pdo, array $user): void
{
    ensureTuitionSupportingUploadsTable($pdo);
    $userId = (int) $user['id'];

    $documentId = isset($_POST['tuition_document_id']) && is_numeric($_POST['tuition_document_id'])
        ? (int) $_POST['tuition_document_id']
        : 0;
    $slug = strtolower(trim((string) ($_POST['slug'] ?? '')));

    if (!$documentId) {
        jsonError('tuition_document_id is required.', 422);
    }
    if (!$slug || !preg_match('/^[a-z0-9_]+$/', $slug)) {
        jsonError('Invalid slug.', 422);
    }

    assertOwnsTuitionDocument($pdo, $userId, $documentId);

    if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'] ?? '')) {
        jsonError('No file was uploaded.', 422);
    }

    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        jsonError('Upload failed (error code ' . $file['error'] . ').', 422);
    }

    $maxBytes = 10 * 1024 * 1024;
    if ($file['size'] > $maxBytes) {
        jsonError('File is too large. Maximum size is 10MB.', 422);
    }

    $allowedExt = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    if (!in_array($ext, $allowedExt, true)) {
        jsonError('Unsupported file type. Allowed: PDF, JPG, PNG, DOC, DOCX.', 422);
    }

    $mimeType = 'application/octet-stream';
    if (function_exists('finfo_open')) {
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo) {
            $detected = finfo_file($finfo, $file['tmp_name']);
            if ($detected) {
                $mimeType = $detected;
            }
            finfo_close($finfo);
        }
    }

    $storedFilename = $documentId . '_' . $slug . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $destPath = tuitionSupportingUploadsDir() . '/' . $storedFilename;

    $existingStmt = $pdo->prepare(
        "SELECT stored_filename FROM school_tuition_supporting_uploads
          WHERE tuition_document_id = :did AND slug = :slug LIMIT 1"
    );
    $existingStmt->execute([':did' => $documentId, ':slug' => $slug]);
    $oldStoredFilename = $existingStmt->fetchColumn();

    if (!move_uploaded_file($file['tmp_name'], $destPath)) {
        jsonError('Could not save the uploaded file.', 500);
    }

    if ($oldStoredFilename) {
        $oldPath = tuitionSupportingUploadsDir() . '/' . $oldStoredFilename;
        if (is_file($oldPath)) {
            @unlink($oldPath);
        }
    }

    $stmt = $pdo->prepare(
        "INSERT INTO school_tuition_supporting_uploads
            (tuition_document_id, slug, original_filename, stored_filename, mime_type, file_size, uploaded_by)
         VALUES (:did, :slug, :orig, :stored, :mime, :size, :uid)
         ON DUPLICATE KEY UPDATE
            original_filename = VALUES(original_filename),
            stored_filename = VALUES(stored_filename),
            mime_type = VALUES(mime_type),
            file_size = VALUES(file_size),
            uploaded_by = VALUES(uploaded_by),
            uploaded_at = CURRENT_TIMESTAMP"
    );
    $stmt->execute([
        ':did'    => $documentId,
        ':slug'   => $slug,
        ':orig'   => $file['name'],
        ':stored' => $storedFilename,
        ':mime'   => $mimeType,
        ':size'   => (int) $file['size'],
        ':uid'    => $userId,
    ]);

    jsonSuccess([
        'slug'              => $slug,
        'original_filename' => $file['name'],
        'file_size'         => (int) $file['size'],
        'uploaded_at'       => date('c'),
    ], 'Supporting document uploaded.');
}

function handleGetSupportingUploads(PDO $pdo, array $user): void
{
    ensureTuitionSupportingUploadsTable($pdo);
    $userId = (int) $user['id'];

    $documentId = isset($_GET['tuition_document_id']) && is_numeric($_GET['tuition_document_id'])
        ? (int) $_GET['tuition_document_id']
        : 0;
    if (!$documentId) {
        jsonSuccess(['items' => []], 'No document specified.');
    }

    assertOwnsTuitionDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT slug, original_filename, mime_type, file_size, uploaded_at
           FROM school_tuition_supporting_uploads
          WHERE tuition_document_id = :did"
    );
    $stmt->execute([':did' => $documentId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    jsonSuccess(['items' => $rows], 'Supporting uploads retrieved.');
}

function handleDeleteSupportingUpload(PDO $pdo, array $user, array $body): void
{
    ensureTuitionSupportingUploadsTable($pdo);
    $userId = (int) $user['id'];

    $documentId = isset($body['tuition_document_id']) && is_numeric($body['tuition_document_id'])
        ? (int) $body['tuition_document_id']
        : 0;
    $slug = strtolower(trim((string) ($body['slug'] ?? '')));
    if (!$documentId || !$slug) {
        jsonError('tuition_document_id and slug are required.', 422);
    }

    assertOwnsTuitionDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT stored_filename FROM school_tuition_supporting_uploads
          WHERE tuition_document_id = :did AND slug = :slug LIMIT 1"
    );
    $stmt->execute([':did' => $documentId, ':slug' => $slug]);
    $storedFilename = $stmt->fetchColumn();
    if (!$storedFilename) {
        jsonError('Upload not found.', 404);
    }

    $path = tuitionSupportingUploadsDir() . '/' . $storedFilename;
    if (is_file($path)) {
        @unlink($path);
    }

    $del = $pdo->prepare(
        "DELETE FROM school_tuition_supporting_uploads
          WHERE tuition_document_id = :did AND slug = :slug LIMIT 1"
    );
    $del->execute([':did' => $documentId, ':slug' => $slug]);

    jsonSuccess([], 'Supporting document removed.');
}

function handleDownloadSupportingUpload(PDO $pdo, array $user): void
{
    ensureTuitionSupportingUploadsTable($pdo);
    $userId = (int) $user['id'];

    $documentId = isset($_GET['tuition_document_id']) && is_numeric($_GET['tuition_document_id'])
        ? (int) $_GET['tuition_document_id']
        : 0;
    $slug = strtolower(trim((string) ($_GET['slug'] ?? '')));
    if (!$documentId || !$slug) {
        jsonError('tuition_document_id and slug are required.', 422);
    }

    assertOwnsTuitionDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT original_filename, stored_filename, mime_type
           FROM school_tuition_supporting_uploads
          WHERE tuition_document_id = :did AND slug = :slug LIMIT 1"
    );
    $stmt->execute([':did' => $documentId, ':slug' => $slug]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        jsonError('File not found.', 404);
    }

    $path = tuitionSupportingUploadsDir() . '/' . $row['stored_filename'];
    if (!is_file($path)) {
        jsonError('File not found on server.', 404);
    }

    if (ob_get_level()) {
        ob_end_clean();
    }
    header('Content-Type: ' . ($row['mime_type'] ?: 'application/octet-stream'));
    // Serve inline where possible so PDFs/images open in-browser for viewing
    header('Content-Disposition: inline; filename="' . basename($row['original_filename']) . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
}

// ── Supporting documents checklist ────────────────────────────────────────────

/**
 * GET ?action=supporting_docs&doc_type=tuition_increase
 *
 * Returns the active checklist items for the given doc_type, plus any
 * items scoped to 'all' (shown for every doc_type). If doc_type is
 * omitted, only 'all' items are returned.
 */
function handleSupportingDocsList(PDO $pdo, string $docType): void
{
    $docType = $docType !== '' ? $docType : 'all';

    $stmt = $pdo->prepare(
        "SELECT slug, label, hint, icon, display_order
         FROM school_supporting_documents
         WHERE is_active = 1
           AND (doc_type = :doc_type OR doc_type = 'all')
         ORDER BY display_order ASC, id ASC"
    );
    $stmt->execute([':doc_type' => $docType]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Re-shape to exactly what the frontend's TF_SUPPORTING_DOCS used:
    // { id, label, hint, icon }
    $items = array_map(static function (array $r): array {
        return [
            'id'    => $r['slug'],
            'label' => $r['label'],
            'hint'  => $r['hint'],
            'icon'  => $r['icon'],
        ];
    }, $rows);

    jsonSuccess(['items' => $items, 'count' => count($items)], 'Supporting documents retrieved successfully.');
}

// ── Payload recomputation ─────────────────────────────────────────────────────

/**
 * FIX #7 (Critical): Field lists now match the frontend exactly.
 *
 * Previously the PHP field lists (k_lms, k_av, k_assess etc.) did not match
 * what the JS was sending (k_handbook, k_water, k_itm, k_books, k_dev etc.).
 * This caused silent data loss on every save. All four level arrays are now
 * aligned with the HTML form IDs in school-portal-tuition.html.
 *
 * Recompute all proposed/increase values server-side.
 * The client sends _curr values and increase_pct. We recalculate _prop and
 * _inc here so a tampered payload cannot store fraudulent proposed amounts.
 * In no_increase mode, proposed = current and increase = 0.
 *
 * Fields are derived dynamically from the payload: any key ending in _curr is
 * treated as a fee field. This supports schools that have deleted built-in
 * misc fee rows (they simply won't appear in the payload) as well as custom
 * fees added via the "Add Custom Fee" button.
 */
function recomputePayload(array $payload, string $mode, float $increasePct): array
{
    $isIncrease = ($mode === 'increase');
    $multiplier = $isIncrease ? (1 + $increasePct / 100) : 1.0;

    $sections = ['kinder', 'elem', 'jhs', 'shs'];

    foreach ($sections as $section) {
        if (!isset($payload[$section]) || !is_array($payload[$section])) {
            continue;
        }

        $totalCurr = 0.0;
        $totalProp = 0.0;

        // Discover fields dynamically: any key that ends with _curr is a fee field.
        // This means deleted built-ins are absent (correct) and custom fees added
        // by the school are processed automatically without any PHP changes.
        foreach ($payload[$section] as $key => $value) {
            if (!str_ends_with($key, '_curr')) continue;

            $field = substr($key, 0, -5); // strip '_curr'
            $curr  = round((float) $value, 2);
            $prop  = round($curr * $multiplier, 2);
            $inc   = round($prop - $curr, 2);

            $payload[$section][$field . '_curr'] = $curr;
            $payload[$section][$field . '_prop'] = $prop;
            $payload[$section][$field . '_inc']  = $inc;

            $totalCurr += $curr;
            $totalProp += $prop;
        }

        $payload[$section]['total_curr'] = round($totalCurr, 2);
        $payload[$section]['total_prop'] = round($totalProp, 2);
        $payload[$section]['total_inc']  = round($totalProp - $totalCurr, 2);
    }

    return $payload;
}

// ── DepEd compliance constants (DepEd Order No. 13 s. 2023) ──────────────────

// Maximum tuition increase percentage allowed under DO 13 s. 2023.
// This cap applies to tuition fees only (not miscellaneous / other fees).
define('DEPED_MAX_TUITION_INCREASE_PCT', 15.0);

// Absolute minimum and maximum plausible tuition fee (annual, per level).
// The floor prevents ₱1 token submissions; the ceiling flags obvious data-entry errors.
// These are intentionally wide — the SDO may tighten them via policy update.
define('DEPED_MIN_TUITION_FEE',    1000.0);   // ₱1,000 / year
define('DEPED_MAX_TUITION_FEE', 150000.0);    // ₱150,000 / year

/**
 * Validate DepEd compliance rules before allowing final submission.
 *
 * Checks enforced here (server-side mirror of JS confirmTuitionSubmit guards):
 *  1. gov_recog must be non-empty.
 *  2. principal and principal_contact must be non-empty.
 *  3. For mode=increase: increase_pct must be ≤ DEPED_MAX_TUITION_INCREASE_PCT.
 *  4. Every enabled level's tuition fee must be within [MIN, MAX].
 *
 * Returns an array of human-readable error strings.  Empty array = pass.
 */
function validateDepEdCompliance(array $doc, array $payload): array
{
    $errors = [];

    // ── 1. Government Recognition Number ──────────────────────────────────────
    $govRecog = trim((string) ($payload['form']['gov_recog'] ?? ''));
    if ($govRecog === '') {
        $errors[] = 'Government Recognition Number is required before submission.';
    }

    // ── 2. Principal / Contact ────────────────────────────────────────────────
    $principal = trim((string) ($payload['form']['principal'] ?? ''));
    if ($principal === '') {
        $errors[] = 'Principal name is required before submission.';
    }
    $contact = trim((string) ($payload['form']['principal_contact'] ?? ''));
    if ($contact === '') {
        $errors[] = 'Principal contact number is required before submission.';
    }

    // ── 3. Increase percentage cap (DO 13 s. 2023) ───────────────────────────
    if ($doc['mode'] === 'increase') {
        $pct = (float) ($doc['increase_pct'] ?? 0);
        if ($pct > DEPED_MAX_TUITION_INCREASE_PCT) {
            $errors[] = sprintf(
                'Proposed tuition increase of %.2f%% exceeds the DepEd Order No. 13 s. 2023 cap of %.0f%%.',
                $pct,
                DEPED_MAX_TUITION_INCREASE_PCT
            );
        }
    }

    // ── 4. Plausible tuition fee range per enabled level ─────────────────────
    // BUG FIX: SHS supports a "per-grade" tuition mode (separate Grade 11 /
    // Grade 12 tuition stored in s11_tuition_curr / s12_tuition_curr, with
    // s_tuition_curr left at 0). The old check only ever looked at
    // s_tuition_curr, so any school using per-grade SHS tuition was always
    // rejected with a false "tuition fee must be greater than ₱0" error even
    // though G11/G12 tuition was correctly filled in. We now check whichever
    // field set is actually populated.
    $levelMap = [
        'kinder' => ['flag' => 'has_kinder', 'fields' => [['k_tuition_curr', 'Kindergarten']]],
        'elem'   => ['flag' => 'has_elem',   'fields' => [['e_tuition_curr', 'Elementary']]],
        'jhs'    => ['flag' => 'has_jhs',    'fields' => [['j_tuition_curr', 'Junior High School']]],
        'shs'    => ['flag' => 'has_shs',    'fields' => null], // resolved below
    ];

    $shsTuitionCurr = (float) ($payload['shs']['s_tuition_curr'] ?? 0);
    $shs11Curr      = (float) ($payload['shs']['s11_tuition_curr'] ?? 0);
    $shs12Curr      = (float) ($payload['shs']['s12_tuition_curr'] ?? 0);
    $shsIsPerGrade  = ($shsTuitionCurr <= 0) && ($shs11Curr > 0 || $shs12Curr > 0);

    $levelMap['shs']['fields'] = $shsIsPerGrade
        ? [
            ['s11_tuition_curr', 'Senior High School (Grade 11)'],
            ['s12_tuition_curr', 'Senior High School (Grade 12)'],
          ]
        : [['s_tuition_curr', 'Senior High School']];

    foreach ($levelMap as $section => $meta) {
        if (empty($doc[$meta['flag']])) {
            continue; // level not enabled — skip
        }

        foreach ($meta['fields'] as [$field, $label]) {
            $tuition = (float) ($payload[$section][$field] ?? 0);

            if ($tuition <= 0) {
                $errors[] = $label . ' tuition fee must be greater than ₱0.';
            } elseif ($tuition < DEPED_MIN_TUITION_FEE) {
                $errors[] = sprintf(
                    '%s tuition fee of ₱%s appears unrealistically low (minimum ₱%s). Please verify.',
                    $label,
                    number_format($tuition, 2),
                    number_format(DEPED_MIN_TUITION_FEE, 2)
                );
            } elseif ($tuition > DEPED_MAX_TUITION_FEE) {
                $errors[] = sprintf(
                    '%s tuition fee of ₱%s exceeds the plausible maximum of ₱%s. Please verify.',
                    $label,
                    number_format($tuition, 2),
                    number_format(DEPED_MAX_TUITION_FEE, 2)
                );
            }
        }
    }

    return $errors;
}

// ── Notification helper ───────────────────────────────────────────────────────

function insertSchoolNotificationForTuition(PDO $pdo, ?int $schoolId, ?int $privateSchoolId, string $title): void
{
    // BUG FIX: private school users carry private_school_id, not school_id.
    // The old signature only accepted $schoolId so it was always null for private
    // schools, hitting the early return and never inserting a notification.
    $resolvedId = $schoolId ?? $privateSchoolId;
    if (!$resolvedId) {
        return;
    }
    try {
        $message = 'Your tuition fee document "' . $title . '" has been submitted for review.';
        $pdo->prepare("
            INSERT INTO school_notifications
                (school_id, type, title, message, link, is_read, created_at)
            VALUES
                (:school_id, 'submission',
                 'Tuition Fee Submitted',
                 :message,
                 'school-tuition.html',
                 0,
                 NOW())
        ")->execute([
            ':school_id' => $resolvedId,
            ':message'   => $message,
        ]);
    } catch (Throwable $e) {
        error_log('insertSchoolNotificationForTuition failed: ' . $e->getMessage());
    }
}

// ── SDO / admin-side notification ────────────────────────────────────────────

/**
 * Insert a notification visible to SDO personnel / admin when a school submits
 * a tuition fee document.  Mirrors the calendar flow where the frontend calls
 * notifications.php after a successful submit.
 *
 * Tries two common table names in priority order:
 *   1. admin_notifications   (used by the SDO dashboard)
 *   2. sdo_notifications     (alternate naming convention)
 * If neither exists the call is silently skipped — the school_submissions row
 * alone is enough for the SDO to see the submission in their queue.
 */
function insertSDONotificationForTuition(
    PDO     $pdo,
    ?int    $schoolId,
    ?int    $districtId,
    string  $schoolName,
    string  $title,
    int     $documentId
): void {
    // Candidate tables in preference order
    $tables = ['admin_notifications', 'sdo_notifications'];
    $targetTable = null;
    foreach ($tables as $tbl) {
        try {
            $chk = $pdo->query("SHOW TABLES LIKE '{$tbl}'")->fetchColumn();
            if ($chk) { $targetTable = $tbl; break; }
        } catch (Throwable $e) {
            error_log("insertSDONotificationForTuition: SHOW TABLES failed for {$tbl}: " . $e->getMessage());
        }
    }

    if (!$targetTable) {
        // Neither table exists — SDO notifications not supported in this install
        return;
    }

    $hasDistrictId  = false;
    $hasLink        = false;
    $hasDocId       = false;

    // Detect optional columns dynamically so we don't break on older schemas
    try {
        $cols = $pdo->query("DESCRIBE `{$targetTable}`")->fetchAll(PDO::FETCH_COLUMN);
        $hasDistrictId = in_array('district_id', $cols, true);
        $hasLink       = in_array('link', $cols, true);
        $hasDocId      = in_array('document_id', $cols, true) || in_array('calendar_document_id', $cols, true);
        $docColName    = in_array('document_id', $cols, true) ? 'document_id' : 'calendar_document_id';
    } catch (Throwable $e) {
        error_log("insertSDONotificationForTuition: DESCRIBE {$targetTable} failed: " . $e->getMessage());
        return;
    }

    try {
        $msgSchool = $schoolName ?: ('School #' . $schoolId);
        $message   = "{$msgSchool} has submitted a Tuition Fee document: \"{$title}\". Please review.";

        $baseCols = ['type', 'title', 'message', 'is_read', 'created_at'];
        $baseVals = [':type', ':notif_title', ':message', '0', 'NOW()'];
        $params   = [
            ':type'        => 'tuition_submission',
            ':notif_title' => 'New Tuition Fee Submission',
            ':message'     => $message,
        ];

        if ($hasDistrictId && $districtId) {
            $baseCols[] = 'district_id'; $baseVals[] = ':district_id';
            $params[':district_id'] = $districtId;
        }
        if ($hasLink) {
            $baseCols[] = 'link'; $baseVals[] = ':link';
            $params[':link'] = 'school-portal-submissions.html?doc=' . $documentId . '&type=tuition';
        }
        if ($hasDocId) {
            $baseCols[] = $docColName; $baseVals[] = ':doc_id';
            $params[':doc_id'] = $documentId;
        }

        $sql = "INSERT INTO `{$targetTable}` (" . implode(', ', $baseCols) . ")
                VALUES (" . implode(', ', $baseVals) . ")";
        $pdo->prepare($sql)->execute($params);
    } catch (Throwable $e) {
        error_log('insertSDONotificationForTuition failed: ' . $e->getMessage());
        // Non-fatal — submission itself already succeeded
    }
}

// ── school_submissions bridge ─────────────────────────────────────────────────

function upsertTuitionSubmission(
    PDO    $pdo,
    array  $user,
    int    $tuitionDocumentId,
    array  $doc
): string {
    if (!tableHasColumn($pdo, 'school_submissions', 'type')) {
        return 'skipped';
    }

    $hasCalendarDocId  = tableHasColumn($pdo, 'school_submissions', 'calendar_document_id');
    $hasSubmittedBy    = tableHasColumn($pdo, 'school_submissions', 'submitted_by');
    $hasDocumentType   = tableHasColumn($pdo, 'school_submissions', 'document_type');
    $hasDateSubmitted  = tableHasColumn($pdo, 'school_submissions', 'date_submitted');
    $hasSchoolIdCol    = tableHasColumn($pdo, 'school_submissions', 'school_id');
    $hasSchoolYear     = tableHasColumn($pdo, 'school_submissions', 'school_year');
    $hasCreatedByName  = tableHasColumn($pdo, 'school_submissions', 'created_by_name');

    $userId          = (int) $user['id'];
    $privateSchoolId = !empty($user['private_school_id']) ? (int) $user['private_school_id'] : null;
    $schoolId        = !empty($user['school_id']) ? (int) $user['school_id'] : null;

    // Re-query private_school_id from users table whenever it is missing.
    // Some sessions include the key but with a null value.
    if ($privateSchoolId === null || $schoolId === null) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id, school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $ids = $psRow->fetch(PDO::FETCH_ASSOC) ?: [];
            if ($privateSchoolId === null) {
                $psVal = $ids['private_school_id'] ?? null;
                $privateSchoolId = ($psVal !== null && $psVal !== '') ? (int) $psVal : null;
            }
            if ($schoolId === null) {
                $sVal = $ids['school_id'] ?? null;
                $schoolId = ($sVal !== null && $sVal !== '') ? (int) $sVal : null;
            }
        } catch (Throwable $e) {
            error_log('upsertTuitionSubmission: could not fetch private_school_id — ' . $e->getMessage());
        }
    }
    $submittedBy = trim((string) ($user['full_name'] ?? $user['email'] ?? 'Portal User'));

    $title      = $doc['title'];
    $schoolYear = $doc['proposed_sy'] ?? '';
    $modeLabel  = ($doc['mode'] ?? 'increase') === 'increase'
        ? 'Tuition Fee Increase'
        : 'Tuition Fee (No Increase)';

    $status   = getStatusValueForSchoolSubmission($pdo);
    $fileName = 'tuition-builder-' . $tuitionDocumentId . '.json';
    $filePath = 'school_tuition_documents:' . $tuitionDocumentId;
    $fileSize = strlen($doc['payload_json'] ?? '');

    $existingId = null;
    $hasHistoryJsonCol = tableHasColumn($pdo, 'school_submissions', 'history_json');

    if ($hasCalendarDocId) {
        $sel = $pdo->prepare(
            "SELECT id FROM school_submissions
             WHERE calendar_document_id = :doc_id AND type = 'tuition'
             LIMIT 1"
        );
        $sel->execute([':doc_id' => $tuitionDocumentId]);
        $existingId = (int) ($sel->fetchColumn() ?: 0);
    }

    // Prefer matching by file_path (derived from tuition document id) so each
    // final-submitted tuition document has its own school_submissions row.
    if (!$existingId) {
        $sel = $pdo->prepare(
            "SELECT id FROM school_submissions
             WHERE type = 'tuition' AND file_path = :file_path
             ORDER BY id DESC LIMIT 1"
        );
        $sel->execute([':file_path' => $filePath]);
        $existingId = (int) ($sel->fetchColumn() ?: 0);
    }

    // Legacy fallback by title/school_year for older rows that may not have the
    // `school_tuition_documents:{id}` file_path pattern.
    if (!$existingId) {
        if ($hasSchoolYear && $schoolYear !== '') {
            $sel = $pdo->prepare(
                "SELECT id FROM school_submissions
                 WHERE user_id = :user_id AND type = 'tuition'
                   AND title = :title AND school_year = :sy
                 ORDER BY id DESC LIMIT 1"
            );
            $sel->execute([':user_id' => $userId, ':title' => $title, ':sy' => $schoolYear]);
        } else {
            $sel = $pdo->prepare(
                "SELECT id FROM school_submissions
                 WHERE user_id = :user_id AND type = 'tuition' AND title = :title
                 ORDER BY id DESC LIMIT 1"
            );
            $sel->execute([':user_id' => $userId, ':title' => $title]);
        }
        $existingId = (int) ($sel->fetchColumn() ?: 0);
    }

    if ($existingId) {
        // ── Resubmission history ─────────────────────────────────────────────
        // Reaching this UPDATE branch (an existing school_submissions row was
        // found for this tuition_document_id) only ever happens on a SECOND
        // OR LATER submit — the very first submit always takes the INSERT
        // path below, since no school_submissions row exists yet at that
        // point. So every time we get here, this is by definition a
        // resubmission: the school requested an edit, the SDO approved it
        // (actionApproveEdit, which only unlocks school_tuition_documents to
        // 'draft' and never changes school_submissions.status), and the
        // school has now corrected and resubmitted. Note this does NOT rely
        // on school_submissions.status having changed (it stays "Pending
        // Review" the whole time in this flow), so we append the history
        // entry unconditionally here — mirroring the same proven approach
        // already used by upsertSchoolCalendarSubmission() in
        // school-portal-calendar.php.
        $updatedHistoryJson = null;
        if ($hasHistoryJsonCol) {
            try {
                $histStmt = $pdo->prepare("SELECT history_json FROM school_submissions WHERE id = :id LIMIT 1");
                $histStmt->execute([':id' => $existingId]);
                $history = json_decode((string) ($histStmt->fetchColumn() ?: '[]'), true);
                if (!is_array($history)) { $history = []; }
                $history[] = [
                    'event'      => 'status_update',
                    'status'     => $status,
                    'by'         => $submittedBy,
                    'created_at' => date('Y-m-d H:i:s'),
                    'note'       => 'Resubmitted after correction',
                ];
                $updatedHistoryJson = json_encode($history, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            } catch (Throwable $histErr) {
                error_log('upsertTuitionSubmission: history append failed — ' . $histErr->getMessage());
                $updatedHistoryJson = null;
            }
        }

        $updateParts = [
            'title       = :title',
            'status      = :status',
            'private_school_id = :private_school_id',
            'type        = :type',
            'file_name   = :file_name',
            'file_path   = :file_path',
            'file_size   = :file_size',
            'updated_at  = NOW()',
        ];
        if ($hasCalendarDocId)  { $updateParts[] = 'calendar_document_id = :calendar_document_id'; }
        if ($hasSubmittedBy)    { $updateParts[] = 'submitted_by         = :submitted_by'; }
        if ($hasDocumentType)   { $updateParts[] = 'document_type        = :document_type'; }
        if ($hasDateSubmitted)  { $updateParts[] = 'date_submitted       = COALESCE(date_submitted, CURDATE())'; }
        if ($hasSchoolIdCol)    { $updateParts[] = 'school_id            = :school_id'; }
        if ($hasSchoolYear)     { $updateParts[] = 'school_year          = :school_year'; }
        if ($hasCreatedByName)  { $updateParts[] = 'created_by_name      = :created_by_name'; }
        if ($updatedHistoryJson !== null) { $updateParts[] = 'history_json = :history_json'; }

        $sql    = "UPDATE school_submissions SET " . implode(', ', $updateParts) . " WHERE id = :id";
        $params = [
            ':id'                => $existingId,
            ':title'             => $title,
            ':status'            => $status,
            ':private_school_id' => $privateSchoolId,
            ':type'              => 'tuition',
            ':file_name'         => $fileName,
            ':file_path'         => $filePath,
            ':file_size'         => $fileSize,
        ];
        if ($hasCalendarDocId) { $params[':calendar_document_id'] = $tuitionDocumentId; }
        if ($hasSubmittedBy)   { $params[':submitted_by']         = $submittedBy; }
        if ($hasDocumentType)  { $params[':document_type']        = $modeLabel; }
        if ($hasSchoolIdCol)   { $params[':school_id']            = $schoolId; }
        if ($hasSchoolYear)    { $params[':school_year']          = $schoolYear !== '' ? $schoolYear : null; }
        if ($hasCreatedByName) { $params[':created_by_name']      = $submittedBy; }
        if ($updatedHistoryJson !== null) { $params[':history_json'] = $updatedHistoryJson; }

        $pdo->prepare($sql)->execute($params);
        // BUG FIX: notification was never called in the update path — only insert got it.
        insertSchoolNotificationForTuition($pdo, null, $privateSchoolId, $title);
        return 'resubmitted_after_correction';
    }

    // Fix H: submitted_at may not exist in all schema versions — check first
    $hasSubmittedAt = tableHasColumn($pdo, 'school_submissions', 'submitted_at');
    $cols   = ['user_id', 'private_school_id', 'type', 'title',
                'file_name', 'file_path', 'file_size', 'status', 'updated_at'];
    $vals   = [':user_id', ':private_school_id', ':type', ':title',
                ':file_name', ':file_path', ':file_size', ':status', 'NOW()'];
    if ($hasSubmittedAt) { $cols[] = 'submitted_at'; $vals[] = 'NOW()'; }
    $params = [
        ':user_id'           => $userId,
        ':private_school_id' => $privateSchoolId,
        ':type'              => 'tuition',
        ':title'             => $title,
        ':file_name'         => $fileName,
        ':file_path'         => $filePath,
        ':file_size'         => $fileSize,
        ':status'            => $status,
    ];

    if ($hasCalendarDocId) {
        $cols[] = 'calendar_document_id';
        $vals[] = ':calendar_document_id';
        $params[':calendar_document_id'] = $tuitionDocumentId;
    }
    if ($hasSubmittedBy) {
        $cols[] = 'submitted_by';
        $vals[] = ':submitted_by';
        $params[':submitted_by'] = $submittedBy;
    }
    if ($hasDocumentType) {
        $cols[] = 'document_type';
        $vals[] = ':document_type';
        $params[':document_type'] = $modeLabel;
    }
    if ($hasDateSubmitted) {
        $cols[] = 'date_submitted';
        $vals[] = 'CURDATE()';
    }
    if ($hasSchoolIdCol) {
        $cols[] = 'school_id';
        $vals[] = ':school_id';
        $params[':school_id'] = $schoolId;
    }
    if ($hasSchoolYear) {
        $cols[] = 'school_year';
        $vals[] = ':school_year';
        $params[':school_year'] = $schoolYear !== '' ? $schoolYear : null;
    }
    if ($hasCreatedByName) {
        $cols[] = 'created_by_name';
        $vals[] = ':created_by_name';
        $params[':created_by_name'] = $submittedBy;
    }

    $sql = "INSERT INTO school_submissions (" . implode(', ', $cols) . ")
            VALUES (" . implode(', ', $vals) . ")";
    $pdo->prepare($sql)->execute($params);

    insertSchoolNotificationForTuition($pdo, null, $privateSchoolId, $title);

    return 'inserted';
}

// ── Audit log helper ──────────────────────────────────────────────────────────

function logTuitionBridgeAudit(PDO $pdo, array $user, int $documentId, string $title, string $bridgeAction): void
{
    if (!in_array($bridgeAction, ['inserted', 'updated', 'resubmitted_after_correction'], true)) {
        return;
    }

    $role = trim((string) ($user['role'] ?? $user['account_type'] ?? 'portal_user'));
    if ($role === '') {
        $role = 'portal_user';
    }

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => (int) ($user['id'] ?? 0),
        'role'          => $role,
        'action'        => 'tuition_final_submit_sync',
        'module'        => 'school_tuition',
        'status'        => 'success',
        'description'   => sprintf(
            'Final submit bridge %s in school_submissions | document_id=%d | title=%s',
            $bridgeAction,
            $documentId,
            $title
        ),
        'document_type' => 'Tuition Fee',
        'file_name'     => 'tuition-builder-' . $documentId . '.json',
    ]);
}

// ── Main entry point ──────────────────────────────────────────────────────────

try {
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'));

    if (!in_array($method, ['GET', 'POST', 'OPTIONS'], true)) {
        header('Allow: GET, POST, OPTIONS');
        jsonError('Method not allowed. Use GET or POST for this endpoint.', 405, [
            'received_method' => $method,
            'expected_method' => 'GET or POST',
        ]);
    }

    handlePreflight();

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) {
        jsonError('Unauthorized. Please sign in.', 401);
    }

    $accountType = $user['account_type'] ?? 'portal_user';
    // Fix B: allow all school-side account types; only block SDO/admin back-office accounts.
    $blockedTypes = ['sdo_personnel', 'sdo_admin', 'admin', 'superadmin', 'regional_admin'];
    if (in_array(strtolower(trim($accountType)), $blockedTypes, true)) {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $body = [];
    $action = '';
    if ($method === 'POST') {
        if (isset($_POST['action']) && in_array(strtolower(trim((string) $_POST['action'])), ['upload_supporting_document', 'delete_supporting_upload'], true)) {
            $action = strtolower(trim((string) $_POST['action']));
            $body = $_POST;
        } else {
            $raw  = file_get_contents('php://input');
            $body = json_decode($raw, true);
            if (!is_array($body)) {
                $body = $_POST;
            }
            if (!is_array($body)) {
                jsonError('Invalid request payload.', 422);
            }
            $action = strtolower(trim($body['action'] ?? ($_POST['action'] ?? '')));
        }
    } else {
        $action = strtolower(trim($_GET['action'] ?? ''));
    }

    $pdo = getDB();
    ensureTuitionDocumentsTable($pdo);
    ensureSupportingDocumentsTable($pdo);

    $userId          = (int) $user['id'];
    $privateSchoolId = !empty($user['private_school_id']) ? (int) $user['private_school_id'] : null;

    if ($method === 'GET' && $action === 'list') {
        handleList($pdo, $userId);

    } elseif ($method === 'GET' && $action === 'supporting_docs') {
        $docType = strtolower(trim((string) ($_GET['doc_type'] ?? 'all')));
        handleSupportingDocsList($pdo, $docType);

    } elseif ($method === 'GET' && $action === 'get_supporting_uploads') {
        handleGetSupportingUploads($pdo, $user);

    } elseif ($method === 'GET' && $action === 'download_supporting_upload') {
        handleDownloadSupportingUpload($pdo, $user);

    } elseif ($method === 'GET' && $action === 'load') {
        $id = isset($_GET['id']) && is_numeric($_GET['id']) ? (int) $_GET['id'] : 0;
        if ($id <= 0) {
            jsonError('Missing or invalid id parameter.', 422);
        }
        handleLoad($pdo, $userId, $id);

    } elseif ($method === 'GET' && $action === 'get_signatories') {
        handleGetSignatoriesTuition($pdo, $user);

    } elseif ($method === 'POST' && $action === 'save') {
        handleSave($pdo, $user, $privateSchoolId, $body);

    } elseif ($method === 'POST' && $action === 'upload_supporting_document') {
        handleUploadSupportingDocument($pdo, $user);

    } elseif ($method === 'POST' && $action === 'delete_supporting_upload') {
        handleDeleteSupportingUpload($pdo, $user, $body);

    } elseif ($method === 'POST' && $action === 'submit') {
        $id = isset($body['id']) && is_numeric($body['id']) ? (int) $body['id'] : 0;
        if ($id <= 0) {
            jsonError('Missing or invalid id.', 422);
        }
        handleSubmit($pdo, $user, $privateSchoolId, $id);

    } elseif ($method === 'POST' && $action === 'delete') {
        $id = isset($body['id']) && is_numeric($body['id']) ? (int) $body['id'] : 0;
        if ($id <= 0) {
            jsonError('Missing or invalid id.', 422);
        }
        handleDelete($pdo, $userId, $id);

    } elseif ($method === 'POST' && $action === 'request_edit') {
        $id = isset($body['id']) && is_numeric($body['id']) ? (int) $body['id'] : 0;
        if ($id <= 0) {
            jsonError('Missing or invalid id.', 422);
        }
        handleEditRequest($pdo, $user, $id, trim((string) ($body['reason'] ?? '')));

    } elseif ($method === 'POST' && $action === 'save_signatory') {
        handleSaveSignatoryTuition($pdo, $user, $body);

    } elseif ($method === 'POST' && $action === 'delete_signatory') {
        handleDeleteSignatoryTuition($pdo, $user, $body);

    } else {
        jsonError('Unknown or unsupported action.', 400, [
            'received_action' => $action,
            'method'          => $method,
        ]);
    }

} catch (Throwable $e) {
    // Fix G: log file+line so the error log pinpoints the exact failure location
    error_log('school-portal-tuition.php FATAL: ' . $e->getMessage()
        . ' in ' . $e->getFile() . ':' . $e->getLine()
        . ' | SQL state: ' . $e->getCode());
    jsonError('Server error: ' . $e->getMessage(), 500);
}

// ── Signatories (shared table: school_signatories) ───────────────────────────

/**
 * Canonical map of which builder each signatory role belongs to. Mirrored
 * identically in school-portal-calendar.php and main-settings.php — see the
 * comment there for details. Kept in sync by hand since these three portal
 * files don't share a common includes file.
 */
function signatoryBuilderType(string $role): string
{
    static $map = [
        'rd'             => 'calendar',
        'sds'            => 'calendar',
        'recommending'   => 'calendar',
        'final_approver' => 'calendar',
        'chk_checked_by' => 'calendar',
        'reviewed_by'    => 'tuition',
        'validated_by'   => 'tuition',
        'noted_by'       => 'tuition',
        // Schools Division Superintendent "Noted by" signatory used specifically
        // on the SHS Certification of Fees page. Deliberately NOT called 'sds' —
        // that role key is already reserved for the calendar builder above and
        // maps to builder_type='calendar', which would make it invisible to
        // handleGetSignatoriesTuition() (filters on builder_type IN ('tuition','shared')).
        'shs_noted_by'   => 'tuition',
        'principal'      => 'shared',
    ];
    return $map[$role] ?? 'shared';
}

/**
 * "Validated by" and "Noted by" are always SDO/regional-office signatories
 * (e.g. EPS/QAD, Regional Director) — same rule as main-settings.php's
 * $officeOnlyRoles. They must only ever exist as office-managed rows
 * (private_school_id IS NULL), never a per-school copy, so block schools
 * from saving over them here. Kept in sync by hand with main-settings.php.
 */
function isOfficeOnlyRoleTuition(string $role): bool
{
    return in_array($role, ['validated_by', 'noted_by', 'shs_noted_by'], true);
}

function ensureSignatoriesTableTuition(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_signatories (
            id                  INT(11)       NOT NULL AUTO_INCREMENT,
            private_school_id   INT(11)       DEFAULT NULL,
            role                VARCHAR(60)   NOT NULL,
            builder_type        VARCHAR(20)   NOT NULL DEFAULT 'shared',
            full_name           VARCHAR(255)  NOT NULL DEFAULT '',
            position_title      VARCHAR(255)  NOT NULL DEFAULT '',
            office              VARCHAR(255)  NOT NULL DEFAULT '',
            city                VARCHAR(100)  NOT NULL DEFAULT '',
            contact             VARCHAR(60)   NOT NULL DEFAULT '',
            is_default          TINYINT(1)    NOT NULL DEFAULT 0,
            created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_sig_school_role (private_school_id, role),
            KEY idx_sig_builder (builder_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // Migrate installs created before builder_type existed.
    $col = $pdo->query("SHOW COLUMNS FROM school_signatories LIKE 'builder_type'")->fetch();
    if (!$col) {
        $pdo->exec("ALTER TABLE school_signatories
            ADD COLUMN builder_type VARCHAR(20) NOT NULL DEFAULT 'shared' AFTER role,
            ADD KEY idx_sig_builder (builder_type)");
        $pdo->exec("UPDATE school_signatories SET builder_type='calendar' WHERE role IN ('rd','sds','recommending','final_approver','chk_checked_by')");
        $pdo->exec("UPDATE school_signatories SET builder_type='tuition'  WHERE role = 'reviewed_by'");
    }
}

function resolvePrivateSchoolIdTuition(PDO $pdo, array $user): ?int
{
    if (!empty($user['private_school_id'])) return (int)$user['private_school_id'];
    try {
        $ps = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
        $ps->execute([':uid' => (int)$user['id']]);
        $v = $ps->fetchColumn();
        return ($v !== false && $v !== null) ? (int)$v : null;
    } catch (Throwable $e) {
        error_log('resolvePrivateSchoolIdTuition: ' . $e->getMessage());
        return null;
    }
}

function handleGetSignatoriesTuition(PDO $pdo, array $user): void
{
    ensureSignatoriesTableTuition($pdo);
    $psid = resolvePrivateSchoolIdTuition($pdo, $user);

    // Merge the school's own rows with office-managed rows (private_school_id
    // IS NULL) so admin-set defaults — like an SDO-wide "Processed and Evaluated By" — are
    // visible here too, the same way the calendar builder already merges RD/SDS.
    // Office rows load even when no school is linked to the account yet.
    $sql = "SELECT id, private_school_id, role, builder_type, full_name, position_title, office, city, contact, is_default, updated_at,
                   CASE WHEN private_school_id IS NULL THEN 'office' ELSE 'school' END AS scope
              FROM school_signatories
             WHERE builder_type IN ('tuition','shared')
               AND (private_school_id IS NULL" . ($psid !== null ? " OR private_school_id = :psid" : "") . ")
             ORDER BY role ASC, is_default DESC, scope ASC, id ASC";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($psid !== null ? [':psid' => $psid] : []);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $grouped = [];
    foreach ($rows as $row) {
        $r = $row['role'];
        if (!isset($grouped[$r])) $grouped[$r] = [];
        $grouped[$r][] = $row;
    }
    jsonSuccess([
        'signatories' => $rows,
        'grouped'     => $grouped ?: (object)[],
        'school_id'   => $psid,
    ], 'Signatories retrieved successfully.');
}

function handleSaveSignatoryTuition(PDO $pdo, array $user, array $body): void
{
    ensureSignatoriesTableTuition($pdo);
    $psid = resolvePrivateSchoolIdTuition($pdo, $user);
    if (!$psid) jsonError('No school linked to this account.', 422);

    $id       = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : null;
    $role     = mb_substr(trim((string)($body['role']           ?? '')), 0, 60);
    $fn       = mb_substr(trim((string)($body['full_name']      ?? '')), 0, 255);
    $pos      = mb_substr(trim((string)($body['position_title'] ?? '')), 0, 255);
    $ofc      = mb_substr(trim((string)($body['office']         ?? '')), 0, 255);
    $city     = mb_substr(trim((string)($body['city']           ?? '')), 0, 100);
    $con      = mb_substr(trim((string)($body['contact']        ?? '')), 0, 60);
    $isd      = !empty($body['is_default']) ? 1 : 0;

    if ($role === '') jsonError('Signatory role is required.', 422);
    if ($fn === '')   jsonError('Signatory full name is required.', 422);
    if (isOfficeOnlyRoleTuition($role)) {
        jsonError('This role is managed by the SDO/SMME office only. Ask your Division office to update it in Settings.', 422);
    }

    if ($isd) {
        $pdo->prepare("UPDATE school_signatories SET is_default = 0 WHERE private_school_id = :psid AND role = :role")
            ->execute([':psid' => $psid, ':role' => $role]);
    }

    if ($id !== null) {
        $chk = $pdo->prepare("SELECT id FROM school_signatories WHERE id = :id AND private_school_id = :psid LIMIT 1");
        $chk->execute([':id' => $id, ':psid' => $psid]);
        if (!$chk->fetchColumn()) jsonError('Signatory not found or access denied.', 404);
        $pdo->prepare(
            "UPDATE school_signatories
                SET role=:role,builder_type=:btype,full_name=:fn,position_title=:pos,office=:ofc,city=:city,contact=:con,is_default=:isd,updated_at=NOW()
              WHERE id=:id AND private_school_id=:psid"
        )->execute([':role'=>$role,':btype'=>signatoryBuilderType($role),':fn'=>$fn,':pos'=>$pos,':ofc'=>$ofc,':city'=>$city,':con'=>$con,':isd'=>$isd,':id'=>$id,':psid'=>$psid]);
        jsonSuccess(['id' => $id, 'is_default' => $isd], 'Signatory updated successfully.');
    }

    $ins = $pdo->prepare(
        "INSERT INTO school_signatories (private_school_id,role,builder_type,full_name,position_title,office,city,contact,is_default)
         VALUES (:psid,:role,:btype,:fn,:pos,:ofc,:city,:con,:isd)"
    );
    $ins->execute([':psid'=>$psid,':role'=>$role,':btype'=>signatoryBuilderType($role),':fn'=>$fn,':pos'=>$pos,':ofc'=>$ofc,':city'=>$city,':con'=>$con,':isd'=>$isd]);
    jsonSuccess(['id' => (int)$pdo->lastInsertId(), 'is_default' => $isd], 'Signatory saved successfully.');
}

function handleDeleteSignatoryTuition(PDO $pdo, array $user, array $body): void
{
    ensureSignatoriesTableTuition($pdo);
    $psid = resolvePrivateSchoolIdTuition($pdo, $user);
    if (!$psid) jsonError('No school linked.', 422);
    $id = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : 0;
    if (!$id) jsonError('Signatory id required.', 422);
    $del = $pdo->prepare("DELETE FROM school_signatories WHERE id=:id AND private_school_id=:psid LIMIT 1");
    $del->execute([':id' => $id, ':psid' => $psid]);
    if ($del->rowCount() === 0) jsonError('Signatory not found or access denied.', 404);
    jsonSuccess(['id' => $id], 'Signatory deleted.');
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(PDO $pdo, int $userId): void
{
    // Fix D: Use COALESCE for columns that may not exist on older table installs.
    // The ensureTuitionDocumentsTable() ALTER adds them, but on the very first
    // request they might still be missing if the ALTER hasn't committed yet.
    $stmt = $pdo->prepare('
        SELECT id, title, mode, increase_pct, current_sy, proposed_sy,
               has_kinder,
               COALESCE(has_elem, 1)  AS has_elem,
               has_jhs,
               COALESCE(has_shs, 0)   AS has_shs,
               kinder_total_curr, kinder_total_prop,
               COALESCE(elem_total_curr, 0)  AS elem_total_curr,
               COALESCE(elem_total_prop, 0)  AS elem_total_prop,
               jhs_total_curr, jhs_total_prop,
               COALESCE(shs_total_curr, 0)   AS shs_total_curr,
               COALESCE(shs_total_prop, 0)   AS shs_total_prop,
               status, active_step, created_at, updated_at,
               COALESCE(edit_request_status, \'none\') AS edit_request_status
        FROM school_tuition_documents
        WHERE user_id = :uid
        ORDER BY updated_at DESC
    ');
    $stmt->execute([':uid' => $userId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    jsonSuccess(['documents' => $rows, 'count' => count($rows)], 'Documents retrieved successfully.');
}

function handleLoad(PDO $pdo, int $userId, int $id): void
{
    $stmt = $pdo->prepare(
        'SELECT * FROM school_tuition_documents WHERE id = :id AND user_id = :uid LIMIT 1'
    );
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        jsonError('Document not found or access denied.', 404);
    }

    $row['payload_json'] = json_decode((string) $row['payload_json'], true);
    jsonSuccess($row, 'Document loaded successfully.');
}

function handleSave(PDO $pdo, array $user, ?int $privateSchoolId, array $body): void
{
    $userId = (int) $user['id'];

    $payload = $body['payload'] ?? null;
    if (!is_array($payload)) {
        jsonError('Missing or invalid payload object.', 422);
    }

    $id          = isset($body['id']) && is_numeric($body['id']) ? (int) $body['id'] : null;
    $mode        = in_array($body['mode'] ?? '', ['increase', 'no_increase'], true)
                   ? $body['mode'] : 'increase';
    // FIX #3: Validate increase_pct range on save (0–100)
    $increasePct = $mode === 'increase' ? max(0.0, min(100.0, (float) ($body['increase_pct'] ?? 0))) : 0.0;
    $currentSY   = mb_substr(trim((string) ($body['current_sy']  ?? '')), 0, 20);
    $proposedSY  = mb_substr(trim((string) ($body['proposed_sy'] ?? '')), 0, 20);
    // FIX #15: persist has_elem and has_shs
    $hasKinder   = (int) (bool) ($body['has_kinder'] ?? true);
    $hasElem     = (int) (bool) ($body['has_elem']   ?? true);
    $hasJHS      = (int) (bool) ($body['has_jhs']    ?? true);
    $hasSHS      = (int) (bool) ($body['has_shs']    ?? false);
    $activeStep  = max(1, min(4, (int) ($body['active_step'] ?? 1)));

    // Recompute all proposed/increase values server-side — client values are discarded.
    $payload = recomputePayload($payload, $mode, $increasePct);

    // Re-read totals from the recomputed payload
    $kinderCurr = (float) ($payload['kinder']['total_curr'] ?? 0);
    $kinderProp = (float) ($payload['kinder']['total_prop'] ?? 0);
    $elemCurr   = (float) ($payload['elem']['total_curr']   ?? 0);
    $elemProp   = (float) ($payload['elem']['total_prop']   ?? 0);
    $jhsCurr    = (float) ($payload['jhs']['total_curr']    ?? 0);
    $jhsProp    = (float) ($payload['jhs']['total_prop']    ?? 0);
    $shsCurr    = (float) ($payload['shs']['total_curr']    ?? 0);
    $shsProp    = (float) ($payload['shs']['total_prop']    ?? 0);

    $schoolName  = trim((string) ($body['school_name'] ?? $payload['form']['school_name'] ?? ''));
    $titleSuffix = $proposedSY !== '' ? " ({$proposedSY})" : '';
    $title = $schoolName !== ''
        ? "Tuition Fee — {$schoolName}{$titleSuffix}"
        : "Tuition Fee Document{$titleSuffix}";
    $title = mb_substr($title, 0, 255);

    $payload['form']['increase_pct'] = $increasePct;
    $payload['form']['current_sy']   = $currentSY;
    $payload['form']['proposed_sy']  = $proposedSY;

    // BUG FIX: PHP's json_encode() turns an empty PHP array ([]) into the
    // JSON array "[]" instead of "{}", since PHP has no native distinction
    // between an empty associative array and an empty list. When the
    // checklist hasn't been touched yet, payload['supporting_docs'] arrives
    // here as an empty array — encode it as a JSON object explicitly so it
    // round-trips correctly and the frontend never mistakes it for a list.
    if (isset($payload['supporting_docs']) && is_array($payload['supporting_docs']) && empty($payload['supporting_docs'])) {
        $payload['supporting_docs'] = (object) [];
    }

    $payloadJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($payloadJson === false) {
        jsonError('Failed to encode tuition payload.', 500);
    }

    $dbIncreasePct = $mode === 'increase' ? $increasePct : null;

    if ($id !== null) {
        $chk = $pdo->prepare(
            'SELECT id, status FROM school_tuition_documents WHERE id = :id AND user_id = :uid LIMIT 1'
        );
        $chk->execute([':id' => $id, ':uid' => $userId]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);

        if (!$existing) {
            jsonError('Document not found or access denied.', 404);
        }

        if ($existing['status'] === 'submitted' || $existing['status'] === 'Pending Review') {
            // Allow saving if the matching school_submissions row has been
            // "Returned for Correction" by the SDO/admin — in that case the
            // tuition document was never reset to draft (the admin side only
            // updates school_submissions.status), so we reset it here and
            // allow the school to save their corrections before resubmitting.
            $isReturned = false;
            try {
                $retChk = $pdo->prepare(
                    "SELECT id FROM school_submissions
                     WHERE (calendar_document_id = :doc_id OR file_path = :file_path)
                       AND type = 'tuition'
                       AND LOWER(TRIM(status)) IN (
                           'returned for correction',
                           'returned_for_correction',
                           'returned',
                           'rejected'
                       )
                     LIMIT 1"
                );
                $retChk->execute([
                    ':doc_id'    => $id,
                    ':file_path' => 'school_tuition_documents:' . $id,
                ]);
                $isReturned = (bool) $retChk->fetchColumn();
            } catch (Throwable $retEx) {
                error_log('handleSave: returned-check error: ' . $retEx->getMessage());
            }

            if (!$isReturned) {
                jsonError('Cannot overwrite a submitted document.', 409);
            }

            // Reset the tuition document to draft so subsequent saves
            // and the final re-submission flow work normally.
            try {
                $pdo->prepare(
                    "UPDATE school_tuition_documents
                     SET status = 'draft', updated_at = NOW()
                     WHERE id = :id AND user_id = :uid"
                )->execute([':id' => $id, ':uid' => $userId]);
                $existing['status'] = 'draft';
            } catch (Throwable $resetEx) {
                error_log('handleSave: status reset error: ' . $resetEx->getMessage());
                jsonError('Failed to reset document status for correction. Please try again.', 500);
            }
        }

        try {
            $stmt = $pdo->prepare('
                UPDATE school_tuition_documents SET
                    title              = :title,
                    mode               = :mode,
                    increase_pct       = :pct,
                    current_sy         = :csy,
                    proposed_sy        = :psy,
                    has_kinder         = :hk,
                    has_elem           = :he,
                    has_jhs            = :hj,
                    has_shs            = :hs,
                    payload_json       = :payload,
                    kinder_total_curr  = :ktc,
                    kinder_total_prop  = :ktp,
                    elem_total_curr    = :etc,
                    elem_total_prop    = :etp,
                    jhs_total_curr     = :jtc,
                    jhs_total_prop     = :jtp,
                    shs_total_curr     = :stc,
                    shs_total_prop     = :stp,
                    active_step        = :step,
                    private_school_id  = :private_school_id,
                    edit_request_status = \'none\',
                    updated_at         = NOW()
                WHERE id = :id AND user_id = :uid
            ');
            $stmt->execute([
                ':title'       => $title,          ':mode'        => $mode,
                ':pct'         => $dbIncreasePct,  ':csy'         => $currentSY,
                ':psy'         => $proposedSY,     ':hk'          => $hasKinder,
                ':he'          => $hasElem,        ':hj'          => $hasJHS,
                ':hs'          => $hasSHS,         ':payload'     => $payloadJson,
                ':ktc'              => $kinderCurr,     ':ktp'               => $kinderProp,
                ':etc'              => $elemCurr,       ':etp'               => $elemProp,
                ':jtc'              => $jhsCurr,        ':jtp'               => $jhsProp,
                ':stc'              => $shsCurr,        ':stp'               => $shsProp,
                ':step'             => $activeStep,
                ':private_school_id'=> $privateSchoolId,
                ':id'               => $id,             ':uid'               => $userId,
            ]);
        } catch (Throwable $e) {
            // Fix G: log full exception trace to help diagnose column/schema issues
            error_log('school-portal-tuition.php UPDATE error: ' . $e->getMessage()
                . ' | SQL state: ' . $e->getCode());
            jsonError('Failed to update tuition document: ' . $e->getMessage(), 500);
        }

        // Fix F: rowCount() returns 0 when UPDATE matches a row but no values changed.
        // We already confirmed the row exists via the SELECT above, so a 0 rowCount
        // here is not an error — just means nothing needed updating.
        jsonSuccess([
            'document_id' => $id,
            'title'       => $title,
            'status'      => $existing['status'],
            'active_step' => $activeStep,
            'edit_request_status' => 'none',
        ], 'Tuition document updated successfully.');
    }

    try {
        $insert = $pdo->prepare('
            INSERT INTO school_tuition_documents
                (user_id, private_school_id, title, mode, increase_pct,
                 current_sy, proposed_sy,
                 has_kinder, has_elem, has_jhs, has_shs,
                 payload_json,
                 kinder_total_curr, kinder_total_prop,
                 elem_total_curr,   elem_total_prop,
                 jhs_total_curr,    jhs_total_prop,
                 shs_total_curr,    shs_total_prop,
                 status, active_step, created_at, updated_at)
            VALUES
                (:uid, :psid, :title, :mode, :pct,
                 :csy, :psy,
                 :hk, :he, :hj, :hs,
                 :payload,
                 :ktc, :ktp, :etc, :etp, :jtc, :jtp, :stc, :stp,
                 \'draft\', :step, NOW(), NOW())
        ');
        $insert->execute([
            ':uid'     => $userId,      ':psid'   => $privateSchoolId,
            ':title'   => $title,       ':mode'   => $mode,       ':pct'   => $dbIncreasePct,
            ':csy'     => $currentSY,   ':psy'    => $proposedSY,
            ':hk'      => $hasKinder,   ':he'     => $hasElem,    ':hj'    => $hasJHS, ':hs' => $hasSHS,
            ':payload' => $payloadJson,
            ':ktc'     => $kinderCurr,  ':ktp'    => $kinderProp,
            ':etc'     => $elemCurr,    ':etp'    => $elemProp,
            ':jtc'     => $jhsCurr,     ':jtp'    => $jhsProp,
            ':stc'     => $shsCurr,     ':stp'    => $shsProp,
            ':step'    => $activeStep,
        ]);
    } catch (Throwable $e) {
        // Fix G: log full exception trace to help diagnose column/schema issues
        error_log('school-portal-tuition.php INSERT error: ' . $e->getMessage()
            . ' | SQL state: ' . $e->getCode());
        jsonError('Failed to save tuition document: ' . $e->getMessage(), 500);
    }

    $newId = (int) $pdo->lastInsertId();

    jsonSuccess([
        'document_id' => $newId,
        'title'       => $title,
        'status'      => 'draft',
        'active_step' => $activeStep,
    ], 'Tuition document saved successfully.', 201);
}

function handleSubmit(PDO $pdo, array $user, ?int $privateSchoolId, int $id): void
{
    $userId = (int) $user['id'];

    $stmt = $pdo->prepare(
        'SELECT * FROM school_tuition_documents WHERE id = :id AND user_id = :uid LIMIT 1'
    );
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $doc = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$doc) {
        jsonError('Document not found or access denied.', 404);
    }

    // FIX #2: Block re-submission of already-submitted documents
    if ($doc['status'] === 'Pending Review') {
        jsonError('This document has already been submitted and is pending review.', 409);
    }

    // FIX #1 & #3: Re-validate increase_pct and recompute payload on submit
    // so a draft saved with a tampered payload cannot bypass server-side checks.
    $storedPayload = json_decode((string) $doc['payload_json'], true);
    if (!is_array($storedPayload)) {
        jsonError('Stored payload is corrupt. Please re-save the document and try again.', 422);
    }

    $mode        = $doc['mode'];
    $increasePct = $mode === 'increase'
        ? max(0.0, min(100.0, (float) ($doc['increase_pct'] ?? 0)))
        : 0.0;
    $recomputed = recomputePayload($storedPayload, $mode, $increasePct);

    // BUG FIX: same JSON object/array ambiguity as in handleSave() — force
    // an empty supporting_docs back to a JSON object so it never round-trips
    // as [] and silently breaks the frontend checklist state.
    if (isset($recomputed['supporting_docs']) && is_array($recomputed['supporting_docs']) && empty($recomputed['supporting_docs'])) {
        $recomputed['supporting_docs'] = (object) [];
    }

    $doc['payload_json'] = json_encode($recomputed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    // ── DepEd compliance gate ─────────────────────────────────────────────────
    // COMPLIANCE: Validate all DepEd policy rules before allowing final submission.
    // This is the authoritative server-side check — the JS performs the same checks
    // as a UX convenience, but this PHP gate cannot be bypassed by a crafted request.
    $complianceErrors = validateDepEdCompliance($doc, $recomputed);
    if (!empty($complianceErrors)) {
        jsonError(
            'Submission blocked: the document does not meet DepEd compliance requirements.',
            422,
            ['compliance_errors' => $complianceErrors]
        );
    }

    // FIX #6: Wrap status update and bridge upsert in a transaction so a bridge
    // failure cannot leave the document stuck in 'submitted' with no submission row.
    try {
        $pdo->beginTransaction();

        $pdo->prepare(
            "UPDATE school_tuition_documents SET status = 'Pending Review', updated_at = NOW() WHERE id = :id"
        )->execute([':id' => $id]);

        $bridgeAction = upsertTuitionSubmission($pdo, $user, $id, $doc);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('school-portal-tuition.php SUBMIT error: ' . $e->getMessage());
        jsonError('Failed to submit tuition document. Please try again.', 500);
    }

    logTuitionBridgeAudit($pdo, $user, $id, $doc['title'], $bridgeAction);

    // ── SDO/admin-side notification (non-fatal if table absent) ──────────────
    $schoolName = '';
    try {
        // Prefer payload school_name → private_schools.name
        $schoolName = (string) ($recomputed['form']['school_name'] ?? '');
        if ($schoolName === '' && $privateSchoolId) {
            $snRow = $pdo->prepare("SELECT name FROM private_schools WHERE id = :sid LIMIT 1");
            $snRow->execute([':sid' => $privateSchoolId]);
            $schoolName = (string) ($snRow->fetchColumn() ?: '');
        }
    } catch (Throwable $_) { /* school name lookup is best-effort */ }

    insertSchoolNotificationForTuition($pdo, null, $privateSchoolId, $doc['title']);
    $districtId = !empty($user['district_id']) ? (int) $user['district_id'] : null;
    insertSDONotificationForTuition($pdo, $privateSchoolId, $districtId, $schoolName, $doc['title'], $id);

    jsonSuccess([
        'document_id'   => $id,
        'title'         => $doc['title'],
        'status'        => 'Pending Review',
        'bridge_action' => $bridgeAction,
    ], 'Tuition document submitted successfully.');
}

function handleEditRequest(PDO $pdo, array $user, int $id, string $reason): void
{
    $userId          = (int) $user['id'];
    $privateSchoolId = !empty($user['private_school_id']) ? (int) $user['private_school_id'] : null;

    // Re-fetch private_school_id if absent from auth middleware.
    if ($privateSchoolId === null && !array_key_exists('private_school_id', $user)) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $psVal = $psRow->fetchColumn();
            $privateSchoolId = ($psVal !== false && $psVal !== null) ? (int) $psVal : null;
        } catch (Throwable $e) {
            error_log('handleEditRequest (tuition): could not fetch private_school_id — ' . $e->getMessage());
        }
    }

    if (!$privateSchoolId) {
        jsonError('Your account is not linked to a school.', 422);
    }

    // Verify the document belongs to this user and is actually submitted.
    $doc = null;
    try {
        $sel = $pdo->prepare(
            "SELECT id, status, title FROM school_tuition_documents
             WHERE id = :id AND user_id = :uid LIMIT 1"
        );
        $sel->execute([':id' => $id, ':uid' => $userId]);
        $doc = $sel->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('handleEditRequest (tuition) fetch: ' . $e->getMessage());
        jsonError('Failed to look up document.', 500);
    }

    if (!$doc) {
        jsonError('Document not found or access denied.', 404);
    }

    $editableStatuses = ['submitted', 'pending', 'pending_review', 'pending review'];
    if (!in_array(strtolower(trim((string) $doc['status'])), $editableStatuses, true)) {
        jsonError('Edit requests can only be made for submitted documents that are still pending review.', 409);
    }

    // Look up matching school_submission row to record the edit request.
    $submissionId = null;
    if (tableHasColumn($pdo, 'school_submissions', 'calendar_document_id')) {
        try {
            $sel2 = $pdo->prepare(
                "SELECT id, status, history_json
                 FROM school_submissions
                 WHERE calendar_document_id = :doc_id
                   AND private_school_id    = :school_id
                   AND type                 = 'tuition'
                 ORDER BY id DESC LIMIT 1"
            );
            $sel2->execute([':doc_id' => $id, ':school_id' => $privateSchoolId]);
            $sub = $sel2->fetch(PDO::FETCH_ASSOC);
            if ($sub) {
                $submissionId = (int) $sub['id'];
            }
        } catch (Throwable $e) {
            error_log('handleEditRequest (tuition) submission lookup: ' . $e->getMessage());
        }
    }

    // Append edit request to history_json if the column exists.
    if ($submissionId && tableHasColumn($pdo, 'school_submissions', 'history_json')) {
        try {
            $histRaw = $sub['history_json'] ?? '[]';
            $history = json_decode($histRaw, true);
            if (!is_array($history)) $history = [];
            $history[] = [
                'event'      => 'edit_request',
                'by'         => trim((string) ($user['full_name'] ?? $user['email'] ?? 'Portal User')),
                'reason'     => $reason,
                'created_at' => date('Y-m-d H:i:s'),
            ];
            $pdo->prepare(
                "UPDATE school_submissions SET history_json = :hj WHERE id = :id"
            )->execute([':hj' => json_encode($history), ':id' => $submissionId]);
        } catch (Throwable $e) {
            error_log('handleEditRequest (tuition) history update: ' . $e->getMessage());
        }
    }

    // Notify SDO about the edit request (non-fatal).
    try {
        $schoolName = trim((string) ($user['full_name'] ?? $user['email'] ?? 'A school'));
        $districtId = !empty($user['district_id']) ? (int) $user['district_id'] : null;
        $msgBody    = sprintf(
            '"%s" has requested permission to edit tuition document "%s". Reason: %s',
            $schoolName,
            $doc['title'],
            $reason !== '' ? $reason : '(none provided)'
        );

        $tables = ['admin_notifications', 'sdo_notifications'];
        $targetTable = null;
        foreach ($tables as $tbl) {
            try {
                if ($pdo->query("SHOW TABLES LIKE '{$tbl}'")->fetchColumn()) {
                    $targetTable = $tbl; break;
                }
            } catch (Throwable $e) {}
        }

        if ($targetTable) {
            $cols = $pdo->query("DESCRIBE `{$targetTable}`")->fetchAll(PDO::FETCH_COLUMN);
            $hasDistrictId = in_array('district_id', $cols, true);
            $hasLink       = in_array('link',        $cols, true);
            $hasDocId      = in_array('document_id', $cols, true) || in_array('calendar_document_id', $cols, true);
            $docColName    = in_array('document_id', $cols, true) ? 'document_id' : 'calendar_document_id';

            $baseCols = ['type', 'title', 'message', 'is_read', 'created_at'];
            $baseVals = [':type', ':notif_title', ':message', '0', 'NOW()'];
            $params   = [
                ':type'        => 'tuition_edit_request',
                ':notif_title' => 'Edit Request — Tuition Fee Document',
                ':message'     => $msgBody,
            ];
            if ($hasDistrictId && $districtId) {
                $baseCols[] = 'district_id'; $baseVals[] = ':district_id';
                $params[':district_id'] = $districtId;
            }
            if ($hasLink) {
                $baseCols[] = 'link'; $baseVals[] = ':link';
                $params[':link'] = 'documents-submitted-all.html';
            }
            if ($hasDocId) {
                $baseCols[] = $docColName; $baseVals[] = ':doc_id';
                $params[':doc_id'] = $id;
            }

            $sql = "INSERT INTO `{$targetTable}` (" . implode(', ', $baseCols) . ")
                    VALUES (" . implode(', ', $baseVals) . ")";
            $pdo->prepare($sql)->execute($params);
        }
    } catch (Throwable $e) {
        error_log('handleEditRequest (tuition) SDO notification: ' . $e->getMessage());
    }

    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => trim((string) ($user['role'] ?? $user['account_type'] ?? 'portal_user')),
        'action'        => 'tuition_edit_request',
        'module'        => 'school_tuition',
        'status'        => 'success',
        'description'   => sprintf(
            'Edit request submitted for tuition document id=%d | reason=%s',
            $id,
            $reason !== '' ? $reason : '(none)'
        ),
        'document_type' => 'Tuition Fee',
        'file_name'     => 'tuition-builder-' . $id . '.json',
    ]);

    // BUG FIX: mark the edit request as pending on the document itself so the
    // "Request Edit Approval" button shows "Request Pending" (and stays
    // disabled) across page reloads, preventing duplicate requests. This is
    // reset back to 'none' in handleSave() once the document becomes editable
    // again (i.e. the SDO unlocks it and the school saves a new draft).
    try {
        $pdo->prepare(
            "UPDATE school_tuition_documents SET edit_request_status = 'pending' WHERE id = :id AND user_id = :uid"
        )->execute([':id' => $id, ':uid' => $userId]);
    } catch (Throwable $e) {
        error_log('handleEditRequest (tuition) edit_request_status update: ' . $e->getMessage());
    }

    jsonSuccess(
        ['document_id' => $id, 'submission_id' => $submissionId],
        'Edit request submitted. The SDO will review your request.'
    );
}

function handleDelete(PDO $pdo, int $userId, int $id): void
{
    // Fetch the document first to verify ownership and check deletability.
    // Deletable statuses: 'draft' (never submitted) and returned documents
    // (the JS shows the trash button for isReturned docs, so PHP must allow it).
    $doc = null;
    try {
        $sel = $pdo->prepare(
            "SELECT id, status FROM school_tuition_documents WHERE id = :id AND user_id = :uid LIMIT 1"
        );
        $sel->execute([':id' => $id, ':uid' => $userId]);
        $doc = $sel->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('school-portal-tuition.php DELETE fetch error: ' . $e->getMessage());
        jsonError('Failed to delete tuition document.', 500);
    }

    if (!$doc) {
        jsonError('Document not found or access denied.', 404);
    }

    // Only allow deletion of draft or returned documents.
    $deletableStatuses = ['draft', 'returned', 'returned_for_correction'];
    if (!in_array(strtolower(trim((string) $doc['status'])), $deletableStatuses, true)) {
        jsonError('Cannot delete — only draft or returned documents can be deleted.', 409);
    }

    try {
        $pdo->beginTransaction();

        // Remove the main document
        $pdo->prepare(
            "DELETE FROM school_tuition_documents WHERE id = :id AND user_id = :uid"
        )->execute([':id' => $id, ':uid' => $userId]);

        // Also remove the matching school_submissions row so the SDO queue and
        // notification count stay accurate. Without this the submission stays
        // visible to the SDO even after the school deletes it.
        if (tableHasColumn($pdo, 'school_submissions', 'calendar_document_id')) {
            $pdo->prepare(
                "DELETE FROM school_submissions
                 WHERE calendar_document_id = :doc_id AND type = 'tuition' AND user_id = :uid"
            )->execute([':doc_id' => $id, ':uid' => $userId]);
        } else {
            // Fallback: match by user + type + file_path if calendar_document_id
            // column is absent, so we only remove the row for THIS document.
            $filePath = 'school_tuition_documents:' . $id;
            $pdo->prepare(
                "DELETE FROM school_submissions
                 WHERE user_id = :uid AND type = 'tuition' AND file_path = :file_path
                 ORDER BY id DESC LIMIT 1"
            )->execute([':uid' => $userId, ':file_path' => $filePath]);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('school-portal-tuition.php DELETE error: ' . $e->getMessage());
        jsonError('Failed to delete tuition document.', 500);
    }

    jsonSuccess(['document_id' => $id], 'Tuition document deleted successfully.');
}