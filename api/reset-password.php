<?php
/**
 * Reset Password API Endpoint
 * POST /api/reset-password.php
 */

// Prevent any output before JSON
error_reporting(0);
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
    require_once $base_path . '/models/User.php';
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
    $password = isset($data['password']) ? $data['password'] : null;
    $password_confirm = isset($data['password_confirm']) ? $data['password_confirm'] : null;

    if (!$token || !$code || !$password || !$password_confirm) {
        $response->error('All fields are required', [], 400);
    }

    // Validate passwords match
    if ($password !== $password_confirm) {
        $response->error('Passwords do not match', ['password' => 'Passwords must match'], 400);
    }

    // Validate password strength
    if (strlen($password) < 8) {
        $response->error('Password must be at least 8 characters', ['password' => 'Password too short'], 400);
    }

    if (!preg_match('/[A-Z]/', $password)) {
        $response->error('Password must contain at least one uppercase letter', ['password' => 'Missing uppercase letter'], 400);
    }

    if (!preg_match('/[a-z]/', $password)) {
        $response->error('Password must contain at least one lowercase letter', ['password' => 'Missing lowercase letter'], 400);
    }

    if (!preg_match('/\d/', $password)) {
        $response->error('Password must contain at least one number', ['password' => 'Missing number'], 400);
    }

    // Connect to database
    $pdo = getDB();

    if (!$pdo || !($pdo instanceof PDO)) {
        $response->error('Database connection failed', [], 500);
    }
    auditEnsureTable($pdo);

    // Verify the token and code
    $resetToken = new PasswordResetToken($pdo);
    $tokenData = $resetToken->verifyResetCode($token, $code);

    if (!$tokenData) {
        auditLog([
            'pdo' => $pdo,
            'action' => 'password_reset_complete',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Password reset failed due to invalid or expired verification code',
        ]);
        $response->error('Invalid or expired verification code', [], 400);
    }

    // Hash the new password
    $hashed_password = password_hash($password, PASSWORD_BCRYPT);

    // Update user password
    $user = new User($pdo);
    $updated = $user->updateUser($tokenData['user_id'], [
        'password' => $hashed_password
    ]);

    if (!$updated) {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)$tokenData['user_id'],
            'role' => 'viewer',
            'action' => 'password_reset_complete',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Password reset failed while updating user password',
        ]);
        $response->error('Failed to update password', [], 500);
    }

    // Mark token as used
    $resetToken->markTokenAsUsed($token);

    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)$tokenData['user_id'],
        'role' => 'viewer',
        'action' => 'password_reset_complete',
        'module' => 'auth',
        'status' => 'success',
        'description' => 'Password was reset successfully',
    ]);

    $response->success([
        'message' => 'Password reset successfully'
    ], 'Password reset successful', 200);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Database error occurred',
        'errors' => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage(),
        'errors' => []
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

ob_end_flush();
?>