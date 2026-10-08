<?php
/**
 * POST /api/school-portal-delete.php
 * Deletes a school portal submission.
 * Only the owner can delete, and only while status is pending or review.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function jsonSuccess($data = [], $msg = 'Success') {
    ob_end_clean();
    echo json_encode(['success' => true, 'message' => $msg, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function jsonError($msg, $code = 400) {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg], JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') jsonError('Method not allowed', 405);

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) jsonError('Unauthorized.', 401);
    if (($user['account_type'] ?? '') !== 'portal_user') jsonError('Access denied.', 403);

    $body = json_decode(file_get_contents('php://input'), true);
    $id   = (int)($body['id'] ?? 0);
    if (!$id) jsonError('Invalid submission ID.', 400);

    $pdo    = getDB();
    $userId = (int)$user['id'];

    // Fetch — must belong to user
    $stmt = $pdo->prepare("SELECT * FROM school_submissions WHERE id = :id AND user_id = :uid LIMIT 1");
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) jsonError('Submission not found.', 404);

    // Only allow deleting pending/review submissions
    $status = strtolower(trim($sub['status'] ?? ''));
    if (!in_array($status, ['pending', 'pending review', 'review', 'under review'], true)) {
        jsonError('Only pending or under-review submissions can be deleted.', 403);
    }

    // Delete the file from disk
    $basePath = dirname(__DIR__);
    $absPath  = $basePath . '/' . $sub['file_path'];
    if (file_exists($absPath)) @unlink($absPath);

    // Delete the DB record
    $del = $pdo->prepare("DELETE FROM school_submissions WHERE id = :id AND user_id = :uid");
    $del->execute([':id' => $id, ':uid' => $userId]);

    $typeLabels = [
        'tuition' => 'Tuition Fee Increase', 'no_tuition' => 'No Tuition Fee Increase',
        'calendar' => 'School Calendar', 'permit' => 'School Permit', 'indorsement' => 'Indorsement Letter',
    ];
    $typeLabel = $typeLabels[$sub['type'] ?? ''] ?? ucfirst($sub['type'] ?? 'unknown');
    $desc = "Submission deleted | submission_id={$id} | title={$sub['title']} | type={$sub['type']}";
    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_delete',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => $desc,
        'document_type' => $typeLabel,
        'file_name'     => $sub['file_name'],
    ]);

    jsonSuccess(['id' => $id], 'Submission deleted successfully.');

} catch (Throwable $e) {
    error_log('school-portal-delete.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
