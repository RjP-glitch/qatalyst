<?php
/**
 * backfill_category_ids.php — ONE-TIME script.
 *
 * Run this once, after applying migration_add_category_id.sql, to populate
 * category_id on existing respondent_scores rows and recompute
 * category_averages / column_averages so historical programs (ones nobody
 * is going to re-import) pick up category_id too.
 *
 * HOW TO RUN:
 *   Drop this in the same folder as save.php (e.g. smme-api/api/) and hit
 *   it once via browser or CLI (php backfill_category_ids.php), then
 *   delete it or move it out of the web root. It is NOT meant to stay
 *   live — it has no auth check and would happily re-run destructively
 *   (re-deleting/rebuilding category_averages/column_averages) if left
 *   reachable.
 *
 * WHAT IT DOES:
 *   1. For every distinct category_name currently in respondent_scores
 *      with category_id still NULL, tries to resolve it against
 *      evaluation_question_categories using the same normalized matching
 *      save.php now uses going forward (config/category_matching.php).
 *   2. Reports any category_name values that couldn't be matched, so you
 *      can review them (typos, truly new categories, "Resource Speaker"
 *      text variants, etc.) and either add them to
 *      evaluation_question_categories or fix the text by hand.
 *   3. Recomputes category_averages/column_averages for every program that
 *      has respondent_scores, using the same insertCategoryAverages() /
 *      insertColumnAverages() functions save.php calls on a normal save —
 *      so those two derived tables end up byte-for-byte what a fresh
 *      save.php run would have produced.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/category_matching.php';
require_once __DIR__ . '/../config/report_averages.php';

header('Content-Type: text/plain');

$pdo = getDB();

echo "=== Step 1: Backfilling respondent_scores.category_id ===\n";

$distinctStmt = $pdo->query("
    SELECT DISTINCT category_name
    FROM respondent_scores
    WHERE category_name IS NOT NULL AND category_id IS NULL
");
$distinctNames = $distinctStmt->fetchAll(PDO::FETCH_COLUMN);

$matchedCount = 0;
$unmatched = [];

$updateStmt = $pdo->prepare("
    UPDATE respondent_scores
    SET category_id = :cat_id
    WHERE category_name = :cat_name AND category_id IS NULL
");

foreach ($distinctNames as $name) {
    $catId = resolveCategoryId($pdo, $name);
    if ($catId === null) {
        $unmatched[] = $name;
        continue;
    }
    $updateStmt->execute([':cat_id' => $catId, ':cat_name' => $name]);
    $rows = $updateStmt->rowCount();
    $matchedCount++;
    echo "  '{$name}' -> category_id {$catId}  ({$rows} rows)\n";
}

echo "\nMatched {$matchedCount} distinct category_name value(s).\n";

if ($unmatched) {
    echo "\n⚠ UNMATCHED — these need manual review (no rows changed for these):\n";
    foreach ($unmatched as $name) {
        echo "  - \"{$name}\"\n";
    }
    echo "Add these to evaluation_question_categories (or fix the spelling) and re-run this script to pick them up.\n";
}

echo "\n=== Step 2: Recomputing category_averages / column_averages ===\n";

$programIds = $pdo->query("
    SELECT DISTINCT r.program_id
    FROM respondent_scores rs
    JOIN respondents r ON r.id = rs.respondent_id
")->fetchAll(PDO::FETCH_COLUMN);

$recomputed = 0;
foreach ($programIds as $programId) {
    insertCategoryAverages($pdo, (int)$programId);
    insertColumnAverages($pdo, (int)$programId);
    $recomputed++;
}

echo "Recomputed derived tables for {$recomputed} program(s).\n";
echo "\nDone.\n";
