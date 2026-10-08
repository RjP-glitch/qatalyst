<?php
/**
 * POST /api/update-school-logo.php
 * Saves the school logo (base64) to the authenticated user's record in the users table.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

function jsonSuccess(array $data = [], string $message = 'Success', int $code = 200): void {
    http_response_code($code);
    echo json_encode(['success' => true, 'message' => $message, 'data' => $data]);
    exit;
}

function jsonError(string $message, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $user = authenticate('portal_user');
    if (!$user) jsonError('Unauthorized.', 401);
    requireSchoolApproval($user);

    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) jsonError('Invalid JSON.', 422);

    $logoDataUrl = trim((string)($body['logo_data_url'] ?? ''));
    if (!$logoDataUrl) jsonError('Missing logo_data_url.', 422);

    // Basic validation — must be a data URL image
    if (!preg_match('/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i', $logoDataUrl)) {
        jsonError('Invalid image format. Must be a base64 data URL.', 422);
    }

    // Rough size check — base64 of 2MB = ~2.7MB string
    if (strlen($logoDataUrl) > 3000000) {
        jsonError('Logo image is too large. Please use an image under 2MB.', 422);
    }

    $pdo = getDB();
    $userId = (int)$user['id'];

    // Check which column name your users table uses
    // Common names: school_logo, logo, school_logo_url, logo_data_url
    // Change 'school_logo' below to match your actual column name
    $stmt = $pdo->prepare(
        "UPDATE users SET school_logo = :logo WHERE id = :id LIMIT 1"
    );
    $stmt->execute([
        ':logo' => $logoDataUrl,
        ':id'   => $userId,
    ]);

    if ($stmt->rowCount() === 0) {
        jsonError('User not found or logo unchanged.', 404);
    }

    jsonSuccess(['logo_data_url' => $logoDataUrl], 'School logo updated successfully.');

} catch (Throwable $e) {
    error_log('update-school-logo.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
