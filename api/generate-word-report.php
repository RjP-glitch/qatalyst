<?php
require_once dirname(__DIR__) . '/config/security.php';
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

$raw  = file_get_contents('php://input');
$data = json_decode($raw, true);

if (!$data) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid JSON body']);
    exit;
}

// Write the incoming report data to a temp file so the Node script can read it
$tmpInput  = tempnam(sys_get_temp_dir(), 'qatalyst_report_in_');
$tmpOutput = tempnam(sys_get_temp_dir(), 'qatalyst_report_out_');

file_put_contents($tmpInput, json_encode($data));

// Path to the Node generator script — adjust if your directory structure differs
$scriptPath = escapeshellarg(dirname(__DIR__) . '/js/generate-summary-report.js');
$inputArg   = escapeshellarg($tmpInput);
$outputArg  = escapeshellarg($tmpOutput);

// Run the Node script: node generate-summary-report.js <input.json> <output.docx>
$cmd    = "node {$scriptPath} {$inputArg} {$outputArg} 2>&1";
$output = shell_exec($cmd);
$exists = file_exists($tmpOutput) && filesize($tmpOutput) > 0;

if (!$exists) {
    @unlink($tmpInput);
    @unlink($tmpOutput);
    error_log('generate-word-report.php: Node script failed: ' . $output);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to generate Word document.', 'detail' => $output]);
    exit;
}

// Stream the .docx back to the browser
header('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document');
header('Content-Disposition: attachment; filename="report.docx"');
header('Content-Length: ' . filesize($tmpOutput));
header('Cache-Control: no-cache');

readfile($tmpOutput);

@unlink($tmpInput);
@unlink($tmpOutput);
exit;