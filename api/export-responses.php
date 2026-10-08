<?php
// SECURITY: Secure CORS configuration
$base_path = dirname(__DIR__);
require_once $base_path . '/config/security.php';
require_once $base_path . '/config/auth_middleware.php';
require_once $base_path . '/config/audit_log.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication
$authUser = authenticate();
if (!$authUser) {
    header('Content-Type: application/json');
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Unauthorized. Please log in.']);
    exit;
}

requirePermission('programs', $authUser);

require_once $base_path . '/config/database.php';

// Connect to database
$pdo = getDB();

if (!$pdo || !($pdo instanceof PDO)) {
    throw new Exception('Database connection failed');
}

auditEnsureTable($pdo);

$auditExportResponses = static function ($status, $description) use ($pdo, $authUser): void {
    auditLog([
        'pdo' => $pdo,
        'user_id' => (int)($authUser['id'] ?? 0),
        'role' => (string)($authUser['role'] ?? 'viewer'),
        'action' => 'responses_export_csv',
        'module' => 'programs',
        'status' => (string)$status,
        'description' => (string)$description,
    ]);
};



try {
    $workshop_day_id = isset($_GET['workshop_day_id']) ? intval($_GET['workshop_day_id']) : 1;
    $sex = isset($_GET['sex']) ? $_GET['sex'] : '';
    $participant_type = isset($_GET['participant_type']) ? $_GET['participant_type'] : '';
    $search = isset($_GET['search']) ? $_GET['search'] : '';
    
    // Build query
    $sql = "
        SELECT 
            er.id,
            er.submitted_at,
            wp.full_name,
            wp.sex,
            wp.participant_type,
            wp.designation,
            wp.email,
            wp.school_office,
            er.pm_delivered_as_planned,
            er.pm_managed_efficiently,
            er.pm_well_structured,
            er.pm_detailed_matrix,
            er.obj_clearly_defined,
            er.obj_attainable,
            er.obj_smart,
            er.obj_presented_prior,
            er.content_reliable_sources,
            er.content_effective_learning,
            er.content_meet_expectations,
            er.content_quality_slides,
            er.content_materials_relevant,
            er.content_organized_ideas,
            er.content_appropriate_roles,
            er.venue_adequately_lit,
            er.venue_well_ventilated,
            er.venue_soundproofing,
            er.venue_sufficient_space,
            er.venue_clean_space,
            er.venue_equipment_serviceable,
            er.venue_clean_restrooms,
            er.food_sufficient_quantity,
            er.food_sufficient_variety,
            er.food_generally_healthy,
            er.food_clean_utensils,
            er.food_served_on_time,
            er.food_follows_protocol,
            er.team_courteous,
            er.team_efficient,
            er.team_responsive,
            er.team_safe_techniques,
            er.team_emcee_clarity,
            er.expectations_met,
            er.improvements_suggestions,
            er.significant_insights,
            er.additional_training_topics
        FROM evaluation_responses er
        INNER JOIN workshop_participants wp ON er.participant_id = wp.id
        WHERE er.workshop_day_id = ?
    ";
    
    $params = [$workshop_day_id];
    
    if ($sex) {
        $sql .= " AND wp.sex = ?";
        $params[] = $sex;
    }
    
    if ($participant_type) {
        $sql .= " AND wp.participant_type = ?";
        $params[] = $participant_type;
    }
    
    if ($search) {
        $sql .= " AND (wp.full_name LIKE ? OR wp.email LIKE ? OR wp.designation LIKE ?)";
        $searchTerm = "%$search%";
        $params[] = $searchTerm;
        $params[] = $searchTerm;
        $params[] = $searchTerm;
    }
    
    $sql .= " ORDER BY er.submitted_at DESC";
    
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $responses = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $auditExportResponses(
        'success',
        'Exported evaluation responses CSV | workshop_day_id=' . $workshop_day_id . ' | rows=' . count($responses) . ' | sex=' . ($sex !== '' ? $sex : 'all') . ' | participant_type=' . ($participant_type !== '' ? $participant_type : 'all')
    );
    
    // Generate CSV (simpler than Excel, works in all environments)
    header('Content-Type: text/csv');
    header('Content-Disposition: attachment; filename="survey_responses_' . date('Y-m-d') . '.csv"');
    
    $output = fopen('php://output', 'w');
    
    // Header row
    $headers = [
        'ID', 'Submission Date', 'Full Name', 'Sex', 'Participant Type', 'Designation', 
        'Email', 'School/Office',
        'PM: Delivered as Planned', 'PM: Managed Efficiently', 'PM: Well Structured', 'PM: Training Matrix',
        'Obj: Clearly Defined', 'Obj: Attainable', 'Obj: SMART', 'Obj: Presented Prior',
        'Content: Reliable Sources', 'Content: Effective Learning', 'Content: Meet Expectations',
        'Content: Quality Slides', 'Content: Materials Relevant', 'Content: Organized Ideas',
        'Content: Appropriate Roles',
        'Venue: Adequately Lit', 'Venue: Well Ventilated', 'Venue: Soundproofing',
        'Venue: Sufficient Space', 'Venue: Clean Space', 'Venue: Equipment Serviceable',
        'Venue: Clean Restrooms',
        'Food: Quantity', 'Food: Variety', 'Food: Healthy', 'Food: Clean Utensils',
        'Food: On Time', 'Food: Protocol',
        'Team: Courteous', 'Team: Efficient', 'Team: Responsive', 'Team: Safe Techniques',
        'Team: Emcee Clarity',
        'Expectations Met', 'Improvement Suggestions', 'Significant Insights', 'Additional Training'
    ];
    
    fputcsv($output, $headers);
    
    // Data rows
    foreach ($responses as $row) {
        $data = [
            $row['id'],
            $row['submitted_at'],
            $row['full_name'],
            $row['sex'],
            $row['participant_type'],
            $row['designation'],
            $row['email'],
            $row['school_office'],
            $row['pm_delivered_as_planned'],
            $row['pm_managed_efficiently'],
            $row['pm_well_structured'],
            $row['pm_detailed_matrix'],
            $row['obj_clearly_defined'],
            $row['obj_attainable'],
            $row['obj_smart'],
            $row['obj_presented_prior'],
            $row['content_reliable_sources'],
            $row['content_effective_learning'],
            $row['content_meet_expectations'],
            $row['content_quality_slides'],
            $row['content_materials_relevant'],
            $row['content_organized_ideas'],
            $row['content_appropriate_roles'],
            $row['venue_adequately_lit'],
            $row['venue_well_ventilated'],
            $row['venue_soundproofing'],
            $row['venue_sufficient_space'],
            $row['venue_clean_space'],
            $row['venue_equipment_serviceable'],
            $row['venue_clean_restrooms'],
            $row['food_sufficient_quantity'],
            $row['food_sufficient_variety'],
            $row['food_generally_healthy'],
            $row['food_clean_utensils'],
            $row['food_served_on_time'],
            $row['food_follows_protocol'],
            $row['team_courteous'],
            $row['team_efficient'],
            $row['team_responsive'],
            $row['team_safe_techniques'],
            $row['team_emcee_clarity'],
            $row['expectations_met'],
            $row['improvements_suggestions'],
            $row['significant_insights'],
            $row['additional_training_topics']
        ];
        
        fputcsv($output, $data);
    }
    
    fclose($output);
    exit();
    
} catch (Exception $e) {
    if (isset($pdo) && $pdo instanceof PDO) {
        auditLog([
            'pdo' => $pdo,
            'user_id' => (int)($authUser['id'] ?? 0),
            'role' => (string)($authUser['role'] ?? 'viewer'),
            'action' => 'responses_export_csv',
            'module' => 'programs',
            'status' => 'failed',
            'description' => 'Export failed: ' . substr($e->getMessage(), 0, 180),
        ]);
    }
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Error exporting responses: ' . $e->getMessage()
    ]);
}
?>