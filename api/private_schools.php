<?php
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}
$method = $_SERVER['REQUEST_METHOD'];

// Checklist tracker (checklist.html) needs read-only access to list schools,
// even for users who don't have Directory CRUD permission.
// - GET: allow users with either 'checklist' or 'directory'
// - POST/PUT/DELETE: require 'directory'
if ($method === 'GET') {
    if (!hasPermission('directory', $authUser) && !hasPermission('checklist', $authUser)) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Access denied. You do not have permission to view schools.'
        ]);
        exit;
    }
} else {
    requirePermission('directory', $authUser);
}
$pdo    = getDB();

// ─── GET ──────────────────────────────────────────────────────────────
if ($method === 'GET') {
    try {
        // If the user lacks Directory permission, return only the fields
        // needed by the checklist's school-tracker UI (id/name/status/levels + contacts).
        if (hasPermission('directory', $authUser)) {
            $stmt = $pdo->query("
                SELECT id, school_id_no, name,
                       street_address, barangay, city,
                       levels, status,
                       elem_principal  AS elem_admin,   elem_contact,
                       jhs_principal   AS jhs_admin,    jhs_contact,
                       shs_principal   AS shs_admin,    shs_contact,
                       registrar_name, registrar_contact,
                       created_by, updated_by, active
                FROM private_schools
                WHERE active = 1
                ORDER BY id ASC
            ");
        } else {
            $stmt = $pdo->query("
                SELECT id, name,
                       levels, status,
                       elem_principal  AS elem_admin,   elem_contact,
                       jhs_principal   AS jhs_admin,    jhs_contact,
                       shs_principal   AS shs_admin,    shs_contact,
                       active
                FROM private_schools
                WHERE active = 1
                ORDER BY id ASC
            ");
        }
        echo json_encode(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit;
}

// ─── Parse body ───────────────────────────────────────────────────────
$body = json_decode(file_get_contents('php://input'), true);

// ─── POST ─────────────────────────────────────────────────────────────
if ($method === 'POST') {
    $name        = trim($body['name']              ?? '');
    $schoolIdNo  = trim($body['school_id_no']      ?? '') ?: null;
    $streetAddr  = trim($body['street_address']    ?? '') ?: null;
    $barangay    = trim($body['barangay']          ?? '') ?: null;
    $levelsRaw   = trim($body['levels']            ?? '') ?: null;
    $status      = trim($body['status']            ?? '') ?: null;
    $elemAdmin   = trim($body['elem_admin']        ?? '') ?: null;
    $elemCon     = trim($body['elem_contact']      ?? '') ?: null;
    $jhsAdmin    = trim($body['jhs_admin']         ?? '') ?: null;
    $jhsCon      = trim($body['jhs_contact']       ?? '') ?: null;
    $shsAdmin    = trim($body['shs_admin']         ?? '') ?: null;
    $shsCon      = trim($body['shs_contact']       ?? '') ?: null;
    $regName     = trim($body['registrar_name']    ?? '') ?: null;
    $regContact  = trim($body['registrar_contact'] ?? '') ?: null;
    $createdBy   = isset($authUser['id']) ? intval($authUser['id']) : null;

    // Normalise levels: accept JSON array string or plain array
    $levels = null;
    if ($levelsRaw !== null) {
        $decoded = json_decode($levelsRaw, true);
        $allowed = ['pre', 'elem', 'jhs', 'shs'];
        if (is_array($decoded)) {
            $filtered = array_values(array_intersect($decoded, $allowed));
            $levels   = count($filtered) ? json_encode($filtered) : null;
        }
    }

    if (!$name) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'School name is required.']);
        exit;
    }

    $stmt = $pdo->prepare("
        INSERT INTO private_schools
            (school_id_no, name, street_address, barangay, levels, status,
             elem_principal, elem_contact, jhs_principal, jhs_contact,
             shs_principal, shs_contact, registrar_name, registrar_contact,
             created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $schoolIdNo, $name, $streetAddr, $barangay, $levels, $status,
        $elemAdmin, $elemCon, $jhsAdmin, $jhsCon,
        $shsAdmin, $shsCon, $regName, $regContact,
        $createdBy,
    ]);

    echo json_encode(['success' => true, 'id' => $pdo->lastInsertId()]);
    exit;
}

// ─── PUT ──────────────────────────────────────────────────────────────
if ($method === 'PUT') {
    $id          = intval($body['id']              ?? 0);
    $name        = trim($body['name']              ?? '');
    $schoolIdNo  = trim($body['school_id_no']      ?? '') ?: null;
    $streetAddr  = trim($body['street_address']    ?? '') ?: null;
    $barangay    = trim($body['barangay']          ?? '') ?: null;
    $levelsRaw   = trim($body['levels']            ?? '') ?: null;
    $status      = trim($body['status']            ?? '') ?: null;
    $elemAdmin   = trim($body['elem_admin']        ?? '') ?: null;
    $elemCon     = trim($body['elem_contact']      ?? '') ?: null;
    $jhsAdmin    = trim($body['jhs_admin']         ?? '') ?: null;
    $jhsCon      = trim($body['jhs_contact']       ?? '') ?: null;
    $shsAdmin    = trim($body['shs_admin']         ?? '') ?: null;
    $shsCon      = trim($body['shs_contact']       ?? '') ?: null;
    $regName     = trim($body['registrar_name']    ?? '') ?: null;
    $regContact  = trim($body['registrar_contact'] ?? '') ?: null;
    $updatedBy   = isset($authUser['id']) ? intval($authUser['id']) : null;

    // Normalise levels
    $levels = null;
    if ($levelsRaw !== null) {
        $decoded = json_decode($levelsRaw, true);
        $allowed = ['pre', 'elem', 'jhs', 'shs'];
        if (is_array($decoded)) {
            $filtered = array_values(array_intersect($decoded, $allowed));
            $levels   = count($filtered) ? json_encode($filtered) : null;
        }
    }

    if (!$id || !$name) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'ID and School Name are required.']);
        exit;
    }

    $stmt = $pdo->prepare("
        UPDATE private_schools
        SET school_id_no=?, name=?, street_address=?, barangay=?, levels=?, status=?,
            elem_principal=?, elem_contact=?,
            jhs_principal=?,  jhs_contact=?,
            shs_principal=?,  shs_contact=?,
            registrar_name=?, registrar_contact=?,
            updated_by=?
        WHERE id=?
    ");
    $stmt->execute([
        $schoolIdNo, $name, $streetAddr, $barangay, $levels, $status,
        $elemAdmin, $elemCon, $jhsAdmin, $jhsCon,
        $shsAdmin, $shsCon, $regName, $regContact,
        $updatedBy, $id,
    ]);

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
    $stmt = $pdo->prepare("DELETE FROM private_schools WHERE id = ?");
    $stmt->execute([$id]);
    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);