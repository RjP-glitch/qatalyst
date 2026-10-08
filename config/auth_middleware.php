<?php
require_once __DIR__ . '/school_portal.php';
/**
 * Authenticate the current request.
 *
 * @param string|null $requiredAccountType Optional. If set (e.g. 'portal_user'),
 *        authentication fails (returns false) unless the resolved user's
 *        account_type matches. Otherwise the endpoint filename determines
 *        whether this is a school portal or SDO request. Cookies never cross
 *        application boundaries and portal accounts require verified email.
 */
function authenticate($requiredAccountType = null) {
    $pdo = getDB();

    $isPortalRequest = (function (): bool {
        $script = basename($_SERVER['SCRIPT_NAME'] ?? ($_SERVER['PHP_SELF'] ?? ''));
        if ($script && strpos($script, 'school-portal-') === 0) return true;
        if ($script === 'school-login.php') return true;

        return false;
    })();

    // The endpoint, never a client-supplied header, defines the account boundary.
    $requiredAccountType = $requiredAccountType ?? ($isPortalRequest ? 'portal_user' : 'sdo_personnel');
    $isPortalRequest = $requiredAccountType === 'portal_user';
    
    // SECURITY: Check HttpOnly cookie first (preferred), then Authorization header as fallback
    $session_token = '';
    
    // Each endpoint accepts only its application's cookie, with no cross-app fallback.
    if ($isPortalRequest) {
        // 1. Try school portal HttpOnly cookie (set by school-login.php)
        if (!empty($_COOKIE['school_session_token'])) {
            $session_token = $_COOKIE['school_session_token'];
        }
    } else {
        // 1. Try SDO HttpOnly cookie (set by login.php)
        if (!empty($_COOKIE['session_token'])) {
            $session_token = $_COOKIE['session_token'];
        }
    }

    // 3. Fallback to Authorization header (for API clients, mobile apps, etc.)
    if (empty($session_token)) {
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $session_token = $headers['Authorization']
            ?? $headers['authorization']
            ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? '');

        // Strip a leading "Bearer " scheme prefix, if present, so standard
        // `Authorization: Bearer <token>` clients match against the raw
        // token stored in login_sessions.session_token instead of failing
        // to match every time.
        if (!empty($session_token)) {
            $session_token = trim(preg_replace('/^Bearer\s+/i', '', trim($session_token)));
        }
    }
    
    if (empty($session_token)) {
        return false;
    }
    
    try {
        $stmt = $pdo->prepare("
            SELECT u.* 
            FROM users u
            INNER JOIN login_sessions ls ON u.id = ls.user_id
            WHERE ls.session_token = ? 
            AND ls.expires_at > NOW()
            AND u.status = 'active'
        ");
        
        $stmt->execute([$session_token]);
        $user = $stmt->fetch();

        if (!$user) return false;

        // If the caller specified a required account type, enforce it here
        // rather than leaving every endpoint responsible for remembering to
        // check it after the fact.
        if ($requiredAccountType !== null) {
            $actualType = $user['account_type'] ?? null;
            if ($actualType !== $requiredAccountType) {
                return false;
            }
        }

        if ($requiredAccountType === 'portal_user') {
            if (empty($user['email_verified'])) return false;
            // Legacy school administrator records never inherit an SDO role.
            $user['role'] = 'teacher';
        }
        return $user;
        
    } catch (Exception $e) {
        return false;
    }
}

/**
 * Check if authenticated user has a specific permission
 * @param string $permission Permission key to check
 * @param array|bool $user User array (from authenticate()) or false
 * @return bool True if user has permission
 */
function hasPermission($permission, $user) {
    if (!$user) return false;

    // SDO permissions never apply to school accounts, even legacy admin records.
    if (($user['account_type'] ?? '') !== 'sdo_personnel') return false;
    // Only an SDO administrator has unrestricted SDO permissions.
    $role = $user['role'] ?? 'viewer';
    if ($role === 'admin') return true;

    // Check user's explicit permissions first
    $permissions = json_decode($user['permissions'] ?? '[]', true);
    if (is_array($permissions) && count($permissions) > 0) {
        return in_array($permission, $permissions);
    }

    // No explicit permissions set — fall back to user_roles table defaults
    try {
        $pdo = getDB();
        $stmt = $pdo->prepare("SELECT default_permissions FROM user_roles WHERE role_name = :role LIMIT 1");
        $stmt->execute([':role' => $role]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row && !empty($row['default_permissions'])) {
            $defaults = json_decode($row['default_permissions'], true);
            if (is_array($defaults)) {
                return in_array($permission, $defaults);
            }
        }
    } catch (Exception $e) {
        // DB error — deny by default
    }

    return false;
}

/**
 * Require specific permission or return 403 error
 * @param string $permission Permission key required
 * @param array|bool $user User array (from authenticate()) or false
 */
function requirePermission($permission, $user) {
    if (!hasPermission($permission, $user)) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Access denied. You do not have permission to perform this action.'
        ]);
        exit;
    }
}
?>
