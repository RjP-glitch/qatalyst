<?php
/**
 * SDO Email Verification
 * POST /api/verify-email.php
 *
 * Mode 1 — Resend code: { "token": "...", "action": "resend" }
 * Mode 2 — Verify code:  { "token": "...", "code": "123456" }
 *
 * Notes:
 * - Uses users.verify_token issued by api/login.php / api/verify-2fa.php
 * - Restricted to account_type = 'sdo_personnel' (School Portal uses a separate flow)
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

header('Content-Type: application/json; charset=utf-8');

$base_path = dirname(__DIR__);
require_once $base_path . '/config/database.php';

// Debug output is gated to avoid leaking internals in production.
// Enable locally via .env: APP_DEBUG=true (or DEBUG_MODE=true).
$DEBUG_MODE = false;
try {
    $rawDebug = $_ENV['APP_DEBUG'] ?? ($_ENV['DEBUG_MODE'] ?? 'false');
    $DEBUG_MODE = filter_var($rawDebug, FILTER_VALIDATE_BOOLEAN);
} catch (Throwable $_) {
    $DEBUG_MODE = false;
}

set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

register_shutdown_function(function () use (&$DEBUG_MODE) {
    $err = error_get_last();
    if (!$err) return;

    $fatalTypes = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR];
    if (!in_array($err['type'], $fatalTypes, true)) return;

    if (ob_get_level()) { ob_end_clean(); }
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    http_response_code(500);

    $payload = [
        'success' => false,
        'message' => 'Fatal server error',
    ];
    if ($DEBUG_MODE) {
        $payload['debug'] = [
            'type' => $err['type'],
            'message' => $err['message'] ?? 'Fatal error',
            'file' => isset($err['file']) ? basename((string)$err['file']) : null,
            'line' => $err['line'] ?? null,
        ];
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
});

function jsonSuccess($data, $msg = 'Success'): void {
    if (ob_get_level()) { ob_end_clean(); }
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError($msg, $code = 400, ?Throwable $e = null): void {
    global $DEBUG_MODE;
    if (ob_get_level()) { ob_end_clean(); }
    http_response_code($code);
    $payload = ['success' => false, 'message' => $msg];
    if ($DEBUG_MODE && $e) {
        $payload['debug'] = [
            'type' => get_class($e),
            'message' => $e->getMessage(),
            'file' => basename($e->getFile()),
            'line' => $e->getLine(),
        ];
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $input  = json_decode(file_get_contents('php://input'), true);
    $token  = isset($input['token'])  ? trim((string)$input['token'])  : '';
    $code   = isset($input['code'])   ? trim((string)$input['code'])   : '';
    $action = isset($input['action']) ? trim((string)$input['action']) : '';

    if ($token === '') {
        jsonError('Verification token is required', 400);
    }
    if ($code === '' && $action !== 'resend') {
        jsonError('Verification code is required', 400);
    }

    $db = getDB();

    // Resolve user by token (SDO personnel only)
    $stmt = $db->prepare("
        SELECT id, email, full_name, role, account_type, status, email_verified, verify_token_expires
        FROM users
        WHERE verify_token = :token
          AND status = 'active'
          AND account_type = 'sdo_personnel'
        LIMIT 1
    ");
    $stmt->execute([':token' => $token]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        jsonError('Invalid or expired verification link. Please log in again.', 401);
    }

    if ((int)$user['email_verified'] === 1) {
        jsonSuccess([
            'id' => (int)$user['id'],
            'email' => $user['email'],
            'full_name' => $user['full_name'],
            'role' => $user['role'] ?? 'viewer',
            'account_type' => $user['account_type'] ?? 'sdo_personnel',
        ], 'Email already verified. You can continue.');
    }

    if (!empty($user['verify_token_expires']) && strtotime($user['verify_token_expires']) < time()) {
        jsonError('Verification link has expired. Please log in again.', 410);
    }

    $userId    = (int)$user['id'];
    $userEmail = (string)$user['email'];
    $name      = trim((string)($user['full_name'] ?? 'User'));
    $firstName = $name !== '' ? explode(' ', $name)[0] : 'User';

    // ── RESEND ─────────────────────────────────────────────────────────────
    if ($action === 'resend') {
        // Rate limit: max 3 resends per 10 minutes
        $stmt = $db->prepare("
            SELECT COUNT(*)
            FROM email_verification_codes
            WHERE user_id = :uid
              AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ");
        $stmt->execute([':uid' => $userId]);
        if ((int)$stmt->fetchColumn() >= 3) {
            jsonError('Too many resend attempts. Please wait 10 minutes.', 429);
        }

        // Invalidate old unused codes
        $db->prepare("UPDATE email_verification_codes SET is_used = 1 WHERE user_id = :uid AND is_used = 0")
           ->execute([':uid' => $userId]);

        $newCode    = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $newExpires = date('Y-m-d H:i:s', strtotime('+30 minutes'));

        $db->prepare("
            INSERT INTO email_verification_codes (user_id, code, is_used, attempts, expires_at)
            VALUES (:uid, :code, 0, 0, :exp)
        ")->execute([
            ':uid'  => $userId,
            ':code' => $newCode,
            ':exp'  => $newExpires,
        ]);

        require_once $base_path . '/helpers/EmailHelper.php';
        $emailHelper = new EmailHelper();
        $sent = $emailHelper->sendVerificationCode($userEmail, $newCode, $firstName);

        if (!$sent) {
            jsonError('Failed to send email. Please try again.', 500);
        }

        jsonSuccess(null, 'A verification code has been sent to your email.');
    }

    // ── VERIFY CODE ────────────────────────────────────────────────────────
    if (!preg_match('/^\d{6}$/', $code)) {
        jsonError('Please enter a valid 6-digit code.', 422);
    }

    $stmt = $db->prepare("
        SELECT id, code, expires_at, attempts
        FROM email_verification_codes
        WHERE user_id = :uid AND is_used = 0
        ORDER BY created_at DESC
        LIMIT 1
    ");
    $stmt->execute([':uid' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        jsonError('No active verification code found. Please click Resend Code.', 404);
    }

    if ((int)$row['attempts'] >= 5) {
        $db->prepare("UPDATE email_verification_codes SET is_used = 1 WHERE id = :id")
           ->execute([':id' => (int)$row['id']]);
        jsonError('Too many incorrect attempts. Please request a new code.', 429);
    }

    if (strtotime($row['expires_at']) < time()) {
        jsonError('This code has expired. Click Resend Code to get a new one.', 410);
    }

    // Increment attempts before comparison
    $db->prepare("UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = :id")
       ->execute([':id' => (int)$row['id']]);
    $attemptsAfter = ((int)$row['attempts']) + 1;

    if ((string)$row['code'] !== $code) {
        $remaining = max(0, 5 - $attemptsAfter);
        jsonError("Incorrect code. $remaining attempt(s) remaining.", 401);
    }

    // Correct code
    $db->prepare("UPDATE email_verification_codes SET is_used = 1 WHERE id = :id")
       ->execute([':id' => (int)$row['id']]);

    $db->prepare("
        UPDATE users
        SET email_verified = 1,
            verify_token = NULL,
            verify_token_expires = NULL,
            updated_at = NOW()
        WHERE id = :id
          AND account_type = 'sdo_personnel'
    ")->execute([':id' => $userId]);

    jsonSuccess([
        'id' => $userId,
        'email' => $userEmail,
        'full_name' => $user['full_name'],
        'role' => $user['role'] ?? 'viewer',
        'account_type' => $user['account_type'] ?? 'sdo_personnel',
        'email_verified' => true,
    ], 'Email verified successfully!');

} catch (Throwable $e) {
    error_log('verify-email.php error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $publicMsg = $DEBUG_MODE
        ? ('Server error: ' . $e->getMessage())
        : 'Server error. Please try again.';
    jsonError($publicMsg, 500, $e);
}