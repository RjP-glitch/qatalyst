<?php
/**
 * API Endpoint: speaker_roster.php
 * Path: smme-api/api/speaker_roster.php
 *
 * Returns speakers (with aggregated ratings and criteria breakdown) for a
 * container workshop or a single imported program. Data is sourced entirely
 * from the Excel/import path (speaker_averages, speaker_criteria) — the old
 * resource_speakers/workshop_days "live workshop" tables are not used on
 * this install and the routes that depended on them have been removed.
 *
 * Usage:
 *   GET /api/speaker_roster.php?workshop_id=1&container=1  → all speakers in
 *                                                             container workshop 1
 *   GET /api/speaker_roster.php?program_id=5                → speakers from a
 *                                                              single imported program
 */

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once '../config/database.php';

// ─── Rating Configuration Constants ───────────────────────────────────────────
define('MAX_RATING', 4);
define('RATING_THRESHOLD_EXCELLENT', 3.5);
define('RATING_THRESHOLD_VERY_GOOD', 2.5);
define('RATING_THRESHOLD_GOOD', 1.5);

try {
    $pdo = getDB();

    $workshop_id     = isset($_GET['workshop_id'])     ? (int)$_GET['workshop_id']     : null;
    $program_id      = isset($_GET['program_id'])      ? (int)$_GET['program_id']      : null;
    $is_container    = isset($_GET['container'])       && $_GET['container'] === '1';

    // ─── Container program route ──────────────────────────────────────────────
    // ?workshop_id=X&container=1  → aggregate speaker_averages from ALL program_imports
    //                               linked to this workshop_id
    // ?program_id=X               → speakers from a single imported evaluation_programs row
    if (($workshop_id && $is_container) || $program_id) {

        // Resolve the set of program_ids to aggregate
        if ($workshop_id && $is_container) {
            $piStmt = $pdo->prepare("
                SELECT pi.program_id, pi.day_label, pi.day_number
                FROM program_imports pi
                JOIN evaluation_programs ep ON ep.id = pi.program_id
                WHERE pi.workshop_id = ?
                ORDER BY COALESCE(pi.day_number, 999) ASC, pi.imported_at ASC
            ");
            $piStmt->execute([$workshop_id]);
            $importRows = $piStmt->fetchAll(PDO::FETCH_ASSOC);
        } else {
            // Single program_id — find its day_label from program_imports if linked
            $piStmt = $pdo->prepare("
                SELECT pi.program_id, pi.day_label, pi.day_number
                FROM program_imports pi
                WHERE pi.program_id = ?
                LIMIT 1
            ");
            $piStmt->execute([$program_id]);
            $importRows = $piStmt->fetchAll(PDO::FETCH_ASSOC);
            if (empty($importRows)) {
                // Standalone (not linked to a container) — fake a single-row entry
                $importRows = [['program_id' => $program_id, 'day_label' => 'Day 1', 'day_number' => 1]];
            }
        }

        if (empty($importRows)) {
            echo json_encode(['success' => true, 'data' => [
                'speakers' => [], 'total_speakers' => 0,
                'avg_rating' => null, 'total_ratings' => 0, 'top_performer' => null,
            ]]);
            exit;
        }

        // Build day-label lookup: program_id → day_label
        $dayLabelMap = [];
        foreach ($importRows as $ir) {
            $dayLabelMap[(int)$ir['program_id']] = $ir['day_label'] ?? ('Day ' . ($ir['day_number'] ?? 1));
        }
        $programIds = array_keys($dayLabelMap);
        // Bound placeholders instead of concatenating the id list into the SQL string.
        // The ids are already cast to (int) above, so this was not exploitable as written,
        // but binding removes that assumption as a requirement for safety going forward.
        $pidPlaceholders = implode(',', array_fill(0, count($programIds), '?'));

        // Fetch container title for the header
        $containerTitle = '';
        if ($workshop_id && $is_container) {
            $wStmt = $pdo->prepare("SELECT title, division_memo FROM workshops WHERE id = ?");
            $wStmt->execute([$workshop_id]);
            $wRow = $wStmt->fetch(PDO::FETCH_ASSOC);
            $containerTitle = $wRow['title'] ?? '';
        } else {
            $epStmt = $pdo->prepare("SELECT title FROM evaluation_programs WHERE id = ?");
            $epStmt->execute([$program_id]);
            $epRow = $epStmt->fetch(PDO::FETCH_ASSOC);
            $containerTitle = $epRow['title'] ?? '';
        }

        // Fetch all speaker_averages rows across all linked programs
        $saStmt = $pdo->prepare("
            SELECT sa.id, sa.program_id, sa.slot_number, sa.speaker_name,
                   sa.overall_avg, sa.result_label, sa.day_sheet
            FROM speaker_averages sa
            WHERE sa.program_id IN ({$pidPlaceholders})
            ORDER BY sa.program_id, sa.slot_number
        ");
        $saStmt->execute($programIds);
        $saRows = $saStmt->fetchAll(PDO::FETCH_ASSOC);

        // Fetch all criteria for those speaker_averages
        $saIds = array_column($saRows, 'id');
        $criteriaBySpAvgId = [];
        if (!empty($saIds)) {
            $saIds = array_map('intval', $saIds);
            $saIdPlaceholders = implode(',', array_fill(0, count($saIds), '?'));
            $scStmt = $pdo->prepare("
                SELECT speaker_avg_id, criterion_label, average_score
                FROM speaker_criteria
                WHERE speaker_avg_id IN ({$saIdPlaceholders})
                ORDER BY id
            ");
            $scStmt->execute($saIds);
            foreach ($scStmt->fetchAll(PDO::FETCH_ASSOC) as $sc) {
                $criteriaBySpAvgId[(int)$sc['speaker_avg_id']][] = $sc;
            }
        }

        // Fetch respondent counts per program_id
        $rcStmt = $pdo->prepare("
            SELECT program_id, COUNT(*) AS cnt
            FROM respondents
            WHERE program_id IN ({$pidPlaceholders})
            GROUP BY program_id
        ");
        $rcStmt->execute($programIds);
        $respondentCount = [];
        foreach ($rcStmt->fetchAll(PDO::FETCH_ASSOC) as $rc) {
            $respondentCount[(int)$rc['program_id']] = (int)$rc['cnt'];
        }

        // Build speaker map: key = slot_number (merge across days by slot)
        $speakerMap = [];

        foreach ($saRows as $sa) {
            $pid    = (int)$sa['program_id'];
            $slot   = (int)$sa['slot_number'];
            $key    = 'slot_' . $slot;
            $dayLabel = $dayLabelMap[$pid] ?? $sa['day_sheet'] ?? 'Day 1';
            $rCount = $respondentCount[$pid] ?? 0;

            // Build criteria as dynamic [{label, score}] array — no hardcoded key mapping
            $rawCriteria = $criteriaBySpAvgId[(int)$sa['id']] ?? [];
            $criteriaArr = [];
            foreach ($rawCriteria as $sc) {
                $criteriaArr[] = [
                    'label' => (string)($sc['criterion_label'] ?? ''),
                    'score' => (float)$sc['average_score'],
                ];
            }

            $spRating = (float)$sa['overall_avg'];

            if (!isset($speakerMap[$key])) {
                $speakerMap[$key] = [
                    'id'           => $key,
                    'speaker_id'   => null,
                    // sa_entries lets the JS save edits back via records_api PATCH
                    'sa_entries'   => [['sa_id' => (int)$sa['id'], 'program_id' => $pid]],
                    'name'         => $sa['speaker_name'] ?: ('RP ' . $slot),
                    'designation'  => '',
                    'organization' => '',
                    'contact'      => '',
                    'topic'        => '',
                    'number'       => $slot,
                    'workshop_id'  => $workshop_id ?? 0,
                    'workshop_day_id' => 0,
                    'day_number'   => 1,
                    'day_title'    => $dayLabel,
                    'workshop_title' => $containerTitle,
                    'rating'       => $spRating,
                    'rating_count' => $rCount,
                    'criteria'     => $criteriaArr,
                    'appearances'  => [],
                ];
            } else {
                // Merge: weighted-average rating
                $existing = &$speakerMap[$key];
                $existing['sa_entries'][] = ['sa_id' => (int)$sa['id'], 'program_id' => $pid];
                if ($spRating > 0) {
                    $totalCount = $existing['rating_count'] + $rCount;
                    $existing['rating'] = $totalCount > 0
                        ? ($existing['rating'] * $existing['rating_count'] + $spRating * $rCount) / $totalCount
                        : $spRating;
                    $existing['rating_count'] = $totalCount;
                }
                // Merge criteria: append new entries not already present (matched by label)
                $existingLabels = array_column($existing['criteria'], 'label');
                foreach ($criteriaArr as $cr) {
                    if (!in_array($cr['label'], $existingLabels, true)) {
                        $existing['criteria'][] = $cr;
                        $existingLabels[] = $cr['label'];
                    }
                }
                unset($existing);
            }

            $speakerMap[$key]['appearances'][] = [
                'workshop_title' => $containerTitle,
                'day_number'     => (int)preg_replace('/\D/', '', $dayLabel) ?: 1,
                'day_title'      => $dayLabel,
                'topic'          => '',
                'rating'         => $spRating,
                'rating_count'   => $rCount,
                'criteria'       => $criteriaArr ?: null,
            ];
        }

        // Build final speaker list
        $speakers = [];
        foreach ($speakerMap as $sp) {
            $criteria = $sp['criteria'];
            $scores = array_filter(array_column($criteria, 'score'), fn($v) => $v > 0);
            $rating = count($scores) > 0
                ? round(array_sum($scores) / count($scores), 2)
                : (float)$sp['rating'];
            $rating = round($rating, 2);

            $speakers[] = [
                'id'              => $sp['id'],
                'speaker_id'      => null,
                'sa_entries'      => $sp['sa_entries'] ?? [],
                'name'            => $sp['name'],
                'designation'     => $sp['designation'],
                'organization'    => $sp['organization'],
                'contact'         => $sp['contact'],
                'topic'           => $sp['topic'],
                'number'          => $sp['number'],
                'workshop_id'     => $sp['workshop_id'],
                'workshop_day_id' => $sp['workshop_day_id'],
                'day_number'      => $sp['day_number'],
                'day_title'       => $sp['day_title'],
                'workshop_title'  => $sp['workshop_title'],
                'rating'          => $rating,
                'rating_label'    => getRatingLabel($rating),
                'rating_count'    => $sp['rating_count'],
                'criteria'        => $criteria,
                'appearances'     => $sp['appearances'],
            ];
        }

        usort($speakers, fn($a, $b) => $b['rating'] <=> $a['rating']);

        $rated      = array_filter($speakers, fn($s) => $s['rating'] > 0);
        $avgOverall = count($rated) > 0
            ? round(array_sum(array_column(array_values($rated), 'rating')) / count($rated), 2)
            : null;
        $top          = count($speakers) > 0 ? $speakers[0] : null;
        $totalRatings = array_sum(array_column($speakers, 'rating_count'));

        echo json_encode(['success' => true, 'data' => [
            'speakers'       => $speakers,
            'total_speakers' => count($speakers),
            'avg_rating'     => $avgOverall,
            'total_ratings'  => $totalRatings,
            'top_performer'  => $top ? ['name' => $top['name'], 'rating' => $top['rating']] : null,
        ]]);
        exit;
    }

    // No recognized query mode. This endpoint only supports the
    // speaker_averages-backed routes above (?workshop_id=X&container=1 or
    // ?program_id=X). The old resource_speakers/workshop_days-based routes
    // (?speaker_id=, and the bare "all speakers" list) were removed — that
    // table isn't used on this install and the frontend never called them.
    echo json_encode([
        'success' => false,
        'message' => 'Missing workshop_id (with container=1) or program_id parameter.',
    ]);
    exit;

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Server error: ' . $e->getMessage(),
    ]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRatingLabel(float $rating): string {
    if ($rating <= 0)                          return 'No Data';
    if ($rating >= RATING_THRESHOLD_EXCELLENT) return 'Excellent';
    if ($rating >= RATING_THRESHOLD_VERY_GOOD) return 'Very Good';
    if ($rating >= RATING_THRESHOLD_GOOD)      return 'Good';
    return 'Poor';
}

?>

