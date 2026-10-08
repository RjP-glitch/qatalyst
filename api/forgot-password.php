<?php
/**
 * Forgot Password API Endpoint
 * POST /api/forgot-password.php
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
    // Include required files - FIXED PATHS
    $base_path = dirname(__DIR__);
    
    // Check if files exist
    if (!file_exists($base_path . '/config/database.php')) {
        throw new Exception('database.php not found');
    }
    
    require_once $base_path . '/config/database.php';
    require_once $base_path . '/config/audit_log.php';
    require_once $base_path . '/models/User.php';
    require_once $base_path . '/models/PasswordResetToken.php';
    require_once $base_path . '/helpers/EmailHelper.php';  // ADD THIS LINE
    
    // Check if Response class exists, create inline if not
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
    $email = isset($data['email']) ? trim($data['email']) : null;

    if (!$email) {
        $response->error('Email is required', ['email' => 'Email is required'], 400);
    }

    // Validate email format
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $response->error('Invalid email format', ['email' => 'Please enter a valid email'], 400);
    }

    // Connect to database
    $pdo = getDB();

    if (!$pdo || !($pdo instanceof PDO)) {
        $response->error('Database connection failed', [], 500);
    }
    auditEnsureTable($pdo);

    // Check if user exists
    $user = new User($pdo);
    $userData = $user->getUserByEmail($email);

    // DEVELOPMENT MODE - Set to false in production
    $DEVELOPMENT_MODE = true;

    if (!$userData) {
        auditLog([
            'pdo' => $pdo,
            'role' => 'unknown',
            'action' => 'password_reset_request',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Password reset requested for non-existent email: ' . $email,
        ]);
        if ($DEVELOPMENT_MODE) {
            // Shows actual error - email not found
            $response->error('No account found with this email address', [], 404);
        } else {
            // Returns success anyway - prevents email enumeration
            $response->success([
                'message' => 'If an account exists with this email, a password reset code has been sent.'
            ], 'Password reset request processed', 200);
        }
        exit;
    }

    // Create reset token
    $resetToken = new PasswordResetToken($pdo);
    $tokenData = $resetToken->createResetToken($userData['id']);

    if (!$tokenData) {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)$userData['id'],
            'role' => (string)($userData['role'] ?? 'viewer'),
            'action' => 'password_reset_request',
            'module' => 'auth',
            'status' => 'failed',
            'description' => 'Failed to create password reset token',
        ]);
        $response->error('Failed to create reset token', [], 500);
    }

    // Log the code to server error log for debugging
    // SEND EMAIL - ADD THIS SECTION
    $emailSent = false;
    try {
        $emailHelper = new EmailHelper();
        $userName = $userData['full_name'] ?? 'User';
        $emailSent = $emailHelper->sendPasswordResetCode($email, $tokenData['code'], $userName);
        
        if (!$emailSent) {
            // Continue anyway - token is created, user can still reset if they have the code
        }
    } catch (Exception $emailError) {
        // Continue anyway - don't fail the entire request due to email issues
    }

    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)$userData['id'],
        'role' => (string)($userData['role'] ?? 'viewer'),
        'action' => 'password_reset_request',
        'module' => 'auth',
        'status' => !empty($emailSent) ? 'success' : 'pending',
        'description' => !empty($emailSent)
            ? 'Password reset code issued and email sent'
            : 'Password reset code issued but email delivery may have failed',
    ]);

    // Send success response (code is logged, not returned to client)
    $response->success([
        'token' => $tokenData['token'],
        'message' => 'A 4-digit verification code has been sent to your email'
    ], 'Password reset code sent', 200);

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