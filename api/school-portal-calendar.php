<?php
/**
 * school-portal-calendar.php
 *
 * Merged endpoint for the School Portal Calendar builder.
 *
 * Supports:
 *  - GET    /api/school-portal-calendar.php
 *  - GET    /api/school-portal-calendar.php?document_id={id}&include_payload=1
 *  - DELETE /api/school-portal-calendar.php?document_id={id}
 *  - POST   /api/school-portal-calendar.php        (save draft / submit)
 *  - POST   /api/school-portal-calendar.php        (request edit approval)
 *
 * Backward-compatible behavior:
 *  - POST action=delete behaves like DELETE.
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

function jsonSuccess(array $data = [], string $message = 'Success', int $code = 200): void
{
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode([
        'success' => true,
        'message' => $message,
        'data' => $data,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError(string $message, int $code = 400, array $data = []): void
{
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    $payload = [
        'success' => false,
        'message' => $message,
    ];
    if (!empty($data)) {
        $payload['data'] = $data;
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function normalizeTitle(?string $title): string
{
    $trimmed = trim((string)$title);
    if ($trimmed !== '') {
        return mb_substr($trimmed, 0, 255);
    }
    $date = date('Y-m-d H:i');
    return 'School Calendar Draft - ' . $date;
}

// ── Signatories table ─────────────────────────────────────────────────────────

/**
 * Creates (or migrates) the shared calendar_legends table.
 *
 * Rows with private_school_id = NULL are GLOBAL DEFAULTS (Holiday / School
 * Activity / Exam today) — these are seeded once below and are permanently
 * locked (is_locked = 1) so this school-facing endpoint can never edit or
 * delete them. Only an SDO-side admin endpoint (not part of this file)
 * should be allowed to manage rows where private_school_id IS NULL.
 *
 * Rows with private_school_id set are CUSTOM legends created by that
 * specific private school, shared across every calendar document that
 * school builds (not per-document), and editable/deletable only by users
 * belonging to that same school.
 */
function ensureCalendarLegendsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS calendar_legends (
            id                    INT(11)       NOT NULL AUTO_INCREMENT,
            private_school_id     INT(11)       DEFAULT NULL,
            legend_key            VARCHAR(80)   NOT NULL,
            label                 VARCHAR(150)  NOT NULL,
            color                 VARCHAR(20)   NOT NULL DEFAULT '#64748b',
            symbol                VARCHAR(10)   NOT NULL DEFAULT '●',
            include_in_school_days TINYINT(1)   NOT NULL DEFAULT 1,
            is_locked             TINYINT(1)    NOT NULL DEFAULT 0,
            created_by            INT(11)       DEFAULT NULL,
            created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_legend_scope_key (private_school_id, legend_key),
            KEY idx_legend_school (private_school_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // One-time seed of the 3 global defaults, matching what was previously
    // hard-coded client-side, so existing calendars don't visually change.
    $count = (int)$pdo->query(
        "SELECT COUNT(*) FROM calendar_legends WHERE private_school_id IS NULL"
    )->fetchColumn();

    if ($count === 0) {
        $seedStmt = $pdo->prepare(
            "INSERT INTO calendar_legends
                (private_school_id, legend_key, label, color, symbol, include_in_school_days, is_locked)
             VALUES (NULL, :k, :l, :c, :s, :inc, 1)"
        );
        $defaults = [
            ['k' => 'holiday',  'l' => 'Holiday',        'c' => '#dc2626', 's' => 'X', 'inc' => 0],
            ['k' => 'activity', 'l' => 'School Activity', 'c' => '#374151', 's' => '□', 'inc' => 1],
            ['k' => 'exam',     'l' => 'Exam / Quarter',  'c' => '#854d0e', 's' => '△', 'inc' => 1],
        ];
        foreach ($defaults as $d) {
            $seedStmt->execute([
                ':k' => $d['k'], ':l' => $d['l'], ':c' => $d['c'], ':s' => $d['s'], ':inc' => $d['inc'],
            ]);
        }
    }
}

/**
 * Resolve the calling user's private_school_id (auth middleware may not
 * always include it on the $user array), same approach as signatories.
 */
function resolvePrivateSchoolIdForLegends(PDO $pdo, array $user): ?int
{
    if (!empty($user['private_school_id'])) {
        return (int)$user['private_school_id'];
    }
    try {
        $stmt = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
        $stmt->execute([':uid' => (int)$user['id']]);
        $val = $stmt->fetchColumn();
        return ($val !== false && $val !== null) ? (int)$val : null;
    } catch (Throwable $e) {
        error_log('resolvePrivateSchoolIdForLegends: lookup failed: ' . $e->getMessage());
        return null;
    }
}

/**
 * GET ?action=get_legends
 *
 * Returns the 3 global defaults (private_school_id IS NULL) merged with
 * this school's own custom legends, so the calendar builder always shows
 * the same set of categories regardless of which document is open.
 */
function handleGetLegends(PDO $pdo, array $user): void
{
    ensureCalendarLegendsTable($pdo);

    $privateSchoolId = resolvePrivateSchoolIdForLegends($pdo, $user);

    $stmt = $pdo->prepare(
        "SELECT id, private_school_id, legend_key, label, color, symbol,
                include_in_school_days, is_locked, updated_at
           FROM calendar_legends
          WHERE private_school_id IS NULL
             OR private_school_id = :psid
          ORDER BY (private_school_id IS NULL) DESC, id ASC"
    );
    $stmt->execute([':psid' => $privateSchoolId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $defaults = [];
    $custom   = [];
    foreach ($rows as $row) {
        $isDefault = $row['private_school_id'] === null;
        $entry = [
            'id'                     => (int)$row['id'],
            'key'                    => $row['legend_key'],
            'label'                  => $row['label'],
            'color'                  => $row['color'],
            'symbol'                 => $row['symbol'],
            'includeInSchoolDays'    => (bool)$row['include_in_school_days'],
            'isDefault'              => $isDefault,
            'isLocked'               => $isDefault || (bool)$row['is_locked'],
        ];
        if ($isDefault) { $defaults[] = $entry; } else { $custom[] = $entry; }
    }

    jsonSuccess([
        'defaults'  => $defaults,
        'custom'    => $custom,
        'school_id' => $privateSchoolId,
    ], 'Legends retrieved successfully.');
}

/**
 * POST action=save_legend
 *
 * Creates or updates a CUSTOM legend (private_school_id = caller's school).
 * This endpoint can never touch a default (private_school_id IS NULL) row —
 * that protection lives in the WHERE clause itself, not just app logic, so
 * a malformed/forged id can't be used to edit a default category.
 */
function handleSaveLegend(PDO $pdo, array $user, array $body): void
{
    ensureCalendarLegendsTable($pdo);

    $privateSchoolId = resolvePrivateSchoolIdForLegends($pdo, $user);
    if ($privateSchoolId === null) {
        jsonError('No school linked to this account.', 422);
    }

    $id     = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : null;
    $key    = trim((string)($body['key'] ?? ''));
    $label  = mb_substr(trim((string)($body['label'] ?? '')), 0, 150);
    $color  = mb_substr(trim((string)($body['color'] ?? '#64748b')), 0, 20);
    $symbol = mb_substr(trim((string)($body['symbol'] ?? '●')), 0, 10);
    $inc    = !empty($body['includeInSchoolDays']) ? 1 : 0;

    if ($label === '') {
        jsonError('Legend label is required.', 422);
    }
    if ($key === '') {
        $key = 'custom_' . bin2hex(random_bytes(6));
    }

    if ($id !== null) {
        // Update — scoped to this school's own row only; defaults are
        // never matched here since they have private_school_id IS NULL.
        $upd = $pdo->prepare(
            "UPDATE calendar_legends
                SET label = :l, color = :c, symbol = :s, include_in_school_days = :inc
              WHERE id = :id AND private_school_id = :psid AND is_locked = 0"
        );
        $upd->execute([
            ':l' => $label, ':c' => $color, ':s' => $symbol, ':inc' => $inc,
            ':id' => $id, ':psid' => $privateSchoolId,
        ]);
        if ($upd->rowCount() === 0) {
            jsonError('Legend not found, locked, or not owned by your school.', 404);
        }
        jsonSuccess(['id' => $id, 'key' => $key], 'Legend updated.');
        return;
    }

    try {
        $ins = $pdo->prepare(
            "INSERT INTO calendar_legends
                (private_school_id, legend_key, label, color, symbol, include_in_school_days, is_locked, created_by)
             VALUES (:psid, :k, :l, :c, :s, :inc, 0, :uid)"
        );
        $ins->execute([
            ':psid' => $privateSchoolId, ':k' => $key, ':l' => $label,
            ':c' => $color, ':s' => $symbol, ':inc' => $inc, ':uid' => (int)$user['id'],
        ]);
        jsonSuccess(['id' => (int)$pdo->lastInsertId(), 'key' => $key], 'Legend created.');
    } catch (Throwable $e) {
        // Most likely the UNIQUE(private_school_id, legend_key) constraint —
        // happens if two tabs create a custom legend with the same key.
        error_log('handleSaveLegend insert failed: ' . $e->getMessage());
        jsonError('Could not save legend (it may already exist).', 409);
    }
}

/**
 * POST action=delete_legend
 *
 * Deletes a CUSTOM legend belonging to the caller's school. Default rows
 * (private_school_id IS NULL) can never be matched/deleted from here.
 */
function handleDeleteLegend(PDO $pdo, array $user, array $body): void
{
    ensureCalendarLegendsTable($pdo);

    $privateSchoolId = resolvePrivateSchoolIdForLegends($pdo, $user);
    $id = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : null;
    if ($privateSchoolId === null || $id === null) {
        jsonError('Missing legend id or school context.', 422);
    }

    $del = $pdo->prepare(
        "DELETE FROM calendar_legends
          WHERE id = :id AND private_school_id = :psid AND is_locked = 0"
    );
    $del->execute([':id' => $id, ':psid' => $privateSchoolId]);

    if ($del->rowCount() === 0) {
        jsonError('Legend not found, locked, or not owned by your school.', 404);
    }
    jsonSuccess([], 'Legend deleted.');
}

/**
 * Canonical map of which builder each signatory role belongs to.
 * 'shared' roles (principal) are usable by every builder; everything else
 * is scoped to exactly one. This mapping is the single source of truth and
 * is mirrored identically in school-portal-calendar.php, school-portal-tuition.php,
 * and main-settings.php so builder_type is always derived the same way,
 * regardless of which endpoint writes the row.
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
        'principal'      => 'shared',
    ];
    return $map[$role] ?? 'shared';
}

/**
 * Creates (or migrates) the shared school_signatories table.
 * Roles cover both builders: calendar uses rd / sds / recommending / final_approver,
 * tuition uses principal / reviewed_by. All builders share the same table so
 * a single admin row feeds every form that references that role.
 *
 * Rows are scoped per-school via private_school_id + role. The `is_default`
 * flag marks the row that should auto-populate a builder's field on first load.
 * `builder_type` (calendar | tuition | shared) records which builder(s) a
 * role belongs to — see signatoryBuilderType() above — so each builder's
 * GET endpoint can filter to only the rows it actually knows how to render.
 */
function ensureSignatoriesTable(PDO $pdo): void
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
        // One-time backfill so existing rows get tagged correctly instead of
        // sitting on the 'shared' default. Roles not listed here (e.g. 'principal')
        // are correctly 'shared' already and need no update.
        $pdo->exec("UPDATE school_signatories SET builder_type='calendar' WHERE role IN ('rd','sds','recommending','final_approver','chk_checked_by')");
        $pdo->exec("UPDATE school_signatories SET builder_type='tuition'  WHERE role = 'reviewed_by'");
    }
}

/**
 * Roles that are managed exclusively by the SDO/SMME office (via Settings)
 * and must never be created, edited, or deleted by a school-portal user.
 * Schools may still SELECT one of these office-managed rows to populate a
 * field, but the row itself always lives under private_school_id IS NULL.
 */
const OFFICE_ONLY_SIGNATORY_ROLES = ['rd', 'sds', 'recommending', 'final_approver', 'chk_checked_by'];

/**
 * GET ?action=get_signatories
 *
 * Returns signatory rows for the school attached to the session user,
 * MERGED with the shared office-managed rows (private_school_id IS NULL)
 * so office-only roles like RD / SDS / Recommending / Final Approver /
 * Checklist "Checked By" are available even though the school never owns
 * them. Each row is tagged with `scope` ('school' | 'office') so the
 * front-end can label it and disable edit/delete for office rows.
 * Grouped by role for convenient JS mapping.
 */
function handleGetSignatories(PDO $pdo, array $user): void
{
    ensureSignatoriesTable($pdo);

    $userId = (int)$user['id'];

    // Resolve private_school_id (auth middleware may not include it)
    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;
    if ($privateSchoolId === null) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $psVal = $psRow->fetchColumn();
            $privateSchoolId = ($psVal !== false && $psVal !== null) ? (int)$psVal : null;
        } catch (Throwable $e) {
            error_log('handleGetSignatories: private_school_id lookup failed: ' . $e->getMessage());
        }
    }

    // Even with no school linked, office-managed rows should still load
    // (e.g. RD/SDS/Checked-by are usable regardless of school linkage).
    // Only pull rows this builder actually knows how to render: its own
    // roles (builder_type='calendar') plus roles shared across builders
    // (builder_type='shared', e.g. principal). Tuition-only rows like
    // reviewed_by are deliberately excluded — the calendar builder has no
    // field for them.
    $stmt = $pdo->prepare(
        "SELECT id, private_school_id, role, builder_type, full_name, position_title, office, city, contact, is_default, updated_at,
                CASE WHEN private_school_id IS NULL THEN 'office' ELSE 'school' END AS scope
           FROM school_signatories
          WHERE builder_type IN ('calendar','shared')
            AND (private_school_id IS NULL" . ($privateSchoolId !== null ? " OR private_school_id = :psid" : "") . ")
          ORDER BY role ASC, is_default DESC, scope ASC, id ASC"
    );
    $stmt->execute($privateSchoolId !== null ? [':psid' => $privateSchoolId] : []);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Group by role so JS can iterate role → [options]
    $grouped = [];
    foreach ($rows as $row) {
        $r = $row['role'];
        if (!isset($grouped[$r])) $grouped[$r] = [];
        $grouped[$r][] = $row;
    }

    jsonSuccess([
        'signatories'     => $rows,
        'grouped'         => $grouped ?: (object)[],
        'school_id'       => $privateSchoolId,
        'office_only_roles' => OFFICE_ONLY_SIGNATORY_ROLES,
    ], 'Signatories retrieved successfully.');
}

/**
 * POST action=save_signatory
 *
 * Upserts a signatory row for the current school. If `id` is provided and
 * belongs to this school, it updates that row; otherwise it inserts a new one.
 * If `is_default` is true, it clears the flag from all other rows in the
 * same role first so only one default exists per role.
 */
function handleSaveSignatory(PDO $pdo, array $user, array $body): void
{
    ensureSignatoriesTable($pdo);

    $userId = (int)$user['id'];

    // Resolve private_school_id
    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;
    if ($privateSchoolId === null) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $psVal = $psRow->fetchColumn();
            $privateSchoolId = ($psVal !== false && $psVal !== null) ? (int)$psVal : null;
        } catch (Throwable $e) {
            error_log('handleSaveSignatory: private_school_id lookup: ' . $e->getMessage());
        }
    }
    if (!$privateSchoolId) {
        jsonError('No school linked to this account.', 422);
    }

    $id            = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : null;
    $role          = mb_substr(trim((string)($body['role']           ?? '')), 0, 60);
    $fullName      = mb_substr(trim((string)($body['full_name']      ?? '')), 0, 255);
    $posTitle      = mb_substr(trim((string)($body['position_title'] ?? '')), 0, 255);
    $office        = mb_substr(trim((string)($body['office']         ?? '')), 0, 255);
    $city          = mb_substr(trim((string)($body['city']           ?? '')), 0, 100);
    $contact       = mb_substr(trim((string)($body['contact']        ?? '')), 0, 60);
    $isDefault     = !empty($body['is_default']) ? 1 : 0;

    if ($role === '') {
        jsonError('Signatory role is required.', 422);
    }
    if ($fullName === '') {
        jsonError('Signatory full name is required.', 422);
    }
    if (in_array($role, OFFICE_ONLY_SIGNATORY_ROLES, true)) {
        jsonError('This signatory is managed by the SDO/SMME office. Contact your division office to update it.', 403);
    }

    // Clear existing default in the same role if this one is being set as default
    if ($isDefault) {
        $pdo->prepare(
            "UPDATE school_signatories SET is_default = 0
              WHERE private_school_id = :psid AND role = :role"
        )->execute([':psid' => $privateSchoolId, ':role' => $role]);
    }

    if ($id !== null) {
        // Verify ownership before updating
        $chk = $pdo->prepare(
            "SELECT id FROM school_signatories WHERE id = :id AND private_school_id = :psid LIMIT 1"
        );
        $chk->execute([':id' => $id, ':psid' => $privateSchoolId]);
        if (!$chk->fetchColumn()) {
            jsonError('Signatory not found or access denied.', 404);
        }
        $pdo->prepare(
            "UPDATE school_signatories
                SET role = :role, builder_type = :btype, full_name = :fn, position_title = :pos,
                    office = :ofc, city = :city, contact = :con, is_default = :isd,
                    updated_at = NOW()
              WHERE id = :id AND private_school_id = :psid"
        )->execute([
            ':role' => $role, ':btype' => signatoryBuilderType($role),
            ':fn'   => $fullName, ':pos' => $posTitle,
            ':ofc'  => $office,':city' => $city,    ':con' => $contact,
            ':isd'  => $isDefault, ':id' => $id,    ':psid' => $privateSchoolId,
        ]);
        jsonSuccess(['id' => $id, 'is_default' => $isDefault], 'Signatory updated successfully.');
    }

    $ins = $pdo->prepare(
        "INSERT INTO school_signatories
            (private_school_id, role, builder_type, full_name, position_title, office, city, contact, is_default)
         VALUES (:psid, :role, :btype, :fn, :pos, :ofc, :city, :con, :isd)"
    );
    $ins->execute([
        ':psid' => $privateSchoolId, ':role' => $role, ':btype' => signatoryBuilderType($role),
        ':fn'   => $fullName,
        ':pos'  => $posTitle,        ':ofc'  => $office, ':city' => $city,
        ':con'  => $contact,         ':isd'  => $isDefault,
    ]);
    $newId = (int)$pdo->lastInsertId();
    jsonSuccess(['id' => $newId, 'is_default' => $isDefault], 'Signatory saved successfully.');
}

/**
 * POST action=delete_signatory
 */
function handleDeleteSignatory(PDO $pdo, array $user, array $body): void
{
    ensureSignatoriesTable($pdo);
    $userId = (int)$user['id'];
    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;
    if ($privateSchoolId === null) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $psVal = $psRow->fetchColumn();
            $privateSchoolId = ($psVal !== false && $psVal !== null) ? (int)$psVal : null;
        } catch (Throwable $e) {}
    }
    if (!$privateSchoolId) jsonError('No school linked.', 422);

    $id = isset($body['id']) && is_numeric($body['id']) ? (int)$body['id'] : 0;
    if (!$id) jsonError('Signatory id required.', 422);

    $del = $pdo->prepare(
        "DELETE FROM school_signatories WHERE id = :id AND private_school_id = :psid LIMIT 1"
    );
    $del->execute([':id' => $id, ':psid' => $privateSchoolId]);
    if ($del->rowCount() === 0) jsonError('Signatory not found or access denied.', 404);
    jsonSuccess(['id' => $id], 'Signatory deleted.');
}

function ensureCalendarDocumentsTable(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS school_calendar_documents (
            id INT(11) NOT NULL AUTO_INCREMENT,
            user_id INT(11) NOT NULL,
            private_school_id INT(11) DEFAULT NULL,
            title VARCHAR(255) NOT NULL,
            payload_json LONGTEXT NOT NULL,
            status ENUM('draft', 'submitted') NOT NULL DEFAULT 'draft',
            active_tab VARCHAR(50) NOT NULL DEFAULT 'pg-cover',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_scd_user_id (user_id),
            KEY idx_scd_private_school_id (private_school_id),
            KEY idx_scd_updated_at (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

/**
 * Check whether a column exists in a table.
 * Results are cached in a static array for the lifetime of this request
 * so that repeated SHOW COLUMNS calls for the same table/column pair
 * (e.g. during schema migration checks on every boot) only hit the DB once.
 */
function tableHasColumn(PDO $pdo, string $table, string $column): bool
{
    static $cache = [];

    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) {
        return false;
    }

    $cacheKey = $table . '.' . $column;
    if (array_key_exists($cacheKey, $cache)) {
        return $cache[$cacheKey];
    }

    $sql  = sprintf("SHOW COLUMNS FROM `%s` LIKE %s", $table, $pdo->quote($column));
    $stmt = $pdo->query($sql);
    $result = $stmt ? (bool)$stmt->fetch(PDO::FETCH_ASSOC) : false;

    $cache[$cacheKey] = $result;
    return $result;
}

function ensureCalendarDocumentsSchema(PDO $pdo): bool
{
    ensureCalendarDocumentsTable($pdo);

    // Add private_school_id if missing (new column replacing school_id + district_id).
    if (!tableHasColumn($pdo, 'school_calendar_documents', 'private_school_id')) {
        try {
            $pdo->exec("ALTER TABLE school_calendar_documents ADD COLUMN private_school_id INT(11) DEFAULT NULL AFTER user_id");
            $pdo->exec("ALTER TABLE school_calendar_documents ADD KEY idx_scd_private_school_id (private_school_id)");
        } catch (Throwable $e) {
            error_log('ensureCalendarDocumentsSchema private_school_id: ' . $e->getMessage());
        }
    }

    // Drop legacy public-school columns if they still exist.
    foreach (['school_id', 'district_id'] as $legacyCol) {
        if (tableHasColumn($pdo, 'school_calendar_documents', $legacyCol)) {
            try {
                $pdo->exec("ALTER TABLE school_calendar_documents DROP COLUMN `{$legacyCol}`");
            } catch (Throwable $e) {
                error_log("ensureCalendarDocumentsSchema drop {$legacyCol}: " . $e->getMessage());
            }
        }
    }

    $hasActiveTabCol = tableHasColumn($pdo, 'school_calendar_documents', 'active_tab');
    if (!$hasActiveTabCol) {
        try {
            $pdo->exec("ALTER TABLE school_calendar_documents ADD COLUMN active_tab VARCHAR(50) NOT NULL DEFAULT 'pg-cover' AFTER status");
        } catch (Throwable $e) {
            error_log('ensureCalendarDocumentsSchema active_tab: ' . $e->getMessage());
        }
        $hasActiveTabCol = tableHasColumn($pdo, 'school_calendar_documents', 'active_tab');
    }

    // Lightweight summary columns (department, school year, opening/closing
    // dates, total school days) so the saved-documents list endpoint can
    // show these on each card without parsing payload_json per row.
    $summaryColumnDefs = [
        'department'   => "VARCHAR(100) DEFAULT NULL",
        'school_year'  => "VARCHAR(20) DEFAULT NULL",
        'opening_date' => "DATE DEFAULT NULL",
        'closing_date' => "DATE DEFAULT NULL",
        'total_days'   => "SMALLINT DEFAULT NULL",
    ];
    $summaryColumnsJustAdded = false;
    foreach ($summaryColumnDefs as $col => $def) {
        if (!tableHasColumn($pdo, 'school_calendar_documents', $col)) {
            try {
                $pdo->exec("ALTER TABLE school_calendar_documents ADD COLUMN `{$col}` {$def}");
                $summaryColumnsJustAdded = true;
            } catch (Throwable $e) {
                error_log("ensureCalendarDocumentsSchema {$col}: " . $e->getMessage());
            }
        }
    }
    if ($summaryColumnsJustAdded) {
        // Backfill existing documents once so they show these details on
        // the very next page load instead of waiting for their next save.
        backfillCalendarSummaryColumns($pdo);
    }

    return $hasActiveTabCol;
}

function backfillCalendarSummaryColumns(PDO $pdo): void
{
    try {
        $stmt = $pdo->query(
            "SELECT id, title, payload_json
             FROM school_calendar_documents
             WHERE department IS NULL AND school_year IS NULL
               AND opening_date IS NULL AND closing_date IS NULL AND total_days IS NULL"
        );
        $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        if (!$rows) {
            return;
        }

        $update = $pdo->prepare(
            "UPDATE school_calendar_documents
             SET department = :department, school_year = :school_year,
                 opening_date = :opening_date, closing_date = :closing_date,
                 total_days = :total_days
             WHERE id = :id"
        );

        foreach ($rows as $row) {
            $payload = json_decode((string)($row['payload_json'] ?? ''), true);
            if (!is_array($payload)) {
                $payload = [];
            }
            $title = (string)($row['title'] ?? '');
            $department = extractDepartment($payload);
            $schoolYear = extractSchoolYear($payload, $title);
            $update->execute([
                ':department'   => $department !== '' ? $department : null,
                ':school_year'  => $schoolYear !== '' ? $schoolYear : null,
                ':opening_date' => extractOpeningDate($payload),
                ':closing_date' => extractClosingDate($payload),
                // totalDays only exists in payloads saved after this feature
                // shipped — older drafts will show "—" until next saved.
                ':total_days'   => extractTotalDays($payload),
                ':id'           => $row['id'],
            ]);
        }
    } catch (Throwable $e) {
        error_log('backfillCalendarSummaryColumns: ' . $e->getMessage());
    }
}

function getStatusValueForSchoolSubmission(PDO $pdo): string
{
    $stmt = $pdo->prepare("SHOW COLUMNS FROM `school_submissions` LIKE 'status'");
    $stmt->execute();
    $row  = $stmt->fetch(PDO::FETCH_ASSOC);
    $type = (string)($row['Type'] ?? '');

    // Parse the raw ENUM definition: enum('val1','val2',...) to extract actual values,
    // preserving original casing rather than relying on a fragile strpos substring match.
    if (preg_match("/^enum\((.+)\)$/i", $type, $m)) {
        $values = array_map(
            static function ($v) { return trim(trim($v), "'\""); },
            explode("','", $m[1])
        );
        foreach ($values as $v) {
            if (strtolower($v) === 'pending review') {
                return $v; // return with original casing from the ENUM definition
            }
        }
    }

    return 'pending';
}

function extractSchoolYear(array $payload, string $title): string
{
    $form = $payload['form'] ?? [];
    $sy1 = trim((string)($form['f_sy1'] ?? ''));
    $sy2 = trim((string)($form['f_sy2'] ?? ''));
    if ($sy1 !== '' && $sy2 !== '') {
        return $sy1 . '-' . $sy2;
    }

    if (preg_match('/\((\d{4}\s*-\s*\d{4})\)/', $title, $m)) {
        return preg_replace('/\s+/', '', $m[1]);
    }
    return '';
}

function extractDepartment(array $payload): string
{
    $form = $payload['form'] ?? [];
    $dept = trim((string)($form['f_dept'] ?? ''));
    return $dept !== '' ? mb_substr($dept, 0, 100) : '';
}

function extractCalendarDateField(array $payload, string $fieldName): ?string
{
    $form = $payload['form'] ?? [];
    $raw = trim((string)($form[$fieldName] ?? ''));
    if ($raw === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw)) {
        return null;
    }
    // Sanity-check it's a real calendar date (e.g. rejects 2026-02-31).
    [$y, $m, $d] = array_map('intval', explode('-', $raw));
    return checkdate($m, $d, $y) ? $raw : null;
}

function extractOpeningDate(array $payload): ?string
{
    return extractCalendarDateField($payload, 'f_opening');
}

function extractClosingDate(array $payload): ?string
{
    return extractCalendarDateField($payload, 'f_closing');
}

function extractTotalDays(array $payload): ?int
{
    if (!isset($payload['totalDays']) || !is_numeric($payload['totalDays'])) {
        return null;
    }
    $days = (int)$payload['totalDays'];
    if ($days < 0 || $days > 366) {
        return null;
    }
    return $days;
}

function insertSchoolNotification(PDO $pdo, int $schoolId, string $type, string $title, string $message, string $link): void
{
    try {
        $cols = ['school_id', 'type', 'title', 'message', 'link', 'created_at'];
        $vals = [':school_id', ':type', ':title', ':message', ':link', 'NOW()'];
        $params = [
            ':school_id' => $schoolId,
            ':type' => $type,
            ':title' => $title,
            ':message' => $message,
            ':link' => $link,
        ];

        if (tableHasColumn($pdo, 'school_notifications', 'is_read')) {
            $cols[] = 'is_read';
            $vals[] = '0';
        }

        $sql = "INSERT INTO school_notifications (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $vals) . ")";
        $pdo->prepare($sql)->execute($params);
    } catch (Throwable $e) {
        error_log('insertSchoolNotification failed: ' . $e->getMessage());
    }
}

function insertSchoolNotificationForCalendar(PDO $pdo, ?int $schoolId, string $title): void
{
    if (!$schoolId) {
        return;
    }

    insertSchoolNotification(
        $pdo,
        $schoolId,
        'submission',
        'Calendar Submitted',
        'Your school calendar "' . $title . '" has been submitted for review.',
        'school-portal-calendar.html'
    );
}

/**
 * Resolve the notification-target school ID for a user.
 * school_calendar_documents is private-schools only — use private_school_id.
 */
function resolveNotificationSchoolId(PDO $pdo, array $user): ?int
{
    return !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;
}

function upsertSchoolCalendarSubmission(
    PDO $pdo,
    array $user,
    int $calendarDocumentId,
    string $title,
    array $payload,
    string $payloadJson
): string {
    // Only bridge rows for final submitted calendars.
    if (!tableHasColumn($pdo, 'school_submissions', 'type')) {
        return 'skipped';
    }

    $hasCalendarDocId = tableHasColumn($pdo, 'school_submissions', 'calendar_document_id');
    $hasSubmittedBy = tableHasColumn($pdo, 'school_submissions', 'submitted_by');
    $hasDocumentType = tableHasColumn($pdo, 'school_submissions', 'document_type');
    $hasDateSubmitted = tableHasColumn($pdo, 'school_submissions', 'date_submitted');
    $hasSchoolYear = tableHasColumn($pdo, 'school_submissions', 'school_year');
    $hasCreatedByName = tableHasColumn($pdo, 'school_submissions', 'created_by_name');
    $hasHistoryJson = tableHasColumn($pdo, 'school_submissions', 'history_json');

    $userId          = (int)$user['id'];
    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;

    // Re-query private_school_id from the users table if the auth middleware did not return it.
    if ($privateSchoolId === null && !array_key_exists('private_school_id', $user)) {
        try {
            $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => $userId]);
            $psVal = $psRow->fetchColumn();
            $privateSchoolId = ($psVal !== false && $psVal !== null) ? (int)$psVal : null;
        } catch (Throwable $e) {
            error_log('upsertSchoolCalendarSubmission: could not fetch private_school_id — ' . $e->getMessage());
        }
    }
    $submittedBy = trim((string)($user['full_name'] ?? $user['email'] ?? 'Portal User'));
    $schoolYear = extractSchoolYear($payload, $title);
    $status = getStatusValueForSchoolSubmission($pdo);
    $fileName = 'calendar-builder-' . $calendarDocumentId . '.json';
    $filePath = 'school_calendar_documents:' . $calendarDocumentId;
    $fileSize = strlen($payloadJson);

    $existingId = null;
    if ($hasCalendarDocId) {
        // Issue 6 — PRIMARY lookup by calendar_document_id (race-condition-safe once
        // a UNIQUE KEY uq_calendar_doc (calendar_document_id) is added via migration).
        $sel = $pdo->prepare(
            "SELECT id
             FROM school_submissions
             WHERE calendar_document_id = :calendar_document_id
             LIMIT 1"
        );
        $sel->execute([':calendar_document_id' => $calendarDocumentId]);
        $existingId = (int)($sel->fetchColumn() ?: 0);
    }

    if (!$existingId) {
        // Issue 6 — Title-based fallback (race condition risk — see UNIQUE KEY note above).
        // The title now includes the dept level, e.g.:
        //   "School Calendar - Rizal High School - Senior High School (2026-2027)"
        // so JHS and SHS calendars for the same school year are distinct rows and will
        // NEVER incorrectly match each other here. Each level gets its own submission row.
        $sel = $pdo->prepare(
            "SELECT id
             FROM school_submissions
             WHERE user_id = :user_id AND type = 'calendar' AND title = :title
             ORDER BY id DESC
             LIMIT 1"
        );
        $sel->execute([
            ':user_id' => $userId,
            ':title' => $title,
        ]);
        $existingId = (int)($sel->fetchColumn() ?: 0);
    }

    if ($existingId) {
        // UPDATE path: re-submission should refresh submitted_at so admin notifications can detect it.
        $updateParts = [
            'title = :title',
            'status = :status',
            'private_school_id = :private_school_id',
            'type = :type',
            'file_name = :file_name',
            'file_path = :file_path',
            'file_size = :file_size',
            'submitted_at = NOW()',
            'updated_at = NOW()',
        ];
        if ($hasCalendarDocId) {
            $updateParts[] = 'calendar_document_id = :calendar_document_id';
        }
        if ($hasSubmittedBy) {
            $updateParts[] = 'submitted_by = :submitted_by';
        }
        if ($hasDocumentType) {
            $updateParts[] = 'document_type = :document_type';
        }
        if ($hasDateSubmitted) {
            $updateParts[] = 'date_submitted = CURDATE()';
        }
        if ($hasSchoolYear) {
            $updateParts[] = 'school_year = :school_year';
        }
        if ($hasCreatedByName) {
            $updateParts[] = 'created_by_name = :created_by_name';
        }

        // Always carry forward and append a resubmission entry to history_json.
        $updateParts[] = 'history_json = :history_json';

        $sql = "UPDATE school_submissions SET " . implode(', ', $updateParts) . " WHERE id = :id";
        $params = [
            ':id'                => $existingId,
            ':title'             => $title,
            ':status'            => $status,
            ':private_school_id' => $privateSchoolId,
            ':type'              => 'calendar',
            ':file_name'         => $fileName,
            ':file_path'         => $filePath,
            ':file_size'         => $fileSize,
        ];
        if ($hasCalendarDocId) {
            $params[':calendar_document_id'] = $calendarDocumentId;
        }
        if ($hasSubmittedBy) {
            $params[':submitted_by'] = $submittedBy;
        }
        if ($hasDocumentType) {
            $params[':document_type'] = 'School Calendar';
        }
        if ($hasSchoolYear) {
            $params[':school_year'] = $schoolYear !== '' ? $schoolYear : null;
        }
        if ($hasCreatedByName) {
            $params[':created_by_name'] = $submittedBy;
        }

        // Fetch existing history and append a resubmission event.
        try {
            $histStmt = $pdo->prepare("SELECT history_json FROM school_submissions WHERE id = :id LIMIT 1");
            $histStmt->execute([':id' => $existingId]);
            $existingHistory = json_decode((string)($histStmt->fetchColumn() ?: '[]'), true);
            if (!is_array($existingHistory)) {
                $existingHistory = [];
            }
        } catch (Throwable $e) {
            error_log('upsertSchoolCalendarSubmission: could not fetch history_json — ' . $e->getMessage());
            $existingHistory = [];
        }
        $existingHistory[] = [
            'status'     => $status,
            'timestamp'  => date('Y-m-d H:i:s'),
            'by'         => $submittedBy,
            'note'       => 'Resubmitted after correction',
        ];
        $params[':history_json'] = json_encode($existingHistory, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $pdo->prepare($sql)->execute($params);
        return 'updated';
    }

    // INSERT path: trigger does NOT fire → manually insert school_notifications
    $cols = ['user_id', 'private_school_id', 'type', 'title', 'file_name', 'file_path', 'file_size', 'status', 'submitted_at', 'updated_at'];
    $vals = [':user_id', ':private_school_id', ':type', ':title', ':file_name', ':file_path', ':file_size', ':status', 'NOW()', 'NOW()'];
    $params = [
        ':user_id'           => $userId,
        ':private_school_id' => $privateSchoolId,
        ':type'              => 'calendar',
        ':title'             => $title,
        ':file_name'         => $fileName,
        ':file_path'         => $filePath,
        ':file_size'         => $fileSize,
        ':status'            => $status,
    ];

    if ($hasCalendarDocId) {
        $cols[] = 'calendar_document_id';
        $vals[] = ':calendar_document_id';
        $params[':calendar_document_id'] = $calendarDocumentId;
    }
    if ($hasSubmittedBy) {
        $cols[] = 'submitted_by';
        $vals[] = ':submitted_by';
        $params[':submitted_by'] = $submittedBy;
    }
    if ($hasDocumentType) {
        $cols[] = 'document_type';
        $vals[] = ':document_type';
        $params[':document_type'] = 'School Calendar';
    }
    if ($hasDateSubmitted) {
        $cols[] = 'date_submitted';
        $vals[] = 'CURDATE()';
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

    if ($hasHistoryJson) {
        $cols[] = 'history_json';
        $vals[] = ':history_json';
        $params[':history_json'] = json_encode([
            [
                'event'      => 'submitted',
                'by'         => $submittedBy,
                'created_at' => date('Y-m-d H:i:s'),
                'note'       => '',
            ],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    $sql = "INSERT INTO school_submissions (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $vals) . ")";
    $pdo->prepare($sql)->execute($params);

    $notifSchoolId = resolveNotificationSchoolId($pdo, $user);
    insertSchoolNotificationForCalendar($pdo, $notifSchoolId, $title);

    return 'inserted';
}

function logCalendarBridgeAudit(PDO $pdo, array $user, int $documentId, string $title, string $bridgeAction): void
{
    if (!in_array($bridgeAction, ['inserted', 'updated'], true)) {
        return;
    }

    $role = trim((string)($user['role'] ?? $user['account_type'] ?? 'portal_user'));
    if ($role === '') {
        $role = 'portal_user';
    }

    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)($user['id'] ?? 0),
        'role' => $role,
        'action' => 'calendar_final_submit_sync',
        'module' => 'school_calendar',
        'status' => 'success',
        'description' => sprintf(
            'Final submit bridge %s in school_submissions | document_id=%d | title=%s',
            $bridgeAction,
            $documentId,
            $title
        ),
        'document_type' => 'School Calendar',
        'file_name' => 'calendar-builder-' . $documentId . '.json',
    ]);
}

function parseJsonBody(string $rawBody): array
{
    if ($rawBody === '') {
        return [];
    }
    $decoded = json_decode($rawBody, true);
    return is_array($decoded) ? $decoded : [];
}

function normalizeSubmissionStatusKey(string $status): string
{
    $s = strtolower(trim($status));
    $s = preg_replace('/\s+/', ' ', $s);
    $s = str_replace(['-', '_'], ' ', $s);
    $s = preg_replace('/\s+/', ' ', $s);
    return trim($s);
}

function isCalendarEditableAfterSubmission(PDO $pdo, array $user, int $calendarDocumentId): bool
{
    // Fast path: if the SDO approved the edit directly on the calendar document row, allow editing.
    if (tableHasColumn($pdo, 'school_calendar_documents', 'edit_request_status')) {
        try {
            $docStmt = $pdo->prepare(
                "SELECT edit_request_status FROM school_calendar_documents WHERE id = :id AND user_id = :uid LIMIT 1"
            );
            $docStmt->execute([':id' => $calendarDocumentId, ':uid' => (int)$user['id']]);
            if ((string)($docStmt->fetchColumn() ?: '') === 'approved') {
                return true;
            }
        } catch (Throwable $e) {
            error_log('isCalendarEditableAfterSubmission edit_request_status check: ' . $e->getMessage());
        }
    }

    if (!tableHasColumn($pdo, 'school_submissions', 'status')) {
        return false;
    }
    if (!tableHasColumn($pdo, 'school_submissions', 'calendar_document_id')) {
        return false;
    }

    $sql = "SELECT status FROM school_submissions WHERE calendar_document_id = :doc_id";
    $params = [':doc_id' => $calendarDocumentId];

    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;

    if ($privateSchoolId && tableHasColumn($pdo, 'school_submissions', 'private_school_id')) {
        $sql .= " AND private_school_id = :private_school_id";
        $params[':private_school_id'] = $privateSchoolId;
    }

    if (tableHasColumn($pdo, 'school_submissions', 'type')) {
        $sql .= " AND type = 'calendar'";
    }

    $sql .= " ORDER BY id DESC LIMIT 1";

    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $status = (string)($stmt->fetchColumn() ?: '');
    } catch (Throwable $e) {
        error_log('isCalendarEditableAfterSubmission: ' . $e->getMessage());
        return false;
    }

    $key = normalizeSubmissionStatusKey($status);
    // Treat returned / rejected / draft as editable.
    // 'draft' is set by approve_edit so the school can re-submit after correction.
    return in_array($key, [
        'draft',
        'rejected',
        'returned',
        'returned for correction',
        'returned for revision',
        'returned_for_correction',
    ], true);
}

function handleDocumentsGet(PDO $pdo, int $userId, bool $hasActiveTabColumn): void
{
    $includePayload = isset($_GET['include_payload']) && (string)$_GET['include_payload'] === '1';
    $documentId = isset($_GET['document_id']) && is_numeric($_GET['document_id'])
        ? (int)$_GET['document_id']
        : null;

    if ($documentId !== null) {
        $hasEditRequestStatusCol = tableHasColumn($pdo, 'school_calendar_documents', 'edit_request_status');
        $hasSummaryColumns = tableHasColumn($pdo, 'school_calendar_documents', 'department');
        $singleCols = 'id, title, status';
        if ($hasEditRequestStatusCol) $singleCols .= ', edit_request_status';
        if ($hasActiveTabColumn)      $singleCols .= ', active_tab';
        if ($hasSummaryColumns)       $singleCols .= ', department, school_year, opening_date, closing_date, total_days';
        $singleCols .= ', payload_json, created_at, updated_at';

        $selectSingle = "SELECT {$singleCols}
               FROM school_calendar_documents
               WHERE id = :id AND user_id = :user_id
               LIMIT 1";

        $stmt = $pdo->prepare($selectSingle);
        $stmt->execute([
            ':id' => $documentId,
            ':user_id' => $userId,
        ]);

        $doc = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$doc) {
            jsonError('Document not found.', 404);
        }

        $result = [
            'id' => (int)$doc['id'],
            'title' => $doc['title'],
            'status' => $doc['status'],
            'edit_request_status' => $hasEditRequestStatusCol ? ($doc['edit_request_status'] ?? null) : null,
            'active_tab' => $hasActiveTabColumn ? ((string)($doc['active_tab'] ?? 'pg-cover') ?: 'pg-cover') : 'pg-cover',
            'department'   => $hasSummaryColumns ? ($doc['department'] ?? null) : null,
            'school_year'  => $hasSummaryColumns ? ($doc['school_year'] ?? null) : null,
            'opening_date' => $hasSummaryColumns ? ($doc['opening_date'] ?? null) : null,
            'closing_date' => $hasSummaryColumns ? ($doc['closing_date'] ?? null) : null,
            'total_days'   => ($hasSummaryColumns && $doc['total_days'] !== null) ? (int)$doc['total_days'] : null,
            'created_at' => $doc['created_at'],
            'updated_at' => $doc['updated_at'],
        ];

        if ($includePayload) {
            $payload = json_decode((string)$doc['payload_json'], true);
            if (!is_array($payload)) {
                $payload = [];
            }
            if (empty($payload['active_tab']) && !empty($result['active_tab'])) {
                $payload['active_tab'] = $result['active_tab'];
            }
            $result['payload'] = $payload;
        }

        jsonSuccess(['document' => $result]);
    }

    $hasEditRequestStatusCol = tableHasColumn($pdo, 'school_calendar_documents', 'edit_request_status');
    $hasSummaryColumns = tableHasColumn($pdo, 'school_calendar_documents', 'department');
    $listCols = 'id, title, status';
    if ($hasEditRequestStatusCol) $listCols .= ', edit_request_status';
    if ($hasActiveTabColumn)      $listCols .= ', active_tab';
    if ($hasSummaryColumns)       $listCols .= ', department, school_year, opening_date, closing_date, total_days';
    $listCols .= ', created_at, updated_at';

    $selectList = "SELECT {$listCols}
           FROM school_calendar_documents
           WHERE user_id = :user_id
           ORDER BY updated_at DESC";

    $stmt = $pdo->prepare($selectList);
    $stmt->execute([':user_id' => $userId]);

    $documents = array_map(static function ($row) use ($hasEditRequestStatusCol, $hasActiveTabColumn, $hasSummaryColumns) {
        return [
            'id' => (int)$row['id'],
            'title' => $row['title'],
            'status' => $row['status'],
            'edit_request_status' => $hasEditRequestStatusCol ? ($row['edit_request_status'] ?? null) : null,
            'active_tab' => $hasActiveTabColumn ? ((string)($row['active_tab'] ?? 'pg-cover') ?: 'pg-cover') : 'pg-cover',
            'department'   => $hasSummaryColumns ? ($row['department'] ?? null) : null,
            'school_year'  => $hasSummaryColumns ? ($row['school_year'] ?? null) : null,
            'opening_date' => $hasSummaryColumns ? ($row['opening_date'] ?? null) : null,
            'closing_date' => $hasSummaryColumns ? ($row['closing_date'] ?? null) : null,
            'total_days'   => ($hasSummaryColumns && $row['total_days'] !== null) ? (int)$row['total_days'] : null,
            'created_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));

    jsonSuccess(['documents' => $documents]);
}

function handleDocumentsDelete(PDO $pdo, int $userId, ?int $documentIdFromQuery, array $jsonBody): void
{
    $documentId = $documentIdFromQuery;

    if ($documentId === null) {
        if (isset($jsonBody['document_id']) && is_numeric($jsonBody['document_id'])) {
            $documentId = (int)$jsonBody['document_id'];
        } elseif (isset($_POST['document_id']) && is_numeric($_POST['document_id'])) {
            $documentId = (int)$_POST['document_id'];
        }
    }

    if ($documentId === null || $documentId <= 0) {
        jsonError('Missing or invalid document_id.', 422);
    }

    $delete = $pdo->prepare(
        "DELETE FROM school_calendar_documents
         WHERE id = :id AND user_id = :user_id
         LIMIT 1"
    );
    $delete->execute([
        ':id' => $documentId,
        ':user_id' => $userId,
    ]);

    if ($delete->rowCount() === 0) {
        jsonError('Document not found or access denied.', 404);
    }

    jsonSuccess(['document_id' => $documentId], 'Calendar document deleted successfully.');
}

function handleSave(PDO $pdo, array $user, array $jsonBody, bool $hasActiveTabCol): void
{
    $payload = $jsonBody['payload'] ?? null;
    if (!is_array($payload)) {
        jsonError('Missing or invalid payload object.', 422);
    }

    $title = normalizeTitle($jsonBody['title'] ?? null);
    $status = strtolower(trim((string)($jsonBody['status'] ?? 'draft')));
    if (!in_array($status, ['draft', 'submitted'], true)) {
        $status = 'draft';
    }

    $documentId = isset($jsonBody['document_id']) && is_numeric($jsonBody['document_id'])
        ? (int)$jsonBody['document_id']
        : null;

    $userId = (int)$user['id'];

    // Fetch private_school_id directly — auth middleware may not include it.
    if (!array_key_exists('private_school_id', $user)) {
        $psRow = $pdo->prepare("SELECT private_school_id FROM users WHERE id = :uid LIMIT 1");
        $psRow->execute([':uid' => $userId]);
        $psVal = $psRow->fetchColumn();
        $user['private_school_id'] = ($psVal !== false && $psVal !== null) ? (int)$psVal : null;
    }

    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;

    $payloadJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($payloadJson === false) {
        jsonError('Failed to encode calendar payload.', 500);
    }

    $activeTab = isset($payload['active_tab']) && is_string($payload['active_tab'])
        ? trim($payload['active_tab'])
        : 'pg-cover';

    $allowedTabs = ['pg-cover', 'pg-transmittal', 'pg-loi-cover', 'pg-loi', 'pg-cal-cover', 'pg-summary', 'pg-checklist', 'pg-monthly'];
    if (!in_array($activeTab, $allowedTabs, true)) {
        $activeTab = 'pg-cover';
    }

    // Lightweight summary fields, computed once and reused by both the
    // UPDATE and INSERT paths below (see ensureCalendarDocumentsSchema).
    $hasSummaryColumns = tableHasColumn($pdo, 'school_calendar_documents', 'department');
    $summaryDepartment  = extractDepartment($payload);
    $summarySchoolYear  = extractSchoolYear($payload, $title);
    $summaryOpeningDate = extractOpeningDate($payload);
    $summaryClosingDate = extractClosingDate($payload);
    $summaryTotalDays   = extractTotalDays($payload);

    if ($documentId !== null) {
        // Enforce server-side lock: submitted docs are read-only unless returned for correction.
        $docStmt = $pdo->prepare(
            "SELECT status
             FROM school_calendar_documents
             WHERE id = :id AND user_id = :user_id
             LIMIT 1"
        );
        $docStmt->execute([
            ':id' => $documentId,
            ':user_id' => $userId,
        ]);
        $existingStatus = (string)($docStmt->fetchColumn() ?: '');
        if ($existingStatus === '') {
            jsonError('Document not found or access denied.', 404);
        }

        if (strtolower(trim($existingStatus)) === 'submitted' && !isCalendarEditableAfterSubmission($pdo, $user, $documentId)) {
            jsonError('This calendar is locked because it has been submitted for final approval.', 423);
        }

        try {
            $hasEditRequestStatusCol = tableHasColumn($pdo, 'school_calendar_documents', 'edit_request_status');

            $setClauses = [
                'title = :title',
                'payload_json = :payload_json',
                'status = :status',
                'private_school_id = :private_school_id',
                'updated_at = NOW()',
            ];
            $updateParams = [
                ':title'             => $title,
                ':payload_json'      => $payloadJson,
                ':status'            => $status,
                ':private_school_id' => $privateSchoolId,
                ':id'                => $documentId,
                ':user_id'           => $userId,
            ];
            if ($hasActiveTabCol) {
                $setClauses[] = 'active_tab = :active_tab';
                $updateParams[':active_tab'] = $activeTab;
            }
            if ($hasEditRequestStatusCol) {
                // Every save (draft or final submit) spends any previously
                // granted edit approval — mirrors school_tuition_documents'
                // handleSave(), so a one-time SDO edit approval can't keep
                // the document showing as "Edit Approved"/unlocked forever
                // once the school has already acted on it.
                $setClauses[] = "edit_request_status = 'none'";

                // If the edit was approved, also flip the school_submissions row
                // status to 'draft' so isCalendarEditableAfterSubmission() keeps
                // returning true after edit_request_status is cleared to 'none'.
                // Without this, the submission row stays at 'pending review' and
                // the document re-locks itself immediately after the first save.
                try {
                    $erStmt = $pdo->prepare(
                        "SELECT edit_request_status FROM school_calendar_documents WHERE id = :id AND user_id = :uid LIMIT 1"
                    );
                    $erStmt->execute([':id' => $documentId, ':uid' => $userId]);
                    $currentEditRequestStatus = (string)($erStmt->fetchColumn() ?: '');

                    if ($currentEditRequestStatus === 'approved'
                        && tableHasColumn($pdo, 'school_submissions', 'calendar_document_id')
                        && tableHasColumn($pdo, 'school_submissions', 'status')
                    ) {
                        $subUpdateSql = "UPDATE school_submissions
                                         SET status = 'draft', updated_at = NOW()
                                         WHERE calendar_document_id = :doc_id
                                           AND type = 'calendar'";
                        $subUpdateParams = [':doc_id' => $documentId];
                        if ($privateSchoolId && tableHasColumn($pdo, 'school_submissions', 'private_school_id')) {
                            $subUpdateSql .= " AND private_school_id = :private_school_id";
                            $subUpdateParams[':private_school_id'] = $privateSchoolId;
                        }
                        $pdo->prepare($subUpdateSql)->execute($subUpdateParams);
                    }
                } catch (Throwable $e) {
                    error_log('handleSave: could not update submission status on edit_request spend — ' . $e->getMessage());
                }
            }
            if ($hasSummaryColumns) {
                $setClauses[] = 'department = :department';
                $setClauses[] = 'school_year = :school_year';
                $setClauses[] = 'opening_date = :opening_date';
                $setClauses[] = 'closing_date = :closing_date';
                $setClauses[] = 'total_days = :total_days';
                $updateParams[':department']   = $summaryDepartment !== '' ? $summaryDepartment : null;
                $updateParams[':school_year']  = $summarySchoolYear !== '' ? $summarySchoolYear : null;
                $updateParams[':opening_date'] = $summaryOpeningDate;
                $updateParams[':closing_date'] = $summaryClosingDate;
                $updateParams[':total_days']   = $summaryTotalDays;
            }

            $updateSql = "UPDATE school_calendar_documents SET "
                . implode(', ', $setClauses)
                . " WHERE id = :id AND user_id = :user_id";

            $stmt = $pdo->prepare($updateSql);
            $stmt->execute($updateParams);
        } catch (Throwable $e) {
            error_log('school-portal-calendar.php UPDATE error: ' . $e->getMessage());
            jsonError('Failed to update calendar document.', 500);
        }

        if ($stmt->rowCount() === 0) {
            jsonError('Document not found or access denied.', 404);
        }

        if ($status === 'submitted') {
            $bridgeAction = upsertSchoolCalendarSubmission($pdo, $user, $documentId, $title, $payload, $payloadJson);
            logCalendarBridgeAudit($pdo, $user, $documentId, $title, $bridgeAction);
        }

        jsonSuccess([
            'document_id' => $documentId,
            'title' => $title,
            'status' => $status,
            'edit_request_status' => $hasEditRequestStatusCol ? 'none' : null,
            'active_tab' => $activeTab,
        ], 'Calendar document updated successfully.');
    }

    try {
        $insertCols = ['user_id', 'private_school_id', 'title', 'payload_json', 'status'];
        $insertVals = [':user_id', ':private_school_id', ':title', ':payload_json', ':status'];
        $insertParams = [
            ':user_id'           => $userId,
            ':private_school_id' => $privateSchoolId,
            ':title'             => $title,
            ':payload_json'      => $payloadJson,
            ':status'            => $status,
        ];

        if ($hasActiveTabCol) {
            $insertCols[] = 'active_tab';
            $insertVals[] = ':active_tab';
            $insertParams[':active_tab'] = $activeTab;
        }

        if ($hasSummaryColumns) {
            $insertCols = array_merge($insertCols, ['department', 'school_year', 'opening_date', 'closing_date', 'total_days']);
            $insertVals = array_merge($insertVals, [':department', ':school_year', ':opening_date', ':closing_date', ':total_days']);
            $insertParams[':department']   = $summaryDepartment !== '' ? $summaryDepartment : null;
            $insertParams[':school_year']  = $summarySchoolYear !== '' ? $summarySchoolYear : null;
            $insertParams[':opening_date'] = $summaryOpeningDate;
            $insertParams[':closing_date'] = $summaryClosingDate;
            $insertParams[':total_days']   = $summaryTotalDays;
        }

        $insertCols[] = 'created_at';
        $insertVals[] = 'NOW()';
        $insertCols[] = 'updated_at';
        $insertVals[] = 'NOW()';

        $insertSql = "INSERT INTO school_calendar_documents (" . implode(', ', $insertCols) . ")
                 VALUES (" . implode(', ', $insertVals) . ")";

        $insert = $pdo->prepare($insertSql);
        $insert->execute($insertParams);
    } catch (Throwable $e) {
        error_log('school-portal-calendar.php INSERT error: ' . $e->getMessage());
        jsonError('Failed to save calendar document.', 500);
    }

    $newDocumentId = (int)$pdo->lastInsertId();

    if ($status === 'submitted') {
        $bridgeAction = upsertSchoolCalendarSubmission($pdo, $user, $newDocumentId, $title, $payload, $payloadJson);
        logCalendarBridgeAudit($pdo, $user, $newDocumentId, $title, $bridgeAction);
    }

    jsonSuccess([
        'document_id' => $newDocumentId,
        'title' => $title,
        'status' => $status,
        'active_tab' => $activeTab,
    ], 'Calendar document saved successfully.', 201);
}

function handleEditRequest(PDO $pdo, array $user, array $jsonBody): void
{
    $docId = isset($jsonBody['calendar_document_id']) ? (int)$jsonBody['calendar_document_id'] : 0;
    $reason = trim((string)($jsonBody['reason'] ?? ''));

    if ($docId <= 0) {
        jsonError('Invalid calendar_document_id.', 400);
    }

    // Resolve the effective school ID — private school users have school_id = null,
    // so fall back to private_school_id.
    $publicSchoolId  = !empty($user['school_id'])         ? (int)$user['school_id']         : null;
    $privateSchoolId = !empty($user['private_school_id']) ? (int)$user['private_school_id'] : null;
    $schoolId        = $publicSchoolId ?? $privateSchoolId;

    // If still null, try fetching from the users table (auth middleware may omit it).
    if ($schoolId === null) {
        try {
            $psRow = $pdo->prepare("SELECT school_id, private_school_id FROM users WHERE id = :uid LIMIT 1");
            $psRow->execute([':uid' => (int)$user['id']]);
            $row = $psRow->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                $publicSchoolId  = !empty($row['school_id'])         ? (int)$row['school_id']         : null;
                $privateSchoolId = !empty($row['private_school_id']) ? (int)$row['private_school_id'] : null;
                $schoolId        = $publicSchoolId ?? $privateSchoolId;
            }
        } catch (Throwable $e) {
            error_log('handleEditRequest: could not resolve school_id — ' . $e->getMessage());
        }
    }

    if (!$schoolId) {
        jsonError('Your account is not linked to a school.', 422);
    }

    if (!tableHasColumn($pdo, 'school_submissions', 'calendar_document_id')) {
        jsonError('Edit request is not available on this deployment (missing calendar_document_id column).', 501);
    }

    $stmt = $pdo->prepare(
        "SELECT id, status, history_json
         FROM school_submissions
         WHERE calendar_document_id = :doc_id
           AND private_school_id = :private_school_id
           AND type = 'calendar'
         ORDER BY id DESC
         LIMIT 1"
    );
    $stmt->execute([':doc_id' => $docId, ':private_school_id' => $schoolId]);
    $submission = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$submission) {
        jsonError('No submitted calendar found for this document.', 404);
    }

    $submissionId = (int)$submission['id'];
    $currentStatus = trim((string)($submission['status'] ?? ''));
    $normalizedStatus = normalizeSubmissionStatusKey($currentStatus);

    // Draft / returned-for-correction / rejected calendars are already directly
    // editable through the builder (see isCalendarEditableAfterSubmission) —
    // an edit request is unnecessary and would just be confusing there.
    $alreadyEditable = ['draft', 'returned', 'rejected', 'returned for correction', 'returned for revision'];
    if (in_array($normalizedStatus, $alreadyEditable, true)) {
        jsonError("This calendar can already be edited directly (status: {$currentStatus}) — no edit request is needed.", 422);
    }

    // Allow an edit request both while the calendar is still in the SDO review
    // pipeline (school wants to fix something before a decision is made) and
    // after it has been finalized (school wants to reopen an approved calendar).
    $allowed = [
        'submitted', 'pending', 'pending review',
        'review', 'under review',
        'for endorsement',
        'endorsed', 'approved', 'released to school',
    ];
    if (!in_array($normalizedStatus, $allowed, true)) {
        jsonError("Edit request not allowed. Current status: {$currentStatus}.", 422);
    }

    $history = [];
    if (!empty($submission['history_json'])) {
        $decoded = json_decode($submission['history_json'], true);
        if (is_array($decoded)) {
            $history = $decoded;
        }
    }

    // Resolve the school's display name for the history entry.
    // Match the tuition fee builder format: event-based entry with school name as "by".
    $schoolDisplayName = trim((string)($user['full_name'] ?? $user['email'] ?? ''));
    if ($schoolDisplayName === '') {
        try {
            $nameRow = $pdo->prepare("SELECT full_name, email FROM users WHERE id = :uid LIMIT 1");
            $nameRow->execute([':uid' => (int)$user['id']]);
            $nameData = $nameRow->fetch(PDO::FETCH_ASSOC);
            $schoolDisplayName = trim((string)($nameData['full_name'] ?? $nameData['email'] ?? 'School'));
        } catch (Throwable $e) {
            error_log('handleEditRequest: could not resolve display name — ' . $e->getMessage());
            $schoolDisplayName = 'School';
        }
    }

    $history[] = [
        'event'      => 'edit_request',
        'by'         => $schoolDisplayName,
        'reason'     => $reason !== '' ? $reason : '',
        'created_at' => date('Y-m-d H:i:s'),
    ];

    $historyJson = json_encode($history, JSON_UNESCAPED_UNICODE);

    // Only bump the status back to "pending" when reopening a calendar that was
    // already finalized — if it's still mid-review (submitted/pending/under
    // review/for endorsement), leave the status alone so the request doesn't
    // yank it out of whatever review stage SDO staff currently has it in.
    $finalizedStates = ['approved', 'endorsed', 'released to school'];
    $newStatus = in_array($normalizedStatus, $finalizedStates, true)
        ? getStatusValueForSchoolSubmission($pdo)
        : $currentStatus;

    $update = $pdo->prepare(
        "UPDATE school_submissions
         SET status = :status,
             history_json = :history,
             updated_at = NOW()
         WHERE id = :id"
    );
    $update->execute([
        ':status' => $newStatus,
        ':history' => $historyJson,
        ':id' => $submissionId,
    ]);

    $notifMsg = 'Your request to edit the school calendar has been submitted to SDO for review.';
    if ($reason !== '') {
        $notifMsg .= " Reason provided: {$reason}";
    }

    insertSchoolNotification(
        $pdo,
        $schoolId,
        'general',
        'Edit Request Submitted',
        $notifMsg,
        "school-portal-submissions.html#submission-{$submissionId}"
    );

    jsonSuccess([], 'Edit request submitted to SDO. You will be notified once approved.');
}

/**
 * GET ?action=get_supporting_documents
 *
 * Returns the active, ordered checklist items configured in
 * Settings → Supporting Docs for doc_type='school_calendar'. This powers
 * the "CHECKLIST FOR SUBMISSION OF CALENDAR ACTIVITIES" page so the list
 * shown to schools always matches what's configured there instead of a
 * hardcoded set of five requirements.
 */
function handleGetSupportingDocuments(PDO $pdo): void
{
    $stmt = $pdo->prepare(
        "SELECT id, slug, label, hint, icon, display_order
           FROM school_supporting_documents
          WHERE doc_type = :doc_type
            AND is_active = 1
          ORDER BY display_order ASC, label ASC"
    );
    $stmt->execute([':doc_type' => 'school_calendar']);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $items = array_map(function ($row) {
        return [
            'id'    => (int)$row['id'],
            'slug'  => $row['slug'],
            'label' => $row['label'],
            'hint'  => $row['hint'],
            'icon'  => $row['icon'],
        ];
    }, $rows);

    jsonSuccess(['items' => $items], 'Supporting documents retrieved successfully.');
}

/**
 * Slugs for the two requirements THIS builder generates itself (Letter of
 * Intent, Calendar of Activities). They're hardcoded on the frontend too —
 * never accept an upload for them here, since there's nothing to upload;
 * the builder's own generated pages satisfy them.
 */
const CHK_HARDCODED_SLUGS = ['sd_cal_loi', 'sd_cal_activities'];

function ensureSupportingUploadsTable(PDO $pdo): void
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

/**
 * Confirms the calendar document exists and belongs to $userId. Every
 * upload/download/delete handler below must call this before touching a
 * file, so a school can never read or overwrite another school's
 * submission just by guessing a document id.
 */
function assertOwnsCalendarDocument(PDO $pdo, int $userId, int $documentId): array
{
    $stmt = $pdo->prepare("SELECT id, user_id FROM school_calendar_documents WHERE id = :id LIMIT 1");
    $stmt->execute([':id' => $documentId]);
    $doc = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$doc || (int)$doc['user_id'] !== $userId) {
        jsonError('Calendar document not found or access denied.', 404);
    }
    return $doc;
}

function supportingUploadsDir(): string
{
    $dir = dirname(__DIR__) . '/uploads/calendar-supporting-docs';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

/**
 * POST action=upload_supporting_document (multipart/form-data)
 * Fields: calendar_document_id, slug, file
 *
 * Stores the actual file for one configurable checklist item on one
 * calendar document. A second upload for the same document+slug replaces
 * the first (old file deleted from disk, row updated in place) — a
 * document only ever needs its latest submission for each requirement.
 */
function handleUploadSupportingDocument(PDO $pdo, array $user): void
{
    ensureSupportingUploadsTable($pdo);
    $userId = (int)$user['id'];

    $documentId = isset($_POST['calendar_document_id']) && is_numeric($_POST['calendar_document_id'])
        ? (int)$_POST['calendar_document_id'] : 0;
    $slug = strtolower(trim((string)($_POST['slug'] ?? '')));

    if (!$documentId) jsonError('calendar_document_id is required.', 422);
    if (!$slug || !preg_match('/^[a-z0-9_]+$/', $slug)) jsonError('Invalid slug.', 422);
    if (in_array($slug, CHK_HARDCODED_SLUGS, true)) {
        jsonError('This requirement is generated automatically by the builder and cannot accept an upload.', 422);
    }

    assertOwnsCalendarDocument($pdo, $userId, $documentId);

    if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'] ?? '')) {
        jsonError('No file was uploaded.', 422);
    }
    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        jsonError('Upload failed (error code ' . $file['error'] . ').', 422);
    }

    $maxBytes = 10 * 1024 * 1024; // 10MB
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
            if ($detected) $mimeType = $detected;
            finfo_close($finfo);
        }
    }

    $storedFilename = $documentId . '_' . $slug . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $destPath = supportingUploadsDir() . '/' . $storedFilename;

    // Replace any previous file for this document+slug.
    $existingStmt = $pdo->prepare(
        "SELECT stored_filename FROM school_calendar_supporting_uploads
          WHERE calendar_document_id = :did AND slug = :slug LIMIT 1"
    );
    $existingStmt->execute([':did' => $documentId, ':slug' => $slug]);
    $oldStoredFilename = $existingStmt->fetchColumn();

    if (!move_uploaded_file($file['tmp_name'], $destPath)) {
        jsonError('Could not save the uploaded file.', 500);
    }

    if ($oldStoredFilename) {
        $oldPath = supportingUploadsDir() . '/' . $oldStoredFilename;
        if (is_file($oldPath)) @unlink($oldPath);
    }

    $stmt = $pdo->prepare(
        "INSERT INTO school_calendar_supporting_uploads
            (calendar_document_id, slug, original_filename, stored_filename, mime_type, file_size, uploaded_by)
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
        ':size'   => (int)$file['size'],
        ':uid'    => $userId,
    ]);

    jsonSuccess([
        'slug'              => $slug,
        'original_filename' => $file['name'],
        'file_size'         => (int)$file['size'],
        'uploaded_at'       => date('c'),
    ], 'Supporting document uploaded.');
}

/**
 * GET ?action=get_supporting_uploads&calendar_document_id={id}
 * Returns every uploaded file for that document, keyed by slug.
 */
function handleGetSupportingUploads(PDO $pdo, array $user): void
{
    ensureSupportingUploadsTable($pdo);
    $userId = (int)$user['id'];

    $documentId = isset($_GET['calendar_document_id']) && is_numeric($_GET['calendar_document_id'])
        ? (int)$_GET['calendar_document_id'] : 0;
    if (!$documentId) {
        jsonSuccess(['items' => []], 'No document specified.');
    }

    assertOwnsCalendarDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT slug, original_filename, mime_type, file_size, uploaded_at
           FROM school_calendar_supporting_uploads
          WHERE calendar_document_id = :did"
    );
    $stmt->execute([':did' => $documentId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    jsonSuccess(['items' => $rows], 'Supporting uploads retrieved.');
}

/**
 * POST action=delete_supporting_upload
 * Body: { calendar_document_id, slug }
 */
function handleDeleteSupportingUpload(PDO $pdo, array $user, array $body): void
{
    ensureSupportingUploadsTable($pdo);
    $userId = (int)$user['id'];

    $documentId = isset($body['calendar_document_id']) && is_numeric($body['calendar_document_id'])
        ? (int)$body['calendar_document_id'] : 0;
    $slug = strtolower(trim((string)($body['slug'] ?? '')));
    if (!$documentId || !$slug) jsonError('calendar_document_id and slug are required.', 422);

    assertOwnsCalendarDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT stored_filename FROM school_calendar_supporting_uploads
          WHERE calendar_document_id = :did AND slug = :slug LIMIT 1"
    );
    $stmt->execute([':did' => $documentId, ':slug' => $slug]);
    $storedFilename = $stmt->fetchColumn();
    if (!$storedFilename) jsonError('Upload not found.', 404);

    $path = supportingUploadsDir() . '/' . $storedFilename;
    if (is_file($path)) @unlink($path);

    $del = $pdo->prepare(
        "DELETE FROM school_calendar_supporting_uploads
          WHERE calendar_document_id = :did AND slug = :slug LIMIT 1"
    );
    $del->execute([':did' => $documentId, ':slug' => $slug]);

    jsonSuccess([], 'Supporting document removed.');
}

/**
 * GET ?action=download_supporting_upload&calendar_document_id={id}&slug={slug}
 * Streams the file rather than returning a public path, so files are never
 * reachable without going through this ownership check.
 */
function handleDownloadSupportingUpload(PDO $pdo, array $user): void
{
    ensureSupportingUploadsTable($pdo);
    $userId = (int)$user['id'];

    $documentId = isset($_GET['calendar_document_id']) && is_numeric($_GET['calendar_document_id'])
        ? (int)$_GET['calendar_document_id'] : 0;
    $slug = strtolower(trim((string)($_GET['slug'] ?? '')));
    if (!$documentId || !$slug) jsonError('calendar_document_id and slug are required.', 422);

    assertOwnsCalendarDocument($pdo, $userId, $documentId);

    $stmt = $pdo->prepare(
        "SELECT original_filename, stored_filename, mime_type
           FROM school_calendar_supporting_uploads
          WHERE calendar_document_id = :did AND slug = :slug LIMIT 1"
    );
    $stmt->execute([':did' => $documentId, ':slug' => $slug]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) jsonError('File not found.', 404);

    $path = supportingUploadsDir() . '/' . $row['stored_filename'];
    if (!is_file($path)) jsonError('File not found on server.', 404);

    if (ob_get_level()) ob_end_clean();
    header('Content-Type: ' . ($row['mime_type'] ?: 'application/octet-stream'));
    // Serve inline when possible so PDFs/images open in the browser for quick review
    header('Content-Disposition: inline; filename="' . basename($row['original_filename']) . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (!in_array($method, ['GET', 'POST', 'DELETE'], true)) {
        jsonError('Method not allowed', 405);
    }

    $rawBody = file_get_contents('php://input');
    $jsonBody = parseJsonBody($rawBody);

    // Backward-compatible fallback if a client cannot send DELETE.
    $action = strtolower(trim((string)($_GET['action'] ?? $_POST['action'] ?? ($jsonBody['action'] ?? ''))));
    if ($method === 'POST' && $action === 'delete') {
        $method = 'DELETE';
    }

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) {
        jsonError('Unauthorized. Please sign in.', 401);
    }

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    $pdo = getDB();
    $hasActiveTabCol = ensureCalendarDocumentsSchema($pdo);

    $userId = (int)$user['id'];

    // Resolve document_id for DELETE via query string.
    $documentIdFromQuery = isset($_GET['document_id']) && is_numeric($_GET['document_id'])
        ? (int)$_GET['document_id']
        : null;

    if ($method === 'GET') {
        if ($action === 'get_signatories') {
            handleGetSignatories($pdo, $user);
        }
        if ($action === 'get_legends') {
            handleGetLegends($pdo, $user);
        }
        if ($action === 'get_supporting_documents') {
            handleGetSupportingDocuments($pdo);
        }
        if ($action === 'get_supporting_uploads') {
            handleGetSupportingUploads($pdo, $user);
        }
        if ($action === 'download_supporting_upload') {
            handleDownloadSupportingUpload($pdo, $user);
        }
        handleDocumentsGet($pdo, $userId, $hasActiveTabCol);
    }

    if ($method === 'DELETE') {
        if ($action === 'delete_legend') {
            handleDeleteLegend($pdo, $user, $jsonBody);
        }
        handleDocumentsDelete($pdo, $userId, $documentIdFromQuery, $jsonBody);
    }

    // POST — multipart/form-data actions must be handled before the JSON
    // body check below, since a file upload has no JSON body ($_POST /
    // $_FILES are used instead).
    if ($action === 'upload_supporting_document') {
        handleUploadSupportingDocument($pdo, $user);
    }

    if (!is_array($jsonBody) || empty($jsonBody)) {
        jsonError('Invalid JSON payload.', 422);
    }

    if ($action === 'save_signatory')   { handleSaveSignatory($pdo, $user, $jsonBody);   }
    if ($action === 'delete_signatory') { handleDeleteSignatory($pdo, $user, $jsonBody); }
    if ($action === 'save_legend')      { handleSaveLegend($pdo, $user, $jsonBody);      }
    if ($action === 'delete_legend')    { handleDeleteLegend($pdo, $user, $jsonBody);    }
    if ($action === 'delete_supporting_upload') { handleDeleteSupportingUpload($pdo, $user, $jsonBody); }

    if (isset($jsonBody['calendar_document_id']) && !isset($jsonBody['payload']) && (empty($action) || $action === 'request_edit')) {


        handleEditRequest($pdo, $user, $jsonBody);
    }

    handleSave($pdo, $user, $jsonBody, $hasActiveTabCol);

} catch (Throwable $e) {
    error_log('school-portal-calendar.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
