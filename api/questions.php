<?php
/**
 * Evaluation Questions API
 * GET    /questions.php?workshop_id=X   – list questions for a workshop
 * POST   /questions.php                 – create question  { workshop_id, category_id, question_text, question_type, select_options, display_order, is_for_speaker }
 * PUT    /questions.php                 – update question  { id, category_id, question_text, question_type, select_options, display_order, is_active, is_for_speaker }
 * DELETE /questions.php?id=X            – delete question
 */

// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

header('Content-Type: application/json');

// SECURITY: Require authentication
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Require 'settings' permission for questions management (create/update/delete)
$method = $_SERVER['REQUEST_METHOD'];
if (in_array($method, ['POST', 'PUT', 'DELETE'])) {
    requirePermission('settings', $authUser);
}

$pdo = getDB();
if (!$pdo || !($pdo instanceof PDO)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database connection failed']);
    exit();
}

try {
    $method = $_SERVER['REQUEST_METHOD'];

    // ── GET ──────────────────────────────────────────────────────────────────
    if ($method === 'GET') {
        $workshopId = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : 0;
        if (!$workshopId) {
            echo json_encode(['success' => false, 'message' => 'workshop_id required']);
            exit();
        }

        // Always merge workshop-specific questions with global (workshop_id=0) ones,
        // mirroring the logic in evaluation.php:
        //   - Find which categories already have workshop-specific questions.
        //   - For those categories → return only workshop-specific questions.
        //   - For all other categories → return global (workshop_id=0) questions.
        // This ensures Venue, Meal, and any other category without a custom override
        // always appears in the questions list.

        $wsqStmt = $pdo->prepare("
            SELECT DISTINCT category_id
            FROM evaluation_questions
            WHERE workshop_id = ?
        ");
        $wsqStmt->execute([$workshopId]);
        $workshopSpecificCats = $wsqStmt->fetchAll(PDO::FETCH_COLUMN);

        if (!empty($workshopSpecificCats)) {
            $ph = implode(',', array_fill(0, count($workshopSpecificCats), '?'));
            $stmt = $pdo->prepare("
                SELECT q.id, q.workshop_id, q.category_id, c.name AS category_name,
                       q.question_text, q.question_type, q.select_options,
                       q.is_active, q.is_for_speaker, q.created_at, q.updated_at, q.display_order
                FROM evaluation_questions q
                LEFT JOIN evaluation_question_categories c ON q.category_id = c.id
                WHERE (
                    (q.workshop_id = ? AND q.category_id IN ($ph))
                    OR
                    (q.workshop_id = 0 AND q.category_id NOT IN ($ph))
                )
                ORDER BY c.display_order ASC, q.display_order ASC, q.id ASC
            ");
            $params = array_merge([$workshopId], $workshopSpecificCats, $workshopSpecificCats);
            $stmt->execute($params);
        } else {
            // No workshop-specific questions at all — return all globals
            $stmt = $pdo->prepare("
                SELECT q.id, q.workshop_id, q.category_id, c.name AS category_name,
                       q.question_text, q.question_type, q.select_options,
                       q.is_active, q.is_for_speaker, q.created_at, q.updated_at, q.display_order
                FROM evaluation_questions q
                LEFT JOIN evaluation_question_categories c ON q.category_id = c.id
                WHERE q.workshop_id = 0
                ORDER BY c.display_order ASC, q.display_order ASC, q.id ASC
            ");
            $stmt->execute();
        }
        $questions = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Decode select_options JSON
        foreach ($questions as &$q) {
            if ($q['question_type'] === 'select' && $q['select_options']) {
                $q['select_options'] = json_decode($q['select_options'], true);
            }
        }

        echo json_encode(['success' => true, 'data' => $questions, 'count' => count($questions)]);
        exit();
    }

    // ── POST (create or bulk copy) ──────────────────────────────────────────────
    if ($method === 'POST') {
        $body = json_decode(file_get_contents('php://input'), true);

        // ── Bulk copy action ──────────────────────────────────────────────────
        if (($body['action'] ?? '') === 'copy') {
            $sourceId = intval($body['source_workshop_id'] ?? 0);
            $targetId = intval($body['target_workshop_id'] ?? 0);
            if (!$sourceId || !$targetId) {
                echo json_encode(['success' => false, 'message' => 'source_workshop_id and target_workshop_id are required']);
                exit();
            }
            if ($sourceId === $targetId) {
                echo json_encode(['success' => false, 'message' => 'Source and target workshop cannot be the same']);
                exit();
            }

            // Get current max display_order in target
            $maxStmt = $pdo->prepare("SELECT COALESCE(MAX(display_order),0) FROM evaluation_questions WHERE workshop_id = ?");
            $maxStmt->execute([$targetId]);
            $offset = intval($maxStmt->fetchColumn());

            // Fetch source questions (workshop-specific + optionally global)
            $includeGlobal = !empty($body['include_global']);
            if ($includeGlobal) {
                $srcStmt = $pdo->prepare("
                    SELECT category_id, question_text, question_type, select_options,
                           display_order, is_for_speaker
                    FROM evaluation_questions
                    WHERE workshop_id IN (0, ?) AND is_active = 1
                    ORDER BY workshop_id ASC, display_order ASC, id ASC
                ");
            } else {
                $srcStmt = $pdo->prepare("
                    SELECT category_id, question_text, question_type, select_options,
                           display_order, is_for_speaker
                    FROM evaluation_questions
                    WHERE workshop_id = ? AND is_active = 1
                    ORDER BY display_order ASC, id ASC
                ");
            }
            $srcStmt->execute([$sourceId]);
            $srcQuestions = $srcStmt->fetchAll(PDO::FETCH_ASSOC);

            if (empty($srcQuestions)) {
                echo json_encode(['success' => false, 'message' => 'No active questions found in the source workshop']);
                exit();
            }

            $insertStmt = $pdo->prepare("
                INSERT INTO evaluation_questions (workshop_id, category_id, question_text, question_type, select_options, display_order, is_for_speaker)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ");

            $copied = 0;
            foreach ($srcQuestions as $idx => $sq) {
                $insertStmt->execute([
                    $targetId,
                    $sq['category_id'],
                    $sq['question_text'],
                    $sq['question_type'],
                    $sq['select_options'],
                    $offset + $idx + 1,
                    $sq['is_for_speaker']
                ]);
                $copied++;
            }

            // Return updated questions list for target
            $fetchStmt = $pdo->prepare("
                SELECT q.id, q.workshop_id, q.category_id, c.name AS category_name,
                       q.question_text, q.question_type, q.select_options,
                       q.is_active, q.is_for_speaker, q.created_at, q.updated_at, q.display_order
                FROM evaluation_questions q
                LEFT JOIN evaluation_question_categories c ON q.category_id = c.id
                WHERE q.workshop_id = ?
                ORDER BY q.id ASC
            ");
            $fetchStmt->execute([$targetId]);
            $allQuestions = $fetchStmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($allQuestions as &$aq) {
                if ($aq['question_type'] === 'select' && $aq['select_options']) {
                    $aq['select_options'] = json_decode($aq['select_options'], true);
                }
            }

            echo json_encode(['success' => true, 'message' => "$copied question(s) copied successfully", 'data' => $allQuestions]);
            exit();
        }

        // ── Regular single create ─────────────────────────────────────────────
        $workshopId   = intval($body['workshop_id'] ?? 0);
        $categoryId   = intval($body['category_id'] ?? 0);
        $questionText = trim($body['question_text'] ?? '');
        $questionType = in_array($body['question_type'] ?? '', ['rating','text','yes_no','select']) ? $body['question_type'] : 'rating';
        $selectOptions = $body['select_options'] ?? null;
        $sortOrder    = intval($body['display_order'] ?? 0);
        $isForSpeaker = isset($body['is_for_speaker']) ? intval($body['is_for_speaker']) : 0;

        if (!$workshopId || !$questionText || !$categoryId) {
            echo json_encode(['success' => false, 'message' => 'workshop_id, category_id, and question_text are required']);
            exit();
        }

        if ($sortOrder === 0) {
            $maxStmt = $pdo->prepare("SELECT COALESCE(MAX(display_order),0)+1 FROM evaluation_questions WHERE workshop_id = ?");
            $maxStmt->execute([$workshopId]);
            $sortOrder = intval($maxStmt->fetchColumn());
        }

        $stmt = $pdo->prepare("
            INSERT INTO evaluation_questions (workshop_id, category_id, question_text, question_type, select_options, display_order, is_for_speaker)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $workshopId, $categoryId, $questionText, $questionType,
            $selectOptions ? json_encode($selectOptions) : null,
            $sortOrder, $isForSpeaker
        ]);

        $newId = $pdo->lastInsertId();
        // In questions.php POST, replace the fetch after insert with:
        $fetchStmt = $pdo->prepare("
            SELECT q.*, c.name AS category_name
            FROM evaluation_questions q
            LEFT JOIN evaluation_question_categories c ON q.category_id = c.id
            WHERE q.id = ?
        ");
        $fetchStmt->execute([$newId]);
        $newQ = $fetchStmt->fetch(PDO::FETCH_ASSOC);

        if ($newQ['question_type'] === 'select' && $newQ['select_options']) {
            $newQ['select_options'] = json_decode($newQ['select_options'], true);
        }

        echo json_encode(['success' => true, 'message' => 'Question added successfully', 'data' => $newQ]);
        exit();
    }

    // ── PUT (update) ──────────────────────────────────────────────────────────
    if ($method === 'PUT') {
        $body = json_decode(file_get_contents('php://input'), true);
        $id           = intval($body['id'] ?? 0);
        $categoryId   = intval($body['category_id'] ?? 0);
        $questionText = trim($body['question_text'] ?? '');
        $questionType = in_array($body['question_type'] ?? '', ['rating','text','yes_no','select']) ? $body['question_type'] : 'rating';
        $selectOptions = $body['select_options'] ?? null;
        $sortOrder    = intval($body['display_order'] ?? 0);
        $isActive     = isset($body['is_active']) ? intval($body['is_active']) : 1;
        $isForSpeaker = isset($body['is_for_speaker']) ? intval($body['is_for_speaker']) : 0;

        if (!$id || !$questionText || !$categoryId) {
            echo json_encode(['success' => false, 'message' => 'id, category_id, and question_text are required']);
            exit();
        }

        $stmt = $pdo->prepare("
            UPDATE evaluation_questions
            SET category_id = ?, question_text = ?, question_type = ?, select_options = ?, display_order = ?, is_active = ?, is_for_speaker = ?
            WHERE id = ?
        ");
        $stmt->execute([
            $categoryId, $questionText, $questionType,
            $selectOptions ? json_encode($selectOptions) : null,
            $sortOrder, $isActive, $isForSpeaker, $id
        ]);

        // In questions.php PUT, replace the fetch after update with:
        $fetchStmt = $pdo->prepare("
            SELECT q.*, c.name AS category_name
            FROM evaluation_questions q
            LEFT JOIN evaluation_question_categories c ON q.category_id = c.id
            WHERE q.id = ?
        ");
        $fetchStmt->execute([$id]);
        $updatedQ = $fetchStmt->fetch(PDO::FETCH_ASSOC);
        if ($updatedQ['question_type'] === 'select' && $updatedQ['select_options']) {
            $updatedQ['select_options'] = json_decode($updatedQ['select_options'], true);
        }

        echo json_encode(['success' => true, 'message' => 'Question updated successfully', 'data' => $updatedQ]);
        exit();
    }

    // ── PATCH (batch reorder) ─────────────────────────────────────────────────
    if ($method === 'PATCH') {
        $body = json_decode(file_get_contents('php://input'), true);
        $orders = $body['orders'] ?? [];
        
        if (!is_array($orders) || count($orders) === 0) {
            echo json_encode(['success' => false, 'message' => 'orders array required']);
            exit();
        }
        
        $stmt = $pdo->prepare("UPDATE evaluation_questions SET display_order = ? WHERE id = ?");
        foreach ($orders as $item) {
            $id = intval($item['id'] ?? 0);
            $order = intval($item['display_order'] ?? 0);
            if ($id > 0) {
                $stmt->execute([$order, $id]);
            }
        }
        
        echo json_encode(['success' => true, 'message' => 'Questions reordered successfully']);
        exit();
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if ($method === 'DELETE') {
        $id = intval($_GET['id'] ?? 0);
        if (!$id) {
            echo json_encode(['success' => false, 'message' => 'id required']);
            exit();
        }
        $stmt = $pdo->prepare("DELETE FROM evaluation_questions WHERE id = ?");
        $stmt->execute([$id]);
        echo json_encode(['success' => true, 'message' => 'Question deleted successfully']);
        exit();
    }

    echo json_encode(['success' => false, 'message' => 'Method not allowed']);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Error: ' . $e->getMessage()]);
}
?>