<?php
// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';

setCorsHeaders();
setSecurityHeaders();
header('Content-Type: application/json');
// Avoid stale cached lists after create/update/delete.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';

$pdo = getDB();

if (!$pdo || !($pdo instanceof PDO)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database connection failed']);
    exit();
}

// ── Auth ────────────────────────────────────────────────────────────────────
function checkAuthentication($pdo) {
    // SECURITY: Check HttpOnly cookie first (primary auth mechanism)
    $authHeader = '';
    if (!empty($_COOKIE['session_token'])) {
        $authHeader = $_COOKIE['session_token'];
    } else {
        // Fallback to Authorization header
        $headers = getallheaders();
        $authHeader = $headers['Authorization'] ?? '';
    }

    if (!$authHeader) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Unauthorized']);
        exit();
    }

    // Get user data with role and permissions
    $stmt = $pdo->prepare("
        SELECT u.id, u.role, u.permissions 
        FROM users u
        INNER JOIN login_sessions ls ON u.id = ls.user_id 
        WHERE ls.session_token = ? AND ls.expires_at > NOW()
    ");
    $stmt->execute([$authHeader]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Invalid or expired session']);
        exit();
    }

    return $user;
}

$user = checkAuthentication($pdo);
$userId = $user['id'];
$method = $_SERVER['REQUEST_METHOD'];

// SECURITY: Require 'programs' permission for all methods including GET.
// Previously only POST/PUT/DELETE were gated — any authenticated user could
// read all program data via GET regardless of their role.
requirePermission('programs', $user);

try {
    // Dropdown options management — separate from program CRUD
    if (isset($_GET['manage_options'])) {
        handleManageOptions($pdo, $method, $userId);
        exit;
    }

    // ── PROGRAM IMPORTS endpoint (?program_imports) ──────────────────────────
    if (isset($_GET['program_imports'])) {
        handleProgramImports($pdo, $method, $userId);
        exit;
    }

    // ── REPORT SIGNATORIES endpoint (?signatories) ──────────────────────────
    if (isset($_GET['signatories'])) {
        handleSignatories($pdo, $method);
        exit;
    }

    switch ($method) {
        case 'GET':    handleGet($pdo, $userId);    break;
        case 'POST':   handlePost($pdo, $userId);   break;
        case 'PUT':    handlePut($pdo, $userId);    break;
        case 'DELETE': handleDelete($pdo, $userId); break;
        default:
            http_response_code(405);
            echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

// ── GET ─────────────────────────────────────────────────────────────────────
function handleGet($pdo, $userId) {

    // ── DROPDOWN OPTIONS REQUEST ──────────────────────────────────────────────
    if (isset($_GET['dropdown_options'])) {
        $type = $_GET['type'] ?? null;
        if ($type) {
            $stmt = $pdo->prepare("
                SELECT id, type, label, display_order, is_active
                FROM workshop_dropdown_options
                WHERE type = ? AND is_active = 1
                ORDER BY display_order ASC, label ASC
            ");
            $stmt->execute([$type]);
        } else {
            $stmt = $pdo->query("
                SELECT id, type, label, display_order, is_active
                FROM workshop_dropdown_options
                WHERE is_active = 1
                ORDER BY type ASC, display_order ASC, label ASC
            ");
        }
        $options = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $grouped = ['unit' => [], 'nature_of_event' => []];
        foreach ($options as $opt) {
            $grouped[$opt['type']][] = $opt;
        }
        echo json_encode(['success' => true, 'data' => $grouped]);
        return;
    }

    // CATEGORY REQUEST
    if (isset($_GET['categories'])) {
        $stmt = $pdo->prepare("
            SELECT id, name
            FROM evaluation_question_categories
            WHERE is_active = 1
            ORDER BY display_order ASC
        ");
        $stmt->execute();
        $categories = $stmt->fetchAll(PDO::FETCH_ASSOC); // ← was FETCH_COLUMN
        echo json_encode(['success' => true, 'data' => $categories]);
        return;
    }

    // ── CONTAINER PROGRAMS LIST (?type=container) ────────────────────────────
    // Returns only workshops with program_type = 'container', along with their
    // linked import count. Used by speaker-roster.js to build the container cards.
    if (isset($_GET['type']) && $_GET['type'] === 'container') {
        $stmt = $pdo->query("
            SELECT w.id, w.title, w.division_memo, w.venue, w.start_date, w.end_date,
                   w.status, w.total_participants, w.program_type,
                   COUNT(DISTINCT pi.id) AS import_count,
                   COALESCE(SUM(COALESCE(ep.total_responses, 0)), 0) AS responses_sum,
                   COALESCE(MAX(COALESCE(ep.total_responses, 0)), 0) AS responses_max,
                   COALESCE(SUM(COALESCE(ep.total_responses, 0)), 0) AS responses_count
            FROM workshops w
            LEFT JOIN program_imports pi ON pi.workshop_id = w.id
            LEFT JOIN evaluation_programs ep ON ep.id = pi.program_id
            WHERE w.program_type = 'container'
            GROUP BY w.id
            ORDER BY w.created_at DESC
        ");
        echo json_encode(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
        return;
    }

    $programId = isset($_GET['id']) ? intval($_GET['id']) : null;

    if ($programId) {
        // Single program with days & speakers
        $stmt = $pdo->prepare("
            SELECT w.*, u.full_name as creator_name
            FROM workshops w
            LEFT JOIN users u ON w.created_by = u.id
            WHERE w.id = ?
        ");
        $stmt->execute([$programId]);
        $program = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$program) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Program not found']);
            return;
        }

        $program['days'] = [];

        // Participant count
        $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM workshop_participants WHERE workshop_id = ?");
        $stmt->execute([$programId]);
        $program['participants_count'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];

        // If container: load linked day imports and compute aggregated totals
        if (($program['program_type'] ?? 'live_form') === 'container') {
            $impStmt = $pdo->prepare("
                SELECT pi.id, pi.program_id, pi.day_label, pi.day_number, pi.imported_at,
                       ep.title, ep.overall_average, ep.overall_result,
                       ep.total_responses, ep.total_participants, ep.source_filename,
                       ep.inclusive_dates, ep.start_date, ep.status
                FROM program_imports pi
                JOIN evaluation_programs ep ON ep.id = pi.program_id
                WHERE pi.workshop_id = ?
                ORDER BY pi.day_number ASC, pi.imported_at ASC
            ");
            $impStmt->execute([$programId]);
            $program['linked_imports'] = $impStmt->fetchAll(PDO::FETCH_ASSOC);

            // FIX: sequence_number and qame_associates live on evaluation_programs,
            // not on workshops. Pull them from the first linked import so the
            // Generate Preview and Word/PPT exports can display them correctly.
            if (!empty($program['linked_imports'])) {
                $firstImportId = $program['linked_imports'][0]['program_id'];
                $epFieldsStmt = $pdo->prepare("
                    SELECT sequence_number, qame_associates
                    FROM evaluation_programs
                    WHERE id = ?
                ");
                $epFieldsStmt->execute([$firstImportId]);
                $epFields = $epFieldsStmt->fetch(PDO::FETCH_ASSOC);
                if ($epFields) {
                    if (empty($program['sequence_number'])) {
                        $program['sequence_number'] = $epFields['sequence_number'];
                    }
                    if (empty($program['qame_associates'])) {
                        $program['qame_associates'] = $epFields['qame_associates'];
                    }
                }
            }

            // For container: total_participants comes from the container row itself
            // (set by the user in the edit modal). total_responses is the MAX across
            // linked imports — NOT a SUM, since the same participants fill out each day.
            $sumStmt = $pdo->prepare("
                SELECT MAX(ep2.total_responses) AS tr
                FROM program_imports pi
                JOIN evaluation_programs ep2 ON ep2.id = pi.program_id
                WHERE pi.workshop_id = ?
            ");
            $sumStmt->execute([$programId]);
            $sums = $sumStmt->fetch(PDO::FETCH_ASSOC);
            // Keep total_participants from the container row (already loaded above)
            $program['total_responses'] = intval($sums['tr']);
        }

        echo json_encode(['success' => true, 'data' => $program]);

    } else {
        // ── nav_category filter (set by sub-pages like qatame.html, qms.html, etc.) ──
        $navCategory = isset($_GET['nav_category']) ? trim($_GET['nav_category']) : '';
        // Appended to workshops query: filters by w.nav_category column
        $navCategoryClause   = $navCategory ? 'HAVING MAX(w.nav_category) = ?' : '';
        // Appended to standalone excel query: filters by ep.nav_category column
        $navCategoryClauseSA = $navCategory ? 'AND ep.nav_category = ?' : '';

        // ── 1. System workshops + Excel-linked workshops ──────────────────────
        $pageFilter = isset($_GET['page']) ? trim($_GET['page']) : null;
        $pageWhere  = $pageFilter ? "AND w.page = " . $pdo->quote($pageFilter) : "";

        $stmt = $pdo->prepare("
            SELECT
                w.id,
                w.title,
                w.division_memo,
                w.proponents,
                w.start_date,
                w.end_date,
                w.venue,
                w.status,
                w.unit,
                w.nature_of_event,
                w.page,
                w.description,
                w.created_at,
                w.program_type,
                u.full_name AS creator_name,
                -- For container programs: use MAX responses across linked imports
                -- (participants are the same people each day, so SUM would double-count).
                CASE
                    WHEN w.program_type = 'container' THEN (
                        SELECT COALESCE(MAX(ep2.total_responses), 0)
                        FROM program_imports pi
                        JOIN evaluation_programs ep2 ON ep2.id = pi.program_id
                        WHERE pi.workshop_id = w.id
                    )
                    ELSE 0
                END AS responses_count,
                0 AS days_count,
                0 AS speakers_count,
                w.total_participants,
                'excel'           AS source,
                ep.id AS eval_program_id,

                ep.overall_average,
                ep.overall_result

            FROM workshops w
            LEFT JOIN users u              ON w.created_by        = u.id
            LEFT JOIN evaluation_programs ep ON ep.workshop_id     = w.id
                        WHERE 1=1
                            AND w.program_type = 'container'
                            $pageWhere
            GROUP BY w.id
            ORDER BY w.created_at DESC
        " . $navCategoryClause . "
        ");
        if ($navCategory) {
            $stmt->execute([$navCategory]);
        } else {
            $stmt->execute();
        }
        $workshops = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // ── 1b. Enrich container programs with per-day import breakdown ────────
        // Fetch all program_imports for container workshops in one query,
        // then group in PHP — avoids MySQL JSON_OBJECT/GROUP_CONCAT compatibility issues.
        $containerIds = array_map(fn($w) => $w['id'],
            array_filter($workshops, fn($w) => ($w['program_type'] ?? '') === 'container')
        );
        if (!empty($containerIds)) {
            $placeholders = implode(',', array_fill(0, count($containerIds), '?'));
            $impStmt = $pdo->prepare("
                SELECT pi.workshop_id,
                       COALESCE(pi.day_label, CONCAT('Day ', pi.id)) AS label,
                       COALESCE(ep.total_responses, 0)               AS responses
                FROM program_imports pi
                LEFT JOIN evaluation_programs ep ON ep.id = pi.program_id
                WHERE pi.workshop_id IN ($placeholders)
                ORDER BY pi.id ASC
            ");
            $impStmt->execute(array_values($containerIds));
            $allImports = $impStmt->fetchAll(PDO::FETCH_ASSOC);

            // Group by workshop_id
            $importsByWorkshop = [];
            foreach ($allImports as $imp) {
                $importsByWorkshop[$imp['workshop_id']][] = [
                    'label'     => $imp['label'],
                    'responses' => (int) $imp['responses'],
                ];
            }

            // Attach day_imports to each container workshop row
            foreach ($workshops as &$w) {
                if (($w['program_type'] ?? '') === 'container') {
                    $w['day_imports'] = $importsByWorkshop[$w['id']] ?? [];
                    // days_count was hardcoded to 0 in the SELECT above since it
                    // can't be computed there without a costly correlated subquery —
                    // derive it here instead from the imports we just fetched.
                    $w['days_count']  = count($w['day_imports']);
                }
            }
            unset($w);
        }

        // ── 2. Standalone Excel imports (no workshop linked) ──────────────────
        $pageFilterSA = $pageFilter ? "AND ep.page = " . $pdo->quote($pageFilter) : "";

        $stmtSA = $pdo->prepare("
            SELECT
                ep.id,
                ep.title,
                ep.division_memo,
                ep.proponents,
                COALESCE(ep.start_date, ep.inclusive_dates) AS start_date,
                ep.end_date,
                ep.training_venue         AS venue,
                ep.status,
                ep.total_participants,
                ep.description,
                ep.created_at,
                NULL                      AS creator_name,
                ep.total_responses        AS responses_count,
                (SELECT COUNT(DISTINCT r.day_sheet)
                 FROM respondents r
                 WHERE r.program_id = ep.id
                   AND r.day_sheet IS NOT NULL
                )                         AS days_count,
                0                         AS speakers_count,
                'excel'                   AS source,
                ep.id                     AS eval_program_id,
                ep.overall_average,
                ep.overall_result,
                ep.unit,
                ep.nature_of_event,
                ep.qame_associates,
                ep.inclusive_dates,
                ep.source_filename
            FROM evaluation_programs ep
            WHERE ep.workshop_id IS NULL
            $pageFilterSA
            ORDER BY ep.created_at DESC
        ");
        $stmtSA->execute();
        $standalone = $stmtSA->fetchAll(PDO::FETCH_ASSOC);

        // ── 2b. Enrich standalone Excel programs with per-day breakdown ─────────
        // Uses day_sheet values from the respondents table (e.g. "Day 1", "Day 2").
        $standaloneIds = array_column($standalone, 'id');
        if (!empty($standaloneIds)) {
            $placeholders = implode(',', array_fill(0, count($standaloneIds), '?'));
            $dsStmt = $pdo->prepare("
                SELECT   r.program_id,
                         r.day_sheet                       AS label,
                         COUNT(DISTINCT r.id)              AS responses
                FROM     respondents r
                WHERE    r.program_id IN ($placeholders)
                  AND    r.day_sheet IS NOT NULL
                GROUP BY r.program_id, r.day_sheet
                ORDER BY r.program_id, r.day_sheet ASC
            ");
            $dsStmt->execute(array_values($standaloneIds));
            $allDaySheets = $dsStmt->fetchAll(PDO::FETCH_ASSOC);

            // Group by program_id
            $daySheetsByProgram = [];
            foreach ($allDaySheets as $row) {
                $daySheetsByProgram[$row['program_id']][] = [
                    'label'     => $row['label'],
                    'responses' => (int) $row['responses'],
                ];
            }

            foreach ($standalone as &$ep) {
                $ep['day_imports'] = $daySheetsByProgram[$ep['id']] ?? [];
            }
            unset($ep);
        }

        // ── 3. Merge — workshops first, then standalones ──────────────────────
        $programs = array_merge($workshops, $standalone);

        echo json_encode(['success' => true, 'data' => $programs]);
    }
}

// ── MANAGE DROPDOWN OPTIONS (POST/PUT/DELETE ?manage_options) ───────────────
function handleManageOptions($pdo, $method, $userId) {
    $rawBody = file_get_contents('php://input');
    $data = json_decode($rawBody, true);
    if (!is_array($data)) $data = [];
    if (empty($data) && !empty($_POST)) {
        $data = $_POST;
    }

    if ($method === 'GET') {
        $type = trim($_GET['type'] ?? '');
        if ($type && !in_array($type, ['unit', 'nature_of_event'], true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid type']);
            return;
        }

        if ($type) {
            $stmt = $pdo->prepare("\n                SELECT id, type, label, display_order, is_active\n                FROM workshop_dropdown_options\n                WHERE type = ?\n                ORDER BY display_order ASC, label ASC\n            ");
            $stmt->execute([$type]);
        } else {
            $stmt = $pdo->query("\n                SELECT id, type, label, display_order, is_active\n                FROM workshop_dropdown_options\n                ORDER BY type ASC, display_order ASC, label ASC\n            ");
        }

        echo json_encode(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
        return;
    }

    if ($method === 'POST') {
        // Add new option
        $label = trim(preg_replace('/\s+/', ' ', (string)($data['label'] ?? '')));
        $type  = $data['type'] ?? '';
        $order = intval($data['display_order'] ?? 0);
        if (!$label || !in_array($type, ['unit', 'nature_of_event'], true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'label and valid type are required']);
            return;
        }
            $existsStmt = $pdo->prepare("
                SELECT id, label
                FROM workshop_dropdown_options
                WHERE type = ?
                  AND LOWER(TRIM(label)) = LOWER(TRIM(?))
                LIMIT 1
            ");
            $existsStmt->execute([$type, $label]);
            $existing = $existsStmt->fetch(PDO::FETCH_ASSOC);
            if ($existing) {
                echo json_encode([
                    'success'  => true,
                    'existing' => true,
                    'id'       => intval($existing['id']),
                    'label'    => $existing['label'],
                    'message'  => "Option '{$existing['label']}' already exists"
                ]);
                return;
            }

            $stmt = $pdo->prepare("
                INSERT INTO workshop_dropdown_options (type, label, display_order)
                VALUES (?, ?, ?)
            ");
            $stmt->execute([$type, $label, $order]);
            echo json_encode([
                'success'  => true,
                'existing' => false,
                'id'       => intval($pdo->lastInsertId()),
                'label'    => $label,
                'message'  => "Option '$label' added"
            ]);
        return;
    }

    if ($method === 'PUT') {
        // Update label / order / active
        $id    = intval($data['id'] ?? 0);
        $label = trim($data['label'] ?? '');
        $order = intval($data['display_order'] ?? 0);
        $active = isset($data['is_active']) ? intval($data['is_active']) : 1;
        if (!$id || !$label) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'id and label are required']);
            return;
        }
        $stmt = $pdo->prepare("
            UPDATE workshop_dropdown_options
            SET label = ?, display_order = ?, is_active = ?
            WHERE id = ?
        ");
        $stmt->execute([$label, $order, $active, $id]);
        echo json_encode(['success' => true, 'message' => "Option updated"]);
        return;
    }

    if ($method === 'DELETE') {
        $id = intval($data['id'] ?? $_GET['id'] ?? 0);
        if (!$id) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'id is required']);
            return;
        }
        $pdo->prepare("DELETE FROM workshop_dropdown_options WHERE id = ?")->execute([$id]);
        echo json_encode(['success' => true, 'message' => 'Option deleted']);
        return;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed for manage_options']);
}

// ── POST (create) ────────────────────────────────────────────────────────────
function handlePost($pdo, $userId) {
    $data = json_decode(file_get_contents('php://input'), true);

    $required = ['title', 'division_memo', 'start_date', 'end_date', 'venue'];
    foreach ($required as $field) {
        if (empty($data[$field])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => "Missing required field: $field"]);
            return;
        }
    }

    $pdo->beginTransaction();

    try {
        $programType = ($data['program_type'] ?? 'live_form') === 'container' ? 'container' : 'live_form';

        $stmt = $pdo->prepare("
            INSERT INTO workshops
                (title, division_memo, description, proponents, total_participants, start_date, end_date, venue, status, unit, nature_of_event, program_type, page, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ");

        $stmt->execute([
            $data['title'],
            $data['division_memo'],
            $data['description']  ?? null,
            $data['proponents']   ?? null,
            $data['total_participants'] ?? null,
            $data['start_date'],
            $data['end_date'],
            $data['venue'],
            $data['status']       ?? 'upcoming',
            $data['unit']         ?? 'SGOD',
            $data['nature_of_event'] ?? 'Training',
            $programType,
            $data['page']         ?? 'qatame',
            $userId
        ]);

        $programId = $pdo->lastInsertId();

        $pdo->commit();

        echo json_encode([
            'success'    => true,
            'message'    => 'Program created successfully',
            'data'       => ['id' => intval($programId)]   // ← frontend expects data.id
        ]);

    } catch (Exception $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── PUT (update) ─────────────────────────────────────────────────────────────
function handlePut($pdo, $userId) {
    $data = json_decode(file_get_contents('php://input'), true);

    $programId = intval($data['program_id'] ?? $data['id'] ?? 0);
    if (!$programId) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Program ID is required']);
        return;
    }

    // Only title is strictly required; all other fields are optional on update.
    // Container programs edited via the "Edit Excel Record" modal may send null
    // for division_memo, start_date, end_date, venue when those are intentionally cleared.
    if (empty($data['title'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing required field: title']);
        return;
    }

    // SECURITY: Verify ownership or admin role
    $stmt = $pdo->prepare("SELECT created_by, program_type, page FROM workshops WHERE id = ?");
    $stmt->execute([$programId]);
    $program = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$program) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Program not found']);
        return;
    }

    // Check if user is owner or admin
    $userStmt = $pdo->prepare("SELECT role FROM users WHERE id = ?");
    $userStmt->execute([$userId]);
    $userRole = $userStmt->fetchColumn();
    
    if ($program['created_by'] != $userId && $userRole !== 'admin') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'You can only edit programs you created']);
        return;
    }

    $pdo->beginTransaction();

    try {
        $stmt = $pdo->prepare("
            UPDATE workshops SET
                title         = ?,
                division_memo = ?,
                description   = ?,
                proponents    = ?,
                total_participants = ?,
                start_date    = ?,
                end_date      = ?,
                venue         = ?,
                status        = ?,
                unit          = ?,
                nature_of_event = ?,
                program_type  = ?,
                page          = ?,
                updated_at    = NOW()
            WHERE id = ?
        ");

        // Accept 'training_venue' as alias for 'venue' (sent by the Edit Excel Record modal)
        $venueValue = $data['venue'] ?? $data['training_venue'] ?? null;

        $stmt->execute([
            $data['title'],
            $data['division_memo']  ?? null,
            $data['description']    ?? null,
            $data['proponents']     ?? null,
            $data['total_participants'] ?? null,
            $data['start_date']     ?? null,
            $data['end_date']       ?? null,
            $venueValue,
            $data['status']         ?? 'upcoming',
            $data['unit']           ?? 'SGOD',
            $data['nature_of_event'] ?? 'Training',
            // Preserve existing program_type unless explicitly sent — prevents container→live_form reset.
            isset($data['program_type'])
                ? (($data['program_type'] === 'container') ? 'container' : 'live_form')
                : ($program['program_type'] ?? 'live_form'),
            // Preserve existing page unless explicitly sent — prevents page reset to 'qatame'.
            $data['page'] ?? $program['page'] ?? 'qatame',
            $programId
        ]);

        $pdo->commit();

        echo json_encode(['success' => true, 'message' => 'Program updated successfully']);

    } catch (Exception $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── DELETE ───────────────────────────────────────────────────────────────────
function handleDelete($pdo, $userId) {
    $programId   = isset($_GET['id'])    ? intval($_GET['id'])              : null;
    $forceDelete = isset($_GET['force']) && $_GET['force'] === 'true';

    if (!$programId) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Program ID is required']);
        return;
    }

    // SECURITY: Verify ownership or admin role
    $stmt = $pdo->prepare("SELECT id, created_by, title, program_type FROM workshops WHERE id = ?");
    $stmt->execute([$programId]);
    $program = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$program) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Program not found']);
        return;
    }

    $userStmt = $pdo->prepare("SELECT role FROM users WHERE id = ?");
    $userStmt->execute([$userId]);
    $userRole = $userStmt->fetchColumn();

    if ($program['created_by'] != $userId && $userRole !== 'admin') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'You can only delete programs you created']);
        return;
    }

    $isContainer = ($program['program_type'] ?? '') === 'container';

    // ── Container: gather linked evaluation_programs ids ─────────────────────
    $linkedProgramIds = [];
    if ($isContainer) {
        $piStmt = $pdo->prepare("
            SELECT pi.program_id
            FROM program_imports pi
            WHERE pi.workshop_id = ?
        ");
        $piStmt->execute([$programId]);
        $linkedProgramIds = $piStmt->fetchAll(PDO::FETCH_COLUMN);
    }

    // ── Submission / import count guard ──────────────────────────────────────
    $dataCount = 0;

    if ($isContainer && !empty($linkedProgramIds)) {
        $pidIn = implode(',', array_map('intval', $linkedProgramIds));
        $rcStmt = $pdo->query("SELECT COUNT(*) FROM respondents WHERE program_id IN ({$pidIn})");
        $dataCount = (int)$rcStmt->fetchColumn();
    }

    if ($dataCount > 0 && !$forceDelete) {
        $noun = 'respondent record';
        http_response_code(409);
        echo json_encode([
            'success'                => false,
            'message'                => "This program has {$dataCount} {$noun}(s). Add ?force=true to permanently delete all data.",
            'submission_count'       => $dataCount,
            'requires_confirmation'  => true,
            'is_container'           => $isContainer,
        ]);
        return;
    }

    // ── Perform deletion inside a transaction ─────────────────────────────────
    $pdo->beginTransaction();
    try {
        if ($isContainer && !empty($linkedProgramIds)) {
            $pidIn = implode(',', array_map('intval', $linkedProgramIds));

            // Delete all evaluation data for linked imports (deepest first)
            // speaker_criteria → speaker_averages
            $saIds = $pdo->query("SELECT id FROM speaker_averages WHERE program_id IN ({$pidIn})")
                         ->fetchAll(PDO::FETCH_COLUMN);
            if (!empty($saIds)) {
                $saIn = implode(',', array_map('intval', $saIds));
                $pdo->exec("DELETE FROM speaker_criteria WHERE speaker_avg_id IN ({$saIn})");
            }
            $pdo->exec("DELETE FROM speaker_averages    WHERE program_id IN ({$pidIn})");

            // respondent_scores → respondents
            $rIds = $pdo->query("SELECT id FROM respondents WHERE program_id IN ({$pidIn})")
                        ->fetchAll(PDO::FETCH_COLUMN);
            if (!empty($rIds)) {
                $rIn = implode(',', array_map('intval', $rIds));
                $pdo->exec("DELETE FROM respondent_scores WHERE respondent_id IN ({$rIn})");
            }
            $pdo->exec("DELETE FROM respondents         WHERE program_id IN ({$pidIn})");

            // column_averages, category_averages
            $pdo->exec("DELETE FROM column_averages     WHERE program_id IN ({$pidIn})");
            $pdo->exec("DELETE FROM category_averages   WHERE program_id IN ({$pidIn})");

            // program_imports link rows (before deleting evaluation_programs)
            $pdo->prepare("DELETE FROM program_imports WHERE workshop_id = ?")->execute([$programId]);

            // Finally delete the evaluation_programs rows themselves
            $pdo->exec("DELETE FROM evaluation_programs WHERE id IN ({$pidIn})");
        }

        // Delete the container workshop row
        $pdo->prepare("DELETE FROM workshops WHERE id = ?")->execute([$programId]);

        $pdo->commit();

        echo json_encode([
            'success' => true,
            'message' => $dataCount > 0
                ? "Program and all linked import data ({$dataCount} records) deleted permanently"
                : 'Program deleted successfully',
        ]);

    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Delete failed: ' . $e->getMessage()]);
    }
}

// ── PROGRAM IMPORTS CRUD ─────────────────────────────────────────────────────
function handleProgramImports($pdo, $method, $userId) {
    if ($method === 'GET') {
        $workshopId = intval($_GET['workshop_id'] ?? 0);
        if (!$workshopId) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'workshop_id is required']);
            return;
        }
        $stmt = $pdo->prepare("
            SELECT pi.id, pi.program_id, pi.day_label, pi.day_number, pi.imported_at,
                   ep.title, ep.overall_average, ep.overall_result,
                   ep.total_responses, ep.total_participants, ep.source_filename,
                   ep.inclusive_dates, ep.start_date, ep.status
            FROM program_imports pi
            JOIN evaluation_programs ep ON ep.id = pi.program_id
            WHERE pi.workshop_id = ?
            ORDER BY pi.day_number ASC, pi.imported_at ASC
        ");
        $stmt->execute([$workshopId]);
        echo json_encode(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
        return;
    }

    if ($method === 'POST') {
        $data = json_decode(file_get_contents('php://input'), true) ?? [];
        $workshopId = intval($data['workshop_id'] ?? 0);
        $programId  = intval($data['program_id']  ?? 0);
        $dayLabel   = trim($data['day_label'] ?? '');
        if (!$workshopId || !$programId) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'workshop_id and program_id are required']);
            return;
        }
        // Find the lowest missing day number so delete+re-add fills the gap correctly
        $existingStmt = $pdo->prepare("SELECT day_label FROM program_imports WHERE workshop_id = ?");
        $existingStmt->execute([$workshopId]);
        $usedNums = array_filter(array_map(function($row) {
            preg_match('/\d+/', $row['day_label'], $m);
            return isset($m[0]) ? (int)$m[0] : null;
        }, $existingStmt->fetchAll(PDO::FETCH_ASSOC)));
        $dayNumber = 1;
        while (in_array($dayNumber, $usedNums)) $dayNumber++;
        if (!$dayLabel) $dayLabel = 'Day ' . $dayNumber;

        // Prevent duplicate links
        $dupStmt = $pdo->prepare("SELECT id FROM program_imports WHERE workshop_id = ? AND program_id = ?");
        $dupStmt->execute([$workshopId, $programId]);
        if ($dupStmt->fetch()) {
            echo json_encode(['success' => true, 'message' => 'Already linked', 'day_number' => $dayNumber]);
            return;
        }

        $ins = $pdo->prepare("
            INSERT INTO program_imports (workshop_id, program_id, day_label, day_number)
            VALUES (?, ?, ?, ?)
        ");
        $ins->execute([$workshopId, $programId, $dayLabel, $dayNumber]);
        echo json_encode(['success' => true, 'message' => 'Import linked successfully', 'day_number' => $dayNumber, 'day_label' => $dayLabel]);
        return;
    }

    if ($method === 'DELETE') {
        $id = intval($_GET['id'] ?? 0);
        if (!$id) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'id is required']);
            return;
        }
        $pdo->prepare("DELETE FROM program_imports WHERE id = ?")->execute([$id]);
        echo json_encode(['success' => true, 'message' => 'Import unlinked']);
        return;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}


// ── REPORT SIGNATORIES ───────────────────────────────────────────────────────
/**
 * GET  programs.php?signatories   → returns active signatory row as JSON
 * PUT  programs.php?signatories   → updates the active signatory row
 */
function handleSignatories($pdo, $method) {
    if ($method === 'GET') {
        $stmt = $pdo->query("
            SELECT org_country, org_department, org_division,
                   org_section, org_unit,
                   prepared_name, prepared_title,
                   checked_name,  checked_title,
                   noted1_name,   noted1_title,
                   noted2_name,   noted2_title,
                   noted3_name,   noted3_title
            FROM report_signatories
            WHERE is_active = 1
            ORDER BY id ASC
            LIMIT 1
        ");
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            echo json_encode(['success' => false, 'message' => 'No active signatory setting found']);
            return;
        }

        $noted = [];
        for ($i = 1; $i <= 3; $i++) {
            $name  = trim($row["noted{$i}_name"]  !== null ? $row["noted{$i}_name"]  : '');
            $title = trim($row["noted{$i}_title"] !== null ? $row["noted{$i}_title"] : '');
            if ($name !== '') {
                $noted[] = ['name' => $name, 'title' => $title];
            }
        }

        echo json_encode([
            'success' => true,
            'data' => [
                'org' => [
                    'country'    => $row['org_country'],
                    'department' => $row['org_department'],
                    'division'   => $row['org_division'],
                    'section'    => $row['org_section'],
                    'unit'       => $row['org_unit'],
                ],
                'preparedBy' => [
                    'name'  => $row['prepared_name'],
                    'title' => $row['prepared_title'],
                ],
                'checkedBy' => [
                    'name'  => $row['checked_name'],
                    'title' => $row['checked_title'],
                ],
                'noted' => $noted,
            ]
        ]);
        return;
    }

    if ($method === 'PUT') {
        $data = json_decode(file_get_contents('php://input'), true);
        if (!$data) { $data = []; }

        $fields = [
            'org_country'    => isset($data['org']['country'])      ? $data['org']['country']      : null,
            'org_department' => isset($data['org']['department'])    ? $data['org']['department']   : null,
            'org_division'   => isset($data['org']['division'])      ? $data['org']['division']     : null,
            'org_section'    => isset($data['org']['section'])       ? $data['org']['section']      : null,
            'org_unit'       => isset($data['org']['unit'])          ? $data['org']['unit']         : null,
            'prepared_name'  => isset($data['preparedBy']['name'])   ? $data['preparedBy']['name']  : null,
            'prepared_title' => isset($data['preparedBy']['title'])  ? $data['preparedBy']['title'] : null,
            'checked_name'   => isset($data['checkedBy']['name'])    ? $data['checkedBy']['name']   : null,
            'checked_title'  => isset($data['checkedBy']['title'])   ? $data['checkedBy']['title']  : null,
            'noted1_name'    => isset($data['noted'][0]['name'])     ? $data['noted'][0]['name']    : null,
            'noted1_title'   => isset($data['noted'][0]['title'])    ? $data['noted'][0]['title']   : null,
            'noted2_name'    => isset($data['noted'][1]['name'])     ? $data['noted'][1]['name']    : null,
            'noted2_title'   => isset($data['noted'][1]['title'])    ? $data['noted'][1]['title']   : null,
            'noted3_name'    => isset($data['noted'][2]['name'])     ? $data['noted'][2]['name']    : null,
            'noted3_title'   => isset($data['noted'][2]['title'])    ? $data['noted'][2]['title']   : null,
        ];

        $keys = array_keys($fields);
        $setClauses = implode(', ', array_map(function($k) { return "$k = ?"; }, $keys));
        $stmt = $pdo->prepare("
            UPDATE report_signatories
            SET $setClauses
            WHERE is_active = 1
            ORDER BY id ASC
            LIMIT 1
        ");
        $stmt->execute(array_values($fields));

        echo json_encode(['success' => true, 'message' => 'Signatories updated']);
        return;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}
