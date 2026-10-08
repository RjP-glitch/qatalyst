<?php
/**
 * API Endpoint: speaker_counts.php
 * Path: smme-api/api/speaker_counts.php
 *
 * Returns speaker counts for EVERY workshop, container program, and standalone
 * record in three queries total, instead of the caller having to fire one
 * speaker_roster.php / records_api.php request per program.
 *
 * Was added to replace the "fire 70-100 requests in parallel" pattern in
 * fetchAndApplySpeakerCounts() (speaker-roster.js), which was blowing past
 * the shared-hosting MySQL max_connections limit and causing every request
 * in the burst to fail with "Database connection error".
 *
 * Usage:
 *   GET /api/speaker_counts.php
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "containers": { "<workshop_id>": <count>, ... },   // container programs (speaker_averages, merged by slot)
 *       "records":    { "<program_id>": <count>, ... }     // standalone imported records (speaker_averages)
 *     }
 *   }
 *
 * Note: this used to also return a "workshops" key sourced from
 * resource_speakers/workshop_days (the "live workshop" speaker feature).
 * That table isn't used on this install, so the block was removed rather
 * than left to fail on every request. speaker-roster.js defaults workshops
 * to {} when the key is absent, so this is a safe removal.
 */

require_once dirname(__DIR__) . '/config/security.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once '../config/database.php';

try {
    $pdo = getDB();

    // ─── Container programs ────────────────────────────────────────────────────
    // Mirrors the merge-by-slot_number logic in speaker_roster.php's container
    // branch: a speaker that appears on multiple linked days is still one
    // speaker, so count DISTINCT slot_number per container workshop_id.
    $containerStmt = $pdo->query("
        SELECT pi.workshop_id, COUNT(DISTINCT sa.slot_number) AS cnt
        FROM program_imports pi
        JOIN speaker_averages sa ON sa.program_id = pi.program_id
        GROUP BY pi.workshop_id
    ");
    $containerCounts = [];
    foreach ($containerStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $containerCounts[(string)$row['workshop_id']] = (int)$row['cnt'];
    }

    // ─── Standalone records ─────────────────────────────────────────────────────
    // records_api.php sums day.speakers.length across all day_sheets for a
    // program, which is equivalent to counting every speaker_averages row
    // for that program_id (rows aren't deduped across days here, unlike
    // the container merge above).
    $recordStmt = $pdo->query("
        SELECT sa.program_id, COUNT(*) AS cnt
        FROM speaker_averages sa
        JOIN evaluation_programs ep ON ep.id = sa.program_id
        WHERE ep.workshop_id IS NULL
        GROUP BY sa.program_id
    ");
    $recordCounts = [];
    foreach ($recordStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $recordCounts[(string)$row['program_id']] = (int)$row['cnt'];
    }

    echo json_encode([
        'success' => true,
        'data'    => [
            'containers' => $containerCounts,
            'records'    => $recordCounts,
        ],
    ]);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Server error: ' . $e->getMessage(),
    ]);
}
