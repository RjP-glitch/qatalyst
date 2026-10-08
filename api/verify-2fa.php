<?php
/**
 * Verify 2FA Code API Endpoint
 * POST /api/verify-2fa.php
 *
 * Body: { "temp_token": "...", "code": "123456" }
 * On success → creates a real login_session and returns session_token.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$base_path = dirname(__DIR__);
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/audit_log.php';

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

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $input = json_decode(file_get_contents('php://input'), true);
    $temp_token = isset($input['temp_token']) ? trim($input['temp_token']) : '';
    $code       = isset($input['code']) ? trim($input['code']) : '';

    // Allow resend with empty code
    $action = isset($input['action']) ? $input['action'] : '';
    if (empty($temp_token) || (empty($code) && $action !== 'resend')) {
        jsonError('Verification code is required');
    }

    $db = getDB();
    auditEnsureTable($db);

    // ---- action: resend ----
    if ($action === 'resend') {
        // Look up the latest code row for this temp_token (even if used/expired)
        $stmt = $db->prepare("
            SELECT tfc.user_id, u.email, u.full_name
            FROM two_factor_codes tfc
            INNER JOIN users u ON u.id = tfc.user_id
            WHERE tfc.temp_token = :token
            ORDER BY tfc.created_at DESC LIMIT 1
        ");
        $stmt->execute([':token' => $temp_token]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            auditLog([
                'pdo' => $db,
                'role' => 'unknown',
                'action' => '2fa_resend',
                'module' => 'auth',
                'status' => 'failed',
                'description' => '2FA resend attempted with invalid or expired temp token',
            ]);
            jsonError('Invalid session. Please log in again.', 401);
        }

        // Generate new code
        $new_code = str_pad(random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expires  = date('Y-m-d H:i:s', strtotime('+10 minutes'));

        // Invalidate old codes for this token
        $db->prepare("UPDATE two_factor_codes SET is_used = 1 WHERE temp_token = :token")
           ->execute([':token' => $temp_token]);

        // Insert fresh code with same temp_token
        $stmt = $db->prepare("
            INSERT INTO two_factor_codes (user_id, code, temp_token, expires_at)
            VALUES (:uid, :code, :token, :exp)
        ");
        $stmt->execute([
            ':uid'   => $row['user_id'],
            ':code'  => $new_code,
            ':token' => $temp_token,
            ':exp'   => $expires
        ]);

        // Send email
        require_once $base_path . '/helpers/EmailHelper.php';
        $emailHelper = new EmailHelper();
        $emailHelper->sendVerificationCode($row['email'], $new_code, $row['full_name'] ?? 'User');

        auditLog([
            'pdo' => $db,
            'user_id' => (int)$row['user_id'],
            'role' => 'viewer',
            'action' => '2fa_resend',
            'module' => 'auth',
            'status' => 'success',
            'description' => '2FA verification code resent',
        ]);

        jsonSuccess(null, 'A new verification code has been sent to your email');
    }

    // ---- action: verify code ----
    // Find the code row
    $stmt = $db->prepare("
        SELECT tfc.*, u.email, u.full_name, u.email_verified, u.status, u.role
        FROM two_factor_codes tfc
        INNER JOIN users u ON u.id = tfc.user_id
        WHERE tfc.temp_token = :token AND tfc.is_used = 0
        ORDER BY tfc.created_at DESC LIMIT 1
    ");
    $stmt->execute([':token' => $temp_token]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        auditLog([
            'pdo' => $db,
            'role' => 'unknown',
            'action' => '2fa_verify',
            'module' => 'auth',
            'status' => 'failed',
            'description' => '2FA verify attempted with invalid or expired temp token',
        ]);
        jsonError('Invalid or expired verification session. Please log in again.', 401);
    }

    // Check max attempts (5)
    if ($row['attempts'] >= 5) {
        // Mark used so user must log in again
        $db->prepare("UPDATE two_factor_codes SET is_used = 1 WHERE id = :id")
           ->execute([':id' => $row['id']]);
        auditLog([
            'pdo' => $db,
            'user_id' => (int)$row['user_id'],
            'role' => (string)($row['role'] ?? 'viewer'),
            'action' => '2fa_verify',
            'module' => 'auth',
            'status' => 'failed',
            'description' => '2FA verify blocked due to max attempts reached',
        ]);
        jsonError('Too many attempts. Please log in again.', 429);
    }

    // Increment attempts
    $db->prepare("UPDATE two_factor_codes SET attempts = attempts + 1 WHERE id = :id")
       ->execute([':id' => $row['id']]);

    // Check expiry
    if (strtotime($row['expires_at']) < time()) {
        auditLog([
            'pdo' => $db,
            'user_id' => (int)$row['user_id'],
            'role' => (string)($row['role'] ?? 'viewer'),
            'action' => '2fa_verify',
            'module' => 'auth',
            'status' => 'failed',
            'description' => '2FA verify failed because code expired',
        ]);
        jsonError('Verification code has expired. Click "Resend Code" to get a new one.');
    }

    // Check code
    if ($row['code'] !== $code) {
        $remaining = 4 - $row['attempts']; // already incremented
        auditLog([
            'pdo' => $db,
            'user_id' => (int)$row['user_id'],
            'role' => (string)($row['role'] ?? 'viewer'),
            'action' => '2fa_verify',
            'module' => 'auth',
            'status' => 'failed',
            'description' => '2FA verify failed due to incorrect code',
        ]);
        jsonError("Invalid code. $remaining attempt(s) remaining.");
    }

    // ---- Code is correct — mark used, create session ----
    $db->prepare("UPDATE two_factor_codes SET is_used = 1 WHERE id = :id")
       ->execute([':id' => $row['id']]);

    // If email is not verified, issue a short-lived verify_token so the client
    // can complete email verification after 2FA.
    $verify_token = null;
    if (!(bool)$row['email_verified']) {
        $verify_token   = bin2hex(random_bytes(16));
        $verify_expires = date('Y-m-d H:i:s', strtotime('+15 minutes'));
        $db->prepare("UPDATE users SET verify_token = :token, verify_token_expires = :exp WHERE id = :id")
           ->execute([
               ':token' => $verify_token,
               ':exp'   => $verify_expires,
               ':id'    => (int)$row['user_id'],
           ]);
    }

    // Create real session
    $session_token = bin2hex(random_bytes(50));
    $ip_address    = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $user_agent    = $_SERVER['HTTP_USER_AGENT'] ?? 'unknown';
    $expires_at    = date('Y-m-d H:i:s', strtotime('+24 hours'));

    $stmt = $db->prepare("
        INSERT INTO login_sessions (user_id, session_token, ip_address, user_agent, expires_at)
        VALUES (:uid, :token, :ip, :ua, :exp)
    ");
    $stmt->execute([
        ':uid'   => $row['user_id'],
        ':token' => $session_token,
        ':ip'    => $ip_address,
        ':ua'    => $user_agent,
        ':exp'   => $expires_at
    ]);

    // SECURITY: Set session token as HttpOnly cookie
    $is_secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    setcookie('session_token', $session_token, [
        'expires'  => strtotime('+24 hours'),
        'path'     => '/',
        'secure'   => $is_secure,
        'httponly' => true,
        'samesite' => 'Strict'
    ]);

    auditLog([
        'pdo' => $db,
        'user_id' => (int)$row['user_id'],
        'role' => (string)($row['role'] ?? 'viewer'),
        'action' => '2fa_verify',
        'module' => 'auth',
        'status' => 'success',
        'description' => '2FA verified and login session created',
    ]);

    jsonSuccess([
        'user_id'        => (int)$row['user_id'],
        'email'          => $row['email'],
        'full_name'      => $row['full_name'] ?? 'User',
        'email_verified' => (bool)$row['email_verified'],
        'role'           => $row['role'] ?? 'viewer',
        'verify_token'   => $verify_token,
        'session_token'  => $session_token,
        'expires_at'     => $expires_at
    ], 'Verification successful');

} catch (Exception $e) {
    error_log('2FA Error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    jsonError('Server error: ' . $e->getMessage(), 500);
}
