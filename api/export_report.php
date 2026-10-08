<?php
error_reporting(0);
ini_set('display_errors', 0);

require_once '../config/database.php';
require_once '../config/auth_middleware.php';

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET')
        throw new Exception('Invalid request method.');

    // ── Authentication & Authorization ─────────────────────────────────────────
    global $pdo;
    $pdo = getDB();
    $authUser = authenticate();
    if (!$authUser) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Unauthorized']);
        exit;
    }
    // Require 'programs' permission to export program data
    requirePermission('programs', $authUser);

    $id = isset($_GET['id']) ? (int)$_GET['id'] : null;
    if (!$id) throw new Exception('Program ID required.');

    // ── Fetch program ──────────────────────────────────────────────────────────
    $stmt = $pdo->prepare("SELECT * FROM evaluation_programs WHERE id = ?");
    $stmt->execute([$id]);
    $program = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$program) throw new Exception('Program not found.');

    // ── Days ───────────────────────────────────────────────────────────────────
    $stmt = $pdo->prepare("
        SELECT DISTINCT day_sheet FROM category_averages
        WHERE program_id = ? AND is_overall = 0 AND day_sheet IS NOT NULL
        ORDER BY day_sheet
    ");
    $stmt->execute([$id]);
    $daySheets = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // ── Respondent counts per day ──────────────────────────────────────────────
    $stmt = $pdo->prepare("SELECT day_sheet, COUNT(*) as cnt FROM respondents WHERE program_id = ? GROUP BY day_sheet");
    $stmt->execute([$id]);
    $respondentCounts = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row)
        $respondentCounts[$row['day_sheet']] = $row['cnt'];

    // ── Build days ─────────────────────────────────────────────────────────────
    $days = [];
    foreach ($daySheets as $day) {
        $stmt = $pdo->prepare("
            SELECT category_name, average_score, result_label
            FROM category_averages
            WHERE program_id = ? AND day_sheet = ? AND is_overall = 0
            ORDER BY id
        ");
        $stmt->execute([$id, $day]);
        $categories = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $stmt = $pdo->prepare("
            SELECT id, slot_number, speaker_name, overall_avg, result_label
            FROM speaker_averages
            WHERE program_id = ? AND day_sheet = ?
            ORDER BY slot_number
        ");
        $stmt->execute([$id, $day]);
        $speakers = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($speakers as &$sp) {
            $stmt = $pdo->prepare("SELECT criterion_label, average_score FROM speaker_criteria WHERE speaker_avg_id = ? ORDER BY id");
            $stmt->execute([$sp['id']]);
            $sp['criteria'] = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
        unset($sp);

        $days[] = [
            'day'         => $day,
            'respondents' => $respondentCounts[$day] ?? 0,
            'categories'  => $categories,
            'speakers'    => $speakers,
        ];
    }

    // ── Overall categories ─────────────────────────────────────────────────────
    $stmt = $pdo->prepare("
        SELECT category_name, average_score, result_label
        FROM category_averages WHERE program_id = ? AND is_overall = 1 ORDER BY id
    ");
    $stmt->execute([$id]);
    $overallCategories = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $program['days']               = $days;
    $program['overall_categories'] = $overallCategories;

    // ── Write JSON for Node script ─────────────────────────────────────────────
    $tmpJson = sys_get_temp_dir() . '/report_data_' . $id . '_' . time() . '.json';
    $tmpDocx = sys_get_temp_dir() . '/report_' . $id . '_' . time() . '.docx';

    file_put_contents($tmpJson, json_encode(['program' => $program]));

    // ── Run Node script ────────────────────────────────────────────────────────
    $scriptPath = __DIR__ . '/../export/generate_report.js';

    $projectRoot = realpath(__DIR__ . '/..');
    $nodeModules = $projectRoot . '\\node_modules';

    $script = file_get_contents($scriptPath);
    $script = str_replace(
        "fs.readFileSync('/tmp/report_data.json'",
        "fs.readFileSync(" . json_encode($tmpJson),
        $script
    );
    $script = str_replace(
        "fs.writeFileSync('/tmp/evaluation_report.docx'",
        "fs.writeFileSync(" . json_encode($tmpDocx),
        $script
    );

    $tmpScript = sys_get_temp_dir() . '/gen_report_' . $id . '_' . time() . '.js';
    file_put_contents($tmpScript, $script);

    $nodeModules = realpath(__DIR__ . '/../node_modules');
    $output = shell_exec('set NODE_PATH=' . escapeshellarg($nodeModules) . ' && "C:\\Program Files\\nodejs\\node.exe" ' . escapeshellarg($tmpScript) . ' 2>&1');

    @unlink($tmpJson);
    @unlink($tmpScript);

    if (!file_exists($tmpDocx) || filesize($tmpDocx) === 0)
        throw new Exception('Failed to generate report: ' . ($output ?? 'unknown error'));

    // ── Stream the file ────────────────────────────────────────────────────────
    $safeTitle = preg_replace('/[^a-zA-Z0-9_\-]/', '_', substr($program['title'], 0, 60));
    $filename  = 'Evaluation_Report_' . $safeTitle . '.docx';

    header('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . filesize($tmpDocx));
    header('Cache-Control: no-cache');
    readfile($tmpDocx);
    @unlink($tmpDocx);
    exit;

} catch (Exception $e) {
    header('Content-Type: application/json');
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>