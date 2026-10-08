<?php
/**
 * POST /api/school-portal-profile-update.php
 * Updates editable school/profile settings for authenticated portal users.
 *
 * Handles:
 *  – users table : grade, school_id_no, profile_picture, school_logo
 *  – school table: street_address, barangay, city, levels (JSON), status,
 *                  elem_principal, elem_contact, jhs_principal, jhs_contact,
 *                  shs_principal, shs_contact, registrar_name, registrar_contact
 *
 * The school table (public_schools or private_schools) is determined by the
 * user's linked school_id and school_type stored in the users table.
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

function jsonSuccess(array $data = [], string $message = 'Success', int $code = 200): void {
    if (ob_get_level()) ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => true, 'message' => $message, 'data' => $data],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError(string $message, int $code = 400): void {
    global $pdo;
    if ($pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    if (ob_get_level()) ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function ensureSchoolLogoColumn(PDO $pdo): void {
    $stmt = $pdo->query("SHOW COLUMNS FROM users LIKE 'school_logo'");
    if (!$stmt->fetch(PDO::FETCH_ASSOC)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN school_logo LONGTEXT NULL AFTER profile_picture");
    }
}

function getMaxAllowedPacket(PDO $pdo): int {
    try {
        $stmt = $pdo->query("SHOW VARIABLES LIKE 'max_allowed_packet'");
        $row  = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : null;
        $val  = isset($row['Value']) ? (int)$row['Value'] : 0;
        return $val > 0 ? $val : 1048576;
    } catch (Throwable $e) {
        return 1048576;
    }
}

function tableHasColumn(PDO $pdo, string $table, string $column): bool {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `{$table}` LIKE " . $pdo->quote($column));
        return (bool)($stmt && $stmt->fetch(PDO::FETCH_ASSOC));
    } catch (Throwable $e) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $user = authenticate();
    if (!$user) jsonError('Unauthorized. Please sign in.', 401);

    if (($user['account_type'] ?? '') !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $raw  = file_get_contents('php://input');
    $body = json_decode($raw, true);
    if (!is_array($body)) jsonError('Invalid JSON payload.', 422);
    foreach ($body as $key => $value) {
        if ($key !== 'levels' && $value !== null && !is_scalar($value)) jsonError('Invalid profile field: ' . $key, 422);
    }
    $personalKeys = ['grade', 'school_id_no', 'profile_picture'];
    $schoolChanges = array_diff(array_keys($body), $personalKeys);
    if ($schoolChanges) requireSchoolApproval($user);

    $auditUserFields = [];
    $auditSchoolFields = [];
    $auditSchoolTable = null;
    $auditSchoolRowId = null;

    // ── Scalar field extraction (treat fields as optional; update only if provided) ──
    $gradeProvided        = array_key_exists('grade', $body);
    $schoolIdNoProvided   = array_key_exists('school_id_no', $body);
    $streetProvided       = array_key_exists('street_address', $body);
    $barangayProvided     = array_key_exists('barangay', $body);
    $cityProvided         = array_key_exists('city', $body);
    $levelsProvided       = array_key_exists('levels', $body);
    $statusProvided       = array_key_exists('status', $body);
    $elemProvided         = array_key_exists('elem_contact', $body) || array_key_exists('elem_principal', $body) || array_key_exists('elem_admin', $body);
    $jhsProvided          = array_key_exists('jhs_contact', $body) || array_key_exists('jhs_principal', $body) || array_key_exists('jhs_admin', $body);
    $shsProvided          = array_key_exists('shs_contact', $body) || array_key_exists('shs_principal', $body) || array_key_exists('shs_admin', $body);
    $registrarProvided    = array_key_exists('registrar_name', $body) || array_key_exists('registrar_contact', $body);

    // User-level fields
    $grade        = trim((string)($body['grade']        ?? ''));
    $schoolIdNo   = trim((string)($body['school_id_no'] ?? ''));

    // Existing portal school fields
    $streetAddress = trim((string)($body['street_address'] ?? ''));
    $barangay      = trim((string)($body['barangay']       ?? ''));
    $city          = trim((string)($body['city']           ?? ''));
    $levelsRaw     = $body['levels'] ?? null;

    // Directory-aligned fields
    $dirNameProvided         = array_key_exists('name', $body);
    $positionProvided        = array_key_exists('position', $body);
    $districtProvided        = array_key_exists('district', $body) || array_key_exists('district_id', $body);
    $schoolIdProvided        = array_key_exists('school_id', $body);
    $schoolNameProvided      = array_key_exists('school_name', $body);
    $birthdateProvided       = array_key_exists('birthdate', $body);
    $contactNumberProvided   = array_key_exists('contact_number', $body);
    $emailProvided           = array_key_exists('email', $body);
    $firstDayStationProvided = array_key_exists('first_day_station', $body);

    $dirName            = trim((string)($body['name']              ?? ''));
    $position           = trim((string)($body['position']          ?? ''));
    $district           = trim((string)($body['district']          ?? ''));
    $schoolId           = trim((string)($body['school_id']         ?? ''));
    $schoolName         = trim((string)($body['school_name']       ?? ''));
    $birthdate          = trim((string)($body['birthdate']         ?? ''));
    $contactNumber      = trim((string)($body['contact_number']    ?? ''));
    $email              = trim((string)($body['email']             ?? ''));
    $firstDayAtStation  = trim((string)($body['first_day_station'] ?? ''));

    // Private schools: accept elem_admin/jhs_admin/shs_admin aliases
    $status            = trim((string)($body['status']         ?? ''));
    $elemPrincipal     = trim((string)($body['elem_principal'] ?? ($body['elem_admin'] ?? '')));
    $elemContact       = trim((string)($body['elem_contact']   ?? ''));
    $jhsPrincipal      = trim((string)($body['jhs_principal']  ?? ($body['jhs_admin'] ?? '')));
    $jhsContact        = trim((string)($body['jhs_contact']    ?? ''));
    $shsPrincipal      = trim((string)($body['shs_principal']  ?? ($body['shs_admin'] ?? '')));
    $shsContact        = trim((string)($body['shs_contact']    ?? ''));
    $registrarName     = trim((string)($body['registrar_name']     ?? ''));
    $registrarContact  = trim((string)($body['registrar_contact']  ?? ''));

    $profilePictureProvided = array_key_exists('profile_picture', $body);
    $schoolLogoProvided     = array_key_exists('school_logo',     $body);
    $profilePicture         = $profilePictureProvided ? $body['profile_picture'] : null;
    $schoolLogo             = $schoolLogoProvided     ? $body['school_logo']     : null;

    // ── Length guards ─────────────────────────────────────────────────────────
    $lengthChecks = [];

    if ($gradeProvided)      $lengthChecks['grade']        = [$grade, 100];
    if ($schoolIdNoProvided) $lengthChecks['school_id_no'] = [$schoolIdNo, 50];

    if ($streetProvided)   $lengthChecks['street_address'] = [$streetAddress, 255];
    if ($barangayProvided) $lengthChecks['barangay']       = [$barangay, 100];
    if ($cityProvided)     $lengthChecks['city']           = [$city, 100];

    // Directory-aligned public fields
    if ($dirNameProvided)         $lengthChecks['name']              = [$dirName, 255];
    if ($positionProvided)        $lengthChecks['position']          = [$position, 255];
    if ($districtProvided)        $lengthChecks['district']          = [$district, 50];
    if ($schoolIdProvided)        $lengthChecks['school_id']         = [$schoolId, 50];
    if ($schoolNameProvided)      $lengthChecks['school_name']       = [$schoolName, 255];
    if ($birthdateProvided)       $lengthChecks['birthdate']         = [$birthdate, 50];
    if ($contactNumberProvided)   $lengthChecks['contact_number']    = [$contactNumber, 50];
    if ($emailProvided)           $lengthChecks['email']             = [$email, 150];
    if ($firstDayStationProvided) $lengthChecks['first_day_station'] = [$firstDayAtStation, 50];

    // Directory-aligned private fields
    if ($statusProvided)    $lengthChecks['status']            = [$status, 50];
    if ($elemProvided)      $lengthChecks['elem_principal']    = [$elemPrincipal, 150];
    if (array_key_exists('elem_contact', $body)) $lengthChecks['elem_contact'] = [$elemContact, 50];
    if ($jhsProvided)       $lengthChecks['jhs_principal']     = [$jhsPrincipal, 150];
    if (array_key_exists('jhs_contact', $body))  $lengthChecks['jhs_contact']  = [$jhsContact, 50];
    if ($shsProvided)       $lengthChecks['shs_principal']     = [$shsPrincipal, 150];
    if (array_key_exists('shs_contact', $body))  $lengthChecks['shs_contact']  = [$shsContact, 50];
    if ($registrarProvided) {
        if (array_key_exists('registrar_name', $body))     $lengthChecks['registrar_name']     = [$registrarName, 150];
        if (array_key_exists('registrar_contact', $body))  $lengthChecks['registrar_contact']  = [$registrarContact, 50];
    }

    foreach ($lengthChecks as $field => [$val, $max]) {
        if (mb_strlen((string)$val) > $max) {
            jsonError(ucwords(str_replace('_', ' ', $field)) . ' is too long.', 422);
        }
    }
    if ($emailProvided && $email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) jsonError('Please enter a valid school head email address.', 422);
    if ($dirNameProvided && $dirName === '') jsonError('Name is required.', 422);
    if ($positionProvided && $position === '') jsonError('Position is required.', 422);
    if ($schoolNameProvided && $schoolName === '') jsonError('School name is required.', 422);
    foreach (['birthdate' => $birthdate, 'first_day_station' => $firstDayAtStation] as $key => $value) {
        if (!array_key_exists($key, $body) || $value === '') continue;
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        if (!$date || $date->format('Y-m-d') !== $value) jsonError('Invalid date for ' . str_replace('_', ' ', $key) . '.', 422);
    }

    // ── Validate / normalise levels ───────────────────────────────────────────
    $allowedLevels = ['pre', 'elem', 'jhs', 'shs'];
    $levelsArr     = [];
    if ($levelsProvided && $levelsRaw !== null) {
        if (is_array($levelsRaw)) {
            $levelsArr = $levelsRaw;
        } elseif (is_string($levelsRaw)) {
            $decoded   = json_decode($levelsRaw, true);
            if (!is_array($decoded)) jsonError('Invalid school levels.', 422);
            $levelsArr = $decoded;
        }
        foreach ($levelsArr as $level) {
            if (!is_string($level) || !in_array($level, $allowedLevels, true)) jsonError('Invalid school levels.', 422);
        }
        $levelsArr = array_values(array_filter(
            array_map('strval', $levelsArr),
            fn($l) => in_array($l, $allowedLevels, true)
        ));
    }
    $levelsJson = $levelsProvided ? (count($levelsArr) ? json_encode($levelsArr) : null) : null;

    // ── Validate status ───────────────────────────────────────────────────────
    $allowedStatuses = ['', 'TEMPORARILY CLOSED', 'WAITING FOR NOTICE OF CLOSURE', 'CLOSED'];
    if ($statusProvided && !in_array($status, $allowedStatuses, true)) {
        jsonError('Invalid school status value.', 422);
    }

    // ── DB setup ──────────────────────────────────────────────────────────────
    $pdo = getDB();
    ensureSchoolLogoColumn($pdo);

    $maxAllowedPacket       = getMaxAllowedPacket($pdo);
    $packetSafeDecodedBytes = max(120 * 1024, (int)floor($maxAllowedPacket * 0.72));

    $validateImageDataUrl = static function (&$value, string $label, int $maxBytes, int $packetSafeBytes): void {
        if ($value === null) return;
        $value = trim((string)$value);
        if ($value === '') { $value = null; return; }

        if (!preg_match('#^data:image/(png|jpe?g|webp);base64,#i', $value)) {
            jsonError($label . ' must be a PNG, JPG, or WEBP image.', 422);
        }
        $parts = explode(',', $value, 2);
        $raw   = isset($parts[1]) ? base64_decode($parts[1], true) : false;
        if ($raw === false) jsonError($label . ' payload is invalid.', 422);

        $effectiveMax = min($maxBytes, $packetSafeBytes);
        if (strlen($raw) > $effectiveMax) {
            if ($packetSafeBytes < $maxBytes) {
                $safeKb = (int)floor($packetSafeBytes / 1024);
                jsonError($label . ' is too large for current server packet limits. Please use an image around ' . $safeKb . 'KB or smaller.', 422);
            }
            jsonError($label . ' is too large. Maximum size is ' . round($maxBytes / (1024 * 1024), 1) . 'MB.', 422);
        }
    };

    if ($profilePictureProvided) {
        $validateImageDataUrl($profilePicture, 'Profile picture', (int)(1.5 * 1024 * 1024), $packetSafeDecodedBytes);
    }
    if ($schoolLogoProvided) {
        $validateImageDataUrl($schoolLogo, 'School logo', 3 * 1024 * 1024, $packetSafeDecodedBytes);
    }

    $districtInfo = $districtProvided ? portalResolveDistrict($pdo, $body['district_id'] ?? null, $district) : null;
    if ($districtProvided && !$districtInfo) jsonError('Please select a valid district.', 422);

    // Lock the account before its school, matching SDO approval/revocation.
    $pdo->beginTransaction();
    $lockUser = $pdo->prepare('SELECT * FROM users WHERE id = ? FOR UPDATE');
    $lockUser->execute([(int)$user['id']]);
    $user = $lockUser->fetch(PDO::FETCH_ASSOC);
    if (!$user || $user['status'] !== 'active' || empty($user['email_verified']) || $user['account_type'] !== 'portal_user') jsonError('Unauthorized.', 401);
    $schoolInfo = portalResolveSchool($pdo, $user, true);
    auditOperationBefore('users', $user);
    if ($schoolInfo) auditOperationBefore($schoolInfo['table'], $schoolInfo['row']);
    if ($schoolChanges && (!portalSchoolIsApproved($user) || !$schoolInfo)) jsonError('SDO approval and an active school link are required to save school settings.', 403);
    $allowedFields = $personalKeys;
    if ($schoolInfo && $schoolInfo['table'] === 'public_schools') {
        $allowedFields = array_merge($allowedFields, ['school_logo', 'name', 'position', 'district', 'district_id', 'school_id', 'school_name', 'birthdate', 'contact_number', 'email', 'first_day_station']);
    } elseif ($schoolInfo) {
        $allowedFields = array_merge($allowedFields, ['school_logo', 'name', 'status', 'street_address', 'barangay', 'city', 'levels', 'elem_principal', 'elem_admin', 'elem_contact', 'jhs_principal', 'jhs_admin', 'jhs_contact', 'shs_principal', 'shs_admin', 'shs_contact', 'registrar_name', 'registrar_contact']);
    }
    if (array_diff(array_keys($body), $allowedFields)) jsonError('One or more fields are not editable for this school type.', 422);

    // ── Update users table ────────────────────────────────────────────────────
    $userUpdates = ['updated_at = NOW()'];
    $userParams  = [':id' => (int)$user['id']];

    if ($gradeProvided) {
        $userUpdates[]      = 'grade = :grade';
        $userParams[':grade'] = $grade !== '' ? $grade : null;
        $auditUserFields[] = 'grade';
    }
    if ($schoolIdNoProvided) {
        $userUpdates[]              = 'school_id_no = :school_id_no';
        $userParams[':school_id_no'] = $schoolIdNo !== '' ? $schoolIdNo : null;
        $auditUserFields[] = 'school_id_no';
    }

    if ($profilePictureProvided) {
        $userUpdates[]                  = 'profile_picture = :profile_picture';
        $userParams[':profile_picture'] = $profilePicture;
        $auditUserFields[] = 'profile_picture';
    }
    if ($schoolLogoProvided) {
        $userUpdates[]              = 'school_logo = :school_logo';
        $userParams[':school_logo'] = $schoolLogo;
        $auditUserFields[] = 'school_logo';
    }

    $shouldUpdateUsers = $gradeProvided || $schoolIdNoProvided || $profilePictureProvided || $schoolLogoProvided;
    if ($shouldUpdateUsers) {
        $pdo->prepare("UPDATE users SET " . implode(', ', $userUpdates) . " WHERE id = :id")
            ->execute($userParams);
    }

    // ── Update school table ───────────────────────────────────────────────────
    if ($schoolChanges && $schoolInfo) {
        $tbl = $schoolInfo['table']; // safe — determined by our logic, not user input
        $auditSchoolTable = $tbl;
        $auditSchoolRowId = (int)$schoolInfo['id'];

        $schoolSets   = ['updated_at = NOW()'];
        $schoolParams = [':linked_school_id' => $schoolInfo['id']];

        $addCol = function (bool $provided, string $col, $value) use (&$schoolSets, &$schoolParams, &$auditSchoolFields, $pdo, $tbl): void {
            if (!$provided) return;
            if (!tableHasColumn($pdo, $tbl, $col)) jsonError('This school field is unavailable: ' . $col . '.', 422);
            $param = ':' . $col;
            $schoolSets[] = "`{$col}` = {$param}";
            $schoolParams[$param] = ($value === '' ? null : $value);
            $auditSchoolFields[] = $col;
        };

        // Existing portal school fields (optional)
        $addCol($streetProvided,   'street_address', $streetAddress);
        $addCol($barangayProvided, 'barangay',       $barangay);
        $addCol($cityProvided,     'city',           $city !== '' ? $city : 'City of Baliwag');
        $addCol($levelsProvided,   'levels',         $levelsJson);

        // Directory-aligned updates (based on which table the user is linked to)
        if ($tbl === 'private_schools') {
            $addCol($dirNameProvided, 'name', $dirName);
            $addCol($statusProvided,  'status', $status);

            $elemPrincipalProvided = array_key_exists('elem_principal', $body) || array_key_exists('elem_admin', $body);
            $jhsPrincipalProvided  = array_key_exists('jhs_principal',  $body) || array_key_exists('jhs_admin',  $body);
            $shsPrincipalProvided  = array_key_exists('shs_principal',  $body) || array_key_exists('shs_admin',  $body);
            $elemContactProvided   = array_key_exists('elem_contact', $body);
            $jhsContactProvided    = array_key_exists('jhs_contact', $body);
            $shsContactProvided    = array_key_exists('shs_contact', $body);

            $addCol($elemPrincipalProvided, 'elem_principal', $elemPrincipal);
            $addCol($elemContactProvided,   'elem_contact',   $elemContact);
            $addCol($jhsPrincipalProvided,  'jhs_principal',  $jhsPrincipal);
            $addCol($jhsContactProvided,    'jhs_contact',    $jhsContact);
            $addCol($shsPrincipalProvided,  'shs_principal',  $shsPrincipal);
            $addCol($shsContactProvided,    'shs_contact',    $shsContact);
            $addCol(array_key_exists('registrar_name', $body),    'registrar_name',    $registrarName);
            $addCol(array_key_exists('registrar_contact', $body), 'registrar_contact', $registrarContact);
        }

        if ($tbl === 'public_schools') {
            // Directory: public school head record
            $addCol($dirNameProvided,         'name',              $dirName);
            $addCol($positionProvided,        'position',          $position);
            $addCol($districtProvided,        'district',          $districtInfo['name'] ?? null);
            $addCol($districtProvided,        'district_id',       $districtInfo['id'] ?? null);
            $addCol($schoolIdProvided,        'school_id',         $schoolId);
            $addCol($schoolNameProvided,      'school_name',       $schoolName);
            $addCol($birthdateProvided,       'birthdate',         $birthdate);
            $addCol($contactNumberProvided,   'contact_number',    $contactNumber);
            $addCol($emailProvided,           'email',             $email);
            $addCol($firstDayStationProvided, 'first_day_station', $firstDayAtStation);
        }

        // Add updated_by only if the column exists on this table and we're updating something
        if (count($schoolSets) > 1 && tableHasColumn($pdo, $tbl, 'updated_by')) {
            $schoolSets[] = 'updated_by = :updated_by';
            $schoolParams[':updated_by'] = (int)$user['id'];
        }

        if (count($schoolSets) > 1) {
            $pdo->prepare(
                "UPDATE `{$tbl}` SET " . implode(', ', $schoolSets) . " WHERE id = :linked_school_id"
            )->execute($schoolParams);
            if ($tbl === 'public_schools' && $districtProvided) {
                // Current affiliations follow the school; historical submissions stay snapshots.
                $pdo->prepare("UPDATE users SET district_id = ?, updated_at = NOW() WHERE account_type = 'portal_user' AND school_type = 'public' AND school_id = ?")
                    ->execute([$districtInfo['id'], $schoolInfo['id']]);
            }
        }
    }

    $pdo->commit();

    // ── Return fresh users data ───────────────────────────────────────────────
    $freshStmt = $pdo->prepare(
        "SELECT grade, school_id_no, profile_picture, school_logo FROM users WHERE id = :id LIMIT 1"
    );
    $freshStmt->execute([':id' => (int)$user['id']]);
    $fresh = $freshStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    // ── Audit log (non-blocking) ─────────────────────────────────────────────
    try {
        auditEnsureTable($pdo);

        $descParts = [];
        if ($auditUserFields) {
            $descParts[] = 'users: ' . implode(', ', array_values(array_unique($auditUserFields)));
        }
        if ($auditSchoolFields) {
            $label = ($auditSchoolTable ?: 'school') . ($auditSchoolRowId ? ('#' . $auditSchoolRowId) : '');
            $descParts[] = $label . ': ' . implode(', ', array_values(array_unique($auditSchoolFields)));
        }
        $desc = $descParts ? ('Updated profile/settings (' . implode(' | ', $descParts) . ')') : 'Updated profile/settings';

        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)$user['id'],
            'role' => (string)($user['role'] ?? $user['account_type'] ?? 'portal_user'),
            'action' => 'update_profile',
            'module' => 'school_portal',
            'status' => 'success',
            'description' => $desc,
        ]);
    } catch (Throwable $e) {
        // ignore
    }

    jsonSuccess([
        'grade'           => $fresh['grade']           ?? $grade,
        'school_id_no'    => $fresh['school_id_no']    ?? $schoolIdNo,
        'profile_picture' => $fresh['profile_picture'] ?? null,
        'school_logo'     => $fresh['school_logo']     ?? null,
    ], 'Profile settings updated successfully.');

} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    if (stripos($e->getMessage(), 'max_allowed_packet') !== false) {
        jsonError('Uploaded image is too large for current server packet limits. Please use a smaller image.', 413);
    }
    error_log('school-portal-profile-update.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
