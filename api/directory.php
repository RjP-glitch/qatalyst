<?php
/**
 * directory.php  — Personnel Directory CRUD API
 * Supports: GET (list), POST (create), PUT (update), DELETE (delete)
 */
ini_set('display_errors', 0);
error_reporting(E_ALL);
ini_set('log_errors', 1);
// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

error_log("directory.php reached successfully");

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

requirePermission('checklist', $authUser);

$method = $_SERVER['REQUEST_METHOD'];

$pdo = getDB();

// ─── GET — fetch all personnel ────────────────────────────────────────
if ($method === 'GET') {
    try {
        $stmt = $pdo->query("
            SELECT id, division, name, position, unit, email,
                contact_number, birthdate
            FROM personnel_directory
            ORDER BY division, name, id
        ");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['success' => true, 'data' => $rows]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit;
}

// ─── Parse JSON body (for POST / PUT / DELETE) ────────────────────────
$body = json_decode(file_get_contents('php://input'), true);

// ─── POST — create ────────────────────────────────────────────────────
if ($method === 'POST') {
    $name     = trim($body['name']           ?? '');
    $position = trim($body['position']       ?? '');
    $division = trim($body['division']       ?? '');
    $unit     = trim($body['unit']           ?? '');
    $email    = trim($body['email']          ?? '');
    $contact  = trim($body['contact_number'] ?? '');
    $birth    = trim($body['birthdate']      ?? '');

    if (!$name || !$position || !$division) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Name, Position, and Division are required.']);
        exit;
    }

    // Determine next `no` within this division
    $noStmt = $pdo->prepare("SELECT COALESCE(MAX(`no`),0)+1 FROM personnel_directory WHERE division = ?");
    $noStmt->execute([$division]);
    $no = $noStmt->fetchColumn();

    $stmt = $pdo->prepare("
        INSERT INTO personnel_directory
            (division, `no`, name, position, unit, email, contact_number, birthdate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$division, $no, $name, $position, $unit,
                    $email ?: null, $contact ?: null, $birth ?: null]);

    echo json_encode(['success' => true, 'id' => $pdo->lastInsertId()]);
    exit;
}

// ─── PUT — update ─────────────────────────────────────────────────────
if ($method === 'PUT') {
    $id       = intval($body['id']            ?? 0);
    $name     = trim($body['name']            ?? '');
    $position = trim($body['position']        ?? '');
    $division = trim($body['division']        ?? '');
    $unit     = trim($body['unit']            ?? '');
    $email    = trim($body['email']           ?? '');
    $contact  = trim($body['contact_number']  ?? '');
    $birth    = trim($body['birthdate']       ?? '');

    if (!$id || !$name || !$position || !$division) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'ID, Name, Position, and Division are required.']);
        exit;
    }

    $stmt = $pdo->prepare("
        UPDATE personnel_directory
        SET name=?, position=?, division=?, unit=?, email=?,
            contact_number=?, birthdate=?
        WHERE id=?
    ");
    $stmt->execute([$name, $position, $division, $unit,
                    $email ?: null, $contact ?: null, $birth ?: null, $id]);

    echo json_encode(['success' => true]);
    exit;
}

// ─── DELETE ───────────────────────────────────────────────────────────
if ($method === 'DELETE') {
    $id = intval($body['id'] ?? 0);
    if (!$id) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'ID required.']);
        exit;
    }
    $stmt = $pdo->prepare("DELETE FROM personnel_directory WHERE id = ?");
    $stmt->execute([$id]);
    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
