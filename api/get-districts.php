<?php
/**
 * GET /api/get-districts.php
 * Returns all districts for the cascading dropdown.
 * Public endpoint — no auth required (read-only reference data).
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/security.php';

setCorsHeaders();
handlePreflight();
setSecurityHeaders();
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

try {
    $pdo = getDB();

    $stmt = $pdo->query("
        SELECT id, name, supervisor
        FROM districts
        ORDER BY
            CAST(REGEXP_REPLACE(name, '[^0-9]', '') AS UNSIGNED) ASC,
            name ASC
    ");

    $districts = $stmt->fetchAll();

    echo json_encode([
        'success' => true,
        'data'    => $districts
    ]);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load districts']);
}
