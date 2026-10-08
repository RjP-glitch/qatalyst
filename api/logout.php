<?php
/**
 * Logout API Endpoint
 * POST /api/logout.php
 */

// Enable error logging
error_reporting(E_ALL);
ini_set('display_errors', 0);

// Start output buffering and clear any previous output
if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';

// Set headers FIRST
header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

try {
    // Include required files
    $base_path = dirname(__DIR__);
    
    require_once $base_path . '/config/database.php';
    require_once $base_path . '/config/audit_log.php';
    
    // Response class
    if (!file_exists($base_path . '/api/Response.php')) {
        class Response {
            public function success($data, $message = 'Success', $code = 200) {
                http_response_code($code);
                echo json_encode([
                    'success' => true,  
                    'message' => $message,
                    'data' => $data
                ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                exit;
            }
            
            public function error($message, $errors = [], $code = 400) {
                http_response_code($code);
                echo json_encode([
                    'success' => false,
                    'message' => $message,
                    'errors' => $errors
                ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                exit;
            }
        }
    } else {
        require_once $base_path . '/api/Response.php';
    }
    
    $response = new Response();

    // Check request method
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        $response->error('Method not allowed', [], 405);
    }

    // Get session token from cookie first, then Authorization header, then POST data
    $sessionToken = null;
    $schoolLogout = ($_GET['portal'] ?? '') === 'school';
    $cookieName = $schoolLogout ? 'school_session_token' : 'session_token';

    // Try only the cookie belonging to the selected application.
    if (!empty($_COOKIE[$cookieName])) {
        $sessionToken = $_COOKIE[$cookieName];
    }

    // Fallback: Try Authorization header
    if (!$sessionToken) {
        $headers = getallheaders();
        if (isset($headers['Authorization'])) {
            $sessionToken = str_replace('Bearer ', '', $headers['Authorization']);
        }
    }

    // Fallback: Try POST data
    if (!$sessionToken) {
        $input = file_get_contents('php://input');
        $data = json_decode($input, true);
        if (isset($data['session_token'])) {
            $sessionToken = $data['session_token'];
        }
    }

    // Logging out of one application leaves the other application's session intact.
    $is_secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    $cookieOptions = [
        'expires'  => time() - 3600,
        'path'     => '/',
        'secure'   => $is_secure,
        'httponly' => true,
        'samesite' => $is_secure ? 'Strict' : 'Lax',
    ];
    setcookie($cookieName, '', $cookieOptions);

    if (!$sessionToken) {
        // Still return success - client-side logout is valid
        $response->success([
            'message' => 'Logged out successfully (client-side only)'
        ], 'Logout successful', 200);
    }

    // Connect to database
    $pdo = getDB();

    if (!$pdo || !($pdo instanceof PDO)) {
        // Still return success - logout should work even if DB fails
        $response->success([
            'message' => 'Logged out successfully'
        ], 'Logout successful', 200);
    }

    auditEnsureTable($pdo);

    $sessionLookup = $pdo->prepare("SELECT u.id AS user_id, u.role
                                    FROM login_sessions ls
                                    LEFT JOIN users u ON u.id = ls.user_id
                                    WHERE ls.session_token = :session_token
                                    LIMIT 1");
    $sessionLookup->bindParam(':session_token', $sessionToken, PDO::PARAM_STR);
    $sessionLookup->execute();
    $sessionInfo = $sessionLookup->fetch(PDO::FETCH_ASSOC) ?: null;

    

    // Delete the session from database
    $query = "DELETE FROM login_sessions WHERE session_token = :session_token";
    $stmt = $pdo->prepare($query);
    $stmt->bindParam(':session_token', $sessionToken, PDO::PARAM_STR);
    
    if ($stmt->execute()) {
        $deletedRows = $stmt->rowCount();
        if ($deletedRows > 0) {
            auditLog([
                'pdo' => $pdo,
                'user_id' => isset($sessionInfo['user_id']) ? (int)$sessionInfo['user_id'] : null,
                'role' => (string)($sessionInfo['role'] ?? 'unknown'),
                'action' => 'logout',
                'module' => 'auth',
                'status' => 'success',
                'description' => 'User logged out and session was revoked',
            ]);
        } else {
            auditLog([
                'pdo' => $pdo,
                'user_id' => isset($sessionInfo['user_id']) ? (int)$sessionInfo['user_id'] : null,
                'role' => (string)($sessionInfo['role'] ?? 'unknown'),
                'action' => 'logout',
                'module' => 'auth',
                'status' => 'success',
                'description' => 'Logout requested but no active session row found',
            ]);
        }
    } else {
        auditLog([
            'pdo' => $pdo,
            'user_id' => isset($sessionInfo['user_id']) ? (int)$sessionInfo['user_id'] : null,
            'role' => (string)($sessionInfo['role'] ?? 'unknown'),
            'action' => 'logout',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Logout attempted but session delete query failed',
        ]);
    }

    // Always return success for logout
    $response->success([
        'message' => 'You have been logged out successfully'
    ], 'Logout successful', 200);

} catch (PDOException $e) {
    // Even on error, return success for logout
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Logged out successfully',
        'data' => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    
} catch (Exception $e) {
    // Even on error, return success for logout
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Logged out successfully',
        'data' => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

ob_end_flush();
?>
