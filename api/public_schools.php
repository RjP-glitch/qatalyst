<?php
/**
 * public_schools.php — Public School Heads CRUD API
 * Supports: GET (list), POST (create), PUT (update), DELETE (soft-delete)
 *
 * Table: public_schools
 * Columns: id, name, position, school_id, district, school_name,
 *          birthdate, contact_number, email, first_day_station,
 *          active, created_by, updated_by
 */
ini_set('display_errors', 0);
error_reporting(E_ALL);
ini_set('log_errors', 1);

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

// Checklist tracker needs read-only access to list schools.
// - GET: allow 'checklist' or 'directory'
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
            if (hasPermission('directory', $authUser)) {
                $stmt = $pdo->query("
                    SELECT
                        id,
                        name,
                        position,
                        school_id,
                        district,
                        school_name,
                        birthdate,
                        contact_number,
                        email,
                        first_day_station
                    FROM public_schools
                    WHERE active = 1
                    ORDER BY
                        FIELD(district,
                            'DISTRICT I','DISTRICT II','DISTRICT III','DISTRICT IV','DISTRICT V',
                            'DISTRICT VI','DISTRICT VII','DISTRICT VIII','DISTRICT IX','DISTRICT X'
                        ),
                        name ASC
                ");
            } else {
                // Minimal fields for checklist-only users
                $stmt = $pdo->query("
                    SELECT
                        id,
                        name,
                        position,
                        district,
                        school_id,
                        school_name
                    FROM public_schools
                    WHERE active = 1
                    ORDER BY
                        FIELD(district,
                            'DISTRICT I','DISTRICT II','DISTRICT III','DISTRICT IV','DISTRICT V',
                            'DISTRICT VI','DISTRICT VII','DISTRICT VIII','DISTRICT IX','DISTRICT X'
                        ),
                        name ASC
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
        $name            = trim($body['name']              ?? '');
        $position        = trim($body['position']          ?? '');
        $district        = trim($body['district']          ?? '');
        $schoolId        = trim($body['school_id']         ?? '');
        $schoolName      = trim($body['school_name']       ?? '');
        $birthdate       = trim($body['birthdate']         ?? '');
        $contactNumber   = trim($body['contact_number']    ?? '');
        $email           = trim($body['email']             ?? '');
        $firstDayStation = trim($body['first_day_station'] ?? '');

        if (!$name || !$position) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Name and Position are required.']);
            exit;
        }

        $districtInfo = portalResolveDistrict($pdo, $body['district_id'] ?? null, $district);
        if (!$districtInfo) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Please select a valid district.']);
            exit;
        }

        $stmt = $pdo->prepare("
            INSERT INTO public_schools
                (name, position, school_id, district, district_id, school_name,
                 birthdate, contact_number, email, first_day_station,
                 created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $name,
            $position,
            $schoolId        ?: null,
            $districtInfo['name'],
            $districtInfo['id'],
            $schoolName      ?: null,
            $birthdate       ?: null,
            $contactNumber   ?: null,
            $email           ?: null,
            $firstDayStation ?: null,
            $authUser['id']  ?? null,
        ]);

        echo json_encode(['success' => true, 'id' => $pdo->lastInsertId()]);
        exit;
    }

    // ─── PUT ──────────────────────────────────────────────────────────────
    if ($method === 'PUT') {
        $id              = intval($body['id']              ?? 0);
        $name            = trim($body['name']              ?? '');
        $position        = trim($body['position']          ?? '');
        $district        = trim($body['district']          ?? '');
        $schoolId        = trim($body['school_id']         ?? '');
        $schoolName      = trim($body['school_name']       ?? '');
        $birthdate       = trim($body['birthdate']         ?? '');
        $contactNumber   = trim($body['contact_number']    ?? '');
        $email           = trim($body['email']             ?? '');
        $firstDayStation = trim($body['first_day_station'] ?? '');

        if (!$id || !$name || !$position) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'ID, Name, and Position are required.']);
            exit;
        }

        $districtInfo = portalResolveDistrict($pdo, $body['district_id'] ?? null, $district);
        if (!$districtInfo) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Please select a valid district.']);
            exit;
        }

    try {
        $pdo->beginTransaction();

        $stmt = $pdo->prepare("
            UPDATE public_schools
            SET name              = ?,
                position          = ?,
                school_id         = ?,
                district          = ?,
                district_id       = ?,
                school_name       = ?,
                birthdate         = ?,
                contact_number    = ?,
                email             = ?,
                first_day_station = ?,
                updated_by        = ?
            WHERE id = ?
        ");
        $stmt->execute([
            $name,
            $position,
            $schoolId        ?: null,
            $districtInfo['name'],
            $districtInfo['id'],
            $schoolName      ?: null,
            $birthdate       ?: null,
            $contactNumber   ?: null,
            $email           ?: null,
            $firstDayStation ?: null,
            $authUser['id']  ?? null,
            $id,
        ]);
        $pdo->prepare("UPDATE users SET district_id = ?, updated_at = NOW() WHERE account_type = 'portal_user' AND school_type = 'public' AND school_id = ?")->execute([$districtInfo['id'], $id]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Could not save school details. Please try again.']);
        exit;
    }

    echo json_encode(['success' => true]);
    exit;
}

// ─── DELETE (soft-delete via active = 0) ─────────────────────────────
if ($method === 'DELETE') {
    $id = intval($body['id'] ?? 0);
    if (!$id) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'ID required.']);
        exit;
    }
    $stmt = $pdo->prepare("UPDATE public_schools SET active = 0 WHERE id = ?");
    $stmt->execute([$id]);
    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
