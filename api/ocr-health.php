<?php
/**
 * OCR Health Check Endpoint
 *
 * GET /api/ocr-health.php
 *
 * Returns runtime checks for OCR dependencies used by checklist/extract flows:
 * - shell execution availability
 * - configured binary paths
 * - executable presence/version output for Tesseract and Ghostscript
 *
 * Auth: required
 * Permission: users (admins always pass via auth middleware)
 */

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once __DIR__ . '/ocr_api_client.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}
requirePermission('users', $authUser);

function envVal(string $key): string {
    $val = $_ENV[$key] ?? ($_SERVER[$key] ?? (getenv($key) ?: ''));
    return trim((string)$val, " \t\n\r\0\x0B\"'");
}

function shellExecEnabled(): bool {
    if (!function_exists('shell_exec')) {
        return false;
    }
    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    return !in_array('shell_exec', $disabled, true);
}

function runVersionCommand(string $cmd): array {
    if (!shellExecEnabled()) {
        return ['ok' => false, 'output' => '', 'error' => 'shell_exec is disabled'];
    }

    $out = @shell_exec($cmd . ' 2>&1');
    $out = is_string($out) ? trim($out) : '';

    if ($out === '') {
        return ['ok' => false, 'output' => '', 'error' => 'No output or command failed'];
    }

    return ['ok' => true, 'output' => $out, 'error' => null];
}

function quoteCmd(string $cmd): string {
    return '"' . str_replace('"', '\\"', $cmd) . '"';
}

$isWindows = DIRECTORY_SEPARATOR === '\\';

$tesseractConfigured = envVal('TESSERACT_BIN');
$ghostscriptConfigured = envVal('GHOSTSCRIPT_BIN');

$tesseractCmd = $tesseractConfigured !== ''
    ? quoteCmd($tesseractConfigured)
    : 'tesseract';

if ($ghostscriptConfigured !== '') {
    $ghostscriptCmd = quoteCmd($ghostscriptConfigured);
} else {
    $ghostscriptCmd = $isWindows ? 'gswin64c' : 'gs';
}

$tesseractResult = runVersionCommand($tesseractCmd . ' --version');
$ghostscriptResult = runVersionCommand($ghostscriptCmd . ' -v');

$apiFallbackEnabled = ocrApiEnabled();
$apiFallbackProvider = ocrApiProviderName();

$apiFallbackOk = false;
$apiFallbackError = null;
$apiFallbackOutput = '';

if ($apiFallbackEnabled) {
    if (!function_exists('curl_init')) {
        $apiFallbackError = 'PHP cURL extension is not available';
    } elseif ($apiFallbackProvider === '' || $apiFallbackProvider === 'ocr_space') {
        $apiKey = function_exists('ocrApiEnvValue')
            ? ocrApiEnvValue('OCR_SPACE_API_KEY', '')
            : trim((string)($_ENV['OCR_SPACE_API_KEY'] ?? $_SERVER['OCR_SPACE_API_KEY'] ?? getenv('OCR_SPACE_API_KEY') ?: ''));
        if ($apiKey === '') {
            $apiFallbackError = 'OCR_SPACE_API_KEY is not configured';
        } else {
            $apiFallbackOk = true;
            $apiFallbackOutput = 'OCR.space fallback is configured and ready';
        }
    } else {
        $apiFallbackError = 'Unsupported OCR fallback provider: ' . $apiFallbackProvider;
    }
}

echo json_encode([
    'success' => true,
    'data' => [
        'shell_exec_enabled' => shellExecEnabled(),
        'config' => [
            'tesseract' => $tesseractConfigured,
            'ghostscript' => $ghostscriptConfigured,
            'api_fallback_provider' => $apiFallbackProvider,
            'tesseract_bin_env' => $tesseractConfigured,
            'ghostscript_bin_env' => $ghostscriptConfigured,
        ],
        'checks' => [
            'tesseract' => [
                'command' => $tesseractCmd . ' --version',
                'ok' => $tesseractResult['ok'],
                'output' => $tesseractResult['output'],
                'error' => $tesseractResult['error'],
            ],
            'ghostscript' => [
                'command' => $ghostscriptCmd . ' -v',
                'ok' => $ghostscriptResult['ok'],
                'output' => $ghostscriptResult['output'],
                'error' => $ghostscriptResult['error'],
            ],
            'api_fallback' => [
                'enabled' => $apiFallbackEnabled,
                'provider' => $apiFallbackProvider,
                'ok' => $apiFallbackEnabled ? $apiFallbackOk : false,
                'output' => $apiFallbackEnabled ? $apiFallbackOutput : 'OCR API fallback is disabled',
                'error' => $apiFallbackEnabled ? $apiFallbackError : null,
            ],
        ],
    ],
]);
