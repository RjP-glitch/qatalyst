<?php
/**
 * extract.php — Document Word Extractor Backend
 *
 * Supports: PDF (via smalot/pdfparser + Tesseract OCR), DOCX (via phpoffice/phpword), images (JPG/JPEG/PNG/WEBP)
 *
 * NEW: Returns per-page quality data so the frontend can show a live scan preview
 *      and warn users when pages are blurred / unreadable.
 *
 * Setup:
 *   composer require smalot/pdfparser phpoffice/phpword
 */

// Detect streaming mode (frontend passes ?stream=1)
$STREAM_MODE = isset($_GET['stream']) && $_GET['stream'] === '1';

if ($STREAM_MODE) {
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-cache');
    header('X-Accel-Buffering: no');  // Nginx
    // Disable all output buffering so each flush reaches the client immediately
    while (ob_get_level())
        ob_end_clean();
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    ini_set('zlib.output_compression', '0');
    ini_set('implicit_flush', '1');
    ob_implicit_flush(true);
} else {
    header('Content-Type: application/json');
}

require_once dirname(__DIR__) . '/config/security.php';
require_once __DIR__ . '/ocr_api_client.php';
setCorsHeaders();
setSecurityHeaders();

// ─── Config ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
];
const ALLOWED_EXT = ['pdf', 'docx', 'jpg', 'jpeg', 'png', 'webp'];

// Default fallback paths to external tools (can be overridden by env vars)
const DEFAULT_GHOSTSCRIPT_BIN = 'C:\\Program Files\\gs\\gs10.06.0\\bin\\gswin64c.exe';
const DEFAULT_TESSERACT_BIN = 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

// Scanner watermarks to ignore when deciding if a PDF is image-based
const SCANNER_WATERMARKS = [
    'camscanner',
    'cam scanner',
    'cs camscanner',
    'scanned by camscanner',
    'scanned with camscanner',
];

const SCANNER_WATERMARK_PATTERNS = [
    '/\bscanned\s+(?:with|by)\s+cam\s*scanner\b/iu',
    '/\bcs\s*cam\s*scanner\b/iu',
    '/\bcam\s*scanner\b/iu',
    '/\bcamscanner\b/iu',
];

/**
 * Read key from local .env (if present), then from process env.
 */
function getEnvValue(string $key): string
{
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
            if (trim($parts[0]) === $key) {
                return trim($parts[1], " \t\n\r\0\x0B\"'");
            }
        }
    }

    $val = $_ENV[$key] ?? ($_SERVER[$key] ?? (getenv($key) ?: ''));
    return trim((string)$val, " \t\n\r\0\x0B\"'");
}

function getConfiguredBinaryPath(string $key, string $defaultPath): string
{
    $value = getEnvValue($key);
    return $value !== '' ? $value : $defaultPath;
}

// Effective binary paths (env-first, fallback to defaults)
define('GHOSTSCRIPT_BIN', getConfiguredBinaryPath('GHOSTSCRIPT_BIN', DEFAULT_GHOSTSCRIPT_BIN));
define('TESSERACT_BIN', getConfiguredBinaryPath('TESSERACT_BIN', DEFAULT_TESSERACT_BIN));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Emit a single NDJSON event line and flush it to the browser immediately.
 * Only used in streaming mode.
 */
function streamEvent(array $data): void
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE) . "\n";
    if (function_exists('ob_flush') && ob_get_level())
        @ob_flush();
    flush();
}

function jsonError(string $msg, int $code = 400): void
{
    global $STREAM_MODE;
    if ($STREAM_MODE) {
        streamEvent(['event' => 'error', 'message' => $msg]);
        exit;
    }
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function jsonSuccess(string $text, array $pages = [], array $scanQuality = []): void
{
    echo json_encode([
        'text' => $text,
        'length' => strlen($text),
        'pages' => $pages,        // per-page quality breakdown
        'scan_quality' => $scanQuality,  // aggregate summary
    ]);
    exit;
}

// ─── Validation ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonError('Only POST requests are accepted.', 405);
}
if (empty($_FILES['document'])) {
    jsonError('No file uploaded. Use field name "document".');
}

$file = $_FILES['document'];

if ($file['error'] !== UPLOAD_ERR_OK) {
    $phpErrors = [
        UPLOAD_ERR_INI_SIZE => 'File exceeds server upload limit (upload_max_filesize).',
        UPLOAD_ERR_FORM_SIZE => 'File exceeds form size limit.',
        UPLOAD_ERR_PARTIAL => 'File was only partially uploaded.',
        UPLOAD_ERR_NO_FILE => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Missing server temp folder.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk.',
        UPLOAD_ERR_EXTENSION => 'Upload blocked by a PHP extension.',
    ];
    jsonError($phpErrors[$file['error']] ?? 'Unknown upload error.');
}

if ($file['size'] > MAX_FILE_SIZE) {
    jsonError('File exceeds the 20 MB limit.');
}

$originalName = $file['name'];
$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
$tmpPath = $file['tmp_name'];

if (!in_array($ext, ALLOWED_EXT, true)) {
    jsonError('Unsupported file type. Allowed: PDF, DOCX, JPG, JPEG, PNG, WEBP.');
}

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mimeType = $finfo->file($tmpPath);
if (!in_array($mimeType, ALLOWED_MIME, true)) {
    jsonError('MIME type mismatch. File does not appear to be a valid PDF, DOCX, or supported image.');
}

// ─── Autoloader ──────────────────────────────────────────────────────────────
$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!file_exists($autoload)) {
    jsonError(
        'Composer dependencies not installed. Run: composer require smalot/pdfparser phpoffice/phpword',
        500
    );
}
require_once $autoload;

// ─── Extraction ──────────────────────────────────────────────────────────────
$text = '';
$pages = [];   // will be populated per-page for PDFs

if ($STREAM_MODE) {
    // ═══════════════════════════════════════════════════════════════════════
    //  STREAMING PATH — emit NDJSON events page-by-page so the frontend
    //  can show a live scanning animation.
    // ═══════════════════════════════════════════════════════════════════════
    try {
        if ($ext === 'pdf') {
            [$text, $pages] = extractPdfStreaming($tmpPath);
        } elseif ($ext === 'docx') {
            $text = extractDocx($tmpPath);
            $text = cleanText($text);
            $pages = buildDocxPageQuality($text);

            // For DOCX we can't do per-page streaming, so emit start → page → done
            streamEvent(['event' => 'start', 'total_pages' => 1]);
            streamEvent([
                'event' => 'page',
                'page' => 1,
                'total' => 1,
                'text' => $text,
                'quality' => $pages[0]['quality'] ?? assessPageQuality($text),
            ]);
        } elseif (isImageExtension($ext)) {
            $text = extractImageText($tmpPath);
            $text = cleanText($text);
            $pages = buildImagePageQuality($text);

            // Images are treated as single-page inputs.
            streamEvent(['event' => 'start', 'total_pages' => 1]);
            streamEvent([
                'event' => 'page',
                'page' => 1,
                'total' => 1,
                'text' => $text,
                'quality' => $pages[0]['quality'] ?? assessPageQuality($text),
            ]);
        }

        if ($ext === 'pdf') {
            $text = cleanText($text);
        }

        $scanQuality = computeOverallQuality($pages);

        if (empty(trim($text))) {
            streamEvent([
                'event' => 'error',
                'message' => 'No readable text found in the document.',
                'pages' => $pages,
                'scan_quality' => $scanQuality,
            ]);
            exit;
        }

        // Final "done" event with everything the frontend needs
        streamEvent([
            'event' => 'done',
            'text' => $text,
            'length' => strlen($text),
            'pages' => $pages,
            'scan_quality' => $scanQuality,
        ]);
    } catch (Throwable $e) {
        streamEvent(['event' => 'error', 'message' => 'Extraction failed: ' . $e->getMessage()]);
    }
    exit;
}

// ═══════════════════════════════════════════════════════════════════════════
//  NON-STREAMING PATH — original behavior, single JSON response
// ═══════════════════════════════════════════════════════════════════════════
try {
    if ($ext === 'pdf') {
        [$text, $pages] = extractPdf($tmpPath);
    } elseif ($ext === 'docx') {
        $text = extractDocx($tmpPath);
        $pages = buildDocxPageQuality($text);
    } elseif (isImageExtension($ext)) {
        $text = extractImageText($tmpPath);
        $pages = buildImagePageQuality($text);
    }
} catch (Throwable $e) {
    jsonError('Extraction failed: ' . $e->getMessage(), 500);
}

$text = cleanText($text);

// Recompute quality on cleaned text for single-page formats
if ($ext === 'docx') {
    $pages = buildDocxPageQuality($text);
} elseif (isImageExtension($ext)) {
    $pages = buildImagePageQuality($text);
}

$scanQuality = computeOverallQuality($pages);

if (empty(trim($text))) {
    // Still return quality data so frontend can explain WHY it failed
    http_response_code(422);
    echo json_encode([
        'error' => 'No readable text found in the document. The file may be image-only, encrypted, or heavily blurred.',
        'pages' => $pages,
        'scan_quality' => $scanQuality,
    ]);
    exit;
}

jsonSuccess($text, $pages, $scanQuality);


// ─── Page Quality Assessment ──────────────────────────────────────────────────
/**
 * Assess a single page's text quality.
 * Returns: ['status', 'reason', 'char_count', 'word_count']
 */
function assessPageQuality(string $pageText): array
{
    $trimmed = trim($pageText);
    $charCount = strlen($trimmed);
    $wordCount = str_word_count($trimmed);

    // Count non-ASCII/garbled bytes (common in blurred-scan OCR output)
    $garbled = preg_match_all('/[^\x09\x0A\x20-\x7E]/', $trimmed);
    $ratio = $charCount > 0 ? ($garbled / $charCount) : 1.0;

    $status = 'ok';
    $reason = null;

    if ($charCount < 30) {
        $status = 'unreadable';
        $reason = 'No meaningful text detected — page may be a scanned image, blank, or fully blurred.';
    } elseif ($ratio > 0.20) {
        $status = 'blurred';
        $reason = sprintf(
            'High garbled-character ratio (%.0f%%) — page may be blurred, low-resolution, or a scanned image OCR could not read cleanly.',
            $ratio * 100
        );
    } elseif ($wordCount < 5) {
        $status = 'sparse';
        $reason = 'Very few words detected (' . $wordCount . ') — content may be mostly images, tables, or decorative elements.';
    }

    return [
        'status' => $status,
        'reason' => $reason,
        'char_count' => $charCount,
        'word_count' => $wordCount,
    ];
}

/**
 * Roll-up: aggregate per-page quality into one summary object.
 */
function computeOverallQuality(array $pages): array
{
    if (empty($pages)) {
        return [
            'total_pages' => 0,
            'unreadable' => 0,
            'unreadable_pct' => 100,
            'scannable' => false,
            'warning' => 'No pages were found in the document.',
        ];
    }

    $bad = array_filter($pages, fn($p) => $p['quality']['status'] !== 'ok');
    $pct = count($bad) / count($pages);

    $warning = null;
    if ($pct >= 0.5) {
        $warning = round($pct * 100) . '% of pages have quality issues — document may not be reliably scannable. Upload a cleaner copy for accurate AI results.';
    } elseif ($pct >= 0.3) {
        $warning = round($pct * 100) . '% of pages have quality issues — AI results may be incomplete for the affected pages.';
    }

    return [
        'total_pages' => count($pages),
        'unreadable' => count($bad),
        'unreadable_pct' => round($pct * 100),
        'scannable' => $pct < 0.5,
        'warning' => $warning,
    ];
}

/**
 * Build a single-element pages array for DOCX (no per-page split available).
 */
function buildDocxPageQuality(string $text): array
{
    return [
        [
            'page' => 1,
            'quality' => assessPageQuality($text),
        ]
    ];
}

function buildImagePageQuality(string $text): array
{
    return [
        [
            'page' => 1,
            'quality' => assessPageQuality($text),
        ]
    ];
}

function isImageExtension(string $ext): bool
{
    return in_array(strtolower($ext), ['jpg', 'jpeg', 'png', 'webp'], true);
}

function extractImageText(string $path): string
{
    $errors = [];
    $tempEnhancedImage = createOcrFriendlyImageCopy($path);
    $candidates = [$path];
    if ($tempEnhancedImage !== '') {
        $candidates[] = $tempEnhancedImage;
    }

    try {
        foreach ($candidates as $index => $candidatePath) {
            $attemptLabel = $index === 0 ? 'original image' : 'enhanced image';
            $attemptError = null;
            $text = extractTextFromImageCandidate($candidatePath, $attemptError);

            if (trim($text) !== '') {
                return trim($text);
            }

            if ($attemptError !== null && $attemptError !== '') {
                $errors[] = $attemptLabel . ': ' . $attemptError;
            }
        }
    } finally {
        if ($tempEnhancedImage !== '' && is_file($tempEnhancedImage)) {
            @unlink($tempEnhancedImage);
        }
    }

    $detail = !empty($errors) ? ' Details: ' . implode('; ', $errors) : '';
    throw new Exception(
        'Image OCR returned no readable text.' . $detail .
        ' Try a sharper image (crop to text area, 1200px+ width, high contrast).'
    );
}

function extractTextFromImageCandidate(string $imagePath, ?string &$error = null): string
{
    $error = null;

    if (file_exists(TESSERACT_BIN)) {
        try {
            $text = (new \thiagoalessio\TesseractOCR\TesseractOCR($imagePath))
                ->executable(TESSERACT_BIN)
                ->lang('eng')
                ->psm(3)
                ->oem(1)
                ->run();

            $trimmed = trim((string)$text);
            if ($trimmed !== '') {
                return $trimmed;
            }

            $error = 'Local OCR returned no text';
        } catch (Throwable $e) {
            $error = 'Local OCR failed: ' . $e->getMessage();
        }
    }

    if (ocrApiEnabled()) {
        $result = ocrApiExtractTextFromFile($imagePath);
        if ($result['ok'] ?? false) {
            $text = trim((string)($result['text'] ?? ''));
            if ($text !== '') {
                return $text;
            }

            $error = 'OCR API returned no text';
            return '';
        }

        $error = (string)($result['error'] ?? 'OCR API fallback failed');
        return '';
    }

    if ($error === null) {
        $error = 'Local OCR unavailable and OCR API fallback disabled';
    }

    return '';
}

function createOcrFriendlyImageCopy(string $path): string
{
    if (!function_exists('getimagesize')) {
        return '';
    }

    $meta = @getimagesize($path);
    if (!is_array($meta) || empty($meta['mime'])) {
        return '';
    }

    $mime = strtolower((string)$meta['mime']);
    $source = null;

    if ($mime === 'image/jpeg' && function_exists('imagecreatefromjpeg')) {
        $source = @imagecreatefromjpeg($path);
    } elseif ($mime === 'image/png' && function_exists('imagecreatefrompng')) {
        $source = @imagecreatefrompng($path);
    } elseif ($mime === 'image/webp' && function_exists('imagecreatefromwebp')) {
        $source = @imagecreatefromwebp($path);
    }

    if ($source === false || $source === null) {
        return '';
    }

    $width = imagesx($source);
    $height = imagesy($source);
    if ($width <= 0 || $height <= 0) {
        imagedestroy($source);
        return '';
    }

    $scale = $width < 1400 ? 2 : 1;
    $newWidth = min(3200, (int)round($width * $scale));
    $newHeight = min(3200, (int)round($height * $scale));

    $work = imagecreatetruecolor($newWidth, $newHeight);
    imagecopyresampled($work, $source, 0, 0, 0, 0, $newWidth, $newHeight, $width, $height);
    imagedestroy($source);

    imagefilter($work, IMG_FILTER_GRAYSCALE);
    imagefilter($work, IMG_FILTER_CONTRAST, -20);
    imagefilter($work, IMG_FILTER_BRIGHTNESS, 10);

    $tmp = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ocr_img_' . uniqid('', true) . '.png';
    $ok = @imagepng($work, $tmp, 9);
    imagedestroy($work);

    if (!$ok || !is_file($tmp)) {
        return '';
    }

    return $tmp;
}

/**
 * Get OCR text by page (1-based) using configured OCR API fallback.
 */
function getOcrApiPageTextMap(string $path): array
{
    $result = ocrApiExtractTextFromFile($path);
    if (!($result['ok'] ?? false)) {
        return [];
    }

    $pages = $result['pages'] ?? [];
    if (!is_array($pages) || empty($pages)) {
        $text = trim((string)($result['text'] ?? ''));
        return $text !== '' ? [1 => $text] : [];
    }

    $normalized = [];
    foreach ($pages as $pageNum => $pageText) {
        $num = (int)$pageNum;
        if ($num <= 0) {
            continue;
        }
        $normalized[$num] = trim((string)$pageText);
    }
    return $normalized;
}

/**
 * Run OCR on the whole source file through API fallback.
 */
function extractFileWithOcrApi(string $path, ?string &$error = null): string
{
    $result = ocrApiExtractTextFromFile($path);
    if (!($result['ok'] ?? false)) {
        $error = (string)($result['error'] ?? 'OCR API fallback failed');
        return '';
    }
    $error = null;
    return trim((string)($result['text'] ?? ''));
}


// ─── PDF Extraction ───────────────────────────────────────────────────────────
/**
 * Returns [string $fullText, array $pages]
 * where $pages = [['page'=>N, 'quality'=>[...]], ...]
 */
function extractPdf(string $path): array
{
    $parser = new \Smalot\PdfParser\Parser();
    $pdf = $parser->parseFile($path);

    $fullText = '';
    $pages = [];
    $apiPageMap = null;

    foreach ($pdf->getPages() as $i => $page) {
        $pageText = $page->getText();
        $pageText = stripScannerWatermarks($pageText);

        // Strip known scanner watermarks before checking real content
        $cleaned = trim(stripScannerWatermarks($pageText));
        $cleaned = trim(preg_replace('/\s+/', ' ', $cleaned));

        // If this page has no meaningful text, attempt per-page OCR
        if (!hasMeaningfulText($cleaned)) {
            $ocrText = extractSinglePageWithOcr($path, $i, $pdf);
            if (empty(trim($ocrText))) {
                if ($apiPageMap === null) {
                    $apiPageMap = getOcrApiPageTextMap($path);
                }
                $ocrText = trim((string)($apiPageMap[$i + 1] ?? ''));
            }
            if (!empty(trim($ocrText))) {
                $pageText = $ocrText;
            }
        }

        $pageText = stripScannerWatermarks($pageText);

        $pages[] = [
            'page' => $i + 1,
            'quality' => assessPageQuality($pageText),
        ];
        $fullText .= $pageText . "\n";
    }

    // Fallback: if the whole document extracted nothing, try full OCR
    $cleanedForCheck = trim(stripScannerWatermarks($fullText));
    $cleanedForCheck = trim(preg_replace('/\s+/', ' ', $cleanedForCheck));
    if (!hasMeaningfulText($cleanedForCheck)) {
        $ocrFull = extractPdfWithOcr($path, $pdf);
        if (!empty(trim($ocrFull))) {
            $fullText = stripScannerWatermarks($ocrFull);
            // Rebuild page quality from OCR (we lose per-page; use single aggregate)
            $pages = [
                [
                    'page' => 1,
                    'quality' => assessPageQuality($fullText),
                ]
            ];
        }
    }

    return [$fullText, $pages];
}

/**
 * Streaming variant of extractPdf — emits NDJSON events per page so the
 * frontend scan animation shows live progress.
 */
function extractPdfStreaming(string $path): array
{
    $parser = new \Smalot\PdfParser\Parser();
    $pdf = $parser->parseFile($path);

    $pdfPages = $pdf->getPages();
    $total = count($pdfPages);

    // Emit 'start' so the frontend knows how many pages to expect
    streamEvent(['event' => 'start', 'total_pages' => $total]);

    $fullText = '';
    $pages = [];
    $apiPageMap = null;

    foreach ($pdfPages as $i => $page) {
        if (connection_aborted()) {
            throw new Exception('Client disconnected during streaming extraction.');
        }

        $pageText = $page->getText();
        $pageText = stripScannerWatermarks($pageText);

        // Strip known scanner watermarks before checking real content
        $cleaned = trim(stripScannerWatermarks($pageText));
        $cleaned = trim(preg_replace('/\s+/', ' ', $cleaned));

        // If this page has no meaningful text, attempt per-page OCR
        if (!hasMeaningfulText($cleaned)) {
            $ocrText = extractSinglePageWithOcr($path, $i, $pdf);
            if (empty(trim($ocrText))) {
                if ($apiPageMap === null) {
                    $apiPageMap = getOcrApiPageTextMap($path);
                }
                $ocrText = trim((string)($apiPageMap[$i + 1] ?? ''));
            }
            if (!empty(trim($ocrText))) {
                $pageText = $ocrText;
            }
        }

        $pageText = stripScannerWatermarks($pageText);

        $quality = assessPageQuality($pageText);

        $pages[] = [
            'page' => $i + 1,
            'quality' => $quality,
        ];
        $fullText .= $pageText . "\n";

        // ── Emit 'page' event — this is what drives the live scan UI ──
        streamEvent([
            'event' => 'page',
            'page' => $i + 1,
            'total' => $total,
            'text' => $pageText,
            'quality' => $quality,
        ]);
    }

    // Fallback: if the whole document extracted nothing, try full OCR
    $cleanedForCheck = trim(stripScannerWatermarks($fullText));
    $cleanedForCheck = trim(preg_replace('/\s+/', ' ', $cleanedForCheck));
    if (!hasMeaningfulText($cleanedForCheck)) {
        $ocrFull = extractPdfWithOcr($path, $pdf);
        if (!empty(trim($ocrFull))) {
            $fullText = stripScannerWatermarks($ocrFull);
            $pages = [
                [
                    'page' => 1,
                    'quality' => assessPageQuality($fullText),
                ]
            ];
        }
    }

    return [$fullText, $pages];
}

/**
 * Attempt OCR on a single PDF page using Ghostscript → Tesseract.
 * Returns empty string if OCR is unavailable or fails.
 */
function extractSinglePageWithOcr(string $path, int $pageIndex, ?\Smalot\PdfParser\Document $pdf = null): string
{
    if (!file_exists(TESSERACT_BIN) && !ocrApiEnabled()) {
        return '';
    }

    $tempDir = sys_get_temp_dir();
    $pageNum = $pageIndex + 1;

    // Strategy 1: Ghostscript
    if (file_exists(GHOSTSCRIPT_BIN)) {
        $tmpImg = $tempDir . DIRECTORY_SEPARATOR . 'ocr_p' . $pageNum . '_' . uniqid() . '.png';
        $gsCmd = sprintf(
            '"%s" -dNOPAUSE -dBATCH -dSAFER -sDEVICE=png16m -r300 ' .
            '-dFirstPage=%d -dLastPage=%d -sOutputFile=%s %s 2>&1',
            GHOSTSCRIPT_BIN,
            $pageNum,
            $pageNum,
            escapeshellarg($tmpImg),
            escapeshellarg($path)
        );
        exec($gsCmd, $out, $rc);
        if (file_exists($tmpImg)) {
            enhanceImageWithGd($tmpImg);
            $text = runTesseract($tmpImg);
            @unlink($tmpImg);
            if (!empty(trim($text)))
                return $text;
        }
    }

    // Strategy 2: Imagick
    if (extension_loaded('imagick')) {
        try {
            $tmpImg = $tempDir . DIRECTORY_SEPARATOR . 'ocr_imk_' . $pageNum . '_' . uniqid() . '.png';
            /** @noinspection PhpUndefinedClassInspection */
            $imagick = new \Imagick();
            $imagick->setResolution(300, 300);
            $imagick->readImage($path . '[' . $pageIndex . ']');
            /** @noinspection PhpUndefinedClassInspection */
            $imagick->transformImageColorspace(\Imagick::COLORSPACE_GRAY);
            $imagick->setImageFormat('png');
            $imagick->writeImage($tmpImg);
            $imagick->destroy();
            $text = runTesseract($tmpImg);
            @unlink($tmpImg);
            if (!empty(trim($text)))
                return $text;
        } catch (Exception $e) { /* fall through */
        }
    }

    return '';
}

function extractPdfWithOcr(string $path, ?\Smalot\PdfParser\Document $pdf = null): string
{
    if (!file_exists(TESSERACT_BIN) && !ocrApiEnabled()) {
        throw new Exception(
            'Tesseract OCR not found at: ' . TESSERACT_BIN .
            '. Install Tesseract or set OCR API fallback environment values.'
        );
    }

    $text = '';
    $tempDir = sys_get_temp_dir();
    $errors = [];

    // Strategy 1: Ghostscript (best quality)
    $useGhostscript = file_exists(GHOSTSCRIPT_BIN);
    if ($useGhostscript) {
        try {
            $pageCount = getPdfPageCount($path);
            for ($i = 0; $i < $pageCount; $i++) {
                $tmpImg = $tempDir . DIRECTORY_SEPARATOR . 'ocr_page_' . $i . '_' . uniqid() . '.png';
                $gsCmd = sprintf(
                    '"%s" -dNOPAUSE -dBATCH -dSAFER -sDEVICE=png16m -r300 ' .
                    '-dFirstPage=%d -dLastPage=%d -sOutputFile=%s %s 2>&1',
                    GHOSTSCRIPT_BIN,
                    $i + 1,
                    $i + 1,
                    escapeshellarg($tmpImg),
                    escapeshellarg($path)
                );
                exec($gsCmd, $output, $returnCode);
                if (file_exists($tmpImg)) {
                    enhanceImageWithGd($tmpImg);
                    $text .= runTesseract($tmpImg) . "\n\n";
                    @unlink($tmpImg);
                } else {
                    $errors[] = "Ghostscript failed for page " . ($i + 1);
                }
            }
            if (!empty(trim($text)))
                return $text;
        } catch (Exception $e) {
            $errors[] = 'Ghostscript approach failed: ' . $e->getMessage();
        }
    }

    // Strategy 2: Embedded images via smalot/pdfparser
    try {
        if ($pdf === null) {
            $parser = new \Smalot\PdfParser\Parser();
            $pdf = $parser->parseFile($path);
        }
        $imgIndex = 0;
        foreach ($pdf->getPages() as $pageNum => $page) {
            $xObjects = $page->getXObjects();
            foreach ($xObjects as $xObject) {
                $objHeader = $xObject->getHeader();
                if ($objHeader->has('Subtype') && $objHeader->get('Subtype')->getContent() === 'Image') {
                    $imgContent = $xObject->getContent();
                    if (empty($imgContent))
                        continue;
                    $tmpImg = $tempDir . DIRECTORY_SEPARATOR . 'ocr_embed_' . $imgIndex . '_' . uniqid() . '.png';
                    if (saveExtractedImage($xObject, $tmpImg) && file_exists($tmpImg)) {
                        enhanceImageWithGd($tmpImg);
                        $text .= runTesseract($tmpImg) . "\n\n";
                        @unlink($tmpImg);
                    }
                    $imgIndex++;
                }
            }
        }
        if (!empty(trim($text)))
            return $text;
    } catch (Exception $e) {
        $errors[] = 'Embedded image extraction failed: ' . $e->getMessage();
    }

    // Strategy 3: Imagick fallback
    if (extension_loaded('imagick')) {
        try {
            $pageCount = getPdfPageCount($path);
            for ($i = 0; $i < $pageCount; $i++) {
                $tmpImg = $tempDir . DIRECTORY_SEPARATOR . 'ocr_imk_' . $i . '_' . uniqid() . '.png';
                /** @noinspection PhpUndefinedClassInspection */
                $imagick = new \Imagick();
                $imagick->setResolution(300, 300);
                $imagick->readImage($path . '[' . $i . ']');
                /** @noinspection PhpUndefinedClassInspection */
                $imagick->transformImageColorspace(\Imagick::COLORSPACE_GRAY);
                $imagick->setImageFormat('png');
                $imagick->writeImage($tmpImg);
                $imagick->destroy();
                $text .= runTesseract($tmpImg) . "\n\n";
                @unlink($tmpImg);
            }
            if (!empty(trim($text)))
                return $text;
        } catch (Exception $e) {
            $errors[] = 'Imagick approach failed: ' . $e->getMessage();
        }
    }

    if (empty(trim($text))) {
        if (ocrApiEnabled()) {
            $apiError = null;
            $apiText = extractFileWithOcrApi($path, $apiError);
            if (!empty($apiText)) {
                return $apiText;
            }
            if (!empty($apiError)) {
                $errors[] = 'OCR API fallback failed: ' . $apiError;
            }
        }

        $detail = !empty($errors) ? ' Tried: ' . implode('; ', $errors) : '';
        throw new Exception('OCR could not extract text from this PDF.' . $detail);
    }

    return $text;
}

function runTesseract(string $imagePath): string
{
    if (file_exists(TESSERACT_BIN)) {
        try {
            return (new \thiagoalessio\TesseractOCR\TesseractOCR($imagePath))
                ->executable(TESSERACT_BIN)
                ->lang('eng')
                ->psm(3)
                ->oem(1)
                ->run();
        } catch (Throwable $e) {
            // Fall through to API fallback when local OCR fails at runtime.
        }
    }

    if (ocrApiEnabled()) {
        $result = ocrApiExtractTextFromFile($imagePath);
        if ($result['ok'] ?? false) {
            return (string)($result['text'] ?? '');
        }
    }

    return '';
}

function saveExtractedImage($xObject, string $outputPath): bool
{
    try {
        $content = $xObject->getContent();
        if (empty($content))
            return false;
        $img = @imagecreatefromstring($content);
        if ($img !== false) {
            imagepng($img, $outputPath);
            imagedestroy($img);
            return true;
        }
        file_put_contents($outputPath, $content);
        return file_exists($outputPath) && filesize($outputPath) > 100;
    } catch (Exception $e) {
        return false;
    }
}

function enhanceImageWithGd(string $imagePath): void
{
    try {
        $img = @imagecreatefrompng($imagePath);
        if ($img === false)
            $img = @imagecreatefromjpeg($imagePath);
        if ($img === false)
            return;
        imagefilter($img, IMG_FILTER_GRAYSCALE);
        imagefilter($img, IMG_FILTER_CONTRAST, -20);
        imagepng($img, $imagePath);
        imagedestroy($img);
    } catch (Exception $e) { /* ignore */
    }
}

function getPdfPageCount(string $path): int
{
    if (file_exists(GHOSTSCRIPT_BIN)) {
        $escapedPath = escapeshellarg(str_replace('\\', '/', $path));
        $cmd = sprintf(
            '"%s" -q -dNODISPLAY -c "(%s) (r) file runpdfbegin pdfpagecount = quit" 2>&1',
            GHOSTSCRIPT_BIN,
            trim($escapedPath, "'\"")
        );
        exec($cmd, $output, $ret);
        if ($ret === 0 && !empty($output[0]) && is_numeric(trim($output[0]))) {
            return max(1, (int) trim($output[0]));
        }
    }
    try {
        $parser = new \Smalot\PdfParser\Parser();
        $pdf = $parser->parseFile($path);
        return max(1, count($pdf->getPages()));
    } catch (Exception $e) {
        return 1;
    }
}

// ─── DOCX Extraction ─────────────────────────────────────────────────────────
function extractDocx(string $path): string
{
    $text = '';

    // Method 1: Direct XML parse
    try {
        $zip = new ZipArchive();
        if ($zip->open($path) === true) {
            $xml = $zip->getFromName('word/document.xml');
            $zip->close();
            if ($xml !== false) {
                $xml = str_replace(['</w:p>', '</w:tr>'], "\n", $xml);
                $xml = str_replace('<w:tab/>', "\t", $xml);
                $text = strip_tags($xml);
                $text = html_entity_decode($text, ENT_QUOTES | ENT_XML1, 'UTF-8');
                return $text;
            }
        }
    } catch (Throwable $e) { /* fall through to PHPWord */
    }

    // Method 2: PHPWord fallback
    $phpWord = \PhpOffice\PhpWord\IOFactory::load($path);
    foreach ($phpWord->getSections() as $section) {
        foreach ($section->getElements() as $element) {
            $text .= extractPhpWordElement($element) . "\n";
        }
    }

    return $text;
}

function extractPhpWordElement($element): string
{
    $text = '';
    if (
        $element instanceof \PhpOffice\PhpWord\Element\TextRun
        || $element instanceof \PhpOffice\PhpWord\Element\Paragraph
    ) {
        foreach ($element->getElements() as $child) {
            $text .= extractPhpWordElement($child);
        }
        $text .= "\n";
    } elseif ($element instanceof \PhpOffice\PhpWord\Element\Text) {
        $text .= $element->getText();
    } elseif ($element instanceof \PhpOffice\PhpWord\Element\Table) {
        foreach ($element->getRows() as $row) {
            foreach ($row->getCells() as $cell) {
                foreach ($cell->getElements() as $cellElement) {
                    $text .= extractPhpWordElement($cellElement) . "\t";
                }
            }
            $text .= "\n";
        }
    }
    return $text;
}

// ─── Clean & Normalize ───────────────────────────────────────────────────────
function cleanText(string $text): string
{
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    $text = stripScannerWatermarks($text);
    $text = preg_replace('/[^\x09\x0A\x20-\x7E\xA0-\xFF]/u', '', $text);

    $text = preg_replace('/\n{3,}/', "\n\n", $text);
    $lines = array_map('rtrim', explode("\n", $text));
    return trim(implode("\n", $lines));
}

function stripScannerWatermarks(string $text): string
{
    $cleaned = (string)$text;
    foreach (SCANNER_WATERMARK_PATTERNS as $pattern) {
        $cleaned = preg_replace($pattern, ' ', $cleaned);
    }

    return trim((string)$cleaned);
}

function hasMeaningfulText(string $text): bool
{
    $cleaned = stripScannerWatermarks($text);
    $cleaned = trim((string)preg_replace('/\s+/u', ' ', $cleaned));
    if ($cleaned === '') {
        return false;
    }

    preg_match_all('/\p{L}[\p{L}\p{M}\p{N}\'’-]*/u', $cleaned, $matches);
    $wordCount = count($matches[0] ?? []);
    $letterCount = preg_match_all('/\p{L}/u', $cleaned);

    return $wordCount >= 6 && $letterCount >= 20;
}