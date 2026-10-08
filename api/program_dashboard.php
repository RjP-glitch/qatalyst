<?php
/**
 * program_dashboard.php  v4
 *
 * FIX 1 – Sex/gender counts now read directly from the `respondents` table
 *          for this program_id, not from `workshop_participants` (which had
 *          nothing to do with imported Excel records).
 *
 * FIX 2 – Category name matching is now tolerant of:
 *            "Program Management & Operations"  ←→  "Program Management and Operations"
 *            "Venue"  ←→  "Venue (FOR IN-PERSON ATTENDEES ONLY)"
 *            "Meal"   ←→  "Meal (FOR IN-PERSON ATTENDEES)"
 *          by normalising & → "and" and stripping parenthetical suffixes
 *          before comparing.
 *
 * FIX 3 – The `id` returned for each category in all_categories[] now uses
 *          the real evaluation_question_categories.id so that the QAME
 *          category mappings resolve correctly and indicator rows show data
 *          (instead of "NO DATA" for categories whose names differ slightly).
 */
error_reporting(E_ALL);
ini_set('display_errors', 0);

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for program dashboard data
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Normalise a category name for fuzzy comparison:
 *  - lowercase
 *  - & → "and"
 *  - strip parenthetical suffixes like "(FOR IN-PERSON ATTENDEES ONLY)"
 *  - collapse whitespace
 */
function normCat(string $s): string {
    $s = strtolower($s);
    $s = str_replace('&', ' and ', $s);
    $s = preg_replace('/\(.*?\)/', '', $s);   // strip (…) suffixes
    $s = preg_replace('/[^a-z0-9 ]/', '', $s);
    return trim(preg_replace('/\s+/', ' ', $s));
}

function wordOverlap(string $a, string $b): float {
    $wa = array_unique(explode(' ', $a));
    $wb = array_unique(explode(' ', $b));
    $inter = count(array_intersect($wa, $wb));
    $union = count(array_unique(array_merge($wa, $wb)));
    return $union > 0 ? $inter / $union : 0.0;
}

/**
 * Find the best matching evaluation_question_categories.id for $needle.
 * $haystack: [ normalisedName => id ]
 */
function bestCatMatch(string $needle, array $haystack): ?int {
    $n = normCat($needle);
    // 1. Exact
    if (isset($haystack[$n])) return $haystack[$n];
    // 2. One contains the other
    foreach ($haystack as $h => $id) {
        if (strpos($n, $h) !== false || strpos($h, $n) !== false) return $id;
    }
    // 3. Word-overlap ≥ 0.35
    $best = null; $bestScore = 0;
    foreach ($haystack as $h => $id) {
        $score = wordOverlap($n, $h);
        if ($score > $bestScore) { $bestScore = $score; $best = $id; }
    }
    return ($bestScore >= 0.35) ? $best : null;
}

/** Fuzzy-match a question text against evaluation_questions. */
function normQ(string $s): string {
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9 ]/', '', $s);
    return trim(preg_replace('/\s+/', ' ', $s));
}
function bestQMatch(string $needle, array $haystack): ?int {
    $n = normQ($needle);
    if (isset($haystack[$n])) return $haystack[$n];
    foreach ($haystack as $h => $id) {
        if (strpos($n, $h) !== false || strpos($h, $n) !== false) return $id;
    }
    $best = null; $bestScore = 0;
    foreach ($haystack as $h => $id) {
        $score = wordOverlap($n, $h);
        if ($score > $bestScore) { $bestScore = $score; $best = $id; }
    }
    return ($bestScore >= 0.4) ? $best : null;
}

function getRatingLabel(float $score, string $type = 'category'): string {
    if ($score <= 0) return 'NO DATA';
    try {
        $pdo = getDB();
        $stmt = $pdo->prepare("
            SELECT descriptive_equivalent FROM rating_scales
            WHERE scale_type = ? AND is_active = 1
              AND min_score <= ? AND max_score >= ?
            ORDER BY display_order ASC LIMIT 1
        ");
        $stmt->execute([$type, $score, $score]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) return $row['descriptive_equivalent'];
    } catch (Exception $e) { /* fall through to fallback */ }
    // Fallback if DB unavailable
    if ($score >= 3.26) return 'Very Satisfactory';
    if ($score >= 2.51) return 'Satisfactory';
    if ($score >= 1.76) return 'Unsatisfactory';
    return 'Very Unsatisfactory';
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════ */
try {
    $pdo = getDB();
    $programId  = isset($_GET['program_id'])  ? (int)$_GET['program_id']  : 0;
    $workshopId = isset($_GET['workshop_id']) ? (int)$_GET['workshop_id'] : 0;

    // ?workshop_id=X  (container program) → resolve to first linked import's program_id
    // and force all-days view so the dashboard opens showing aggregated data.
    // Also capture ALL sibling program_ids for cross-day aggregation.
    $allLinkedProgramIds = []; // populated below when workshopId is set
    if (!$programId && $workshopId) {
        $piStmt = $pdo->prepare("
            SELECT pi.program_id
            FROM program_imports pi
            JOIN evaluation_programs ep ON ep.id = pi.program_id
            WHERE pi.workshop_id = ?
            ORDER BY COALESCE(pi.day_number, 999) ASC, pi.imported_at ASC
        ");
        $piStmt->execute([$workshopId]);
        $allImportRows = $piStmt->fetchAll(PDO::FETCH_ASSOC);
        if ($allImportRows) {
            $programId = (int)$allImportRows[0]['program_id'];
            $allLinkedProgramIds = array_map(fn($r) => (int)$r['program_id'], $allImportRows);
            // Force all-days view so navigation starts at the aggregated view
            if (!isset($_GET['day'])) {
                $_GET['day'] = 'all';
            }
        }
    }

    if (!$programId) throw new Exception('program_id is required.');

    // Optional day filter: 'all' or specific day_sheet name (e.g. 'Day 1')
    // $dayParamRaw  — the raw value used for DB queries (matches stored day_sheet values)
    // $dayParam     — kept as alias of $dayParamRaw for backward-compat in DB queries
    // $dayTitle     — positional "Day N" label used only for display (nav buttons, current_day.title)
    $dayParamRaw   = isset($_GET['day']) ? trim($_GET['day']) : 'all';
    $dayParam      = $dayParamRaw;   // all DB queries continue using $dayParam (= raw stored value)
    $isAllDaysView = ($dayParam === 'all' || $dayParam === '');

    /* ── 1. Core program row ─────────────────────────────────────── */
    $stmt = $pdo->prepare("SELECT * FROM evaluation_programs WHERE id = ?");
    $stmt->execute([$programId]);
    $program = $stmt->fetch(PDO::FETCH_ASSOC);

    // Fallback: the requested ID may no longer exist because a re-import
    // deleted the old row and inserted a new one with a new auto-increment ID.
    // Find the most recently saved Excel program as the best approximation,
    // then update $programId so all subsequent queries use the correct row.
    if (!$program) {
        $stmt = $pdo->prepare("
            SELECT * FROM evaluation_programs
            WHERE source_type = 'excel'
            ORDER BY id DESC
            LIMIT 1
        ");
        $stmt->execute();
        $program = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$program) throw new Exception('Program not found.');

        // Correct $programId so all subsequent queries reference the real row
        $programId = (int)$program['id'];
    }

    /* ── 1b. Parent container details ───────────────────────────── */
    // When this import is linked to a container program, use the container's
    // title, division_memo, venue, proponents etc. for the dashboard header —
    // not the excel import's own title which is just the filename-derived name.
    $container = null;
    $linkedWorkshopId = isset($program['workshop_id']) ? (int)$program['workshop_id'] : 0;
    if ($linkedWorkshopId) {
        $cStmt = $pdo->prepare("SELECT * FROM workshops WHERE id = ?");
        $cStmt->execute([$linkedWorkshopId]);
        $container = $cStmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    // If allLinkedProgramIds wasn't set from ?workshop_id param, build it now
    // from this program's own linked_workshop_id so all-days view is always correct.
    if (empty($allLinkedProgramIds) && $linkedWorkshopId) {
        $piStmt2 = $pdo->prepare("
            SELECT pi.program_id
            FROM program_imports pi
            JOIN evaluation_programs ep ON ep.id = pi.program_id
            WHERE pi.workshop_id = ?
            ORDER BY COALESCE(pi.day_number, 999) ASC, pi.imported_at ASC
        ");
        $piStmt2->execute([$linkedWorkshopId]);
        $allLinkedProgramIds = array_map(
            fn($r) => (int)$r['program_id'],
            $piStmt2->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    // $queryProgramIds: the set of program_ids to aggregate across in all-days view.
    // Falls back to just the current programId for standalone imports.
    $queryProgramIds = (!empty($allLinkedProgramIds)) ? $allLinkedProgramIds : [$programId];
    $qidIn = implode(',', $queryProgramIds); // safe: all cast to int above
    $stmt = $pdo->query("
        SELECT DISTINCT day_sheet
        FROM category_averages
        WHERE program_id IN ({$qidIn}) AND is_overall = 0 AND day_sheet IS NOT NULL
        ORDER BY day_sheet
    ");
    $daySheets = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // Sort day_sheets numerically (so "Day 10" comes after "Day 9", not before "Day 2")
    usort($daySheets, function($a, $b) {
        $an = (int)preg_replace('/\D/', '', $a) ?: 0;
        $bn = (int)preg_replace('/\D/', '', $b) ?: 0;
        return $an - $bn;
    });

    // Look up the correct day_label from program_imports using linked_workshop_id.
    // This ensures titles like "Day 2" come from the import record, not positional counting.
    // Map: day_sheet_value → day_label (e.g. "Day 2" → "Day 2")
    $dayLabelMap = [];
    if ($linkedWorkshopId) {
        $piStmt = $pdo->prepare("
            SELECT pi.day_label, ep.id AS prog_id
            FROM program_imports pi
            JOIN evaluation_programs ep ON ep.id = pi.program_id
            WHERE pi.workshop_id = ?
        ");
        $piStmt->execute([$linkedWorkshopId]);
        foreach ($piStmt->fetchAll(PDO::FETCH_ASSOC) as $piRow) {
            // Map program_id → day_label; we'll also map by current programId
            if ((int)$piRow['prog_id'] === $programId) {
                // For the current program, map its day_sheets to its day_label
                foreach ($daySheets as $ds) {
                    $dayLabelMap[$ds] = $piRow['day_label'];
                }
            }
        }
        // Also build a full map of all sibling day_labels for reference
        $piStmt->execute([$linkedWorkshopId]);
        $allImports = $piStmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /* ── 3. Categories from saved import (overall or per-day) ────── */
    if ($isAllDaysView) {
        // Aggregate category averages across ALL linked program_ids
        $stmt = $pdo->query("
            SELECT category_name,
                   AVG(average_score) AS average_score,
                   NULL               AS result_label
            FROM category_averages
            WHERE program_id IN ({$qidIn}) AND is_overall = 1
            GROUP BY category_name
            ORDER BY MIN(id)
        ");
    } else {
        $stmt = $pdo->prepare("
            SELECT category_name, average_score, result_label
            FROM category_averages
            WHERE program_id = ? AND is_overall = 0 AND day_sheet = ?
            ORDER BY id
        ");
        $stmt->execute([$programId, $dayParam]);
    }
    $overallCats = $stmt->fetchAll(PDO::FETCH_ASSOC);
    // Recompute result_label for aggregated rows
    if ($isAllDaysView) {
        foreach ($overallCats as &$oc) {
            $oc['result_label'] = getRatingLabel((float)$oc['average_score']);
        }
        unset($oc);
    }

    /* ── 4. Respondent count (filtered by day if needed) ──────────── */
    // Count all respondent rows directly — no name-based deduplication.
    // Name dedup caused under-counting when two people share the same name,
    // and is unreliable for MS Forms exports where all emails are "anonymous".
    if ($isAllDaysView) {
        $stmt = $pdo->query("SELECT COUNT(*) FROM respondents WHERE program_id IN ({$qidIn})");
        $totalRespondents = (int)$stmt->fetchColumn();
    } else {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM respondents WHERE program_id = ? AND day_sheet = ?");
        $stmt->execute([$programId, $dayParam]);
        $totalRespondents = (int)$stmt->fetchColumn();
    }

    /* ── 5. FIX 1: Sex breakdown from respondents table ─────────────
     *
     *  The old code tried to match a workshop in `workshops` and then
     *  read sex from `workshop_participants`. That worked for live
     *  workshops but NOT for Excel-imported records, which only exist
     *  in `respondents`.
     *
     *  Fix: read sex directly from `respondents` for this program_id.
     * ─────────────────────────────────────────────────────────────── */
    if ($isAllDaysView) {
        // Count directly by sex across ALL linked program_ids
        $stmt = $pdo->query("
            SELECT
                COALESCE(sex, 'Unknown') AS sex_val,
                COUNT(*)                 AS cnt
            FROM respondents
            WHERE program_id IN ({$qidIn})
            GROUP BY sex_val
        ");
    } else {
        $stmt = $pdo->prepare("
            SELECT
                COALESCE(sex, 'Unknown')            AS sex_val,
                COUNT(*)                            AS cnt
            FROM respondents
            WHERE program_id = ? AND day_sheet = ?
            GROUP BY sex_val
        ");
        $stmt->execute([$programId, $dayParam]);
    }
    $sexRows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $maleCount   = 0;
    $femaleCount  = 0;
    $lgbtqCount   = 0;
    $unknownCount = 0;
    foreach ($sexRows as $row) {
        $cnt = (int)$row['cnt'];
        $sexVal = strtolower(trim((string)($row['sex_val'] ?? '')));
        if ($sexVal === 'male') {
            $maleCount += $cnt;
            continue;
        }
        if ($sexVal === 'female') {
            $femaleCount += $cnt;
            continue;
        }

        // Treat explicit non-binary / prefer-not-to-say as the third bucket.
        // Treat NULL/blank/unknown as "missing sex" (also part of the third bucket).
        $lgbtqCount += $cnt;
        if ($sexVal === '' || $sexVal === 'unknown' || $sexVal === 'null' || $sexVal === 'n/a') {
            $unknownCount += $cnt;
        }
    }

    // True when sex data was not collected at all (all respondent sex values are NULL).
    // In that case we hide the sex pie chart on the dashboard.
    $sexAllNull = ($totalRespondents > 0)
        && ($unknownCount === (int)$totalRespondents)
        && ($maleCount === 0)
        && ($femaleCount === 0);

    $totalParticipants = (int)($program['total_participants'] ?: $totalRespondents);

    /* ── 6. FIX 2 & 3: Build lookup tables with normalised names ────
     *
     *  evaluation_question_categories uses full display names:
     *    "Program Management and Operations"
     *    "Venue (FOR IN-PERSON ATTENDEES ONLY)"
     *    "Meal (FOR IN-PERSON ATTENDEES)"
     *
     *  category_averages (imported) stores short names:
     *    "Program Management & Operations"
     *    "Venue"
     *    "Meal"
     *
     *  normCat() strips the parenthetical suffix and converts & → and,
     *  so both sides normalise to the same string for matching.
     * ─────────────────────────────────────────────────────────────── */
    $eqcRows = $pdo->query(
        "SELECT id, name FROM evaluation_question_categories WHERE is_active = 1"
    )->fetchAll(PDO::FETCH_ASSOC);

    $eqcByNorm   = [];   // normCat(name) → id
    $eqcIdToName = [];   // id → display name
    foreach ($eqcRows as $r) {
        $eqcByNorm[normCat($r['name'])] = (int)$r['id'];
        $eqcIdToName[(int)$r['id']]     = $r['name'];
    }

    // evaluation_questions lookup for resolving real question IDs
    $eqRows = $pdo->query("
        SELECT id, question_text
        FROM evaluation_questions
        WHERE question_type = 'rating' AND is_for_speaker = 0 AND is_active = 1
    ")->fetchAll(PDO::FETCH_ASSOC);

    $eqByNorm = [];   // normQ(question_text) → id
    foreach ($eqRows as $r) {
        $eqByNorm[normQ($r['question_text'])] = (int)$r['id'];
    }

    /* ── 7. Build all_categories ─────────────────────────────────── */
    $allCategories = [];
    foreach ($overallCats as $cat) {
        // Resolve evaluation_question_categories.id via fuzzy match
        $realCatId = bestCatMatch($cat['category_name'], $eqcByNorm);

        // Use real display name when found; fall back to the imported name
        $displayName = $realCatId
            ? ($eqcIdToName[$realCatId] ?? $cat['category_name'])
            : $cat['category_name'];

        // Use a stable synthetic ID when no real match found
        if (!$realCatId) $realCatId = abs(crc32($cat['category_name']));

        // Per-question averages from column_averages
        if ($isAllDaysView) {
            // Overall: aggregate across ALL linked program_ids and all days
            $catName = $cat['category_name'];
            $catNameQuoted = $pdo->quote($catName);
            $qStmt = $pdo->query("
                SELECT
                    question_header AS text,
                    AVG(average_score) AS avg_rating,
                    SUM(n_responses)   AS answer_count
                FROM column_averages
                WHERE program_id IN ({$qidIn}) AND category_name = {$catNameQuoted}
                GROUP BY question_header
                ORDER BY MIN(id)
            ");
        } else {
            $qStmt = $pdo->prepare("
                SELECT
                    question_header AS text,
                    average_score   AS avg_rating,
                    n_responses     AS answer_count
                FROM column_averages
                WHERE program_id = ? AND category_name = ? AND day_sheet = ?
                ORDER BY id
            ");
            $qStmt->execute([$programId, $cat['category_name'], $dayParam]);
        }
        $questions = $qStmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($questions as &$q) {
            $q['avg_rating']   = (float)$q['avg_rating'];
            $q['answer_count'] = (int)$q['answer_count'];
            $q['label']        = getRatingLabel($q['avg_rating']);
            $qid               = bestQMatch($q['text'], $eqByNorm);
            $q['id']           = $qid ?? abs(crc32($q['text']));
        }
        unset($q);

        $allCategories[] = [
            'id'         => $realCatId,
            'name'       => $displayName,
            'avg_rating' => (float)$cat['average_score'],
            'result'     => $cat['result_label'],
            'questions'  => $questions,
        ];
    }

    /* ── 8. Resource speakers ────────────────────────────────────── */
    if ($isAllDaysView) {
        $spStmt = $pdo->query("
            SELECT id, slot_number, speaker_name, overall_avg, result_label, day_sheet
            FROM speaker_averages
            WHERE program_id IN ({$qidIn})
            ORDER BY day_sheet, slot_number
        ");
    } else {
        $spStmt = $pdo->prepare("
            SELECT id, slot_number, speaker_name, overall_avg, result_label, day_sheet
            FROM speaker_averages
            WHERE program_id = ? AND day_sheet = ?
            ORDER BY slot_number
        ");
        $spStmt->execute([$programId, $dayParam]);
    }
    $spRows = $spStmt->fetchAll(PDO::FETCH_ASSOC);

    // Prepare criteria lookup statement
    $criteriaStmt = $pdo->prepare("
        SELECT criterion_label, average_score
        FROM speaker_criteria
        WHERE speaker_avg_id = ?
        ORDER BY id
    ");

    $resourceSpeakers = [];
    $speakersByDay    = [];
    foreach ($spRows as $sp) {
        // Fetch criteria for this speaker
        $criteriaStmt->execute([$sp['id']]);
        $criteriaRows = $criteriaStmt->fetchAll(PDO::FETCH_ASSOC);
        $criteria = [];
        foreach ($criteriaRows as $cr) {
            $criteria[] = [
                'label' => $cr['criterion_label'],
                'score' => (float)$cr['average_score']
            ];
        }

        $entry = [
            'number' => (int)$sp['slot_number'],
            'name'   => $sp['speaker_name'] ?: null,
            'rating' => (float)$sp['overall_avg'],
            'result' => $sp['result_label'],
            'is_top' => false,
            'criteria' => $criteria
        ];
        $resourceSpeakers[] = $entry;
        $dayNum = preg_replace('/\D/', '', $sp['day_sheet']) ?: '1';
        $speakersByDay[$dayNum][] = $entry;
    }
    if ($resourceSpeakers) {
        $maxRating = max(array_column($resourceSpeakers, 'rating'));
        foreach ($resourceSpeakers as &$sp) {
            $sp['is_top'] = ((float)$sp['rating'] === (float)$maxRating && $maxRating > 0);
        }
        unset($sp);
    }

    /* ── 9. workshop_days ───────────────────────────────────────── */
    // Title comes from program_imports.day_label when available (correct "Day N" label),
    // falling back to positional counting only for standalone imports with no link.
    $workshopDays = [];
    foreach ($daySheets as $i => $day) {
        $title = $dayLabelMap[$day] ?? ('Day ' . ($i + 1));
        $workshopDays[] = [
            'id'         => $i + 1,
            'day_number' => $i + 1,
            'title'      => $title,   // correct label e.g. "Day 2"
            'day_sheet'  => $day,     // raw DB value passed back as ?day=
        ];
    }
    if (empty($workshopDays)) {
        $workshopDays[] = ['id' => 1, 'day_number' => 1, 'title' => 'Day 1', 'day_sheet' => 'Day 1'];
    }

    // current_day title: use day_label from program_imports if available
    $currentDayTitle = 'Day 1';
    if (!$isAllDaysView) {
        $currentDayTitle = $dayLabelMap[$dayParam] ?? ('Day ' . (array_search($dayParam, $daySheets) + 1 ?: 1));
    }

    /* ── 10. Response ────────────────────────────────────────────── */
    echo json_encode(['success' => true, 'data' => [
        'is_program_record'    => true,
        'program_id'           => $programId,
        'source_type'          => $program['source_type'] ?? 'excel',
        'linked_workshop_id'   => $program['workshop_id'] ?? null,
        'response_count'       => $totalRespondents,
        'last_submission_time' => $program['created_at'],
        'workshop' => [
            'id'                    => $container ? (int)$container['id'] : 0,
            'title'                 => $container ? $container['title'] : $program['title'],
            'division_memo'         => $container ? ($container['division_memo'] ?? '') : ($program['inclusive_dates'] ?? ''),
            'venue'                 => $container ? ($container['venue'] ?? '') : ($program['training_venue'] ?? ''),
            'nature_of_event'       => $container ? ($container['nature_of_event'] ?? '') : ($program['nature_of_event'] ?? ''),
            // BUG FIX: $container['total_participants'] is the PER-DAY expected headcount
            // (e.g. 45 people expected each day). It was being used as-is even in the
            // combined "All Days" view, where 'participants.total' below counts EVERY
            // respondent across ALL days (e.g. 84) — making expected look smaller than
            // the actual total. For the combined view, multiply by the number of
            // workshop days so both numbers are on the same basis.
            'expected_participants' => $container
                ? (int)($container['total_participants'] ?? $totalParticipants) * (($isAllDaysView && count($workshopDays) > 1) ? count($workshopDays) : 1)
                : $totalParticipants,
            'proponents'            => $container ? ($container['proponents'] ?? '') : ($program['proponents'] ?? ''),
        ],
        'current_day'       => $isAllDaysView
            ? ['id' => 0, 'day_number' => 0, 'title' => 'All Days']
            : (function() use ($daySheets, $dayParam, $currentDayTitle) {
                $idx = array_search($dayParam, $daySheets);
                $idx = ($idx !== false) ? (int)$idx : 0;
                return [
                    'id'         => $idx + 1,
                    'day_number' => $idx + 1,
                    'title'      => $currentDayTitle,  // correct label from program_imports
                    'day_sheet'  => $dayParam,
                ];
            })(),
        'workshop_days'     => $workshopDays,
        // FIX 1: sex counts now come from respondents table
        'participants'      => [
            'total'        => $totalRespondents,
            'male_count'   => $maleCount,
            'female_count' => $femaleCount,
            'lgbtq_count'  => $lgbtqCount,
            'sex_all_null' => $sexAllNull ? 1 : 0,
        ],
        // FIX 2 & 3: all_categories now use real EQC IDs + normalised display names
        'all_categories'    => $allCategories,
        'resource_speakers' => $resourceSpeakers,
        'speakers_by_day'   => $speakersByDay,
        'is_all_days'       => $isAllDaysView,
        // METHOD CHANGE: overall_average is now a straight (unweighted) mean of the
        // category averages in $overallCats — each category counts equally, matching
        // the manual/paper QATAME computation. This used to be AVG(rs.score) over every
        // individual question score, which gave categories with more questions more
        // influence and drifted from the manual figure (e.g. 3.92 vs a manually-computed
        // 3.89 on the same data). overall_result's label is derived from this SAME value,
        // so the number and its label can never disagree.
        'overall_average'   => ($overallAverageValue = (function() use ($overallCats) {
                if (empty($overallCats)) return 0;
                $catAvgs = array_map('floatval', array_column($overallCats, 'average_score'));
                return round(array_sum($catAvgs) / count($catAvgs), 2);
            })()),
        'overall_result'    => empty($overallCats) ? 'NO DATA' : getRatingLabel((float)$overallAverageValue),
        'overall_categories'=> $overallCats,
    ]]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'DB error: ' . $e->getMessage()]);
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>