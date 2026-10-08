<?php
/**
 * POST /api/school-portal-upload.php
 * Handles school portal document uploads (tuition, calendar).
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) {
    ob_end_clean();
}
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once dirname(__DIR__) . '/config/audit_log.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

function jsonSuccess(array $data = [], string $message = 'Success', int $code = 200): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode([
        'success' => true,
        'message' => $message,
        'data' => $data,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonError(string $message, int $code = 400): void {
    if (ob_get_level()) {
        ob_end_clean();
    }
    http_response_code($code);
    echo json_encode([
        'success' => false,
        'message' => $message,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError('Method not allowed', 405);
    }

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) {
        jsonError('Unauthorized. Please sign in.', 401);
    }

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType !== 'portal_user') {
        jsonError('Access denied. This endpoint is only for school portal users.', 403);
    }

    if (empty($_FILES['file']) || !isset($_FILES['file']['error'])) {
        jsonError('No file uploaded.', 400);
    }

    $type = strtolower(trim($_POST['type'] ?? ''));
    $allowedTypes = ['tuition', 'no_tuition', 'calendar', 'permit', 'indorsement'];
    if (!in_array($type, $allowedTypes, true)) {
        jsonError('Invalid document type.', 422);
    }

    $file = $_FILES['file'];
    if ((int)$file['error'] !== UPLOAD_ERR_OK) {
        $uploadErrors = [
            UPLOAD_ERR_INI_SIZE => 'File exceeds server upload limit.',
            UPLOAD_ERR_FORM_SIZE => 'File exceeds form size limit.',
            UPLOAD_ERR_PARTIAL => 'File was only partially uploaded.',
            UPLOAD_ERR_NO_FILE => 'No file uploaded.',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary upload folder.',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write uploaded file.',
            UPLOAD_ERR_EXTENSION => 'Upload blocked by server extension.',
        ];
        $err = $uploadErrors[(int)$file['error']] ?? 'Upload failed.';
        jsonError($err, 400);
    }

    $maxBytes = 10 * 1024 * 1024; // 10MB
    $fileSize = (int)($file['size'] ?? 0);
    if ($fileSize <= 0) {
        jsonError('Uploaded file appears to be empty.', 400);
    }
    if ($fileSize > $maxBytes) {
        jsonError('File is too large. Maximum size is 10MB.', 413);
    }

    $originalName = sanitizeFilename((string)($file['name'] ?? ''));
    if ($originalName === '') {
        jsonError('Invalid filename.', 400);
    }

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

    // Keep MIME validation best-effort to avoid false negatives on some Office files.
    if (!validateFileMimeType((string)$file['tmp_name'], $originalName)) {
        jsonError('Uploaded file content does not match its extension.', 422);
    }

    $basePath = dirname(__DIR__);
    $userId = (int)$user['id'];
    $schoolId = !empty($user['school_id']) ? (int)$user['school_id'] : null;
    $districtId = !empty($user['district_id']) ? (int)$user['district_id'] : null;

    $uploadDir = $basePath . '/api/uploads/school_submissions/' . $userId;
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
        jsonError('Could not initialize upload directory.', 500);
    }

    $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    $storedName = sprintf(
        '%s_%d_%s.%s',
        $type,
        time(),
        bin2hex(random_bytes(8)),
        $ext
    );

    $absolutePath = $uploadDir . '/' . $storedName;
    if (!move_uploaded_file((string)$file['tmp_name'], $absolutePath)) {
        jsonError('Failed to store uploaded file.', 500);
    }

    // Save relative path for portability across environments.
    $relativePath = 'api/uploads/school_submissions/' . $userId . '/' . $storedName;

    $typeLabel = [
        'tuition'     => 'Tuition Fee Document',
        'no_tuition'  => 'No Tuition Fee Increase',
        'calendar'    => 'School Calendar',
        'permit'      => 'School Permit',
        'indorsement' => 'Indorsement Letter',
    ][$type] ?? ucfirst($type);

    $title = $typeLabel . ' — ' . ($user['full_name'] ?? 'Portal User');

    $pdo = getDB();
    $stmt = $pdo->prepare("
        INSERT INTO school_submissions
            (user_id, school_id, district_id, type, title, file_name, file_path, file_size, status, submitted_at)
        VALUES
            (:user_id, :school_id, :district_id, :type, :title, :file_name, :file_path, :file_size, 'pending', NOW())
    ");

    $stmt->execute([
        ':user_id' => $userId,
        ':school_id' => $schoolId,
        ':district_id' => $districtId,
        ':type' => $type,
        ':title' => $title,
        ':file_name' => $originalName,
        ':file_path' => $relativePath,
        ':file_size' => $fileSize,
    ]);

    $submissionId = (int)$pdo->lastInsertId();
    $desc = "Document uploaded | submission_id={$submissionId} | type={$type} | file={$originalName} | size={$fileSize}";
    auditLog([
        'pdo'           => $pdo,
        'user_id'       => $userId,
        'role'          => $user['role'] ?? $user['account_type'] ?? 'portal_user',
        'action'        => 'submission_upload',
        'module'        => 'school_submissions',
        'status'        => 'success',
        'description'   => $desc,
        'document_type' => $typeLabel,
        'file_name'     => $originalName,
    ]);

    jsonSuccess([
        'submission_id' => $submissionId,
        'type' => $type,
        'file_name' => $originalName,
        'file_size' => $fileSize,
    ], 'Document submitted successfully.');

} catch (Throwable $e) {
    error_log('school-portal-upload.php error: ' . $e->getMessage());
    jsonError('Server error. Please try again.', 500);
}