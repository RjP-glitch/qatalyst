<?php
/**
 * POST /api/school-portal-register.php
 * Registers a School User against an existing active school. SDO approval is separate.
 *
 * Payload (JSON):
 * {
 *   role         : ignored; all school accounts use the teacher storage role
 *   first_name   : string
 *   last_name    : string
 *   email        : string
 *   school_type  : 'public' | 'private'   — NEW: toggles district requirement
 *   district_id  : int|null      — required for public; null/omitted for private
 *   school_id    : int           — existing active school record
 *   school       : string        — selected school's display name
 *   grade        : string        — grade/year level or department
 *   school_id_no : string        — student/employee ID number
 *   password     : string
 * }
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/security.php';
require_once __DIR__ . '/../config/school_portal.php';
require_once __DIR__ . '/../helpers/SchoolVerification.php';

setCorsHeaders();
handlePreflight();
setSecurityHeaders();
header('Content-Type: application/json');

// ── Method guard ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
$pdo = getDB();
if (!checkRateLimit($pdo, 'register', 10, 15)) {
    http_response_code(429);
    echo json_encode(['success' => false, 'message' => 'Too many registration attempts. Please wait 15 minutes.']);
    exit;
}

// ── Parse JSON body ───────────────────────────────────────────────────────────
$raw = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid request body']);
    exit;
}

foreach (['first_name', 'last_name', 'email', 'password', 'school_type', 'school', 'grade', 'school_id_no'] as $field) {
    if (isset($body[$field]) && !is_string($body[$field])) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'Invalid registration field: ' . $field]);
        exit;
    }
}
foreach (['school_id', 'district_id'] as $field) {
    if (isset($body[$field]) && $body[$field] !== '' && filter_var($body[$field], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]) === false) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'Invalid school or district selection.']);
        exit;
    }
}

// ── Sanitize inputs ───────────────────────────────────────────────────────────
$allowedSexes = ['Male', 'Female', 'Prefer not to say'];
$allowedSchoolTypes = ['public', 'private'];
$role        = 'teacher';
$sex         = in_array($body['sex']  ?? '', $allowedSexes, true) ? $body['sex']  : 'Prefer not to say';
$schoolType  = in_array($body['school_type'] ?? '', $allowedSchoolTypes, true) ? $body['school_type'] : 'public';
$firstName   = sanitizeInput($body['first_name']   ?? '', 100);
$lastName    = sanitizeInput($body['last_name']    ?? '', 100);
$email       = strtolower(trim($body['email']      ?? ''));
$districtId  = isset($body['district_id']) && $body['district_id'] !== '' ? sanitizeInt($body['district_id']) : null;
$schoolId        = isset($body['school_id']) && $body['school_id'] !== '' ? sanitizeInt($body['school_id']) : null;
$publicSchoolId  = null;
$privateSchoolId = null;
$school      = sanitizeInput($body['school']       ?? '', 255);
$grade       = sanitizeInput($body['grade']        ?? '', 100);
$schoolIdNo  = sanitizeInput($body['school_id_no'] ?? '', 50);
$password    = $body['password'] ?? '';

// For private schools, district is not required
if ($schoolType === 'private') {
    $districtId      = null;
    $privateSchoolId = $schoolId;
    $publicSchoolId  = null;
} else {
    $publicSchoolId  = $schoolId;
    $privateSchoolId = null;
}

// ── Validation ────────────────────────────────────────────────────────────────
$errors = [];

if (!$firstName) $errors[] = 'First name is required.';
if (!$lastName)  $errors[] = 'Last name is required.';

if (!$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors[] = 'A valid email address is required.';
}
if (strlen($email) > 255) {
    $errors[] = 'Email address is too long.';
}

if (!in_array($body['school_type'] ?? '', $allowedSchoolTypes, true)) $errors[] = 'Please select a valid school type.';
if (!$schoolId || $schoolId < 1) $errors[] = 'Select an existing school. If it is missing, contact SDO to add it.';

if (strlen($password) < 8) {
    $errors[] = 'Password must be at least 8 characters.';
}
if (strlen($password) > 72) {
    $errors[] = 'Password must be at most 72 bytes.';
}

$levels = json_decode($grade ?: '[]', true);
if (!is_array($levels)) {
    $errors[] = 'Invalid school levels.';
} else {
    foreach ($levels as $level) {
        if (!is_string($level) || !in_array($level, ['pre', 'elem', 'jhs', 'shs'], true)) { $errors[] = 'Invalid school levels.'; break; }
    }
}

if (!empty($errors)) {
    http_response_code(422);
    echo json_encode(['success' => false, 'message' => implode(' ', $errors)]);
    exit;
}

// Validate a canonical school and district; never trust names or IDs from the UI.
try {
    $schoolInfo = portalResolveSchool($pdo, ['school_type' => $schoolType, 'school_id' => $publicSchoolId, 'private_school_id' => $privateSchoolId]);
    if (!$schoolInfo) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'The selected school is unavailable. Please select an active school.']);
        exit;
    }
    if ($schoolType === 'public') {
        if (!array_key_exists('district_id', $body) || $body['district_id'] === '') {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Please select the school district.']);
            exit;
        }
        $district = portalResolveDistrict($pdo, $body['district_id']);
        $canonicalDistrictId = $schoolInfo['row']['district_id'];
        if (!$district || (int)$district['id'] !== (int)$canonicalDistrictId) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'The selected school does not belong to that district.']);
            exit;
        }
        $districtId = $district['id'];
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unable to validate the school. Please try again.']);
    exit;
}

// ── Check duplicate email ─────────────────────────────────────────────────────
try {
    $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        http_response_code(409);
        echo json_encode(['success' => false, 'message' => 'An account with this email already exists.']);
        exit;
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server error. Please try again.']);
    exit;
}

// ── Hash password ─────────────────────────────────────────────────────────────
$passwordHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
$fullName     = trim($firstName . ' ' . $lastName);

// ── Generate email verification token ────────────────────────────────────────
$verifyToken   = bin2hex(random_bytes(32));
$tokenExpires  = date('Y-m-d H:i:s', strtotime('+24 hours'));

// ── Build permissions based on role ──────────────────────────────────────────
$permissions = json_encode(['dashboard']);

// ── Insert user ───────────────────────────────────────────────────────────────
try {
    $pdo->beginTransaction();

    // All portal self-registrations are typed as 'portal_user'.
    // SDO personnel accounts are created exclusively by the admin
    // inside the main system and are typed as 'sdo_personnel'.
    $accountType = 'portal_user';

    $stmt = $pdo->prepare("
        INSERT INTO users (
            email, password, full_name, status,
            email_verified, role, account_type, permissions,
            sex, school_id, private_school_id, school_type, district_id, grade, school_id_no,
            verify_token, verify_token_expires,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?, 'active',
            0, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?,
            NOW(), NOW()
        )
    ");
    $stmt->execute([
        $email,
        $passwordHash,
        $fullName,
        $role,
        $accountType,
        $permissions,
        $sex,
        $publicSchoolId,
        $privateSchoolId,
        $schoolType,
        ($districtId && $districtId > 0) ? $districtId : null,
        $grade       ?: null,
        $schoolIdNo  ?: null,
        $verifyToken,
        $tokenExpires,
    ]);

    $userId = (int) $pdo->lastInsertId();

    // ── workshop_participants skipped for portal_user registrations ───────────
    // Portal users have no associated workshop; the FK on workshop_id is NOT NULL
    // so inserting a placeholder value would violate the constraint. Their profile
    // data is stored on the users table (school_id, district_id, grade, etc.).

    // Self-registration never changes shared school records.
    $pdo->commit();

} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Registration failed. Please try again.']);
    exit;
}

require_once dirname(__DIR__) . '/config/audit_log.php';
auditLog(['pdo' => $pdo, 'user_id' => $userId, 'role' => $role,
    'action' => 'register_school_account', 'module' => 'school_portal', 'status' => 'success',
    'description' => 'School account registered; email verification and SDO approval required.',
    'target_user_id' => $userId, 'entity_type' => 'users', 'entity_id' => (string)$userId]);

// ── Send verification email ───────────────────────────────────────────────────
$emailSent = false;
try {
    $verification = schoolStartVerification($pdo, ['id' => $userId, 'email' => $email, 'full_name' => $fullName]);
    $verifyToken = $verification['verify_token'];
    $emailSent = $verification['verification_email_sent'];
} catch (Throwable $e) {
    error_log('School registration verification setup failed for user #' . $userId);
}

// ── Success ───────────────────────────────────────────────────────────────────
echo json_encode([
    'success' => true,
    'message' => $emailSent ? 'Account created. Check your email to verify it. SDO approval is required for school access.' : 'Account created, but the verification email could not be sent. Use Resend code or sign in again.',
    'data'    => [
        'user_id'        => $userId,
        'email'          => $email,
        'full_name'      => $fullName,
        'role'           => $role,
        'sex'            => $sex,
        'account_type'   => 'portal_user',
        'verify_token'   => $verifyToken,
        'email_verified' => false,
        'verification_email_sent' => $emailSent,
    ]
]);
