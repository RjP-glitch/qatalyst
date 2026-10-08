<?php
/**
 * Total Responses Summary API
 * GET /api/total_responses.php
 *
 * Returns the total number of responses across ALL evaluation_programs
 * regardless of source_type (excel, online, merged).
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

header('Content-Type: application/json');

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Require dashboard permission (matches dashboard page access)
requirePermission('dashboard', $authUser);

try {
    $pdo = getDB();
    if (!$pdo || !($pdo instanceof PDO)) {
        throw new Exception('Database connection failed');
    }

    $stmt = $pdo->query("\n        SELECT\n            COUNT(*)                          AS total_programs,\n            COALESCE(SUM(total_responses), 0) AS total_responses\n        FROM evaluation_programs\n    ");
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    echo json_encode([
        'success'         => true,
        'total_programs'  => intval($row['total_programs'] ?? 0),
        'total_responses' => intval($row['total_responses'] ?? 0),
    ]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>
