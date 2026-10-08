<?php
/**
 * POST /api/school-portal-edit.php
 * Edits a school portal submission (title, type, optional file replacement).
 * Only the owner can edit, and only while status is pending or review.
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

    $id    = (int)($_POST['id']    ?? 0);
    $title = trim($_POST['title']  ?? '');
    $type  = strtolower(trim($_POST['type'] ?? ''));

    if (!$id)    jsonError('Invalid submission ID.', 400);
    if (!$title) jsonError('Title is required.', 422);

    $allowedTypes = ['tuition', 'no_tuition', 'calendar', 'permit', 'indorsement'];
    if (!in_array($type, $allowedTypes, true)) jsonError('Invalid document type.', 422);

    $pdo    = getDB();
    $userId = (int)$user['id'];

    // Fetch existing submission — must belong to user
    $stmt = $pdo->prepare("SELECT * FROM school_submissions WHERE id = :id AND user_id = :uid LIMIT 1");
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$sub) jsonError('Submission not found.', 404);

    // Only allow editing pending/review submissions
    $status = strtolower(trim($sub['status'] ?? ''));
    if (!in_array($status, ['pending', 'pending review', 'review', 'under review'], true)) {
        jsonError('Only pending or under-review submissions can be edited.', 403);
    }

    $newFilePath = $sub['file_path'];
    $newFileName = $sub['file_name'];
    $newFileSize = $sub['file_size'];

    // Handle optional file replacement
    if (!empty($_FILES['file']) && (int)$_FILES['file']['error'] === UPLOAD_ERR_OK) {
        $file = $_FILES['file'];

        $maxBytes = 10 * 1024 * 1024;
        if ((int)$file['size'] > $maxBytes) jsonError('File is too large. Maximum size is 10MB.', 413);

        $originalName = sanitizeFilename((string)($file['name'] ?? ''));
        if (!$originalName) jsonError('Invalid filename.', 400);

        $allowedByType = [
            'tuition'     => ['pdf', 'doc', 'docx'],
            'no_tuition'  => ['pdf', 'doc', 'docx'],
            'calendar'    => ['pdf', 'doc', 'docx', 'xlsx', 'txt'],
            'permit'      => ['pdf', 'doc', 'docx'],
            'indorsement' => ['pdf', 'doc', 'docx'],
        ];
        if (!isAllowedFileExtension($originalName, $allowedByType[$type])) {
            jsonError('File type is not allowed for this document category.', 422);
        }
        if (!validateFileMimeType((string)$file['tmp_name'], $originalName)) {
            jsonError('Uploaded file content does not match its extension.', 422);
        }

        $basePath  = dirname(__DIR__);
        $uploadDir = $basePath . '/api/uploads/school_submissions/' . $userId;
        if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
            jsonError('Could not initialize upload directory.', 500);
        }

        $ext        = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        $storedName = sprintf('%s_%d_%s.%s', $type, time(), bin2hex(random_bytes(8)), $ext);
        $absPath    = $uploadDir . '/' . $storedName;

        if (!move_uploaded_file((string)$file['tmp_name'], $absPath)) jsonError('Failed to store file.', 500);

        // Delete old file if it exists
        $oldAbs = $basePath . '/' . $sub['file_path'];
        if (file_exists($oldAbs)) @unlink($oldAbs);

        $newFilePath = 'api/uploads/school_submissions/' . $userId . '/' . $storedName;
        $newFileName = $originalName;
        $newFileSize = (int)$file['size'];
    }

    $update = $pdo->prepare("
        UPDATE school_submissions
        SET title = :title, type = :type, file_name = :file_name,
            file_path = :file_path, file_size = :file_size, updated_at = NOW()
        WHERE id = :id AND user_id = :uid
    ");
    $update->execute([
        ':title'     => $title,
        ':type'      => $type,
        ':file_name' => $newFileName,
        ':file_path' => $newFilePath,
        ':file_size' => $newFileSize,
        ':id'        => $id,
        ':uid'       => $userId,
    ]);

    $typeLabels = [
        'tuition' => 'Tuition Fee Increase', 'no_tuition' => 'No Tuition Fee Increase',
        'calendar' => 'School Calendar', 'permit' => 'School Permit', 'indorsement' => 'Indorsement Letter',
    ];
    $typeLabel = $typeLabels[$type] ?? ucfirst($type);
    $desc = "Submission edited | submission_id={$id} | title={$title} | type={$type}" . ($file ? ' | file_replaced=yes' : '');
    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_edit',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => $desc,
        'document_type' => $typeLabel,
        'file_name'     => $newFileName,
    ]);

    jsonSuccess(['id' => $id], 'Submission updated successfully.');

} catch (Throwable $e) {
    error_log('school-portal-edit.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}
