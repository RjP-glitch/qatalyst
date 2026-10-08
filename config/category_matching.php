<?php
/**
 * config/category_matching.php
 *
 * Single source of truth for turning a free-text category name (however it
 * was spelled in a given import) into the canonical
 * evaluation_question_categories.id it refers to.
 *
 * Used by:
 *   - save.php            (resolves category_id at insert time, going forward)
 *   - backfill_category_ids.php (resolves category_id for existing rows)
 *
 * Keeping this in one file means the matching rules (case, whitespace,
 * "&" vs "and", parenthetical qualifiers) only need to be right in one
 * place, and save.php / the backfill script can never drift out of sync
 * with each other the way the report code and the importer previously did.
 */

/**
 * Normalizes a category name into a comparison key: lowercase, "&" and
 * "and" treated as equivalent, punctuation/parentheses stripped, and
 * whitespace collapsed. Mirrors normalizeReportCategoryName() in
 * programs.js and categoryDedupKey() in import-excell.js — if you change
 * the matching rules here, update those too so all three stay consistent.
 */
function normalizeCategoryMatchKey(string $name): string
{
    $s = strtolower(trim($name));
    $s = str_replace('&', ' and ', $s);
    $s = preg_replace('/\(.*?\)/', ' ', $s);   // drop parenthetical qualifiers, e.g. "(FOR IN-PERSON ATTENDEES ONLY)"
    $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
    $s = preg_replace('/\s+/', ' ', $s);
    return trim($s);
}

/**
 * Loads all evaluation_question_categories rows once and returns them
 * keyed by normalized match key. Cached per-request (static) since this
 * table rarely changes and may be resolved against many times in a loop.
 */
function loadCategoryMatchIndex(PDO $pdo): array
{
    static $index = null;
    if ($index !== null) return $index;

    $index = [];
    $rows = $pdo->query("SELECT id, name FROM evaluation_question_categories")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $row) {
        $key = normalizeCategoryMatchKey($row['name']);
        if ($key === '') continue;
        // If two categories somehow normalize to the same key, keep the
        // first (lowest id) rather than silently overwriting — surfaces
        // the conflict instead of hiding it.
        if (!isset($index[$key])) {
            $index[$key] = (int)$row['id'];
        }
    }
    return $index;
}

/**
 * Resolves a raw category_name string to its canonical category_id, or
 * null if nothing matches (e.g. "Resource Speaker" text variants, or a
 * genuinely new/unrecognized category — those stay unmatched rather than
 * being force-fit to the wrong row).
 */
function resolveCategoryId(PDO $pdo, ?string $categoryName): ?int
{
    if ($categoryName === null || trim($categoryName) === '') return null;
    $key = normalizeCategoryMatchKey($categoryName);
    if ($key === '') return null;
    $index = loadCategoryMatchIndex($pdo);
    return $index[$key] ?? null;
}
