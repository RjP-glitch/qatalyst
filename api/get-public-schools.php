<?php
/**
 * GET /api/get-public-schools.php?district_id=1
 * GET /api/get-public-schools.php?type=private
 *
 * Returns schools for a given district (by district_id FK),
 * or all Private/SUC schools when ?type=private.
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

$type       = $_GET['type']        ?? null;
$districtId = isset($_GET['district_id']) ? sanitizeInt($_GET['district_id']) : null;

try {
    $pdo = getDB();

    // ── ?type=private → return all Private + SUC schools ──────────────────────
    if ($type === 'private') {
        $stmt = $pdo->prepare("
            SELECT id, name,
                   TRIM(SUBSTRING_INDEX(school_id_no, '/', 1)) AS deped_school_id
            FROM   private_schools
            WHERE  active = 1
            ORDER  BY name ASC
        ");
        $stmt->execute();
        $schools = $stmt->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode(['success' => true, 'data' => $schools]);
        exit;
    }

    // ── ?district_id=N → return public schools for that district ──────────────
    if ($districtId === null || $districtId === '') {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'district_id is required']);
        exit;
    }

    // district_id = 0 means SDO-level / no district assigned
    if ($districtId === 0) {
        $stmt = $pdo->prepare("
            SELECT MIN(id) AS id,
                   school_name AS name,
                   TRIM(MAX(school_id)) AS deped_school_id
            FROM   public_schools
            WHERE  district_id IS NULL
              AND  active = 1
            GROUP  BY school_name
            ORDER  BY school_name ASC
        ");
        $stmt->execute();
    } else {
        $stmt = $pdo->prepare("
            SELECT MIN(id) AS id,
                   school_name AS name,
                   TRIM(MAX(school_id)) AS deped_school_id
            FROM   public_schools
            WHERE  district_id = ?
              AND  active = 1
            GROUP  BY school_name
            ORDER  BY school_name ASC
        ");
        $stmt->execute([$districtId]);
    }

    $schools = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode(['success' => true, 'data' => $schools]);

} catch (Throwable $e) {
    error_log('get-public-schools.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load public schools']);
}
