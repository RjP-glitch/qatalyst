<?php
// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/auth_middleware.php';

// SECURITY: Require authentication for data access
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
    exit();
}

/**
 * Normalise a category name for fuzzy comparison — same logic as
 * program_dashboard.php's normCat(), duplicated here so this endpoint's
 * category averages agree with the live dashboard's instead of treating
 * "Program Management & Operations" and "...and Operations" (etc.) as two
 * different categories.
 */
function normCat(string $s): string {
    $s = strtolower($s);
    $s = str_replace('&', ' and ', $s);
    $s = preg_replace('/\(.*?\)/', '', $s);   // strip (…) suffixes
    $s = preg_replace('/[^a-z0-9 ]/', '', $s);
    return trim(preg_replace('/\s+/', ' ', $s));
}

// ─── DELETE ───────────────────────────────────────────────────��───────────────
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    // Require 'programs' permission to delete responses
    requirePermission('programs', $authUser);
    
    $participant_id = isset($_GET['participant_id']) ? intval($_GET['participant_id']) : 0;
    if (!$participant_id) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing participant_id']);
        exit();
    }
    try {
        $deleted = false;

        // ── Excel-imported respondent ─────────────────────────────────────────
        if (!$deleted) {
            $chk = $pdo->prepare("SELECT id FROM respondents WHERE id = ? LIMIT 1");
            $chk->execute([$participant_id]);
            if ($chk->fetch()) {
                $pdo->prepare("DELETE FROM respondent_feedback WHERE respondent_id = ?")->execute([$participant_id]);
                $pdo->prepare("DELETE FROM respondent_scores   WHERE respondent_id = ?")->execute([$participant_id]);
                $pdo->prepare("DELETE FROM respondents          WHERE id = ?")->execute([$participant_id]);
                $deleted = true;
            }
        }

        if (!$deleted) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Response not found']);
            exit();
        }

        echo json_encode(['success' => true, 'message' => 'Response deleted']);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit();
}

// ─── GET ──────────────────────────────────────────────────────────────────────
try {

    // ═══════════════════════════════════════════════════════════════════════════
    //  CATEGORY AVERAGES  — ?workshop_id=X&categories=1[&workshop_day_id=Y]
    //  Also handles the program_id fallback for Excel-imported records
    // ═══════════════════════════════════════════════════════════════════════════
    $workshop_id    = isset($_GET['workshop_id'])     ? intval($_GET['workshop_id'])     : 0;
    $program_id     = isset($_GET['program_id'])      ? intval($_GET['program_id'])      : 0;
    // BUG FIX: this was referenced below (`!$workshop_day_id`) without ever being
    // assigned from $_GET, relying on PHP's "undefined variable is falsy" behavior.
    // That happened to still work, but threw a PHP warning on every request — and
    // if the host's php.ini has display_errors On, that warning gets printed into
    // the JSON response body, breaking json_decode() on the client and silently
    // triggering fallback paths (e.g. the PPT export's respondent-count fallback).
    $workshop_day_id = isset($_GET['workshop_day_id']) ? intval($_GET['workshop_day_id']) : 0;
    // For Excel records, day filtering uses the sheet name string (e.g. "Day 1")
    $day_sheet      = isset($_GET['day_sheet'])       ? trim($_GET['day_sheet'])         : '';

    if (isset($_GET['categories'])) {

        // ── Container "All Days Combined" path: workshop_id with no day_sheet ─
        // Aggregates category_averages across all program_imports linked to this workshop.
        if ($workshop_id && !$workshop_day_id && $day_sheet === '') {
            $piCheck = $pdo->prepare("SELECT COUNT(*) FROM program_imports WHERE workshop_id = ?");
            $piCheck->execute([$workshop_id]);
            if ((int)$piCheck->fetchColumn() > 0) {
                // BUG FIX: was a raw SQL `GROUP BY ca.category_name`, which treats
                // e.g. "Program Management & Operations" (Day 1's wording) and
                // "Program Management and Operations" (Day 2's wording) as two
                // separate categories — so the "average" for one ends up reflecting
                // only one day's data instead of the true combined average across
                // all linked days. Fetch ungrouped and normalise with normCat()
                // before averaging, same as program_dashboard.php already does.
                $stmt = $pdo->prepare("
                    SELECT ca.id, ca.category_name, ca.average_score
                    FROM category_averages ca
                    INNER JOIN program_imports pi ON pi.program_id = ca.program_id
                    WHERE pi.workshop_id = ? AND ca.is_overall = 1
                    ORDER BY ca.id
                ");
                $stmt->execute([$workshop_id]);
                $rawRows = $stmt->fetchAll(PDO::FETCH_ASSOC);

                $grouped = []; // normCat(name) => ['display' => name, 'sum' => x, 'count' => n, 'firstId' => id]
                foreach ($rawRows as $row) {
                    $norm = normCat($row['category_name']);
                    if (!isset($grouped[$norm])) {
                        $grouped[$norm] = [
                            'display'  => $row['category_name'],
                            'sum'      => 0.0,
                            'count'    => 0,
                            'firstId'  => (int)$row['id'],
                        ];
                    }
                    $grouped[$norm]['sum']   += (float)$row['average_score'];
                    $grouped[$norm]['count']++;
                }
                uasort($grouped, fn($a, $b) => $a['firstId'] <=> $b['firstId']);

                $cats = array_values(array_map(function ($g) {
                    return [
                        'category_name' => $g['display'],
                        'average_score' => round($g['sum'] / $g['count'], 4),
                    ];
                }, $grouped));

                // BUG FIX: this used to COUNT(DISTINCT email-or-name), deduplicating
                // respondents who attended more than one day. That disagreed with
                // program_dashboard.php's response_count, which deliberately counts
                // every respondent ROW with no dedup at all (see the FIX comment in
                // program_dashboard.php: name-based dedup under-counts when two
                // people share a name, and is unreliable when every email is blank).
                // Match that same raw-count convention here so the PPT/Word/PDF
                // exporters' respondent counts always agree with the live dashboard.
                $totalStmt = $pdo->prepare("
                    SELECT COUNT(*)
                    FROM respondents r
                    INNER JOIN program_imports pi ON pi.program_id = r.program_id
                    WHERE pi.workshop_id = ?
                ");
                $totalStmt->execute([$workshop_id]);
                $total = (int)$totalStmt->fetchColumn();

                // METHOD CHANGE: overall average is now a straight (unweighted) mean of
                // the category averages in $cats — i.e. each of the 6 categories counts
                // equally, matching the manual/paper QATAME computation. This used to be
                // AVG(rs.score) over every individual question score, which silently gave
                // more influence to categories with more questions and drifted from the
                // manual figure (e.g. 3.92 vs a manually-computed 3.89 on the same data).
                // Kept the field name 'overall_weighted_average' for API compatibility,
                // even though it's no longer question-weighted.
                $overallWeightedAverage = count($cats) > 0
                    ? round(array_sum(array_column($cats, 'average_score')) / count($cats), 4)
                    : null;

                echo json_encode([
                    'success'                  => true,
                    'category_averages'        => $cats,
                    'total_respondents'        => $total,
                    'overall_weighted_average' => $overallWeightedAverage,
                ]);
                exit();
            }
            // No Excel imports — fall through to the live workshop path below
        }

        // ── Excel-imported record path (single program_id) ─────────────────
        if ($program_id) {
            // When a specific day is selected, query that day's per-day averages.
            // When no day is selected (all days), use is_overall = 1 (the stored overall).
            if ($day_sheet !== '') {
                $stmt = $pdo->prepare("
                    SELECT category_name, ROUND(AVG(average_score), 4) AS average_score
                    FROM category_averages
                    WHERE program_id = ? AND day_sheet = ? AND is_overall = 0
                    GROUP BY category_name
                    ORDER BY MIN(id)
                ");
                $stmt->execute([$program_id, $day_sheet]);
            } else {
                $stmt = $pdo->prepare("
                    SELECT category_name, ROUND(AVG(average_score), 4) AS average_score
                    FROM category_averages
                    WHERE program_id = ? AND is_overall = 1
                    GROUP BY category_name
                    ORDER BY MIN(id)
                ");
                $stmt->execute([$program_id]);
            }
            $cats = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $totalStmt = $day_sheet !== ''
                ? $pdo->prepare("SELECT COUNT(*) FROM respondents WHERE program_id = ? AND day_sheet = ?")
                : $pdo->prepare("SELECT COUNT(*) FROM respondents WHERE program_id = ?");
            $totalParams = $day_sheet !== '' ? [$program_id, $day_sheet] : [$program_id];
            $totalStmt->execute($totalParams);
            $total = (int)$totalStmt->fetchColumn();

            // METHOD CHANGE: overall average is now a straight (unweighted) mean of the
            // category averages in $cats, scoped the same way the category query above
            // is scoped (single day if day_sheet given, else the whole import). Each
            // category counts equally, matching the manual/paper QATAME computation —
            // see the matching comment in the "All Days Combined" branch above.
            $overallWeightedAverage = count($cats) > 0
                ? round(array_sum(array_column($cats, 'average_score')) / count($cats), 4)
                : null;

            echo json_encode([
                'success'                  => true,
                'category_averages'        => $cats,
                'total_respondents'        => $total,
                'overall_weighted_average' => $overallWeightedAverage,
            ]);
            exit();
        }

        echo json_encode(['success' => true, 'category_averages' => [], 'total_respondents' => 0]);
        exit();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  COLUMN (per-indicator) AVERAGES  — ?workshop_id=X&column_averages=1
    // ═══════════════════════════════════════════════════════════════════════════
    if (isset($_GET['column_averages'])) {

        // ── Container "All Days Combined" path ─────────────────────────────
        if ($workshop_id && !$workshop_day_id && $day_sheet === '') {
            $piCheck = $pdo->prepare("SELECT COUNT(*) FROM program_imports WHERE workshop_id = ?");
            $piCheck->execute([$workshop_id]);
            if ((int)$piCheck->fetchColumn() > 0) {
                $stmt = $pdo->prepare("
                    SELECT
                        ca.category_name,
                        ca.question_header,
                        ROUND(AVG(ca.average_score), 4) AS average_score,
                        MIN(ca.id) AS sort_order
                    FROM column_averages ca
                    INNER JOIN program_imports pi ON pi.program_id = ca.program_id
                    WHERE pi.workshop_id = ?
                    GROUP BY ca.category_name, ca.question_header
                    ORDER BY ca.category_name, sort_order
                ");
                $stmt->execute([$workshop_id]);
                $cols = $stmt->fetchAll(PDO::FETCH_ASSOC);
                echo json_encode(['success' => true, 'column_averages' => $cols]);
                exit();
            }
        }

        // ── Excel-imported record path (single program_id) ─────────────────
        if ($program_id) {
            if ($day_sheet !== '') {
                $stmt = $pdo->prepare("
                    SELECT
                        category_name,
                        question_header,
                        ROUND(AVG(average_score), 4) AS average_score,
                        MIN(id) AS sort_order
                    FROM column_averages
                    WHERE program_id = ? AND day_sheet = ?
                    GROUP BY category_name, question_header
                    ORDER BY category_name, sort_order
                ");
                $stmt->execute([$program_id, $day_sheet]);
            } else {
                $stmt = $pdo->prepare("
                    SELECT
                        category_name,
                        question_header,
                        ROUND(AVG(average_score), 4) AS average_score,
                        MIN(id) AS sort_order
                    FROM column_averages
                    WHERE program_id = ?
                    GROUP BY category_name, question_header
                    ORDER BY category_name, sort_order
                ");
                $stmt->execute([$program_id]);
            }
            $cols = $stmt->fetchAll(PDO::FETCH_ASSOC);

            echo json_encode(['success' => true, 'column_averages' => $cols]);
            exit();
        }

        echo json_encode(['success' => true, 'column_averages' => []]);
        exit();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SPEAKER AVERAGES  — ?workshop_id=X&speaker_averages=1
    // ═══════════════════════════════════════════════════════════════════════════
    if (isset($_GET['speaker_averages'])) {

        // ── Container "All Days Combined" path ─────────────────────────────
        if ($workshop_id && !$workshop_day_id && $day_sheet === '') {
            $piCheck = $pdo->prepare("SELECT COUNT(*) FROM program_imports WHERE workshop_id = ?");
            $piCheck->execute([$workshop_id]);
            if ((int)$piCheck->fetchColumn() > 0) {
                $stmt = $pdo->prepare("
                    SELECT sa.id, sa.slot_number, sa.speaker_name,
                           ROUND(AVG(sa.overall_avg), 4) AS overall_avg,
                           sa.result_label, sa.day_sheet
                    FROM speaker_averages sa
                    INNER JOIN program_imports pi ON pi.program_id = sa.program_id
                    WHERE pi.workshop_id = ?
                    GROUP BY sa.slot_number, sa.speaker_name, sa.result_label, sa.day_sheet
                    ORDER BY sa.day_sheet, sa.slot_number
                ");
                $stmt->execute([$workshop_id]);
                $speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // BUG FIX: this used to join back to speaker_averages/program_imports and
                // filter by (workshop_id, slot_number) alone, which pulled criteria from
                // EVERY speaker in the workshop who ever occupied that slot number on any
                // day — silently averaging Rowena's Day-1 "Slot 1" scores together with
                // whoever else was "Slot 1" on Day 2/3/4. Since the outer query already
                // grouped by (slot_number, speaker_name, day_sheet), each $sp row here
                // corresponds to exactly one speaker_averages.id — just look up that row's
                // own criteria directly, with no cross-speaker aggregation at all.
                foreach ($speakers as &$sp) {
                    $cStmt = $pdo->prepare("
                        SELECT criterion_label, ROUND(average_score, 4) AS average_score
                        FROM speaker_criteria
                        WHERE speaker_avg_id = ?
                        ORDER BY id
                    ");
                    $cStmt->execute([$sp['id']]);
                    $sp['criteria'] = $cStmt->fetchAll(PDO::FETCH_ASSOC);
                }
                unset($sp);

                echo json_encode(['success' => true, 'speaker_averages' => $speakers]);
                exit();
            }
        }

        // ── Excel-imported record path (single program_id) ─────────────────
        if ($program_id) {
            if ($day_sheet !== '') {
                $stmt = $pdo->prepare("
                    SELECT sa.id, sa.slot_number, sa.speaker_name,
                           ROUND(sa.overall_avg, 4) AS overall_avg, sa.result_label, sa.day_sheet
                    FROM speaker_averages sa
                    WHERE sa.program_id = ? AND sa.day_sheet = ?
                    ORDER BY sa.slot_number
                ");
                $stmt->execute([$program_id, $day_sheet]);
            } else {
                $stmt = $pdo->prepare("
                    SELECT sa.id, sa.slot_number, sa.speaker_name,
                           ROUND(sa.overall_avg, 4) AS overall_avg, sa.result_label, sa.day_sheet
                    FROM speaker_averages sa
                    WHERE sa.program_id = ?
                    ORDER BY sa.day_sheet, sa.slot_number
                ");
                $stmt->execute([$program_id]);
            }
            $speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($speakers as &$sp) {
                $cStmt = $pdo->prepare("
                    SELECT criterion_label, ROUND(average_score, 4) AS average_score
                    FROM speaker_criteria
                    WHERE speaker_avg_id = ?
                    ORDER BY id
                ");
                $cStmt->execute([$sp['id']]);
                $sp['criteria'] = $cStmt->fetchAll(PDO::FETCH_ASSOC);
            }
            unset($sp);

            echo json_encode(['success' => true, 'speaker_averages' => $speakers]);
            exit();
        }

        echo json_encode(['success' => true, 'speaker_averages' => []]);
        exit();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  FEEDBACK  — ?workshop_id=X&feedback=1
    // ═══════════════════════════════════════════════════════════════════════════
    if (isset($_GET['feedback'])) {

        // Shared noise filter
        $NOISE_RX = '/^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|--?)$/i';

        // Shared helper: build feedback array from respondent_feedback rows.
        // Supports two schemas:
        //   New: feedback_label = actual Excel column header → use as key directly.
        //   Old: feedback_label = NULL → fall back to insertion-order positional keys.
        $buildFeedback = function(array $rows) use ($NOISE_RX): array {
            $byRespondent = [];
            $posCounter   = [];
            $columnOrder  = []; // ordered list of distinct label keys seen

            foreach ($rows as $row) {
                $rid = $row['respondent_id'];

                $val = preg_replace('/\s+/', ' ', trim((string)($row['feedback_value'] ?? '')));
                if ($val === ''
                    || preg_match($NOISE_RX, $val)
                    || preg_match('/^\d+(\.\d+)?$/', $val)
                    || preg_match('/^[^a-zA-Z0-9]+$/', $val)
                ) continue;

                if (!isset($byRespondent[$rid])) {
                    $byRespondent[$rid] = ['day_sheet' => $row['day_sheet'] ?? ''];
                    $posCounter[$rid]   = 0;
                }

                $rawLabel = trim((string)($row['feedback_label'] ?? ''));

                if ($rawLabel !== '') {
                    // New schema: use the stored label as the key.
                    // First value wins (guards against duplicate rows for same label).
                    if (!isset($byRespondent[$rid][$rawLabel])) {
                        $byRespondent[$rid][$rawLabel] = $val;
                    }
                    if (!in_array($rawLabel, $columnOrder, true)) {
                        $columnOrder[] = $rawLabel;
                    }
                } else {
                    // Old schema (NULL label): assign by insertion position.
                    $pos = $posCounter[$rid];
                    $posKey = '__pos_' . $pos;
                    if (!isset($byRespondent[$rid][$posKey])) {
                        $byRespondent[$rid][$posKey] = $val;
                    }
                    if (!in_array($posKey, $columnOrder, true)) {
                        $columnOrder[] = $posKey;
                    }
                }
                $posCounter[$rid]++;
            }

            return array_values(array_map(function($fb) use ($columnOrder) {
                $out = ['day_sheet' => $fb['day_sheet'] ?? ''];
                foreach ($columnOrder as $label) {
                    $out[$label] = $fb[$label] ?? '';
                }
                return $out;
            }, $byRespondent));
        };

        // ── Container "All Days Combined" path ─────────────────────────────
        if ($workshop_id && !$workshop_day_id && $day_sheet === '') {
            $piCheck = $pdo->prepare("SELECT COUNT(*) FROM program_imports WHERE workshop_id = ?");
            $piCheck->execute([$workshop_id]);
            if ((int)$piCheck->fetchColumn() > 0) {
                $stmt = $pdo->prepare("
                    SELECT rf.respondent_id, rf.feedback_label,
                           rf.feedback_value, pi.day_label AS day_sheet
                    FROM respondent_feedback rf
                    INNER JOIN respondents r ON rf.respondent_id = r.id
                    INNER JOIN program_imports pi ON pi.program_id = r.program_id
                    WHERE pi.workshop_id = ?
                      AND rf.feedback_value IS NOT NULL AND TRIM(rf.feedback_value) != ''
                    ORDER BY pi.day_label, rf.respondent_id, rf.id
                ");
                $stmt->execute([$workshop_id]);
                $feedback = $buildFeedback($stmt->fetchAll(PDO::FETCH_ASSOC));
                echo json_encode(['success' => true, 'feedback' => $feedback]);
                exit();
            }
        }

        // ── Excel-imported record path (single program_id) ──────────────────
        if ($program_id) {
            $sql = $day_sheet !== ''
                ? "SELECT rf.respondent_id, rf.feedback_label,
                          rf.feedback_value, r.day_sheet
                   FROM respondent_feedback rf
                   INNER JOIN respondents r ON rf.respondent_id = r.id
                   WHERE r.program_id = ? AND r.day_sheet = ?
                     AND rf.feedback_value IS NOT NULL AND TRIM(rf.feedback_value) != ''
                   ORDER BY rf.respondent_id, rf.id"
                : "SELECT rf.respondent_id, rf.feedback_label,
                          rf.feedback_value, r.day_sheet
                   FROM respondent_feedback rf
                   INNER JOIN respondents r ON rf.respondent_id = r.id
                   WHERE r.program_id = ?
                     AND rf.feedback_value IS NOT NULL AND TRIM(rf.feedback_value) != ''
                   ORDER BY r.day_sheet, rf.respondent_id, rf.id";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($day_sheet !== '' ? [$program_id, $day_sheet] : [$program_id]);
            $feedback = $buildFeedback($stmt->fetchAll(PDO::FETCH_ASSOC));
            echo json_encode(['success' => true, 'feedback' => $feedback]);
            exit();
        }

        echo json_encode(['success' => true, 'feedback' => []]);
        exit();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SINGLE PARTICIPANT DETAIL  — ?participant_id=X
    // ═══════════════════════════════════════════════════════════════════════════
    if (isset($_GET['participant_id'])) {
        $participant_id = intval($_GET['participant_id']);

        $rStmt = $pdo->prepare("
            SELECT id, respondent_name AS full_name, sex, participant_type,
                   designation, school_office, email, day_sheet,
                   average_score, result_label, program_id
            FROM respondents WHERE id = ? LIMIT 1
        ");
        $rStmt->execute([$participant_id]);
        $respondent = $rStmt->fetch(PDO::FETCH_ASSOC);

        if (!$respondent) {
            echo json_encode(['success' => false, 'message' => 'Response not found']);
            exit();
        }

        // Get per-question scores
        $sStmt = $pdo->prepare("
            SELECT question_header AS question, score AS rating, category_name AS category
            FROM respondent_scores WHERE respondent_id = ? ORDER BY id
        ");
        $sStmt->execute([$participant_id]);
        $scores = $sStmt->fetchAll(PDO::FETCH_ASSOC);

        $ratings = [];
        foreach ($scores as $s) {
            $ratings[$s['category']][] = ['question' => $s['question'], 'rating' => $s['rating']];
        }

        // Get feedback
        $fStmt = $pdo->prepare("
            SELECT feedback_value FROM respondent_feedback
            WHERE respondent_id = ? ORDER BY id
        ");
        $fStmt->execute([$participant_id]);
        $feedbackParts = array_filter(array_column($fStmt->fetchAll(PDO::FETCH_ASSOC), 'feedback_value'));

        echo json_encode([
            'success' => true,
            'data'    => [
                'full_name'        => $respondent['full_name'],
                'sex'              => $respondent['sex'],
                'participant_type' => $respondent['participant_type'],
                'designation'      => $respondent['designation'],
                'school_office'    => $respondent['school_office'],
                'average_rating'   => (float)$respondent['average_score'],
                'result_label'     => $respondent['result_label'],
                'ratings'          => $ratings,
                'feedback'         => implode(' | ', $feedbackParts),
            ],
        ]);
        exit();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  PROGRAM RECORD PATH  — ?program_id=X  (Excel-imported respondent list)
    // ═══════════════════════════════════════════════════════════════════════════
    if ($program_id) {
        $daySheet = $_GET['day_sheet'] ?? null;

        $sql    = "SELECT id, respondent_name AS full_name, sex, participant_type,
                          designation, school_office, email, day_sheet,
                          average_score, result_label
                   FROM respondents WHERE program_id = ?";
        $params = [$program_id];
        if ($daySheet) { $sql .= " AND day_sheet = ?"; $params[] = $daySheet; }
        $sql .= " ORDER BY id";

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $respondents = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $rids = array_column($respondents, 'id');
        $scoresByRespondent   = [];
        $feedbackByRespondent = [];

        if (!empty($rids)) {
            $ph = implode(',', array_fill(0, count($rids), '?'));

            $sStmt = $pdo->prepare("
                SELECT respondent_id, question_header, score, category_name
                FROM respondent_scores WHERE respondent_id IN ($ph) ORDER BY id
            ");
            $sStmt->execute($rids);
            foreach ($sStmt->fetchAll(PDO::FETCH_ASSOC) as $s) {
                $scoresByRespondent[$s['respondent_id']][] = $s;
            }

            $fStmt = $pdo->prepare("
                SELECT respondent_id, feedback_value
                FROM respondent_feedback WHERE respondent_id IN ($ph) ORDER BY id
            ");
            $fStmt->execute($rids);
            $fbKeys = ['expectations', 'improvements', 'insights', 'further'];
            $fbPos  = [];
            foreach ($fStmt->fetchAll(PDO::FETCH_ASSOC) as $f) {
                $rid = $f['respondent_id'];
                $pos = $fbPos[$rid] ?? 0;
                $key = $fbKeys[$pos] ?? null;
                if ($key !== null) {
                    $feedbackByRespondent[$rid][$key] = $f['feedback_value'];
                    $fbPos[$rid] = $pos + 1;
                }
            }
        }

        // Build dynamic field map
        $catQuestions = [];
        if (!empty($rids)) {
            $ph    = implode(',', array_fill(0, count($rids), '?'));
            $cStmt = $pdo->prepare("
                SELECT DISTINCT category_name, question_header
                FROM respondent_scores
                WHERE respondent_id IN ($ph) AND category_name IS NOT NULL
                ORDER BY category_name, id
            ");
            $cStmt->execute($rids);
            foreach ($cStmt->fetchAll(PDO::FETCH_ASSOC) as $c) {
                $catQuestions[$c['category_name']][] = trim($c['question_header']);
            }
        }

        $catCounter  = 0;
        $fieldMap    = [];
        $questionMeta = [];
        foreach ($catQuestions as $catName => $qHeaders) {
            $catCounter++;
            $prefix = 'cat' . $catCounter;
            $qCounter = 0;
            foreach ($qHeaders as $qh) {
                $qCounter++;
                $field = $prefix . '_q' . $qCounter;
                $fieldMap[$qh] = $field;
                $questionMeta['rec_' . $catCounter . '_' . $qCounter] = [
                    'field'      => $field,
                    'label'      => $qh,
                    'type'       => 'rating',
                    'category'   => $catCounter,
                    'is_speaker' => false,
                ];
            }
        }

        $speakerFieldMap = [];
        if (!empty($rids)) {
            $ph    = implode(',', array_fill(0, count($rids), '?'));
            $spStmt = $pdo->prepare("
                SELECT DISTINCT question_header
                FROM respondent_scores
                WHERE respondent_id IN ($ph) AND category_name IS NULL
                AND question_header LIKE '%Speaker%'
                ORDER BY id
            ");
            $spStmt->execute($rids);
            $spIdx = 0;
            foreach ($spStmt->fetchAll(PDO::FETCH_COLUMN) as $spQh) {
                $spIdx++;
                $speakerFieldMap[$spQh] = 'speaker_q' . $spIdx;
            }
        }

        $responses = [];
        foreach ($respondents as $r) {
            $rid = $r['id'];
            $row = [
                'id'             => $rid,
                'participant_id' => $rid,
                'submitted_at'   => null,
                'full_name'      => $r['full_name'],
                'name'           => $r['full_name'],
                'sex'            => $r['sex'],
                'participant_type' => $r['participant_type'],
                'designation'    => $r['designation'],
                'email'          => $r['email'],
                'school_office'  => $r['school_office'],
                'average_score'  => (float)$r['average_score'],
                'day_sheet'      => $r['day_sheet'],
                '_is_record'     => true,
            ];

            foreach (($scoresByRespondent[$rid] ?? []) as $sc) {
                $qh = trim($sc['question_header']);
                if (isset($fieldMap[$qh]))         $row[$fieldMap[$qh]]         = $sc['score'] !== null ? (float)$sc['score'] : null;
                elseif (isset($speakerFieldMap[$qh])) $row[$speakerFieldMap[$qh]] = $sc['score'] !== null ? (float)$sc['score'] : null;
            }

            $fb = $feedbackByRespondent[$rid] ?? [];
            if (!empty($fb)) {
                $row['feedback_expectations'] = $fb['expectations'] ?? null;
                $row['feedback_improvements'] = $fb['improvements'] ?? null;
                $row['feedback_insights']     = $fb['insights']     ?? null;
                $row['feedback_further']      = $fb['further']      ?? null;
            }

            $row['speaker_ratings'] = [];
            $responses[] = $row;
        }

        echo json_encode([
            'success'      => true,
            'data'         => $responses,
            'count'        => count($responses),
            'question_map' => $questionMeta,
            'is_record'    => true,
        ]);
        exit();
    }


} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Error fetching responses: ' . $e->getMessage(),
    ]);
}
?>