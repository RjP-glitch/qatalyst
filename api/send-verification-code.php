<?php
/**
 * Send Verification Code API Endpoint
 * POST /api/send-verification-code.php
 */

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once '../config/database.php';
require_once '../api/Response.php';
require_once '../models/User.php';
require_once '../models/VerificationCode.php';
require_once '../helpers/EmailHelper.php';

$response = new Response();

// Get POST data
$data = json_decode(file_get_contents("php://input"), true);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    $response->error('Method not allowed', [], 405);
}

// Validate input
$user_id = isset($data['user_id']) ? intval($data['user_id']) : null;

if (!$user_id) {
    $response->error('User ID is required', ['user_id' => 'User ID is required']);
}

// Connect to database
$pdo = getDB();

// Get user
$user = new User($pdo);
$userData = $user->getUserById($user_id);

if (!$userData) {
    $response->error('User not found', [], 404);
}

// Generate and save verification code
$verificationCode = new VerificationCode($pdo);
$code = $verificationCode->generateCode($user_id);

if (!$code) {
    $response->error('Failed to generate verification code', [], 500);
}

// Send email
$emailHelper = new EmailHelper();
$emailSent = $emailHelper->sendVerificationCode(
    $userData['email'],
    $code,
    $userData['full_name'] ?? 'User'
);

// Log the code for demo purposes (remove in production)
$response->success([
    'user_id' => $user_id,
    'email' => $userData['email'],
    'message' => 'Verification code sent to your email'
], 'Verification code sent', 200);
?>