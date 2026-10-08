<?php
/**
 * User Management API Endpoint
 * 
 * GET    /user_management.php                        → List all users
 * GET    /user_management.php?action=get_roles        → List distinct roles
 * POST   /user_management.php?action=create           → Create user
 * POST   /user_management.php?action=update&id=X      → Update user
 * POST   /user_management.php?action=delete&id=X      → Delete user
 * POST   /user_management.php?action=reset_password&id=X → Reset password
 * POST   /user_management.php?action=toggle_status&id=X  → Activate/Deactivate
 */

error_reporting(0);
ini_set('display_errors', 0);

if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';
require_once $base_path . '/config/audit_log.php';
require_once $base_path . '/models/User.php';

// ---------- helpers ----------
function jsonSuccess($data, $msg = 'Success') {
    ob_end_clean();
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

// ---------- role hierarchy ----------
/**
 * SECURITY: Enforce role hierarchy for write operations.
 * - Only admins can create/modify admin accounts.
 * - Non-admin users cannot modify their own role or permissions.
 */
function enforceRoleHierarchy($authUser, $targetRole = null, $targetId = null, $changingPerms = false) {
    $authRole = $authUser['role'] ?? 'viewer';
    $isAdmin  = ($authRole === 'admin');

    // Only admins can assign or target the admin role
    if ($targetRole === 'admin' && !$isAdmin) {
        jsonError('Only administrators can create or modify admin accounts', 403);
    }

    // When targeting an existing user, check if that user is currently an admin
    if ($targetId) {
        global $db;
        $chk = $db->prepare("SELECT role FROM users WHERE id = :id LIMIT 1");
        $chk->execute([':id' => $targetId]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if ($existing && $existing['role'] === 'admin' && !$isAdmin) {
            jsonError('Only administrators can modify admin accounts', 403);
        }
    }

    // Non-admins cannot modify their own role or permissions (prevents self-escalation)
    if ($targetId && intval($targetId) === intval($authUser['id']) && !$isAdmin) {
        if ($targetRole || $changingPerms) {
            jsonError('You cannot modify your own role or permissions', 403);
        }
    }
}

// ---------- auth ----------
function getAuthUser($db) {
    $user = authenticate('sdo_personnel');
    if (!$user) jsonError('Unauthorized', 401);
    return $user;
}

// ---------- routing ----------
$action = isset($_GET['action']) ? $_GET['action'] : '';
$targetId = isset($_GET['id']) ? intval($_GET['id']) : 0;

try {
    $db = getDB();
    $authUser = getAuthUser($db);
    auditEnsureTable($db);

    $auditUserMgmt = static function ($actionName, $status, $description, $targetUserId = null, $targetRole = null) use ($db, $authUser): void {
        $suffix = '';
        if ($targetUserId !== null) {
            $suffix .= ' | target_user_id=' . (int)$targetUserId;
        }
        if ($targetRole !== null && $targetRole !== '') {
            $suffix .= ' | target_role=' . (string)$targetRole;
        }

        auditLog([
            'pdo' => $db,
            'user_id' => (int)$authUser['id'],
            'role' => (string)($authUser['role'] ?? 'viewer'),
            'action' => (string)$actionName,
            'module' => 'user_management',
            'status' => (string)$status,
            'description' => (string)$description . $suffix,
        ]);
    };

    // ===== GET — List distinct roles =====
    // Any authenticated user can read role presets (needed for permission system init)
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'get_roles') {
        $stmt = $db->query("SELECT role_name, description, default_permissions FROM user_roles ORDER BY role_name ASC");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            $row['default_permissions'] = $row['default_permissions']
                ? json_decode($row['default_permissions'], true)
                : [];
        }
        jsonSuccess($rows);
    }

    // Require 'users' permission for all other user management actions
    requirePermission('users', $authUser);

    // ===== GET — List users =====
    // ?type=portal  → school portal users (portal_user)
    // ?type=sdo     → SDO personnel (sdo_personnel) [default]
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === '') {
        $type = isset($_GET['type']) && $_GET['type'] === 'portal' ? 'portal_user' : 'sdo_personnel';
        $stmt = $db->prepare("
            SELECT u.id, u.email, u.full_name, u.status, u.email_verified,
                   u.created_at, u.role, u.permissions, u.profile_picture,
                   u.account_type, u.school_id, u.private_school_id, u.school_type, u.district_id,
                   CASE WHEN u.school_type = 'private' THEN pvs.name ELSE ps.school_name END AS school_name,
                   d.name AS district_name,
                   (SELECT MAX(ls.created_at) FROM login_sessions ls WHERE ls.user_id = u.id) AS last_login
            FROM users u
            LEFT JOIN public_schools ps ON ps.id = u.school_id AND u.school_type = 'public'
            LEFT JOIN private_schools pvs ON pvs.id = u.private_school_id AND u.school_type = 'private'
            LEFT JOIN districts d ON d.id = u.district_id
            WHERE u.account_type = :account_type
            ORDER BY u.created_at DESC
        ");
        $stmt->execute([':account_type' => $type]);
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Ensure role & permissions have defaults
        foreach ($users as &$u) {
            if ($u['account_type'] === 'portal_user') {
                $u['school_approved'] = portalSchoolIsApproved($u) && (bool)portalResolveSchool($db, $u);
                $u['role'] = 'teacher';
            }
            if (empty($u['role'])) $u['role'] = 'viewer';
                if (empty($u['permissions'])) {
                    $u['permissions'] = [];
                } else {
                    // Try to decode permissions, fallback to empty array if invalid
                    $decoded = json_decode($u['permissions'], true);
                    $u['permissions'] = is_array($decoded) ? $decoded : [];
                }
        }
        unset($u);

        jsonSuccess($users);
    }

    // SECURITY: Role hierarchy is enforced per-action via enforceRoleHierarchy().
    // Non-admin users with 'users' permission can manage non-admin accounts only.

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) jsonError('Invalid JSON request.', 422);

    // Approval grants only school access, never an SDO role or permission.
    if ($action === 'approve_school') {
        if (!$targetId || !isset($input['approved']) || !is_bool($input['approved'])) jsonError('User ID and approval choice are required.', 422);
        $db->beginTransaction();
        try {
            $stmt = $db->prepare("SELECT * FROM users WHERE id = ? AND account_type = 'portal_user' FOR UPDATE");
            $stmt->execute([$targetId]);
            $target = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$target) throw new DomainException('School user not found.');
            $approved = $input['approved'];
            if ($approved && ($target['status'] !== 'active' || empty($target['email_verified']) || !portalResolveSchool($db, $target, true))) {
                throw new DomainException('Approval requires a verified, active account linked to an active school.');
            }
            $perms = $approved ? ['dashboard', SCHOOL_ACCESS_PERMISSION] : ['dashboard'];
            $db->prepare("UPDATE users SET role = 'teacher', permissions = ?, updated_at = NOW() WHERE id = ? AND account_type = 'portal_user'")->execute([json_encode($perms), $targetId]);
            $db->commit();
        } catch (DomainException $e) {
            if ($db->inTransaction()) $db->rollBack();
            jsonError($e->getMessage(), 422);
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            throw $e;
        }
        $auditUserMgmt($approved ? 'approve_school_access' : 'revoke_school_access', 'success', $approved ? 'Approved school affiliation and school record access' : 'Revoked school access', $targetId, 'teacher');
        jsonSuccess(['school_approved' => $approved], $approved ? 'School access approved.' : 'School access revoked.');
    }

    // ===== CREATE =====
    if ($action === 'create') {
        $fullName = isset($input['full_name']) ? trim($input['full_name']) : '';
        $email    = isset($input['email']) ? trim($input['email']) : '';
        $password = isset($input['password']) ? $input['password'] : '';
        $role     = isset($input['role']) ? $input['role'] : 'viewer';
        $status   = isset($input['status']) ? $input['status'] : 'active';
        $perms    = isset($input['permissions']) ? $input['permissions'] : [];

        // SECURITY: Role hierarchy — only admins can create admin accounts
        enforceRoleHierarchy($authUser, $role);
        // Stricter validation for permissions
        if (!is_array($perms)) {
            // Try to decode if string
            if (is_string($perms)) {
                $decoded = json_decode($perms, true);
                if (is_array($decoded)) {
                    $perms = $decoded;
                } else {
                    jsonError('Permissions must be an array or valid JSON array');
                }
            } else {
                jsonError('Permissions must be an array');
            }
        }

        if (!$fullName || !$email || !$password) {
            jsonError('Full name, email and password are required');
        }
        if (empty($role)) {
            jsonError('Please select a role');
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            jsonError('Invalid email format');
        }
        if (strlen($password) < 8) {
            jsonError('Password must be at least 8 characters');
        }

        // Check duplicate
        $chk = $db->prepare("SELECT id FROM users WHERE email = :e LIMIT 1");
        $chk->execute([':e' => $email]);
        if ($chk->fetch()) jsonError('Email already exists');

        try {
            $hashed = password_hash($password, PASSWORD_BCRYPT);
            $permsJson = json_encode($perms);
            $now = date('Y-m-d H:i:s');

            $stmt = $db->prepare("
                INSERT INTO users (email, password, full_name, status, email_verified, role, permissions, created_at)
                VALUES (:email, :password, :full_name, :status, 0, :role, :permissions, :created_at)
            ");
            $stmt->execute([
                ':email'       => $email,
                ':password'    => $hashed,
                ':full_name'   => $fullName,
                ':status'      => $status,
                ':role'        => $role,
                ':permissions' => $permsJson,
                ':created_at'  => $now
            ]);

            $createdId = (int)$db->lastInsertId();

            // ── Email the new account's login credentials ───────────────
            // Verification of the email itself still happens at first
            // login (unchanged) — this just lets the user know their
            // account exists and how to log in.
            $emailSent = false;
            try {
                require_once $base_path . '/helpers/EmailHelper.php';
                $emailHelper = new EmailHelper();
                $emailSent = $emailHelper->sendAccountCredentials($email, $fullName, $password);
            } catch (Throwable $mailEx) {
                // Don't fail account creation if the email couldn't be sent —
                // the admin can still relay credentials manually. Just log it.
                error_log('user_management.php create: credentials email failed: ' . $mailEx->getMessage());
            }

            $auditUserMgmt(
                'user_create',
                'success',
                'User account created' . ($emailSent ? ' | credentials email sent' : ' | credentials email NOT sent'),
                $createdId,
                $role
            );

            $msg = $emailSent
                ? 'User created successfully — login credentials have been sent to their email'
                : 'User created successfully, but the credentials email could not be sent';

            jsonSuccess(['id' => $createdId, 'email_sent' => $emailSent], $msg);
        } catch (Exception $ex) {
            jsonError('Server error: ' . $ex->getMessage(), 500);
        }
    }

    // ===== UPDATE =====
    if ($action === 'update') {
        if (!$targetId) jsonError('User ID is required');

        $fullName = isset($input['full_name']) ? trim($input['full_name']) : '';
        $email    = isset($input['email']) ? trim($input['email']) : '';
        $role     = isset($input['role']) ? $input['role'] : '';
        $status   = isset($input['status']) ? $input['status'] : '';
        $perms    = isset($input['permissions']) ? $input['permissions'] : null;

        // SECURITY: Role hierarchy — only admins can modify admin accounts or assign admin role
        enforceRoleHierarchy($authUser, $role ?: null, $targetId, $perms !== null);

        // Check target exists
        $chk = $db->prepare("SELECT id, email, account_type FROM users WHERE id = :id LIMIT 1");
        $chk->execute([':id' => $targetId]);
        $existing = $chk->fetch();
        if (!$existing) jsonError('User not found', 404);
        if ($existing['account_type'] === 'portal_user' && ($role !== '' || $perms !== null)) {
            jsonError('School roles and permissions are managed through Approve school access.', 422);
        }

        // Check email uniqueness if changed
        if ($email && $email !== $existing['email']) {
            $dup = $db->prepare("SELECT id FROM users WHERE email = :e AND id != :id LIMIT 1");
            $dup->execute([':e' => $email, ':id' => $targetId]);
            if ($dup->fetch()) jsonError('Email already in use by another user');
        }

        $sets = [];
        $changedFields = [];
        $params = [':id' => $targetId];

        if ($fullName) { $sets[] = "full_name = :fn"; $params[':fn'] = $fullName; $changedFields[] = 'full_name'; }
        if ($email)    { $sets[] = "email = :em";     $params[':em'] = $email; $changedFields[] = 'email'; }
        if ($role)     { $sets[] = "role = :rl";      $params[':rl'] = $role; $changedFields[] = 'role'; }
        if ($status)   { $sets[] = "status = :st";    $params[':st'] = $status; $changedFields[] = 'status'; }
        if ($perms !== null) { $sets[] = "permissions = :pm"; $params[':pm'] = json_encode($perms); $changedFields[] = 'permissions'; }

        if (empty($sets)) jsonError('Nothing to update');

        $sql = "UPDATE users SET " . implode(', ', $sets) . " WHERE id = :id";
        $db->prepare($sql)->execute($params);

        $auditUserMgmt(
            'user_update',
            'success',
            'User account updated | fields=' . implode(',', $changedFields),
            $targetId,
            $role ?: null
        );

        jsonSuccess(null, 'User updated successfully');
    }

    // ===== RESET PASSWORD =====
    if ($action === 'reset_password') {
        if (!$targetId) jsonError('User ID is required');
        $newPw = isset($input['new_password']) ? $input['new_password'] : '';
        if (strlen($newPw) < 8) jsonError('Password must be at least 8 characters');

        $hashed = password_hash($newPw, PASSWORD_BCRYPT);
        $stmt = $db->prepare("UPDATE users SET password = :pw WHERE id = :id");
        $stmt->execute([':pw' => $hashed, ':id' => $targetId]);

        if ($stmt->rowCount() === 0) {
            $auditUserMgmt('user_reset_password', 'failed', 'Password reset failed: user not found', $targetId);
            jsonError('User not found', 404);
        }

        $auditUserMgmt('user_reset_password', 'success', 'User password reset by manager', $targetId);
        jsonSuccess(null, 'Password reset successfully');
    }

    // ===== TOGGLE STATUS =====
    if ($action === 'toggle_status') {
        if (!$targetId) jsonError('User ID is required');
        $newStatus = isset($input['status']) ? $input['status'] : '';
        if (!in_array($newStatus, ['active', 'inactive'])) jsonError('Invalid status');

        $stmt = $db->prepare("UPDATE users SET status = :st WHERE id = :id");
        $stmt->execute([':st' => $newStatus, ':id' => $targetId]);

        if ($stmt->rowCount() === 0) {
            $auditUserMgmt('user_toggle_status', 'failed', 'Status change failed: user not found', $targetId);
            jsonError('User not found', 404);
        }

        $auditUserMgmt('user_toggle_status', 'success', 'User status changed to ' . $newStatus, $targetId);
        jsonSuccess(null, "User {$newStatus}d successfully");
    }

    // ===== DELETE =====
    if ($action === 'delete') {
        if (!$targetId) jsonError('User ID is required');

        // Prevent deleting yourself
        if ($targetId == $authUser['id']) {
            $auditUserMgmt('user_delete', 'failed', 'Delete blocked: attempted self-delete', $targetId);
            jsonError('You cannot delete your own account');
        }

        $targetRole = null;
        $roleStmt = $db->prepare("SELECT role FROM users WHERE id = :id LIMIT 1");
        $roleStmt->execute([':id' => $targetId]);
        $targetRoleRow = $roleStmt->fetch(PDO::FETCH_ASSOC);
        if ($targetRoleRow) {
            $targetRole = $targetRoleRow['role'];
        }

        // Delete sessions first
        $db->prepare("DELETE FROM login_sessions WHERE user_id = :id")->execute([':id' => $targetId]);
        // Delete user
        $stmt = $db->prepare("DELETE FROM users WHERE id = :id");
        $stmt->execute([':id' => $targetId]);

        if ($stmt->rowCount() === 0) {
            $auditUserMgmt('user_delete', 'failed', 'Delete failed: user not found', $targetId);
            jsonError('User not found', 404);
        }

        $auditUserMgmt('user_delete', 'success', 'User account deleted', $targetId, $targetRole);
        jsonSuccess(null, 'User deleted successfully');
    }

    jsonError('Unknown action');

} catch (Exception $e) {
    jsonError('Server error', 500);
}
