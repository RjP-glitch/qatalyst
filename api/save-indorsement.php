<?php
/**
 * save-indorsement.php
 * POST — saves one indorsement record into school_indorsements
 *
 * Called by indorsement-generator.js → saveIndorsement()
 * JSON body:
 *   school_id     int|null
 *   school_name   string   (required)
 *   address       string
 *   school_year   string   (required)  e.g. 2025-2026
 *   type          string   (required)  school_calendar|tuition_increase|no_increase|school_permit
 *   ind_number    int      default 1
 *   level         string
 *   letter_date   string   YYYY-MM-DD
 *   sig_name      string
 *   sig_position  string
 *   preview_text  string
 *
 * Response: { success: true, id: int, school_id: int|null }
 */

ini_set('display_errors', 0);
error_reporting(E_ALL);
ini_set('log_errors', 1);

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
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

// ── Method guard ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// ── Parse body ────────────────────────────────────────────────────────────────
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid JSON body']);
    exit;
}

// ── Validate required fields ──────────────────────────────────────────────────
$schoolName = trim($body['school_name'] ?? '');
$type       = trim($body['type']        ?? '');
$schoolYear = trim($body['school_year'] ?? '');
$letterDate = trim($body['letter_date'] ?? '') ?: date('Y-m-d');

$allowedTypes = ['school_calendar', 'tuition_increase', 'no_increase', 'school_permit'];

if (!$schoolName) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'school_name is required']);
    exit;
}
if (!$type || !in_array($type, $allowedTypes, true)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Valid type is required: ' . implode(', ', $allowedTypes)]);
    exit;
}
if (!$schoolYear) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'school_year is required']);
    exit;
}

// ── Sanitise / cast remaining fields ─────────────────────────────────────────
$schoolId        = isset($body['school_id']) && $body['school_id'] !== '' && $body['school_id'] !== null
                     ? intval($body['school_id']) : null;
$privateSchoolId = isset($body['private_school_id']) && $body['private_school_id'] !== '' && $body['private_school_id'] !== null
                     ? intval($body['private_school_id']) : null;
$address   = trim($body['address']      ?? '') ?: null;
$indNumber = intval($body['ind_number'] ?? 1);
$level     = trim($body['level']        ?? '') ?: null;
$sigName   = trim($body['sig_name']     ?? '') ?: null;
$sigPos    = trim($body['sig_position'] ?? '') ?: null;
$preview   = trim($body['preview_text'] ?? '') ?: null;

// ── Upsert (insert or update if same school+type+year+number) ─────────────────
try {
    $pdo = getDB();

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
        ':created_by'        => $authUser['id'] ?? null,
    ]);

    // lastInsertId returns 0 on update, so fetch the actual id
    $newId = (int) $pdo->lastInsertId();
    if (!$newId) {
        $find = $pdo->prepare("
            SELECT id FROM school_indorsements
            WHERE private_school_id = :psid
              AND type              = :type
              AND school_year       = :sy
              AND ind_number        = :num
            LIMIT 1
        ");
        $find->execute([
            ':psid' => $privateSchoolId,
            ':type' => $type,
            ':sy'   => $schoolYear,
            ':num'  => $indNumber,
        ]);
        $newId = (int) ($find->fetchColumn() ?: 0);
    }

    echo json_encode([
        'success'           => true,
        'id'                => $newId,
        'school_id'         => $schoolId,
        'private_school_id' => $privateSchoolId,
    ]);

} catch (Throwable $e) {
    error_log('save-indorsement.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
}
