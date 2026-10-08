<?php
/**
 * QAME Super Categories API
 * 
 * GET    /qame_categories.php              - List all super categories with mappings
 * GET    /qame_categories.php?id=1         - Get single super category with mappings
 * POST   /qame_categories.php              - Create super category
 * PUT    /qame_categories.php              - Update super category
 * DELETE /qame_categories.php?id=1         - Delete super category
 * 
 * POST   /qame_categories.php?action=map   - Add category mapping
 * DELETE /qame_categories.php?action=unmap&super_id=1&category_id=2 - Remove mapping
 */

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
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


try {
    $pdo = getDB();
    $method = $_SERVER['REQUEST_METHOD'];
    $action = $_GET['action'] ?? null;

    // ══════════════════════════════════════════════════════════════════════════
    // GET - List super categories with their mapped sub-categories
    // ══════════════════════════════════════════════════════════════════════════
    if ($method === 'GET') {
        // Reading QAME categories only requires 'programs' permission
        requirePermission('programs', $authUser);
        $id = isset($_GET['id']) ? intval($_GET['id']) : null;
        
        if ($id) {
            // Get single super category
            $stmt = $pdo->prepare("
                SELECT * FROM qame_super_categories WHERE id = ?
            ");
            $stmt->execute([$id]);
            $superCategory = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$superCategory) {
                echo json_encode(['success' => false, 'message' => 'Super category not found']);
                exit;
            }
            
            // Get mapped categories
            $stmt = $pdo->prepare("
                SELECT cm.id as mapping_id, cm.weight, eqc.*
                FROM qame_category_mappings cm
                JOIN evaluation_question_categories eqc ON eqc.id = cm.category_id
                WHERE cm.super_category_id = ?
                ORDER BY eqc.display_order
            ");
            $stmt->execute([$id]);
            $superCategory['mapped_categories'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode(['success' => true, 'data' => $superCategory]);
            exit;
        }
        
        // Get all super categories
        $stmt = $pdo->query("
            SELECT * FROM qame_super_categories 
            ORDER BY display_order, id
        ");
        $superCategories = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        // Get mappings for each super category
        foreach ($superCategories as &$sc) {
            $stmt = $pdo->prepare("
                SELECT cm.id as mapping_id, cm.weight, eqc.id, eqc.name, eqc.description, eqc.display_order
                FROM qame_category_mappings cm
                JOIN evaluation_question_categories eqc ON eqc.id = cm.category_id
                WHERE cm.super_category_id = ?
                ORDER BY eqc.display_order
            ");
            $stmt->execute([$sc['id']]);
            $sc['mapped_categories'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
        
        // Also get all available categories for the UI
        $stmt = $pdo->query("
            SELECT id, name, description, display_order 
            FROM evaluation_question_categories 
            WHERE is_active = 1
            ORDER BY display_order
        ");
        $allCategories = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        echo json_encode([
            'success' => true, 
            'data' => $superCategories,
            'available_categories' => $allCategories
        ]);
        exit;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POST - Create super category or add mapping
    // ══════════════════════════════════════════════════════════════════════════
    if ($method === 'POST') {
        // Modifying QAME categories requires 'settings' permission
        requirePermission('settings', $authUser);
        $body = json_decode(file_get_contents('php://input'), true);
        
        // Handle mapping action
        if ($action === 'map') {
            $superId = intval($body['super_category_id'] ?? 0);
            $categoryId = intval($body['category_id'] ?? 0);
            $weight = floatval($body['weight'] ?? 1.0);
            
            if (!$superId || !$categoryId) {
                echo json_encode(['success' => false, 'message' => 'super_category_id and category_id required']);
                exit;
            }
            
            // Check if mapping already exists
            $stmt = $pdo->prepare("SELECT id FROM qame_category_mappings WHERE super_category_id = ? AND category_id = ?");
            $stmt->execute([$superId, $categoryId]);
            if ($stmt->fetch()) {
                echo json_encode(['success' => false, 'message' => 'Mapping already exists']);
                exit;
            }
            
            $stmt = $pdo->prepare("
                INSERT INTO qame_category_mappings (super_category_id, category_id, weight)
                VALUES (?, ?, ?)
            ");
            $stmt->execute([$superId, $categoryId, $weight]);
            
            echo json_encode(['success' => true, 'message' => 'Category mapped successfully', 'mapping_id' => $pdo->lastInsertId()]);
            exit;
        }
        
        // Create new super category
        $code = strtoupper(trim($body['code'] ?? ''));
        $name = trim($body['name'] ?? '');
        $description = trim($body['description'] ?? '');
        $icon = trim($body['icon'] ?? 'fa-star');
        $color = trim($body['color'] ?? '#1e3a8a');
        $displayOrder = intval($body['display_order'] ?? 0);
        
        if (!$code || !$name) {
            echo json_encode(['success' => false, 'message' => 'code and name are required']);
            exit;
        }
        
        // Check if code already exists
        $stmt = $pdo->prepare("SELECT id FROM qame_super_categories WHERE code = ?");
        $stmt->execute([$code]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => 'A super category with this code already exists']);
            exit;
        }
        
        // Auto-assign display order if not provided
        if ($displayOrder === 0) {
            $stmt = $pdo->query("SELECT COALESCE(MAX(display_order), 0) + 1 FROM qame_super_categories");
            $displayOrder = intval($stmt->fetchColumn());
        }
        
        $stmt = $pdo->prepare("
            INSERT INTO qame_super_categories (code, name, description, icon, color, display_order)
            VALUES (?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([$code, $name, $description, $icon, $color, $displayOrder]);
        $newId = $pdo->lastInsertId();
        
        // Handle initial category mappings if provided
        if (!empty($body['category_ids']) && is_array($body['category_ids'])) {
            $mapStmt = $pdo->prepare("INSERT INTO qame_category_mappings (super_category_id, category_id) VALUES (?, ?)");
            foreach ($body['category_ids'] as $catId) {
                try {
                    $mapStmt->execute([$newId, intval($catId)]);
                } catch (Exception $e) {
                    // Ignore duplicate mapping errors
                }
            }
        }
        
        // Fetch the created record
        $stmt = $pdo->prepare("SELECT * FROM qame_super_categories WHERE id = ?");
        $stmt->execute([$newId]);
        $created = $stmt->fetch(PDO::FETCH_ASSOC);
        
        echo json_encode(['success' => true, 'message' => 'Super category created', 'data' => $created]);
        exit;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUT - Update super category
    // ══════════════════════════════════════════════════════════════════════════
    if ($method === 'PUT') {
        // Modifying QAME categories requires 'settings' permission
        requirePermission('settings', $authUser);
        $body = json_decode(file_get_contents('php://input'), true);
        $id = intval($body['id'] ?? 0);
        
        if (!$id) {
            echo json_encode(['success' => false, 'message' => 'id is required']);
            exit;
        }
        
        $code = strtoupper(trim($body['code'] ?? ''));
        $name = trim($body['name'] ?? '');
        $description = trim($body['description'] ?? '');
        $icon = trim($body['icon'] ?? 'fa-star');
        $color = trim($body['color'] ?? '#1e3a8a');
        $displayOrder = intval($body['display_order'] ?? 0);
        $isActive = isset($body['is_active']) ? intval($body['is_active']) : 1;
        
        if (!$code || !$name) {
            echo json_encode(['success' => false, 'message' => 'code and name are required']);
            exit;
        }
        
        // Check if code exists for another record
        $stmt = $pdo->prepare("SELECT id FROM qame_super_categories WHERE code = ? AND id != ?");
        $stmt->execute([$code, $id]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => 'Another super category with this code already exists']);
            exit;
        }
        
        $stmt = $pdo->prepare("
            UPDATE qame_super_categories 
            SET code = ?, name = ?, description = ?, icon = ?, color = ?, display_order = ?, is_active = ?
            WHERE id = ?
        ");
        $stmt->execute([$code, $name, $description, $icon, $color, $displayOrder, $isActive, $id]);
        
        // Handle category mappings update if provided
        if (isset($body['category_ids']) && is_array($body['category_ids'])) {
            // Remove existing mappings
            $stmt = $pdo->prepare("DELETE FROM qame_category_mappings WHERE super_category_id = ?");
            $stmt->execute([$id]);
            
            // Add new mappings
            $mapStmt = $pdo->prepare("INSERT INTO qame_category_mappings (super_category_id, category_id) VALUES (?, ?)");
            foreach ($body['category_ids'] as $catId) {
                try {
                    $mapStmt->execute([$id, intval($catId)]);
                } catch (Exception $e) {
                    // Ignore duplicate mapping errors
                }
            }
        }
        
        // Fetch the updated record
        $stmt = $pdo->prepare("SELECT * FROM qame_super_categories WHERE id = ?");
        $stmt->execute([$id]);
        $updated = $stmt->fetch(PDO::FETCH_ASSOC);
        
        echo json_encode(['success' => true, 'message' => 'Super category updated', 'data' => $updated]);
        exit;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DELETE - Delete super category or remove mapping
    // ══════════════════════════════════════════════════════════════════════════
    if ($method === 'DELETE') {
        // Modifying QAME categories requires 'settings' permission
        requirePermission('settings', $authUser);
        // Handle unmap action
        if ($action === 'unmap') {
            $superId = intval($_GET['super_id'] ?? 0);
            $categoryId = intval($_GET['category_id'] ?? 0);
            
            if (!$superId || !$categoryId) {
                echo json_encode(['success' => false, 'message' => 'super_id and category_id required']);
                exit;
            }
            
            $stmt = $pdo->prepare("DELETE FROM qame_category_mappings WHERE super_category_id = ? AND category_id = ?");
            $stmt->execute([$superId, $categoryId]);
            
            echo json_encode(['success' => true, 'message' => 'Category mapping removed']);
            exit;
        }
        
        // Delete super category
        $id = intval($_GET['id'] ?? 0);
        if (!$id) {
            echo json_encode(['success' => false, 'message' => 'id is required']);
            exit;
        }
        
        // Mappings will be deleted automatically via CASCADE
        $stmt = $pdo->prepare("DELETE FROM qame_super_categories WHERE id = ?");
        $stmt->execute([$id]);
        
        echo json_encode(['success' => true, 'message' => 'Super category deleted']);
        exit;
    }

    echo json_encode(['success' => false, 'message' => 'Method not allowed']);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}