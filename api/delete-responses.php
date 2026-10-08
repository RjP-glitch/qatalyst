<?php
// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';
require_once $base_path . '/config/audit_log.php';

// Connect to database
$pdo = getDB();

if (!$pdo || !($pdo instanceof PDO)) {
    throw new Exception('Database connection failed');
}



// Check authentication
$user = authenticate();
if (!$user) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit();
}

// Require 'programs' permission to delete responses
requirePermission('programs', $user);

auditEnsureTable($pdo);

$auditDeleteResponse = static function ($status, $description, $responseId = null) use ($pdo, $user): void {
    $suffix = $responseId !== null ? (' | response_id=' . (int)$responseId) : '';
    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)($user['id'] ?? 0),
        'role' => (string)($user['role'] ?? 'viewer'),
        'action' => 'response_delete',
        'module' => 'programs',
        'status' => (string)$status,
        'description' => (string)$description . $suffix,
    ]);
};

try {
    $data = json_decode(file_get_contents('php://input'), true);
    $response_id = isset($data['response_id']) ? intval($data['response_id']) : 0;
    
    if ($response_id <= 0) {
        $auditDeleteResponse('failed', 'Delete failed: invalid response id payload', $response_id);
        throw new Exception('Invalid response ID');
    }
    
    $pdo->beginTransaction();
    
    // Delete resource speaker ratings first (if any)
    $stmt = $pdo->prepare("DELETE FROM resource_speaker_ratings WHERE evaluation_response_id = ?");
    $stmt->execute([$response_id]);
    
    // Delete the evaluation response
    $stmt = $pdo->prepare("DELETE FROM evaluation_responses WHERE id = ?");
    $stmt->execute([$response_id]);
    
    if ($stmt->rowCount() === 0) {
        $auditDeleteResponse('failed', 'Delete failed: response not found', $response_id);
        throw new Exception('Response not found');
    }
    
    $pdo->commit();

    $auditDeleteResponse('success', 'Evaluation response deleted', $response_id);
    
    echo json_encode([
        'success' => true,
        'message' => 'Response deleted successfully'
    ]);
    
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    $auditDeleteResponse(
        'failed',
        'Delete failed with exception: ' . substr($e->getMessage(), 0, 180),
        isset($response_id) ? $response_id : null
    );
    
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}
?>