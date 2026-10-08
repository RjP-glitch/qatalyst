<?php
/**
 * Verify Reset Code API Endpoint
 * POST /api/verify-reset-code.php
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
    require_once $base_path . '/models/PasswordResetToken.php';
    
    // Check if Response class exists
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

    // Get POST data
    $input = file_get_contents("php://input");
    $data = json_decode($input, true);

    if (json_last_error() !== JSON_ERROR_NONE) {
        $response->error('Invalid JSON input', ['json_error' => json_last_error_msg()], 400);
    }

    // Validate input
    $token = isset($data['token']) ? trim($data['token']) : null;
    $code = isset($data['code']) ? trim($data['code']) : null;

    if (!$token) {
        $response->error('Reset token is missing. Please restart the password reset process.', ['field' => 'token'], 400);
    }
    
    if (!$code) {
        $response->error('Verification code is required', ['field' => 'code'], 400);
    }

    // Validate code format (6 digits)
    if (!preg_match('/^\d{6}$/', $code)) {
        $response->error('Invalid code format. Please enter 6 digits.', ['field' => 'code'], 400);
    }

    // Connect to database
    $pdo = getDB();

    if (!$pdo || !($pdo instanceof PDO)) {
        $response->error('Database connection failed', [], 500);
    }
    auditEnsureTable($pdo);

    
    // First, let's check what tokens exist in the database
    $checkQuery = "SELECT token, code, is_used, expires_at, 
                   (expires_at > NOW()) as is_valid_time,
                   NOW() as server_time
                   FROM password_reset_tokens 
                   WHERE token = :token";
    $checkStmt = $pdo->prepare($checkQuery);
    $checkStmt->bindParam(':token', $token, PDO::PARAM_STR);
    $checkStmt->execute();
    $existingToken = $checkStmt->fetch(PDO::FETCH_ASSOC);

    if ($existingToken) {
    } else {
    }

    // Verify the code
    $resetToken = new PasswordResetToken($pdo);
    $tokenData = $resetToken->verifyResetCode($token, $code);

    if (!$tokenData) {
        // Provide more detailed error message
        if ($existingToken) {
            if ($existingToken['is_used'] == 1) {
                auditLog([
                    'pdo' => $pdo,
                    'action' => 'password_reset_verify_code',
                    'module' => 'auth',
                    'status' => 'failed',
                    'description' => 'Reset code verification attempted with already used token',
                ]);
                $response->error('This verification code has already been used', [], 400);
            } elseif ($existingToken['is_valid_time'] == 0) {
                auditLog([
                    'pdo' => $pdo,
                    'action' => 'password_reset_verify_code',
                    'module' => 'auth',
                    'status' => 'failed',
                    'description' => 'Reset code verification attempted with expired token',
                ]);
                $response->error('This verification code has expired', [], 400);
            } elseif ($existingToken['code'] !== $code) {
                auditLog([
                    'pdo' => $pdo,
                    'action' => 'password_reset_verify_code',
                    'module' => 'auth',
                    'status' => 'failed',
                    'description' => 'Reset code verification failed due to incorrect code',
                ]);
                $response->error('Incorrect verification code', [], 400);
            }
        }
        auditLog([
            'pdo' => $pdo,
            'action' => 'password_reset_verify_code',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Reset code verification failed due to invalid token/code pair',
        ]);
        
        $response->error('Invalid or expired verification code', [], 400);
    }

    auditLog([
        'pdo' => $pdo,
        'user_id' => isset($tokenData['user_id']) ? (int)$tokenData['user_id'] : null,
        'role' => 'viewer',
        'action' => 'password_reset_verify_code',
        'module' => 'auth',
        'status' => 'success',
        'description' => 'Reset code verified successfully',
    ]);

    $response->success([
        'verified' => true,
        'message' => 'Code verified successfully'
    ], 'Code verified', 200);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Database error occurred',
        'errors' => [],
        'debug' => $e->getMessage() // Remove in production
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage(),
        'errors' => [],
        'debug' => $e->getMessage() // Remove in production
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

ob_end_flush();
?>