<?php
/**
 * /api/school-portal-permit-view.php
 *
 * Streams a single School Permit file back to the browser for INLINE preview
 * (Content-Disposition: inline), instead of the forced download that the
 * uploads/ folder's .htaccess applies to every file under it.
 *
 * This file deliberately lives in /api (outside uploads/), so that hardening
 * rule never touches it — it only ever READS from uploads/, server-side, and
 * re-serves the bytes itself with the header it wants.
 *
 * GET /api/school-portal-permit-view.php?id={submission_id}
 *
 * Access rule: the requesting user must be an authenticated portal_user
 * belonging to the SAME school as the submission (mirrors the visibility
 * rule already used by handlePermitList in school-portal-permit.php — i.e.
 * any portal user at that school can view it, not only the original uploader).
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (ob_get_level()) ob_end_clean();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

setCorsHeaders();
setSecurityHeaders();
handlePreflight();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function viewerError(string $msg, int $code = 400): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') viewerError('Method not allowed.', 405);

    $user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
    if (!$user) viewerError('Unauthorized. Please sign in.', 401);

    $accountType = $user['account_type'] ?? 'portal_user';
    if ($accountType !== 'portal_user') viewerError('Access denied.', 403);

    $submissionId = (int)($_GET['id'] ?? 0);
    if ($submissionId <= 0) viewerError('Missing or invalid file reference.', 400);

    $pdo = getDB();

    // Resolve the requesting user's school scope — same logic used in
    // handlePermitList(), so visibility here matches what they see in the UI.
    $schoolType      = strtolower(trim((string)($user['school_type'] ?? '')));
    $isPrivate       = str_contains($schoolType, 'private');
    $privateSchoolId = ((int)($user['private_school_id'] ?? 0) ?: null);
    $publicSchoolId  = ((int)($user['school_id'] ?? 0) ?: null);

    if (!$privateSchoolId && !$publicSchoolId) viewerError('No school linked to your account.', 403);

    $schoolScopeSQL    = '';
    $schoolScopeParams = [];
    if ($isPrivate && $privateSchoolId) {
        $schoolScopeSQL = 'private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } elseif (!$isPrivate && $publicSchoolId) {
        $schoolScopeSQL = 'school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId && $publicSchoolId) {
        $schoolScopeSQL = '(private_school_id = :private_school_id OR school_id = :school_id)';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    } elseif ($privateSchoolId) {
        $schoolScopeSQL = 'private_school_id = :private_school_id';
        $schoolScopeParams[':private_school_id'] = $privateSchoolId;
    } else {
        $schoolScopeSQL = 'school_id = :school_id';
        $schoolScopeParams[':school_id'] = $publicSchoolId;
    }

    $stmt = $pdo->prepare("
        SELECT id, file_name, file_path
        FROM school_submissions
        WHERE id = :id AND type = 'permit' AND {$schoolScopeSQL}
        LIMIT 1
    ");
    $params = array_merge([':id' => $submissionId], $schoolScopeParams);
    $stmt->execute($params);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) viewerError('File not found.', 404);

    // Resolve to an absolute path and make sure it's still inside the
    // uploads directory (defense against any unexpected path traversal,
    // even though file_path always comes from our own DB, never user input).
    $basePath    = dirname(__DIR__);
    $uploadsRoot = realpath($basePath . '/api/uploads/school_submissions');
    $absPath     = realpath($basePath . '/' . $row['file_path']);

    if ($uploadsRoot === false || $absPath === false || !str_starts_with($absPath, $uploadsRoot)) {
        viewerError('File not found.', 404);
    }
    if (!is_file($absPath)) viewerError('File not found.', 404);

    $originalName = (string)($row['file_name'] ?? 'document');
    $ext          = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));

    $mimeByExt = [
        'pdf'  => 'application/pdf',
        'doc'  => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    $mimeType = $mimeByExt[$ext] ?? 'application/octet-stream';

    // Stream the file back inline (the whole reason this endpoint exists).
    header('Content-Type: ' . $mimeType);
    header('Content-Disposition: inline; filename="' . addslashes($originalName) . '"');
    header('Content-Length: ' . filesize($absPath));
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, max-age=0, must-revalidate');

    readfile($absPath);
    exit;

} catch (Throwable $e) {
    error_log(sprintf('school-portal-permit-view.php [line %d]: %s', $e->getLine(), $e->getMessage()));
    viewerError('Server error. Please try again.', 500);
}
