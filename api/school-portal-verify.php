<?php
/** Verify a school email or resend its ten-minute code. */
require_once dirname(__DIR__) . '/config/security.php';
setCorsHeaders();
setSecurityHeaders();
handlePreflight();
header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/helpers/SchoolVerification.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

function jsonError(string $message, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}
function jsonSuccess($data, string $message): void {
    echo json_encode(['success' => true, 'data' => $data, 'message' => $message]);
    exit;
}

$db = null;
try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') jsonError('Method not allowed', 405);
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) jsonError('Invalid JSON request.', 422);
    foreach (['token', 'code', 'action'] as $key) {
        if (isset($input[$key]) && !is_string($input[$key])) jsonError('Invalid verification request.', 422);
    }
    $token = trim($input['token'] ?? '');
    $code = trim($input['code'] ?? '');
    $action = trim($input['action'] ?? '');
    if ($token === '' || strlen($token) > 128) jsonError('Sign in again to get a new verification link.', 401);
    if ($action !== '' && $action !== 'resend') jsonError('Invalid action.', 422);
    if ($action !== 'resend' && !preg_match('/^\d{6}$/D', $code)) jsonError('Please enter a valid 6-digit code.', 422);

    $db = getDB();
    $db->beginTransaction();
    $stmt = $db->prepare("SELECT * FROM users WHERE verify_token = ? AND status = 'active' AND account_type = 'portal_user' LIMIT 1 FOR UPDATE");
    $stmt->execute([$token]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$user || !empty($user['email_verified']) || !$user['verify_token_expires'] || strtotime($user['verify_token_expires']) < time()) {
        $db->rollBack();
        jsonError('This verification link is invalid or expired. Sign in again to receive a new link and code.', 410);
    }
    $userId = (int)$user['id'];

    if ($action === 'resend') {
        $newCode = schoolCreateVerificationCode($db, $userId);
        if ($newCode === null) {
            $db->rollBack();
            jsonError('Too many requests. Please wait 10 minutes.', 429);
        }
        $db->prepare('UPDATE users SET verify_token_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?')->execute([$userId]);
        $db->commit();
        if (!schoolDeliverVerificationCode($user, $newCode)) jsonError('The email could not be sent. Please try again later.', 503);
        jsonSuccess(null, 'A new verification code has been sent. It expires in 10 minutes.');
    }

    $stmt = $db->prepare('SELECT id, code, expires_at, attempts FROM email_verification_codes WHERE user_id = ? AND is_used = 0 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE');
    $stmt->execute([$userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || strtotime($row['expires_at']) < time()) {
        $db->rollBack();
        jsonError('No active code found. Use Resend code to get a new one.', 410);
    }
    if ((int)$row['attempts'] >= 5) {
        $db->prepare('UPDATE email_verification_codes SET is_used = 1 WHERE id = ?')->execute([$row['id']]);
        $db->commit();
        jsonError('Too many incorrect attempts. Please request a new code.', 429);
    }
    if (!hash_equals((string)$row['code'], $code)) {
        $attempts = (int)$row['attempts'] + 1;
        $db->prepare('UPDATE email_verification_codes SET attempts = ?, is_used = ? WHERE id = ?')->execute([$attempts, $attempts >= 5 ? 1 : 0, $row['id']]);
        $db->commit();
        jsonError('Incorrect code. ' . (5 - $attempts) . ' attempt(s) remaining.', $attempts >= 5 ? 429 : 401);
    }

    $db->prepare('UPDATE email_verification_codes SET is_used = 1 WHERE user_id = ?')->execute([$userId]);
    $db->prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL, updated_at = NOW() WHERE id = ?')->execute([$userId]);
    $sessionToken = bin2hex(random_bytes(50));
    $db->prepare('INSERT INTO login_sessions (user_id, session_token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))')->execute([
        $userId, $sessionToken, $_SERVER['REMOTE_ADDR'] ?? 'unknown', substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 512),
    ]);
    $stmt = $db->prepare("SELECT u.id, u.email, u.full_name, u.school_type, u.school_id, u.private_school_id, u.district_id, u.grade, u.school_id_no,
        CASE WHEN u.school_type = 'private' THEN pvs.name ELSE ps.school_name END AS school_name, d.name AS district_name
        FROM users u LEFT JOIN public_schools ps ON ps.id = u.school_id AND u.school_type = 'public'
        LEFT JOIN private_schools pvs ON pvs.id = u.private_school_id AND u.school_type = 'private'
        LEFT JOIN districts d ON d.id = u.district_id WHERE u.id = ?");
    $stmt->execute([$userId]);
    $profile = $stmt->fetch(PDO::FETCH_ASSOC);
    $db->commit();
    auditLog([
        'pdo' => $db, 'user_id' => $userId, 'role' => 'teacher',
        'action' => 'verify_email', 'module' => 'school_portal', 'status' => 'success',
        'description' => 'Verified school account email; school affiliation awaits SDO approval.',
    ]);

    $secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    setcookie('school_session_token', $sessionToken, [
        'expires' => time() + 86400, 'path' => '/', 'secure' => $secure,
        'httponly' => true, 'samesite' => $secure ? 'Strict' : 'Lax',
    ]);
    jsonSuccess($profile + ['role' => 'teacher', 'account_type' => 'portal_user', 'email_verified' => true], 'Email verified successfully.');
} catch (Throwable $e) {
    if ($db instanceof PDO && $db->inTransaction()) $db->rollBack();
    error_log('School verification failed: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
