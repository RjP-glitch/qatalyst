<?php
/**
 * School Portal Login Endpoint
 * POST /api/school-login.php
 *
 * Accepts ONLY accounts with account_type = 'portal_user'.
 * SDO personnel accounts (account_type = 'sdo_personnel') are rejected.
 */

// ─── Error logging ────────────────────────────────────────────────────────────
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

// ─── Output buffer ────────────────────────────────────────────────────────────
if (ob_get_level()) ob_end_clean();
ob_start();

// ─── CORS ─────────────────────────────────────────────────────────────────────
$is_dev = in_array($_SERVER['SERVER_NAME'] ?? '', ['localhost', '127.0.0.1'], true);
$allowed_origins = $is_dev
    ? [
        'http://localhost',
        'http://127.0.0.1',
        'http://localhost/qatalyst',
        'http://127.0.0.1/qatalyst',
    ]
    : [
        'https://yourdomain.com',     // ← replace when deploying
        'https://www.yourdomain.com', // ← replace when deploying
    ];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowed_origins, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
} elseif (!empty($origin)) {
    header('Access-Control-Allow-Origin: null');
}

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ─── Constants ────────────────────────────────────────────────────────────────
define('SCHOOL_MAX_FAILED_ATTEMPTS', 5);
define('SCHOOL_LOCKOUT_MINUTES', 15);
define('SCHOOL_SESSION_EXPIRY_HOURS', 24);

// ─── This endpoint is school portal-only ─────────────────────────────────────
define('PORTAL', 'school');
define('ALLOWED_ACCOUNT_TYPE', 'portal_user');
define('REJECTED_ACCOUNT_TYPE', 'sdo_personnel');
define('REJECTED_MESSAGE', 'This account belongs to the SDO system. Please sign in at the SDO Personnel login page instead.');

try {
    $base_path = dirname(__DIR__);

    require_once $base_path . '/config/database.php';
    require_once $base_path . '/config/audit_log.php';
    require_once $base_path . '/models/User.php';

    // ─── Response helper ──────────────────────────────────────────────────────
    if (!file_exists($base_path . '/api/Response.php')) {
        class Response {
            public function success($data, $message = 'Success', $code = 200) {
                http_response_code($code);
                echo json_encode(['success' => true, 'message' => $message, 'data' => $data],
                    JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                exit;
            }
            public function error($message, $errors = [], $code = 400) {
                http_response_code($code);
                echo json_encode(['success' => false, 'message' => $message, 'errors' => $errors],
                    JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                exit;
            }
        }
    } else {
        require_once $base_path . '/api/Response.php';
    }

    $response = new Response();

    // ─── Method check ─────────────────────────────────────────────────────────
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        $response->error('Method not allowed', [], 405);
    }

    // ─── Parse input ──────────────────────────────────────────────────────────
    $data = json_decode(file_get_contents('php://input'), true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        $response->error('Invalid JSON input', [], 400);
    }

    $email    = isset($data['email'])    ? trim($data['email']) : null;
    $password = isset($data['password']) ? $data['password']    : null;

    if (!$email || !$password) {
        $response->error('Email and password are required', [], 400);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $response->error('Invalid email format', [], 400);
    }
    if (strlen($email) > 255 || strlen($password) > 1024) {
        $response->error('Invalid input', [], 400);
    }

    // ─── Database ─────────────────────────────────────────────────────────────
    $pdo = getDB();
    if (!$pdo || !($pdo instanceof PDO)) {
        $response->error('Database connection failed', [], 500);
    }
    auditEnsureTable($pdo);

    // ─── Resolve real client IP ───────────────────────────────────────────────
    function getClientIp(): string {
        $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($forwarded) {
            foreach (array_map('trim', explode(',', $forwarded)) as $ip) {
                if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                    return $ip;
                }
            }
        }
        $realIp = $_SERVER['HTTP_X_REAL_IP'] ?? '';
        if (filter_var($realIp, FILTER_VALIDATE_IP)) return $realIp;
        return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    }

    $ip_address = getClientIp();
    $user_agent = $_SERVER['HTTP_USER_AGENT'] ?? 'unknown';

    // ─── Rate limiting ────────────────────────────────────────────────────────
    $lockoutStmt = $pdo->prepare("
        SELECT COUNT(*) as attempt_count
        FROM login_attempts
        WHERE ip_address = :ip
          AND attempted_at > DATE_SUB(NOW(), INTERVAL :minutes MINUTE)
          AND success = 0
    ");
    $lockoutStmt->execute([':ip' => $ip_address, ':minutes' => SCHOOL_LOCKOUT_MINUTES]);
    $attemptData = $lockoutStmt->fetch(PDO::FETCH_ASSOC);

    if ((int)$attemptData['attempt_count'] >= SCHOOL_MAX_FAILED_ATTEMPTS) {
        $response->error(
            'Too many failed login attempts. Please try again in ' . SCHOOL_LOCKOUT_MINUTES . ' minutes.',
            [], 429
        );
    }

    // ─── Fetch user ───────────────────────────────────────────────────────────
    $user     = new User($pdo);
    $userData = $user->getUserByEmail($email);

    if ($userData && !array_key_exists('account_type', $userData)) {
        $atStmt = $pdo->prepare("SELECT account_type FROM users WHERE id = :id LIMIT 1");
        $atStmt->execute([':id' => $userData['id']]);
        $atRow = $atStmt->fetch(PDO::FETCH_ASSOC);
        $userData['account_type'] = $atRow['account_type'] ?? ALLOWED_ACCOUNT_TYPE;
    }

    // ─── Constant-time password check (prevents timing attacks) ──────────────
    $dummyHash     = '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    $hashToVerify  = $userData ? $userData['password'] : $dummyHash;
    $passwordMatch = password_verify($password, $hashToVerify);

    if (!$userData || !$passwordMatch) {
        $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 0, NOW())
        ")->execute([':ip' => $ip_address, ':email' => $email, ':ua' => substr($user_agent, 0, 512)]);
        $response->error('Invalid email or password', [], 401);
    }

    // ─── Account status check ─────────────────────────────────────────────────
    if (isset($userData['status']) && $userData['status'] !== 'active') {
        auditLog([
            'pdo' => $pdo,
            'user_id' => isset($userData['id']) ? (int)$userData['id'] : null,
            'role' => (string)($userData['role'] ?? 'portal_user'),
            'action' => 'login',
            'module' => 'school_portal',
            'status' => 'blocked',
            'description' => 'Portal login blocked: account not active',
        ]);
        $response->error('Account is not active. Please contact support.', [], 403);
    }

    // ─── School portal guard: reject SDO personnel accounts ──────────────────
    $accountType = $userData['account_type'] ?? '';
    if ($accountType !== ALLOWED_ACCOUNT_TYPE) {
        $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 0, NOW())
        ")->execute([':ip' => $ip_address, ':email' => $email, ':ua' => substr($user_agent, 0, 512)]);
        auditLog([
            'pdo' => $pdo,
            'user_id' => isset($userData['id']) ? (int)$userData['id'] : null,
            'role' => (string)($userData['role'] ?? 'sdo_personnel'),
            'action' => 'login',
            'module' => 'school_portal',
            'status' => 'blocked',
            'description' => 'Portal login blocked: SDO account tried to sign in to School Portal',
        ]);
        $response->error(REJECTED_MESSAGE, [], 403);
    }

    // Unverified accounts receive a verification challenge, never a full session.
    if (empty($userData['email_verified'])) {
        require_once $base_path . '/helpers/SchoolVerification.php';
        $challenge = schoolStartVerification($pdo, $userData);
        setcookie('school_session_token', '', [
            'expires' => time() - 3600, 'path' => '/', 'httponly' => true,
            'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
            'samesite' => 'Lax',
        ]);
        $response->success([
            'user_id' => (int)$userData['id'], 'email' => $userData['email'],
            'full_name' => $userData['full_name'], 'role' => 'teacher',
            'account_type' => 'portal_user', 'email_verified' => false,
            'verify_token' => $challenge['verify_token'],
            'verification_email_sent' => $challenge['verification_email_sent'],
        ], $challenge['verification_email_sent'] ? 'Please verify your email. A new code has been sent.' : 'Please verify your email. Use Resend code if needed; requests are limited to three per ten minutes.');
    }

    // ─── Clean up expired sessions ────────────────────────────────────────────
    $user_id = intval($userData['id']);
    $pdo->prepare("DELETE FROM login_sessions WHERE user_id = :id AND expires_at < NOW()")
        ->execute([':id' => $user_id]);

    // ─── Create session ───────────────────────────────────────────────────────
    $session_token = bin2hex(random_bytes(50));
    $expires_at    = date('Y-m-d H:i:s', strtotime('+' . SCHOOL_SESSION_EXPIRY_HOURS . ' hours'));

    $stmt = $pdo->prepare("
        INSERT INTO login_sessions (user_id, session_token, ip_address, user_agent, expires_at)
        VALUES (:user_id, :session_token, :ip_address, :user_agent, :expires_at)
    ");
    $stmt->bindParam(':user_id',       $user_id,       PDO::PARAM_INT);
    $stmt->bindParam(':session_token', $session_token, PDO::PARAM_STR);
    $stmt->bindParam(':ip_address',    $ip_address,    PDO::PARAM_STR);
    $stmt->bindParam(':user_agent',    $user_agent,    PDO::PARAM_STR);
    $stmt->bindParam(':expires_at',    $expires_at,    PDO::PARAM_STR);
    $stmt->execute();

    auditLog([
        'pdo' => $pdo,
        'user_id' => $user_id,
        'role' => (string)($userData['role'] ?? 'portal_user'),
        'action' => 'login',
        'module' => 'school_portal',
        'status' => 'success',
        'description' => 'School Portal login successful',
    ]);

    // ─── Log success ──────────────────────────────────────────────────────────
    $pdo->prepare("
        INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
        VALUES (:ip, :email, :ua, 1, NOW())
    ")->execute([':ip' => $ip_address, ':email' => $email, ':ua' => substr($user_agent, 0, 512)]);

    // ─── Set HttpOnly session cookie ──────────────────────────────────────────
    // Uses a different cookie name so SDO and school sessions never collide
    $is_secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    setcookie('school_session_token', $session_token, [
        'expires'  => strtotime('+' . SCHOOL_SESSION_EXPIRY_HOURS . ' hours'),
        'path'     => '/',
        'secure'   => $is_secure,
        'httponly' => true,
        'samesite' => $is_secure ? 'Strict' : 'Lax',
    ]);

    $response->success([
        'user_id'        => $user_id,
        'email'          => $userData['email'],
        'full_name'      => $userData['full_name'] ?? 'User',
        'email_verified' => boolval($userData['email_verified'] ?? false),
        'role'           => 'teacher',
        'account_type'   => $accountType,
        'verify_token'   => null,
    ], 'Login successful', 200);

} catch (PDOException $e) {
    error_log('PDO Error in school-login.php: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'A server error occurred. Please try again later.', 'errors' => []]);
} catch (Exception $e) {
    error_log('Error in school-login.php: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'A server error occurred. Please try again later.', 'errors' => []]);
}

ob_end_flush();
