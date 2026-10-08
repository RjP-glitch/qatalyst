<?php
/**
 * config/report_averages.php
 *
 * Rating-scale lookup + the two derived-table builders (category_averages,
 * column_averages). Extracted out of save.php so backfill_category_ids.php
 * can recompute these derived tables for programs that were imported
 * before category_id existed, without duplicating this logic.
 *
 * category_averages and column_averages are pure derived data: every call
 * to insertCategoryAverages()/insertColumnAverages() deletes that program's
 * existing rows and rebuilds them fresh from respondent_scores. So once
 * respondent_scores.category_id is backfilled, re-running these two
 * functions for a program is all that's needed to bring its derived tables
 * up to date too — no separate backfill logic needed for those tables.
 */

require_once __DIR__ . '/category_matching.php';

// ── Rating helpers ────────────────────────────────────────────────────────────
function getRatingFromScale(float $avg, string $type = 'category'): array {
    try {
        $pdo = getDB();

        $stmt = $pdo->prepare("
            SELECT min_score, max_score, level_of_agreement, descriptive_equivalent
            FROM rating_scales
            WHERE scale_type = ? AND is_active = 1
            ORDER BY display_order ASC
        ");
        $stmt->execute([$type]);

        $scales = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // If DB has data, use it
        if (!empty($scales)) {
            foreach ($scales as $scale) {
                if ($avg >= $scale['min_score'] && $avg <= $scale['max_score']) {
                    return [
                        'level' => $scale['level_of_agreement'],
                        'description' => $scale['descriptive_equivalent']
                    ];
                }
            }
        }

    } catch (Exception $e) {
        // silently fall back
    }

    // FALLBACK (same as your JS)
    $fallback = [
        'category' => [
            ['min' => 3.26, 'max' => 4.00, 'level' => 'Strongly Agree (SA)',    'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'max' => 3.25, 'level' => 'Agree (A)',              'desc' => 'Satisfactory'],
            ['min' => 1.76, 'max' => 2.50, 'level' => 'Disagree (D)',           'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'max' => 1.75, 'level' => 'Strongly Disagree (SD)', 'desc' => 'Very Unsatisfactory'],
        ],
        'speaker' => [
            ['min' => 3.26, 'max' => 4.00, 'level' => 'Very Satisfied',         'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'max' => 3.25, 'level' => 'Somewhat Satisfied',     'desc' => 'Satisfactory'],
            ['min' => 1.76, 'max' => 2.50, 'level' => 'Somewhat Dissatisfied',  'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'max' => 1.75, 'level' => 'Dissatisfied',           'desc' => 'Very Unsatisfactory'],
        ],
        'overall' => [
            ['min' => 3.26, 'max' => 4.00, 'level' => 'Excellent', 'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'max' => 3.25, 'level' => 'Good',      'desc' => 'Satisfactory'],
            ['min' => 1.76, 'max' => 2.50, 'level' => 'Average',   'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'max' => 1.75, 'level' => 'Fair',      'desc' => 'Very Unsatisfactory'],
        ],
    ];

    $typeScales = $fallback[$type] ?? $fallback['category'];

    foreach ($typeScales as $scale) {
        if ($avg >= $scale['min'] && $avg <= $scale['max']) {
            return [
                'level' => $scale['level'],
                'description' => $scale['desc']
            ];
        }
    }

    return ['level' => 'N/A', 'description' => 'Very Unsatisfactory'];
}

// ── Shortcut helper ───────────────────────────────────────────────────────────
function getResultLabel(float $avg, string $type = 'category'): string {
    return getRatingFromScale($avg, $type)['description'];
}

// ── Compute and insert category_averages ──────────────────────────────────────
// CHANGED: now carries category_id through (resolved from respondent_scores,
// which already has it populated — either at import time going forward, or
// via the backfill script for historical rows). MAX() picks it up per group;
// since category_id is derived from category_name via the same resolver,
// every row in a GROUP BY ... category_name group shares the same
// category_id (or all NULL), so MAX() is just "the value", not an aggregate
// choice.
function insertCategoryAverages(PDO $pdo, int $programId): void {
    // BUG 20 FIX: delete existing rows first so retries don't produce duplicate averages
    $pdo->prepare("DELETE FROM category_averages WHERE program_id = ?")->execute([$programId]);
    $rows = $pdo->prepare("
        SELECT r.day_sheet, rs.category_name, MAX(rs.category_id) AS category_id,
               AVG(rs.score) AS avg_score, COUNT(rs.score) AS n
        FROM respondent_scores rs
        JOIN respondents r ON r.id = rs.respondent_id
        WHERE r.program_id = :pid
          AND rs.category_name IS NOT NULL AND rs.score IS NOT NULL
        GROUP BY r.day_sheet, rs.category_name
        ORDER BY r.day_sheet, rs.category_name
    ");
    $rows->execute([':pid' => $programId]);
    $perDay = $rows->fetchAll(PDO::FETCH_ASSOC);

    $rowsOv = $pdo->prepare("
        SELECT rs.category_name, MAX(rs.category_id) AS category_id,
               AVG(rs.score) AS avg_score, COUNT(rs.score) AS n
        FROM respondent_scores rs
        JOIN respondents r ON r.id = rs.respondent_id
        WHERE r.program_id = :pid
          AND rs.category_name IS NOT NULL AND rs.score IS NOT NULL
        GROUP BY rs.category_name
        ORDER BY rs.category_name
    ");
    $rowsOv->execute([':pid' => $programId]);
    $overall = $rowsOv->fetchAll(PDO::FETCH_ASSOC);

    $ins = $pdo->prepare("
        INSERT INTO category_averages
            (program_id, day_sheet, category_name, category_id, average_score, result_label, is_overall)
        VALUES (:pid, :day, :cat, :cat_id, :avg, :res, :is_overall)
    ");

    foreach ($perDay as $row) {
        $avg = round((float)$row['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => $row['day_sheet'],
            ':cat' => $row['category_name'], ':cat_id' => $row['category_id'] !== null ? (int)$row['category_id'] : null,
            ':avg' => $avg,
            ':res' => getResultLabel($avg, 'category'), ':is_overall' => 0]);
    }
    foreach ($overall as $row) {
        $avg = round((float)$row['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => null,
            ':cat' => $row['category_name'], ':cat_id' => $row['category_id'] !== null ? (int)$row['category_id'] : null,
            ':avg' => $avg,
            ':res' => getResultLabel($avg, 'category'), ':is_overall' => 1]);
    }
}

// ── Compute and insert column_averages ────────────────────────────────────────
function insertColumnAverages(PDO $pdo, int $programId): void {
    // BUG 20 FIX: delete existing rows first so retries don't produce duplicate averages
    $pdo->prepare("DELETE FROM column_averages WHERE program_id = ?")->execute([$programId]);
    $rows = $pdo->prepare("
        SELECT r.day_sheet, rs.category_name, MAX(rs.category_id) AS category_id, rs.question_header,
               AVG(rs.score) AS avg_score, COUNT(rs.score) AS n
        FROM respondent_scores rs
        JOIN respondents r ON r.id = rs.respondent_id
        WHERE r.program_id = :pid AND rs.score IS NOT NULL
        GROUP BY r.day_sheet, rs.category_name, rs.question_header
        ORDER BY r.day_sheet, rs.category_name, rs.question_header
    ");
    $rows->execute([':pid' => $programId]);
    $cols = $rows->fetchAll(PDO::FETCH_ASSOC);

    $ins = $pdo->prepare("
        INSERT INTO column_averages
            (program_id, day_sheet, category_name, category_id, question_header, average_score, n_responses)
        VALUES (:pid, :day, :cat, :cat_id, :qh, :avg, :n)
    ");
    foreach ($cols as $col) {
        $avg = round((float)$col['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => $col['day_sheet'],
            ':cat' => $col['category_name'],
            ':cat_id' => $col['category_id'] !== null ? (int)$col['category_id'] : null,
            ':qh'  => trim($col['question_header'] ?? ''),
            ':avg' => $avg, ':n' => (int)$col['n']]);
    }
}
