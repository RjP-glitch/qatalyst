<?php
/**
 * Workshops API Endpoint
 *
 * Actions (via ?action=):
 *   list         — all workshops (optionally filtered by ?status=)
 *   participants — participants for a single workshop (?workshop_id=)
 *
 * If no action is given the endpoint falls back to the original
 * behaviour: return a single workshop when ?workshop_id= is present,
 * otherwise return all workshops.
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

header('Content-Type: application/json');

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

try {
    $action      = isset($_GET['action'])      ? trim($_GET['action'])      : null;
    $workshop_id = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : null;
    $status      = isset($_GET['status'])      ? trim($_GET['status'])      : null;

    // ── Route ──────────────────────────────────────────────────────────────────
    // Treat missing action as 'list' (backwards-compatible fallback).
    // Treat action=list or action=participants explicitly.
    if ($action === 'participants') {
        handleParticipants($pdo, $workshop_id);
    } else {
        // action=list or no action
        handleList($pdo, $workshop_id, $status);
    }

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Error: ' . $e->getMessage(),
    ]);
}

// ── Handler: list workshops ────────────────────────────────────────────────────
function handleList(PDO $pdo, ?int $workshop_id, ?string $status): void
{
    $query = "
        SELECT
            w.id,
            w.title,
            w.division_memo,
            w.description,
            w.start_date,
            w.end_date,
            w.total_days,
            w.venue,
            w.total_participants,
            w.proponents,
            w.nature_of_event,
            w.status,
            w.created_by,
            w.created_at,
            w.updated_at,
            -- FIX (Bug 2): workshop_days and evaluation_submissions tables were removed.
            -- responses_count now reads from program_imports + evaluation_programs instead.
            (
                SELECT COALESCE(MAX(ep2.total_responses), 0)
                FROM program_imports pi
                JOIN evaluation_programs ep2 ON ep2.id = pi.program_id
                WHERE pi.workshop_id = w.id
            ) AS responses_count
        FROM workshops w
        WHERE 1=1
    ";

    $params = [];

    if ($workshop_id) {
        $query .= " AND w.id = ?";
        $params[] = $workshop_id;
    }

    if ($status) {
        $query .= " AND w.status = ?";
        $params[] = $status;
    }

    // Exclude container programs — they are managed separately via programs.php?type=container
    // and must not appear as live workshop cards in the speaker roster grid.
    $query .= " AND (w.program_type IS NULL OR w.program_type != 'container')";

    $query .= " ORDER BY w.start_date DESC, w.id DESC";

    $stmt = $pdo->prepare($query);
    $stmt->execute($params);
    $workshops = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($workshops as &$workshop) {
        // FIX (Bug 2): workshop_days table was removed.
        // Container program days are now tracked via program_imports; non-container
        // workshops no longer need a days sub-array here.
        $workshop['days'] = [];

        // Participant count
        $count_stmt = $pdo->prepare("
            SELECT COUNT(*) AS participant_count
            FROM workshop_participants
            WHERE workshop_id = ?
        ");
        $count_stmt->execute([$workshop['id']]);
        $workshop['participant_count'] = intval(
            $count_stmt->fetchColumn()
        );

        // Cast responses_count (from subquery) to int
        $workshop['responses_count'] = intval($workshop['responses_count']);
    }
    unset($workshop);

    // Single workshop requested → return object, not array
    if ($workshop_id && count($workshops) > 0) {
        echo json_encode([
            'success' => true,
            'data'    => $workshops[0],
        ]);
    } else {
        echo json_encode([
            'success' => true,
            'data'    => $workshops,
            'count'   => count($workshops),
        ]);
    }
}

// ── Handler: participants for one workshop ─────────────────────────────────────
function handleParticipants(PDO $pdo, ?int $workshop_id): void
{
    if (!$workshop_id) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'message' => 'workshop_id is required for action=participants',
        ]);
        return;
    }

    // Verify the workshop exists (and the user can see it)
    $check = $pdo->prepare("SELECT id FROM workshops WHERE id = ?");
    $check->execute([$workshop_id]);
    if (!$check->fetch()) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'message' => 'Workshop not found.',
        ]);
        return;
    }

    $stmt = $pdo->prepare("
        SELECT
            id,
            workshop_id,
            response_id,
            full_name,
            sex,
            participant_type,
            designation,
            school_office,
            email,
            attendance_status,
            registered_at,
            email_sent_at,
            cert_file_id
        FROM workshop_participants
        WHERE workshop_id = ?
        ORDER BY full_name ASC
    ");
    $stmt->execute([$workshop_id]);
    $participants = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        'success' => true,
        'data'    => $participants,
        'count'   => count($participants),
    ]);
}
?>