<?php
/**
 * school-indorsements.php
 * REST-style API for the School Indorsements table.
 *
 * Merged 2026-07: this file used to be split across three files
 * (school-indorsements.php, save-indorsement.php, get-indorsement-status.php).
 * They're combined here so save/read/status logic can't drift out of sync again.
 *
 * Supported actions:
 *   GET  list    ?school_year=2026-2027&type=school_calendar&school_id=N
 *                — list indorsements with optional filters
 *   GET  status  ?school_id=N&private_school_id=N&type=school_permit&ind_number=2
 *                — count of matching saved indorsements (used to toggle
 *                  the Save/Update Indorsement button + badge in the modal)
 *   POST save    — upsert an indorsement. Matches the existing row on the
 *                  table's unique key (school/private_school_id + type +
 *                  school_year) and updates it in place, INCLUDING ind_number
 *                  — this is what "1st Indorsement" becoming "2nd Indorsement"
 *                  for the same school/type/year actually updates.
 *   POST delete  — hard-delete an indorsement by id (owner or admin only)
 *
 * All responses: JSON { success: bool, ... }
 * All endpoints require authentication + 'checklist' permission.
 *
 * Table: school_indorsements
 *   id, school_id, private_school_id, school_name, address, school_year, type
 *   (enum: school_calendar|tuition_increase|no_increase|school_permit),
 *   ind_number, level, letter_date, sig_name, sig_position,
 *   preview_text, created_by, created_at, updated_at
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError(string $msg, int $code = 400): void {
    jsonOut(['success' => false, 'message' => $msg], $code);
}

/** Allowed indorsement type values */
const VALID_IND_TYPES = ['school_calendar', 'tuition_increase', 'no_increase', 'school_permit'];

/**
 * Normalize a school_year string so visually-identical but byte-different
 * values (e.g. "2026-2027" vs "2026–2027" en dash, or "2026 - 2027" with
 * stray spaces — common when a value is typed/pasted somewhere with
 * smart-punctuation/autocorrect enabled) always collapse to the same
 * canonical string. Without this, rows saved with a "different" dash
 * silently fail to match the year filter used by the Indorsements view
 * and by GET list, even though the row exists in the table.
 */
function normalizeSchoolYear(string $sy): string {
    $sy = trim($sy);
    // Collapse en dash (–, U+2013), em dash (—, U+2014), and any run of
    // hyphen-like characters/whitespace around them into a single "-".
    $sy = preg_replace('/\s*[\x{2010}-\x{2015}\x{2212}-]\s*/u', '-', $sy);
    return $sy;
}

// ── Router ────────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? 'list';   // default to list for plain GET

$body = [];
if ($method === 'POST') {
    $raw  = file_get_contents('php://input');
    $body = $raw ? (json_decode($raw, true) ?? []) : [];
}

try {
    $pdo = getDb();

    // ── GET list ───────────────────────────────────────────────────────────
    // Returns all indorsements, optionally filtered by school_year, type, school_id.
    // Front-end fetches this once and does client-side filtering for speed.
    if ($method === 'GET' && $action === 'list') {

        $where  = [];
        $params = [];

        // Optional: filter by school year
        $sy = isset($_GET['school_year']) ? normalizeSchoolYear($_GET['school_year']) : '';
        if ($sy !== '' && $sy !== 'all') {
            $where[]            = 'i.school_year = :school_year';
            $params[':school_year'] = $sy;
        }

        // Optional: filter by type
        $type = isset($_GET['type']) ? trim($_GET['type']) : '';
        if ($type !== '' && $type !== 'all' && in_array($type, VALID_IND_TYPES, true)) {
            $where[]       = 'i.type = :type';
            $params[':type'] = $type;
        }

        // Optional: filter by school_id
        $schoolId = filter_input(INPUT_GET, 'school_id', FILTER_VALIDATE_INT);
        if ($schoolId) {
            $where[]           = 'i.school_id = :school_id';
            $params[':school_id'] = $schoolId;
        }

        $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

        $stmt = $pdo->prepare(
            "SELECT
                i.id,
                i.school_id,
                i.private_school_id,
                i.school_name,
                i.address,
                i.school_year,
                i.type,
                i.ind_number,
                i.level,
                i.letter_date,
                i.sig_name,
                i.sig_position,
                i.preview_text,
                i.created_by,
                u.full_name  AS created_by_name,
                i.created_at,
                i.updated_at
             FROM school_indorsements i
             LEFT JOIN users u ON u.id = i.created_by
             {$whereSql}
             ORDER BY i.school_year DESC, i.letter_date DESC, i.school_name ASC"
        );
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Cast types for clean JSON output
        foreach ($rows as &$r) {
            $r['id']                = (int)$r['id'];
            $r['school_id']         = $r['school_id'] !== null ? (int)$r['school_id'] : null;
            $r['private_school_id'] = $r['private_school_id'] !== null ? (int)$r['private_school_id'] : null;
            $r['ind_number']        = (int)$r['ind_number'];
            // Trim preview_text — it can be large; front-end only shows a tooltip
            if (isset($r['preview_text']) && strlen((string)$r['preview_text']) > 200) {
                $r['preview_text'] = mb_substr($r['preview_text'], 0, 200) . '…';
            }
        }
        unset($r);

        jsonOut(['success' => true, 'data' => $rows, 'total' => count($rows)]);
    }

    // ── GET status ─────────────────────────────────────────────────────────
    // Returns how many indorsements exist for a given school + type
    // (+ optional ind_number). Used by indorsement-generator.js to decide
    // whether to show "Save Indorsement" or "Update Indorsement".
    if ($method === 'GET' && $action === 'status') {

        $statusSchoolId        = intval($_GET['school_id']         ?? 0);
        $statusPrivateSchoolId = intval($_GET['private_school_id'] ?? 0);
        $statusType            = trim($_GET['type']                ?? '');
        $statusIndNumber       = intval($_GET['ind_number']         ?? 0);

        if ((!$statusSchoolId && !$statusPrivateSchoolId) || !$statusType) {
            jsonError('school_id (or private_school_id) and type are required');
        }

        $sWhere  = 'type = :type';
        $sParams = [':type' => $statusType];

        if ($statusPrivateSchoolId) {
            $sWhere            .= ' AND private_school_id = :psid';
            $sParams[':psid']  = $statusPrivateSchoolId;
        } else {
            $sWhere            .= ' AND school_id = :sid';
            $sParams[':sid']   = $statusSchoolId;
        }

        if ($statusIndNumber > 0) {
            $sWhere               .= ' AND ind_number = :ind_number';
            $sParams[':ind_number'] = $statusIndNumber;
        }

        $sStmt = $pdo->prepare("SELECT COUNT(*) AS cnt FROM school_indorsements WHERE {$sWhere}");
        $sStmt->execute($sParams);
        $sRow   = $sStmt->fetch(PDO::FETCH_ASSOC);
        $sCount = (int) ($sRow['cnt'] ?? 0);

        jsonOut(['success' => true, 'count' => $sCount, 'exists' => $sCount > 0]);
    }

    // ── POST save ──────────────────────────────────────────────────────────
    // Upserts an indorsement: inserts a new row, or if one already exists for
    // the same school/private_school_id + type + school_year, updates it in
    // place (this is how a school's indorsement moves from 1st -> 2nd -> 3rd
    // etc. as it's forwarded back and forth). ind_number IS updated on
    // conflict — this line was missing before and is why re-saving a school's
    // 2nd/3rd/etc. indorsement kept showing "1" everywhere.
    if ($method === 'POST' && $action === 'save') {

        $schoolName  = trim((string)($body['school_name']  ?? ''));
        $type        = trim((string)($body['type']         ?? ''));
        $schoolYear  = normalizeSchoolYear((string)($body['school_year']  ?? ''));
        $letterDate  = trim((string)($body['letter_date']  ?? '')) ?: date('Y-m-d');

        if ($schoolName === '') jsonError('school_name is required');
        if (!in_array($type, VALID_IND_TYPES, true)) {
            jsonError('type must be one of: ' . implode(', ', VALID_IND_TYPES));
        }
        if ($schoolYear === '') jsonError('school_year is required');

        $schoolId        = isset($body['school_id']) && $body['school_id'] !== '' && $body['school_id'] !== null
                              ? (int)$body['school_id'] : null;
        $privateSchoolId = isset($body['private_school_id']) && $body['private_school_id'] !== '' && $body['private_school_id'] !== null
                              ? (int)$body['private_school_id'] : null;
        $address    = trim((string)($body['address']      ?? '')) ?: null;
        $indNumber  = isset($body['ind_number']) ? (int)$body['ind_number'] : 1;
        $level      = trim((string)($body['level']        ?? '')) ?: null;
        $sigName    = trim((string)($body['sig_name']     ?? '')) ?: null;
        $sigPos     = trim((string)($body['sig_position'] ?? '')) ?: null;
        $preview    = trim((string)($body['preview_text'] ?? '')) ?: null;
        $userId     = $authUser['id'] ?? null;

        $stmt = $pdo->prepare("
            INSERT INTO school_indorsements
                (school_id, private_school_id, school_name, address, school_year, type,
                 ind_number, level, letter_date, sig_name, sig_position,
                 preview_text, created_by)
            VALUES
                (:school_id, :private_school_id, :school_name, :address, :school_year, :type,
                 :ind_number, :level, :letter_date, :sig_name, :sig_position,
                 :preview_text, :created_by)
            ON DUPLICATE KEY UPDATE
                school_id         = VALUES(school_id),
                school_name       = VALUES(school_name),
                address           = VALUES(address),
                ind_number        = VALUES(ind_number),
                level             = VALUES(level),
                letter_date       = VALUES(letter_date),
                sig_name          = VALUES(sig_name),
                sig_position      = VALUES(sig_position),
                preview_text      = VALUES(preview_text),
                updated_at        = CURRENT_TIMESTAMP
        ");
        $stmt->execute([
            ':school_id'         => $schoolId,
            ':private_school_id' => $privateSchoolId,
            ':school_name'       => $schoolName,
            ':address'           => $address,
            ':school_year'       => $schoolYear,
            ':type'              => $type,
            ':ind_number'        => $indNumber,
            ':level'             => $level,
            ':letter_date'       => $letterDate,
            ':sig_name'          => $sigName,
            ':sig_position'      => $sigPos,
            ':preview_text'      => $preview,
            ':created_by'        => $userId,
        ]);

        // lastInsertId returns 0 on an UPDATE, so look the row up if needed
        $newId = (int) $pdo->lastInsertId();
        if (!$newId) {
            $find = $pdo->prepare("
                SELECT id FROM school_indorsements
                WHERE (private_school_id = :psid OR (:psid IS NULL AND school_id = :sid))
                  AND type        = :type
                  AND school_year = :sy
                  AND ind_number  = :num
                LIMIT 1
            ");
            $find->execute([
                ':psid' => $privateSchoolId,
                ':sid'  => $schoolId,
                ':type' => $type,
                ':sy'   => $schoolYear,
                ':num'  => $indNumber,
            ]);
            $newId = (int) ($find->fetchColumn() ?: 0);
        }

        jsonOut([
            'success'           => true,
            'id'                => $newId,
            'school_id'         => $schoolId,
            'private_school_id' => $privateSchoolId,
        ]);
    }

    // ── POST delete ────────────────────────────────────────────────────────
    // Hard-deletes a single indorsement by id.
    // Only the original creator or an admin/superadmin may delete.
    if ($method === 'POST' && $action === 'delete') {

        $id = isset($body['id']) ? (int)$body['id'] : 0;
        if (!$id) jsonError('id is required');

        // Fetch the row first so we can check ownership
        $chk = $pdo->prepare("SELECT id, created_by FROM school_indorsements WHERE id = :id");
        $chk->execute([':id' => $id]);
        $row = $chk->fetch(PDO::FETCH_ASSOC);

        if (!$row) jsonError('Indorsement not found', 404);

        $role      = $authUser['role']         ?? '';
        $acctType  = $authUser['account_type'] ?? '';
        $isAdmin   = in_array($role, ['admin', 'superadmin'], true)
                  || in_array($acctType, ['admin', 'superadmin'], true);
        $isOwner   = (int)$row['created_by'] === (int)($authUser['id'] ?? -1);

        if (!$isAdmin && !$isOwner) {
            jsonError('You do not have permission to delete this indorsement.', 403);
        }

        $del = $pdo->prepare("DELETE FROM school_indorsements WHERE id = :id");
        $del->execute([':id' => $id]);

        jsonOut(['success' => true, 'deleted_id' => $id]);
    }

    jsonError('Unknown action: ' . htmlspecialchars($action));

} catch (Throwable $e) {
    error_log('school-indorsements.php error: ' . $e->getMessage());
    jsonError('Server error — please try again.', 500);
}
