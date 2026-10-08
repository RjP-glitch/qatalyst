<?php
/**
 * GET /api/school-portal-dashboard.php
 * Returns dashboard data for the authenticated school portal user:
 * - user info
 * - school info
 * - submission stats (counts only — no submission records)
 *
 * Submission records are fetched separately by school-portal-submissions.php
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

function ensureSchoolLogoColumn(PDO $pdo): void {
    $stmt = $pdo->query("SHOW COLUMNS FROM users LIKE 'school_logo'");
    if (!$stmt->fetch(PDO::FETCH_ASSOC)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN school_logo LONGTEXT NULL AFTER profile_picture");
    }
}

function ensureSchoolTypeColumn(PDO $pdo): void {
    $stmt = $pdo->query("SHOW COLUMNS FROM users LIKE 'school_type'");
    if (!$stmt->fetch(PDO::FETCH_ASSOC)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN school_type VARCHAR(50) NULL AFTER school_id");
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

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') jsonError('Method not allowed', 405);

    // ── Auth ──────────────────────────────────────────────────────────────────
    $user = authenticate();
    if (!$user) jsonError('Unauthorized. Please sign in.', 401);

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType === 'sdo_personnel') {
        jsonError('Access denied. SDO personnel accounts use the main system dashboard.', 403);
    }

    $db     = getDB();
    $userId = (int)$user['id'];
    ensureSchoolLogoColumn($db);
    ensureSchoolTypeColumn($db);

    // ── School info ───────────────────────────────────────────────────────────
    // First, get the user's school_id, district_id, and user-level fields.
    $uStmt = $db->prepare("
        SELECT school_id, private_school_id, school_type, district_id, grade, school_id_no, school_logo, email_verified
        FROM users WHERE id = :uid LIMIT 1
    ");
    $uStmt->execute([':uid' => $userId]);
    $uRow = $uStmt->fetch(PDO::FETCH_ASSOC);
    $linkedSchool = portalResolveSchool($db, $user);
    $schoolApproved = portalSchoolIsApproved($user) && (bool)$linkedSchool;

    $linkedSchoolType = strtolower((string)($uRow['school_type'] ?? ''));
    $isExplicitlyPrivate = str_contains($linkedSchoolType, 'private');

    // Private schools use private_school_id; public schools use school_id
    $linkedSchoolId = $isExplicitlyPrivate
        ? (int)($uRow['private_school_id'] ?? 0)
        : (int)($uRow['school_id'] ?? 0);

    $schoolRow  = null;
    $isPrivate  = false;

    if ($linkedSchool && $schoolApproved) {

        // Try public_schools first unless explicitly private
        if (!$isExplicitlyPrivate) {
            $hasPublicSchoolName = tableHasColumn($db, 'public_schools', 'school_name');
            $hasPublicDistrictId = tableHasColumn($db, 'public_schools', 'district_id');
            $hasPublicDistrict   = tableHasColumn($db, 'public_schools', 'district');

            $selectSchoolName = $hasPublicSchoolName ? 'ps.school_name AS name' : 'ps.name AS name';
            $selectSchoolType = tableHasColumn($db, 'public_schools', 'school_type')
                ? 'ps.school_type AS school_type'
                : "'Public School' AS school_type";

            $selectDepedId = 'NULL AS deped_id';
            if (tableHasColumn($db, 'public_schools', 'deped_school_id')) {
                $selectDepedId = 'ps.deped_school_id AS deped_id';
            } elseif (tableHasColumn($db, 'public_schools', 'school_id')) {
                $selectDepedId = 'ps.school_id AS deped_id';
            }

            $joinDistrict = '';
            $selectDistrictName = 'NULL AS district_name';
            if ($hasPublicDistrictId) {
                $joinDistrict = 'LEFT JOIN districts d ON d.id = ps.district_id';
                $selectDistrictName = 'd.name AS district_name';
            } elseif ($hasPublicDistrict) {
                $selectDistrictName = 'ps.district AS district_name';
            }

            $selPublicOptional = function (string $col, string $alias = null) use ($db): string {
                $alias = $alias ?: $col;
                return tableHasColumn($db, 'public_schools', $col)
                    ? "ps.`{$col}` AS `{$alias}`"
                    : "NULL AS `{$alias}`";
            };

            // public_schools.name = school head's personal name
            // public_schools.school_name = the school's actual name
            // Check each column independently — don't gate head name on school_name's existence.
            $hasPublicName     = tableHasColumn($db, 'public_schools', 'name');
            $publicHeadExpr       = $hasPublicName       ? 'ps.name'        : 'NULL';
            $publicSchoolNameExpr = $hasPublicSchoolName ? 'ps.school_name'  : ($hasPublicName ? 'ps.name' : 'NULL');

            $selectParts = [
                'ps.id',
                $selectSchoolName,
                $selectSchoolType,
                $selectDepedId,
                $selPublicOptional('street_address'),
                $selPublicOptional('barangay'),
                $selPublicOptional('city'),
                $selPublicOptional('levels'),
                $selPublicOptional('status'),
                $selPublicOptional('elem_principal'),
                $selPublicOptional('elem_contact'),
                $selPublicOptional('jhs_principal'),
                $selPublicOptional('jhs_contact'),
                $selPublicOptional('shs_principal'),
                $selPublicOptional('shs_contact'),
                $selPublicOptional('registrar_name'),
                $selPublicOptional('registrar_contact'),
                $selectDistrictName,
                // Directory-aligned fields for Public Schools (school head record)
                $publicHeadExpr . ' AS public_head_name',
                $selPublicOptional('position', 'public_position'),
                // public_district mirrors district_name — no need to re-fetch ps.district separately
                (($hasPublicDistrict ? 'ps.district' : 'NULL') . ' AS public_district'),
                ((tableHasColumn($db, 'public_schools', 'school_id') ? 'ps.school_id' : 'NULL') . ' AS public_school_id'),
                $publicSchoolNameExpr . ' AS public_school_name',
                $selPublicOptional('birthdate', 'public_birthdate'),
                $selPublicOptional('contact_number', 'public_contact_number'),
                $selPublicOptional('email', 'public_email'),
                $selPublicOptional('first_day_station', 'public_first_day_station'),
            ];

            $sql = "SELECT\n    " . implode(",\n    ", $selectParts) . "\nFROM public_schools ps\n";
            if ($joinDistrict) $sql .= $joinDistrict . "\n";
            $sql .= "WHERE ps.id = :sid AND ps.active = 1\nLIMIT 1";

            $s = $db->prepare($sql);
            $s->execute([':sid' => $linkedSchoolId]);
            $schoolRow = $s->fetch(PDO::FETCH_ASSOC) ?: null;
        }

        // Public and private school IDs are independent; never cross tables.
        if ($isExplicitlyPrivate) {
            $selPrivateOptional = function (string $col, string $alias = null) use ($db): string {
                $alias = $alias ?: $col;
                return tableHasColumn($db, 'private_schools', $col)
                    ? "pvs.`{$col}` AS `{$alias}`"
                    : "NULL AS `{$alias}`";
            };

            $selectParts = [
                'pvs.id',
                'pvs.name',
                "'Private School' AS school_type",
                (tableHasColumn($db, 'private_schools', 'school_id_no') ? 'pvs.school_id_no' : 'NULL') . ' AS deped_id',
                $selPrivateOptional('street_address'),
                $selPrivateOptional('barangay'),
                $selPrivateOptional('city'),
                $selPrivateOptional('levels'),
                $selPrivateOptional('status'),
                $selPrivateOptional('elem_principal'),
                $selPrivateOptional('elem_contact'),
                $selPrivateOptional('jhs_principal'),
                $selPrivateOptional('jhs_contact'),
                $selPrivateOptional('shs_principal'),
                $selPrivateOptional('shs_contact'),
                $selPrivateOptional('registrar_name'),
                $selPrivateOptional('registrar_contact'),
                'NULL AS district_name',
                'NULL AS public_head_name',
                'NULL AS public_position',
                'NULL AS public_district',
                'NULL AS public_school_id',
                'NULL AS public_school_name',
                'NULL AS public_birthdate',
                'NULL AS public_contact_number',
                'NULL AS public_email',
                'NULL AS public_first_day_station',
            ];

            $sql = "SELECT\n    " . implode(",\n    ", $selectParts) . "\nFROM private_schools pvs\nWHERE pvs.id = :sid AND pvs.active = 1\nLIMIT 1";

            $s = $db->prepare($sql);
            $s->execute([':sid' => $linkedSchoolId]);
            $schoolRow = $s->fetch(PDO::FETCH_ASSOC) ?: null;
            if ($schoolRow) $isPrivate = true;
        }
    }

    // Pending accounts see only reference data already available at registration.
    if (!$schoolApproved && $linkedSchool) {
        $row = $linkedSchool['row'];
        $schoolRow = [
            'id' => $linkedSchool['id'],
            'name' => $isExplicitlyPrivate ? $row['name'] : $row['school_name'],
            'school_type' => $isExplicitlyPrivate ? 'Private School' : 'Public School',
            'deped_id' => $isExplicitlyPrivate ? $row['school_id_no'] : $row['school_id'],
        ];
    }

    // District name fallback via users.district_id (for public schools without a district JOIN hit)
    $districtName = $schoolRow['district_name'] ?? null;
    if (!$districtName && !empty($uRow['district_id'])) {
        $dStmt = $db->prepare("SELECT name FROM districts WHERE id = :did LIMIT 1");
        $dStmt->execute([':did' => (int)$uRow['district_id']]);
        $dRow = $dStmt->fetch(PDO::FETCH_ASSOC);
        $districtName = $dRow['name'] ?? null;
    }

    $school = [
        'id'                 => $schoolRow['id']                 ?? null,
        'name'               => $schoolRow['name']               ?? null,
        'district'           => $districtName,
        'type'               => $schoolRow['school_type']        ?? null,
        'deped_id'           => $schoolRow['deped_id']           ?? null,
        'grade'              => $uRow['grade']                   ?? null,
        'school_id_no'       => $uRow['school_id_no']            ?? null,
        'school_logo'        => $uRow['school_logo']             ?? null,

        // NOTE: street_address, barangay, city, levels, status, *_principal, *_contact,
        // registrar_name, registrar_contact do NOT exist in public_schools — they will
        // be null for public school users. These fields are only populated for private schools.
        'street_address'     => $schoolRow['street_address']     ?? null,
        'barangay'           => $schoolRow['barangay']           ?? null,
        'city'               => $schoolRow['city']               ?? null,
        'levels'             => $schoolRow['levels']             ?? null,
        'status'             => $schoolRow['status']             ?? null,
        'elem_principal'     => $schoolRow['elem_principal']     ?? null,
        'elem_contact'       => $schoolRow['elem_contact']       ?? null,
        'jhs_principal'      => $schoolRow['jhs_principal']      ?? null,
        'jhs_contact'        => $schoolRow['jhs_contact']        ?? null,
        'shs_principal'      => $schoolRow['shs_principal']      ?? null,
        'shs_contact'        => $schoolRow['shs_contact']        ?? null,
        'registrar_name'     => $schoolRow['registrar_name']     ?? null,
        'registrar_contact'  => $schoolRow['registrar_contact']  ?? null,

        // Directory-aligned fields from public_schools (school head / personnel record).
        // public_head_name = ps.name (the school head's personal name)
        // public_school_name = ps.school_name (the school's name)
        // public_district reuses the already-resolved $districtName to avoid a duplicate
        // ps.district fetch now that district_name and public_district are the same value.
        'public_head_name'         => $schoolRow['public_head_name']         ?? null,
        'public_position'          => $schoolRow['public_position']          ?? null,
        'public_district'          => $districtName,  // same source as district — no duplication
        'public_school_id'         => $schoolRow['public_school_id']         ?? null,
        'public_school_name'       => $schoolRow['public_school_name']       ?? null,
        'public_birthdate'         => $schoolRow['public_birthdate']         ?? null,
        'public_contact_number'    => $schoolRow['public_contact_number']    ?? null,
        'public_email'             => $schoolRow['public_email']             ?? null,
        'public_first_day_station' => $schoolRow['public_first_day_station'] ?? null,
    ];

    // ── Stats only (no submission rows returned here) ─────────────────────────
    $privateSchoolId = ((int)($uRow['private_school_id'] ?? 0) ?: null);
    $publicSchoolId  = ((int)($uRow['school_id'] ?? 0) ?: null);

    $statsWhereSql = 'user_id = :uid';
    $statsParams   = [':uid' => $userId];

    if ($schoolApproved && $isExplicitlyPrivate && $privateSchoolId) {
        $statsWhereSql = 'private_school_id = :private_school_id';
        $statsParams   = [':private_school_id' => $privateSchoolId];
    } elseif ($schoolApproved && !$isExplicitlyPrivate && $publicSchoolId) {
        $statsWhereSql = 'school_id = :school_id';
        $statsParams   = [':school_id' => $publicSchoolId];
    } elseif ($schoolApproved && $privateSchoolId && $publicSchoolId) {
        $statsWhereSql = '(private_school_id = :private_school_id OR school_id = :school_id)';
        $statsParams   = [
            ':private_school_id' => $privateSchoolId,
            ':school_id'         => $publicSchoolId,
        ];
    } elseif ($schoolApproved && $privateSchoolId) {
        $statsWhereSql = 'private_school_id = :private_school_id';
        $statsParams   = [':private_school_id' => $privateSchoolId];
    } elseif ($schoolApproved && $publicSchoolId) {
        $statsWhereSql = 'school_id = :school_id';
        $statsParams   = [':school_id' => $publicSchoolId];
    }

    $stmt = $db->prepare(" 
        SELECT
            COUNT(*)                                                        AS total,
            SUM(LOWER(TRIM(status)) = 'approved')                           AS approved,
            SUM(LOWER(TRIM(status)) IN ('pending', 'pending review', 'review', 'under review')) AS pending,
            SUM(LOWER(TRIM(status)) = 'endorsed')                           AS endorsed
        FROM school_submissions
        WHERE {$statsWhereSql}
    ");
    $stmt->execute($statsParams);
    $counts = $stmt->fetch(PDO::FETCH_ASSOC);

    $stats = [
        'total'    => (int)($counts['total']    ?? 0),
        'approved' => (int)($counts['approved'] ?? 0),
        'pending'  => (int)($counts['pending']  ?? 0),
        'endorsed' => (int)($counts['endorsed'] ?? 0),
    ];

    jsonSuccess([
        'user' => [
            'id'                => $userId,
            'full_name'         => $user['full_name'],
            'email'             => $user['email'],
            'role'              => $user['role'],
            'account_type'      => $accountType,
            'email_verified'    => (bool)($uRow['email_verified'] ?? false),
            'school_approved'   => $schoolApproved,
            'school_link_valid' => (bool)$linkedSchool,
            'profile_picture'   => $user['profile_picture'] ?? null,
            'school_id'         => $isExplicitlyPrivate ? null : $linkedSchoolId,
            'private_school_id' => $isExplicitlyPrivate ? $linkedSchoolId : null,
            'school_type'       => $uRow['school_type'] ?? null,
            'district_id'       => !empty($uRow['district_id']) ? (int)$uRow['district_id'] : null,
        ],
        'school' => $school,
        'stats'  => $stats,
        // NOTE: submissions are NOT returned here.
        // Fetch them from school-portal-submissions.php instead.
    ]);

} catch (Exception $e) {
    error_log('School Portal Dashboard Error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
