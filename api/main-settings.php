<?php
/**
 * Settings API Endpoint
 * GET  /api/main-settings.php              → Get user profile
 * POST /api/main-settings.php?action=profile  → Update profile (name, email, picture)
 * POST /api/main-settings.php?action=password → Change password
 * POST /api/main-settings.php?action=2fa      → Toggle 2FA
 * GET  /api/main-settings.php?action=sessions → Get active sessions
 * POST /api/main-settings.php?action=revoke   → Revoke other sessions
 */

// ─── Error logging setup (MUST be first) ──────────────────────────────────────
error_reporting(E_ALL);
ini_set('display_errors', 0);

$action_label = isset($_GET['action']) ? $_GET['action'] : '(profile GET)';
if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Include security helpers and set proper headers
require_once dirname(__DIR__) . '/config/security.php';
header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$base_path = dirname(__DIR__);
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';
require_once $base_path . '/config/audit_log.php';
require_once $base_path . '/models/User.php';
require_once $base_path . '/helpers/FileEncryption.php';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data]);
    exit;
}

function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg]);
    exit;
}

/**
 * Canonical map of which builder each signatory role belongs to. Mirrored
 * identically in school-portal-calendar.php and school-portal-tuition.php.
 * Kept in sync by hand since these three portal files don't share a common
 * includes file. If a role is ever moved between builders, update this map
 * here and in the other two files — existing rows will self-correct the
 * next time they're saved (edit-and-resave), or via a manual UPDATE.
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
        'principal'      => 'shared',
    ];
    return $map[$role] ?? 'shared';
}

function ensureSchoolSignatoriesTable(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS school_signatories (
        id                INT(11)       NOT NULL AUTO_INCREMENT,
        private_school_id INT(11)       DEFAULT NULL,
        role              VARCHAR(60)   NOT NULL,
        builder_type      VARCHAR(20)   NOT NULL DEFAULT 'shared',
        full_name         VARCHAR(255)  NOT NULL DEFAULT '',
        position_title    VARCHAR(255)  NOT NULL DEFAULT '',
        office            VARCHAR(255)  NOT NULL DEFAULT '',
        city              VARCHAR(100)  NOT NULL DEFAULT '',
        contact           VARCHAR(60)   NOT NULL DEFAULT '',
        is_default        TINYINT(1)    NOT NULL DEFAULT 0,
        created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_sig_school_role (private_school_id, role),
        KEY idx_sig_builder (builder_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

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

function ensurePermitChecklistItemsTable(PDO $pdo): void {
    // Schema kept identical to migrations/permit_checklist_items.sql so this
    // is a no-op once that migration has run, and a safety net if it hasn't.
    $pdo->exec("CREATE TABLE IF NOT EXISTS permit_checklist_items (
        id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        section_name     VARCHAR(150)  NOT NULL,
        section_order    INT           NOT NULL DEFAULT 0,
        always_required  TINYINT(1)    NOT NULL DEFAULT 0,
        app_types        VARCHAR(255)  NULL,
        item_key         VARCHAR(100)  NOT NULL,
        label            TEXT          NOT NULL,
        item_order       INT           NOT NULL DEFAULT 0,
        is_active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_item_key (item_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function ensureSchoolSupportingDocumentsTable(PDO $pdo): void {
    // Schema kept identical to ensureSupportingDocumentsTable() in
    // school-portal-tuition.php (the table's original owner) so both files
    // agree regardless of which one runs first on a fresh install.
    $pdo->exec("CREATE TABLE IF NOT EXISTS school_supporting_documents (
        id             INT(11)      NOT NULL AUTO_INCREMENT,
        doc_type       VARCHAR(50)  NOT NULL DEFAULT 'all',
        slug           VARCHAR(60)  NOT NULL,
        label          VARCHAR(255) NOT NULL,
        hint           VARCHAR(500) DEFAULT NULL,
        icon           VARCHAR(50)  NOT NULL DEFAULT 'fa-file',
        display_order  INT(11)      NOT NULL DEFAULT 0,
        is_active      TINYINT(1)   NOT NULL DEFAULT 1,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_doctype_slug (doc_type, slug),
        KEY idx_doctype_active_order (doc_type, is_active, display_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function handleSchoolSignatories(PDO $pdo, string $method, array $input, array $user): void {
    if (!hasPermission('settings', $user)) {
        jsonError('Access denied. You do not have permission to perform this action.', 403);
    }

    ensureSchoolSignatoriesTable($pdo);

    $accountType = strtolower(trim((string)($user['account_type'] ?? 'sdo_personnel')));
    $isPortalUser = ($accountType === 'portal_user');

    if ($method === 'GET') {
        $privateSchoolId = isset($_GET['private_school_id']) ? (int)$_GET['private_school_id'] : 0;
        $scopeType = isset($_GET['scope_type']) ? strtolower(trim((string)$_GET['scope_type'])) : 'school';

        if ($scopeType === 'school' && $privateSchoolId <= 0) {
            jsonError('private_school_id is required', 422);
        }

        $sql = "SELECT id, private_school_id, role, builder_type, full_name, position_title, office, city, contact, is_default, created_at, updated_at
                  FROM school_signatories";
        $params = [];
        if ($scopeType === 'school') {
            $sql .= " WHERE private_school_id = :psid";
            $params[':psid'] = $privateSchoolId;
        } else {
            $sql .= " WHERE private_school_id IS NULL";
        }
        // Optional ?builder_type=calendar|tuition|shared filter, so the
        // Settings UI can show "which builder is this for" without the
        // admin having to cross-reference the role name manually.
        $builderFilter = isset($_GET['builder_type']) ? strtolower(trim((string)$_GET['builder_type'])) : '';
        if (in_array($builderFilter, ['calendar', 'tuition', 'shared'], true)) {
            $sql .= " AND builder_type = :btype";
            $params[':btype'] = $builderFilter;
        }
        $sql .= " ORDER BY role ASC, is_default DESC, id ASC";

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        jsonSuccess(['signatories' => $rows], 'School signatories retrieved successfully');
    }

    if ($method === 'PUT') {
        $scopeType = strtolower(trim((string)($input['scope_type'] ?? 'school')));
        $privateSchoolId = $scopeType === 'school' ? (int)($input['private_school_id'] ?? 0) : null;
        $role = mb_substr(trim((string)($input['role'] ?? '')), 0, 60);
        $fullName = mb_substr(trim((string)($input['full_name'] ?? '')), 0, 255);
        $positionTitle = mb_substr(trim((string)($input['position_title'] ?? '')), 0, 255);
        $office = mb_substr(trim((string)($input['office'] ?? '')), 0, 255);
        $city = mb_substr(trim((string)($input['city'] ?? '')), 0, 100);
        $contact = mb_substr(trim((string)($input['contact'] ?? '')), 0, 60);
        $isDefault = !empty($input['is_default']) ? 1 : 0;
        $id = isset($input['id']) && is_numeric($input['id']) ? (int)$input['id'] : null;

        if (!in_array($scopeType, ['school', 'office'], true)) jsonError('Invalid scope', 422);
        if ($scopeType === 'school' && $privateSchoolId <= 0) jsonError('private_school_id is required', 422);
        if ($scopeType === 'office' && $isPortalUser) jsonError('Office-managed signatories can only be edited by SDO personnel.', 403);
        if ($role === '') jsonError('Signatory role is required', 422);
        if ($fullName === '') jsonError('Signatory full name is required', 422);
        // These roles are shared across every school (RD, SDS, Recommending
        // Approval, Final Approver, Checklist "Checked By") — plus the
        // Tuition Fee builder's "Validated By" and "Noted By" signatories,
        // which are always SDO/regional-office signatories (e.g. EPS/QAD,
        // Regional Director) — and must only ever exist as office-managed
        // rows, never a per-school copy.
        $officeOnlyRoles = ['rd', 'sds', 'recommending', 'final_approver', 'chk_checked_by', 'validated_by', 'noted_by'];
        if ($scopeType === 'school' && in_array($role, $officeOnlyRoles, true)) {
            jsonError('This role is managed by the SDO/SMME office only. Use "Office-managed signatories" scope instead.', 422);
        }

        if ($scopeType === 'school' && $isDefault) {
            $pdo->prepare("UPDATE school_signatories SET is_default = 0 WHERE private_school_id = :psid AND role = :role")
                ->execute([':psid' => $privateSchoolId, ':role' => $role]);
        }
        if ($scopeType === 'office' && $isDefault) {
            $pdo->prepare("UPDATE school_signatories SET is_default = 0 WHERE private_school_id IS NULL AND role = :role")
                ->execute([':role' => $role]);
        }

        if ($id !== null) {
            $chk = $pdo->prepare("SELECT id FROM school_signatories WHERE id = :id LIMIT 1");
            $chk->execute([':id' => $id]);
            if (!$chk->fetchColumn()) jsonError('School signatory not found.', 404);

            $sql = "UPDATE school_signatories SET role = :role, builder_type = :btype, full_name = :full_name, position_title = :position_title,
                        office = :office, city = :city, contact = :contact, is_default = :is_default, updated_at = NOW()";
            $params = [
                ':role' => $role,
                ':btype' => signatoryBuilderType($role),
                ':full_name' => $fullName,
                ':position_title' => $positionTitle,
                ':office' => $office,
                ':city' => $city,
                ':contact' => $contact,
                ':is_default' => $isDefault,
                ':id' => $id,
            ];
            if ($scopeType === 'school') {
                $sql .= ", private_school_id = :psid";
                $params[':psid'] = $privateSchoolId;
            } else {
                $sql .= ", private_school_id = NULL";
            }
            $sql .= " WHERE id = :id";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            jsonSuccess(['id' => $id, 'is_default' => $isDefault], 'School signatory updated');
        }

        $sql = "INSERT INTO school_signatories (private_school_id, role, builder_type, full_name, position_title, office, city, contact, is_default)
                VALUES (:psid, :role, :btype, :full_name, :position_title, :office, :city, :contact, :is_default)";
        $params = [
            ':role' => $role,
            ':btype' => signatoryBuilderType($role),
            ':full_name' => $fullName,
            ':position_title' => $positionTitle,
            ':office' => $office,
            ':city' => $city,
            ':contact' => $contact,
            ':is_default' => $isDefault,
        ];
        if ($scopeType === 'school') {
            $params[':psid'] = $privateSchoolId;
        } else {
            $params[':psid'] = null;
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        jsonSuccess(['id' => (int)$pdo->lastInsertId(), 'is_default' => $isDefault], 'School signatory saved');
    }

    if ($method === 'DELETE') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id <= 0) jsonError('Signatory id required', 422);

        $stmt = $pdo->prepare("DELETE FROM school_signatories WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount() === 0) jsonError('School signatory not found.', 404);

        jsonSuccess(['id' => $id], 'School signatory deleted');
    }

    jsonError('Method not allowed', 405);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getAuthUser() {
    $user = authenticate('sdo_personnel');
    if (!$user) jsonError('Unauthorized', 401);
    return $user;
}

// ─── Routing ──────────────────────────────────────────────────────────────────
$action = isset($_GET['action']) ? $_GET['action'] : '';

try {
    $pdo       = getDB();
    auditEnsureTable($pdo);
    ensureSchoolSupportingDocumentsTable($pdo);
    ensurePermitChecklistItemsTable($pdo);
    $userModel = new User($pdo);

    // ===== GET profile =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === '') {
        $user = getAuthUser();
        $permissions = json_decode($user['permissions'] ?? '[]', true);
        if (!is_array($permissions)) {
            $permissions = [];
        }

        jsonSuccess([
            'id'             => $user['id'],
            'full_name'      => $user['full_name'],
            'email'          => $user['email'],
            'role'           => $user['role'] ?? 'viewer',
            'account_type'   => $user['account_type'] ?? 'sdo_personnel',
            'permissions'    => $permissions,
            'profile_picture'=> $user['profile_picture'] ?? null,
            'two_factor'     => (int)($user['two_factor_enabled'] ?? 0),
            'created_at'     => $user['created_at'],
        ]);
    }

    // ===== GET sessions =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'sessions') {
        $user         = getAuthUser();
        $currentToken = $_COOKIE['session_token'] ?? (getallheaders()['Authorization'] ?? '');

        $stmt = $pdo->prepare("
            SELECT id, ip_address, user_agent, created_at, expires_at,
                   CASE WHEN session_token = :current THEN 1 ELSE 0 END AS is_current
            FROM login_sessions
            WHERE user_id = :uid AND expires_at > NOW()
            ORDER BY created_at DESC
        ");
        $stmt->execute([':uid' => $user['id'], ':current' => $currentToken]);
        $sessions = $stmt->fetchAll(PDO::FETCH_ASSOC);

        jsonSuccess($sessions);
    }

    // ===== GET rating-scales =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'rating-scales') {
        $user = getAuthUser();
        
        // SECURITY: Require 'settings' permission for rating scales
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $stmt = $pdo->query("SELECT id, scale_type, min_score, max_score, level_of_agreement, descriptive_equivalent FROM rating_scales WHERE is_active = 1 ORDER BY scale_type, min_score DESC");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Group by type and map to JS-friendly keys
        $grouped = ['category' => [], 'speaker' => [], 'overall' => []];
        foreach ($rows as $row) {
            $grouped[$row['scale_type']][] = [
                'id' => $row['id'],
                'type' => $row['scale_type'],
                'min_value' => $row['min_score'],
                'max_value' => $row['max_score'],
                'level' => $row['level_of_agreement'],
                'description' => $row['descriptive_equivalent']
            ];
        }

        jsonSuccess($grouped);
    }

    // ===== GET user-roles =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'user-roles') {
        $user = getAuthUser();

        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $stmt = $pdo->query("
            SELECT ur.id, ur.role_name, ur.description, ur.default_permissions,
                   COUNT(u.id) AS user_count
            FROM user_roles ur
            LEFT JOIN users u ON u.role = ur.role_name
            GROUP BY ur.id
            ORDER BY ur.role_name ASC
        ");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as &$row) {
            $row['default_permissions'] = $row['default_permissions']
                ? json_decode($row['default_permissions'], true)
                : [];
            $row['user_count'] = (int)$row['user_count'];
        }

        jsonSuccess($rows);
    }

    // ===== GET supporting-documents =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'supporting-documents') {
        $user = getAuthUser();

        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $docType = isset($_GET['doc_type']) ? trim($_GET['doc_type']) : '';

        if ($docType !== '' && $docType !== 'all') {
            $stmt = $pdo->prepare("
                SELECT id, doc_type, slug, label, hint, icon, display_order, is_active, created_at, updated_at
                FROM school_supporting_documents
                WHERE doc_type = :doc_type
                ORDER BY display_order ASC, label ASC
            ");
            $stmt->execute([':doc_type' => $docType]);
        } else {
            $stmt = $pdo->query("
                SELECT id, doc_type, slug, label, hint, icon, display_order, is_active, created_at, updated_at
                FROM school_supporting_documents
                ORDER BY FIELD(doc_type, 'all','tuition_increase','tuition_no_increase','school_calendar'), display_order ASC, label ASC
            ");
        }
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as &$row) {
            $row['id']            = (int)$row['id'];
            $row['display_order'] = (int)$row['display_order'];
            $row['is_active']     = (int)$row['is_active'];
        }

        jsonSuccess($rows);
    }

    // ===== GET permit-checklist =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'permit-checklist') {
        $user = getAuthUser();

        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $stmt = $pdo->query("
            SELECT id, section_name, section_order, always_required, app_types,
                   item_key, label, item_order, is_active, created_at, updated_at
            FROM permit_checklist_items
            ORDER BY section_order ASC, item_order ASC, id ASC
        ");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as &$row) {
            $row['id']              = (int)$row['id'];
            $row['section_order']   = (int)$row['section_order'];
            $row['always_required'] = (int)$row['always_required'];
            $row['item_order']      = (int)$row['item_order'];
            $row['is_active']       = (int)$row['is_active'];
        }

        jsonSuccess($rows);
    }

    // ===== GET signatories =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'signatories') {
        $user = getAuthUser();
        
        // SECURITY: Require 'settings' permission for signatories
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        
        $settingName = isset($_GET['setting_name']) ? trim($_GET['setting_name']) : 'default';
        
        $stmt = $pdo->prepare("SELECT * FROM report_signatories WHERE setting_name = :name AND is_active = 1 LIMIT 1");
        $stmt->execute([':name' => $settingName]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if ($row) {
            jsonSuccess([
                'id' => $row['id'],
                'setting_name' => $row['setting_name'],
                'org_country' => $row['org_country'],
                'org_department' => $row['org_department'],
                'org_division' => $row['org_division'],
                'org_section' => $row['org_section'],
                'org_unit' => $row['org_unit'],
                'prepared_name' => $row['prepared_name'],
                'prepared_title' => $row['prepared_title'],
                'checked_name' => $row['checked_name'],
                'checked_title' => $row['checked_title'],
                'noted1_name' => $row['noted1_name'],
                'noted1_title' => $row['noted1_title'],
                'noted2_name' => $row['noted2_name'],
                'noted2_title' => $row['noted2_title'],
                'noted3_name' => $row['noted3_name'],
                'noted3_title' => $row['noted3_title']
            ]);
        } else {
            // Return default values if no record exists
            jsonSuccess([
                'setting_name' => 'default',
                'org_country' => 'Republic of the Philippines',
                'org_department' => 'Department of Education',
                'org_division' => '',
                'org_section' => '',
                'org_unit' => '',
                'prepared_name' => '',
                'prepared_title' => '',
                'checked_name' => '',
                'checked_title' => '',
                'noted1_name' => '',
                'noted1_title' => '',
                'noted2_name' => '',
                'noted2_title' => '',
                'noted3_name' => '',
                'noted3_title' => ''
            ]);
        }
    }

    // ===== GET files =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'files') {
        $user = getAuthUser();
        
        $stmt = $pdo->prepare("
            SELECT id, files, uploaded_at, item_no, location, headings, unit, nature_of_event, status, qame_report, computation_files
            FROM user_files 
            WHERE user_id = :uid 
            ORDER BY uploaded_at DESC
        ");
        $stmt->execute([':uid' => $user['id']]);
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        // Parse files JSON for each record
        foreach ($records as &$record) {
            $record['files'] = json_decode($record['files'], true) ?: [];
        }
        
        jsonSuccess($records);
    }

    // ===== GET single file =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'get-file') {
        $user = getAuthUser();
        $fileId = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if (!$fileId) {
            jsonError('File ID required');
        }
        
        $stmt = $pdo->prepare("SELECT * FROM user_files WHERE id = :id AND user_id = :uid");
        $stmt->execute([':id' => $fileId, ':uid' => $user['id']]);
        $fileRecord = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$fileRecord) {
            jsonError('File not found', 404);
        }
        
        // Parse files JSON
        $fileRecord['files'] = json_decode($fileRecord['files'], true) ?: [];
        
        jsonSuccess($fileRecord);
    }

    // ===== GET download =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'download') {
        $user = getAuthUser();
        $recordId = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        $fileIndex = isset($_GET['file_index']) ? (int)$_GET['file_index'] : 0;
        if (!$recordId) {
            jsonError('Record ID required');
        }
        
        $stmt = $pdo->prepare("SELECT * FROM user_files WHERE id = :id AND user_id = :uid");
        $stmt->execute([':id' => $recordId, ':uid' => $user['id']]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$record) {
            jsonError('Record not found', 404);
        }
        
        $files = json_decode($record['files'], true) ?: [];
        
        if (!isset($files[$fileIndex])) {
            jsonError('File not found', 404);
        }
        
        $fileData = $files[$fileIndex];
        $filePath = $fileData['file_path'];
        
        if (!file_exists($filePath)) {
            jsonError('File not found on server', 404);
        }
        
        // Decrypt file for download
        $fileEncryption = new FileEncryption();
        try {
            $decryptedContents = $fileEncryption->getDecryptedContents($filePath);
        } catch (Exception $e) {
            // Fallback: file might not be encrypted (legacy files)
            $decryptedContents = file_get_contents($filePath);
        }
        
        ob_end_clean();
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . $fileData['file_name'] . '"');
        header('Content-Length: ' . mb_strlen($decryptedContents, '8bit'));
        header('Cache-Control: no-cache, must-revalidate');
        echo $decryptedContents;
        exit;
    }

    // ===== GET contact-info (public — no auth required) =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'contact-info') {
        $stmt = $pdo->prepare("
            SELECT setting_value FROM system_settings WHERE setting_key = 'contact_info' LIMIT 1
        ");
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $data = json_decode($row['setting_value'], true) ?? [];
        } else {
            $data = ['address' => '', 'email' => '', 'phone' => '', 'hours' => ''];
        }
        jsonSuccess($data, 'OK');
    }

    // ===== GET contact-submissions (auth required) =====
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'contact-submissions') {
        $user = getAuthUser();
        try {
            $stmt = $pdo->query("
                SELECT id, name, email, school, concern, message, created_at
                FROM contact_submissions ORDER BY created_at DESC LIMIT 200
            ");
            jsonSuccess($stmt->fetchAll(PDO::FETCH_ASSOC), 'OK');
        } catch (PDOException $e) {
            jsonSuccess([], 'No submissions yet');
        }
    }
    if ($action === 'school-signatories') {
        $user = getAuthUser();
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
        handleSchoolSignatories($pdo, $_SERVER['REQUEST_METHOD'] ?? 'GET', $input, $user);
    }

    // ===== POST actions =====
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    // ─── Contact Submission POST (public — no auth required) ──────────
    if ($action === 'contact') {
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
        $name    = trim($input['name'] ?? '');
        $email   = trim($input['email'] ?? '');
        $school  = trim($input['school'] ?? '');
        $concern = trim($input['concern'] ?? '');
        $message = trim($input['message'] ?? '');
        if (!$name || !$email || !$message) {
            jsonError('Name, email, and message are required.');
        }
        try {
            $pdo->prepare("
                CREATE TABLE IF NOT EXISTS contact_submissions (
                    id          INT AUTO_INCREMENT PRIMARY KEY,
                    name        VARCHAR(255) NOT NULL,
                    email       VARCHAR(255) NOT NULL,
                    school      VARCHAR(255),
                    concern     VARCHAR(255),
                    message     TEXT NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ")->execute();
            $pdo->prepare("
                INSERT INTO contact_submissions (name, email, school, concern, message)
                VALUES (:name, :email, :school, :concern, :message)
            ")->execute([
                ':name' => $name, ':email' => $email, ':school' => $school,
                ':concern' => $concern, ':message' => $message
            ]);
            jsonSuccess(null, 'Message received');
        } catch (PDOException $e) {
            jsonError('Could not save message: ' . $e->getMessage(), 500);
        }
    }

    $user = getAuthUser();

    $auditSettings = static function ($actionName, $status, $description) use ($pdo, $user): void {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)$user['id'],
            'role' => (string)($user['role'] ?? 'viewer'),
            'action' => (string)$actionName,
            'module' => 'main_settings',
            'status' => (string)$status,
            'description' => (string)$description,
        ]);
    };

    // ─── Upload file (multipart/form-data, not JSON) ──────────────────────────
    if ($action === 'upload') {
        // Handle multiple files upload
        $uploadedFiles = [];
        $uploadDir = $base_path . '/api/uploads/user_files/' . $user['id'];
        if (!is_dir($uploadDir)) {
            mkdir($uploadDir, 0755, true);
        }
        
        $maxSize = 10 * 1024 * 1024; // 10 MB per file
        
        // Check if files[] array or single file
        $fileEncryption = new FileEncryption();
        
        if (isset($_FILES['files'])) {
            // Multiple files upload
            $fileCount = count($_FILES['files']['name']);
            for ($i = 0; $i < $fileCount; $i++) {
                if ($_FILES['files']['error'][$i] !== UPLOAD_ERR_OK) continue;
                if ($_FILES['files']['size'][$i] > $maxSize) {
                    continue;
                }
                
                // SECURITY: Validate file extension to prevent RCE
                $originalName = $_FILES['files']['name'][$i];
                if (!isAllowedFileExtension($originalName, ['document', 'image', 'archive'])) {
                    continue; // Skip dangerous file types
                }
                
                $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
                $safeName = preg_replace('/[^a-zA-Z0-9_.-]/', '_', pathinfo($originalName, PATHINFO_FILENAME));
                $storedName = $safeName . '_' . time() . '_' . $i . '.' . $ext . '.enc';
                $filePath = $uploadDir . '/' . $storedName;
                
                // Encrypt file before saving
                if ($fileEncryption->encryptUploadedFile($_FILES['files']['tmp_name'][$i], $filePath)) {
                    $uploadedFiles[] = [
                        'file_name' => $_FILES['files']['name'][$i],
                        'stored_name' => $storedName,
                        'file_size' => $_FILES['files']['size'][$i],
                        'file_path' => $filePath
                    ];
                }
            }
        } elseif (isset($_FILES['file']) && $_FILES['file']['error'] === UPLOAD_ERR_OK) {
            // Single file (backward compatibility)
            $file = $_FILES['file'];
            if ($file['size'] <= $maxSize) {
                // SECURITY: Validate file extension to prevent RCE
                if (!isAllowedFileExtension($file['name'], ['document', 'image', 'archive'])) {
                    jsonError('File type not allowed. Allowed types: PDF, Word, Excel, images');
                }
                
                $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                $safeName = preg_replace('/[^a-zA-Z0-9_.-]/', '_', pathinfo($file['name'], PATHINFO_FILENAME));
                $storedName = $safeName . '_' . time() . '.' . $ext . '.enc';
                $filePath = $uploadDir . '/' . $storedName;
                
                // Encrypt file before saving
                if ($fileEncryption->encryptUploadedFile($file['tmp_name'], $filePath)) {
                    $uploadedFiles[] = [
                        'file_name' => $file['name'],
                        'stored_name' => $storedName,
                        'file_size' => $file['size'],
                        'file_path' => $filePath
                    ];
                }
            }
        }
        
        if (empty($uploadedFiles)) {
            jsonError('No files uploaded successfully');
        }
        
        // Get metadata from POST
        $itemNo = isset($_POST['item_no']) ? trim($_POST['item_no']) : '';
        $headings = isset($_POST['headings']) ? trim($_POST['headings']) : '';
        $unit = isset($_POST['unit']) ? trim($_POST['unit']) : '';
        $natureOfEvent = isset($_POST['nature_of_event']) ? trim($_POST['nature_of_event']) : '';
        $status = isset($_POST['status']) ? trim($_POST['status']) : 'Pending';
        $qameReport = isset($_POST['qame_report']) ? trim($_POST['qame_report']) : '';
        $computationFiles = isset($_POST['computation_files']) ? trim($_POST['computation_files']) : '';
        
        // Save to database with files as JSON
        $stmt = $pdo->prepare("
            INSERT INTO user_files (user_id, files, uploaded_at, item_no, location, headings, unit, nature_of_event, status, qame_report, computation_files)
            VALUES (:uid, :files, NOW(), :itemno, :loc, :heads, :unit, :nature, :status, :qame, :comp)
        ");
        $stmt->execute([
            ':uid'    => $user['id'],
            ':files'  => json_encode($uploadedFiles),
            ':itemno' => $itemNo,
            ':loc'    => $uploadDir,
            ':heads'  => $headings,
            ':unit'   => $unit,
            ':nature' => $natureOfEvent,
            ':status' => $status,
            ':qame'   => $qameReport,
            ':comp'   => $computationFiles
        ]);
        
        $recordId = $pdo->lastInsertId();
        $auditSettings(
            'settings_upload_files',
            'success',
            'Created user file record | record_id=' . (int)$recordId . ' | files_count=' . count($uploadedFiles)
        );
        jsonSuccess(['id' => $recordId, 'files_count' => count($uploadedFiles)], 'Files uploaded successfully');
    }

    // ─── Add files to existing record (multipart/form-data) ───────────────────
    if ($action === 'add-files') {
        $recordId = isset($_POST['record_id']) ? (int)$_POST['record_id'] : 0;
        if (!$recordId) {
            jsonError('Record ID required');
        }
        
        // Verify ownership
        $stmt = $pdo->prepare("SELECT * FROM user_files WHERE id = :id AND user_id = :uid");
        $stmt->execute([':id' => $recordId, ':uid' => $user['id']]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$record) {
            jsonError('Record not found');
        }
        
        $existingFiles = json_decode($record['files'], true) ?: [];
        $uploadDir = $base_path . '/api/uploads/user_files/' . $user['id'];
        $maxSize = 10 * 1024 * 1024;
        $newFiles = [];
        $fileEncryption = new FileEncryption();
        
        if (isset($_FILES['files'])) {
            $fileCount = count($_FILES['files']['name']);
            for ($i = 0; $i < $fileCount; $i++) {
                if ($_FILES['files']['error'][$i] !== UPLOAD_ERR_OK) continue;
                if ($_FILES['files']['size'][$i] > $maxSize) continue;
                
                // SECURITY: Validate file extension to prevent RCE
                $originalName = $_FILES['files']['name'][$i];
                if (!isAllowedFileExtension($originalName, ['document', 'image', 'archive'])) {
                    continue; // Skip dangerous file types
                }
                
                $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
                $safeName = preg_replace('/[^a-zA-Z0-9_.-]/', '_', pathinfo($originalName, PATHINFO_FILENAME));
                $storedName = $safeName . '_' . time() . '_' . $i . '.' . $ext . '.enc';
                $filePath = $uploadDir . '/' . $storedName;
                
                // Encrypt file before saving (consistent with upload action)
                if ($fileEncryption->encryptUploadedFile($_FILES['files']['tmp_name'][$i], $filePath)) {
                    $newFiles[] = [
                        'file_name' => $originalName,
                        'stored_name' => $storedName,
                        'file_size' => $_FILES['files']['size'][$i],
                        'file_path' => $filePath
                    ];
                }
            }
        }
        
        if (empty($newFiles)) {
            jsonError('No new files uploaded');
        }
        
        $allFiles = array_merge($existingFiles, $newFiles);
        $stmt = $pdo->prepare("UPDATE user_files SET files = :files WHERE id = :id");
        $stmt->execute([':files' => json_encode($allFiles), ':id' => $recordId]);

        $auditSettings(
            'settings_add_files',
            'success',
            'Added files to existing record | record_id=' . $recordId . ' | added=' . count($newFiles) . ' | total=' . count($allFiles)
        );
        
        jsonSuccess(['added' => count($newFiles), 'total' => count($allFiles)], 'Files added');
    }

    // ─── Delete Contact Submission ─────────────────────────────────────
    if ($action === 'delete-contact-submission') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        // Accept id from query string (no body needed)
        $id = intval($_GET['id'] ?? 0);
        if (!$id) jsonError('Invalid submission ID');
        $stmt = $pdo->prepare("DELETE FROM contact_submissions WHERE id = :id");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount() === 0) {
            jsonError('Submission not found', 404);
        }
        $auditSettings('contact_submission_delete', 'success', "Contact submission #$id deleted");
        jsonSuccess(null, 'Submission deleted');
    }

    // For other POST actions, parse JSON body
    $input = json_decode(file_get_contents('php://input'), true);

    if (!is_array($input)) {
        jsonError('Invalid JSON body');
    }

    // ─── Update profile ───────────────────────────────────────────────────────
    if ($action === 'profile') {
        $updates = [];
        $changedFields = [];

        if (isset($input['full_name']) && trim($input['full_name']) !== '') {
            $updates['full_name'] = trim($input['full_name']);
            $changedFields[] = 'full_name';
        }

        if (isset($input['email']) && filter_var($input['email'], FILTER_VALIDATE_EMAIL)) {
            if ($input['email'] !== $user['email']) {
                $existing = $userModel->getUserByEmail($input['email']);
                if ($existing) {
                    jsonError('Email already in use');
                }
            }
            $updates['email'] = $input['email'];
            $changedFields[] = 'email';
        }
        // Note: Invalid email format silently ignored to allow partial updates

        // Handle base64 profile picture separately with validation
        if (isset($input['profile_picture'])) {
            $pic = $input['profile_picture'];
            // Allow empty string to remove profile picture
            if ($pic !== '') {
                // SECURITY: Validate size limit (500KB max)
                if (strlen($pic) > 500000) {
                    jsonError('Profile picture too large (max 500KB)');
                }
                // SECURITY: Validate it's a proper image data URI
                if (!preg_match('/^data:image\/(jpeg|png|gif|webp);base64,/', $pic)) {
                    jsonError('Invalid image format. Allowed: JPEG, PNG, GIF, WebP');
                }
            }
            $stmt = $pdo->prepare("UPDATE users SET profile_picture = :pic WHERE id = :id");
            $stmt->execute([':pic' => $pic, ':id' => $user['id']]);
            unset($updates['profile_picture']);
            $changedFields[] = 'profile_picture';
        }

        if (!empty($updates)) {
            $userModel->updateUser($user['id'], $updates);
        }
        // No changes needed if updates array is empty (profile picture may have been updated separately)

        $fresh = $userModel->getUserById($user['id']);
        $auditSettings(
            'settings_profile_update',
            'success',
            'Profile updated | fields=' . (!empty($changedFields) ? implode(',', array_unique($changedFields)) : 'none')
        );
        jsonSuccess([
            'full_name'       => $fresh['full_name'],
            'email'           => $fresh['email'],
            'profile_picture' => $fresh['profile_picture'] ?? null,
        ], 'Profile updated');
    }

    // ─── Change password ──────────────────────────────────────────────────────
    if ($action === 'password') {
        if (empty($input['current_password']) || empty($input['new_password'])) {
            jsonError('Current and new passwords are required');
        }
        if (strlen($input['new_password']) < 8) {
            jsonError('New password must be at least 8 characters');
        }

        $hashInDB = $user['password'];
        $verified = password_verify($input['current_password'], $hashInDB);
        if (!$verified) {
            $auditSettings('settings_password_change', 'failed', 'Password change failed: current password mismatch');
            jsonError('Current password is incorrect');
        }

        $hashed = password_hash($input['new_password'], PASSWORD_BCRYPT);
        $userModel->updateUser($user['id'], ['password' => $hashed]);
        $auditSettings('settings_password_change', 'success', 'Password changed successfully');
        jsonSuccess(null, 'Password changed successfully');
    }

    // ─── Toggle 2FA ───────────────────────────────────────────────────────────
    if ($action === '2fa') {
        $enable   = isset($input['enable']) ? (bool)$input['enable'] : false;
        $password = isset($input['password']) ? $input['password'] : '';

        if (empty($password)) {
            jsonError('Password is required to change 2FA settings');
        }

        $verified = password_verify($password, $user['password']);
        if (!$verified) {
            $auditSettings('settings_2fa_toggle', 'failed', '2FA toggle failed: password mismatch');
            jsonError('Incorrect password');
        }

        $stmt = $pdo->prepare("UPDATE users SET two_factor_enabled = :val WHERE id = :id");
        $stmt->execute([':val' => $enable ? 1 : 0, ':id' => $user['id']]);
        if (!$enable) {
            $del = $pdo->prepare("DELETE FROM two_factor_codes WHERE user_id = :id AND is_used = 0");
            $del->execute([':id' => $user['id']]);
            $deleted = $del->rowCount();
        }

        $auditSettings(
            'settings_2fa_toggle',
            'success',
            '2FA setting updated | enabled=' . ($enable ? '1' : '0')
        );

        jsonSuccess(
            ['two_factor' => $enable ? 1 : 0],
            $enable
                ? '2FA enabled — you will receive an email code on your next login'
                : '2FA disabled'
        );
    }

    // ─── Revoke other sessions ────────────────────────────────────────────────
    if ($action === 'revoke') {
        $currentToken = $_COOKIE['session_token'] ?? (getallheaders()['Authorization'] ?? '');

        $stmt = $pdo->prepare("DELETE FROM login_sessions WHERE user_id = :uid AND session_token != :current");
        $stmt->execute([':uid' => $user['id'], ':current' => $currentToken]);
        $count = $stmt->rowCount();

        $auditSettings('settings_revoke_sessions', 'success', 'Revoked other sessions | count=' . $count);

        jsonSuccess(['revoked' => $count], "Logged out of $count other session(s)");
    }

    // ─── Update file metadata ─────────────────────────────────────────────────
    if ($action === 'update-file') {
        $fileId = isset($input['file_id']) ? (int)$input['file_id'] : 0;
        if (!$fileId) {
            jsonError('File ID required');
        }
        
        // Verify ownership
        $stmt = $pdo->prepare("SELECT id FROM user_files WHERE id = :id AND user_id = :uid");
        $stmt->execute([':id' => $fileId, ':uid' => $user['id']]);
        if (!$stmt->fetch()) {
            $auditSettings('settings_file_metadata_update', 'failed', 'File metadata update failed: record not found | record_id=' . $fileId);
            jsonError('File not found');
        }
        
        $stmt = $pdo->prepare("
            UPDATE user_files SET
                item_no = :itemno,
                headings = :heads,
                unit = :unit,
                nature_of_event = :nature,
                status = :status,
                qame_report = :qame,
                computation_files = :comp
            WHERE id = :id AND user_id = :uid
        ");
        $stmt->execute([
            ':itemno' => isset($input['item_no']) ? trim($input['item_no']) : '',
            ':heads'  => isset($input['headings']) ? trim($input['headings']) : '',
            ':unit'   => isset($input['unit']) ? trim($input['unit']) : '',
            ':nature' => isset($input['nature_of_event']) ? trim($input['nature_of_event']) : '',
            ':status' => isset($input['status']) ? trim($input['status']) : 'Pending',
            ':qame'   => isset($input['qame_report']) ? trim($input['qame_report']) : '',
            ':comp'   => isset($input['computation_files']) ? trim($input['computation_files']) : '',
            ':id'     => $fileId,
            ':uid'    => $user['id']
        ]);

        $auditSettings('settings_file_metadata_update', 'success', 'File metadata updated | record_id=' . $fileId);
        
        jsonSuccess(null, 'File updated');
    }

    // ─── Delete file or record ────────────────────────────────────────────────
    if ($action === 'delete-file') {
        $recordId = isset($input['record_id']) ? (int)$input['record_id'] : (isset($input['file_id']) ? (int)$input['file_id'] : 0);
        $fileIndex = isset($input['file_index']) ? (int)$input['file_index'] : -1;
        if (!$recordId) {
            jsonError('Record ID required');
        }
        
        $stmt = $pdo->prepare("SELECT * FROM user_files WHERE id = :id AND user_id = :uid");
        $stmt->execute([':id' => $recordId, ':uid' => $user['id']]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$record) {
            $auditSettings('settings_file_delete', 'failed', 'Delete failed: record not found | record_id=' . $recordId);
            jsonError('Record not found');
        }
        
        $files = json_decode($record['files'], true) ?: [];
        
        if ($fileIndex >= 0 && isset($files[$fileIndex])) {
            // Delete specific file from array
            $fileToDelete = $files[$fileIndex];
            if (file_exists($fileToDelete['file_path'])) {
                unlink($fileToDelete['file_path']);
            }
            
            array_splice($files, $fileIndex, 1);
            
            if (empty($files)) {
                // No more files, delete record
                $stmt = $pdo->prepare("DELETE FROM user_files WHERE id = :id");
                $stmt->execute([':id' => $recordId]);
                $auditSettings('settings_record_delete', 'success', 'Record deleted because last file was removed | record_id=' . $recordId);
                jsonSuccess(['deleted' => 'record'], 'Record deleted');
            } else {
                // Update record with remaining files
                $stmt = $pdo->prepare("UPDATE user_files SET files = :files WHERE id = :id");
                $stmt->execute([':files' => json_encode($files), ':id' => $recordId]);
                $auditSettings(
                    'settings_file_delete',
                    'success',
                    'File removed from record | record_id=' . $recordId . ' | file_index=' . $fileIndex . ' | remaining=' . count($files)
                );
                jsonSuccess(['deleted' => 'file', 'remaining' => count($files)], 'File deleted');
            }
        } else {
            // Delete entire record and all files
            foreach ($files as $f) {
                if (file_exists($f['file_path'])) {
                    unlink($f['file_path']);
                }
            }
            
            $stmt = $pdo->prepare("DELETE FROM user_files WHERE id = :id");
            $stmt->execute([':id' => $recordId]);

            $auditSettings('settings_record_delete', 'success', 'Record and all files deleted | record_id=' . $recordId);
            
            jsonSuccess(['deleted' => 'record'], 'Record deleted');
        }
    }

    // ─── Update rating scale ──────────────────────────────────────────────────
    if ($action === 'update-rating-scale') {
        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        
        $id = isset($input['id']) ? (int)$input['id'] : 0;
        $minValue = isset($input['min_value']) ? (float)$input['min_value'] : null;
        $maxValue = isset($input['max_value']) ? (float)$input['max_value'] : null;
        $level = isset($input['level']) ? trim($input['level']) : '';
        $description = isset($input['description']) ? trim($input['description']) : '';
        
        if (!$id) {
            jsonError('Scale ID required');
        }
        if ($minValue === null || $maxValue === null) {
            jsonError('Min and max values required');
        }
        if (empty($level) || empty($description)) {
            jsonError('Level and description required');
        }
        
        $stmt = $pdo->prepare("
            UPDATE rating_scales 
            SET min_score = :min, max_score = :max, level_of_agreement = :level, descriptive_equivalent = :desc 
            WHERE id = :id
        ");
        $stmt->execute([
            ':min'  => $minValue,
            ':max'  => $maxValue,
            ':level' => $level,
            ':desc' => $description,
            ':id'   => $id
        ]);

        $auditSettings('settings_rating_scale_update', 'success', 'Rating scale updated | scale_id=' . $id);
        
        jsonSuccess(null, 'Rating scale updated');
    }

    // ─── Add new rating scale ─────────────────────────────────────────────────
    if ($action === 'add-rating-scale') {
        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        
        $type = isset($input['type']) ? trim($input['type']) : '';
        $minValue = isset($input['min_value']) ? (float)$input['min_value'] : null;
        $maxValue = isset($input['max_value']) ? (float)$input['max_value'] : null;
        $level = isset($input['level']) ? trim($input['level']) : '';
        $description = isset($input['description']) ? trim($input['description']) : '';
        
        if (!in_array($type, ['category', 'speaker', 'overall'])) {
            jsonError('Invalid scale type');
        }
        if ($minValue === null || $maxValue === null) {
            jsonError('Min and max values required');
        }
        if (empty($level) || empty($description)) {
            jsonError('Level and description required');
        }
        
        $stmt = $pdo->prepare("
            INSERT INTO rating_scales (scale_type, min_score, max_score, level_of_agreement, descriptive_equivalent)
            VALUES (:type, :min, :max, :level, :desc)
        ");
        $stmt->execute([
            ':type' => $type,
            ':min'  => $minValue,
            ':max'  => $maxValue,
            ':level' => $level,
            ':desc' => $description
        ]);
        
        $newId = $pdo->lastInsertId();
        $auditSettings('settings_rating_scale_add', 'success', 'Rating scale added | scale_id=' . (int)$newId . ' | type=' . $type);
        jsonSuccess(['id' => $newId], 'Rating scale added');
    }

    // ─── Delete rating scale ──────────────────────────────────────────────────
    if ($action === 'delete-rating-scale') {
        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        
        $id = isset($input['id']) ? (int)$input['id'] : 0;
        
        if (!$id) {
            jsonError('Scale ID required');
        }
        
        $stmt = $pdo->prepare("DELETE FROM rating_scales WHERE id = :id");
        $stmt->execute([':id' => $id]);
        
        if ($stmt->rowCount() === 0) {
            $auditSettings('settings_rating_scale_delete', 'failed', 'Rating scale delete failed: not found | scale_id=' . $id);
            jsonError('Rating scale not found');
        }

        $auditSettings('settings_rating_scale_delete', 'success', 'Rating scale deleted | scale_id=' . $id);
        
        jsonSuccess(null, 'Rating scale deleted');
    }

    // ─── Add supporting document ───────────────────────────────────────────────
    if ($action === 'add-supporting-document') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $docType = isset($input['doc_type']) ? trim($input['doc_type']) : 'all';
        $slug    = isset($input['slug']) ? strtolower(trim($input['slug'])) : '';
        $label   = isset($input['label']) ? trim($input['label']) : '';
        $hint    = isset($input['hint']) ? trim($input['hint']) : null;
        $icon    = isset($input['icon']) && trim($input['icon']) !== '' ? trim($input['icon']) : 'fa-file';
        $order   = isset($input['display_order']) ? (int)$input['display_order'] : 0;
        $active  = isset($input['is_active']) ? (int)!!$input['is_active'] : 1;

        if (!in_array($docType, ['all', 'tuition_increase', 'tuition_no_increase', 'school_calendar'], true)) {
            jsonError('Invalid doc type');
        }
        if (empty($label)) {
            jsonError('Label is required');
        }
        if (empty($slug) || !preg_match('/^[a-z0-9_]+$/', $slug)) {
            jsonError('Slug is required and may only contain lowercase letters, numbers, and underscores');
        }

        try {
            $stmt = $pdo->prepare("
                INSERT INTO school_supporting_documents (doc_type, slug, label, hint, icon, display_order, is_active)
                VALUES (:doc_type, :slug, :label, :hint, :icon, :order, :active)
            ");
            $stmt->execute([
                ':doc_type' => $docType,
                ':slug'     => $slug,
                ':label'    => $label,
                ':hint'     => $hint !== '' ? $hint : null,
                ':icon'     => $icon,
                ':order'    => $order,
                ':active'   => $active,
            ]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                jsonError('A supporting document with this slug already exists for this doc type');
            }
            throw $e;
        }

        $newId = $pdo->lastInsertId();
        $auditSettings('settings_supporting_document_add', 'success', 'Supporting document added | id=' . (int)$newId . ' | doc_type=' . $docType . ' | slug=' . $slug);
        jsonSuccess(['id' => $newId], 'Supporting document added');
    }

    // ─── Update supporting document ────────────────────────────────────────────
    if ($action === 'update-supporting-document') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id      = isset($input['id']) ? (int)$input['id'] : 0;
        $docType = isset($input['doc_type']) ? trim($input['doc_type']) : 'all';
        $slug    = isset($input['slug']) ? strtolower(trim($input['slug'])) : '';
        $label   = isset($input['label']) ? trim($input['label']) : '';
        $hint    = isset($input['hint']) ? trim($input['hint']) : null;
        $icon    = isset($input['icon']) && trim($input['icon']) !== '' ? trim($input['icon']) : 'fa-file';
        $order   = isset($input['display_order']) ? (int)$input['display_order'] : 0;
        $active  = isset($input['is_active']) ? (int)!!$input['is_active'] : 1;

        if (!$id) {
            jsonError('Supporting document ID required');
        }
        if (!in_array($docType, ['all', 'tuition_increase', 'tuition_no_increase', 'school_calendar'], true)) {
            jsonError('Invalid doc type');
        }
        if (empty($label)) {
            jsonError('Label is required');
        }
        if (empty($slug) || !preg_match('/^[a-z0-9_]+$/', $slug)) {
            jsonError('Slug is required and may only contain lowercase letters, numbers, and underscores');
        }

        try {
            $stmt = $pdo->prepare("
                UPDATE school_supporting_documents
                SET doc_type = :doc_type, slug = :slug, label = :label, hint = :hint,
                    icon = :icon, display_order = :order, is_active = :active
                WHERE id = :id
            ");
            $stmt->execute([
                ':doc_type' => $docType,
                ':slug'     => $slug,
                ':label'    => $label,
                ':hint'     => $hint !== '' ? $hint : null,
                ':icon'     => $icon,
                ':order'    => $order,
                ':active'   => $active,
                ':id'       => $id,
            ]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                jsonError('A supporting document with this slug already exists for this doc type');
            }
            throw $e;
        }

        $auditSettings('settings_supporting_document_update', 'success', 'Supporting document updated | id=' . $id);
        jsonSuccess(null, 'Supporting document updated');
    }

    // ─── Toggle supporting document active state ───────────────────────────────
    if ($action === 'toggle-supporting-document') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id     = isset($input['id']) ? (int)$input['id'] : 0;
        $active = isset($input['is_active']) ? (int)!!$input['is_active'] : 0;

        if (!$id) {
            jsonError('Supporting document ID required');
        }

        $stmt = $pdo->prepare("UPDATE school_supporting_documents SET is_active = :active WHERE id = :id");
        $stmt->execute([':active' => $active, ':id' => $id]);

        if ($stmt->rowCount() === 0) {
            jsonError('Supporting document not found');
        }

        $auditSettings('settings_supporting_document_toggle', 'success', 'Supporting document status changed | id=' . $id . ' | is_active=' . $active);
        jsonSuccess(null, 'Status updated');
    }

    // ─── Delete supporting document ─────────────────────────────────────────────
    if ($action === 'delete-supporting-document') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id = isset($input['id']) ? (int)$input['id'] : 0;

        if (!$id) {
            jsonError('Supporting document ID required');
        }

        $stmt = $pdo->prepare("DELETE FROM school_supporting_documents WHERE id = :id");
        $stmt->execute([':id' => $id]);

        if ($stmt->rowCount() === 0) {
            $auditSettings('settings_supporting_document_delete', 'failed', 'Supporting document delete failed: not found | id=' . $id);
            jsonError('Supporting document not found');
        }

        $auditSettings('settings_supporting_document_delete', 'success', 'Supporting document deleted | id=' . $id);
        jsonSuccess(null, 'Supporting document deleted');
    }

    // ─── Add permit checklist item ─────────────────────────────────────────────
    if ($action === 'add-permit-checklist-item') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $sectionName    = isset($input['section_name']) ? trim($input['section_name']) : '';
        $sectionOrder   = isset($input['section_order']) ? (int)$input['section_order'] : 0;
        $alwaysRequired = isset($input['always_required']) ? (int)!!$input['always_required'] : 0;
        $appTypesArr    = isset($input['app_types']) && is_array($input['app_types']) ? $input['app_types'] : [];
        $itemKey        = isset($input['item_key']) ? strtolower(trim($input['item_key'])) : '';
        $label          = isset($input['label']) ? trim($input['label']) : '';
        $itemOrder      = isset($input['item_order']) ? (int)$input['item_order'] : 0;
        $isActive       = isset($input['is_active']) ? (int)!!$input['is_active'] : 1;

        $validAppTypes = ['new_school', 'recognition', 'new_course'];
        $appTypesArr = array_values(array_intersect($validAppTypes, array_map('trim', $appTypesArr)));
        $appTypes = $alwaysRequired ? null : (implode(',', $appTypesArr) ?: null);

        if ($sectionName === '') jsonError('Section name is required');
        if ($label === '') jsonError('Label is required');
        if ($itemKey === '' || !preg_match('/^[a-z0-9_]+$/', $itemKey)) {
            jsonError('Item key is required and may only contain lowercase letters, numbers, and underscores');
        }
        if (!$alwaysRequired && empty($appTypesArr)) {
            jsonError('Select at least one application type, or mark this item "For All Applicants"');
        }

        try {
            $stmt = $pdo->prepare("
                INSERT INTO permit_checklist_items
                    (section_name, section_order, always_required, app_types, item_key, label, item_order, is_active)
                VALUES
                    (:section_name, :section_order, :always_required, :app_types, :item_key, :label, :item_order, :is_active)
            ");
            $stmt->execute([
                ':section_name'    => $sectionName,
                ':section_order'   => $sectionOrder,
                ':always_required' => $alwaysRequired,
                ':app_types'       => $appTypes,
                ':item_key'        => $itemKey,
                ':label'           => $label,
                ':item_order'      => $itemOrder,
                ':is_active'       => $isActive,
            ]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                jsonError('A checklist item with this item key already exists');
            }
            throw $e;
        }

        $newId = $pdo->lastInsertId();
        $auditSettings('settings_permit_checklist_add', 'success', 'Permit checklist item added | id=' . (int)$newId . ' | item_key=' . $itemKey);
        jsonSuccess(['id' => $newId], 'Checklist item added');
    }

    // ─── Update permit checklist item ──────────────────────────────────────────
    if ($action === 'update-permit-checklist-item') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id             = isset($input['id']) ? (int)$input['id'] : 0;
        $sectionName    = isset($input['section_name']) ? trim($input['section_name']) : '';
        $sectionOrder   = isset($input['section_order']) ? (int)$input['section_order'] : 0;
        $alwaysRequired = isset($input['always_required']) ? (int)!!$input['always_required'] : 0;
        $appTypesArr    = isset($input['app_types']) && is_array($input['app_types']) ? $input['app_types'] : [];
        $label          = isset($input['label']) ? trim($input['label']) : '';
        $itemOrder      = isset($input['item_order']) ? (int)$input['item_order'] : 0;
        $isActive       = isset($input['is_active']) ? (int)!!$input['is_active'] : 1;

        $validAppTypes = ['new_school', 'recognition', 'new_course'];
        $appTypesArr = array_values(array_intersect($validAppTypes, array_map('trim', $appTypesArr)));
        $appTypes = $alwaysRequired ? null : (implode(',', $appTypesArr) ?: null);

        if (!$id) jsonError('Checklist item ID required');
        if ($sectionName === '') jsonError('Section name is required');
        if ($label === '') jsonError('Label is required');
        if (!$alwaysRequired && empty($appTypesArr)) {
            jsonError('Select at least one application type, or mark this item "For All Applicants"');
        }

        // item_key is intentionally not editable here — existing submitted
        // applications reference requirements by item_key (see migration
        // notes in permit_checklist_items.sql), so changing it after the
        // fact would orphan historical checklist data. Retire the item with
        // is_active = 0 and add a new one instead if the key itself needs
        // to change.
        $stmt = $pdo->prepare("
            UPDATE permit_checklist_items
            SET section_name = :section_name, section_order = :section_order,
                always_required = :always_required, app_types = :app_types,
                label = :label, item_order = :item_order, is_active = :is_active
            WHERE id = :id
        ");
        $stmt->execute([
            ':section_name'    => $sectionName,
            ':section_order'   => $sectionOrder,
            ':always_required' => $alwaysRequired,
            ':app_types'       => $appTypes,
            ':label'           => $label,
            ':item_order'      => $itemOrder,
            ':is_active'       => $isActive,
            ':id'              => $id,
        ]);

        if ($stmt->rowCount() === 0) {
            $exists = $pdo->prepare("SELECT id FROM permit_checklist_items WHERE id = :id");
            $exists->execute([':id' => $id]);
            if (!$exists->fetchColumn()) jsonError('Checklist item not found', 404);
        }

        $auditSettings('settings_permit_checklist_update', 'success', 'Permit checklist item updated | id=' . $id);
        jsonSuccess(null, 'Checklist item updated');
    }

    // ─── Toggle permit checklist item active state ─────────────────────────────
    if ($action === 'toggle-permit-checklist-item') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id     = isset($input['id']) ? (int)$input['id'] : 0;
        $active = isset($input['is_active']) ? (int)!!$input['is_active'] : 0;

        if (!$id) jsonError('Checklist item ID required');

        $stmt = $pdo->prepare("UPDATE permit_checklist_items SET is_active = :active WHERE id = :id");
        $stmt->execute([':active' => $active, ':id' => $id]);

        if ($stmt->rowCount() === 0) jsonError('Checklist item not found');

        $auditSettings('settings_permit_checklist_toggle', 'success', 'Permit checklist item status changed | id=' . $id . ' | is_active=' . $active);
        jsonSuccess(null, 'Status updated');
    }

    // ─── Delete permit checklist item ──────────────────────────────────────────
    if ($action === 'delete-permit-checklist-item') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id = isset($input['id']) ? (int)$input['id'] : 0;
        if (!$id) jsonError('Checklist item ID required');

        $stmt = $pdo->prepare("DELETE FROM permit_checklist_items WHERE id = :id");
        $stmt->execute([':id' => $id]);

        if ($stmt->rowCount() === 0) {
            $auditSettings('settings_permit_checklist_delete', 'failed', 'Permit checklist item delete failed: not found | id=' . $id);
            jsonError('Checklist item not found');
        }

        $auditSettings('settings_permit_checklist_delete', 'success', 'Permit checklist item deleted | id=' . $id);
        jsonSuccess(null, 'Checklist item deleted');
    }

    // ─── Add participant role ─────────────────────────────────────────────────
    // ─── Add user role ────────────────────────────────────────────────────────
    if ($action === 'add-user-role') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $roleName    = isset($input['role_name'])           ? trim($input['role_name'])   : '';
        $description = isset($input['description'])         ? trim($input['description']) : '';
        $defaultPerms = isset($input['default_permissions']) ? $input['default_permissions'] : [];

        if (empty($roleName)) jsonError('Role name is required');

        $stmt = $pdo->prepare("SELECT id FROM user_roles WHERE role_name = :name");
        $stmt->execute([':name' => $roleName]);
        if ($stmt->fetch()) jsonError('A role with this name already exists');

        $stmt = $pdo->prepare("
            INSERT INTO user_roles (role_name, description, default_permissions)
            VALUES (:name, :desc, :perms)
        ");
        $stmt->execute([
            ':name'  => $roleName,
            ':desc'  => $description,
            ':perms' => json_encode($defaultPerms)
        ]);

        $newRoleId = (int)$pdo->lastInsertId();
        $auditSettings('settings_user_role_add', 'success', 'User role added | role_id=' . $newRoleId . ' | role_name=' . $roleName);

        jsonSuccess(['id' => $newRoleId], 'User role added');
    }

    // ─── Update user role ─────────────────────────────────────────────────────
    if ($action === 'update-user-role') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id          = isset($input['id'])                  ? (int)$input['id']           : 0;
        $roleName    = isset($input['role_name'])           ? trim($input['role_name'])   : '';
        $description = isset($input['description'])         ? trim($input['description']) : '';
        $defaultPerms = isset($input['default_permissions']) ? $input['default_permissions'] : [];

        if (!$id)           jsonError('Role ID required');
        if (empty($roleName)) jsonError('Role name is required');
        if (!is_array($defaultPerms)) jsonError('Default permissions must be an array');

        $existingStmt = $pdo->prepare("SELECT role_name FROM user_roles WHERE id = :id");
        $existingStmt->execute([':id' => $id]);
        $existingRole = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!$existingRole) {
            jsonError('User role not found', 404);
        }
        $oldRoleName = (string)($existingRole['role_name'] ?? '');

        $stmt = $pdo->prepare("SELECT id FROM user_roles WHERE role_name = :name AND id != :id");
        $stmt->execute([':name' => $roleName, ':id' => $id]);
        if ($stmt->fetch()) jsonError('A role with this name already exists');

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("
                UPDATE user_roles
                SET role_name = :name, description = :desc, default_permissions = :perms
                WHERE id = :id
            ");
            $stmt->execute([
                ':name'  => $roleName,
                ':desc'  => $description,
                ':perms' => json_encode($defaultPerms),
                ':id'    => $id
            ]);
            if ($oldRoleName !== '' && $oldRoleName !== $roleName) {
                $renameStmt = $pdo->prepare("UPDATE users SET role = :new_role WHERE role = :old_role");
                $renameStmt->execute([':new_role' => $roleName, ':old_role' => $oldRoleName]);
            }

            $syncStmt = $pdo->prepare("UPDATE users SET permissions = :perms WHERE role = :role");
            $syncStmt->execute([
                ':perms' => json_encode($defaultPerms),
                ':role'  => $roleName
            ]);

            $pdo->commit();
        } catch (Exception $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            jsonError('Failed to update user role', 500);
        }
        
        $auditSettings('settings_user_role_update', 'success', 'User role updated | role_id=' . $id . ' | role_name=' . $roleName);

        jsonSuccess(null, 'User role updated');
    }

    // ─── Delete user role ─────────────────────────────────────────────────────
    if ($action === 'delete-user-role') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }

        $id = isset($input['id']) ? (int)$input['id'] : 0;
        if (!$id) jsonError('Role ID required');

        $stmt = $pdo->prepare("DELETE FROM user_roles WHERE id = :id");
        $stmt->execute([':id' => $id]);

        if ($stmt->rowCount() === 0) {
            $auditSettings('settings_user_role_delete', 'failed', 'User role delete failed: not found | role_id=' . $id);
            jsonError('User role not found');
        }

        $auditSettings('settings_user_role_delete', 'success', 'User role deleted | role_id=' . $id);

        jsonSuccess(null, 'User role deleted');
    }

    // ─── Update signatories ───────────────────────────────────────────────────
    if ($action === 'update-signatories') {
        // SECURITY: Require 'settings' permission
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        
        $settingName = isset($input['setting_name']) ? trim($input['setting_name']) : 'default';
        
        // Check if record exists
        $stmt = $pdo->prepare("SELECT id FROM report_signatories WHERE setting_name = :name");
        $stmt->execute([':name' => $settingName]);
        $exists = $stmt->fetch();
        
        if ($exists) {
            // Update existing
            $stmt = $pdo->prepare("
                UPDATE report_signatories SET
                    org_country = :org_country,
                    org_department = :org_department,
                    org_division = :org_division,
                    org_section = :org_section,
                    org_unit = :org_unit,
                    prepared_name = :prepared_name,
                    prepared_title = :prepared_title,
                    checked_name = :checked_name,
                    checked_title = :checked_title,
                    noted1_name = :noted1_name,
                    noted1_title = :noted1_title,
                    noted2_name = :noted2_name,
                    noted2_title = :noted2_title,
                    noted3_name = :noted3_name,
                    noted3_title = :noted3_title
                WHERE setting_name = :name
            ");
        } else {
            // Insert new
            $stmt = $pdo->prepare("
                INSERT INTO report_signatories (
                    setting_name, org_country, org_department, org_division, org_section, org_unit,
                    prepared_name, prepared_title, checked_name, checked_title,
                    noted1_name, noted1_title, noted2_name, noted2_title, noted3_name, noted3_title
                ) VALUES (
                    :name, :org_country, :org_department, :org_division, :org_section, :org_unit,
                    :prepared_name, :prepared_title, :checked_name, :checked_title,
                    :noted1_name, :noted1_title, :noted2_name, :noted2_title, :noted3_name, :noted3_title
                )
            ");
        }
        
        $stmt->execute([
            ':name' => $settingName,
            ':org_country' => $input['org_country'] ?? 'Republic of the Philippines',
            ':org_department' => $input['org_department'] ?? 'Department of Education',
            ':org_division' => $input['org_division'] ?? '',
            ':org_section' => $input['org_section'] ?? '',
            ':org_unit' => $input['org_unit'] ?? '',
            ':prepared_name' => $input['prepared_name'] ?? '',
            ':prepared_title' => $input['prepared_title'] ?? '',
            ':checked_name' => $input['checked_name'] ?? '',
            ':checked_title' => $input['checked_title'] ?? '',
            ':noted1_name' => $input['noted1_name'] ?? '',
            ':noted1_title' => $input['noted1_title'] ?? '',
            ':noted2_name' => $input['noted2_name'] ?? '',
            ':noted2_title' => $input['noted2_title'] ?? '',
            ':noted3_name' => $input['noted3_name'] ?? '',
            ':noted3_title' => $input['noted3_title'] ?? ''
        ]);

        $auditSettings('settings_signatories_update', 'success', 'Report signatories updated | setting_name=' . $settingName);
        
        jsonSuccess(null, 'Signatories updated');
    }


    // ─── Contact Info POST (save) ──────────────────────────────────────
    if ($action === 'contact-info') {
        if (!hasPermission('settings', $user)) {
            jsonError('Access denied. You do not have permission to perform this action.', 403);
        }
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
        $payload = json_encode([
            'address' => trim($input['address'] ?? ''),
            'email'   => trim($input['email'] ?? ''),
            'phone'   => trim($input['phone'] ?? ''),
            'hours'   => trim($input['hours'] ?? '')
        ]);
        $pdo->prepare("
            INSERT INTO system_settings (setting_key, setting_value)
            VALUES ('contact_info', :val)
            ON DUPLICATE KEY UPDATE setting_value = :val2
        ")->execute([':val' => $payload, ':val2' => $payload]);
        $auditSettings('contact_info_update', 'success', 'Contact Us info updated');
        jsonSuccess(null, 'Contact info saved');
    }

    jsonError('Unknown action');

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);

} catch (Exception $e) {
    jsonError('Server error: ' . $e->getMessage(), 500);
}