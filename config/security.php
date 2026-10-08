<?php
/**
 * Security Configuration & Helpers
 * Include this file in all API endpoints for consistent security
 */

// ─── Security Headers ─────────────────────────────────────────────────────────
function setSecurityHeaders(): void {
    // Prevent clickjacking
    header('X-Frame-Options: DENY');
    // Prevent MIME type sniffing
    header('X-Content-Type-Options: nosniff');
    // Enable XSS filter
    header('X-XSS-Protection: 1; mode=block');
    // Referrer policy
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // Content Security Policy
    header("Content-Security-Policy: default-src 'self'");
}

// ─── CORS Configuration ───────────────────────────────────────────────────────
function setCorsHeaders(): void {
    $is_dev = in_array($_SERVER['SERVER_NAME'] ?? '', ['localhost', '127.0.0.1'], true);
    
    $allowed_origins = $is_dev
        ? ['http://localhost', 'http://127.0.0.1']
        : [
            'https://mistyrose-wolverine-463441.hostingersite.com',     // ← Replace with your actual domain
            'https://www.mistyrose-wolverine-463441.hostingersite.com', // ← Replace with your actual domain
        ];
    
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    
    if (in_array($origin, $allowed_origins, true)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Access-Control-Allow-Credentials: true');
    } else {
        // For same-origin requests (no Origin header), allow the request
        // But for cross-origin from unknown origins, block
        if (!empty($origin)) {
            header('Access-Control-Allow-Origin: null');
        }
    }
    
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Vary: Origin');
}

// ─── Handle OPTIONS preflight ─────────────────────────────────────────────────
function handlePreflight(): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(200);
        exit;
    }
}

// ─── File Upload Security ─────────────────────────────────────────────────────
const ALLOWED_FILE_EXTENSIONS = [
    'document' => ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'],
    'image'    => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
    'archive'  => ['zip', 'rar', '7z'],
];

const DANGEROUS_EXTENSIONS = [
    'php', 'php3', 'php4', 'php5', 'php7', 'phtml', 'phar',
    'exe', 'com', 'bat', 'cmd', 'sh', 'bash',
    'js', 'jsp', 'asp', 'aspx', 'cgi', 'pl', 'py',
    'htaccess', 'htpasswd', 'ini', 'config',
];

/**
 * Validate uploaded file extension
 * @param string $filename Original filename
 * @param array $allowed Allowed extension categories: 'document', 'image', 'archive', or array of extensions
 * @return bool True if safe, false if dangerous
 */
function isAllowedFileExtension(string $filename, array $allowed = ['document', 'image']): bool {
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    
    // Always block dangerous extensions
    if (in_array($ext, DANGEROUS_EXTENSIONS, true)) {
        return false;
    }
    
    // Check against allowed list
    $allowedExts = [];
    foreach ($allowed as $category) {
        if (isset(ALLOWED_FILE_EXTENSIONS[$category])) {
            $allowedExts = array_merge($allowedExts, ALLOWED_FILE_EXTENSIONS[$category]);
        } elseif (is_string($category)) {
            $allowedExts[] = $category;
        }
    }
    
    return in_array($ext, $allowedExts, true);
}

/**
 * Sanitize filename to prevent path traversal
 * @param string $filename Original filename
 * @return string Safe filename
 */
function sanitizeFilename(string $filename): string {
    // Remove path components
    $filename = basename($filename);
    // Remove null bytes
    $filename = str_replace("\0", '', $filename);
    // Remove special characters except alphanumeric, dash, underscore, dot
    $name = pathinfo($filename, PATHINFO_FILENAME);
    $ext = pathinfo($filename, PATHINFO_EXTENSION);
    $safeName = preg_replace('/[^a-zA-Z0-9_.-]/', '_', $name);
    return $safeName . ($ext ? '.' . strtolower($ext) : '');
}

/**
 * Validate file MIME type matches extension
 * @param string $tmpPath Uploaded file temporary path
 * @param string $filename Original filename
 * @return bool True if MIME type matches extension
 */
function validateFileMimeType(string $tmpPath, string $filename): bool {
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mimeType = finfo_file($finfo, $tmpPath);
    finfo_close($finfo);
    
    $mimeMap = [
        'pdf'  => ['application/pdf'],
        'doc'  => ['application/msword'],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        'xls'  => ['application/vnd.ms-excel'],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        'jpg'  => ['image/jpeg'],
        'jpeg' => ['image/jpeg'],
        'png'  => ['image/png'],
        'gif'  => ['image/gif'],
        'txt'  => ['text/plain'],
        'csv'  => ['text/csv', 'text/plain', 'application/csv'],
        'zip'  => ['application/zip', 'application/x-zip-compressed'],
    ];
    
    if (!isset($mimeMap[$ext])) {
        return true; // Unknown extension, allow (extension check already passed)
    }
    
    return in_array($mimeType, $mimeMap[$ext], true);
}

// ─── Input Sanitization ───────────────────────────────────────────────────────
/**
 * Sanitize string input
 */
function sanitizeInput(string $input, int $maxLength = 1000): string {
    $input = trim($input);
    $input = substr($input, 0, $maxLength);
    return $input;
}

/**
 * Sanitize integer input
 */
function sanitizeInt($input): int {
    return (int) filter_var($input, FILTER_SANITIZE_NUMBER_INT);
}

// ─── Rate Limiting Helper ─────────────────────────────────────────────────────
/**
 * Simple rate limiter (requires login_attempts table)
 */
function checkRateLimit(PDO $pdo, string $action, int $maxAttempts = 60, int $windowMinutes = 1): bool {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    
    $stmt = $pdo->prepare("
        SELECT COUNT(*) as count 
        FROM login_attempts 
        WHERE ip_address = ? 
        AND attempted_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
    ");
    $stmt->execute([$ip, $windowMinutes]);
    $result = $stmt->fetch(PDO::FETCH_ASSOC);
    
    return ($result['count'] ?? 0) < $maxAttempts;
}