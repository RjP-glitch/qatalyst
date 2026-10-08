<?php
// ============================================================
// calendar_api.php
// Handles:
//   POST action=save   — save config + marks + legends to DB
//   GET  action=load   — load latest config + marks + legends
// ============================================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');          // tighten in production
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/db.php';

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? ($_POST['action'] ?? '');

// ── Read JSON body for POST ───────────────────────────────────
$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw, true) ?? [];
    if (!$action && isset($body['action'])) {
        $action = $body['action'];
    }
}

// ── Route ─────────────────────────────────────────────────────
try {
    switch ($action) {
        case 'save':   actionSave($body);   break;
        case 'load':   actionLoad();        break;
        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'Unknown action: ' . $action]);
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}

// ─────────────────────────────────────────────────────────────
// SAVE  — upsert config, replace marks, replace custom legends
// ─────────────────────────────────────────────────────────────
function actionSave(array $data): void {
    $db = getDB();

    // ── 1. Upsert config row (always config_id = 1) ──────────
    $config = $data['config'] ?? [];
    $configId = 1;

    $db->prepare("
        INSERT INTO school_calendar_config (
            id, school_name, department, school_id, gov_recog,
            sy_from, sy_to, opening_date, closing_date,
            rd_name, rd_position, rd_office,
            sds_name, sds_position, sds_office, sds_city,
            attached_docs,
            loi_date, loi_salutation, loi_greeting,
            loi_p1, loi_p2, loi_closing, loi_complclose,
            principal_name, principal_title,
            recommending_name, recommending_pos, recommending_org,
            approved_name, approved_pos, approved_org,
            logo_data
        ) VALUES (
            :id, :school_name, :department, :school_id, :gov_recog,
            :sy_from, :sy_to, :opening_date, :closing_date,
            :rd_name, :rd_position, :rd_office,
            :sds_name, :sds_position, :sds_office, :sds_city,
            :attached_docs,
            :loi_date, :loi_salutation, :loi_greeting,
            :loi_p1, :loi_p2, :loi_closing, :loi_complclose,
            :principal_name, :principal_title,
            :recommending_name, :recommending_pos, :recommending_org,
            :approved_name, :approved_pos, :approved_org,
            :logo_data
        )
        ON DUPLICATE KEY UPDATE
            school_name        = VALUES(school_name),
            department         = VALUES(department),
            school_id          = VALUES(school_id),
            gov_recog          = VALUES(gov_recog),
            sy_from            = VALUES(sy_from),
            sy_to              = VALUES(sy_to),
            opening_date       = VALUES(opening_date),
            closing_date       = VALUES(closing_date),
            rd_name            = VALUES(rd_name),
            rd_position        = VALUES(rd_position),
            rd_office          = VALUES(rd_office),
            sds_name           = VALUES(sds_name),
            sds_position       = VALUES(sds_position),
            sds_office         = VALUES(sds_office),
            sds_city           = VALUES(sds_city),
            attached_docs      = VALUES(attached_docs),
            loi_date           = VALUES(loi_date),
            loi_salutation     = VALUES(loi_salutation),
            loi_greeting       = VALUES(loi_greeting),
            loi_p1             = VALUES(loi_p1),
            loi_p2             = VALUES(loi_p2),
            loi_closing        = VALUES(loi_closing),
            loi_complclose     = VALUES(loi_complclose),
            principal_name     = VALUES(principal_name),
            principal_title    = VALUES(principal_title),
            recommending_name  = VALUES(recommending_name),
            recommending_pos   = VALUES(recommending_pos),
            recommending_org   = VALUES(recommending_org),
            approved_name      = VALUES(approved_name),
            approved_pos       = VALUES(approved_pos),
            approved_org       = VALUES(approved_org),
            logo_data          = VALUES(logo_data),
            updated_at         = current_timestamp()
    ")->execute([
        ':id'                => $configId,
        ':school_name'       => $config['school_name']      ?? 'MARIAN COLLEGE OF BALIUAG, INC.',
        ':department'        => $config['department']        ?? 'Elementary Department',
        ':school_id'         => $config['school_id']         ?? '',
        ':gov_recog'         => $config['gov_recog']         ?? '',
        ':sy_from'           => $config['sy_from']           ?? date('Y'),
        ':sy_to'             => $config['sy_to']             ?? (date('Y') + 1),
        ':opening_date'      => nullIfEmpty($config['opening_date']  ?? ''),
        ':closing_date'      => nullIfEmpty($config['closing_date']  ?? ''),
        ':rd_name'           => $config['rd_name']           ?? '',
        ':rd_position'       => $config['rd_position']       ?? '',
        ':rd_office'         => $config['rd_office']         ?? '',
        ':sds_name'          => $config['sds_name']          ?? '',
        ':sds_position'      => $config['sds_position']      ?? '',
        ':sds_office'        => $config['sds_office']        ?? '',
        ':sds_city'          => $config['sds_city']          ?? '',
        ':attached_docs'     => $config['attached_docs']     ?? '',
        ':loi_date'          => nullIfEmpty($config['loi_date'] ?? ''),
        ':loi_salutation'    => $config['loi_salutation']    ?? '',
        ':loi_greeting'      => $config['loi_greeting']      ?? '',
        ':loi_p1'            => $config['loi_p1']            ?? '',
        ':loi_p2'            => $config['loi_p2']            ?? '',
        ':loi_closing'       => $config['loi_closing']       ?? '',
        ':loi_complclose'    => $config['loi_complclose']    ?? '',
        ':principal_name'    => $config['principal_name']    ?? '',
        ':principal_title'   => $config['principal_title']   ?? '',
        ':recommending_name' => $config['recommending_name'] ?? '',
        ':recommending_pos'  => $config['recommending_pos']  ?? '',
        ':recommending_org'  => $config['recommending_org']  ?? '',
        ':approved_name'     => $config['approved_name']     ?? '',
        ':approved_pos'      => $config['approved_pos']      ?? '',
        ':approved_org'      => $config['approved_org']      ?? '',
        ':logo_data'         => $config['logo_data']         ?? null,
    ]);

    // ── 2. Replace all marks for this config ─────────────────
    $db->prepare("DELETE FROM school_calendar_marks WHERE config_id = ?")->execute([$configId]);
    $marks = $data['marks'] ?? [];  // array of {date, type, remark}
    if (!empty($marks)) {
        $stmt = $db->prepare("
            INSERT INTO school_calendar_marks (config_id, mark_date, mark_type, remark)
            VALUES (:config_id, :mark_date, :mark_type, :remark)
        ");
        foreach ($marks as $m) {
            $stmt->execute([
                ':config_id' => $configId,
                ':mark_date' => $m['date'],
                ':mark_type' => $m['type'],
                ':remark'    => $m['remark'] ?? null,
            ]);
        }
    }

    // ── 3. Replace custom legends (non-builtins) ─────────────
    $db->prepare("DELETE FROM school_calendar_legends WHERE config_id = ? AND is_builtin = 0")->execute([$configId]);
    $customLegends = $data['custom_legends'] ?? [];
    if (!empty($customLegends)) {
        $stmt = $db->prepare("
            INSERT INTO school_calendar_legends (config_id, legend_key, legend_label, legend_color, legend_symbol, is_builtin)
            VALUES (:config_id, :legend_key, :legend_label, :legend_color, :legend_symbol, 0)
        ");
        foreach ($customLegends as $leg) {
            $stmt->execute([
                ':config_id'    => $configId,
                ':legend_key'   => $leg['key'],
                ':legend_label' => $leg['label'],
                ':legend_color' => $leg['color'],
                ':legend_symbol'=> $leg['symbol'] ?? '●',
            ]);
        }
    }

    echo json_encode([
        'success'   => true,
        'message'   => 'Calendar saved successfully!',
        'config_id' => $configId,
        'marks_saved' => count($marks),
    ]);
}

// ─────────────────────────────────────────────────────────────
// LOAD  — fetch config + marks + custom legends
// ─────────────────────────────────────────────────────────────
function actionLoad(): void {
    $db = getDB();
    $configId = 1;

    // Config
    $config = $db->prepare("SELECT * FROM school_calendar_config WHERE id = ?")->execute([$configId])
        ? $db->prepare("SELECT * FROM school_calendar_config WHERE id = ?")->execute([$configId])
        : null;

    $stmt = $db->prepare("SELECT * FROM school_calendar_config WHERE id = ?");
    $stmt->execute([$configId]);
    $config = $stmt->fetch();

    // Marks
    $stmt2 = $db->prepare("SELECT mark_date, mark_type, remark FROM school_calendar_marks WHERE config_id = ? ORDER BY mark_date");
    $stmt2->execute([$configId]);
    $marks = $stmt2->fetchAll();

    // Custom legends
    $stmt3 = $db->prepare("SELECT legend_key, legend_label, legend_color, legend_symbol FROM school_calendar_legends WHERE config_id = ? AND is_builtin = 0");
    $stmt3->execute([$configId]);
    $customLegends = $stmt3->fetchAll();

    echo json_encode([
        'success'       => true,
        'config'        => $config ?: [],
        'marks'         => $marks,
        'custom_legends'=> $customLegends,
    ]);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function nullIfEmpty(?string $val): ?string {
    return ($val === null || trim($val) === '') ? null : trim($val);
}
