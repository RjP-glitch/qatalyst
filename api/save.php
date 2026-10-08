<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);

// SECURITY: Include security helpers and set proper headers
require_once '../config/security.php';
require_once '../config/database.php';
require_once '../config/auth_middleware.php';
require_once '../config/category_matching.php';
require_once '../config/report_averages.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for data modification
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized. Please log in.']);
    exit;
}

// Require 'programs' permission to save/import data
requirePermission('programs', $authUser);

// Rating-scale lookup (getRatingFromScale, getResultLabel) and the
// derived-table builders (insertCategoryAverages, insertColumnAverages)
// now live in config/report_averages.php — required above — so
// backfill_category_ids.php can reuse the exact same logic for existing
// programs instead of duplicating it.


// BUG 17 FIX: single authoritative placeholder email list — referenced everywhere below
$PLACEHOLDER_EMAILS = ['anonymous', 'n/a', 'none', 'na', '-', 'n.a.', 'no email', 'noemail', 'no_email'];

// ── Normalise a sex string → enum value ──────────────────────────────────────
function normaliseSex(?string $raw): ?string {
    if ($raw === null) return null;

    $v = strtolower(trim($raw));
    if ($v === '') return null;

    if (in_array($v, ['male', 'm', '1', 'lalaki'])) return 'Male';
    if (in_array($v, ['female', 'f', '2', 'babae'])) return 'Female';
    if (in_array($v, ['other', 'lgbtq', 'lgbtq+', '3', 'prefer not to say', 'pnts', 'prefer', 'non-binary', 'nonbinary'])) return 'Other';

    return null; // unknown → store NULL
}

// insertCategoryAverages() and insertColumnAverages() now live in
// config/report_averages.php (required above) so backfill_category_ids.php
// can call the identical logic for existing programs.

// ═════════════════════════════════════════════════════════════════════════════
try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST')
        throw new Exception('Invalid request method.');

    $body = json_decode(file_get_contents('php://input'), true);
    if (!$body) throw new Exception('Invalid JSON payload.');

    $meta         = $body['meta']                ?? [];
    $respondents  = $body['respondents']         ?? [];
    $consolidated = $body['consolidated']        ?? [];
    $qHeaders     = $body['questionHeaders']     ?? [];
    $filename     = $body['filename']            ?? '';
    $qCategoryMap = $body['questionCategoryMap'] ?? [];
    $incomingFeedbackLabels = $body['feedback_labels'] ?? null;

    // Detect container-linked import early: workshop_id + day_label present means
    // this is a day import linked to a container program — program details are
    // owned by the container and should NOT be saved/duplicated on the import record.
    $incomingWorkshopId = !empty($body['workshop_id']) ? intval($body['workshop_id']) : null;
    $incomingDayLabelRaw = trim($body['day_label'] ?? '');
    $isContainerLinkedImport = ($incomingWorkshopId !== null && $incomingDayLabelRaw !== '');

    if (empty($meta['title']) && !$isContainerLinkedImport)
        throw new Exception('Training program title is required.');

    // For container-linked imports, use a placeholder title derived from the day label
    // so the evaluation_programs row has a valid title (NOT NULL constraint).
    if ($isContainerLinkedImport && empty($meta['title'])) {
        $meta['title'] = '[' . $incomingDayLabelRaw . ' Import]';
    }

    $pdo = getDB();
    $pdo->beginTransaction();

    // Detect optional schema support (older DBs may not have this column yet)
    $hasFeedbackLabelCol = false;
    try {
        $colStmt = $pdo->prepare("SHOW COLUMNS FROM respondent_feedback LIKE 'feedback_label'");
        $colStmt->execute();
        $hasFeedbackLabelCol = (bool)$colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $_) {
        $hasFeedbackLabelCol = false;
    }

    // feedback_labels is no longer used for insert — labels come directly from
    // the respondent feedback keys (which are the actual Excel column headers).
    // Kept only for the settings_snapshot so exports can read the exact header wording.
    $feedbackLabelsForInsert = []; // unused; retained for snapshot logic below

    // ── 1. Summary statistics ─────────────────────────────────────────────────
    // Unique respondent count (deduplicate by real email across days).
    // 'anonymous' and placeholder emails are counted individually — each is a
    // real submission, just privacy-masked. Only genuine unique emails are deduped.
    // BUG 17 FIX: use shared PLACEHOLDER_EMAILS constant (defined at top of file)
    $seenRealEmails = [];
    $totalResponses = 0;
    foreach ($respondents as $r) {
        $email  = strtolower(trim($r['email'] ?? ''));
        $isReal = $email !== '' && !in_array($email, $PLACEHOLDER_EMAILS, true);
        if ($isReal) {
            if (!isset($seenRealEmails[$email])) {
                $seenRealEmails[$email] = true;
                $totalResponses++;
            }
        } else {
            $totalResponses++;
        }
    }
    $days     = $consolidated['days'] ?? [];
    // FIX: For container-linked imports (day_label in payload e.g. "Day 2"),
    // trust the labels already set by process.php and JS. Do NOT re-index from 1,
    // which was overwriting "Day 2" -> "Day 1" in the respondents table.
    // For standalone multi-day imports (no day_label), keep the positional fallback.
    $incomingDayLabel = $incomingDayLabelRaw; // already set above from $body['day_label']
    if (!$isContainerLinkedImport) {
        // Standalone: normalize positionally (Day 1, Day 2, Day 3 ...)
        foreach ($days as $di => &$dayEntry) {
            $dayEntry['day'] = 'Day ' . ($di + 1);
        }
        unset($dayEntry);
    }
    // Build a map so respondent .day fields are aligned with the final day labels.
    $dayLabelMap = [];
    foreach ($days as $di => $d) {
        $finalLabel = $d['day'] ?? ('Day ' . ($di + 1));
        $dayLabelMap[$finalLabel] = $finalLabel; // labels are already correct
        // Also cover positional fallback keys that may still arrive from old data
        $positional = 'Day ' . ($di + 1);
        if (!isset($dayLabelMap[$positional])) {
            $dayLabelMap[$positional] = $finalLabel;
        }
    }
    foreach ($respondents as &$r) {
        $orig = $r['day'] ?? '';
        if ($orig !== '' && isset($dayLabelMap[$orig])) {
            $r['day'] = $dayLabelMap[$orig];
        } elseif ($isContainerLinkedImport) {
            // Fallback: any respondent without a recognised day gets the container label
            $r['day'] = $incomingDayLabel;
        }
    }
    unset($r);
    $dayCount = count($days);
    $totalParticipants = intval($meta['total_participants'] ?? 0);

    // Per-day participant counts (optional — sent from the save modal)
    $dayParticipants = $body['day_participants'] ?? null; // e.g. {"Day 1":50,"Day 2":60}

    $avgResponses = $dayCount > 0
        ? round($totalResponses / $dayCount, 2)
        : $totalResponses;

    // Compute pct_responses:
    // If per-day participant counts were provided, average the per-day percentages.
    // This correctly handles cases where the same person responded on multiple days
    // (each day is treated independently with its own participant total).
    if (!empty($dayParticipants) && is_array($dayParticipants) && $dayCount > 0) {
        $dayPcts = [];
        foreach ($days as $day) {
            $dayName  = $day['day'] ?? '';
            $dayResp  = count(array_filter($respondents ?? [], fn($r) => ($r['day'] ?? '') === $dayName));
            if ($dayResp === 0) {
                // Fall back to consolidated respondents count
                $dayResp = intval($day['respondents'] ?? 0);
            }
            $dayTotal = intval($dayParticipants[$dayName] ?? 0);
            if ($dayTotal > 0) {
                $dayPcts[] = min(($dayResp / $dayTotal) * 100, 100);
            }
        }
        $pctResponses = count($dayPcts) > 0
            ? round(array_sum($dayPcts) / count($dayPcts), 2)
            : 0;
    } else {
        $pctResponses = ($totalParticipants > 0)
            ? round(($totalResponses / $totalParticipants) * 100, 2)
            : 0;
    }

    // METHOD CHANGE: overall_average is now the unweighted mean of the per-category
    // averages in $consolidated['overallCategories'] — each category counts equally,
    // matching the manual/paper QATAME computation and the (already-fixed) formulas
    // in responses.php and program_dashboard.php. This used to average each
    // respondent's own 'average' field (their personal mean across ALL answered
    // questions regardless of category), which is mathematically the same shape as
    // the old question-weighted method: categories with more questions pulled the
    // figure further, which is why this stored value could drift from the manual
    // per-category calculation (e.g. 3.92 vs a manually-computed 3.89 on the same
    // data). This value is written once at import time into evaluation_programs, so
    // existing rows need a one-time backfill (see backfill_overall_average.php)
    // — this change only affects imports going forward.
    $overallCategories = $consolidated['overallCategories'] ?? [];
    if (!empty($overallCategories)) {
        $catAvgs    = array_map(fn($c) => (float)($c['avg'] ?? 0), $overallCategories);
        $overallAvg = count($catAvgs) > 0 ? round(array_sum($catAvgs) / count($catAvgs), 2) : 0;
    } else {
        // Fallback for malformed/legacy payloads with no category breakdown —
        // better to fall back to the old method than to store a false zero.
        $allAvgs    = array_column($respondents, 'average');
        $overallAvg = count($allAvgs) > 0
            ? round(array_sum($allAvgs) / count($allAvgs), 2)
            : 0;
    }
    $overallResult = getResultLabel($overallAvg, 'overall');

    // ── 2. evaluation_programs ────────────────────────────────────────────────
    // Snapshot current eval_settings so they can be loaded/copied later
    $settingsSnapshot = null;
    try {
        $snapRows = $pdo->query("SELECT setting_key, setting_value FROM eval_settings")
                        ->fetchAll(PDO::FETCH_ASSOC);
        $snapObj = [];
        foreach ($snapRows as $sr) {
            $snapObj[$sr['setting_key']] = json_decode($sr['setting_value'], true);
        }
        // Embed day_participants into snapshot so it can be read back by records_api
        if (!empty($dayParticipants) && is_array($dayParticipants)) {
            $snapObj['day_participants'] = $dayParticipants;
        }

        // feedback_labels are no longer stored in the snapshot — the actual column
        // header text is saved directly as feedback_label in respondent_feedback rows.
        $settingsSnapshot = json_encode($snapObj, JSON_UNESCAPED_UNICODE);
    } catch (Exception $snapErr) {
    }

    // $incomingWorkshopId / $isContainerLinkedImport already set above
    $workshopId = $incomingWorkshopId;
    // source_type must match the DB enum: ('excel','online','merged')
    // All imports via the Excel importer use 'excel' regardless of workshop linkage.
    $sourceType = 'excel';

    // ── Check for existing program and delete if re-saving (prevent duplicates) ──
    // Priority 1: same filename (most reliable).
    // Priority 2: same title + same workshop linkage (handles NULL correctly in PHP).
    $existingProgram = null;

    if ($filename) {
        $existingStmt = $pdo->prepare("
            SELECT id FROM evaluation_programs
            WHERE source_type = 'excel'
              AND source_filename = :filename
            LIMIT 1
        ");
        $existingStmt->execute([':filename' => $filename]);
        $existingProgram = $existingStmt->fetch(PDO::FETCH_ASSOC);
    }

    if (!$existingProgram) {
        if ($workshopId !== null) {
            $existingStmt = $pdo->prepare("
                SELECT id FROM evaluation_programs
                WHERE source_type = 'excel'
                  AND title = :title
                  AND workshop_id = :wid
                LIMIT 1
            ");
            $existingStmt->execute([
                ':title' => trim($meta['title']),
                ':wid'   => $workshopId,
            ]);
        } else {
            $existingStmt = $pdo->prepare("
                SELECT id FROM evaluation_programs
                WHERE source_type = 'excel'
                  AND title = :title
                  AND workshop_id IS NULL
                LIMIT 1
            ");
            $existingStmt->execute([':title' => trim($meta['title'])]);
        }
        $existingProgram = $existingStmt->fetch(PDO::FETCH_ASSOC);
    }

    if ($existingProgram) {
        $oldPid = (int)$existingProgram['id'];

        // FIX #1: Remove stale workshop_participants tied to this program's
        // respondents before re-inserting, to prevent duplicates on re-import.
        // Excel-imported participants have response_id = NULL, so we match by
        // workshop_id + full_name against the respondents we're about to delete.
        if ($workshopId) {
            $pdo->prepare("
                DELETE wp FROM workshop_participants wp
                WHERE wp.workshop_id = :wid
                  AND wp.response_id IS NULL
                  AND wp.full_name IN (
                      SELECT respondent_name FROM respondents WHERE program_id = :pid
                  )
            ")->execute([':wid' => $workshopId, ':pid' => $oldPid]);
        }

        // Delete in correct order to respect FK relationships
        $pdo->prepare("DELETE sc FROM speaker_criteria sc
                       JOIN speaker_averages sa ON sc.speaker_avg_id = sa.id
                       WHERE sa.program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE FROM speaker_averages WHERE program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE FROM column_averages WHERE program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE FROM category_averages WHERE program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE rf FROM respondent_feedback rf
                       JOIN respondents r ON rf.respondent_id = r.id
                       WHERE r.program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE rs FROM respondent_scores rs
                       JOIN respondents r ON rs.respondent_id = r.id
                       WHERE r.program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE FROM respondents WHERE program_id = ?")->execute([$oldPid]);
        // BUG 2 FIX: delete the program_imports row pointing to the old record to
        // prevent orphaned foreign keys when the evaluation_programs row is deleted below
        $pdo->prepare("DELETE FROM program_imports WHERE program_id = ?")->execute([$oldPid]);
        $pdo->prepare("DELETE FROM evaluation_programs WHERE id = ?")->execute([$oldPid]);
    }

    // Auto-generate sequence number if not provided
    $sequenceNumber = trim($meta['sequence_number'] ?? '');
    if (empty($sequenceNumber)) {
        $year   = date('Y');
        $prefix = "SDOCB-SMME-{$year}-";
        $snStmt = $pdo->prepare(
            "SELECT sequence_number FROM evaluation_programs WHERE sequence_number LIKE ?"
        );
        $snStmt->execute(["{$prefix}%"]);
        $existing = $snStmt->fetchAll(PDO::FETCH_COLUMN);
        $max = 0;
        foreach ($existing as $sn) {
            $num = (int) substr($sn, strlen($prefix));
            if ($num > $max) $max = $num;
        }
        $sequenceNumber = $prefix . str_pad($max + 1, 3, '0', STR_PAD_LEFT);
    } else {
        // Validate format
        if (!preg_match('/^SDOCB-SMME-\d{4}-\d{3,}$/', $sequenceNumber)) {
            throw new Exception(
                "Invalid sequence number format. Expected: SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)."
            );
        }
        // Check for duplicates
        $dupChk = $pdo->prepare(
            "SELECT id FROM evaluation_programs WHERE sequence_number = ?"
        );
        $dupChk->execute([$sequenceNumber]);
        $conflict = $dupChk->fetch(PDO::FETCH_ASSOC);
        if ($conflict) {
            throw new Exception(
                "Sequence number \"{$sequenceNumber}\" is already in use by record ID #{$conflict['id']}. Please use a different number or leave blank to auto-generate."
            );
        }
    }

    $stmt = $pdo->prepare("
        INSERT INTO evaluation_programs
            (title, sequence_number, division_memo, proponents, training_venue, inclusive_dates,
             start_date, end_date, qame_associates, total_participants, total_responses,
             avg_responses, pct_responses, overall_average,
             overall_result, detected_scale, source_filename,
             settings_snapshot, workshop_id, source_type,
             status, unit, nature_of_event, description, page)
        VALUES
            (:title, :sequence_number, :division_memo, :proponents, :venue, :dates,
             :start_date, :end_date, :qame, :total_p, :total_r,
             :avg_r, :pct_r, :ov_avg,
             :ov_res, :scale, :filename,
             :snapshot, :wid, :stype,
             :status, :unit, :nature, :description, :page)
    ");

    // For container-linked imports: program details (title, memo, venue, dates, etc.)
    // are owned by the container program — do NOT duplicate them on the day import row.
    // Only save statistical columns + the link identifiers.
    if ($isContainerLinkedImport) {
        $stmt->execute([
            ':title'           => trim($meta['title']),  // placeholder e.g. "[Day 1 Import]"
            ':sequence_number' => $sequenceNumber,
            ':division_memo'   => null,
            ':proponents'      => null,
            ':venue'           => null,
            ':dates'           => trim($meta['inclusive_dates'] ?? '') ?: null,  // per-day date from import modal
            ':start_date'      => null,
            ':end_date'        => null,
            ':qame'            => null,
            ':total_p'         => $totalParticipants,
            ':total_r'         => $totalResponses,
            ':avg_r'           => $avgResponses,
            ':pct_r'           => $pctResponses,
            ':ov_avg'          => $overallAvg,
            ':ov_res'          => $overallResult,
            ':scale'           => intval($body['detectedScale'] ?? 4),
            ':filename'        => $filename,
            ':snapshot'        => $settingsSnapshot,
            ':wid'             => $workshopId,
            ':stype'           => $sourceType,
            ':status'          => 'completed',
            ':unit'            => null,
            ':nature'          => null,
            ':description'     => null,
            ':page'            => trim($meta['page'] ?? 'qatame'),
        ]);
    } else {
        // Standalone import: save all program detail fields normally
        $stmt->execute([
            ':title'           => trim($meta['title']),
            ':sequence_number' => $sequenceNumber,
            ':division_memo'   => trim($meta['division_memo'] ?? ''),
            ':proponents'      => trim($meta['proponents'] ?? ''),
            ':venue'           => trim($meta['training_venue'] ?? ''),
            ':dates'           => trim($meta['inclusive_dates'] ?? ''),
            ':start_date'      => trim($meta['start_date'] ?? '') ?: null,
            ':end_date'        => trim($meta['end_date'] ?? '') ?: null,
            ':qame'            => trim($meta['qame_associates'] ?? ''),
            ':total_p'         => $totalParticipants,
            ':total_r'         => $totalResponses,
            ':avg_r'           => $avgResponses,
            ':pct_r'           => $pctResponses,
            ':ov_avg'          => $overallAvg,
            ':ov_res'          => $overallResult,
            ':scale'           => intval($body['detectedScale'] ?? 4),
            ':filename'        => $filename,
            ':snapshot'        => $settingsSnapshot,
            ':wid'             => $workshopId,
            ':stype'           => $sourceType,
            ':status'          => trim($meta['status'] ?? 'completed'),
            ':unit'            => trim($meta['unit'] ?? ''),
            ':nature'          => trim($meta['nature_of_event'] ?? ''),
            ':description'     => trim($meta['description'] ?? ''),
            ':page'            => trim($meta['page'] ?? 'qatame'),
        ]);
    }
    $programId = (int)$pdo->lastInsertId();

    // ── 2b. Link to program_imports if this is a container-linked import ───────
    // When the user arrives from programs.html via "+ Add Day Import", the payload
    // includes workshop_id (already captured above) AND day_label.
    $dayLabel = trim($body['day_label'] ?? '');
    if ($workshopId && $dayLabel) {
        // If this is a replace, inherit the old row's day_number so order is preserved.
        // Otherwise auto-assign from existing count.
        $replaceImportId = !empty($body['replace_import_id']) ? intval($body['replace_import_id']) : null;
        if ($replaceImportId) {
            $oldStmt = $pdo->prepare("SELECT day_number FROM program_imports WHERE id = ?");
            $oldStmt->execute([$replaceImportId]);
            $oldRow = $oldStmt->fetch(PDO::FETCH_ASSOC);
            $dayNumber = $oldRow ? (int)$oldRow['day_number'] : 1;
        } else {
            // BUG 5 FIX: use MAX(day_number)+1 instead of COUNT(*)+1 to avoid
            // duplicate day_number values when two imports run concurrently
            $cntStmt = $pdo->prepare("SELECT COALESCE(MAX(day_number), 0) FROM program_imports WHERE workshop_id = ?");
            $cntStmt->execute([$workshopId]);
            $dayNumber = (int)$cntStmt->fetchColumn() + 1;
        }

        // Only insert if not already linked (re-save guard)
        $dupStmt = $pdo->prepare("SELECT id FROM program_imports WHERE workshop_id = ? AND program_id = ?");
        $dupStmt->execute([$workshopId, $programId]);
        if (!$dupStmt->fetch()) {
            $pdo->prepare("
                INSERT INTO program_imports (workshop_id, program_id, day_label, day_number)
                VALUES (?, ?, ?, ?)
            ")->execute([$workshopId, $programId, $dayLabel, $dayNumber]);
        }
    }
    // NOW includes: sex, participant_type, designation, school_office, email
    $rStmt = $pdo->prepare("
        INSERT INTO respondents
            (program_id, day_sheet, respondent_name,
             sex, participant_type, designation, school_office, email,
             average_score, result_label)
        VALUES
            (:pid, :day, :name,
             :sex, :participant_type, :designation, :school_office, :email,
             :avg, :result)
    ");
    $sStmt = $pdo->prepare("
        INSERT INTO respondent_scores
            (respondent_id, question_header, score, category_name, category_id)
        VALUES (:rid, :qh, :sc, :cat_name, :cat_id)
    ");
    $fStmt = $hasFeedbackLabelCol
        ? $pdo->prepare("
            INSERT INTO respondent_feedback
                (respondent_id, feedback_label, feedback_value)
            VALUES (:rid, :label, :val)
        ")
        : $pdo->prepare("
            INSERT INTO respondent_feedback
                (respondent_id, feedback_value)
            VALUES (:rid, :val)
        ");

    foreach ($respondents as $r) {
        // ── Full name ─────────────────────────────────────────────────────────
        $respondentName = trim($r['fullname'] ?? $r['name'] ?? '');
        if ($respondentName === '' || strtolower($respondentName) === 'anonymous') {
            $respondentName = 'Unknown';
        }

        // ── Demographic fields sent by the JS importer ────────────────────────
        $sex             = normaliseSex($r['sex'] ?? null);
        $participantType = trim($r['participant_type'] ?? $r['participantType'] ?? '') ?: null;
        $designation     = trim($r['designation'] ?? '') ?: null;
        $schoolOffice    = trim($r['school'] ?? $r['school_office'] ?? '') ?: null;
        // Discard MS-Forms placeholder values ('anonymous', 'n/a', etc.) so the
        // email column is only populated with real participant email addresses.
        $emailRaw        = trim($r['email'] ?? '');
        // BUG 17 FIX: use shared $PLACEHOLDER_EMAILS variable instead of re-defining
        $email           = ($emailRaw !== '' && !in_array(strtolower($emailRaw), $PLACEHOLDER_EMAILS, true))
                           ? $emailRaw : null;

        $rStmt->execute([
            ':pid'              => $programId,
            ':day'              => $r['day'] ?? null,
            ':name'             => $respondentName,
            ':sex'              => $sex,
            ':participant_type' => $participantType,
            ':designation'      => $designation,
            ':school_office'    => $schoolOffice,
            ':email'            => $email,
            ':avg'              => $r['average'] ?? 0,
            ':result'           => $r['result'] ?? '',
        ]);
        $respondentId = (int)$pdo->lastInsertId();

        // ── Scores ────────────────────────────────────────────────────────────
        $scores = $r['scores'] ?? [];
        foreach ($scores as $qi => $score) {
            $catName = $qCategoryMap[$qi] ?? null;
            $sStmt->execute([
                ':rid'      => $respondentId,
                ':qh'       => $qHeaders[$qi] ?? ('Q' . ($qi + 1)),
                ':sc'       => is_numeric($score) ? (float)$score : null,
                ':cat_name' => $catName,
                // Resolved via the same normalized matching used by the
                // importer's dedup guard and the backfill script, so
                // "Program Management & Operations" and "...and Operations"
                // both land on the same category_id regardless of which
                // spelling this particular import's header used.
                ':cat_id'   => resolveCategoryId($pdo, $catName),
            ]);
        }

        // ── Open-ended feedback ───────────────────────────────────────────────
        $feedback = $r['feedback'] ?? [];
        foreach ($feedback as $fbLabel => $fbVal) {
                $fbVal = preg_replace('/\s+/', ' ', trim((string)$fbVal));

                // Skip empty / placeholder / noise values so we don't store fake "N/A" feedback
                if ($fbVal === '') continue;
                if (preg_match('/^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i', $fbVal)) continue;
                if (preg_match('/^\d+(\.\d+)?$/', $fbVal)) continue;
                if (preg_match('/^[^a-zA-Z0-9]+$/', $fbVal)) continue;

            // $fbLabel is the actual Excel column header text
            $label = (is_string($fbLabel) && trim($fbLabel) !== '') ? $fbLabel : null;
            if ($hasFeedbackLabelCol) {
                $fStmt->execute([':rid' => $respondentId, ':label' => $label, ':val' => $fbVal]);
            } else {
                $fStmt->execute([':rid' => $respondentId, ':val' => $fbVal]);
            }
        }
    }

    // ── 4. speaker_averages + speaker_criteria ────────────────────────────────
    $spStmt = $pdo->prepare("
        INSERT INTO speaker_averages
            (program_id, day_sheet, slot_number, speaker_name, overall_avg, result_label)
        VALUES (:pid, :day, :slot, :name, :avg, :res)
    ");
    $crStmt = $pdo->prepare("
        INSERT INTO speaker_criteria
            (speaker_avg_id, criterion_label, average_score)
        VALUES (:sid, :label, :avg)
    ");

    foreach ($days as $day) {
        $dayName = $day['day'] ?? 'Unknown';
        foreach (($day['speakers'] ?? []) as $sp) {
            $spStmt->execute([
                ':pid'  => $programId,
                ':day'  => $dayName,
                ':slot' => $sp['slot_number'] ?? $sp['slot'] ?? null,
                ':name' => $sp['speaker_name'] ?? $sp['name'] ?? null,
                ':avg'  => $sp['overall_avg'] ?? $sp['overall'] ?? 0,
                ':res'  => $sp['result_label'] ?? $sp['result'] ?? '',
            ]);
            $speakerId = (int)$pdo->lastInsertId();

            foreach (($sp['criteriaAvgs'] ?? []) as $cr) {
                $crStmt->execute([
                    ':sid'   => $speakerId,
                    ':label' => $cr['label'],
                    ':avg'   => is_numeric($cr['average_score'] ?? $cr['avg'] ?? null)
                                ? (float)($cr['average_score'] ?? $cr['avg'])
                                : null,
                ]);
            }
        }
    }

    // ── 4b. Insert unique participants into workshop_participants ─────────────
    // This populates the certificates page with participants + emails
    if ($workshopId) {
        $wpStmt = $pdo->prepare("
            INSERT INTO workshop_participants
                (workshop_id, response_id, full_name, sex, participant_type,
                 designation, school_office, email, attendance_status, registered_at)
            VALUES
                (:wid, :rid, :name, :sex, :ptype,
                 :desig, :school, :email, 'attended', NOW())
        ");

        // Track unique participants by a composite key (name + designation + school)
        // to avoid both cross-day duplicates and false-positives for people
        // who share the same name but work at different schools/offices.
        $seenParticipants = [];
        foreach ($respondents as $r) {
            $respName = trim($r['fullname'] ?? $r['name'] ?? '');
            if ($respName === '' || strtolower($respName) === 'anonymous' || strtolower($respName) === 'unknown') {
                continue;
            }

            // FIX #3: Composite key — name + designation + school_office
            $designation  = trim($r['designation'] ?? '');
            $schoolOffice = trim($r['school'] ?? $r['school_office'] ?? '');
            $nameKey = strtolower($respName . '||' . $designation . '||' . $schoolOffice);

            if (isset($seenParticipants[$nameKey])) {
                continue; // Skip cross-day duplicate of the same person
            }
            $seenParticipants[$nameKey] = true;

            $sex = normaliseSex($r['sex'] ?? null);
            // workshop_participants.sex — allow NULL and 'Other'.
            // Schema should be: ENUM('Male','Female','Other') NULL
            // Run once if not already done:
            //   ALTER TABLE workshop_participants
            //     MODIFY sex ENUM('Male','Female','Other') NULL;
            if (!in_array($sex, ['Male', 'Female', 'Other'], true)) {
                $sex = null; // unknown/blank → store NULL, not a fabricated value
            }

            $wpStmt->execute([
                ':wid'    => $workshopId,
                ':rid'    => null, // No response_id for Excel imports
                ':name'   => $respName,
                ':sex'    => $sex,
                ':ptype'  => trim($r['participant_type'] ?? $r['participantType'] ?? '') ?: null,
                ':desig'  => trim($r['designation'] ?? '') ?: null,
                ':school' => trim($r['school'] ?? $r['school_office'] ?? '') ?: null,
                ':email'  => (($re = trim($r['email'] ?? '')) !== '' && !in_array(strtolower($re), $PLACEHOLDER_EMAILS, true)) ? $re : null,
            ]);
        }
    }

    // ── 5. Compute aggregates inside the transaction, then commit ─────────────
    // BUG 16 FIX: aggregate inserts moved BEFORE commit so a failure here can
    // still be rolled back, preventing partially-written records on the dashboard
    insertCategoryAverages($pdo, $programId);
    insertColumnAverages($pdo, $programId);

    $pdo->commit();

    echo json_encode([
        'success'    => true,
        'program_id' => $programId,
        'message'    => 'Evaluation saved successfully.',
        'stats'      => [
            'respondents_saved' => $totalResponses,
            'days_saved'        => $dayCount,
            'overall_average'   => $overallAvg,
            'overall_result'    => $overallResult,
            'pct_responses'     => $pctResponses,
        ],
    ]);

} catch (PDOException $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error: ' . $e->getMessage()]);
} catch (Exception $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>