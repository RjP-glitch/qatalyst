<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
header('Content-Type: application/json');

require_once '../config/database.php';
require_once '../config/security.php';
require_once '../config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

/**
 * Generate the next sequence number in the format SDOCB-SMME-YYYY-NNN.
 * Looks at the highest existing sequence number for the current year
 * and increments it. Falls back to 001 if none exist yet.
 */
function generateSequenceNumber(PDO $pdo, ?int $excludeId = null): string {
    $year   = date('Y');
    $prefix = "SDOCB-SMME-{$year}-";

    $sql    = "SELECT sequence_number FROM evaluation_programs WHERE sequence_number LIKE ?";
    $params = ["{$prefix}%"];

    if ($excludeId) {
        $sql    .= " AND id != ?";
        $params[] = $excludeId;
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $max = 0;
    foreach ($rows as $sn) {
        $num = (int) substr($sn, strlen($prefix));
        if ($num > $max) $max = $num;
    }

    return $prefix . str_pad($max + 1, 3, '0', STR_PAD_LEFT);
}

try {
    $pdo    = getDB();
    $method = $_SERVER['REQUEST_METHOD'];

    $authUser = authenticate();
    if (!$authUser) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Unauthorized']);
        exit;
    }

    // ── GET: List all programs with sequence number info ─────────────────────
    if ($method === 'GET' && !isset($_GET['action'])) {
        // FIX: workshop_days table was removed. total_days is now derived from
        // the distinct day_sheet values in the respondents table instead.
        $stmt = $pdo->query("
            SELECT
                ep.id,
                ep.title,
                ep.division_memo,
                ep.sequence_number,
                ep.inclusive_dates,
                ep.start_date,
                ep.end_date,
                ep.status,
                ep.source_type,
                ep.created_at,
                ep.unit,
                ep.nature_of_event,
                ep.proponents,
                (
                    SELECT COUNT(DISTINCT r.day_sheet)
                    FROM respondents r
                    WHERE r.program_id = ep.id
                      AND r.day_sheet IS NOT NULL
                ) AS total_days,
                ep.total_participants,
                ep.total_responses
            FROM evaluation_programs ep
            ORDER BY
                CASE WHEN ep.sequence_number IS NOT NULL AND ep.sequence_number != '' THEN 0 ELSE 1 END,
                ep.sequence_number ASC,
                ep.created_at DESC
        ");
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Separate stats
        $total      = count($records);
        $withSN     = count(array_filter($records, fn($r) => !empty($r['sequence_number'])));
        $withoutSN  = $total - $withSN;
        $nextSN     = generateSequenceNumber($pdo);

        echo json_encode([
            'success'  => true,
            'records'  => $records,
            'stats'    => [
                'total'     => $total,
                'with_sn'   => $withSN,
                'without_sn'=> $withoutSN,
                'next_sn'   => $nextSN,
            ]
        ]);
        exit;
    }

    // ── GET: next_sequence ────────────────────────────────────────────────────
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'next_sequence') {
        $excludeId = isset($_GET['exclude_id']) ? (int)$_GET['exclude_id'] : null;
        echo json_encode([
            'success'         => true,
            'sequence_number' => generateSequenceNumber($pdo, $excludeId),
        ]);
        exit;
    }

    // ── GET: check_sequence (duplicate check) ─────────────────────────────────
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'check_sequence') {
        $sn        = trim($_GET['sn'] ?? '');
        $excludeId = (int)($_GET['exclude_id'] ?? 0);

        if (!$sn) {
            echo json_encode(['success' => true, 'duplicate' => false]);
            exit;
        }

        $sql    = "SELECT id, title FROM evaluation_programs WHERE sequence_number = ?";
        $params = [$sn];
        if ($excludeId) {
            $sql    .= " AND id != ?";
            $params[] = $excludeId;
        }

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        echo json_encode([
            'success'   => true,
            'duplicate' => (bool)$row,
            'id'        => $row['id']    ?? null,
            'title'     => $row['title'] ?? null,
        ]);
        exit;
    }

    // ── PATCH: Update sequence number for a single program ────────────────────
    if ($method === 'PATCH') {
        requirePermission('programs', $authUser);

        $body = json_decode(file_get_contents('php://input'), true);
        if (!$body) throw new Exception('Invalid JSON body.');

        $id = (int)($body['id'] ?? 0);
        if (!$id) throw new Exception('Program ID required.');

        // Verify the record exists
        $check = $pdo->prepare("SELECT id, sequence_number FROM evaluation_programs WHERE id = ?");
        $check->execute([$id]);
        $existing = $check->fetch(PDO::FETCH_ASSOC);
        if (!$existing) throw new Exception('Record not found.');

        $sn = isset($body['sequence_number']) ? trim((string)$body['sequence_number']) : null;

        // Allow clearing the sequence number
        if ($sn === '') $sn = null;

        // Validate format if a value was provided
        if ($sn !== null) {
            if (!preg_match('/^SDOCB-SMME-\d{4}-\d{3,}$/', $sn)) {
                throw new Exception(
                    "Invalid format. Expected: SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)."
                );
            }

            // Duplicate check
            $dupCheck = $pdo->prepare(
                "SELECT id, title FROM evaluation_programs WHERE sequence_number = ? AND id != ?"
            );
            $dupCheck->execute([$sn, $id]);
            $conflict = $dupCheck->fetch(PDO::FETCH_ASSOC);
            if ($conflict) {
                throw new Exception(
                    "\"{$sn}\" is already used by \"{$conflict['title']}\" (ID #{$conflict['id']})."
                );
            }
        }

        // Auto-assign if explicitly requested
        if (isset($body['auto_assign']) && $body['auto_assign'] === true) {
            $sn = generateSequenceNumber($pdo, $id);
        }

        $stmt = $pdo->prepare("UPDATE evaluation_programs SET sequence_number = ? WHERE id = ?");
        $stmt->execute([$sn, $id]);

        echo json_encode([
            'success'         => true,
            'message'         => 'Sequence number updated.',
            'sequence_number' => $sn,
        ]);
        exit;
    }

    // ── POST: Bulk auto-assign sequence numbers to all records missing one ────
    if ($method === 'POST' && isset($_GET['action']) && $_GET['action'] === 'bulk_assign') {
        requirePermission('programs', $authUser);

        // Fetch all records without a sequence number, oldest first
        $stmt = $pdo->prepare("
            SELECT id FROM evaluation_programs
            WHERE (sequence_number IS NULL OR sequence_number = '')
            ORDER BY created_at ASC
        ");
        $stmt->execute();
        $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $assigned = [];
        foreach ($ids as $rid) {
            $sn = generateSequenceNumber($pdo, (int)$rid);
            $pdo->prepare("UPDATE evaluation_programs SET sequence_number = ? WHERE id = ?")
                ->execute([$sn, $rid]);
            $assigned[] = ['id' => $rid, 'sequence_number' => $sn];
        }

        echo json_encode([
            'success'  => true,
            'message'  => count($assigned) . ' records assigned sequence numbers.',
            'assigned' => $assigned,
        ]);
        exit;
    }

    throw new Exception('Method not allowed.');

} catch (PDOException $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>
