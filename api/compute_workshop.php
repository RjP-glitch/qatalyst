<?php
/**
 * compute_workshop.php
 *
 * Reads online evaluation submissions for a workshop and writes computed results
 * into the shared result tables (evaluation_programs, respondents, respondent_scores,
 * respondent_feedback, category_averages, column_averages, speaker_averages,
 * speaker_criteria) — the same tables that Excel imports produce.
 *
 * POST  { workshop_id: int }
 * Returns { success, program_id, stats }
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);

// SECURITY: Secure CORS and authentication
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for data computation
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized. Please log in.']);
    exit;
}

// Require 'programs' permission to compute workshop data
requirePermission('programs', $authUser);

// ── Rating helpers (same as save.php) ─────────────────────────────────────────
function getResultLabel(float $avg, string $type = 'category'): string {
    $scales = [
        'category' => [
            ['min' => 3.26, 'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'desc' => 'Satisfactory'],
            ['min' => 1.76, 'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'desc' => 'Very Unsatisfactory'],
        ],
        'speaker' => [
            ['min' => 3.26, 'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'desc' => 'Satisfactory'],
            ['min' => 1.76, 'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'desc' => 'Very Unsatisfactory'],
        ],
        'overall' => [
            ['min' => 3.26, 'desc' => 'Very Satisfactory'],
            ['min' => 2.51, 'desc' => 'Satisfactory'],
            ['min' => 1.76, 'desc' => 'Unsatisfactory'],
            ['min' => 1.00, 'desc' => 'Very Unsatisfactory'],
        ],
    ];
    $typeScales = $scales[$type] ?? $scales['category'];
    foreach ($typeScales as $scale) {
        if ($avg >= $scale['min']) return $scale['desc'];
    }
    return 'Very Unsatisfactory';
}

function normaliseSex(?string $raw): ?string {
    if ($raw === null) return null;
    $v = strtolower(trim($raw));
    if (in_array($v, ['male', 'm'])) return 'Male';
    if (in_array($v, ['female', 'f'])) return 'Female';
    return 'Other';
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        throw new Exception('Method not allowed');
    }

    $body = json_decode(file_get_contents('php://input'), true);
    if (!$body) throw new Exception('Invalid JSON payload.');

    $workshopId = intval($body['workshop_id'] ?? 0);
    if (!$workshopId) throw new Exception('workshop_id is required.');

    $pdo = getDB();

    // ── 1. Load workshop info ─────────────────────────────────────────────────
    $stmt = $pdo->prepare("SELECT * FROM workshops WHERE id = ?");
    $stmt->execute([$workshopId]);
    $workshop = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$workshop) throw new Exception('Workshop not found.');

    // ── 2. Load workshop days ─────────────────────────────────────────────────
    $stmt = $pdo->prepare("
        SELECT id, day_number, day_date, title
        FROM workshop_days WHERE workshop_id = ? ORDER BY day_number
    ");
    $stmt->execute([$workshopId]);
    $workshopDays = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (empty($workshopDays)) throw new Exception('No workshop days found.');

    // ── 3. Load question categories ───────────────────────────────────────────
    $catRows = $pdo->query("
        SELECT id, name FROM evaluation_question_categories WHERE is_active = 1 ORDER BY display_order
    ")->fetchAll(PDO::FETCH_ASSOC);
    $catIdToName = [];
    foreach ($catRows as $c) $catIdToName[(int)$c['id']] = $c['name'];

    // ── 4. Load questions that were ACTUALLY answered for this workshop ────────
    // Instead of guessing which question set was used (global vs workshop-specific),
    // we look at which question_ids actually appear in the answers.
    $stmt = $pdo->prepare("
        SELECT DISTINCT ea.question_id
        FROM evaluation_answers ea
        JOIN evaluation_submissions es ON ea.submission_id = es.id
        JOIN workshop_days wd ON es.workshop_day_id = wd.id
        WHERE wd.workshop_id = ?
    ");
    $stmt->execute([$workshopId]);
    $answeredQids = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // Also get speaker question IDs
    $stmt = $pdo->prepare("
        SELECT DISTINCT esa.question_id
        FROM evaluation_speaker_answers esa
        JOIN evaluation_submissions es ON esa.submission_id = es.id
        JOIN workshop_days wd ON es.workshop_day_id = wd.id
        WHERE wd.workshop_id = ?
    ");
    $stmt->execute([$workshopId]);
    $answeredSpQids = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $allNeededQids = array_unique(array_merge($answeredQids, $answeredSpQids));

    $questions = [];
    if (!empty($allNeededQids)) {
        $ph = implode(',', array_fill(0, count($allNeededQids), '?'));
        $stmt = $pdo->prepare("
            SELECT q.id, q.category_id, q.question_text, q.question_type,
                   q.is_for_speaker, q.display_order
            FROM evaluation_questions q
            WHERE q.id IN ($ph)
            ORDER BY q.category_id, q.display_order
        ");
        $stmt->execute($allNeededQids);
        $questions = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    // Build lookup maps
    $ratingQuestions  = [];  // id => {category_id, question_text, display_order}
    $speakerQuestions = [];  // id => {question_text, display_order}
    $textQuestions    = [];  // id => {question_text, category_id}

    foreach ($questions as $q) {
        $qid = (int)$q['id'];
        if ((int)$q['is_for_speaker'] === 1) {
            $speakerQuestions[$qid] = $q;
        } elseif ($q['question_type'] === 'rating') {
            $ratingQuestions[$qid] = $q;
        } else {
            $textQuestions[$qid] = $q;
        }
    }

    // ── 5. Check for existing program record and delete if re-computing ───────
    $stmt = $pdo->prepare("
        SELECT id FROM evaluation_programs
        WHERE workshop_id = ? AND source_type = 'online'
    ");
    $stmt->execute([$workshopId]);
    $existingProgram = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($existingProgram) {
        $oldPid = (int)$existingProgram['id'];
        // Delete in correct order to respect FK relationships using prepared statements
        // SECURITY FIX: Use parameterized queries instead of string interpolation
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
        $pdo->prepare("DELETE FROM evaluation_programs WHERE id = ?")->execute([$oldPid]);
    }

    // ── 6. Process each workshop day ──────────────────────────────────────────
    $pdo->beginTransaction();

    $allRespondents   = [];
    $allCategoryScores= []; // catName => [scores]
    $allSpeakerData   = []; // dayLabel => [{slot, name, criteriaScores}]
    $totalSubmissions  = 0;

    foreach ($workshopDays as $day) {
        $dayId    = (int)$day['id'];
        $dayLabel = 'Day ' . $day['day_number'];

        // Load submissions for this day
        $stmt = $pdo->prepare("
            SELECT es.id AS submission_id, es.participant_id, es.submitted_at,
                   wp.full_name, wp.sex, wp.participant_type, wp.designation,
                   wp.school_office, wp.email
            FROM evaluation_submissions es
            JOIN workshop_participants wp ON es.participant_id = wp.id
            WHERE es.workshop_day_id = ?
        ");
        $stmt->execute([$dayId]);
        $submissions = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if (empty($submissions)) continue;

        $submissionIds = array_column($submissions, 'submission_id');
        $totalSubmissions += count($submissions);
        $ph = implode(',', array_fill(0, count($submissionIds), '?'));

        // Load all rating answers for these submissions
        $aStmt = $pdo->prepare("
            SELECT submission_id, question_id, rating_value, text_value, select_value
            FROM evaluation_answers WHERE submission_id IN ($ph)
        ");
        $aStmt->execute($submissionIds);
        $allAnswers = $aStmt->fetchAll(PDO::FETCH_ASSOC);

        // Group: [submission_id][question_id] => answer
        $answersBySubmission = [];
        foreach ($allAnswers as $a) {
            $answersBySubmission[$a['submission_id']][$a['question_id']] = $a;
        }

        // Load speaker answers
        $spStmt = $pdo->prepare("
            SELECT esa.submission_id, esa.resource_speaker_id, esa.question_id, esa.rating_value,
                   rs.speaker_number, rs.name AS speaker_name
            FROM evaluation_speaker_answers esa
            JOIN resource_speakers rs ON esa.resource_speaker_id = rs.id
            WHERE esa.submission_id IN ($ph)
        ");
        $spStmt->execute($submissionIds);
        $spAnswers = $spStmt->fetchAll(PDO::FETCH_ASSOC);

        // Group: [submission_id][speaker_number][question_id] => rating_value
        $speakerBySubmission = []; // also: [speaker_number] => speaker_name
        $speakerNames = [];
        foreach ($spAnswers as $sa) {
            $speakerBySubmission[$sa['submission_id']][$sa['speaker_number']][$sa['question_id']] = (int)$sa['rating_value'];
            $speakerNames[(int)$sa['speaker_number']] = $sa['speaker_name'];
        }

        // For each submission → build respondent + scores
        foreach ($submissions as $sub) {
            $sid     = $sub['submission_id'];
            $answers = $answersBySubmission[$sid] ?? [];

            // Build scores per question (rating questions only)
            $scores       = [];
            $catScoreAccum = []; // catName => [scores]
            $allRatings   = [];

            foreach ($ratingQuestions as $qid => $q) {
                $catName = $catIdToName[(int)$q['category_id']] ?? null;
                $rating  = isset($answers[$qid]) ? (int)$answers[$qid]['rating_value'] : null;

                $scores[] = [
                    'question_text' => $q['question_text'],
                    'category_name' => $catName,
                    'score'         => $rating,
                ];

                if ($rating !== null && $catName !== null) {
                    $catScoreAccum[$catName][] = $rating;
                    $allRatings[] = $rating;
                    // Global aggregation
                    $allCategoryScores[$catName][] = ['day' => $dayLabel, 'question' => $q['question_text'], 'score' => $rating];
                }
            }

            // Speaker scores counted into respondent average
            foreach (($speakerBySubmission[$sid] ?? []) as $spNum => $spQAnswers) {
                foreach ($spQAnswers as $qid => $ratingVal) {
                    $qText = $speakerQuestions[$qid]['question_text'] ?? ('Speaker Q' . $qid);
                    $scores[] = [
                        'question_text' => $qText . ' (Speaker ' . $spNum . ')',
                        'category_name' => null, // speaker scores have no category
                        'score'         => $ratingVal,
                    ];
                    $allRatings[] = $ratingVal;
                }
            }

            // Feedback (text/select answers)
            $feedback = [];
            foreach ($textQuestions as $qid => $q) {
                $val = $answers[$qid]['text_value'] ?? $answers[$qid]['select_value'] ?? null;
                if ($val !== null && trim($val) !== '') {
                    // Map question text to feedback key
                    $fbKey = 'feedback';
                    $lower = strtolower($q['question_text']);
                    if (strpos($lower, 'expectation') !== false) $fbKey = 'expectations';
                    elseif (strpos($lower, 'improve') !== false) $fbKey = 'improvements';
                    elseif (strpos($lower, 'insight') !== false) $fbKey = 'insights';
                    elseif (strpos($lower, 'further') !== false || strpos($lower, 'additional') !== false) $fbKey = 'further';
                    $feedback[$fbKey] = trim($val);
                }
            }

            $avgScore = count($allRatings) > 0
                ? round(array_sum($allRatings) / count($allRatings), 2)
                : 0;

            $allRespondents[] = [
                'day'              => $dayLabel,
                'name'             => $sub['full_name'] ?? 'Unknown',
                'sex'              => normaliseSex($sub['sex'] ?? null),
                'participant_type' => $sub['participant_type'] ?? null,
                'designation'      => $sub['designation'] ?? null,
                'school_office'    => $sub['school_office'] ?? null,
                'email'            => $sub['email'] ?? null,
                'average'          => $avgScore,
                'result'           => getResultLabel($avgScore, 'overall'),
                'scores'           => $scores,
                'feedback'         => $feedback,
            ];
        }

        // ── Speaker aggregation for this day ──────────────────────────────────
        // Collect all speaker ratings across submissions for this day
        $daySpeakerScores = []; // [speaker_number][question_id] => [ratings]
        foreach ($submissions as $sub) {
            $sid = $sub['submission_id'];
            foreach (($speakerBySubmission[$sid] ?? []) as $spNum => $spQAnswers) {
                foreach ($spQAnswers as $qid => $ratingVal) {
                    $daySpeakerScores[$spNum][$qid][] = $ratingVal;
                }
            }
        }

        $daySpeakers = [];
        foreach ($daySpeakerScores as $spNum => $qScores) {
            $criteriaAvgs = [];
            $allVals      = [];
            foreach ($qScores as $qid => $ratings) {
                $avg = round(array_sum($ratings) / count($ratings), 2);
                $criteriaAvgs[] = [
                    'label' => $speakerQuestions[$qid]['question_text'] ?? 'Criterion',
                    'avg'   => $avg,
                ];
                $allVals = array_merge($allVals, $ratings);
            }
            $overall = count($allVals) > 0 ? round(array_sum($allVals) / count($allVals), 2) : null;
            if ($overall !== null) {
                $daySpeakers[] = [
                    'slot'         => $spNum,
                    'name'         => $speakerNames[$spNum] ?? ('Speaker ' . $spNum),
                    'overall'      => $overall,
                    'result'       => getResultLabel($overall, 'speaker'),
                    'criteriaAvgs' => $criteriaAvgs,
                ];
            }
        }

        $allSpeakerData[$dayLabel] = $daySpeakers;
    }

    if (empty($allRespondents)) {
        $pdo->rollBack();
        throw new Exception('No evaluation responses found for this workshop.');
    }

    // ── 7. Compute overall statistics ─────────────────────────────────────────
    $uniqueNames = [];
    foreach ($allRespondents as $r) {
        $key = strtolower(trim($r['name']));
        if ($key !== '' && $key !== 'unknown') $uniqueNames[$key] = true;
    }
    $totalResponses    = count($uniqueNames) ?: count($allRespondents);
    $dayCount          = count($workshopDays);
    $totalParticipants = (int)($workshop['total_participants'] ?? $totalResponses);
    $avgResponses      = $dayCount > 0 ? round($totalResponses / $dayCount, 2) : $totalResponses;
    $pctResponses      = $totalParticipants > 0 ? round(($totalResponses / $totalParticipants) * 100, 2) : 0;

    $allAvgs    = array_column($allRespondents, 'average');
    $overallAvg = count($allAvgs) > 0 ? round(array_sum($allAvgs) / count($allAvgs), 2) : 0;
    $overallResult = getResultLabel($overallAvg, 'overall');

    // Format dates
    $inclusiveDates = '';
    if ($workshop['start_date'] === $workshop['end_date']) {
        $inclusiveDates = date('F j, Y', strtotime($workshop['start_date']));
    } else {
        $inclusiveDates = date('F j', strtotime($workshop['start_date'])) . ' - ' . date('j, Y', strtotime($workshop['end_date']));
    }

    // ── 8. Insert evaluation_programs ─────────────────────────────────────────
    $stmt = $pdo->prepare("
        INSERT INTO evaluation_programs
            (workshop_id, source_type, title, proponents, training_venue,
             inclusive_dates, qame_associates, total_participants,
             total_responses, avg_responses, pct_responses,
             overall_average, overall_result, detected_scale,
             source_filename, settings_snapshot)
        VALUES
            (:wid, 'online', :title, :proponents, :venue,
             :dates, :qame, :total_p,
             :total_r, :avg_r, :pct_r,
             :ov_avg, :ov_res, 4,
             :filename, NULL)
    ");
    $stmt->execute([
        ':wid'        => $workshopId,
        ':title'      => $workshop['title'],
        ':proponents' => $workshop['proponents'] ?? 'N/A',
        ':venue'      => $workshop['venue'] ?? '',
        ':dates'      => $inclusiveDates,
        ':qame'       => '',
        ':total_p'    => $totalParticipants,
        ':total_r'    => $totalResponses,
        ':avg_r'      => $avgResponses,
        ':pct_r'      => $pctResponses,
        ':ov_avg'     => $overallAvg,
        ':ov_res'     => $overallResult,
        ':filename'   => 'Online Evaluation',
    ]);
    $programId = (int)$pdo->lastInsertId();

    // Detect optional schema support (older DBs may not have this column yet)
    $hasFeedbackLabelCol = false;
    try {
        $colStmt = $pdo->prepare("SHOW COLUMNS FROM respondent_feedback LIKE 'feedback_label'");
        $colStmt->execute();
        $hasFeedbackLabelCol = (bool)$colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $_) {
        $hasFeedbackLabelCol = false;
    }

    // ── 9. Insert respondents + respondent_scores + respondent_feedback ────────
    $rStmt = $pdo->prepare("
        INSERT INTO respondents
            (program_id, day_sheet, respondent_name,
             sex, participant_type, designation, school_office, email,
             average_score, result_label)
        VALUES (:pid, :day, :name,
                :sex, :ptype, :desig, :school, :email,
                :avg, :result)
    ");
    $sStmt = $pdo->prepare("
        INSERT INTO respondent_scores
            (respondent_id, question_header, score, category_name)
        VALUES (:rid, :qh, :sc, :cat)
    ");
    $fStmt = $hasFeedbackLabelCol
        ? $pdo->prepare("
            INSERT INTO respondent_feedback
                (respondent_id, feedback_key, feedback_label, feedback_value)
            VALUES (:rid, :key, :label, :val)
        ")
        : $pdo->prepare("
            INSERT INTO respondent_feedback
                (respondent_id, feedback_key, feedback_value)
            VALUES (:rid, :key, :val)
        ");

    foreach ($allRespondents as $r) {
        $rStmt->execute([
            ':pid'    => $programId,
            ':day'    => $r['day'],
            ':name'   => $r['name'],
            ':sex'    => $r['sex'],
            ':ptype'  => $r['participant_type'],
            ':desig'  => $r['designation'],
            ':school' => $r['school_office'],
            ':email'  => $r['email'],
            ':avg'    => $r['average'],
            ':result' => $r['result'],
        ]);
        $respondentId = (int)$pdo->lastInsertId();

        foreach ($r['scores'] as $sc) {
            $sStmt->execute([
                ':rid' => $respondentId,
                ':qh'  => $sc['question_text'],
                ':sc'  => $sc['score'],
                ':cat' => $sc['category_name'],
            ]);
        }

        foreach ($r['feedback'] as $fbKey => $fbVal) {
            $fbVal = preg_replace('/\s+/', ' ', trim((string)$fbVal));

            // Skip empty / placeholder / noise values so we don't store fake "N/A" feedback
            if ($fbVal === '') continue;
            if (preg_match('/^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i', $fbVal)) continue;
            if (preg_match('/^\d+(\.\d+)?$/', $fbVal)) continue;
            if (preg_match('/^[^a-zA-Z0-9]+$/', $fbVal)) continue;

            if ($hasFeedbackLabelCol) {
                $fStmt->execute([':rid' => $respondentId, ':key' => $fbKey, ':label' => null, ':val' => $fbVal]);
            } else {
                $fStmt->execute([':rid' => $respondentId, ':key' => $fbKey, ':val' => $fbVal]);
            }
        }
    }

    // ── 10. Insert speaker_averages + speaker_criteria ────────────────────────
    $spStmt = $pdo->prepare("
        INSERT INTO speaker_averages
            (program_id, day_sheet, slot_number, speaker_name, overall_avg, result_label)
        VALUES (:pid, :day, :slot, :name, :avg, :res)
    ");
    $crStmt = $pdo->prepare("
        INSERT INTO speaker_criteria (speaker_avg_id, criterion_label, average_score)
        VALUES (:sid, :label, :avg)
    ");

    foreach ($allSpeakerData as $dayLabel => $speakers) {
        foreach ($speakers as $sp) {
            $spStmt->execute([
                ':pid'  => $programId,
                ':day'  => $dayLabel,
                ':slot' => $sp['slot'],
                ':name' => $sp['name'],
                ':avg'  => $sp['overall'],
                ':res'  => $sp['result'],
            ]);
            $speakerAvgId = (int)$pdo->lastInsertId();

            foreach ($sp['criteriaAvgs'] as $cr) {
                $crStmt->execute([
                    ':sid'   => $speakerAvgId,
                    ':label' => $cr['label'],
                    ':avg'   => $cr['avg'],
                ]);
            }
        }
    }

    $pdo->commit();

    // ── 11. Compute aggregate tables (same as save.php) ───────────────────────
    insertCategoryAverages($pdo, $programId);
    insertColumnAverages($pdo, $programId);

    echo json_encode([
        'success'    => true,
        'program_id' => $programId,
        'message'    => "Workshop responses computed successfully.",
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

// ── Aggregate helper functions (identical to save.php) ────────────────────────
function insertCategoryAverages(PDO $pdo, int $programId): void {
    $rows = $pdo->prepare("
        SELECT r.day_sheet, rs.category_name,
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
        SELECT rs.category_name, AVG(rs.score) AS avg_score, COUNT(rs.score) AS n
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
            (program_id, day_sheet, category_name, average_score, result_label, is_overall)
        VALUES (:pid, :day, :cat, :avg, :res, :ov)
    ");
    foreach ($perDay as $row) {
        $avg = round((float)$row['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => $row['day_sheet'],
            ':cat' => $row['category_name'], ':avg' => $avg,
            ':res' => getResultLabel($avg), ':ov' => 0]);
    }
    foreach ($overall as $row) {
        $avg = round((float)$row['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => null,
            ':cat' => $row['category_name'], ':avg' => $avg,
            ':res' => getResultLabel($avg), ':ov' => 1]);
    }
}

function insertColumnAverages(PDO $pdo, int $programId): void {
    $rows = $pdo->prepare("
        SELECT r.day_sheet, rs.category_name, rs.question_header,
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
            (program_id, day_sheet, category_name, question_header, average_score, n_responses)
        VALUES (:pid, :day, :cat, :qh, :avg, :n)
    ");
    foreach ($cols as $col) {
        $avg = round((float)$col['avg_score'], 2);
        $ins->execute([':pid' => $programId, ':day' => $col['day_sheet'],
            ':cat' => $col['category_name'],
            ':qh'  => trim($col['question_header'] ?? ''),
            ':avg' => $avg, ':n' => (int)$col['n']]);
    }
}
?>