<?php
// ============================================================
//  evaluation.php  —  Public evaluation form API (no auth)
//  GET  ?program_id=X  →  returns program + days + categories
//                          + questions + speakers
//  POST (JSON body)    →  saves participant + submission +
//                          answers + speaker_answers
// ============================================================

$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

require_once $base_path . '/config/database.php';
require_once $base_path . '/config/audit_log.php';

$pdo = getDB();
if (!$pdo || !($pdo instanceof PDO)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database connection failed']);
    exit();
}

// ─── Route ────────────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    handleGet($pdo);
} elseif ($method === 'POST') {
    handlePost($pdo);
} else {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}

// ══════════════════════════════════════════════════════════════════════════════
//  GET  ?program_id=X
//  Returns everything the evaluation form needs to render itself:
//    data.title, data.division_memo, data.venue, data.start_date, data.end_date
//    data.status, data.effective_status, data.is_submittable
//    data.days[]          — workshop days with nested speakers[]
//    data.categories[]    — active question categories
//    data.questions{}     — questions keyed by category_id
// ══════════════════════════════════════════════════════════════════════════════
function handleGet(PDO $pdo): void
{
    $program_id = isset($_GET['program_id']) ? intval($_GET['program_id']) : 0;

    if (!$program_id) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing program_id']);
        exit();
    }

    // ── 1. Load workshop ──────────────────────────────────────────────────────
    $stmt = $pdo->prepare("
        SELECT id, title, division_memo, description,
               venue, start_date, end_date, status
        FROM workshops
        WHERE id = ?
        LIMIT 1
    ");
    $stmt->execute([$program_id]);
    $workshop = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$workshop) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Program not found']);
        exit();
    }

    // ── 2. Compute effective status & submittability ──────────────────────────
    $today  = date('Y-m-d');
    $status = $workshop['status'];

    // Derive effective_status from dates when status is 'upcoming' or 'ongoing'
    if ($status === 'upcoming' && $workshop['start_date'] <= $today) {
        $effective_status = 'ongoing';
    } elseif ($status === 'ongoing' && $workshop['end_date'] < $today) {
        $effective_status = 'completed';
    } else {
        $effective_status = $status;
    }

    // Form is open only while the workshop is ongoing
    $is_submittable = ($effective_status === 'ongoing');

    // ── 3. Load workshop days with speakers ───────────────────────────────────
    $dStmt = $pdo->prepare("
        SELECT id, day_number, day_date AS date, title, description
        FROM workshop_days
        WHERE workshop_id = ?
        ORDER BY day_number ASC
    ");
    $dStmt->execute([$program_id]);
    $days = $dStmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($days as &$day) {
        // Cast types
        $day['id']         = (int)$day['id'];
        $day['day_number'] = (int)$day['day_number'];

        // Load resource speakers for this day
        $spStmt = $pdo->prepare("
            SELECT id, speaker_number, name, designation, organization, topic
            FROM resource_speakers
            WHERE workshop_day_id = ?
            ORDER BY speaker_number ASC
        ");
        $spStmt->execute([$day['id']]);
        $day['speakers'] = $spStmt->fetchAll(PDO::FETCH_ASSOC);

        // Cast speaker ids
        foreach ($day['speakers'] as &$sp) {
            $sp['id']             = (int)$sp['id'];
            $sp['speaker_number'] = (int)$sp['speaker_number'];
        }
        unset($sp);
    }
    unset($day);

    // ── 4. Load active question categories ────────────────────────────────────
    $catStmt = $pdo->prepare("
        SELECT id, name, description, display_order
        FROM evaluation_question_categories
        WHERE is_active = 1
        ORDER BY display_order ASC
    ");
    $catStmt->execute();
    $categories = $catStmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($categories as &$cat) {
        $cat['id']            = (int)$cat['id'];
        $cat['display_order'] = (int)$cat['display_order'];
    }
    unset($cat);

    // ── 5. Load active questions scoped to this workshop ─────────────────────
    //  Pulls questions where workshop_id = X  OR  workshop_id = 0 (global).
    //  Per-workshop questions take precedence: if a workshop has its own set
    //  for a given category, global ones are excluded for that category.
    //
    //  Strategy:
    //   a) Find which category_ids have workshop-specific questions for this workshop.
    //   b) For those categories → return only workshop-specific questions.
    //   c) For all other categories → return global (workshop_id = 0) questions.

    // a) Categories that have workshop-specific questions
    $wsqStmt = $pdo->prepare("
        SELECT DISTINCT category_id
        FROM evaluation_questions
        WHERE workshop_id = ? AND is_active = 1
    ");
    $wsqStmt->execute([$program_id]);
    $workshopSpecificCats = $wsqStmt->fetchAll(PDO::FETCH_COLUMN);

    // b+c) Build the questions query
    if (!empty($workshopSpecificCats)) {
        $ph = implode(',', array_fill(0, count($workshopSpecificCats), '?'));

        $qStmt = $pdo->prepare("
            SELECT id, category_id, question_text, question_type,
                   rating_min, rating_max, select_options,
                   is_for_speaker, is_required, display_order
            FROM evaluation_questions
            WHERE is_active = 1
              AND (
                  (workshop_id = ? AND category_id IN ($ph))
                  OR
                  (workshop_id = 0 AND category_id NOT IN ($ph))
              )
            ORDER BY category_id ASC, display_order ASC
        ");
        // params: program_id, ...workshopSpecificCats (for IN), ...workshopSpecificCats (for NOT IN)
        $params = array_merge([$program_id], $workshopSpecificCats, $workshopSpecificCats);
        $qStmt->execute($params);
    } else {
        // No workshop-specific questions — use all globals
        $qStmt = $pdo->prepare("
            SELECT id, category_id, question_text, question_type,
                   rating_min, rating_max, select_options,
                   is_for_speaker, is_required, display_order
            FROM evaluation_questions
            WHERE is_active = 1 AND workshop_id = 0
            ORDER BY category_id ASC, display_order ASC
        ");
        $qStmt->execute();
    }

    $allQuestions = $qStmt->fetchAll(PDO::FETCH_ASSOC);

    // Group by category_id, decode select_options JSON
    $questions = [];
    foreach ($allQuestions as $q) {
        $catId = (int)$q['category_id'];

        // Decode select_options if present
        if ($q['select_options']) {
            $decoded = json_decode($q['select_options'], true);
            $q['select_options'] = is_array($decoded) ? $decoded : [];
        } else {
            $q['select_options'] = [];
        }

        $q['id']            = (int)$q['id'];
        $q['category_id']   = $catId;
        $q['rating_min']    = (int)$q['rating_min'];
        $q['rating_max']    = (int)$q['rating_max'];
        $q['is_for_speaker'] = (bool)$q['is_for_speaker'];
        $q['is_required']    = (bool)$q['is_required'];
        $q['display_order']  = (int)$q['display_order'];

        $questions[$catId][] = $q;
    }

    // ── 6. Return ─────────────────────────────────────────────────────────────
    echo json_encode([
        'success' => true,
        'data'    => [
            'id'               => (int)$workshop['id'],
            'title'            => $workshop['title'],
            'division_memo'    => $workshop['division_memo'],
            'description'      => $workshop['description'],
            'venue'            => $workshop['venue'],
            'start_date'       => $workshop['start_date'],
            'end_date'         => $workshop['end_date'],
            'status'           => $status,
            'effective_status' => $effective_status,
            'is_submittable'   => $is_submittable,
            'days'             => $days,
            'categories'       => $categories,
            'questions'        => $questions,   // keyed by category_id (string)
        ],
    ]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  POST  (JSON body)
//  Expected body:
//  {
//    "program_id": 5,
//    "workshop_day_id": 12,
//    "participant": {
//      "first_name": "Juan",
//      "last_name": "Dela Cruz",
//      "email": "juan@example.com",
//      "phone": "",
//      "sex": "Male",
//      "age": 35,
//      "organization": "Malolos Elementary",
//      "position": "Teacher I"
//    },
//    "answers": [
//      { "question_id": 58, "rating_value": 4 },
//      { "question_id": 96, "text_value": "Very informative." }
//    ],
//    "speaker_answers": [
//      { "speaker_id": 3, "question_id": 133, "rating_value": 3 }
//    ]
//  }
// ══════════════════════════════════════════════════════════════════════════════
function handlePost(PDO $pdo): void
{
    // ── Parse JSON body ───────────────────────────────────────────────────────
    $body = file_get_contents('php://input');
    $data = json_decode($body, true);

    if (!$data) {
        auditLog([
            'pdo' => $pdo,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'failed',
            'description' => 'Submission failed: invalid JSON body',
        ]);
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid JSON body']);
        exit();
    }

    $program_id      = isset($data['program_id'])      ? intval($data['program_id'])      : 0;
    $workshop_day_id = isset($data['workshop_day_id']) ? intval($data['workshop_day_id']) : 0;
    $participant     = $data['participant']     ?? [];
    $answers         = $data['answers']         ?? [];
    $speaker_answers = $data['speaker_answers'] ?? [];

    // ── Validate required fields ──────────────────────────────────────────────
    if (!$program_id || !$workshop_day_id) {
        auditLog([
            'pdo' => $pdo,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'failed',
            'description' => 'Submission failed: missing program_id or workshop_day_id',
        ]);
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing program_id or workshop_day_id']);
        exit();
    }

    $first_name = trim($participant['first_name'] ?? '');
    $last_name  = trim($participant['last_name']  ?? '');
    $email      = trim($participant['email']      ?? '');
    $sex        = trim($participant['sex']        ?? '');

    if (!$first_name || !$last_name || !$email || !$sex) {
        auditLog([
            'pdo' => $pdo,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'failed',
            'description' => 'Submission failed: missing required participant fields',
        ]);
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing required participant fields (first_name, last_name, email, sex)']);
        exit();
    }

    // Validate sex against DB enum — default to 'Male' only as a last resort
    $validSex = ['Male', 'Female', 'Prefer not to say'];
    if (!in_array($sex, $validSex, true)) {
        $sex = 'Male';
    }

    // ── Verify the workshop_day belongs to the workshop ───────────────────────
    $dayCheck = $pdo->prepare("
        SELECT id FROM workshop_days WHERE id = ? AND workshop_id = ? LIMIT 1
    ");
    $dayCheck->execute([$workshop_day_id, $program_id]);
    if (!$dayCheck->fetch()) {
        auditLog([
            'pdo' => $pdo,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'failed',
            'description' => 'Submission failed: invalid workshop_day_id for workshop | program_id=' . $program_id . ' | workshop_day_id=' . $workshop_day_id,
        ]);
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid workshop_day_id for this program']);
        exit();
    }

    // ── Begin transaction ─────────────────────────────────────────────────────
    try {
        $pdo->beginTransaction();

        // 1. Upsert workshop_participant — reuse existing row if same email+workshop
        $full_name    = trim($first_name . ' ' . $last_name);
        $phone        = trim($participant['phone']        ?? '');
        $organization = trim($participant['organization'] ?? '');
        $position     = trim($participant['position']     ?? '');
        $age          = isset($participant['age']) && $participant['age'] !== null
                        ? intval($participant['age']) : null;

        // Check for existing participant with same email in this workshop
        $existingStmt = $pdo->prepare("
            SELECT id FROM workshop_participants
            WHERE workshop_id = ? AND email = ?
            ORDER BY CASE WHEN attendance_status = 'attended' THEN 0 ELSE 1 END
            LIMIT 1
        ");
        $existingStmt->execute([$program_id, $email]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);

        if ($existing) {
            // Reuse existing row — update info and mark attended
            $participant_id = (int)$existing['id'];
            $pdo->prepare("
                UPDATE workshop_participants
                SET full_name = ?, sex = ?, participant_type = ?,
                    designation = ?, school_office = ?,
                    attendance_status = 'attended'
                WHERE id = ?
            ")->execute([
                $full_name, $sex, $position,
                $position, $organization,
                $participant_id
            ]);
        } else {
            // New participant — insert fresh row
            $pStmt = $pdo->prepare("
                INSERT INTO workshop_participants
                    (workshop_id, full_name, sex, participant_type, designation, school_office, email, attendance_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'attended')
            ");
            $pStmt->execute([
                $program_id, $full_name, $sex,
                $position, $position, $organization, $email,
            ]);
            $participant_id = (int)$pdo->lastInsertId();
        }

        // 2. Insert evaluation_submission — skip if already submitted for this day
        $existingSubStmt = $pdo->prepare("
            SELECT id FROM evaluation_submissions
            WHERE workshop_day_id = ? AND participant_id = ?
            LIMIT 1
        ");
        $existingSubStmt->execute([$workshop_day_id, $participant_id]);
        $existingSub = $existingSubStmt->fetch(PDO::FETCH_ASSOC);

        if ($existingSub) {
            $submission_id = (int)$existingSub['id'];
            // Keep notification/order timestamps accurate on re-submission.
            $pdo->prepare("UPDATE evaluation_submissions SET submitted_at = NOW() WHERE id = ?")
                ->execute([$submission_id]);
            // Delete old answers so they get replaced with the new ones
            $pdo->prepare("DELETE FROM evaluation_answers WHERE submission_id = ?")
                ->execute([$submission_id]);
            $pdo->prepare("DELETE FROM evaluation_speaker_answers WHERE submission_id = ?")
                ->execute([$submission_id]);
        } else {
            $subStmt = $pdo->prepare("
                INSERT INTO evaluation_submissions (workshop_day_id, participant_id)
                VALUES (?, ?)
            ");
            $subStmt->execute([$workshop_day_id, $participant_id]);
            $submission_id = (int)$pdo->lastInsertId();
        }

        // 3. Update workshop_participant.response_id with the submission id
        $pdo->prepare("
            UPDATE workshop_participants SET response_id = ? WHERE id = ?
        ")->execute([$submission_id, $participant_id]);

        // 4. Insert evaluation_answers
        if (!empty($answers)) {
            $aStmt = $pdo->prepare("
                INSERT INTO evaluation_answers
                    (submission_id, question_id, rating_value, text_value, select_value)
                VALUES (?, ?, ?, ?, ?)
            ");
            foreach ($answers as $ans) {
                $question_id  = isset($ans['question_id'])  ? intval($ans['question_id'])  : 0;
                $rating_value = isset($ans['rating_value']) ? intval($ans['rating_value']) : null;
                $text_value   = isset($ans['text_value'])   ? trim($ans['text_value'])     : null;
                $select_value = isset($ans['select_value']) ? trim($ans['select_value'])   : null;

                if (!$question_id) continue;

                $aStmt->execute([
                    $submission_id,
                    $question_id,
                    $rating_value  ?: null,
                    $text_value    ?: null,
                    $select_value  ?: null,
                ]);
            }
        }

        // 4b. Compute and store average_score for this submission
        //     Only non-speaker rating answers count (same logic as responses.php)
        $ratingValues = [];
        foreach ($answers as $ans) {
            $qid = intval($ans['question_id'] ?? 0);
            $rv  = isset($ans['rating_value']) && $ans['rating_value'] !== '' ? intval($ans['rating_value']) : null;
            if (!$qid || $rv === null) continue;

            // Confirm this is a non-speaker rating question
            $qCheck = $pdo->prepare("
                SELECT id FROM evaluation_questions
                WHERE id = ? AND question_type = 'rating' AND is_for_speaker = 0 AND is_active = 1
                LIMIT 1
            ");
            $qCheck->execute([$qid]);
            if ($qCheck->fetch()) {
                $ratingValues[] = $rv;
            }
        }

        $avg_score = !empty($ratingValues)
            ? round(array_sum($ratingValues) / count($ratingValues), 2)
            : null;

        $pdo->prepare("UPDATE evaluation_submissions SET average_score = ? WHERE id = ?")
            ->execute([$avg_score, $submission_id]);

        // 5. Insert evaluation_speaker_answers
        if (!empty($speaker_answers)) {
            $saStmt = $pdo->prepare("
                INSERT INTO evaluation_speaker_answers
                    (submission_id, resource_speaker_id, question_id, rating_value)
                VALUES (?, ?, ?, ?)
            ");
            foreach ($speaker_answers as $sa) {
                $speaker_id   = isset($sa['speaker_id'])    ? intval($sa['speaker_id'])    : 0;
                $question_id  = isset($sa['question_id'])   ? intval($sa['question_id'])   : 0;
                $rating_value = isset($sa['rating_value'])  ? intval($sa['rating_value'])  : null;

                if (!$speaker_id || !$question_id) continue;

                $saStmt->execute([
                    $submission_id,
                    $speaker_id,
                    $question_id,
                    $rating_value,
                ]);
            }
        }

        $pdo->commit();

        auditLog([
            'pdo' => $pdo,
            'user_id' => $participant_id,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'success',
            'description' => 'Evaluation submitted | program_id=' . $program_id . ' | workshop_day_id=' . $workshop_day_id . ' | submission_id=' . $submission_id . ' | answers=' . count($answers) . ' | speaker_answers=' . count($speaker_answers),
        ]);

        echo json_encode([
            'success'        => true,
            'message'        => 'Evaluation submitted successfully',
            'submission_id'  => $submission_id,
            'participant_id' => $participant_id,
        ]);

    } catch (Exception $e) {
        $pdo->rollBack();
        auditLog([
            'pdo' => $pdo,
            'role' => 'public_evaluator',
            'action' => 'evaluation_submit',
            'module' => 'evaluation',
            'status' => 'failed',
            'description' => 'Submission transaction failed | program_id=' . $program_id . ' | workshop_day_id=' . $workshop_day_id . ' | error=' . substr($e->getMessage(), 0, 180),
        ]);
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Submission failed: ' . $e->getMessage()]);
    }
}

auditEnsureTable($pdo);