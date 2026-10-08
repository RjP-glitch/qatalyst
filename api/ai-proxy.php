<?php
/**
 * AI Proxy Endpoint (Anthropic Messages API)
 *
 * POST /api/ai-proxy.php
 * Body: Anthropic-compatible JSON payload
 *
 * .env variables:
 *   GROQ_API_KEY=...              — Primary provider
 *   GEMINI_API_KEY=...            — Fallback 1
 *   CLOUDFLARE_API_KEY=...        — Fallback 2 (also accepts CLOUDFLARE_API_TOKEN)
 *   CLOUDFLARE_ACCOUNT_ID=...     — Required for Cloudflare (get from dash.cloudflare.com)
 *
 * Provider strategy (ai_provider field from client):
 *   "auto"       → Groq → Gemini → Cloudflare (first success wins)
 *   "groq"       → Groq only
 *   "gemini"     → Gemini only
 *   "cloudflare" → Cloudflare only
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);

if (ob_get_level()) ob_end_clean();
ob_start();

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

header('Content-Type: application/json; charset=utf-8');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function proxyError(string $message, int $code = 400): void {
    ob_end_clean();
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function normalizeApiKey(string $key): string {
    $key = trim($key, " \t\n\r\0\x0B\"'");
    if (stripos($key, 'Bearer ') === 0) {
        $key = trim(substr($key, 7));
    }
    return $key;
}

/**
 * Read a single key from the nearest .env file.
 * Handles Windows CRLF, Unix LF, and old Mac CR line endings.
 */
function readEnv(string $keyName): string {
    $candidates = [
        __DIR__ . '/../.env',
        dirname(__DIR__) . '/.env',
    ];
    foreach ($candidates as $candidate) {
        $path = realpath($candidate);
        if (!$path || !is_file($path)) continue;
        $raw = @file_get_contents($path);
        if ($raw === false) continue;
        foreach (preg_split('/\r\n|\r|\n/', $raw) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') continue;
            $parts = explode('=', $line, 2);
            if (count($parts) !== 2) continue;
            if (trim($parts[0]) === $keyName) {
                return normalizeApiKey($parts[1]);
            }
        }
    }
    return '';
}

/**
 * Read env var: .env file first, then $_ENV / $_SERVER / getenv().
 */
function getEnvKey(string $keyName): string {
    $val = readEnv($keyName);
    if ($val) return $val;
    $val = $_ENV[$keyName] ?? ($_SERVER[$keyName] ?? (getenv($keyName) ?: ''));
    return normalizeApiKey((string) $val);
}

/**
 * Convert Anthropic-format messages to OpenAI-compatible format (text only).
 */
function toOpenAiMessages(array $messages): array {
    $out = [];
    foreach ($messages as $msg) {
        $content = $msg['content'];
        if (is_array($content)) {
            $parts = [];
            foreach ($content as $block) {
                if (($block['type'] ?? '') === 'text') $parts[] = $block['text'];
            }
            $content = implode("\n", $parts);
        }
        $out[] = ['role' => $msg['role'], 'content' => (string) $content];
    }
    return $out;
}

/**
 * Wrap output in Anthropic-format response so checklist.js works unchanged.
 */
function anthropicResponse(string $provider, string $model, string $text): array {
    return [
        'id'          => 'msg_' . $provider . '_' . time(),
        'type'        => 'message',
        'role'        => 'assistant',
        'content'     => [['type' => 'text', 'text' => $text]],
        'model'       => $model,
        'stop_reason' => 'end_turn',
    ];
}

/**
 * POST via cURL. Returns [httpCode, body, curlError].
 */
function curlPost(string $url, array $headers, string $body, int $timeout = 120): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => $timeout,
    ]);
    $resp = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, $resp, $err];
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    proxyError('Method not allowed', 405);
}

$authUser = authenticate();
if (!$authUser) proxyError('Unauthorized', 401);
if (!hasPermission('checklist', $authUser)) proxyError('Access denied.', 403);

$payload = json_decode(file_get_contents('php://input'), true);
if (!is_array($payload))                                             proxyError('Invalid JSON body');
if (empty($payload['model']))                                        proxyError('Missing field: model');
if (empty($payload['messages']) || !is_array($payload['messages'])) proxyError('Missing field: messages');

$maxTokens = max(1, min(4096, (int) ($payload['max_tokens'] ?? 1024)));

// Validate requested provider — defaults to 'auto'
$provider = strtolower(trim($payload['ai_provider'] ?? 'auto'));
if (!in_array($provider, ['auto', 'groq', 'gemini', 'cloudflare'], true)) {
    $provider = 'auto';
}

$messages = toOpenAiMessages($payload['messages']);

// $result will hold ['provider', 'model', 'text'] on first success
$result = null;

// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY: GROQ  (llama-3.1-8b-instant — fast, low TPM, avoids rate limits)
// ─────────────────────────────────────────────────────────────────────────────

if ($result === null && in_array($provider, ['auto', 'groq'], true)) {

    $groqKey = getEnvKey('GROQ_API_KEY');

    if (!$groqKey && $provider === 'groq') {
        proxyError('Groq selected but GROQ_API_KEY is not set in .env.', 503);
    }

    if ($groqKey) {
        // Use versatile 70b for accuracy; stays within free TPM if requests are spaced
        $groqModel = 'llama-3.3-70b-versatile';

        [$code, $body, $err] = curlPost(
            'https://api.groq.com/openai/v1/chat/completions',
            [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $groqKey,
            ],
            json_encode([
                'model'       => $groqModel,
                'messages'    => $messages,
                'max_tokens'  => $maxTokens,
                'temperature' => 0.1,
            ], JSON_UNESCAPED_SLASHES)
        );

        if (!$err && $code < 400) {
            $parsed = json_decode($body, true);
            $text   = $parsed['choices'][0]['message']['content'] ?? '';
            if ($text !== '') {
                $result = ['provider' => 'groq', 'model' => $groqModel, 'text' => $text];
            }
        }

        // If Groq was specifically requested and it failed, return the error immediately
        if ($result === null && $provider === 'groq') {
            $upstream = json_decode($body, true);
            $msg      = $upstream['error']['message'] ?? 'Unknown Groq error';
            proxyError('Groq error: ' . $msg, $code ?: 502);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK 1: GEMINI  (gemini-1.5-flash — 1,500 req/day free)
// Get key: https://aistudio.google.com/app/apikey
// ─────────────────────────────────────────────────────────────────────────────

if ($result === null && in_array($provider, ['auto', 'gemini'], true)) {

    $geminiKey = getEnvKey('GEMINI_API_KEY');

    if (!$geminiKey && $provider === 'gemini') {
        proxyError('Gemini selected but GEMINI_API_KEY is not set in .env.', 503);
    }

    if ($geminiKey) {
        // Gemini uses "user" / "model" roles (not "assistant")
        $geminiContents = [];
        foreach ($messages as $msg) {
            $geminiContents[] = [
                'role'  => $msg['role'] === 'assistant' ? 'model' : 'user',
                'parts' => [['text' => $msg['content']]],
            ];
        }

        $geminiModel = 'gemini-2.0-flash';

        [$code, $body, $err] = curlPost(
            'https://generativelanguage.googleapis.com/v1beta/models/'
                . $geminiModel . ':generateContent?key=' . $geminiKey,
            ['Content-Type: application/json'],
            json_encode([
                'contents'         => $geminiContents,
                'generationConfig' => [
                    'maxOutputTokens' => $maxTokens,
                    'temperature'     => 0.1,
                ],
            ], JSON_UNESCAPED_SLASHES)
        );

        if (!$err && $code < 400) {
            $parsed = json_decode($body, true);
            $text   = $parsed['candidates'][0]['content']['parts'][0]['text'] ?? '';
            if ($text !== '') {
                $result = ['provider' => 'gemini', 'model' => $geminiModel, 'text' => $text];
            }
        }

        if ($result === null && $provider === 'gemini') {
            $upstream = json_decode($body, true);
            $msg      = $upstream['error']['message'] ?? 'Unknown Gemini error';
            proxyError('Gemini error: ' . $msg, $code ?: 502);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK 2: CLOUDFLARE WORKERS AI  (@cf/meta/llama-3.1-8b-instruct)
// Needs both CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID in .env
// Get Account ID: dash.cloudflare.com → right sidebar
// ─────────────────────────────────────────────────────────────────────────────

if ($result === null && in_array($provider, ['auto', 'cloudflare'], true)) {

    // Accept both CLOUDFLARE_API_KEY and legacy CLOUDFLARE_API_TOKEN
    $cfKey = getEnvKey('CLOUDFLARE_API_KEY') ?: getEnvKey('CLOUDFLARE_API_TOKEN');
    $cfAcc = getEnvKey('CLOUDFLARE_ACCOUNT_ID');

    if (!$cfKey && $provider === 'cloudflare') {
        proxyError('Cloudflare selected but CLOUDFLARE_API_KEY is not set in .env.', 503);
    }

    if ($cfKey && !$cfAcc && $provider === 'cloudflare') {
        proxyError(
            'Cloudflare selected but CLOUDFLARE_ACCOUNT_ID is not set in .env. ' .
            'Find it on the right sidebar at dash.cloudflare.com.',
            503
        );
    }

    if ($cfKey && $cfAcc) {
        // Use a larger, more accurate model for complex calendar/compliance analysis
        $cfModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

        [$code, $body, $err] = curlPost(
            'https://api.cloudflare.com/client/v4/accounts/' . $cfAcc . '/ai/run/' . $cfModel,
            [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $cfKey,
            ],
            json_encode([
                'messages'    => $messages,
                'max_tokens'  => $maxTokens,
                'temperature' => 0.1,
            ], JSON_UNESCAPED_SLASHES)
        );

        if (!$err && $code < 400) {
            $parsed = json_decode($body, true);
            $text   = $parsed['result']['response'] ?? '';
            if ($text !== '') {
                $result = ['provider' => 'cloudflare', 'model' => $cfModel, 'text' => $text];
            }
        }

        if ($result === null && $provider === 'cloudflare') {
            $upstream = json_decode($body, true);
            $msg      = $upstream['errors'][0]['message'] ?? ($upstream['error'] ?? 'Unknown Cloudflare error');
            proxyError('Cloudflare error: ' . $msg, $code ?: 502);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL PROVIDERS FAILED OR UNCONFIGURED
// ─────────────────────────────────────────────────────────────────────────────

if ($result === null) {
    proxyError(
        'All AI providers failed or are unconfigured. ' .
        'Check GROQ_API_KEY, GEMINI_API_KEY, and CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID in your .env file.',
        503
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS — return Anthropic-format response (checklist.js works unchanged)
// ─────────────────────────────────────────────────────────────────────────────

ob_end_clean();
http_response_code(200);
echo json_encode(
    anthropicResponse($result['provider'], $result['model'], $result['text']),
    JSON_UNESCAPED_SLASHES
);
?>
