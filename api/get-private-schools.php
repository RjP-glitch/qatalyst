<?php
/**
 * GET /api/get-private-schools.php
 * Returns all private schools with name and composed address
 * from private_schools_datasheet for the Indorsement Letter generator.
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
        SELECT
            id,
            school_id_no,
            name,
            levels,
            TRIM(CONCAT_WS(', ',
                NULLIF(TRIM(street_address), ''),
                NULLIF(TRIM(barangay), ''),
                NULLIF(TRIM(city), '')
            ))                                                  AS address
        FROM private_schools
        WHERE active = 1
        ORDER BY name ASC
    ");

    $schools = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode(['success' => true, 'data' => $schools]);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load private schools']);
}
