<?php
/**
 * API Endpoint: rating_scales.php
 * Path: smme-api/api/rating_scales.php
 *
 * Returns all active rating scales grouped by type (category, speaker, overall).
 * Used by programs.js and workshop-dashboard.js to label scores dynamically.
 *
 * Usage:
 *   GET /api/rating_scales.php  → all active scales
 */

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

// Require authentication
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
            id,
            scale_type,
            min_score,
            max_score,
            level_of_agreement,
            descriptive_equivalent,
            display_order,
            is_active
        FROM rating_scales
        WHERE is_active = 1
        ORDER BY scale_type, display_order ASC
    ");

    $scales = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Cast numeric fields
    $scales = array_map(function($row) {
        return [
            'id'                     => (int)$row['id'],
            'scale_type'             => $row['scale_type'],
            'min_score'              => (float)$row['min_score'],
            'max_score'              => (float)$row['max_score'],
            'level_of_agreement'     => $row['level_of_agreement'],
            'descriptive_equivalent' => $row['descriptive_equivalent'],
            'display_order'          => (int)$row['display_order'],
            'is_active'              => (bool)$row['is_active'],
        ];
    }, $scales);

    echo json_encode([
        'success' => true,
        'scales'  => $scales,
    ]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Server error: ' . $e->getMessage()
    ]);
}
?>