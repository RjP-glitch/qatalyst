<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
header('Content-Type: application/json');

require_once '../config/database.php';
require_once '../config/security.php';
require_once '../config/auth_middleware.php';

// SECURITY: Set proper headers
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

function normalizeText($str) {
    $str = trim($str);
    $str = preg_replace('/\s+/', ' ', $str);
    return strtolower($str);
}

/**
 * Generate the next sequence number in the format SDOCB-SMME-YYYY-NNN.
 * Looks at the highest existing sequence number for the current year
 * and increments it. Falls back to 001 if none exist yet.
 *
 * @param PDO $pdo
 * @param int|null $excludeId  Program ID to exclude (for re-generation on edit)
 * @return string  e.g. "SDOCB-SMME-2025-047"
 */
function generateSequenceNumber(PDO $pdo, ?int $excludeId = null): string {
    $year   = date('Y');
    $prefix = "SDOCB-SMME-{$year}-";

    $sql = "SELECT sequence_number FROM evaluation_programs
            WHERE sequence_number LIKE ?";
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
    $id     = isset($_GET['id']) ? (int)$_GET['id'] : null;

    // Authenticate user for all operations
    $authUser = authenticate();
    if (!$authUser) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Unauthorized']);
        exit;
    }

    // ── GET CATEGORIES (ordered from eval_settings) ───────────────────────────
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'categories') {
        $stmt = $pdo->prepare("SELECT setting_value FROM eval_settings WHERE setting_key = 'categories' LIMIT 1");
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new Exception('Categories setting not found.');
        // JSON key order = insertion order = display order
        $cats = json_decode($row['setting_value'], true);
        $ordered = array_keys($cats); // preserves insertion order
        echo json_encode(['success' => true, 'categories' => $ordered]);
        exit;
    }

    // ── GET NEXT SEQUENCE NUMBER ──────────────────────────────────────────────
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'next_sequence') {
        echo json_encode([
            'success'         => true,
            'sequence_number' => generateSequenceNumber($pdo),
        ]);
        exit;
    }

    // ── CHECK SEQUENCE NUMBER (duplicate check for live validation) ───────────
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

    // ── DELETE ────────────────────────────────────────────────────────────────
    if ($method === 'DELETE') {
        // Require 'programs' permission to delete records
        requirePermission('programs', $authUser);
        
        if (!$id) throw new Exception('Program ID required.');

        $pdo->beginTransaction();

        // Fetch workshop_id before deleting so we can clean up workshop_participants
        $wIdStmt = $pdo->prepare("SELECT workshop_id FROM evaluation_programs WHERE id = ?");
        $wIdStmt->execute([$id]);
        $wRow = $wIdStmt->fetch(PDO::FETCH_ASSOC);
        $workshopId = $wRow ? $wRow['workshop_id'] : null;

        // If this program was linked to a workshop, remove the participants
        // that were imported from this specific program (response_id IS NULL = Excel import).
        // Only removes names that came from this program's respondents, not
        // participants added through other means (e.g. online responses).
        if ($workshopId) {
            $pdo->prepare("
                DELETE wp FROM workshop_participants wp
                WHERE wp.workshop_id = :wid
                  AND wp.response_id IS NULL
                  AND wp.full_name IN (
                      SELECT respondent_name FROM respondents WHERE program_id = :pid
                  )
            ")->execute([':wid' => $workshopId, ':pid' => $id]);
        }

        $pdo->prepare("
            DELETE sc FROM speaker_criteria sc
            INNER JOIN speaker_averages sa ON sc.speaker_avg_id = sa.id
            WHERE sa.program_id = ?
        ")->execute([$id]);

        $pdo->prepare("DELETE FROM speaker_averages WHERE program_id = ?")->execute([$id]);
        $pdo->prepare("DELETE FROM category_averages WHERE program_id = ?")->execute([$id]);
        $pdo->prepare("DELETE FROM column_averages WHERE program_id = ?")->execute([$id]);

        $pdo->prepare("
            DELETE rf FROM respondent_feedback rf
            INNER JOIN respondents r ON rf.respondent_id = r.id
            WHERE r.program_id = ?
        ")->execute([$id]);

        $pdo->prepare("
            DELETE rs FROM respondent_scores rs
            INNER JOIN respondents r ON rs.respondent_id = r.id
            WHERE r.program_id = ?
        ")->execute([$id]);

        $pdo->prepare("DELETE FROM respondents WHERE program_id = ?")->execute([$id]);
        $pdo->prepare("DELETE FROM evaluation_programs WHERE id = ?")->execute([$id]);

        $pdo->commit();
        echo json_encode(['success' => true, 'message' => 'Record deleted.']);
        exit;
    }

    // ── GET SINGLE ───────────────────────────────────────────────────────────
    if ($method === 'GET' && $id) {
        $stmt = $pdo->prepare("SELECT * FROM evaluation_programs WHERE id = ?");
        $stmt->execute([$id]);
        $program = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$program) throw new Exception('Program not found.');

        // Include feedback question labels — one label per position (insertion order).
        // Positional order: expectations(0), improvements(1), insights(2), further(3).
        $program['feedback_labels'] = null;
        try {
            $fbKeys   = ['expectations', 'improvements', 'insights', 'further'];
            $lblStmt  = $pdo->prepare("
                SELECT NULLIF(TRIM(rf.feedback_label), '') AS feedback_label
                FROM respondent_feedback rf
                INNER JOIN respondents r ON rf.respondent_id = r.id
                WHERE r.program_id = ? AND rf.feedback_label IS NOT NULL AND TRIM(rf.feedback_label) != ''
                ORDER BY rf.id
                LIMIT 4
            ");
            $lblStmt->execute([$id]);
            $lblRows = $lblStmt->fetchAll(PDO::FETCH_COLUMN);
            $map = [];
            foreach ($lblRows as $pos => $lbl) {
                if ($lbl && isset($fbKeys[$pos])) $map[$fbKeys[$pos]] = $lbl;
            }
            if (!empty($map)) $program['feedback_labels'] = $map;
        } catch (Exception $_) {
            // non-fatal
        }

        // ── Monitoring branch — lightweight respondents list ──────────────────
        if (isset($_GET['monitoring'])) {
            $rStmt = $pdo->prepare("
                SELECT
                    r.id,
                    r.respondent_name,
                    r.sex,
                    r.participant_type,
                    r.designation,
                    r.school_office,
                    r.email,
                    r.day_sheet,
                    r.average_score,
                    r.result_label
                FROM respondents r
                WHERE r.program_id = ?
                ORDER BY r.day_sheet, r.respondent_name
            ");
            $rStmt->execute([$id]);
            $respondents = $rStmt->fetchAll(PDO::FETCH_ASSOC);

            // Build days_breakdown for the completion bars
            $dayMap = [];
            foreach ($respondents as $r) {
                $d = $r['day_sheet'] ?? 'Day 1';
                if (!isset($dayMap[$d])) $dayMap[$d] = 0;
                $dayMap[$d]++;
            }
            $daysBreakdown = [];
            $dayNum = 1;
            foreach ($dayMap as $dayName => $cnt) {
                $daysBreakdown[] = [
                    'day_number' => $dayNum++,
                    'day_name'   => $dayName,
                    'completed'  => $cnt,
                    'total'      => $cnt,
                ];
            }

            $program['respondents']     = $respondents;
            $program['days_breakdown']  = $daysBreakdown;
            echo json_encode(['success' => true, 'program' => $program]);
            exit;
        }

        $stmt = $pdo->prepare("
            SELECT DISTINCT day_sheet
            FROM category_averages
            WHERE program_id = ? AND is_overall = 0 AND day_sheet IS NOT NULL
            ORDER BY day_sheet
        ");
        $stmt->execute([$id]);
        $daySheets = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $stmt = $pdo->prepare("
            SELECT day_sheet, COUNT(*) as cnt
            FROM respondents
            WHERE program_id = ?
            GROUP BY day_sheet
        ");
        $stmt->execute([$id]);
        $respondentCounts = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row)
            $respondentCounts[$row['day_sheet']] = $row['cnt'];

        $days = [];
        foreach ($daySheets as $day) {
            $stmt = $pdo->prepare("
                SELECT category_name, average_score, result_label
                FROM category_averages
                WHERE program_id = ? AND day_sheet = ? AND is_overall = 0
                ORDER BY id
            ");
            $stmt->execute([$id, $day]);
            $categories = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $qCatMap = [];
            $eqStmt = $pdo->query("
                SELECT
                    eq.question_text,
                    eq.display_order,
                    eqc.name AS category_name
                FROM evaluation_questions eq
                INNER JOIN evaluation_question_categories eqc ON eq.category_id = eqc.id
                WHERE eq.question_type = 'rating'
                  AND eq.is_for_speaker = 0
                  AND eq.is_active = 1
                ORDER BY eqc.display_order, eq.display_order
            ");
            foreach ($eqStmt->fetchAll(PDO::FETCH_ASSOC) as $eq) {
                $qCatMap[$eq['category_name']][] = [
                    'text'  => $eq['question_text'],
                    'order' => $eq['display_order'],
                ];
            }

            $allQStmt = $pdo->prepare("
                SELECT
                    TRIM(rs.question_header) AS qh_clean,
                    ROUND(AVG(rs.score), 2)  AS avg_score,
                    COUNT(rs.score)           AS n
                FROM respondent_scores rs
                INNER JOIN respondents r ON rs.respondent_id = r.id
                WHERE r.program_id = ?
                  AND r.day_sheet  = ?
                  AND rs.score IS NOT NULL
                  AND rs.question_header NOT LIKE '%Knowledgeable%'
                  AND rs.question_header NOT LIKE '%Resource Person%'
                  AND rs.question_header NOT LIKE '%Resource Speaker%'
                  AND rs.question_header NOT LIKE '%Start and end%'
                GROUP BY TRIM(rs.question_header)
            ");
            $allQStmt->execute([$id, $day]);
            $qAvgIndex = [];
            foreach ($allQStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $normalizedKey = normalizeText($row['qh_clean']);
                $qAvgIndex[$normalizedKey] = $row;
            }

            foreach ($categories as &$cat) {
                $catName  = $cat['category_name'];
                $col_avgs = [];

                $normalizedCatName = strtolower(str_replace(['&', ' and '], ['and', 'and'], $catName));
                $normalizedCatName = preg_replace('/\s+/', '', $normalizedCatName);

                $questions = $qCatMap[$catName] ?? null;
                if (!$questions) {
                    foreach ($qCatMap as $qcName => $qList) {
                        $normalizedQcName = strtolower(str_replace(['&', ' and '], ['and', 'and'], $qcName));
                        $normalizedQcName = preg_replace('/\s+/', '', $normalizedQcName);
                        if ($normalizedCatName === $normalizedQcName ||
                            stripos($qcName, $catName) !== false ||
                            stripos($catName, $qcName) !== false) {
                            $questions = $qList;
                            break;
                        }
                    }
                }

                if ($questions) {
                    foreach ($questions as $q) {
                        $key = normalizeText($q['text']);
                        if (isset($qAvgIndex[$key])) {
                            $col_avgs[] = [
                                'question_header' => $q['text'],
                                'avg_score'       => $qAvgIndex[$key]['avg_score'],
                                'n'               => $qAvgIndex[$key]['n'],
                            ];
                        }
                    }
                }

                $cat['col_avgs'] = $col_avgs;
            }
            unset($cat);

            $stmt = $pdo->prepare("
                SELECT id, slot_number, speaker_name, overall_avg, result_label
                FROM speaker_averages
                WHERE program_id = ? AND day_sheet = ?
                ORDER BY slot_number
            ");
            $stmt->execute([$id, $day]);
            $speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($speakers as &$sp) {
                $stmt = $pdo->prepare("
                    SELECT criterion_label, average_score
                    FROM speaker_criteria
                    WHERE speaker_avg_id = ?
                    ORDER BY id
                ");
                $stmt->execute([$sp['id']]);
                $sp['criteria'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
            }
            unset($sp);

            $days[] = [
                'day'         => $day,
                'respondents' => $respondentCounts[$day] ?? 0,
                'categories'  => $categories,
                'speakers'    => $speakers,
            ];
        }

        $stmt = $pdo->prepare("
            SELECT category_name, average_score, result_label
            FROM category_averages
            WHERE program_id = ? AND is_overall = 1
            ORDER BY id
        ");
        $stmt->execute([$id]);
        $overallCategories = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $feedback = [
            'expectations_met'          => [],
            'improvement_suggestions'   => [],
            'significant_insights'      => [],
            'further_training_interest' => [],
        ];

        // Query actual feedback from respondent_feedback table.
        // Rows are ordered by rf.id ASC within each respondent, matching the
        // insertion order: expectations(0), improvements(1), insights(2), further(3).
        $fbOutputKeys = ['expectations_met', 'improvement_suggestions', 'significant_insights', 'further_training_interest'];
        $fbStmt = $pdo->prepare("
            SELECT rf.respondent_id, rf.feedback_value
            FROM respondent_feedback rf
            INNER JOIN respondents r ON rf.respondent_id = r.id
            WHERE r.program_id = ?
              AND rf.feedback_value IS NOT NULL
              AND TRIM(rf.feedback_value) != ''
            ORDER BY rf.respondent_id, rf.id
        ");
        $fbStmt->execute([$id]);
        $fbPosCounter = [];
        foreach ($fbStmt->fetchAll(PDO::FETCH_ASSOC) as $fbRow) {
            $rid = $fbRow['respondent_id'];
            $pos = $fbPosCounter[$rid] ?? 0;
            $fbPosCounter[$rid] = $pos + 1;
            $outputKey = $fbOutputKeys[$pos] ?? null;
            if (!$outputKey) continue;
            $val = preg_replace('/\s+/', ' ', trim((string)($fbRow['feedback_value'] ?? '')));
            if ($val === '') continue;
            if (preg_match('/^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i', $val)) continue;
            if (preg_match('/^\d+(\.\d+)?$/', $val)) continue;
            if (preg_match('/^[^a-zA-Z0-9]+$/', $val)) continue;
            $feedback[$outputKey][] = $val;
        }

        $program['days']               = $days;
        $program['overall_categories'] = $overallCategories;
        $program['feedback']           = $feedback;

        // Extract day_participants from settings_snapshot (saved by import page)
        // so the report generator can use per-day denominators for percentages.
        $program['day_participants'] = null;
        if (!empty($program['settings_snapshot'])) {
            $snap = json_decode($program['settings_snapshot'], true);
            if (!empty($snap['day_participants']) && is_array($snap['day_participants'])) {
                $program['day_participants'] = $snap['day_participants'];
            }
        }

        echo json_encode(['success' => true, 'program' => $program]);
        exit;
    }

    // ── GET LIST ─────────────────────────────────────────────────────────────
    if ($method === 'GET') {
        // Only return standalone imports (workshop_id IS NULL).
        // Records linked to a container program (workshop_id IS NOT NULL) are
        // already surfaced through programs.php?type=container → linked_imports,
        // so excluding them here prevents their speakers from appearing outside
        // the container in the speaker roster.
        $stmt = $pdo->query("
            SELECT id, title, proponents, training_venue, inclusive_dates,
                   qame_associates, total_participants, total_responses,
                   pct_responses, overall_average, overall_result,
                   workshop_id, source_type, source_filename,
                   sequence_number,
                   created_at
            FROM evaluation_programs
            WHERE workshop_id IS NULL
            ORDER BY created_at DESC
        ");
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['success' => true, 'records' => $records]);
        exit;
    }

    // ── PATCH (edit Excel record metadata) ───────────────────────────────────
    if ($method === 'PATCH') {
        requirePermission('programs', $authUser);

        $body = json_decode(file_get_contents('php://input'), true);
        if (!$body) throw new Exception('Invalid JSON body.');

        $id = (int)($body['id'] ?? 0);
        if (!$id) throw new Exception('Record ID required.');

        // Verify the record exists
        $check = $pdo->prepare("SELECT id FROM evaluation_programs WHERE id = ?");
        $check->execute([$id]);
        if (!$check->fetch()) throw new Exception('Record not found.');

        // Only allow updating safe metadata fields — never scores/averages
        $allowed = [
            'title', 'proponents', 'inclusive_dates', 'training_venue',
            'qame_associates', 'total_participants',
            // Extended fields added to match Save Evaluation modal
            'division_memo', 'status', 'unit', 'nature_of_event',
            'start_date', 'end_date', 'description',
            'sequence_number',
        ];

        $setClauses = [];
        $params     = [];

        foreach ($allowed as $field) {
            if (array_key_exists($field, $body)) {
                $setClauses[] = "`$field` = ?";
                $params[]     = $body[$field] !== null ? trim((string)$body[$field]) : null;
            }
        }

        // Allow a speakers-only PATCH — only fail if nothing at all was provided
        $hasSpeakersUpdate = !empty($body['speakers']) && is_array($body['speakers']);
        if (empty($setClauses) && !$hasSpeakersUpdate) throw new Exception('No valid fields provided.');

        // title is required and must not be blank
        if (isset($body['title']) && trim((string)$body['title']) === '') {
            throw new Exception('Title cannot be empty.');
        }

        // ── Sequence number validation ────────────────────────────────────────
        if (array_key_exists('sequence_number', $body) && !empty(trim((string)$body['sequence_number']))) {
            $sn = trim((string)$body['sequence_number']);

            // 1. Format check — must match SDOCB-SMME-YYYY-NNN
            if (!preg_match('/^SDOCB-SMME-\d{4}-\d{3,}$/', $sn)) {
                throw new Exception(
                    "Invalid sequence number format. Expected format: SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)."
                );
            }

            // 2. Duplicate check — must not be used by another record
            $dupCheck = $pdo->prepare(
                "SELECT id FROM evaluation_programs WHERE sequence_number = ? AND id != ?"
            );
            $dupCheck->execute([$sn, $id]);
            $conflict = $dupCheck->fetch(PDO::FETCH_ASSOC);
            if ($conflict) {
                throw new Exception(
                    "Sequence number \"{$sn}\" is already used by another record (ID #{$conflict['id']}). Please choose a different number."
                );
            }
        }

        // Auto-assign a sequence number if the record doesn't have one yet
        // and the caller didn't explicitly supply one.
        if (!array_key_exists('sequence_number', $body)) {
            $snCheck = $pdo->prepare("SELECT sequence_number FROM evaluation_programs WHERE id = ?");
            $snCheck->execute([$id]);
            $existingSN = $snCheck->fetchColumn();
            if (empty($existingSN)) {
                $autoSN       = generateSequenceNumber($pdo, $id);
                $setClauses[] = "`sequence_number` = ?";
                $params[]     = $autoSN;
            }
        }

        if (!empty($setClauses)) {
            $params[] = $id;
            $pdo->prepare("UPDATE evaluation_programs SET " . implode(', ', $setClauses) . " WHERE id = ?")
                ->execute($params);
        }

        // ── Update speaker names if provided ─────────────────────────────────
        if (!empty($body['speakers']) && is_array($body['speakers'])) {
            $spStmt = $pdo->prepare("
                UPDATE speaker_averages
                SET speaker_name = ?
                WHERE id = ? AND program_id = ?
            ");
            foreach ($body['speakers'] as $sp) {
                $spId   = (int)($sp['id']   ?? 0);
                $spName = trim((string)($sp['name'] ?? ''));
                if ($spId > 0) {
                    $spStmt->execute([$spName ?: null, $spId, $id]);
                }
            }
        }

        echo json_encode(['success' => true, 'message' => 'Record updated.']);
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