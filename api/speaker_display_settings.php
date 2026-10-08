<?php
/**
 * Speaker Display Settings API
 * 
 * GET    /speaker_display_settings.php                  – Get settings (global or for a workshop)
 * GET    /speaker_display_settings.php?workshop_id=5    – Get effective settings for workshop 5
 * POST   /speaker_display_settings.php                  – Create or update settings
 * DELETE /speaker_display_settings.php?workshop_id=5    – Reset workshop settings to global default
 *
 * Request body for POST:
 * {
 *   "workshop_id":     null | int,   // null = global default
 *   "show_name":       0 | 1,
 *   "show_rating":     0 | 1,
 *   "show_rank":       0 | 1,
 *   "show_badge_label":0 | 1,
 *   "highlight_top":   0 | 1
 * }
 */

// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$pdo = getDB();
if (!$pdo || !($pdo instanceof PDO)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database connection failed']);
    exit;
}

// ── Helper: resolve effective settings for a workshop ─────────────────
function getEffectiveSettings(PDO $pdo, ?int $workshopId): array {
    if ($workshopId !== null) {
        // Resolve workshop settings with global fallback without relying on SQL views.
        $stmt = $pdo->prepare("
            SELECT
                ? AS workshop_id,
                COALESCE(ws.show_name, g.show_name, 1) AS show_name,
                COALESCE(ws.show_rating, g.show_rating, 1) AS show_rating,
                COALESCE(ws.show_rank, g.show_rank, 1) AS show_rank,
                COALESCE(ws.show_badge_label, g.show_badge_label, 1) AS show_badge_label,
                COALESCE(ws.highlight_top, g.highlight_top, 1) AS highlight_top,
                COALESCE(ws.show_response_count, g.show_response_count, 1) AS show_response_count
            FROM (SELECT 1) AS seed
            LEFT JOIN speaker_display_settings AS ws ON ws.workshop_id = ?
            LEFT JOIN speaker_display_settings AS g ON g.workshop_id IS NULL
            LIMIT 1
        ");
        $stmt->execute([$workshopId, $workshopId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) return $row;
    }

    // Return the global row
    $stmt = $pdo->query("SELECT * FROM speaker_display_settings WHERE workshop_id IS NULL LIMIT 1");
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: [
        'workshop_id'      => null,
        'show_name'           => 1,
        'show_rating'         => 1,
        'show_rank'           => 1,
        'show_badge_label'    => 1,
        'highlight_top'       => 1,
        'show_response_count' => 1,
    ];
}

try {
    $method = $_SERVER['REQUEST_METHOD'];

    // ── GET ───────────────────────────────────────────────────────────
    if ($method === 'GET') {
        // Reading settings only requires 'programs' permission
        requirePermission('programs', $authUser);
        $workshopId = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : null;
        $effective  = getEffectiveSettings($pdo, $workshopId);

        // Also fetch the raw workshop-specific row (if any) so the UI knows
        // whether an override exists or whether the global default is in effect.
        $raw = null;
        if ($workshopId !== null) {
            $stmt = $pdo->prepare("SELECT * FROM speaker_display_settings WHERE workshop_id = ?");
            $stmt->execute([$workshopId]);
            $raw = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        }

        // Global default row
        $globalStmt = $pdo->query("SELECT * FROM speaker_display_settings WHERE workshop_id IS NULL LIMIT 1");
        $global = $globalStmt->fetch(PDO::FETCH_ASSOC) ?: null;

        echo json_encode([
            'success'            => true,
            'data' => [
                'effective'          => $effective,   // resolved settings to use
                'workshop_override'  => $raw,          // null if no override exists
                'global_default'     => $global,
            ]
        ]);
        exit;
    }

    // ── POST (upsert) ─────────────────────────────────────────────────
    if ($method === 'POST') {
        // Modifying settings requires 'settings' permission
        requirePermission('settings', $authUser);
        $body          = json_decode(file_get_contents('php://input'), true) ?? [];
        $workshopId    = array_key_exists('workshop_id', $body) 
                            ? ($body['workshop_id'] === null ? null : intval($body['workshop_id'])) 
                            : null;
        $showName      = isset($body['show_name'])             ? (intval($body['show_name'])             ? 1 : 0) : 1;
        $showRating    = isset($body['show_rating'])           ? (intval($body['show_rating'])           ? 1 : 0) : 1;
        $showRank      = isset($body['show_rank'])             ? (intval($body['show_rank'])             ? 1 : 0) : 1;
        $showBadge     = isset($body['show_badge_label'])      ? (intval($body['show_badge_label'])      ? 1 : 0) : 1;
        $highlightTop  = isset($body['highlight_top'])         ? (intval($body['highlight_top'])         ? 1 : 0) : 1;
        $showRespCount = isset($body['show_response_count'])   ? (intval($body['show_response_count'])   ? 1 : 0) : 1;

        // Validate workshop exists (if not null)
        if ($workshopId !== null) {
            $wStmt = $pdo->prepare("SELECT id FROM workshops WHERE id = ?");
            $wStmt->execute([$workshopId]);
            if (!$wStmt->fetch()) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Workshop not found']);
                exit;
            }
        }

        // Handle NULL workshop_id (global settings) separately because 
        // ON DUPLICATE KEY doesn't work with NULL values (NULL != NULL in SQL)
        if ($workshopId === null) {
            // Check if global row exists
            $checkStmt = $pdo->query("SELECT id FROM speaker_display_settings WHERE workshop_id IS NULL LIMIT 1");
            $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existing) {
                // UPDATE existing global row
                $stmt = $pdo->prepare("
                    UPDATE speaker_display_settings 
                    SET show_name = ?, show_rating = ?, show_rank = ?, show_badge_label = ?, highlight_top = ?, show_response_count = ?
                    WHERE workshop_id IS NULL
                ");
                $stmt->execute([$showName, $showRating, $showRank, $showBadge, $highlightTop, $showRespCount]);
            } else {
                // INSERT new global row
                $stmt = $pdo->prepare("
                    INSERT INTO speaker_display_settings
                        (workshop_id, show_name, show_rating, show_rank, show_badge_label, highlight_top, show_response_count)
                    VALUES (NULL, ?, ?, ?, ?, ?, ?)
                ");
                $stmt->execute([$showName, $showRating, $showRank, $showBadge, $highlightTop, $showRespCount]);
            }
        } else {
            // For specific workshop_id, ON DUPLICATE KEY works fine
            $stmt = $pdo->prepare("
                INSERT INTO speaker_display_settings
                    (workshop_id, show_name, show_rating, show_rank, show_badge_label, highlight_top, show_response_count)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    show_name           = VALUES(show_name),
                    show_rating         = VALUES(show_rating),
                    show_rank           = VALUES(show_rank),
                    show_badge_label    = VALUES(show_badge_label),
                    highlight_top       = VALUES(highlight_top),
                    show_response_count = VALUES(show_response_count)
            ");
            $stmt->execute([$workshopId, $showName, $showRating, $showRank, $showBadge, $highlightTop, $showRespCount]);
        }

        // Return the saved row
        if ($workshopId !== null) {
            $fetchStmt = $pdo->prepare("SELECT * FROM speaker_display_settings WHERE workshop_id = ?");
            $fetchStmt->execute([$workshopId]);
        } else {
            $fetchStmt = $pdo->query("SELECT * FROM speaker_display_settings WHERE workshop_id IS NULL LIMIT 1");
        }
        $saved = $fetchStmt->fetch(PDO::FETCH_ASSOC);

        echo json_encode([
            'success' => true,
            'message' => 'Settings saved successfully',
            'data'    => $saved
        ]);
        exit;
    }

    // ── DELETE (remove workshop override, revert to global) ───────────
    if ($method === 'DELETE') {
        // Modifying settings requires 'settings' permission
        requirePermission('settings', $authUser);
        $workshopId = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : null;
        if ($workshopId === null) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'workshop_id is required for DELETE (cannot delete global default)']);
            exit;
        }

        $stmt = $pdo->prepare("DELETE FROM speaker_display_settings WHERE workshop_id = ?");
        $stmt->execute([$workshopId]);

        echo json_encode([
            'success' => true,
            'message' => 'Workshop-specific settings removed. Global default will now apply.'
        ]);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>