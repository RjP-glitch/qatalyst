<?php
/**
 * school-tracker.php
 * REST-style API for the Document Tracking System — Private School
 * Application and Request checklist.
 *
 * Supported actions (via GET ?action=):
 *   GET  load              ?year_id=N&school_type=private|public  — load checkbox states
 *   GET  years                                                     — list all school years
 *   GET  check_year_empty  ?year_id=N                             — check if year has records
 *   POST save                                                      — upsert one or many cells
 *   POST add_year                                                  — insert a new school year
 *   POST delete_year                                               — delete an empty year
 *
 * All responses: JSON  { success: bool, ... }
 * All endpoints require authentication + 'checklist' permission.
 *
 * CHANGELOG:
 *   - load: now returns { is_checked, checked_at, checked_by_name } per cell
 *     so the front-end can display timestamps next to each checkbox.
 *   - save: accepts optional custom_timestamp (ISO string) per cell to allow
 *     manual override of checked_at from the UI timestamp editor.
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

// ── helpers ──────────────────────────────────────────────────────────────────
function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError(string $msg, int $code = 400): void {
    jsonOut(['success' => false, 'message' => $msg], $code);
}

function isValidQuarterKey($q): bool {
    return is_string($q) && preg_match('/^Q[1-4]$/', $q);
}

/**
 * Extracts a quarter key (Q1..Q4) from the notes column.
 * Notes may be JSON (preferred) or plain text.
 */
function quarterFromNotes($notes): ?string {
    if ($notes === null) return null;
    $s = trim((string)$notes);
    if ($s === '') return null;

    $decoded = json_decode($s, true);
    if (is_array($decoded)) {
        $q = $decoded['q'] ?? ($decoded['quarter'] ?? null);
        if (isValidQuarterKey($q)) return $q;
    }

    if (preg_match('/\bQ([1-4])\b/i', $s, $m)) {
        return 'Q' . (int)$m[1];
    }
    if (preg_match('/\b([1-4])(?:st|nd|rd|th)?\s*quarter\b/i', $s, $m)) {
        return 'Q' . (int)$m[1];
    }
    return null;
}

/**
 * Returns the schools table name for the given school_type.
 * Defaults to 'private_schools' for backwards compatibility.
 */
function schoolsTable(string $schoolType): string {
    return $schoolType === 'public' ? 'public_schools' : 'private_schools';
}

// ── router ───────────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $body = $raw ? (json_decode($raw, true) ?? []) : [];
}

try {
    $pdo = getDb();

    // ── GET years ──────────────────────────────────────────────────────────
    if ($method === 'GET' && $action === 'years') {
        $stmt = $pdo->query(
            "SELECT id, school_year, label, is_active
             FROM school_tracker_years
             WHERE is_active = 1
             ORDER BY school_year ASC"
        );
        jsonOut(['success' => true, 'years' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    // ── GET load ───────────────────────────────────────────────────────────
    // Now returns checked_at and checked_by_name so the front-end can show
    // timestamps next to each checkbox without an extra round-trip.
    if ($method === 'GET' && $action === 'load') {
        $yearId     = filter_input(INPUT_GET, 'year_id', FILTER_VALIDATE_INT);
        $schoolType = isset($_GET['school_type']) && $_GET['school_type'] === 'public' ? 'public' : 'private';

        if (!$yearId) jsonError('year_id is required');

        $tbl = schoolsTable($schoolType);

        $stmt = $pdo->prepare(
            "SELECT s.id                   AS school_id,
                    c.category_key,
                    c.row_label,
                    c.step_label,
                    c.is_checked,
                    c.notes,
                    c.checked_at,
                    u.full_name            AS checked_by_name
             FROM   school_tracker_checklist c
             JOIN   `{$tbl}` s ON s.id = c.private_school_id
             LEFT JOIN users u ON u.id = c.checked_by
             WHERE  c.year_id    = :year_id
               AND  c.school_type = :school_type
               AND  s.active = 1
             ORDER BY s.id, c.category_key, c.row_label, c.step_label"
        );
        $stmt->execute([
            ':year_id'     => $yearId,
            ':school_type' => $schoolType,
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Build data map:
        //   data[school_id][composite_key] = { checked: bool, ts: "ISO string or null", by: "name or null", q: "Q1..Q4 or null" }
        $data = [];
        foreach ($rows as $row) {
            $sid = (int)$row['school_id'];
            $key = $row['category_key'] . '|' . $row['row_label'] . '|' . $row['step_label'];
            if (!isset($data[$sid])) $data[$sid] = [];
            $q = quarterFromNotes($row['notes'] ?? null);
            $data[$sid][$key] = [
                'checked' => (bool)$row['is_checked'],
                // If a quarter is set, treat it as quarter-only and prefer not to show an exact timestamp.
                'ts'      => $q ? null : ($row['checked_at'] ?: null),
                'by'      => $row['checked_by_name'] ?: null,
                'q'       => $q,
            ];
        }

        jsonOut(['success' => true, 'year_id' => $yearId, 'data' => $data]);
    }

    // ── GET check_year_empty ───────────────────────────────────────────────
    if ($method === 'GET' && $action === 'check_year_empty') {
        $yearId = filter_input(INPUT_GET, 'year_id', FILTER_VALIDATE_INT);
        if (!$yearId) jsonError('year_id is required');

        $stmt = $pdo->prepare(
            "SELECT COUNT(*) AS cnt
             FROM school_tracker_checklist
             WHERE year_id = ? AND is_checked = 1"
        );
        $stmt->execute([$yearId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        jsonOut(['success' => true, 'empty' => ((int)$row['cnt'] === 0)]);
    }

    // ── POST save ──────────────────────────────────────────────────────────
    // Accepts cells as:
    //   { "cat|row|step": true }          — simple bool (backwards compat)
    //   { "cat|row|step": { checked: true, ts: "2025-06-01T09:30:00" } } — with custom timestamp
    //   { "cat|row|step": { checked: true, q: "Q2" } } — quarter-only (no exact date)
    if ($method === 'POST' && $action === 'save') {
        $yearId     = isset($body['year_id'])     ? (int)$body['year_id']   : 0;
        $schoolId   = isset($body['school_id'])   ? (int)$body['school_id'] : 0;
        $schoolType = isset($body['school_type']) && $body['school_type'] === 'public' ? 'public' : 'private';
        $cells      = $body['cells'] ?? [];

        if (!$yearId)   jsonError('year_id is required');
        if (!$schoolId) jsonError('school_id is required');
        if (!is_array($cells) || empty($cells)) jsonError('cells must be a non-empty object');

        $tbl = schoolsTable($schoolType);

        $chkStmt = $pdo->prepare("SELECT id FROM private_schools WHERE id = :id AND active = 1");
        $chkStmt->execute([':id' => $schoolId]);
        if (!$chkStmt->fetch()) jsonError('Invalid school_id', 404);

        $yrStmt = $pdo->prepare("SELECT id FROM school_tracker_years WHERE id = :id");
        $yrStmt->execute([':id' => $yearId]);
        if (!$yrStmt->fetch()) jsonError('Invalid year_id', 404);

        // Detect whether checked_at can be NULL (some deployments may have stricter schemas).
        $checkedAtNullable = true;
        try {
            $col = $pdo->query(
                "SELECT IS_NULLABLE
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'school_tracker_checklist'
                   AND COLUMN_NAME = 'checked_at'")
                ->fetch(PDO::FETCH_ASSOC);
            if ($col && isset($col['IS_NULLABLE'])) {
                $checkedAtNullable = (strtoupper((string)$col['IS_NULLABLE']) === 'YES');
            }
        } catch (Throwable $e) {
            // If we can't detect it, assume nullable (existing behaviour in most setups).
            $checkedAtNullable = true;
        }

                // Single upsert that allows:
                // - checked_at = NULL (unchecked or quarter-only)
                // - checked_at = explicit datetime string
                // - notes to store quarter metadata
                $upsert = $pdo->prepare(
                        "INSERT INTO school_tracker_checklist
                             (school_id, private_school_id, year_id, school_type, category_key, row_label, step_label, is_checked, checked_by, checked_at, notes)
                         VALUES
                             (:school_id, :private_school_id, :year_id, :school_type, :cat, :row, :step, :checked, :user, :ts, :notes)
                         ON DUPLICATE KEY UPDATE
                             private_school_id = VALUES(private_school_id),
                             is_checked = VALUES(is_checked),
                             checked_by = VALUES(checked_by),
                             checked_at = VALUES(checked_at),
                             notes      = VALUES(notes)"
                );

        $pdo->beginTransaction();
        try {
            foreach ($cells as $compositeKey => $cellValue) {
                $parts = explode('|', $compositeKey, 3);
                if (count($parts) !== 3) continue;

                [$catKey, $rowLabel, $stepLabel] = $parts;
                $catKey    = mb_substr($catKey,    0, 60);
                $rowLabel  = mb_substr($rowLabel,  0, 100);
                $stepLabel = mb_substr($stepLabel, 0, 100);

                // Support both the old bool format and the new {checked, ts, q} object format
                if (is_array($cellValue)) {
                    $isChecked       = !empty($cellValue['checked']);
                    $customTimestamp = isset($cellValue['ts']) ? (string)$cellValue['ts'] : null;
                    $quarterKey      = isset($cellValue['q']) ? strtoupper(trim((string)$cellValue['q'])) : null;
                } else {
                    $isChecked       = (bool)$cellValue;
                    $customTimestamp = null;
                    $quarterKey      = null;
                }

                if (!isValidQuarterKey($quarterKey)) {
                    $quarterKey = null;
                }

                // Validate custom timestamp — must be a parseable date string
                if ($customTimestamp !== null) {
                    $parsed = strtotime($customTimestamp);
                    if ($parsed === false) {
                        $customTimestamp = null; // fall back to NOW()
                    } else {
                        // Normalise to MySQL DATETIME format
                        $customTimestamp = date('Y-m-d H:i:s', $parsed);
                    }
                }

                // Decide what to store
                $checkedAt = null;
                $notes     = null;
                if (!$isChecked) {
                    $checkedAt = $checkedAtNullable ? null : date('Y-m-d H:i:s');
                    $notes = null;
                } else if ($quarterKey !== null && $customTimestamp === null) {
                    // Quarter-only: no exact date/time.
                    $checkedAt = $checkedAtNullable ? null : date('Y-m-d H:i:s');
                    $notes = json_encode(['q' => $quarterKey], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                } else if ($customTimestamp !== null) {
                    // Exact timestamp
                    $checkedAt = $customTimestamp;
                    $notes = null;
                } else {
                    // Default behaviour: stamp when saved
                    $checkedAt = date('Y-m-d H:i:s');
                    $notes = null;
                }

                $base = [
                    ':school_id'        => $schoolId,
                    ':private_school_id' => $schoolId,
                    ':year_id'          => $yearId,
                    ':school_type' => $schoolType,
                    ':cat'         => $catKey,
                    ':row'         => $rowLabel,
                    ':step'        => $stepLabel,
                    ':checked'     => $isChecked ? 1 : 0,
                    ':user'        => $authUser['id'] ?? null,
                    ':ts'          => $checkedAt,
                    ':notes'       => $notes,
                ];

                $upsert->execute($base);
            }
            $pdo->commit();
            jsonOut(['success' => true, 'saved' => count($cells)]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    // ── POST add_year ──────────────────────────────────────────────────────
    if ($method === 'POST' && $action === 'add_year') {
        $sy    = trim((string)($body['school_year'] ?? ''));
        $label = trim((string)($body['label']       ?? ''));

        if (!$sy) jsonError('school_year is required');
        if (!preg_match('/^\d{4}-\d{4}$/', $sy)) {
            jsonError('school_year must be in YYYY-YYYY format (e.g. 2026-2027)');
        }

        $ins = $pdo->prepare(
            "INSERT IGNORE INTO school_tracker_years (school_year, label, created_by)
             VALUES (:sy, :label, :user)"
        );
        $ins->execute([
            ':sy'    => $sy,
            ':label' => $label ?: 'SY ' . $sy,
            ':user'  => $authUser['id'] ?? null,
        ]);

        if ($ins->rowCount() === 0) {
            $exist = $pdo->prepare(
                "SELECT id, school_year, label FROM school_tracker_years WHERE school_year = :sy"
            );
            $exist->execute([':sy' => $sy]);
            $row = $exist->fetch(PDO::FETCH_ASSOC);
            jsonOut(['success' => true, 'already_exists' => true, 'year' => $row]);
        }

        $newId = (int)$pdo->lastInsertId();
        jsonOut([
            'success' => true,
            'year'    => ['id' => $newId, 'school_year' => $sy, 'label' => 'SY ' . $sy],
        ]);
    }

    // ── POST delete_year ───────────────────────────────────────────────────
    if ($method === 'POST' && $action === 'delete_year') {
        $yearId = isset($body['year_id']) ? (int)$body['year_id'] : 0;
        if (!$yearId) jsonError('year_id is required');

        // Double-check on the server: refuse if any checked records exist
        $chk = $pdo->prepare(
            "SELECT COUNT(*) AS cnt
             FROM school_tracker_checklist
             WHERE year_id = ? AND is_checked = 1"
        );
        $chk->execute([$yearId]);
        $row = $chk->fetch(PDO::FETCH_ASSOC);

        if ((int)$row['cnt'] > 0) {
            jsonError('Cannot delete this year — it still has checked tracking records.', 409);
        }

        // Delete any unchecked rows for this year, then the year itself
        $pdo->prepare("DELETE FROM school_tracker_checklist WHERE year_id = ?")->execute([$yearId]);
        $pdo->prepare("UPDATE school_tracker_years SET is_active = 0 WHERE id = ?")->execute([$yearId]);

        jsonOut(['success' => true]);
    }

    jsonError('Unknown action: ' . htmlspecialchars($action));

} catch (Throwable $e) {
    error_log('school-tracker.php error: ' . $e->getMessage());
    jsonError('Server error — please try again.', 500);
}