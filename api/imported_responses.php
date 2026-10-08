<?php
/**
 * Imported Responses Summary API
 * GET /api/imported_responses.php
 *
 * Returns the total number of responses imported from Excel
 * (source_type = 'excel') across all evaluation_programs.
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

try {
    $pdo = getDB();
    if (!$pdo || !($pdo instanceof PDO)) {
        throw new Exception('Database connection failed');
    }

    $stmt = $pdo->query("
        SELECT
            COUNT(*)                          AS total_imports,
            COALESCE(SUM(total_responses), 0) AS total_responses
        FROM evaluation_programs
        WHERE source_type = 'excel'
    ");
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    echo json_encode([
        'success'          => true,
        'total_imports'    => intval($row['total_imports']),
        'total_responses'  => intval($row['total_responses']),
    ]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>
