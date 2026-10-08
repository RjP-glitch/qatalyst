<?php
/**
 * Dashboard Data API Endpoint
 * GET /api/dashboard.php?workshop_day_id=1
 * 
 * Updated to use dynamic evaluation schema:
 * - evaluation_submissions
 * - evaluation_answers
 * - evaluation_questions
 * - evaluation_question_categories
 * - evaluation_speaker_answers
 */

error_reporting(0);
ini_set('display_errors', 0);

if (ob_get_level()) ob_end_clean();
ob_start();

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for dashboard data
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Require 'dashboard' permission
requirePermission('dashboard', $authUser);

// ========================================================================
// HELPER FUNCTIONS
// ========================================================================
function getRatingLabel($score) {
    $score = floatval($score);
    if ($score >= 3.50) return 'STRONGLY AGREE';
    if ($score >= 2.50) return 'AGREE';
    if ($score >= 1.50) return 'DISAGREE';
    if ($score > 0)     return 'STRONGLY DISAGREE';
    return 'NO DATA';
}

function getProgressWidth($score) {
    $score = floatval($score);
    return $score > 0 ? round(($score / 4.0) * 100, 2) : 0;
}

/**
 * Fetch per-question averages for a speaker (criteria breakdown).
 * Returns array of [{label, score}] sorted by question display order.
 */
function getSpeakerCriteria(PDO $pdo, int $speakerId): array {
    $stmt = $pdo->prepare("
        SELECT eq.question_text, ROUND(AVG(esa.rating_value), 2) as avg_score
        FROM evaluation_speaker_answers esa
        JOIN evaluation_questions eq ON eq.id = esa.question_id
        WHERE esa.resource_speaker_id = :speaker_id
        GROUP BY eq.id, eq.question_text, eq.display_order
        ORDER BY eq.display_order
    ");
    $stmt->execute([':speaker_id' => $speakerId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    $criteria = [];
    foreach ($rows as $row) {
        $criteria[] = [
            'label' => $row['question_text'],
            'score' => floatval($row['avg_score'])
        ];
    }
    return $criteria;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        throw new Exception('Method not allowed');
    }

    $workshop_day_id_param = isset($_GET['workshop_day_id']) ? $_GET['workshop_day_id'] : '1';
    $is_all_days = ($workshop_day_id_param === 'all');
    $workshop_day_id = $is_all_days ? 0 : intval($workshop_day_id_param);
    $workshop_id_param = isset($_GET['workshop_id']) ? intval($_GET['workshop_id']) : 0;

    $pdo = getDB();

    if (!$pdo || !($pdo instanceof PDO)) {
        throw new Exception('Database connection failed');
    }

    // ========================================================================
    // 1. GET WORKSHOP INFO
    // ========================================================================
    if ($is_all_days) {
        // For "All Days", get workshop info directly
        $stmt = $pdo->prepare("
            SELECT 
                w.id as workshop_id,
                w.title,
                w.division_memo,
                w.venue,
                w.status,
                w.total_participants as expected_participants
            FROM workshops w
            WHERE w.id = :workshop_id
        ");
        $stmt->bindParam(':workshop_id', $workshop_id_param, PDO::PARAM_INT);
        $stmt->execute();
        $workshop_info = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$workshop_info) {
            throw new Exception('Workshop not found');
        }
        $workshop_info['workshop_day_id'] = 0;
        $workshop_info['day_number'] = 0;
        $workshop_info['day_date'] = null;
        $workshop_info['day_title'] = 'All Days';
    } else {
        $stmt = $pdo->prepare("
            SELECT 
                w.id as workshop_id,
                w.title,
                w.division_memo,
                w.venue,
                w.status,
                w.total_participants as expected_participants,
                wd.id as workshop_day_id,
                wd.day_number,
                wd.day_date,
                wd.title as day_title
            FROM workshop_days wd
            JOIN workshops w ON wd.workshop_id = w.id
            WHERE wd.id = :workshop_day_id
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
        $stmt->execute();
        $workshop_info = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$workshop_info) {
            throw new Exception('Workshop day not found');
        }
    }

    // ========================================================================
    // 2. GET RESPONDENT STATISTICS (only participants who submitted evaluations)
    // ========================================================================
    if ($is_all_days) {
        // Aggregate unique respondents across all days of this workshop
        // Use subquery to deduplicate participants who submitted on multiple days
        $stmt = $pdo->prepare("
            SELECT 
                COUNT(*) as total_participants,
                SUM(CASE WHEN sex = 'Male' THEN 1 ELSE 0 END) as male_count,
                SUM(CASE WHEN sex = 'Female' THEN 1 ELSE 0 END) as female_count,
                ROUND(SUM(CASE WHEN sex = 'Male' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as male_percentage,
                ROUND(SUM(CASE WHEN sex = 'Female' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as female_percentage
            FROM (
                SELECT DISTINCT wp.id, wp.sex
                FROM evaluation_submissions es
                INNER JOIN workshop_participants wp ON es.participant_id = wp.id
                INNER JOIN workshop_days wd ON es.workshop_day_id = wd.id
                WHERE wd.workshop_id = :workshop_id
            ) AS unique_participants
        ");
        $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    } else {
        $stmt = $pdo->prepare("
            SELECT 
                COUNT(DISTINCT wp.id) as total_participants,
                SUM(CASE WHEN wp.sex = 'Male' THEN 1 ELSE 0 END) as male_count,
                SUM(CASE WHEN wp.sex = 'Female' THEN 1 ELSE 0 END) as female_count,
                ROUND(SUM(CASE WHEN wp.sex = 'Male' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(DISTINCT wp.id), 0), 1) as male_percentage,
                ROUND(SUM(CASE WHEN wp.sex = 'Female' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(DISTINCT wp.id), 0), 1) as female_percentage
            FROM evaluation_submissions es
            INNER JOIN workshop_participants wp ON es.participant_id = wp.id
            WHERE es.workshop_day_id = :workshop_day_id
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
    }
    $stmt->execute();
    $participants = $stmt->fetch(PDO::FETCH_ASSOC);

    // ========================================================================
    // 3. GET RESPONSE COUNT FOR THIS DAY
    // ========================================================================
    if ($is_all_days) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as response_count
            FROM evaluation_submissions es
            INNER JOIN workshop_days wd ON es.workshop_day_id = wd.id
            WHERE wd.workshop_id = :workshop_id
        ");
        $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    } else {
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as response_count
            FROM evaluation_submissions
            WHERE workshop_day_id = :workshop_day_id
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
    }
    $stmt->execute();
    $submission_info = $stmt->fetch(PDO::FETCH_ASSOC);
    $response_count = intval($submission_info['response_count']);

    // Get last submission timestamp for real-time update detection
    if ($is_all_days) {
        $stmt = $pdo->prepare("
            SELECT MAX(es.submitted_at) as last_submission_time
            FROM evaluation_submissions es
            INNER JOIN workshop_days wd ON es.workshop_day_id = wd.id
            WHERE wd.workshop_id = :workshop_id
        ");
        $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    } else {
        $stmt = $pdo->prepare("
            SELECT MAX(submitted_at) as last_submission_time
            FROM evaluation_submissions
            WHERE workshop_day_id = :workshop_day_id
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
    }
    $stmt->execute();
    $last_submission = $stmt->fetch(PDO::FETCH_ASSOC);
    $last_submission_time = $last_submission['last_submission_time'];

    // If check_only mode, return minimal data for polling (more efficient)
    if (isset($_GET['check_only']) && $_GET['check_only'] == '1') {
        echo json_encode([
            'success' => true,
            'data' => [
                'response_count' => $response_count,
                'last_submission_time' => $last_submission_time
            ]
        ]);
        exit;
    }

    // ========================================================================
    // 4. GET AVERAGE RATINGS PER CATEGORY (Dynamic - uses question categories)
    // ========================================================================
    // This query averages all rating answers grouped by category,
    // excluding speaker questions (is_for_speaker = 0)
    if ($is_all_days) {
        $stmt = $pdo->prepare("
            SELECT 
                eqc.id as category_id,
                eqc.name as category_name,
                eqc.display_order,
                ROUND(AVG(ea.rating_value), 2) as avg_rating,
                COUNT(DISTINCT es.id) as response_count
            FROM evaluation_submissions es
            INNER JOIN workshop_days wd ON es.workshop_day_id = wd.id
            JOIN evaluation_answers ea ON ea.submission_id = es.id
            JOIN evaluation_questions eq ON eq.id = ea.question_id
                AND eq.question_type = 'rating'
                AND eq.is_for_speaker = 0
                AND eq.is_active = 1
            JOIN evaluation_question_categories eqc ON eqc.id = eq.category_id
            WHERE wd.workshop_id = :workshop_id
            GROUP BY eqc.id, eqc.name, eqc.display_order
            ORDER BY eqc.display_order
        ");
        $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    } else {
        $stmt = $pdo->prepare("
            SELECT 
                eqc.id as category_id,
                eqc.name as category_name,
                eqc.display_order,
                ROUND(AVG(ea.rating_value), 2) as avg_rating,
                COUNT(DISTINCT es.id) as response_count
            FROM evaluation_submissions es
            JOIN evaluation_answers ea ON ea.submission_id = es.id
            JOIN evaluation_questions eq ON eq.id = ea.question_id
                AND eq.question_type = 'rating'
                AND eq.is_for_speaker = 0
                AND eq.is_active = 1
            JOIN evaluation_question_categories eqc ON eqc.id = eq.category_id
            WHERE es.workshop_day_id = :workshop_day_id
            GROUP BY eqc.id, eqc.name, eqc.display_order
            ORDER BY eqc.display_order
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
    }
    $stmt->execute();
    $category_averages = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Map category averages by name for easy lookup in the frontend
    $category_map = [];
    foreach ($category_averages as $cat) {
        $category_map[$cat['category_name']] = floatval($cat['avg_rating']);
    }

    // Pull the 4 main dashboard categories
    // These names must match what was seeded in evaluation_question_categories
    $avg_program_management = $category_map['Program Management and Operations'] ?? 0;
    $avg_objectives         = $category_map['Attainment of Objectives'] ?? 0;
    $avg_content            = $category_map['Delivery of Content'] ?? 0;
    $avg_venue              = $category_map['Venue'] ?? 0;
    $avg_food               = $category_map['Meal'] ?? 0;

    // Combined Food + Venue score
    if ($avg_venue > 0 && $avg_food > 0) {
        $avg_food_venue = round(($avg_venue + $avg_food) / 2, 2);
    } elseif ($avg_venue > 0) {
        $avg_food_venue = $avg_venue;
    } elseif ($avg_food > 0) {
        $avg_food_venue = $avg_food;
    } else {
        $avg_food_venue = 0;
    }

    // ========================================================================
    // 5. GET ALL CATEGORY AVERAGES (for full analytics) with questions
    // ========================================================================
    
    // First, get question-level averages (INNER JOINs to only include questions with actual answers)
    if ($is_all_days) {
        $qStmt = $pdo->prepare("
            SELECT 
                eq.id as question_id,
                eq.question_text,
                eq.category_id,
                eq.display_order,
                ROUND(AVG(ea.rating_value), 2) as avg_rating,
                COUNT(ea.id) as answer_count
            FROM evaluation_submissions es
            INNER JOIN workshop_days wd ON wd.id = es.workshop_day_id
            JOIN evaluation_answers ea ON ea.submission_id = es.id
            JOIN evaluation_questions eq ON eq.id = ea.question_id
                AND eq.question_type = 'rating'
                AND eq.is_for_speaker = 0
                AND eq.is_active = 1
            WHERE wd.workshop_id = :workshop_id
            GROUP BY eq.id, eq.question_text, eq.category_id, eq.display_order
            ORDER BY eq.category_id, eq.display_order
        ");
        $qStmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    } else {
        $qStmt = $pdo->prepare("
            SELECT 
                eq.id as question_id,
                eq.question_text,
                eq.category_id,
                eq.display_order,
                ROUND(AVG(ea.rating_value), 2) as avg_rating,
                COUNT(ea.id) as answer_count
            FROM evaluation_submissions es
            JOIN evaluation_answers ea ON ea.submission_id = es.id
            JOIN evaluation_questions eq ON eq.id = ea.question_id
                AND eq.question_type = 'rating'
                AND eq.is_for_speaker = 0
                AND eq.is_active = 1
            WHERE es.workshop_day_id = :workshop_day_id
            GROUP BY eq.id, eq.question_text, eq.category_id, eq.display_order
            ORDER BY eq.category_id, eq.display_order
        ");
        $qStmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
    }
    $qStmt->execute();
    $question_averages = $qStmt->fetchAll(PDO::FETCH_ASSOC);
    
    // Group questions by category
    $questions_by_category = [];
    foreach ($question_averages as $q) {
        $catId = intval($q['category_id']);
        if (!isset($questions_by_category[$catId])) {
            $questions_by_category[$catId] = [];
        }
        $questions_by_category[$catId][] = [
            'id'           => intval($q['question_id']),
            'text'         => $q['question_text'],
            'avg_rating'   => floatval($q['avg_rating'] ?? 0),
            'answer_count' => intval($q['answer_count']),
            'label'        => getRatingLabel($q['avg_rating'] ?? 0)
        ];
    }
    
    $all_categories = [];
    foreach ($category_averages as $cat) {
        $catId = intval($cat['category_id']);
        $all_categories[] = [
            'id'           => $catId,
            'name'         => $cat['category_name'],
            'avg_rating'   => floatval($cat['avg_rating']),
            'label'        => getRatingLabel($cat['avg_rating']),
            'progress_width' => getProgressWidth($cat['avg_rating']),
            'questions'    => $questions_by_category[$catId] ?? []
        ];
    }

    // ========================================================================
    // 6. GET RESOURCE SPEAKER RATINGS (Dynamic)
    // ========================================================================
    $speakers = [];
    $speakers_by_day = [];
    $all_speakers_flat = []; // For ranking across all days
    
    if ($is_all_days) {
        // Get all speakers for all days in this workshop
        $stmt = $pdo->prepare("
            SELECT 
                rs.id as speaker_id,
                rs.speaker_number,
                rs.name,
                rs.designation,
                rs.topic,
                rs.workshop_day_id,
                wd.day_number,
                ROUND(AVG(esa.rating_value), 2) as avg_rating,
                COUNT(esa.id) as rating_count
            FROM resource_speakers rs
            INNER JOIN workshop_days wd ON rs.workshop_day_id = wd.id
            LEFT JOIN evaluation_speaker_answers esa ON esa.resource_speaker_id = rs.id
            WHERE wd.workshop_id = :workshop_id
            GROUP BY rs.id, rs.speaker_number, rs.name, rs.designation, rs.topic, rs.workshop_day_id, wd.day_number
            ORDER BY wd.day_number, rs.speaker_number
        ");
        $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
        $stmt->execute();
        $all_speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        // Group speakers by day and collect all for ranking
        foreach ($all_speakers as $speaker) {
            $day_num = intval($speaker['day_number']);
            if (!isset($speakers_by_day[$day_num])) {
                $speakers_by_day[$day_num] = [];
            }
            $speakerId = intval($speaker['speaker_id']);
            $speaker_data = [
                'id'           => $speakerId,
                'number'       => intval($speaker['speaker_number']),
                'name'         => $speaker['name'],
                'designation'  => $speaker['designation'],
                'topic'        => $speaker['topic'],
                'rating'       => floatval($speaker['avg_rating']) ?: 0,
                'rating_count' => intval($speaker['rating_count']),
                'day_number'   => $day_num,
                'criteria'     => getSpeakerCriteria($pdo, $speakerId)
            ];
            $speakers_by_day[$day_num][] = $speaker_data;
            $all_speakers_flat[] = $speaker_data;
        }
        
        // Sort all speakers by rating (descending) to determine rankings
        usort($all_speakers_flat, function($a, $b) {
            return $b['rating'] <=> $a['rating'];
        });
        
        // Assign ranks (1-based, speakers with same rating get same rank)
        $rank = 1;
        $prev_rating = null;
        $rank_map = [];
        foreach ($all_speakers_flat as $i => $speaker) {
            if ($speaker['rating'] > 0) {
                if ($prev_rating !== null && $speaker['rating'] < $prev_rating) {
                    $rank = $i + 1;
                }
                $rank_map[$speaker['id']] = $rank;
                $prev_rating = $speaker['rating'];
            }
        }
        
        // Add ranks to speakers_by_day
        foreach ($speakers_by_day as $day_num => &$day_speakers) {
            foreach ($day_speakers as &$speaker) {
                $speaker['rank'] = $rank_map[$speaker['id']] ?? null;
                $speaker['is_top'] = ($speaker['rank'] === 1 && $speaker['rating'] > 0);
            }
        }
        
        // Also add to flat list
        foreach ($all_speakers_flat as &$speaker) {
            $speaker['rank'] = $rank_map[$speaker['id']] ?? null;
            $speaker['is_top'] = ($speaker['rank'] === 1 && $speaker['rating'] > 0);
        }
        
        $speakers = $all_speakers_flat;
    } else {
        $stmt = $pdo->prepare("
            SELECT 
                rs.id as speaker_id,
                rs.speaker_number,
                rs.name,
                rs.designation,
                rs.topic,
                ROUND(AVG(esa.rating_value), 2) as avg_rating,
                COUNT(esa.id) as rating_count
            FROM resource_speakers rs
            LEFT JOIN evaluation_speaker_answers esa ON esa.resource_speaker_id = rs.id
            WHERE rs.workshop_day_id = :workshop_day_id
            GROUP BY rs.id, rs.speaker_number, rs.name, rs.designation, rs.topic
            ORDER BY rs.speaker_number
        ");
        $stmt->bindParam(':workshop_day_id', $workshop_day_id, PDO::PARAM_INT);
        $stmt->execute();
        $speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        // For single day, still calculate rankings
        $speakers_with_rank = [];
        foreach ($speakers as $speaker) {
            $speakerId = intval($speaker['speaker_id']);
            $speakers_with_rank[] = [
                'id'           => $speakerId,
                'number'       => intval($speaker['speaker_number']),
                'name'         => $speaker['name'],
                'designation'  => $speaker['designation'],
                'topic'        => $speaker['topic'],
                'rating'       => floatval($speaker['avg_rating']) ?: 0,
                'rating_count' => intval($speaker['rating_count']),
                'criteria'     => getSpeakerCriteria($pdo, $speakerId)
            ];
        }
        
        // Sort by rating to assign ranks
        usort($speakers_with_rank, function($a, $b) {
            return $b['rating'] <=> $a['rating'];
        });
        
        $rank = 1;
        $prev_rating = null;
        foreach ($speakers_with_rank as $i => &$speaker) {
            if ($speaker['rating'] > 0) {
                if ($prev_rating !== null && $speaker['rating'] < $prev_rating) {
                    $rank = $i + 1;
                }
                $speaker['rank'] = $rank;
                $speaker['is_top'] = ($rank === 1);
                $prev_rating = $speaker['rating'];
            } else {
                $speaker['rank'] = null;
                $speaker['is_top'] = false;
            }
        }
        
        $speakers = $speakers_with_rank;
    }

    // ========================================================================
    // 7. GET ALL WORKSHOP DAYS FOR NAVIGATION
    // ========================================================================
    $stmt = $pdo->prepare("
        SELECT id, day_number, day_date, title
        FROM workshop_days
        WHERE workshop_id = :workshop_id
        ORDER BY day_number
    ");
    $stmt->bindParam(':workshop_id', $workshop_info['workshop_id'], PDO::PARAM_INT);
    $stmt->execute();
    $workshop_days = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // ========================================================================
    // BUILD RESPONSE
    // ========================================================================
    $response = [
        'success' => true,
        'data' => [
            'is_all_days' => $is_all_days,
            'workshop' => [
                'id'           => intval($workshop_info['workshop_id']),
                'title'        => $workshop_info['title'],
                'division_memo'=> $workshop_info['division_memo'],
                'venue'        => $workshop_info['venue'],
                'status'       => $workshop_info['status'],
                'expected_participants' => intval($workshop_info['expected_participants']) ?: null
            ],
            'current_day' => [
                'id'         => intval($workshop_info['workshop_day_id']),
                'day_number' => intval($workshop_info['day_number']),
                'day_date'   => $workshop_info['day_date'],
                'title'      => $workshop_info['day_title']
            ],
            'workshop_days' => array_map(function($day) {
                return [
                    'id'         => intval($day['id']),
                    'day_number' => intval($day['day_number']),
                    'day_date'   => $day['day_date'],
                    'title'      => $day['title']
                ];
            }, $workshop_days),
            'participants' => [
                'total'             => intval($participants['total_participants']) ?: 0,
                'male_count'        => intval($participants['male_count']) ?: 0,
                'female_count'      => intval($participants['female_count']) ?: 0,
                'male_percentage'   => floatval($participants['male_percentage']) ?: 0,
                'female_percentage' => floatval($participants['female_percentage']) ?: 0
            ],

            // 4 main dashboard categories (hardcoded for the dashboard cards)
            'program_management' => [
                'score'          => $avg_program_management,
                'label'          => getRatingLabel($avg_program_management),
                'progress_width' => getProgressWidth($avg_program_management)
            ],
            'attainment_objectives' => [
                'score'          => $avg_objectives,
                'label'          => getRatingLabel($avg_objectives),
                'progress_width' => getProgressWidth($avg_objectives)
            ],
            'delivery_content' => [
                'score'          => $avg_content,
                'label'          => getRatingLabel($avg_content),
                'progress_width' => getProgressWidth($avg_content)
            ],
            'food_venue' => [
                'score'          => $avg_food_venue,
                'label'          => getRatingLabel($avg_food_venue),
                'progress_width' => getProgressWidth($avg_food_venue),
                'food_score'     => $avg_food,
                'venue_score'    => $avg_venue
            ],

            // All categories (for analytics pages)
            'all_categories' => $all_categories,

            // Resource speakers with rankings
            'resource_speakers' => $speakers,
            
            // Speakers grouped by day (for All Days view)
            'speakers_by_day' => $speakers_by_day,

            'response_count' => $response_count,
            'last_submission_time' => $last_submission_time,
            'timestamp'      => date('Y-m-d H:i:s')
        ]
    ];

    http_response_code(200);
    echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Database error occurred',
        'error'   => $e->getMessage()
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

ob_end_flush();
?>