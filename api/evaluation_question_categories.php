<?php
/**
 * evaluation_question_categories.php — Manage Evaluation Question Categories
 *
 * GET  — Returns all active categories ordered by display_order
 *        Response: { success: true, categories: [{id, name, description, display_order}] }
 *
 * POST — Insert a new category
 *        Body: { name: string, description?: string }
 *        Response: { success: true, id: int, message: string }
 *
 * Returns:
 *   { success: false, message: '<reason>' } on error
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ── Auth ──────────────────────────────────────────────────────────────────────
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('programs', $authUser);

try {
    $pdo = getDB();
    auditEnsureTable($pdo);

    $auditCategory = static function (string $status, string $description) use ($pdo, $authUser): void {
        auditLog([
            'pdo'         => $pdo,
            'user_id'     => (int)($authUser['id'] ?? 0),
            'role'        => (string)($authUser['role'] ?? 'viewer'),
            'action'      => 'evaluation_category',
            'module'      => 'programs',
            'status'      => $status,
            'description' => $description,
        ]);
    };

    // ── GET — return all active categories ────────────────────────────────────
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $stmt = $pdo->query("
            SELECT id, name, description, display_order
            FROM evaluation_question_categories
            WHERE is_active = 1
            ORDER BY display_order ASC, name ASC
        ");
        echo json_encode([
            'success'    => true,
            'categories' => $stmt->fetchAll(PDO::FETCH_ASSOC),
        ]);
        exit;
    }

    // ── POST — insert a new category ──────────────────────────────────────────
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $raw  = file_get_contents('php://input');
        $body = json_decode($raw, true);

        if (!$body || !is_array($body)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid JSON body.']);
            exit;
        }

        $name        = trim($body['name']        ?? '');
        $description = trim($body['description'] ?? '');

        if ($name === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Category name is required.']);
            exit;
        }

        if (mb_strlen($name) > 255) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Category name must be 255 characters or fewer.']);
            exit;
        }

        // ── Duplicate check (case-insensitive) ────────────────────────────────
        $check = $pdo->prepare("
            SELECT id FROM evaluation_question_categories
            WHERE LOWER(name) = LOWER(?)
        ");
        $check->execute([$name]);
        $existing = $check->fetch(PDO::FETCH_ASSOC);

        if ($existing) {
            // Not an error — return success so the UI can use the existing entry
            echo json_encode([
                'success' => true,
                'id'      => (int)$existing['id'],
                'message' => "Category \"{$name}\" already exists.",
            ]);
            exit;
        }

        // ── Get next display_order ─────────────────────────────────────────────
        $maxOrder = (int)$pdo->query("
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM evaluation_question_categories
        ")->fetchColumn();

        // ── Insert ────────────────────────────────────────────────────────────
        $insert = $pdo->prepare("
            INSERT INTO evaluation_question_categories
                (name, description, display_order, is_active)
            VALUES
                (:name, :description, :display_order, 1)
        ");
        $insert->execute([
            ':name'          => $name,
            ':description'   => $description ?: null,
            ':display_order' => $maxOrder,
        ]);

        $newId = (int)$pdo->lastInsertId();

        $auditCategory(
            'success',
            "New evaluation category created | id={$newId} | name={$name} | created_by=" . (int)($authUser['id'] ?? 0)
        );

        echo json_encode([
            'success' => true,
            'id'      => $newId,
            'message' => "Category \"{$name}\" created successfully.",
        ]);
        exit;
    }

    // ── Method not allowed ────────────────────────────────────────────────────
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);

} catch (PDOException $e) {
    error_log('[evaluation_question_categories.php] DB error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error. Please try again.']);
} catch (Throwable $e) {
    error_log('[evaluation_question_categories.php] Error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}