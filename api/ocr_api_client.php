<?php
/**
 * Shared OCR API fallback client.
 *
 * Purpose:
 * - Allow OCR to work on shared hosting where local binaries are unavailable.
 * - Keep local OCR as primary and use API OCR as fallback.
 *
 * Supported providers:
 * - ocr_space
 */

if (!function_exists('ocrApiEnvValue')) {
    function ocrApiEnvValue(string $key, string $default = ''): string
    {
        $val = $_ENV[$key] ?? ($_SERVER[$key] ?? (getenv($key) ?: ''));
        $val = trim((string)$val, " \t\n\r\0\x0B\"'");
        if ($val !== '') {
            return $val;
        }

        static $envCache = null;
        if ($envCache === null) {
            $envCache = [];
            $candidates = [
                __DIR__ . '/../.env',
                dirname(__DIR__) . '/.env',
            ];

            foreach ($candidates as $candidate) {
                $path = realpath($candidate);
                if (!$path || !is_file($path)) {
                    continue;
                }

                $raw = @file_get_contents($path);
                if ($raw === false) {
                    continue;
                }

                foreach (preg_split('/\r\n|\r|\n/', $raw) as $line) {
                    $line = trim($line);
                    if ($line === '' || $line[0] === '#') {
                        continue;
                    }
                    $parts = explode('=', $line, 2);
                    if (count($parts) !== 2) {
                        continue;
                    }
                    $envCache[trim($parts[0])] = trim($parts[1], " \t\n\r\0\x0B\"'");
                }
                break;
            }
        }

        return (string)($envCache[$key] ?? $default);
    }
}

if (!function_exists('ocrApiToBool')) {
    function ocrApiToBool(string $value, bool $default = false): bool
    {
        $v = strtolower(trim($value));
        if ($v === '') {
            return $default;
        }
        return in_array($v, ['1', 'true', 'yes', 'on'], true);
    }
}

if (!function_exists('ocrApiEnabled')) {
    function ocrApiEnabled(): bool
    {
        $explicit = ocrApiEnvValue('OCR_FALLBACK_ENABLED', '');
        if ($explicit !== '') {
            return ocrApiToBool($explicit, false);
        }

        // If provider + key are configured, treat fallback as enabled.
        $provider = strtolower(ocrApiEnvValue('OCR_PROVIDER', ''));
        $hasProvider = in_array($provider, ['ocr_space', 'ocrspace'], true);
        $hasKey = ocrApiEnvValue('OCR_SPACE_API_KEY', '') !== '';

        return $hasProvider && $hasKey;
    }
}

if (!function_exists('ocrApiProviderName')) {
    function ocrApiProviderName(): string
    {
        $provider = strtolower(ocrApiEnvValue('OCR_PROVIDER', ''));
        if ($provider === 'ocrspace') {
            return 'ocr_space';
        }
        return $provider;
    }
}

if (!function_exists('ocrApiExtractTextFromFile')) {
    /**
     * Return format:
     * ['ok'=>bool, 'text'=>string, 'pages'=>array<int,string>, 'provider'=>string, 'error'=>string|null]
     */
    function ocrApiExtractTextFromFile(string $filePath): array
    {
        if (!is_file($filePath)) {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => ocrApiProviderName(),
                'error' => 'OCR API fallback file does not exist',
            ];
        }

        if (!ocrApiEnabled()) {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => ocrApiProviderName(),
                'error' => 'OCR API fallback is disabled',
            ];
        }

        $provider = ocrApiProviderName();
        if ($provider === '' || $provider === 'ocr_space') {
            return ocrApiExtractWithOcrSpace($filePath);
        }

        return [
            'ok' => false,
            'text' => '',
            'pages' => [],
            'provider' => $provider,
            'error' => 'Unsupported OCR provider: ' . $provider,
        ];
    }
}

if (!function_exists('ocrApiExtractWithOcrSpace')) {
    function ocrApiExtractWithOcrSpace(string $filePath): array
    {
        $apiKey = ocrApiEnvValue('OCR_SPACE_API_KEY', '');
        if ($apiKey === '') {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => 'ocr_space',
                'error' => 'OCR_SPACE_API_KEY is not set',
            ];
        }

        if (!function_exists('curl_init')) {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => 'ocr_space',
                'error' => 'PHP cURL extension is required for OCR API fallback',
            ];
        }

        $endpoint = ocrApiEnvValue('OCR_SPACE_ENDPOINT', 'https://api.ocr.space/parse/image');
        $language = ocrApiEnvValue('OCR_SPACE_LANGUAGE', 'eng');
        $engine = ocrApiEnvValue('OCR_SPACE_ENGINE', '2');
        $timeout = (int)ocrApiEnvValue('OCR_SPACE_TIMEOUT', '120');

        $postFields = [
            'apikey' => $apiKey,
            'language' => $language,
            'isOverlayRequired' => ocrApiToBool(ocrApiEnvValue('OCR_SPACE_OVERLAY', 'false'), false) ? 'true' : 'false',
            'scale' => ocrApiToBool(ocrApiEnvValue('OCR_SPACE_SCALE', 'true'), true) ? 'true' : 'false',
            'isTable' => ocrApiToBool(ocrApiEnvValue('OCR_SPACE_TABLE', 'false'), false) ? 'true' : 'false',
            'OCREngine' => $engine,
            'file' => new CURLFile($filePath, mime_content_type($filePath) ?: 'application/octet-stream', basename($filePath)),
        ];

        $ch = curl_init($endpoint);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $postFields,
            CURLOPT_TIMEOUT => max(15, $timeout),
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);

        $raw = curl_exec($ch);
        $curlErr = curl_error($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($raw === false || $raw === null) {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => 'ocr_space',
                'error' => 'OCR API request failed: ' . ($curlErr ?: 'unknown cURL error'),
            ];
        }

        $json = json_decode($raw, true);
        if (!is_array($json)) {
            return [
                'ok' => false,
                'text' => '',
                'pages' => [],
                'provider' => 'ocr_space',
                'error' => 'OCR API returned invalid JSON (HTTP ' . $httpCode . ')',
            ];
        }

        $apiError = '';
        if (!empty($json['ErrorMessage'])) {
            $apiError = is_array($json['ErrorMessage']) ? implode('; ', $json['ErrorMessage']) : (string)$json['ErrorMessage'];
        }
        if ($apiError === '' && !empty($json['ErrorDetails'])) {
            $apiError = (string)$json['ErrorDetails'];
        }

        $parsedResults = $json['ParsedResults'] ?? [];
        $pages = [];
        $textParts = [];

        if (is_array($parsedResults)) {
            foreach (array_values($parsedResults) as $index => $result) {
                $parsedText = trim((string)($result['ParsedText'] ?? ''));
                $pageNum = $index + 1;
                $pages[$pageNum] = $parsedText;
                if ($parsedText !== '') {
                    $textParts[] = $parsedText;
                }
            }
        }

        $combinedText = trim(implode("\n\n", $textParts));

        $isErrored = !empty($json['IsErroredOnProcessing']);
        if ($isErrored && $apiError === '') {
            $apiError = 'OCR provider reported a processing error';
        }

        if ($combinedText === '') {
            $exitCode = (int)($json['OCRExitCode'] ?? 0);
            if ($apiError === '' && $exitCode !== 1) {
                $apiError = 'OCR provider returned no text (exit code ' . $exitCode . ')';
            }

            return [
                'ok' => false,
                'text' => '',
                'pages' => $pages,
                'provider' => 'ocr_space',
                'error' => $apiError !== '' ? $apiError : 'OCR provider returned no text',
            ];
        }

        return [
            'ok' => true,
            'text' => $combinedText,
            'pages' => $pages,
            'provider' => 'ocr_space',
            'error' => null,
        ];
    }
}
