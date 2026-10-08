<?php
/**
 * certificates_api.php
 * Backend API for the Certificates & Files page
 * Database: smme_dashboard (MariaDB / MySQL)
 * Email: uses your project's EmailHelper class
 */

// SECURITY: Secure CORS configuration
$_base = dirname(__DIR__);
require_once $_base . '/config/security.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ─── PROJECT DEPENDENCIES ─────────────────────────────────────────────────────
require_once $_base . '/config/database.php';
require_once $_base . '/config/auth_middleware.php';
require_once $_base . '/helpers/EmailHelper.php';
require_once $_base . '/helpers/FileEncryption.php';

function respond(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function error(string $msg, int $code = 400): void {
    respond(['success' => false, 'error' => $msg], $code);
}

/**
 * Mirrors JS normaliseName() in certificates-splitter.js:
 * uppercase, transliterate accented chars, strip non-alpha to spaces.
 */
function phpNormaliseName(string $str): string {
    $str = strtoupper($str);
    $str = strtr($str, [
        'Ñ' => 'N',
        'Á' => 'A', 'À' => 'A', 'Â' => 'A', 'Ä' => 'A',
        'É' => 'E', 'È' => 'E', 'Ê' => 'E', 'Ë' => 'E',
        'Í' => 'I', 'Ì' => 'I', 'Î' => 'I', 'Ï' => 'I',
        'Ó' => 'O', 'Ò' => 'O', 'Ô' => 'O', 'Ö' => 'O',
        'Ú' => 'U', 'Ù' => 'U', 'Û' => 'U', 'Ü' => 'U',
    ]);
    $str = preg_replace('/[^A-Z\s]/', ' ', $str);
    $str = trim(preg_replace('/\s+/', ' ', $str));
    return $str;
}

// ─── AUTHENTICATION ───────────────────────────────────────────────────────────
global $pdo;
$pdo = getDB();
$authUser = authenticate();
if (!$authUser) {
    error('Unauthorized: Please log in', 401);
}
requirePermission('certificates', $authUser);

// ─── ROUTER ───────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? $_POST['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

// ─── ATTACHMENT HELPER ───────────────────────────────────────────────────────
// Decrypts a stored .enc certificate file to a temp .pdf path for emailing.
// Returns the temp path on success, or null if the source file doesn't exist.
// IMPORTANT: caller must @unlink() the returned path after sending.
function prepareCertAttachment(string $storedPath, string $displayName, FileEncryption $fe): ?string {
    if (!file_exists($storedPath)) return null;
    // Ensure display name ends with .pdf (strip any .enc suffix)
    $pdfName = preg_replace('/\.enc$/i', '', $displayName);
    if (!preg_match('/\.pdf$/i', $pdfName)) $pdfName .= '.pdf';
    // Sanitise so it's safe as a filename
    $pdfName = preg_replace('/[^a-zA-Z0-9 _\-\.\(\)]/u', '_', $pdfName);
    $tmpPath = sys_get_temp_dir() . '/' . uniqid('cert_') . '_' . $pdfName;
    try {
        // getDecryptedContents() checks for magic bytes and decrypts;
        // if the file was stored raw (no magic bytes) it throws, so we fall back
        $bytes = $fe->getDecryptedContents($storedPath);
    } catch (Throwable $e) {
        $bytes = file_get_contents($storedPath);
    }
    if ($bytes === false || $bytes === '') return null;
    file_put_contents($tmpPath, $bytes);
    return $tmpPath;
}

try {
    switch ($action) {

        // ── GET all workshops (for program dropdown) ──────────────────────────
        // Pattern mirrors programs.php handleGet():
        //   Part 1 — all workshops (standalone type = single-day participant list,
        //             container type = per-day counts from program_imports).
        //   Part 2 — standalone evaluation_programs (ep.workshop_id IS NULL),
        //             i.e. Excel imports not linked to any workshop row.
        //             Per-day breakdown comes from respondents.day_sheet.
        // NO references to workshop_days, evaluation_submissions, or evaluation_answers.
        case 'get_workshops':

            // ── Part 1: workshops (standalone + container) ────────────────────
            $wsStmt = $pdo->query(
                "SELECT
                    w.id,
                    w.title,
                    w.division_memo,
                    w.venue,
                    w.status,
                    w.start_date,
                    w.end_date,
                    w.total_days,
                    w.total_participants,
                    w.proponents,
                    w.program_type,
                    'workshop' AS source_type,
                    (SELECT COUNT(*)
                     FROM workshop_participants wp
                     WHERE wp.workshop_id = w.id) AS actual_participants
                 FROM workshops w
                 WHERE w.program_type = 'container'
                 ORDER BY w.start_date DESC, w.id DESC"
            );
            $workshopRows = $wsStmt->fetchAll(PDO::FETCH_ASSOC);

            // ── Collect container IDs for a single batch import fetch ─────────
            $containerIds = [];
            foreach ($workshopRows as $row) {
                if (($row['program_type'] ?? '') === 'container') {
                    $containerIds[] = (int)$row['id'];
                }
            }

            // Batch-fetch program_imports for all container workshops at once
            $importsByWorkshop = [];
            if (!empty($containerIds)) {
                $ph = implode(',', array_fill(0, count($containerIds), '?'));
                $impBatch = $pdo->prepare(
                    "SELECT pi.workshop_id,
                            COALESCE(pi.day_label, CONCAT('Day ', pi.day_number)) AS day_label,
                            pi.day_number,
                            COALESCE(ep.total_participants, ep.total_responses, 0) AS count
                     FROM program_imports pi
                     LEFT JOIN evaluation_programs ep ON ep.id = pi.program_id
                     WHERE pi.workshop_id IN ($ph)
                     ORDER BY pi.workshop_id ASC, pi.day_number ASC, pi.imported_at ASC"
                );
                $impBatch->execute($containerIds);
                foreach ($impBatch->fetchAll(PDO::FETCH_ASSOC) as $imp) {
                    $importsByWorkshop[$imp['workshop_id']][] = $imp;
                }
            }

            // Enrich each workshop row
            foreach ($workshopRows as &$row) {
                // Use actual participant count when total_participants is null
                if (empty($row['total_participants'])) {
                    $row['total_participants'] = $row['actual_participants'];
                }
                unset($row['actual_participants']);

                if (($row['program_type'] ?? '') === 'container') {
                    // Container: one day entry per linked program_import
                    $imports   = $importsByWorkshop[$row['id']] ?? [];
                    $dayCounts = [];
                    foreach ($imports as $imp) {
                        $dayCounts[] = [
                            'day_number' => (int)$imp['day_number'],
                            'day_label'  => $imp['day_label'],
                            'day_date'   => null,
                            'count'      => (int)$imp['count'],
                        ];
                    }
                    $row['total_days'] = count($dayCounts) ?: (int)($row['total_days'] ?? 1);
                } else {
                    // Standalone workshop: single entry, count from workshop_participants
                    $dayCounts = [[
                        'day_number' => 1,
                        'day_label'  => 'Day 1',
                        'day_date'   => $row['start_date'] ?? null,
                        'count'      => (int)($row['total_participants'] ?? 0),
                    ]];
                }
                $row['day_counts'] = $dayCounts;
            }
            unset($row);

            // ── Part 2: standalone evaluation_programs (no workshop row) ──────
            // These are Excel imports saved without linking to any workshop.
            // Mirrors programs.php Part 2 (standalone Excel imports).
            $epStmt = $pdo->query(
                "SELECT
                    ep.id,
                    ep.title,
                    ep.division_memo,
                    COALESCE(ep.start_date, ep.inclusive_dates) AS start_date,
                    ep.end_date,
                    ep.training_venue  AS venue,
                    ep.status,
                    ep.total_participants,
                    ep.proponents,
                    ep.source_filename,
                    'record'           AS source_type,
                    1                  AS total_days
                 FROM evaluation_programs ep
                 WHERE ep.workshop_id IS NULL
                 ORDER BY ep.created_at DESC"
            );
            $standaloneRows = $epStmt->fetchAll(PDO::FETCH_ASSOC);

            // Per-day breakdown for standalone programs via respondents.day_sheet
            // (same approach as programs.php Part 2b)
            $standaloneIds = array_column($standaloneRows, 'id');
            $daySheetsByProgram = [];
            if (!empty($standaloneIds)) {
                $ph2 = implode(',', array_fill(0, count($standaloneIds), '?'));
                $dsStmt = $pdo->prepare(
                    "SELECT r.program_id,
                            TRIM(r.day_sheet)             AS day_label,
                            COUNT(DISTINCT r.id)           AS count
                     FROM respondents r
                     WHERE r.program_id IN ($ph2)
                       AND r.day_sheet IS NOT NULL
                       AND r.day_sheet != ''
                     GROUP BY r.program_id, TRIM(r.day_sheet)
                     ORDER BY r.program_id ASC, TRIM(r.day_sheet) ASC"
                );
                $dsStmt->execute(array_values($standaloneIds));
                foreach ($dsStmt->fetchAll(PDO::FETCH_ASSOC) as $ds) {
                    $daySheetsByProgram[$ds['program_id']][] = [
                        'day_number' => null,
                        'day_label'  => $ds['day_label'],
                        'day_date'   => null,
                        'count'      => (int)$ds['count'],
                    ];
                }
            }

            foreach ($standaloneRows as &$row) {
                $dayCounts = $daySheetsByProgram[$row['id']] ?? [];
                $row['day_counts'] = $dayCounts;
                if (count($dayCounts) > 1) {
                    $row['total_days'] = count($dayCounts);
                }
            }
            unset($row);

            // Merge: workshops first, then standalone Excel imports
            $rows = array_merge($workshopRows, $standaloneRows);

            respond(['success' => true, 'data' => $rows]);

        // ── GET participant roles ─────────────────────────────────────────────
        case 'get_participant_roles':
            $rows = $pdo->query(
                "SELECT id, role_name, description, display_order 
                 FROM participant_roles 
                 WHERE is_active = 1 
                 ORDER BY display_order, role_name"
            )->fetchAll();
            respond(['success' => true, 'data' => $rows]);

        // ── GET participants for a workshop ───────────────────────────────────
        // If the ID belongs to an orphaned evaluation_programs record (no
        // matching row in workshops), fall back to the respondents table which
        // is where Excel-import data actually lives.
        case 'get_participants':
            $workshopId = $_GET['workshop_id'] ?? null;

            // Check if orphan (NULL or invalid workshop)
            $chk = $pdo->prepare("
                SELECT COUNT(*) FROM evaluation_programs 
                WHERE id = ? 
                AND (workshop_id IS NULL 
                    OR workshop_id NOT IN (SELECT id FROM workshops))
            ");
            $chk->execute([$workshopId]);
            $isOrphan = $chk->fetchColumn() > 0;

            if ($isOrphan) {
                // 👉 USE respondents (Excel source) — fetch all rows, dedup in PHP
                //
                // IMPORTANT: A multi-day container workshop has one evaluation_programs
                // row per day (linked via program_imports). The caller passes ONE of
                // those day-program IDs as workshop_id. We must collect ALL sibling
                // program IDs that share the same parent workshop so that respondents
                // from every day are included — then deduplicate by email in PHP.
                // Without this, only Day N respondents show up, not the full roster.

                // Step 1: find the parent workshop_id for this program (may be NULL)
                $parentStmt = $pdo->prepare("
                    SELECT workshop_id FROM evaluation_programs WHERE id = ?
                ");
                $parentStmt->execute([$workshopId]);
                $parentRow = $parentStmt->fetch(PDO::FETCH_ASSOC);
                $parentWorkshopId = $parentRow ? $parentRow['workshop_id'] : null;

                // Step 2: collect all sibling program IDs that share the same parent,
                // OR just use the single program ID if there is no parent workshop.
                if ($parentWorkshopId) {
                    $sibStmt = $pdo->prepare("
                        SELECT ep.id
                        FROM evaluation_programs ep
                        INNER JOIN program_imports pi ON pi.program_id = ep.id
                        WHERE pi.workshop_id = ?
                    ");
                    $sibStmt->execute([$parentWorkshopId]);
                    $allProgramIds = $sibStmt->fetchAll(PDO::FETCH_COLUMN);
                    // Always include the requested ID in case it's missing from program_imports
                    if (!in_array($workshopId, $allProgramIds)) {
                        $allProgramIds[] = $workshopId;
                    }
                } else {
                    $allProgramIds = [$workshopId];
                }

                $ph = implode(',', array_fill(0, count($allProgramIds), '?'));
                $stmt = $pdo->prepare("
                    SELECT
                        r.id,
                        r.respondent_name                AS full_name,
                        r.email,
                        r.sex,
                        r.designation,
                        r.participant_type,
                        r.school_office,
                        r.cert_file_id
                    FROM respondents r
                    WHERE r.program_id IN ($ph)
                    ORDER BY r.id ASC
                ");
                $stmt->execute(array_values($allProgramIds));
            } else {
                // 👉 USE workshop_participants (normal) — fetch all rows, dedup in PHP
                $stmt = $pdo->prepare("
                    SELECT
                        wp.id,
                        wp.full_name,
                        wp.email,
                        wp.sex,
                        wp.designation,
                        wp.participant_type,
                        wp.school_office,
                        wp.cert_file_id
                    FROM workshop_participants wp
                    WHERE wp.workshop_id = ?
                    ORDER BY wp.id ASC
                ");
                $stmt->execute([$workshopId]);
            }

            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // ── PHP-level name deduplication ──────────────────────────────────
            // Converts any name format to a sorted set of alpha tokens so that
            // "Daryl M. Purisima" and "Purisima, Daryl, M" both become
            // the same key: ["DARYL", "M", "PURISIMA"].
            // When duplicates are found, the row with the most data wins
            // (has email > has cert > lowest id).
            $nameKey = function(string $name): string {
                // uppercase, strip accents best-effort, remove non-alpha chars
                $n = strtoupper($name);
                $n = strtr($n, [
                    'Ñ'=>'N','Á'=>'A','À'=>'A','Â'=>'A','Ä'=>'A',
                    'É'=>'E','È'=>'E','Ê'=>'E','Ë'=>'E',
                    'Í'=>'I','Ì'=>'I','Î'=>'I','Ï'=>'I',
                    'Ó'=>'O','Ò'=>'O','Ô'=>'O','Ö'=>'O',
                    'Ú'=>'U','Ù'=>'U','Û'=>'U','Ü'=>'U',
                ]);
                $tokens = preg_split('/[^A-Z]+/', $n, -1, PREG_SPLIT_NO_EMPTY);
                // Filter out single-letter middle initials only if there are 3+
                // tokens so "M" in "Daryl M. Purisima" doesn't block the match
                // — actually keep all tokens but sort so order doesn't matter.
                sort($tokens);
                return implode('|', $tokens);
            };

            $seen   = []; // nameKey => index in $data
            $seenEmails = []; // email => index in $data (primary dedup for orphan records)
            $data   = [];

            foreach ($rows as $row) {
                $key = $nameKey($row['full_name'] ?? '');
                $normalised = strtoupper(trim($row['full_name'] ?? ''));
                if ($key === '' || $normalised === 'UNKNOWN') {
                    $data[] = $row; // blank or unknown name — keep every row as-is, never dedup
                    continue;
                }

                // For orphan (Excel import) records, full_name is actually the email.
                // Use email as the primary dedup key so same person across multiple day
                // sheets is collapsed into one row.
                $emailKey = strtolower(trim($row['email'] ?? ''));
                $isRealEmail = $emailKey && !in_array($emailKey, ['anonymous', 'n/a', 'none', 'na', '-', '']);
                if ($isRealEmail && isset($seenEmails[$emailKey])) {
                    // Already have this email — merge cert if better
                    $idx = $seenEmails[$emailKey];
                    $existing = &$data[$idx];
                    if (empty($existing['cert_file_id']) && !empty($row['cert_file_id'])) {
                        $existing['cert_file_id'] = $row['cert_file_id'];
                    }
                    foreach (['sex','designation','participant_type','school_office'] as $f) {
                        if (empty($existing[$f]) && !empty($row[$f])) $existing[$f] = $row[$f];
                    }
                    unset($existing);
                    continue;
                }

                if (!isset($seen[$key])) {
                    $seen[$key] = count($data);
                    if ($isRealEmail) $seenEmails[$emailKey] = count($data);
                    $data[] = $row;
                } else {
                    // Merge: promote better data into the existing slot
                    $idx = $seen[$key];
                    $existing = &$data[$idx];

                    // Prefer row with email
                    if (empty($existing['email']) && !empty($row['email'])
                        && $row['email'] !== 'anonymous') {
                        $existing['email'] = $row['email'];
                        // Also take the name from this row if it looks "cleaner"
                        // (fewer commas = more likely First Last format)
                        if (substr_count($row['full_name'], ',') <
                            substr_count($existing['full_name'], ',')) {
                            $existing['full_name'] = $row['full_name'];
                        }
                    }
                    // Prefer row with cert
                    if (empty($existing['cert_file_id']) && !empty($row['cert_file_id'])) {
                        $existing['cert_file_id'] = $row['cert_file_id'];
                    }
                    // Fill any other empty fields
                    foreach (['sex','designation','participant_type','school_office'] as $f) {
                        if (empty($existing[$f]) && !empty($row[$f])) {
                            $existing[$f] = $row[$f];
                        }
                    }
                    unset($existing);
                }
            }

            // Sort by name for consistent display
            usort($data, fn($a, $b) => strcmp($a['full_name'] ?? '', $b['full_name'] ?? ''));

            respond(['success' => true, 'data' => $data]);

        // ── GET stats for a workshop ──────────────────────────────────────────
        case 'get_stats':
            $wid = (int)($_GET['workshop_id'] ?? 0);
            if (!$wid) error('workshop_id required');

            // Reuse orphan-detection logic
            $chkS = $pdo->prepare(
                "SELECT COUNT(*) FROM evaluation_programs ep
                 WHERE ep.id = ?
                   AND (ep.workshop_id IS NULL
                        OR ep.workshop_id NOT IN (SELECT id FROM workshops))"
            );
            $chkS->execute([$wid]);
            $isOrphanStats = (int)$chkS->fetchColumn() > 0;

            if ($isOrphanStats) {
                // Deduplicate by name before counting so multi-day imports
                // don't inflate totals.
                $stmt = $pdo->prepare(
                    "SELECT
                        COUNT(DISTINCT respondent_name) AS total,
                        COUNT(DISTINCT CASE WHEN sex = 'Female' THEN respondent_name END) AS female,
                        COUNT(DISTINCT CASE WHEN sex = 'Male'   THEN respondent_name END) AS male,
                        COUNT(DISTINCT CASE WHEN email IS NOT NULL
                                             AND email != ''
                                             AND email != 'anonymous'
                                            THEN respondent_name END) AS with_email
                     FROM respondents WHERE program_id = ?"
                );
            } else {
                $stmt = $pdo->prepare(
                    "SELECT
                        COUNT(*) AS total,
                        SUM(sex = 'Female') AS female,
                        SUM(sex = 'Male') AS male,
                        SUM(email IS NOT NULL AND email != '') AS with_email
                     FROM workshop_participants WHERE workshop_id = ?"
                );
            }
            $stmt->execute([$wid]);
            respond(['success' => true, 'data' => $stmt->fetch()]);

        // ── ADD participant ───────────────────────────────────────────────────
        case 'add_participant':
            $wid  = (int)($body['workshop_id'] ?? 0);
            $name = trim($body['full_name'] ?? '');
            $sex  = $body['sex'] ?? 'Male';
            $pos  = trim($body['designation'] ?? '');
            $email= trim($body['email'] ?? '');
            $sch  = trim($body['school_office'] ?? '');
        
            if (!$wid || !$name || !$pos) error('workshop_id, full_name and designation are required');
        
            // Detect orphan (Excel-import) programs — same check used by get_participants
            $chkAdd = $pdo->prepare("
                SELECT COUNT(*) FROM evaluation_programs 
                WHERE id = ? 
                AND (workshop_id IS NULL 
                    OR workshop_id NOT IN (SELECT id FROM workshops))
            ");
            $chkAdd->execute([$wid]);
            $isOrphanAdd = (int)$chkAdd->fetchColumn() > 0;
        
            if ($isOrphanAdd) {
                // Insert into respondents for orphan/Excel-import programs
                $stmt = $pdo->prepare(
                    "INSERT INTO respondents
                        (program_id, respondent_name, sex, designation, school_office, email)
                     VALUES (?, ?, ?, ?, ?, ?)"
                );
                $stmt->execute([$wid, strtoupper($name), $sex, $pos, $sch, $email ?: null]);
            } else {
                // Normal workshop → workshop_participants
                $stmt = $pdo->prepare(
                    "INSERT INTO workshop_participants
                        (workshop_id, full_name, sex, designation, school_office, email, attendance_status)
                     VALUES (?, ?, ?, ?, ?, ?, 'attended')"
                );
                $stmt->execute([$wid, strtoupper($name), $sex, $pos, $sch, $email ?: null]);
            }
        
            respond(['success' => true, 'id' => $pdo->lastInsertId(), 'message' => "Added $name"]);

        // ── UPDATE participant ────────────────────────────────────────────────
        case 'update_participant':
            $id   = (int)($body['id'] ?? 0);
            $name = trim($body['full_name'] ?? '');
            $sex  = $body['sex'] ?? 'Male';
            $pos  = trim($body['designation'] ?? '');
            $type = trim($body['participant_type'] ?? '');
            $email= trim($body['email'] ?? '');
            $sch  = trim($body['school_office'] ?? '');

            if (!$id || !$name || !$pos) error('id, full_name and designation are required');

            $stmt = $pdo->prepare(
                "UPDATE workshop_participants
                 SET full_name=?, sex=?, participant_type=?, designation=?,
                     school_office=?, email=?
                 WHERE id=?"
            );
            $stmt->execute([strtoupper($name), $sex, $type, $pos, $sch, $email ?: null, $id]);

            // Fall back to respondents table if not found in workshop_participants
            if ($stmt->rowCount() === 0) {
                $stmt2 = $pdo->prepare(
                    "UPDATE respondents
                     SET respondent_name=?, sex=?, participant_type=?, designation=?,
                         school_office=?, email=?
                     WHERE id=?"
                );
                $stmt2->execute([strtoupper($name), $sex, $type, $pos, $sch, $email ?: null, $id]);
            }

            respond(['success' => true, 'message' => "Updated $name"]);

        // ── DELETE participant ────────────────────────────────────────────────
        case 'delete_participant':
            $id = (int)($body['id'] ?? 0);
            if (!$id) error('id required');
            $del = $pdo->prepare("DELETE FROM workshop_participants WHERE id=?");
            $del->execute([$id]);
            // Fall back to respondents table for Excel-import participants
            if ($del->rowCount() === 0) {
                $pdo->prepare("DELETE FROM respondents WHERE id=?")->execute([$id]);
            }
            respond(['success' => true, 'message' => 'Participant removed']);

        // ── MARK email sent ───────────────────────────────────────────────────
        case 'mark_email_sent':
            $id = (int)($body['id'] ?? 0);
            if (!$id) error('id required');

            try {
                $pdo->exec("ALTER TABLE workshop_participants ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
            } catch (\PDOException $e) {}
            try {
                $pdo->exec("ALTER TABLE respondents ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
            } catch (\PDOException $e) {}

            $stmt = $pdo->prepare(
                "UPDATE workshop_participants SET email_sent_at = NOW() WHERE id = ?"
            );
            $stmt->execute([$id]);

            // Fall back to respondents for Excel-import participants
            if ($stmt->rowCount() === 0) {
                $pdo->prepare("UPDATE respondents SET email_sent_at = NOW() WHERE id = ?")
                    ->execute([$id]);
            }

            respond(['success' => true, 'message' => 'Marked as sent']);

        // ── BULK mark email sent ──────────────────────────────────────────────
        case 'bulk_mark_sent':
            $ids = $body['ids'] ?? [];
            if (!is_array($ids) || !count($ids)) error('ids array required');

            try {
                $pdo->exec("ALTER TABLE workshop_participants ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
            } catch (\PDOException $e) {}
            try {
                $pdo->exec("ALTER TABLE respondents ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
            } catch (\PDOException $e) {}

            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $intIds = array_map('intval', $ids);

            $pdo->prepare(
                "UPDATE workshop_participants SET email_sent_at = NOW() WHERE id IN ($placeholders)"
            )->execute($intIds);

            // Also update respondents in case any IDs belong to Excel-import participants
            $pdo->prepare(
                "UPDATE respondents SET email_sent_at = NOW() WHERE id IN ($placeholders)"
            )->execute($intIds);

            respond(['success' => true, 'message' => count($ids) . ' marked as sent']);

        // ── GET email sent status ─────────────────────────────────────────────
        case 'get_email_status':
            $workshopId = $_GET['workshop_id'] ?? null;

            $chk = $pdo->prepare("
                SELECT COUNT(*) FROM evaluation_programs 
                WHERE id = ? 
                AND (workshop_id IS NULL 
                    OR workshop_id NOT IN (SELECT id FROM workshops))
            ");
            $chk->execute([$workshopId]);
            $isOrphan = $chk->fetchColumn() > 0;

            if ($isOrphan) {
                $stmt = $pdo->prepare("
                    SELECT id, email_sent_at 
                    FROM respondents
                    WHERE program_id = ?
                ");
            } else {
                $stmt = $pdo->prepare("
                    SELECT id, email_sent_at 
                    FROM workshop_participants
                    WHERE workshop_id = ?
                ");
            }

            $stmt->execute([$workshopId]);

            $map = [];
            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                $map[$row['id']] = [
                    'status' => $row['email_sent_at'] ? 'sent' : 'pending',
                    'email_sent_at' => $row['email_sent_at']
                ];
            }

            respond(['success' => true, 'data' => $map]);

        // ── GET workshop days (workshop_days table removed) ─────────────────
        // Container  → one entry per program_import row
        // Non-container → single Day 1 entry from workshops row
        case 'get_days':
            $wid = (int)($_GET['workshop_id'] ?? 0);
            if (!$wid) error('workshop_id required');

            $wStmt = $pdo->prepare(
                "SELECT start_date, program_type FROM workshops WHERE id = ?"
            );
            $wStmt->execute([$wid]);
            $wRow = $wStmt->fetch(PDO::FETCH_ASSOC);

            if (!$wRow) error('Workshop not found', 404);

            if (($wRow['program_type'] ?? '') === 'container') {
                // Container: each program_import is one day
                $impStmt = $pdo->prepare(
                    "SELECT pi.day_number,
                            COALESCE(pi.day_label, CONCAT('Day ', pi.day_number)) AS title,
                            ep.start_date AS day_date
                     FROM program_imports pi
                     LEFT JOIN evaluation_programs ep ON ep.id = pi.program_id
                     WHERE pi.workshop_id = ?
                     ORDER BY pi.day_number ASC, pi.imported_at ASC"
                );
                $impStmt->execute([$wid]);
                $imports = $impStmt->fetchAll(PDO::FETCH_ASSOC);
                $days = [];
                foreach ($imports as $i => $imp) {
                    $days[] = [
                        'id'         => $i + 1,
                        'day_number' => (int)$imp['day_number'],
                        'day_date'   => $imp['day_date'] ?? null,
                        'title'      => $imp['title'],
                    ];
                }
            } else {
                // Non-container: single Day 1
                $days = [[
                    'id'         => 1,
                    'day_number' => 1,
                    'day_date'   => $wRow['start_date'] ?? null,
                    'title'      => 'Day 1',
                ]];
            }
            respond(['success' => true, 'data' => $days]);

        // ── FILES: list ───────────────────────────────────────────────────────
        case 'get_files':
            $wid = (int)($_GET['workshop_id'] ?? 0);

            $pdo->exec("
                CREATE TABLE IF NOT EXISTS `program_files` (
                    `id` int(11) NOT NULL AUTO_INCREMENT,
                    `workshop_id` int(11) NOT NULL,
                    `file_name` varchar(500) NOT NULL,
                    `file_type` enum('cert','qame','eval','other') DEFAULT 'other',
                    `day_session` varchar(50) DEFAULT 'All Days',
                    `description` text DEFAULT NULL,
                    `file_size` varchar(30) DEFAULT NULL,
                    `stored_name` varchar(500) DEFAULT NULL,
                    `uploaded_by` int(11) DEFAULT NULL,
                    `uploaded_at` timestamp NOT NULL DEFAULT current_timestamp(),
                    PRIMARY KEY (`id`),
                    KEY `workshop_id` (`workshop_id`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ");

            if ($wid) {
                // For orphan (Excel-import) programs, the splitter saves cert files
                // using program_id as the workshop_id column in program_files.
                // We must include those IDs so cert auto-attach works in the UI.
                $relatedIds = [$wid];

                // Any evaluation_programs linked to this workshop_id
                $epStmt = $pdo->prepare(
                    "SELECT id FROM evaluation_programs WHERE workshop_id = ?"
                );
                $epStmt->execute([$wid]);
                foreach ($epStmt->fetchAll(PDO::FETCH_COLUMN) as $epId) {
                    $relatedIds[] = (int)$epId;
                }

                // If $wid is itself an evaluation_programs.id, also include its parent workshop
                $epSelf = $pdo->prepare(
                    "SELECT workshop_id FROM evaluation_programs WHERE id = ? AND workshop_id IS NOT NULL"
                );
                $epSelf->execute([$wid]);
                $parentWid = $epSelf->fetchColumn();
                if ($parentWid) $relatedIds[] = (int)$parentWid;

                $relatedIds = array_unique($relatedIds);
                $placeholders = implode(',', array_fill(0, count($relatedIds), '?'));
                $stmt = $pdo->prepare(
                    "SELECT pf.*, w.title as program_title
                     FROM program_files pf
                     LEFT JOIN workshops w ON w.id = pf.workshop_id
                     WHERE pf.workshop_id IN ($placeholders)
                     ORDER BY pf.uploaded_at DESC"
                );
                $stmt->execute($relatedIds);
            } else {
                $stmt = $pdo->prepare(
                    "SELECT pf.*, w.title as program_title
                     FROM program_files pf
                     LEFT JOIN workshops w ON w.id = pf.workshop_id
                     ORDER BY pf.uploaded_at DESC"
                );
                $stmt->execute();
            }
            respond(['success' => true, 'data' => $stmt->fetchAll()]);

        // ── FILES: upload (multipart) ─────────────────────────────────────────
        case 'upload_file':
            $wid  = (int)($_POST['workshop_id'] ?? 0);
            $type = $_POST['file_type'] ?? 'other';
            $day  = $_POST['day_session'] ?? 'All Days';
            $desc = trim($_POST['description'] ?? '');
            if (!$wid) error('workshop_id required');
            if (empty($_FILES['file'])) error('No file uploaded');

            $uploadDir = __DIR__ . '/uploads/program_files/';
            if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);

            $origName   = basename($_FILES['file']['name']);
            $storedName = uniqid('file_', true) . '_' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $origName) . '.enc';
            $dest       = $uploadDir . $storedName;

            $fileEncryption = new FileEncryption();
            if (!$fileEncryption->encryptUploadedFile($_FILES['file']['tmp_name'], $dest)) {
                error('Failed to save encrypted file');
            }

            $size = $_FILES['file']['size'];
            $sizeStr = $size > 1048576
                ? round($size/1048576, 1) . ' MB'
                : round($size/1024) . ' KB';

            $pdo->exec("
                CREATE TABLE IF NOT EXISTS `program_files` (
                    `id` int(11) NOT NULL AUTO_INCREMENT,
                    `workshop_id` int(11) NOT NULL,
                    `file_name` varchar(500) NOT NULL,
                    `file_type` enum('cert','qame','eval','other') DEFAULT 'other',
                    `day_session` varchar(50) DEFAULT 'All Days',
                    `description` text DEFAULT NULL,
                    `file_size` varchar(30) DEFAULT NULL,
                    `stored_name` varchar(500) DEFAULT NULL,
                    `uploaded_by` int(11) DEFAULT NULL,
                    `uploaded_at` timestamp NOT NULL DEFAULT current_timestamp(),
                    PRIMARY KEY (`id`),
                    KEY `workshop_id` (`workshop_id`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ");

            $stmt = $pdo->prepare(
                "INSERT INTO program_files (workshop_id, file_name, file_type, day_session, description, file_size, stored_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?)"
            );
            $stmt->execute([$wid, $origName, $type, $day, $desc, $sizeStr, $storedName]);
            respond(['success' => true, 'id' => $pdo->lastInsertId(), 'message' => "Uploaded $origName"]);

        // ── FILES: delete ─────────────────────────────────────────────────────
        case 'delete_file':
            $id = (int)($body['id'] ?? 0);
            if (!$id) error('id required');

            $stmt = $pdo->prepare("SELECT stored_name FROM program_files WHERE id = ?");
            $stmt->execute([$id]);
            $row = $stmt->fetch();
            if ($row && $row['stored_name']) {
                $path = __DIR__ . '/uploads/program_files/' . $row['stored_name'];
                if (file_exists($path)) unlink($path);
            }
            $pdo->prepare("DELETE FROM program_files WHERE id = ?")->execute([$id]);
            // Clear dangling cert_file_id references so participants show as missing certificate
            $pdo->prepare("UPDATE workshop_participants SET cert_file_id = NULL WHERE cert_file_id = ?")->execute([$id]);
            $pdo->prepare("UPDATE respondents SET cert_file_id = NULL WHERE cert_file_id = ?")->execute([$id]);
            respond(['success' => true, 'message' => 'File deleted']);

        // ── FILES: download ───────────────────────────────────────────────────
        case 'download_file':
            $id = (int)($_GET['id'] ?? 0);
            if (!$id) error('id required');

            $stmt = $pdo->prepare("SELECT file_name, stored_name FROM program_files WHERE id = ?");
            $stmt->execute([$id]);
            $row = $stmt->fetch();
            if (!$row) error('File not found', 404);

            $path = __DIR__ . '/uploads/program_files/' . $row['stored_name'];
            if (!file_exists($path)) error('File missing on server', 404);

            $fileEncryption = new FileEncryption();
            try {
                $decryptedContents = $fileEncryption->getDecryptedContents($path);
            } catch (Exception $e) {
                $decryptedContents = file_get_contents($path);
            }

            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . $row['file_name'] . '"');
            header('Content-Length: ' . strlen($decryptedContents));
            echo $decryptedContents;
            exit;

        // ── IMPORT CSV of participants ────────────────────────────────────────
        case 'import_csv':
            $wid = (int)($body['workshop_id'] ?? 0);
            $rows = $body['rows'] ?? [];
            if (!$wid || !count($rows)) error('workshop_id and rows required');

            $stmt = $pdo->prepare(
                "INSERT INTO workshop_participants
                    (workshop_id, full_name, sex, participant_type, designation, school_office, email, attendance_status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'attended')"
            );
            $added = 0;
            foreach ($rows as $r) {
                $name = strtoupper(trim($r['full_name'] ?? ''));
                $pos  = trim($r['designation'] ?? '');
                if (!$name || !$pos) continue;
                $sex = (strtolower($r['sex'] ?? '') === 'female') ? 'Female' : 'Male';
                $stmt->execute([
                    $wid, $name, $sex,
                    trim($r['participant_type'] ?? ''),
                    $pos,
                    trim($r['school_office'] ?? ''),
                    trim($r['email'] ?? '') ?: null,
                ]);
                $added++;
            }
            respond(['success' => true, 'added' => $added, 'message' => "Imported $added participant(s)"]);

        // ── SEND CERTIFICATE EMAIL (single) ───────────────────────────────────
        case 'send_certificate_email':
            $participantId = (int)($body['participant_id'] ?? 0);
            $subject       = trim($body['subject']  ?? 'Your Certificate of Participation');
            $message       = trim($body['message']  ?? '');
            $fileId        = (int)($body['file_id'] ?? 0);
            $forceResend   = !empty($body['force_resend']);

            if (!$participantId) error('participant_id is required');

            // Try workshop_participants first (normal workshops)
            $stmt = $pdo->prepare(
                "SELECT id, full_name, email, designation, cert_file_id, email_sent_at FROM workshop_participants WHERE id = ?"
            );
            $stmt->execute([$participantId]);
            $participant = $stmt->fetch();
            $isRespondent = false;

            // Fallback: check respondents table (Excel-import / orphan programs)
            if (!$participant) {
                $stmt = $pdo->prepare(
                    "SELECT id, respondent_name AS full_name, email, designation, cert_file_id, email_sent_at FROM respondents WHERE id = ?"
                );
                $stmt->execute([$participantId]);
                $participant = $stmt->fetch();
                $isRespondent = true;
            }

            if (!$participant)          error('Participant not found', 404);
            // Sanitize email: trim whitespace and trailing dots/commas
            $participant['email'] = rtrim(trim($participant['email']), '.,; ');
            if (!$participant['email']) error('Participant has no email address', 422);
            if (!filter_var($participant['email'], FILTER_VALIDATE_EMAIL)) error('Invalid email address: ' . $participant['email'], 422);

            // Determine the correct table for all subsequent DB writes
            $participantTable = $isRespondent ? 'respondents' : 'workshop_participants';

            // Guard: block re-send unless force_resend is explicitly set
            if (!$forceResend && !empty($participant['email_sent_at'])) {
                error('Certificate was already sent to this recipient. Use "Resend" to send again.', 409);
            }

            // For resends: reset email_sent_at so the participant is treated as pending again
            if ($forceResend) {
                try {
                    $pdo->exec("ALTER TABLE {$participantTable} ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
                } catch (\PDOException $e) {}
                $pdo->prepare("UPDATE {$participantTable} SET email_sent_at = NULL WHERE id = ?")
                    ->execute([$participantId]);
            }

            if (!$message) {
                $message = "Dear {$participant['full_name']},\n\nCongratulations! "
                    . "Please find attached your Certificate of Participation.\n\n"
                    . "Thank you for your active participation and dedication.\n\n"
                    . "Best regards,\nSDO Baliwag HRDS";
            }

            $attachmentPath = null;
            $tmpCertPath    = null;
            $uploadDir      = __DIR__ . '/uploads/program_files/';
            $fe             = new FileEncryption();

            // Prefer explicitly chosen file_id from modal,
            // fall back to the participant's own linked cert_file_id.
            $resolvedFileId = $fileId;
            if (!$resolvedFileId && !empty($participant['cert_file_id'])) {
                $resolvedFileId = (int)$participant['cert_file_id'];
            }

            if ($resolvedFileId) {
                $fStmt = $pdo->prepare("SELECT stored_name, file_name FROM program_files WHERE id = ?");
                $fStmt->execute([$resolvedFileId]);
                $fileRow = $fStmt->fetch();
                if ($fileRow && $fileRow['stored_name']) {
                    $storedPath  = $uploadDir . $fileRow['stored_name'];
                    // Decrypt .enc to temp .pdf — same as bulk send
                    // Never fall back to raw .enc; EmailHelper cannot attach it
                    $tmpCertPath    = prepareCertAttachment($storedPath, $fileRow['file_name'], $fe);
                    $attachmentPath = $tmpCertPath;
                }
            }

            // Guard: refuse to send without a valid decrypted attachment
            if (!$attachmentPath) {
                error('No valid certificate file could be prepared. '
                    . 'Ensure the certificate file exists and is not corrupted.', 422);
            }

            $emailHelper = new EmailHelper();
            $sent = $emailHelper->sendCertificateEmail(
                $participant['email'],
                $participant['full_name'],
                $subject,
                $message,
                $attachmentPath
            );
            if ($tmpCertPath && file_exists($tmpCertPath)) @unlink($tmpCertPath);

            if (!$sent) error('EmailHelper failed: ' . $emailHelper->getLastError(), 500);

            try {
                $pdo->exec("ALTER TABLE {$participantTable} ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL");
            } catch (\PDOException $e) {}

            $pdo->prepare("UPDATE {$participantTable} SET email_sent_at = NOW() WHERE id = ?")
                   ->execute([$participantId]);

            respond([
                'success'   => true,
                'message'   => "Certificate email sent to {$participant['email']}",
                'recipient' => $participant['full_name'],
                'email'     => $participant['email'],
            ]);


        // ── SAVE SPLIT RESULTS ────────────────────────────────────────────────
        // Receives base64-encoded PDFs, saves each to disk (encrypted),
        // records in program_files, and links to the participant/respondent row.
        case 'save_split_results':
            $workshopId        = (int)($body['workshop_id']           ?? 0);
            $programId         = (int)($body['program_id']            ?? 0);
            // FIX: optional hint from the Certificates page so we can search
            // workshop_participants even when the splitter was run for a
            // different program/record ID.
            $certPageWorkshopId = (int)($body['cert_page_workshop_id'] ?? 0);
            $results            = $body['results'] ?? [];

            if (!$workshopId && !$programId) error('workshop_id or program_id required');
            if (!is_array($results) || !count($results)) error('results array is required');

            $uploadDir = __DIR__ . '/uploads/program_files/';
            if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);

            $fileEncryption = new FileEncryption();

            // Ensure cert_file_id column exists on both participant tables
            try { $pdo->exec('ALTER TABLE workshop_participants ADD COLUMN cert_file_id INT NULL DEFAULT NULL'); } catch (\PDOException $e) {}
            try { $pdo->exec('ALTER TABLE respondents ADD COLUMN cert_file_id INT UNSIGNED NULL DEFAULT NULL'); } catch (\PDOException $e) {}

            $wid = $workshopId ?: $programId;

            // ── FIX: resolve all workshop IDs we should search ───────────────
            // The Certificates page always passes a workshops.id as workshop_id.
            // The splitter may pass it as workshop_id (normal) or program_id
            // (orphan/Excel record). Build a consolidated set of workshop IDs
            // and program IDs so the fallback name-match covers every table.

            // Start with the direct value
            $resolvedWorkshopIds = [];
            $resolvedProgramIds  = [];

            // If $wid looks like a workshops row, use it directly
            $isRealWorkshop = false;
            if ($wid) {
                $chkW = $pdo->prepare("SELECT COUNT(*) FROM workshops WHERE id = ?");
                $chkW->execute([$wid]);
                $isRealWorkshop = ((int)$chkW->fetchColumn() > 0);
            }

            if ($isRealWorkshop) {
                $resolvedWorkshopIds[] = $wid;
                // Also collect any evaluation_programs linked to this workshop
                $epSib = $pdo->prepare("SELECT id FROM evaluation_programs WHERE workshop_id = ?");
                $epSib->execute([$wid]);
                foreach ($epSib->fetchAll(PDO::FETCH_COLUMN) as $epId) {
                    $resolvedProgramIds[] = (int)$epId;
                }
            } else {
                // $wid is an evaluation_programs.id (orphan / Excel-import)
                $resolvedProgramIds[] = $wid;
                // Try to find the parent workshop
                $parentStmt = $pdo->prepare("SELECT workshop_id FROM evaluation_programs WHERE id = ? AND workshop_id IS NOT NULL");
                $parentStmt->execute([$wid]);
                $parentWid = $parentStmt->fetchColumn();
                if ($parentWid) {
                    $resolvedWorkshopIds[] = (int)$parentWid;
                    // Sibling programs under that workshop
                    $sibStmt = $pdo->prepare("SELECT ep.id FROM evaluation_programs ep INNER JOIN program_imports pi ON pi.program_id = ep.id WHERE pi.workshop_id = ?");
                    $sibStmt->execute([$parentWid]);
                    foreach ($sibStmt->fetchAll(PDO::FETCH_COLUMN) as $sibId) {
                        $resolvedProgramIds[] = (int)$sibId;
                    }
                }
            }

            // Merge in the cert-page workshop hint (may differ from splitter's $wid)
            if ($certPageWorkshopId && !in_array($certPageWorkshopId, $resolvedWorkshopIds)) {
                $resolvedWorkshopIds[] = $certPageWorkshopId;
                // Sibling programs under the hint workshop
                $hintSib = $pdo->prepare("SELECT id FROM evaluation_programs WHERE workshop_id = ?");
                $hintSib->execute([$certPageWorkshopId]);
                foreach ($hintSib->fetchAll(PDO::FETCH_COLUMN) as $hId) {
                    $resolvedProgramIds[] = (int)$hId;
                }
            }

            $resolvedWorkshopIds = array_unique(array_filter($resolvedWorkshopIds));
            $resolvedProgramIds  = array_unique(array_filter($resolvedProgramIds));

            // ── Load already-linked IDs so we can skip them on re-run ────────
            // Only skip participants whose cert_file_id STILL EXISTS in program_files.
            $alreadyLinkedRespondents  = [];
            $alreadyLinkedParticipants = [];

            // Check respondents across all resolved program IDs
            if (!empty($resolvedProgramIds)) {
                $phR = implode(',', array_fill(0, count($resolvedProgramIds), '?'));
                $stmt = $pdo->prepare(
                    "SELECT r.id FROM respondents r
                     INNER JOIN program_files pf ON pf.id = r.cert_file_id
                     WHERE r.program_id IN ($phR) AND r.cert_file_id IS NOT NULL"
                );
                $stmt->execute(array_values($resolvedProgramIds));
                foreach ($stmt->fetchAll() as $r) $alreadyLinkedRespondents[$r['id']] = true;
            }
            // Also check the direct $wid in case it's a program_id not in our resolved list
            $stmt = $pdo->prepare(
                "SELECT r.id FROM respondents r
                 INNER JOIN program_files pf ON pf.id = r.cert_file_id
                 WHERE r.program_id = ? AND r.cert_file_id IS NOT NULL"
            );
            $stmt->execute([$wid]);
            foreach ($stmt->fetchAll() as $r) $alreadyLinkedRespondents[$r['id']] = true;

            // Check workshop_participants across all resolved workshop IDs
            if (!empty($resolvedWorkshopIds)) {
                $phW = implode(',', array_fill(0, count($resolvedWorkshopIds), '?'));
                $stmt = $pdo->prepare(
                    "SELECT wp.id FROM workshop_participants wp
                     INNER JOIN program_files pf ON pf.id = wp.cert_file_id
                     WHERE wp.workshop_id IN ($phW) AND wp.cert_file_id IS NOT NULL"
                );
                $stmt->execute(array_values($resolvedWorkshopIds));
                foreach ($stmt->fetchAll() as $r) $alreadyLinkedParticipants[$r['id']] = true;
            }

            // ── Email-level dedup for multi-day respondents ───────────────────
            $alreadyLinkedEmails = [];
            if (!empty($resolvedProgramIds)) {
                $phR2 = implode(',', array_fill(0, count($resolvedProgramIds), '?'));
                $stmt = $pdo->prepare(
                    "SELECT DISTINCT LOWER(TRIM(r.email)) AS email
                     FROM respondents r
                     INNER JOIN program_files pf ON pf.id = r.cert_file_id
                     WHERE r.program_id IN ($phR2)
                       AND r.cert_file_id IS NOT NULL
                       AND r.email IS NOT NULL AND r.email != '' AND r.email != 'anonymous'"
                );
                $stmt->execute(array_values($resolvedProgramIds));
                foreach ($stmt->fetchAll() as $r) $alreadyLinkedEmails[$r['email']] = true;
            }
            // Also check $wid directly
            $stmt = $pdo->prepare(
                "SELECT DISTINCT LOWER(TRIM(r.email)) AS email
                 FROM respondents r
                 INNER JOIN program_files pf ON pf.id = r.cert_file_id
                 WHERE r.program_id = ?
                   AND r.cert_file_id IS NOT NULL
                   AND r.email IS NOT NULL AND r.email != '' AND r.email != 'anonymous'"
            );
            $stmt->execute([$wid]);
            foreach ($stmt->fetchAll() as $r) $alreadyLinkedEmails[$r['email']] = true;

            // ── Load existing ownerless certificates (file_name → file_id) ───
            // These are previously saved certs with no owner yet.
            // When a new participant matches one, we link instead of re-saving.
            // FIX: search all resolved workshop IDs so certs saved under any
            // related workshop ID are still findable.
            $orphanCerts = []; // normalized_name => program_files.id
            $allWidForOrphan = array_unique(array_merge([$wid], $resolvedWorkshopIds));
            $phOrphan = implode(',', array_fill(0, count($allWidForOrphan), '?'));
            $stmt = $pdo->prepare(
                "SELECT pf.id, pf.file_name
                 FROM program_files pf
                 WHERE pf.workshop_id IN ($phOrphan)
                   AND pf.description = 'Auto-split certificate'
                   AND pf.id NOT IN (
                       SELECT cert_file_id FROM respondents
                        WHERE cert_file_id IS NOT NULL
                       UNION
                       SELECT cert_file_id FROM workshop_participants
                        WHERE cert_file_id IS NOT NULL
                   )"
            );
            $stmt->execute(array_values($allWidForOrphan));
            foreach ($stmt->fetchAll() as $row) {
                // Normalize the filename the same way JS does: strip .pdf, uppercase, strip non-alpha
                $key = preg_replace('/[^A-Z0-9 ]/', ' ', strtoupper(preg_replace('/\.pdf$/i', '', $row['file_name'])));
                $key = trim(preg_replace('/\s+/', ' ', $key));
                $orphanCerts[$key] = (int)$row['id'];
            }

            $insertFile = $pdo->prepare(
                "INSERT INTO program_files
                    (workshop_id, file_name, file_type, day_session, description, file_size, stored_name)
                VALUES (?, ?, 'cert', 'All Days', 'Auto-split certificate', ?, ?)"
            );
            $linkParticipant = $pdo->prepare('UPDATE workshop_participants SET cert_file_id = ? WHERE id = ?');
            $linkRespondent  = $pdo->prepare('UPDATE respondents SET cert_file_id = ? WHERE id = ?');
            $linkRespondentSiblings = $pdo->prepare(
                "UPDATE respondents SET cert_file_id = ?
                 WHERE program_id = ? AND LOWER(TRIM(email)) = ? AND cert_file_id IS NULL"
            );

            $saved = 0; $linked = 0; $skipped = 0; $errors = [];

            // ── Token-based name match (mirrors JS namesMatch) — defined once ─
            $tokensMatch = function(string $a, string $b): bool {
                $ta = array_values(array_filter(explode(' ', $a)));
                $tb = array_values(array_filter(explode(' ', $b)));
                if (count($ta) < 2 || count($tb) < 2) return false;
                [$shorter, $longer] = count($ta) <= count($tb) ? [$ta, $tb] : [$tb, $ta];
                foreach ($shorter as $tok) {
                    $found = false;
                    foreach ($longer as $lt) {
                        if (str_starts_with($lt, $tok) || str_starts_with($tok, $lt)) {
                            $found = true; break;
                        }
                    }
                    if (!$found) return false;
                }
                return true;
            };

            foreach ($results as $item) {
                $fileName      = basename($item['file_name']    ?? '');
                $participantId = (int)($item['participant_id']  ?? 0);
                $respondentId  = (int)($item['respondent_id']   ?? 0);
                $b64           = $item['data'] ?? '';

                // Allow empty $b64 — "Save Matched for Bulk Sending" sends data:''
                // intentionally (file already saved) and only wants the DB link written.
                if (!$fileName) continue;
                $isMetaOnly = ($b64 === '' || $b64 === null);

                // ── Skip participants who already have a valid certificate ─────
                if ($respondentId  && isset($alreadyLinkedRespondents[$respondentId]))  { $skipped++; continue; }
                if ($participantId && isset($alreadyLinkedParticipants[$participantId])) { $skipped++; continue; }

                // ── Fetch respondent email for sibling propagation / dedup ─────
                $respondentEmail = null;
                if ($respondentId) {
                    $eStmt = $pdo->prepare("SELECT LOWER(TRIM(email)) FROM respondents WHERE id = ? LIMIT 1");
                    $eStmt->execute([$respondentId]);
                    $respondentEmail = $eStmt->fetchColumn() ?: null;
                    if ($respondentEmail && isset($alreadyLinkedEmails[$respondentEmail])) {
                        $skipped++; continue;
                    }
                }

                // ── Normalised key used by both paths ─────────────────────────
                $normKey = trim(preg_replace('/\s+/', ' ',
                    preg_replace('/[^A-Z0-9 ]/', ' ',
                        strtoupper(preg_replace('/\.pdf$/i', '', $fileName))
                    )
                ));

                // ── Metadata-only path (data:'') ─────────────────────────────
                // "Save Matched for Bulk Sending" sends empty data — the file is
                // already in program_files; we just need to write cert_file_id.
                if ($isMetaOnly) {
                    // 1) Try orphan pool (file exists but has no owner yet)
                    $existingFileId = $orphanCerts[$normKey] ?? null;

                    // 2) Fallback: find the most-recent file with that exact name
                    if (!$existingFileId) {
                        $fStmt = $pdo->prepare(
                            "SELECT id FROM program_files
                             WHERE workshop_id = ? AND file_name = ?
                             ORDER BY uploaded_at DESC LIMIT 1"
                        );
                        $fStmt->execute([$wid, $fileName]);
                        $existingFileId = $fStmt->fetchColumn() ?: null;
                    }

                    if (!$existingFileId) {
                        $errors[] = "Meta-only: no existing file found for $fileName";
                        continue;
                    }

                    if ($participantId) {
                        $linkParticipant->execute([$existingFileId, $participantId]);
                        $alreadyLinkedParticipants[$participantId] = true;
                        unset($orphanCerts[$normKey]);
                        $linked++;
                    } elseif ($respondentId) {
                        $linkRespondent->execute([$existingFileId, $respondentId]);
                        if (!empty($respondentEmail)) {
                            $linkRespondentSiblings->execute([$existingFileId, $wid, $respondentEmail]);
                            $alreadyLinkedEmails[$respondentEmail] = true;
                        }
                        $alreadyLinkedRespondents[$respondentId] = true;
                        unset($orphanCerts[$normKey]);
                        $linked++;
                    } else {
                        // No IDs — name-match across participants
                        $normFile    = phpNormaliseName(preg_replace('/\.pdf$/i', '', $fileName));
                        $linkedByName = false;

                        $mStmt = $pdo->prepare(
                            "SELECT r.id, r.program_id, LOWER(TRIM(r.email)) AS email, r.respondent_name
                             FROM respondents r
                             JOIN evaluation_programs ep ON ep.id = r.program_id
                             WHERE (ep.workshop_id = ? OR r.program_id = ?)
                               AND r.cert_file_id IS NULL
                             GROUP BY r.id, r.respondent_name, r.email
                             ORDER BY r.id ASC"
                        );
                        $mStmt->execute([$wid, $wid]);
                        foreach ($mStmt->fetchAll() as $cand) {
                            if (!$tokensMatch($normFile, phpNormaliseName($cand['respondent_name'] ?? ''))) continue;
                            $linkRespondent->execute([$existingFileId, $cand['id']]);
                            $ce = $cand['email'] ?? '';
                            if ($ce && $ce !== 'anonymous') {
                                $linkRespondentSiblings->execute([$existingFileId, $cand['program_id'], $ce]);
                                $alreadyLinkedEmails[$ce] = true;
                            }
                            $alreadyLinkedRespondents[$cand['id']] = true;
                            unset($orphanCerts[$normKey]);
                            $linkedByName = true; $linked++;
                            break;
                        }
                        if (!$linkedByName) {
                            $mStmt2 = $pdo->prepare(
                                "SELECT id, NULL AS program_id, LOWER(TRIM(email)) AS email, full_name AS respondent_name
                                 FROM workshop_participants
                                 WHERE workshop_id = ? AND cert_file_id IS NULL ORDER BY id ASC"
                            );
                            $mStmt2->execute([$wid]);
                            foreach ($mStmt2->fetchAll() as $cand) {
                                if (!$tokensMatch($normFile, phpNormaliseName($cand['respondent_name'] ?? ''))) continue;
                                $linkParticipant->execute([$existingFileId, $cand['id']]);
                                $alreadyLinkedParticipants[$cand['id']] = true;
                                unset($orphanCerts[$normKey]);
                                $linkedByName = true; $linked++;
                                break;
                            }
                        }
                        if (!$linkedByName) {
                            $errors[] = "Meta-only: could not match $fileName to any participant";
                        }
                    }
                    continue; // metadata-only done — skip file-save block
                }

                // ── Full-save path: check orphan pool before writing a new file ─
                // (Only for items that have an identified owner via participant/respondent ID)
                if ($respondentId || $participantId) {
                    if (isset($orphanCerts[$normKey])) {
                        $orphanFileId = $orphanCerts[$normKey];
                        if ($respondentId) {
                            $linkRespondent->execute([$orphanFileId, $respondentId]);
                            if (!empty($respondentEmail)) {
                                $linkRespondentSiblings->execute([$orphanFileId, $wid, $respondentEmail]);
                                $alreadyLinkedEmails[$respondentEmail] = true;
                            }
                        }
                        if ($participantId) $linkParticipant->execute([$orphanFileId, $participantId]);
                        unset($orphanCerts[$normKey]);
                        $linked++;
                        continue;
                    }
                }

                // ── Full-save path (data has base64) ─────────────────────────
                // Before saving, check if a file with this exact name already exists
                // for this workshop — if so, just link it instead of creating a duplicate.
                $dupStmt = $pdo->prepare(
                    "SELECT id FROM program_files
                     WHERE workshop_id = ? AND file_name = ?
                     ORDER BY uploaded_at DESC LIMIT 1"
                );
                $dupStmt->execute([$wid, $fileName]);
                $dupFileId = $dupStmt->fetchColumn();
                if ($dupFileId) {
                    // File already exists — just link it to the participant, skip re-saving
                    if ($participantId) {
                        $linkParticipant->execute([$dupFileId, $participantId]);
                        $alreadyLinkedParticipants[$participantId] = true;
                    } elseif ($respondentId) {
                        $linkRespondent->execute([$dupFileId, $respondentId]);
                        if (!empty($respondentEmail)) {
                            $linkRespondentSiblings->execute([$dupFileId, $wid, $respondentEmail]);
                            $alreadyLinkedEmails[$respondentEmail] = true;
                        }
                        $alreadyLinkedRespondents[$respondentId] = true;
                    }
                    $linked++;
                    continue;
                }

                $pdfBytes = base64_decode($b64, true);
                if ($pdfBytes === false) { $errors[] = "Bad base64 for $fileName"; continue; }

                $storedName = uniqid('cert_', true) . '_' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName) . '.enc';
                $destPath   = $uploadDir . $storedName;

                $tmpPath = sys_get_temp_dir() . '/cert_' . uniqid() . '.pdf';
                file_put_contents($tmpPath, $pdfBytes);
                try {
                    $fileEncryption->encryptFile($tmpPath, $destPath);
                } catch (Throwable $e) {
                    file_put_contents($destPath, $pdfBytes);
                }
                @unlink($tmpPath);

                $sizeStr = strlen($pdfBytes) > 1048576
                    ? round(strlen($pdfBytes) / 1048576, 1) . ' MB'
                    : round(strlen($pdfBytes) / 1024) . ' KB';

                $insertFile->execute([$wid, $fileName, $sizeStr, $storedName]);
                $fileId = (int)$pdo->lastInsertId();

                // Link to owner if matched
                if ($participantId) {
                    $linkParticipant->execute([$fileId, $participantId]);
                } elseif ($respondentId) {
                    $linkRespondent->execute([$fileId, $respondentId]);
                    // Propagate to all sibling day-sheet rows for the same email
                    if (!empty($respondentEmail)) {
                        $linkRespondentSiblings->execute([$fileId, $wid, $respondentEmail]);
                        $alreadyLinkedEmails[$respondentEmail] = true;
                    }
                } else {
                    // No owner matched during splitting — attempt post-save name matching.
                    $baseName = preg_replace('/\.pdf$/i', '', $fileName);
                    $normFile = phpNormaliseName($baseName);

                    // ── FIX: Search respondents across ALL resolved program IDs ─────
                    // Previously only searched where ep.workshop_id = $wid OR
                    // r.program_id = $wid, which missed cases where $wid is a
                    // workshops.id (not an evaluation_programs.id).
                    $candidateProgIds = array_unique(array_merge([$wid], $resolvedProgramIds));
                    $phCP = implode(',', array_fill(0, count($candidateProgIds), '?'));
                    $matchStmt2 = $pdo->prepare(
                        "SELECT r.id, r.program_id, LOWER(TRIM(r.email)) AS email, r.respondent_name
                         FROM respondents r
                         WHERE r.program_id IN ($phCP)
                           AND r.cert_file_id IS NULL
                         GROUP BY r.id, r.respondent_name, r.email
                         ORDER BY r.id ASC"
                    );
                    $matchStmt2->execute(array_values($candidateProgIds));
                    $candidates = $matchStmt2->fetchAll();

                    // ── FIX: Search workshop_participants across ALL resolved workshop IDs ─
                    // Previously only searched workshop_id = $wid, which missed the
                    // case where $wid is an evaluation_programs.id rather than a
                    // workshops.id. Now we also check the cert-page hint and any
                    // resolved parent workshop.
                    $candidateWsIds = array_unique(array_merge(
                        $isRealWorkshop ? [$wid] : [],
                        $resolvedWorkshopIds
                    ));
                    $wpCandidates = [];
                    if (!empty($candidateWsIds)) {
                        $phCW = implode(',', array_fill(0, count($candidateWsIds), '?'));
                        $matchStmt3 = $pdo->prepare(
                            "SELECT id, NULL AS program_id, LOWER(TRIM(email)) AS email, full_name AS respondent_name
                             FROM workshop_participants
                             WHERE workshop_id IN ($phCW)
                               AND cert_file_id IS NULL
                             ORDER BY id ASC"
                        );
                        $matchStmt3->execute(array_values($candidateWsIds));
                        $wpCandidates = $matchStmt3->fetchAll();
                    }

                    $linkedByName = false;

                    // Try respondents first
                    foreach ($candidates as $cand) {
                        $normCand = phpNormaliseName($cand['respondent_name'] ?? '');
                        if (!$tokensMatch($normFile, $normCand)) continue;

                        $linkRespondent->execute([$fileId, $cand['id']]);
                        $candEmail = $cand['email'] ?? '';
                        if ($candEmail && $candEmail !== 'anonymous') {
                            $linkRespondentSiblings->execute([$fileId, $cand['program_id'], $candEmail]);
                            $alreadyLinkedEmails[$candEmail] = true;
                        }
                        $alreadyLinkedRespondents[$cand['id']] = true;
                        $linkedByName = true;
                        break;
                    }

                    // Try workshop_participants if still unmatched
                    if (!$linkedByName) {
                        foreach ($wpCandidates as $cand) {
                            $normCand = phpNormaliseName($cand['respondent_name'] ?? '');
                            if (!$tokensMatch($normFile, $normCand)) continue;

                            $linkParticipant->execute([$fileId, $cand['id']]);
                            $alreadyLinkedParticipants[$cand['id']] = true;
                            $linkedByName = true;
                            break;
                        }
                    }
                    // If still no match, cert is saved as orphan (linkable later via "Save Matched" button)
                }

                $saved++;
            }

            respond([
                'success' => true,
                'saved'   => $saved,
                'linked'  => $linked,
                'skipped' => $skipped,
                'errors'  => $errors,
                'message' => "Saved $saved new, linked $linked existing, skipped $skipped already-linked certificate(s)",
            ]);

        // ── BULK SEND CERTIFICATE EMAILS ──────────────────────────────────────
        case 'bulk_send_certificate_email':
            $workshopId  = (int)($body['workshop_id'] ?? 0);
            $subject     = trim($body['subject'] ?? 'Your Certificate of Participation');
            $bodyTpl     = trim($body['message']  ?? '');
            $fallbackFileId = (int)($body['file_id'] ?? 0); // optional single fallback attachment

            if (!$workshopId) error('workshop_id is required');

            // Pre-load a fallback attachment path ONLY if the caller explicitly chose one.
            // No auto-fallback — silently attaching the wrong cert is worse than sending without one.
            $fallbackAttachmentPath = null;
            $fallbackFileName       = null;

            if ($fallbackFileId) {
                $fStmt = $pdo->prepare(
                    "SELECT stored_name, file_name FROM program_files WHERE id = ?"
                );
                $fStmt->execute([$fallbackFileId]);
                $fRow = $fStmt->fetch();
            } else {
                $fRow = null; // no fallback chosen — respect the caller's intent
            }

            if ($fRow && !empty($fRow['stored_name'])) {
                $c = __DIR__ . '/uploads/program_files/' . $fRow['stored_name'];
                if (file_exists($c)) {
                    $fallbackAttachmentPath = $c;
                    $fallbackFileName       = $fRow['file_name'] ?? $fRow['stored_name'];
                }
            }

            // ── Detect orphan (Excel-import) programs ────────────────────────
            // These live in `respondents`, not `workshop_participants`.
            // Same detection logic used by get_participants / get_stats.
            $isOrphanBulk = false;
            $chkBulk = $pdo->prepare(
                "SELECT COUNT(*) FROM evaluation_programs ep
                 WHERE ep.id = ?
                   AND (ep.workshop_id IS NULL
                        OR ep.workshop_id NOT IN (SELECT id FROM workshops))"
            );
            $chkBulk->execute([$workshopId]);
            if ((int)$chkBulk->fetchColumn() > 0) $isOrphanBulk = true;

            error_log("Bulk Send Mode: " . ($isOrphanBulk ? 'RESPONDENTS' : 'WORKSHOP'));
            error_log("Program ID: " . $workshopId);
            // Ensure email_sent_at exists on both tables before any query uses it
            try { $pdo->exec('ALTER TABLE workshop_participants ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL'); } catch (\PDOException $e) {}
            try { $pdo->exec('ALTER TABLE respondents ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL'); } catch (\PDOException $e) {}

            // Fetch pending recipients from the correct table
            if ($isOrphanBulk) {
                // GROUP BY LOWER(email) to deduplicate multi-day respondents —
                // same person can appear once per training day; we only send once.
                // MIN(id) picks one representative row per email address.
                $stmt = $pdo->prepare("
                    SELECT MIN(r.id) AS id,
                           r.respondent_name AS full_name,
                           LOWER(TRIM(r.email)) AS email,
                           r.cert_file_id, r.designation,
                           pf.stored_name AS cert_stored_name,
                           pf.file_name   AS cert_file_name
                    FROM respondents r
                    LEFT JOIN program_files pf ON pf.id = r.cert_file_id
                    WHERE r.program_id = ?
                    AND r.email IS NOT NULL
                    AND r.email != ''
                    AND r.email != 'anonymous'
                    AND (r.email_sent_at IS NULL OR r.email_sent_at = '')
                    GROUP BY LOWER(TRIM(r.email))
                ");
            } else {
                // GROUP BY LOWER(email) to deduplicate in case the same email
                // was entered for multiple participant rows.
                $stmt = $pdo->prepare("
                    SELECT MIN(wp.id) AS id, wp.full_name, LOWER(TRIM(wp.email)) AS email,
                           wp.cert_file_id,
                           pf.stored_name AS cert_stored_name,
                           pf.file_name   AS cert_file_name
                    FROM workshop_participants wp
                    LEFT JOIN program_files pf ON pf.id = wp.cert_file_id
                    WHERE wp.workshop_id = ?
                    AND wp.email IS NOT NULL
                    AND wp.email != ''
                    AND wp.email != 'anonymous'
                    AND (wp.email_sent_at IS NULL OR wp.email_sent_at = '')
                    GROUP BY LOWER(TRIM(wp.email))
                ");
            }
            $stmt->execute([$workshopId]);
            $rawPending = $stmt->fetchAll();

            // ── Secondary dedup by name tokens (catches "Last, First" vs "First Last") ──
            // The SQL GROUP BY email already handles same-email duplicates.
            // This pass catches same-person different-email where the name was
            // entered in two different formats AND both emails happen to be pending.
            $bulkNameKey = function(string $name): string {
                $n = strtoupper($name);
                $n = strtr($n, ['Ñ'=>'N','Á'=>'A','É'=>'E','Í'=>'I','Ó'=>'O','Ú'=>'U']);
                $tokens = preg_split('/[^A-Z]+/', $n, -1, PREG_SPLIT_NO_EMPTY);
                sort($tokens);
                return implode('|', $tokens);
            };
            $seenNames = [];
            $pending   = [];
            foreach ($rawPending as $p) {
                $nk = $bulkNameKey($p['full_name'] ?? '');
                if ($nk !== '' && isset($seenNames[$nk])) continue; // skip duplicate name
                $seenNames[$nk] = true;
                $pending[] = $p;
            }

            if (!count($pending)) {
                respond(['success' => true, 'sent' => 0, 'skipped' => 0,
                         'message' => 'No pending recipients with an email address.']);
            }

            $emailHelper    = new EmailHelper();
            $feForEmail     = new FileEncryption();
            $results     = [];
            $sentCount   = 0;
            $failCount   = 0;
            $skipCount   = 0;
            $uploadDir   = __DIR__ . '/uploads/program_files/';

            foreach ($pending as $p) {
                // Sanitize email: strip trailing dots/spaces that make PHPMailer reject the address
                $p['email'] = rtrim(trim($p['email']), '.,; ');
                if (!$p['email'] || !filter_var($p['email'], FILTER_VALIDATE_EMAIL)) {
                    $skipCount++;
                    $results[] = ['id' => $p['id'], 'name' => $p['full_name'], 'email' => $p['email'], 'status' => 'skipped', 'reason' => 'invalid_email'];
                    continue;
                }

                // Decrypt each participant's cert from .enc → temp .pdf so
                // EmailHelper attaches a proper PDF (not a blocked .enc file)
                $attachmentPath = null;
                $tmpCertPath    = null;
                if (!empty($p['cert_stored_name'])) {
                    $storedPath  = $uploadDir . $p['cert_stored_name'];
                    $displayName = $p['cert_file_name'] ?? $p['cert_stored_name'];
                    $tmpCertPath = prepareCertAttachment($storedPath, $displayName, $feForEmail);
                    $attachmentPath = $tmpCertPath ?? (file_exists($storedPath) ? $storedPath : null);
                }
                if (!$attachmentPath && $fallbackAttachmentPath) {
                    // Decrypt the auto-fallback cert just like individual certs
                    $tmpFallback = prepareCertAttachment($fallbackAttachmentPath, $fallbackFileName ?? 'Certificate.pdf', $feForEmail);
                    $attachmentPath = $tmpFallback ?? $fallbackAttachmentPath;
                }

                // ── GUARD: never send without a certificate attached ─────────
                // If there is still no attachment at this point, skip this
                // recipient entirely rather than sending a bare email.
                if (!$attachmentPath) {
                    $skipCount++;
                    $results[] = [
                        'id'     => $p['id'],
                        'name'   => $p['full_name'],
                        'email'  => $p['email'],
                        'status' => 'skipped',
                        'reason' => 'no_certificate',
                    ];
                    continue;
                }

                $personalBody = $bodyTpl
                    ? str_replace(['{name}', '{designation}'], [$p['full_name'], $p['designation'] ?? ''], $bodyTpl)
                    : "Dear {$p['full_name']},\n\nCongratulations! Please find attached your Certificate of Participation.\n\nThank you for your active participation and dedication.\n\nBest regards,\nSDO Baliwag HRDS";

                $sent = $emailHelper->sendCertificateEmail(
                    $p['email'],
                    $p['full_name'],
                    $subject,
                    $personalBody,
                    $attachmentPath
                );
                if ($tmpCertPath  && file_exists($tmpCertPath))  @unlink($tmpCertPath);
                if (isset($tmpFallback) && $tmpFallback && file_exists($tmpFallback)) @unlink($tmpFallback);

                if ($sent) {
                    if ($isOrphanBulk) {
                        // Stamp ALL rows with this email so siblings are also marked sent
                        $upd = $pdo->prepare(
                            "UPDATE respondents SET email_sent_at = NOW()
                             WHERE program_id = ? AND LOWER(TRIM(email)) = ?"
                        );
                        $upd->execute([$workshopId, strtolower(trim($p['email']))]);
                    } else {
                        // Stamp ALL rows with this email in this workshop
                        $upd = $pdo->prepare(
                            "UPDATE workshop_participants SET email_sent_at = NOW()
                             WHERE workshop_id = ? AND LOWER(TRIM(email)) = ?"
                        );
                        $upd->execute([$workshopId, strtolower(trim($p['email']))]);
                    }
                    $sentCount++;
                    $results[] = [
                        'id'       => $p['id'],
                        'name'     => $p['full_name'],
                        'email'    => $p['email'],
                        'status'   => 'sent',
                        'attached' => $attachmentPath ? basename($p['cert_stored_name'] ?? '') : null,
                    ];
                } else {
                    $failCount++;
                    $results[] = [
                        'id'     => $p['id'],
                        'name'   => $p['full_name'],
                        'email'  => $p['email'],
                        'status' => 'failed',
                    ];
                }
            }

            respond([
                'success' => true,
                'sent'    => $sentCount,
                'failed'  => $failCount,
                'skipped' => $skipCount,
                'results' => $results,
                'message' => "Sent: {$sentCount}, Failed: {$failCount}, Skipped (no cert): {$skipCount}",
            ]);

        // ── CLEANUP: clear dangling cert_file_id references ─────────────────
        // Call this once to fix participants whose cert was deleted but their
        // cert_file_id pointer was never cleared.
        case 'fix_dangling_certs':
            $wid = (int)($_GET['workshop_id'] ?? $body['workshop_id'] ?? 0);

            $wpFixed = 0;
            $rFixed  = 0;

            if ($wid) {
                $wp = $pdo->prepare(
                    "UPDATE workshop_participants SET cert_file_id = NULL
                     WHERE workshop_id = ?
                       AND cert_file_id IS NOT NULL
                       AND cert_file_id NOT IN (SELECT id FROM program_files)"
                );
                $wp->execute([$wid]);
                $wpFixed = $wp->rowCount();
                $r = $pdo->prepare(
                    "UPDATE respondents SET cert_file_id = NULL
                     WHERE program_id = ?
                       AND cert_file_id IS NOT NULL
                       AND cert_file_id NOT IN (SELECT id FROM program_files)"
                );
                $r->execute([$wid]);
                $rFixed = $r->rowCount();
            } else {
                $wp = $pdo->exec(
                    "UPDATE workshop_participants SET cert_file_id = NULL
                     WHERE cert_file_id IS NOT NULL
                       AND cert_file_id NOT IN (SELECT id FROM program_files)"
                );
                $wpFixed = $wp;
                $r = $pdo->exec(
                    "UPDATE respondents SET cert_file_id = NULL
                     WHERE cert_file_id IS NOT NULL
                       AND cert_file_id NOT IN (SELECT id FROM program_files)"
                );
                $rFixed = $r;
            }

            respond([
                'success'  => true,
                'wp_fixed' => $wpFixed,
                'r_fixed'  => $rFixed,
                'message'  => 'Dangling cert_file_id references cleared',
            ]);

        default:
            error("Unknown action: $action", 404);
    }
} catch (\PDOException $e) {
    error('Database error: ' . $e->getMessage(), 500);
} catch (\Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
?>