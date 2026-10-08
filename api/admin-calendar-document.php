<?php
// Admin-only: download school calendar builder JSON payload.

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

$role = strtolower(trim((string)($authUser['role'] ?? '')));
if ($role !== 'admin') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied']);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
    exit;
}

$documentId = isset($_GET['document_id']) && is_numeric($_GET['document_id'])
    ? (int)$_GET['document_id']
    : 0;

if ($documentId <= 0) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid document id.']);
    exit;
}

try {
    $pdo = getDB();

    $stmt = $pdo->prepare(
        "SELECT id, title, payload_json, status, updated_at
         FROM school_calendar_documents
         WHERE id = :id
         LIMIT 1"
    );
    $stmt->execute([':id' => $documentId]);
    $doc = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$doc) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Document not found.']);
        exit;
    }

    $download = isset($_GET['download']) && (string)$_GET['download'] === '1';
    if ($download) {
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="calendar_builder_' . $documentId . '.json"');
        echo (string)$doc['payload_json'];
        exit;
    }

    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'success' => true,
        'data' => [
            'id' => (int)$doc['id'],
            'title' => $doc['title'],
            'status' => $doc['status'],
            'updated_at' => $doc['updated_at'],
        ]
    ]);
} catch (PDOException $e) {
    error_log('[admin-calendar-document.php] DB error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error. Please try again.']);
} catch (Throwable $e) {
    error_log('[admin-calendar-document.php] Error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unexpected error. Please try again.']);
}
