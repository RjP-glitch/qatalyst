<?php
/**
 * Login API Endpoint
 * POST /api/login.php
 */

// ─── Error logging setup ───────────────────────────────────────────────────────
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

// ─── Output buffer ────────────────────────────────────────────────────────────
if (ob_get_level()) ob_end_clean();
ob_start();

// ─── SECURITY FIX #5: Force HTTPS ─────────────────────────────────────────────
// Uncomment this block when deployed to production with SSL
// if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') {
//     http_response_code(400);
//     echo json_encode(['success' => false, 'message' => 'HTTPS is required', 'errors' => []]);
//     exit;
// }

// ─── SECURITY FIX #1: Restrict CORS to your domain only ───────────────────────
$is_dev = in_array($_SERVER['SERVER_NAME'] ?? '', ['localhost', '127.0.0.1'], true);
$allowed_origins = $is_dev
    ? ['http://localhost', 'http://127.0.0.1']
    : [
        'https://yourdomain.com',       // ← replace with your actual domain
        'https://www.yourdomain.com',   // ← replace with your actual domain
    ];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowed_origins, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
} else {
    // Origin not allowed — still set headers for preflight, but restrict access
    header('Access-Control-Allow-Origin: null');
}

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
// SECURITY: Prevent clickjacking, content sniffing, and XSS
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ─── Constants ────────────────────────────────────────────────────────────────
define('MAX_FAILED_ATTEMPTS', 5);
define('LOCKOUT_MINUTES', 15);
define('SESSION_EXPIRY_HOURS', 24);

try {
    $base_path = dirname(__DIR__);

    if (!file_exists($base_path . '/config/database.php')) {
        throw new Exception('database.php not found');
    }
    if (!file_exists($base_path . '/models/User.php')) {
        throw new Exception('User.php not found');
    }

    require_once $base_path . '/config/database.php';
    require_once $base_path . '/config/audit_log.php';
    require_once $base_path . '/models/User.php';

    // ─── Response helper ──────────────────────────────────────────────────────
    if (!file_exists($base_path . '/api/Response.php')) {
        class Response {
            public function success($data, $message = 'Success', $code = 200) {
                http_response_code($code);
                echo json_encode([
                    'success' => true,
                    'message' => $message,
                    'data'    => $data
                ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                exit;
            }
            public function error($message, $errors = [], $code = 400) {
                http_response_code($code);
                echo json_encode([
                    'success' => false,
                    'message' => $message,
                    'errors'  => $errors
                ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
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
    $input = file_get_contents('php://input');
    $data  = json_decode($input, true);

    if (json_last_error() !== JSON_ERROR_NONE) {
        $response->error('Invalid JSON input', [], 400);
    }

    // ─── Validate fields ──────────────────────────────────────────────────────
    $email    = isset($data['email'])    ? trim($data['email']) : null;
    $password = isset($data['password']) ? $data['password']    : null;

    if (!$email || !$password) {
        $response->error('Email and password are required', [], 400);
    }

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $response->error('Invalid email format', [], 400);
    }

    // Limit input length to prevent abuse
    if (strlen($email) > 255 || strlen($password) > 1024) {
        $response->error('Invalid input', [], 400);
    }

    // ─── Database ─────────────────────────────────────────────────────────────
    $pdo = getDB();
    if (!$pdo || !($pdo instanceof PDO)) {
        $response->error('Database connection failed', [], 500);
    }
    auditEnsureTable($pdo);

    $logAudit = static function (
        string $action,
        string $status,
        string $description,
        ?int $targetUserId = null,
        string $targetRole = 'guest'
    ) use ($pdo): void {
        auditLog([
            'pdo' => $pdo,
            'user_id' => $targetUserId,
            'role' => $targetRole,
            'action' => $action,
            'module' => 'auth',
            'status' => $status,
            'description' => $description,
        ]);
    };

    // ─── SECURITY FIX #2: Rate limiting — check lockout before fetching user ──
    $ip_address = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $user_agent = $_SERVER['HTTP_USER_AGENT'] ?? 'unknown';

    $lockoutStmt = $pdo->prepare("
        SELECT COUNT(*) as attempt_count 
        FROM login_attempts 
        WHERE ip_address = :ip 
          AND attempted_at > DATE_SUB(NOW(), INTERVAL :minutes MINUTE)
          AND success = 0
    ");
    $lockoutStmt->execute([
        ':ip'      => $ip_address,
        ':minutes' => LOCKOUT_MINUTES
    ]);
    $attemptData = $lockoutStmt->fetch(PDO::FETCH_ASSOC);

    if ((int)$attemptData['attempt_count'] >= MAX_FAILED_ATTEMPTS) {
        $logAudit(
            'login_rate_limited',
            'failed',
            'Login blocked by rate limit for email: ' . $email
        );
        $response->error(
            'Too many failed login attempts. Please try again in ' . LOCKOUT_MINUTES . ' minutes.',
            [],
            429
        );
    }

    // ─── Fetch user ───────────────────────────────────────────────────────────
    // Direct query so we always get account_type regardless of what the User
    // model's SELECT list includes. This is the source-of-truth for the guard.
    $user     = new User($pdo);
    $userData = $user->getUserByEmail($email);

    // Supplement with account_type if the model didn't return it
    if ($userData && !array_key_exists('account_type', $userData)) {
        $atStmt = $pdo->prepare("SELECT account_type FROM users WHERE id = :id LIMIT 1");
        $atStmt->execute([':id' => $userData['id']]);
        $atRow = $atStmt->fetch(PDO::FETCH_ASSOC);
        $userData['account_type'] = $atRow['account_type'] ?? 'sdo_personnel';
    }

    // ─── SECURITY: Use constant-time comparison path even on missing user ──────
    // This prevents timing attacks that reveal whether an email exists
    $dummyHash = '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    $hashToVerify = $userData ? $userData['password'] : $dummyHash;
    $passwordMatch = password_verify($password, $hashToVerify);

    if (!$userData || !$passwordMatch) {
        // ─── Log failed attempt ───────────────────────────────────────────────
        $logStmt = $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 0, NOW())
        ");
        $logStmt->execute([
            ':ip'    => $ip_address,
            ':email' => $email,
            ':ua'    => substr($user_agent, 0, 512)
        ]);

        $logAudit(
            'login',
            'failed',
            'Invalid credentials for email: ' . $email
        );

        // Always return the same generic message — never reveal which field is wrong
        $response->error('Invalid email or password', [], 401);
    }

    // ─── Account status check ─────────────────────────────────────────────────
    if (isset($userData['status']) && $userData['status'] !== 'active') {
        $logAudit(
            'login',
            'failed',
            'Login blocked for inactive account',
            (int)$userData['id'],
            (string)($userData['role'] ?? 'viewer')
        );
        $response->error('Account is not active. Please contact support.', [], 403);
    }

    // ─── ACCOUNT TYPE GUARD ───────────────────────────────────────────────────
    $portal      = $data['portal'] ?? 'sdo'; // 'sdo' or 'school'
    $accountType = $userData['account_type'] ?? 'sdo_personnel';

    if ($portal === 'sdo' && $accountType === 'portal_user') {
        // Portal user trying to log into SDO system
        $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 0, NOW())
        ")->execute([
            ':ip'    => $ip_address,
            ':email' => $email,
            ':ua'    => substr($user_agent, 0, 512)
        ]);
        $logAudit(
            'login',
            'failed',
            'Portal user attempted SDO login',
            (int)$userData['id'],
            (string)($userData['role'] ?? 'portal_user')
        );
        $response->error(
            'This account is registered through the School Portal. Please sign in at the School Portal page instead.',
            [],
            403
        );
    }

    if ($portal === 'school' && $accountType === 'sdo_personnel') {
        // SDO personnel trying to log into school portal
        $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 0, NOW())
        ")->execute([
            ':ip'    => $ip_address,
            ':email' => $email,
            ':ua'    => substr($user_agent, 0, 512)
        ]);
        $logAudit(
            'login',
            'failed',
            'SDO personnel attempted School Portal login',
            (int)$userData['id'],
            (string)($userData['role'] ?? 'viewer')
        );
        $response->error(
            'This account belongs to the SDO system. Please sign in at the SDO Personnel login page instead.',
            [],
            403
        );
    }

    // ─── SECURITY FIX #7: Invalidate expired sessions before creating new one ─
    $user_id = intval($userData['id']);
    $pdo->prepare("
        DELETE FROM login_sessions 
        WHERE user_id = :id AND expires_at < NOW()
    ")->execute([':id' => $user_id]);

    // ─── 2FA CHECK ────────────────────────────────────────────────────────────
    // If user has 2FA enabled, generate temp token and send verification code
    if (!empty($userData['two_factor_enabled'])) {
        // Generate temp token for 2FA verification
        $temp_token = bin2hex(random_bytes(32));
        $code = str_pad(random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expires = date('Y-m-d H:i:s', strtotime('+10 minutes'));

        // Insert 2FA code record
        $stmt = $pdo->prepare("
            INSERT INTO two_factor_codes (user_id, code, temp_token, expires_at)
            VALUES (:user_id, :code, :temp_token, :expires_at)
        ");
        $stmt->execute([
            ':user_id'    => $user_id,
            ':code'       => $code,
            ':temp_token' => $temp_token,
            ':expires_at' => $expires
        ]);

        // Send verification code via email
        require_once $base_path . '/helpers/EmailHelper.php';
        $emailHelper = new EmailHelper();
        $emailHelper->sendVerificationCode(
            $userData['email'],
            $code,
            $userData['full_name'] ?? 'User'
        );

        // Log successful credential validation (but not full login yet)
        $pdo->prepare("
            INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
            VALUES (:ip, :email, :ua, 1, NOW())
        ")->execute([
            ':ip'    => $ip_address,
            ':email' => $email,
            ':ua'    => substr($user_agent, 0, 512)
        ]);

        $logAudit(
            'login_2fa_challenge',
            'pending',
            'Primary credentials accepted; waiting for 2FA verification',
            $user_id,
            (string)($userData['role'] ?? 'viewer')
        );

        // Return 2FA required response
        $response->success([
            'requires_2fa' => true,
            'temp_token'   => $temp_token,
            'email'        => $userData['email'],
            'full_name'    => $userData['full_name'] ?? 'User'
        ], '2FA verification required', 200);
    }

    // ─── Create session (only if 2FA not enabled) ─────────────────────────────
    $session_token = bin2hex(random_bytes(50));
    $expires_at    = date('Y-m-d H:i:s', strtotime('+' . SESSION_EXPIRY_HOURS . ' hours'));

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

    // ─── Log successful attempt ───────────────────────────────────────────────
    $pdo->prepare("
        INSERT INTO login_attempts (ip_address, email, user_agent, success, attempted_at)
        VALUES (:ip, :email, :ua, 1, NOW())
    ")->execute([
        ':ip'    => $ip_address,
        ':email' => $email,
        ':ua'    => substr($user_agent, 0, 512)
    ]);

    $logAudit(
        'login',
        'success',
        'User logged in successfully',
        $user_id,
        (string)($userData['role'] ?? 'viewer')
    );

    // ─── SECURITY FIX #3: Set session token as HttpOnly cookie ───────────────
    // The token is ALSO returned in the response body for API clients,
    // but the cookie ensures browser clients never expose it to JS.
    $is_secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    setcookie('session_token', $session_token, [
        'expires'  => strtotime('+' . SESSION_EXPIRY_HOURS . ' hours'),
        'path'     => '/',
        'secure'   => $is_secure,  // HTTPS only in production, allow HTTP on localhost
        'httponly' => true,        // JS cannot access this cookie
        'samesite' => 'Strict'     // Prevents CSRF
    ]);

    // ─── SECURITY FIX #6: Use a short-lived verify token instead of user_id ──
    $verify_token = null;
    if (!($userData['email_verified'] ?? false)) {
        $verify_token = bin2hex(random_bytes(16));
        $verify_expires = date('Y-m-d H:i:s', strtotime('+15 minutes'));
        $pdo->prepare("
            UPDATE users 
            SET verify_token = :token, verify_token_expires = :expires 
            WHERE id = :id
        ")->execute([
            ':token'   => $verify_token,
            ':expires' => $verify_expires,
            ':id'      => $user_id
        ]);
    }

    // ─── SECURITY FIX #8: Never return permissions or session token to client ──
    // session_token is delivered exclusively via the HttpOnly cookie set above.
    // Returning it in the JSON body would expose it to JS and defeat the purpose.
    // Permissions are validated server-side on every request — never trust the client.
    $response->success([
        'user_id'        => $user_id,
        'email'          => $userData['email'],
        'full_name'      => $userData['full_name'] ?? 'User',
        'email_verified' => boolval($userData['email_verified'] ?? false),
        'role'           => $userData['role'] ?? 'viewer',
        'account_type'   => $accountType,
        // verify_token replaces user_id in the redirect URL (null if already verified)
        'verify_token'   => $verify_token,
    ], 'Login successful', 200);

} catch (PDOException $e) {
    // Log full error server-side, never expose to client
    error_log('PDO Error in login.php: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'A server error occurred. Please try again later.',
        'errors'  => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);

} catch (Exception $e) {
    error_log('Error in login.php: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'A server error occurred. Please try again later.',
        'errors'  => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

ob_end_flush();