<?php
/**
 * checklist.php — Checklist Scanner Backend
 *
 * Action: scan_checklist
 *   POST a .doc/.docx/.pdf file → returns detected fields + checklist items
 *        + per-page quality analysis (NEW)
 *
 * This works alongside extract.php (which handles the school document OCR).
 */

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';
require_once __DIR__ . '/ocr_api_client.php';

header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Require 'checklist' permission
requirePermission('checklist', $authUser);

function jsonError(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function getConfiguredTesseractCmd(): string {
    $fromEnv = trim((string)($_ENV['TESSERACT_BIN'] ?? $_SERVER['TESSERACT_BIN'] ?? getenv('TESSERACT_BIN') ?: ''));
    return $fromEnv !== '' ? $fromEnv : 'tesseract';
}

function checklistStripScannerWatermarks(string $text): string {
    $cleaned = trim($text);
    $patterns = [
        '/\bscanned\s+with\s+cam\s*scanner\b/iu',
        '/\bscanned\s+by\s+cam\s*scanner\b/iu',
        '/\bcs\s+cam\s*scanner\b/iu',
        '/\bcam\s*scanner\b/iu',
    ];

    foreach ($patterns as $pattern) {
        $cleaned = preg_replace($pattern, ' ', $cleaned);
    }

    $cleaned = preg_replace('/\s+/u', ' ', (string)$cleaned);
    return trim((string)$cleaned);
}

function checklistHasMeaningfulText(string $text): bool {
    $cleaned = checklistStripScannerWatermarks($text);
    if ($cleaned === '') {
        return false;
    }

    preg_match_all('/\p{L}[\p{L}\p{M}\p{N}\'’-]*/u', $cleaned, $matches);
    $wordCount = count($matches[0] ?? []);

    return strlen($cleaned) >= 25 && $wordCount >= 4;
}

function checklistExtractPdfPageWithLocalOcr(string $pdfPath, int $pageNum, string $tesseractCmd): string {
    $base = sys_get_temp_dir() . '/spv_page_' . $pageNum . '_' . uniqid('', true);

    shell_exec(
        'pdftoppm -r 200 -f ' . $pageNum . ' -l ' . $pageNum .
        ' -png ' . escapeshellarg($pdfPath) .
        ' ' . escapeshellarg($base) .
        ' 2>/dev/null'
    );

    // pdftoppm appends -1.png for single-page output
    $actualImg = $base . '-1.png';
    if (!file_exists($actualImg)) {
        return '';
    }

    $ocr = shell_exec(
        escapeshellarg($tesseractCmd) . ' ' . escapeshellarg($actualImg) . ' stdout 2>/dev/null'
    );
    if (!unlink($actualImg)) {
        error_log('checklist: failed to delete temp file: ' . $actualImg);
    }

    return trim((string)$ocr);
}

function checklistGetOcrApiPageTextMap(string $path): array {
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

$action = $_GET['action'] ?? '';

// ── STREAMING MODE — emits newline-delimited JSON events, one per page ──
// Triggered when JS sends FormData with stream=1 appended to the URL.
if (!empty($_GET['stream'])) {

    $tesseractCmd = getConfiguredTesseractCmd();

    // Guard: shell_exec is required for PDF page rendering and OCR fallback.
    if (!function_exists('shell_exec') || stripos(ini_get('disable_functions'), 'shell_exec') !== false) {
        streamEvent(['event' => 'error', 'message' => 'shell_exec is disabled on this server. PDF OCR fallback is unavailable.']);
        exit;
    }

    // Disable output buffering completely so flush() actually works
    while (ob_get_level()) ob_end_clean();
    
    // Headers that tell the browser: "this is a stream, don't buffer it"
    header('Content-Type: application/x-ndjson; charset=utf-8');
    header('X-Accel-Buffering: no');   // disables Nginx proxy buffering
    header('Cache-Control: no-cache');

    // Auth already verified above (authenticate() / requirePermission()).
    // Helper: emit one JSON event and flush immediately to the browser
    function streamEvent(array $data): void {
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
        flush();
    }

    // Validate upload
    if (empty($_FILES['document']['tmp_name'])) {
        streamEvent(['event' => 'error', 'message' => 'No file uploaded.']);
        exit;
    }

    $tmpPath  = $_FILES['document']['tmp_name'];
    $origName = $_FILES['document']['name'] ?? 'document';
    $ext      = strtolower(pathinfo($origName, PATHINFO_EXTENSION));

    // ── Determine total pages first so JS can set up the UI ──
    $totalPages = 1;
    if ($ext === 'pdf') {
        // Use pdfinfo if available (fastest), otherwise fall back to counting %%Page markers
        $piOut = shell_exec('pdfinfo ' . escapeshellarg($tmpPath) . ' 2>/dev/null');
        if ($piOut && preg_match('/Pages:\s*(\d+)/i', $piOut, $m)) {
            $totalPages = (int)$m[1];
        } else {
            $raw = @file_get_contents($tmpPath);
            $totalPages = $raw ? max(1, preg_match_all('/\/Type\s*\/Page[^s]/s', $raw)) : 1;
        }
    }

    // Tell JS how many pages to expect
    streamEvent(['event' => 'start', 'total_pages' => $totalPages, 'filename' => $origName]);

    // ── Per-page extraction ──
    $allText   = '';
    $pagesData = [];
    $ocrApiPageMap = null;

    for ($pageNum = 1; $pageNum <= $totalPages; $pageNum++) {

        // --- Extract text for this page ---
        $pageText = '';
        $quality  = ['status' => 'ok', 'word_count' => 0, 'reason' => null];

        if ($ext === 'pdf') {
            // pdftotext (poppler-utils) — extract single page
            $raw = shell_exec(
                'pdftotext -f ' . $pageNum . ' -l ' . $pageNum .
                ' ' . escapeshellarg($tmpPath) . ' - 2>/dev/null'
            );
            $pageText = trim($raw ?? '');

            // If native text is empty or watermark-only, try OCR with tesseract
            if (!checklistHasMeaningfulText($pageText)) {
                $pageText = checklistExtractPdfPageWithLocalOcr($tmpPath, $pageNum, $tesseractCmd);

                if (!checklistHasMeaningfulText($pageText)) {
                    if ($ocrApiPageMap === null) {
                        $ocrApiPageMap = checklistGetOcrApiPageTextMap($tmpPath);
                    }
                    $apiText = trim((string)($ocrApiPageMap[$pageNum] ?? ''));
                    if ($apiText !== '') {
                        $pageText = $apiText;
                    }
                }

                $quality['status'] = checklistHasMeaningfulText($pageText) ? 'ok' : 'unreadable';
                if ($quality['status'] === 'unreadable') {
                    $quality['reason'] = 'OCR returned very little text';
                }
            }

            $pageText = checklistStripScannerWatermarks($pageText);
        } elseif ($ext === 'docx') {
            // For DOCX just return all text on page 1, blank on others
            // (DOCX has no real page boundaries without rendering)
            if ($pageNum === 1) {
                $zip = new ZipArchive();
                if ($zip->open($tmpPath) === true) {
                    $xml = $zip->getFromName('word/document.xml');
                    $zip->close();
                    if ($xml) {
                        $pageText = strip_tags(str_replace(
                            ['</w:p>', '</w:tr>'], ["\n", "\n"],
                            $xml
                        ));
                        $pageText = preg_replace('/\s{2,}/', ' ', $pageText);
                        $pageText = trim($pageText);
                    }
                }
            }
        }

        $wordCount = $pageText ? count(array_filter(explode(' ', preg_replace('/\s+/', ' ', $pageText)))) : 0;
        $quality['word_count'] = $wordCount;

        // Classify quality
        if ($quality['status'] === 'ok') {
            if ($wordCount < 10)       { $quality['status'] = 'unreadable'; $quality['reason'] = 'No readable text found'; }
            elseif ($wordCount < 40)   { $quality['status'] = 'sparse';     $quality['reason'] = 'Very few words detected'; }
        }

        $allText    .= $pageText . "\n\n";
        $pagesData[] = [
            'page'    => $pageNum,
            'text'    => $pageText,
            'quality' => $quality,
        ];

        // ── Emit this page to the browser RIGHT NOW ──
        streamEvent([
            'event'   => 'page',
            'page'    => $pageNum,
            'total'   => $totalPages,
            'text'    => $pageText,
            'quality' => $quality,
        ]);
    }

    // ── Final summary event ──
    $allText  = trim($allText);
    $unreadable = count(array_filter($pagesData, fn($p) => $p['quality']['status'] === 'unreadable'));
    $scannable  = $unreadable < ceil($totalPages * 0.5);
    $warning    = null;
    if (!$scannable)         $warning = 'More than half the pages could not be read. Document may be image-only with poor scan quality.';
    elseif ($unreadable > 0) $warning = $unreadable . ' page(s) had low readability. Results may be incomplete.';

    streamEvent([
        'event'        => 'done',
        'text'         => $allText,
        'pages'        => $pagesData,
        'scan_quality' => [
            'total_pages' => $totalPages,
            'unreadable'  => $unreadable,
            'scannable'   => $scannable,
            'warning'     => $warning,
        ],
    ]);

    exit; // Don't fall through to the old non-streaming code
}

if ($action === 'scan_checklist') {
    scanChecklist();
} elseif ($action === 'get_schools') {
    $pdo   = getDb();
    $rows  = $pdo->query("SELECT id, name AS canonical_name FROM private_schools WHERE active=1 ORDER BY name")->fetchAll(\PDO::FETCH_ASSOC);
    echo json_encode(['schools' => $rows]);
    exit;
} else {
    jsonError('Unknown action.', 400);
}

// ─── Scan Checklist Document ──────────────────────────────────────────────────
function scanChecklist(): void
{
    if (empty($_FILES['document'])) {
        jsonError('No file uploaded.');
    }

    $file     = $_FILES['document'];
    $tmpPath  = $file['tmp_name'];
    $origName = $file['name'];
    $ext      = strtolower(pathinfo($origName, PATHINFO_EXTENSION));

    if (!in_array($ext, ['doc','docx','pdf'], true)) {
        jsonError('Only DOC, DOCX, or PDF checklist files are supported.');
    }

    $autoload = __DIR__ . '/../vendor/autoload.php';
    if (!file_exists($autoload)) {
        jsonError('Composer dependencies not installed.', 500);
    }
    require_once $autoload;

    $text  = '';
    $pages = [];   // NEW — per-page quality data
    $tesseractCmd = getConfiguredTesseractCmd();

    try {
        if ($ext === 'pdf') {
            $parser = new \Smalot\PdfParser\Parser();
            $pdf    = $parser->parseFile($tmpPath);
            $ocrApiPageMap = null;

            foreach ($pdf->getPages() as $i => $page) {
                $pageText = $page->getText();

                if (!checklistHasMeaningfulText($pageText)) {
                    $pageText = checklistExtractPdfPageWithLocalOcr($tmpPath, $i + 1, $tesseractCmd);

                    if (!checklistHasMeaningfulText($pageText)) {
                        if ($ocrApiPageMap === null) {
                            $ocrApiPageMap = checklistGetOcrApiPageTextMap($tmpPath);
                        }
                        $apiText = trim((string)($ocrApiPageMap[$i + 1] ?? ''));
                        if ($apiText !== '') {
                            $pageText = $apiText;
                        }
                    }
                }

                $pageText = checklistStripScannerWatermarks($pageText);

                $quality  = assessPageQuality($pageText);

                $pages[] = [
                    'page'    => $i + 1,
                    'quality' => $quality,
                ];

                $text .= $pageText . "\n";
            }

        } elseif ($ext === 'docx') {
            $zip = new ZipArchive();
            if ($zip->open($tmpPath) === true) {
                $xml = $zip->getFromName('word/document.xml');
                $zip->close();
                if ($xml !== false) {
                    $xml  = str_replace(['</w:p>', '</w:tr>'], "\n", $xml);
                    $xml  = str_replace('<w:tab/>', "\t", $xml);
                    $text = strip_tags($xml);
                    $text = html_entity_decode($text, ENT_QUOTES | ENT_XML1, 'UTF-8');
                }
            }
            // DOCX is always a single logical "page" for quality purposes
            $pages[] = [
                'page'    => 1,
                'quality' => assessPageQuality($text),
            ];

        } elseif ($ext === 'doc') {
            // Read old .doc binary format — extract readable ASCII
            $raw  = file_get_contents($tmpPath);
            $text = mb_convert_encoding($raw, 'UTF-8', 'Windows-1252');
            $text = preg_replace('/[^\x20-\x7E\n\r\t]/u', ' ', $text);
            $text = preg_replace('/\s{3,}/', ' ', $text);

            $pages[] = [
                'page'    => 1,
                'quality' => assessPageQuality($text),
            ];
        }
    } catch (Throwable $e) {
        jsonError('Failed to read checklist file: ' . $e->getMessage(), 500);
    }

    if (empty(trim($text))) {
        jsonError('Could not extract text from the checklist file.');
    }

    // ── Detect header fields ──────────────────────────────────────────────────
    $fields = detectHeaderFields($text);
    $fields = resolveSchoolFromDb($fields, $text);

    // ── Detect checklist items ────────────────────────────────────────────────
    $items = detectChecklistItems($text);

    // ── Overall scan quality summary ──────────────────────────────────────────
    $scanQuality = computeOverallQuality($pages);

    echo json_encode([
        'fields'       => $fields,
        'items'        => $items,
        'raw'          => substr(trim($text), 0, 2000),
        'pages'        => $pages,          // NEW — per-page quality breakdown
        'scan_quality' => $scanQuality,    // NEW — aggregate summary
    ]);
}

// ─── Page Quality Assessment (NEW) ───────────────────────────────────────────
/**
 * Assess the readability of a single extracted page.
 *
 * Returns:
 *   status    — 'ok' | 'blurred' | 'sparse' | 'unreadable'
 *   reason    — human-readable explanation, or null when status is 'ok'
 *   char_count
 *   word_count
 */
function assessPageQuality(string $pageText): array
{
    $trimmed   = trim($pageText);
    $charCount = strlen($trimmed);
    $wordCount = str_word_count($trimmed);

    // Count non-ASCII / garbled bytes (common in blurred OCR output)
    $garbled = preg_match_all('/[^\x09\x0A\x20-\x7E]/', $trimmed);
    $ratio   = $charCount > 0 ? ($garbled / $charCount) : 1.0;

    $status = 'ok';
    $reason = null;

    if ($charCount < 30) {
        $status = 'unreadable';
        $reason = 'No meaningful text detected — page may be a scanned image, blank, or fully blurred.';
    } elseif ($ratio > 0.20) {
        $status = 'blurred';
        $reason = sprintf(
            'High garbled-character ratio (%.0f%%) — page may be blurred, low-resolution, or a scanned image that OCR could not read cleanly.',
            $ratio * 100
        );
    } elseif ($wordCount < 5) {
        $status = 'sparse';
        $reason = 'Very few words detected (' . $wordCount . ') — content may be mostly images, tables, or decorative elements.';
    }

    return [
        'status'     => $status,
        'reason'     => $reason,
        'char_count' => $charCount,
        'word_count' => $wordCount,
    ];
}

/**
 * Roll up all per-page quality data into a single summary object.
 */
function computeOverallQuality(array $pages): array
{
    if (empty($pages)) {
        return [
            'total_pages'    => 0,
            'unreadable'     => 0,
            'unreadable_pct' => 100,
            'scannable'      => false,
            'warning'        => 'No pages were found in the document.',
        ];
    }

    $bad = array_filter($pages, fn($p) => $p['quality']['status'] !== 'ok');
    $pct = count($bad) / count($pages);

    $warning = null;
    if ($pct >= 0.5) {
        $warning = round($pct * 100) . '% of pages have quality issues — document may not be reliably scannable. Consider uploading a cleaner copy.';
    } elseif ($pct >= 0.3) {
        $warning = round($pct * 100) . '% of pages have quality issues — AI results may be incomplete for affected pages.';
    }

    return [
        'total_pages'    => count($pages),
        'unreadable'     => count($bad),
        'unreadable_pct' => round($pct * 100),
        'scannable'      => $pct < 0.5,
        'warning'        => $warning,
    ];
}

// ─── Detect Header Fields ─────────────────────────────────────────────────────
function detectHeaderFields(string $text): array
{
    $fields = [];

    $patterns = [
        'schoolName'  => [
            '/name\s+of\s+school\s*[:\-]\s*([^\n\r]{3,80})/i',
            '/school\s+name\s*[:\-]\s*([^\n\r]{3,80})/i',
        ],
        'location'    => [
            '/location\s*[\/\-:]?\s*address\s*[:\-]\s*([^\n\r]{3,120})/i',
            '/location\s*[:\-]\s*([^\n\r]{3,120})/i',
            '/address\s*[:\-]\s*([^\n\r]{3,120})/i',
        ],
        'syApplied'   => [
            '/sy\s+applied\s+for\s*[:\-]\s*([^\n\r]{1,30})/i',
            '/school\s+year\s+applied\s*[:\-]\s*([^\n\r]{1,30})/i',
        ],
        'govRecogNo'  => [
            '/(?:government\s+)?recognition\s+no[\.:\-]\s*([^\n\r]{1,40})/i',
            '/recog(?:nition)?\s*[#no\.:\-]+\s*([^\n\r]{1,40})/i',
        ],
        'govPermitNo' => [
            '/(?:government\s+)?permit\s+no[\.:\-]\s*([^\n\r]{1,40})/i',
        ],
        'evaluatedBy' => [
            '/(?:processed|evaluated)\s*(?:\/\s*evaluated)?\s*by\s*[:\-]?\s*([^\n\r]{3,80})/i',
        ],
    ];

    foreach ($patterns as $key => $pats) {
        foreach ($pats as $pat) {
            if (preg_match($pat, $text, $m)) {
                $val = trim($m[1] ?? '');
                // Remove only control characters — preserve accented/Filipino characters.
                $val = preg_replace('/[\x00-\x1F\x7F\x80-\x9F]/u', '', $val);
                $val = trim($val, ' :-');
                if (strlen($val) > 1 && strlen($val) < 200) {
                    $fields[$key] = $val;
                    break;
                }
            }
        }
    }

    return $fields;
}

// ─── Detect Checklist Items ───────────────────────────────────────────────────
function detectChecklistItems(string $text): array
{
    $items = [];

    preg_match_all('/(\d+[\.\)])\s+([^\n\r]{10,300})/u', $text, $matches, PREG_SET_ORDER);

    foreach ($matches as $m) {
        $num      = rtrim($m[1], '.)');
        $itemText = trim($m[2]);
        // Remove only actual control characters (U+0000–U+001F, U+007F–U+009F)
        // while preserving Filipino-specific characters (ñ, Ñ, é, etc.) and other Unicode letters.
        $itemText = preg_replace('/[\x00-\x1F\x7F\x80-\x9F]/u', '', $itemText);
        $itemText = trim($itemText);
        if (strlen($itemText) > 10) {
            $items[] = [
                'id'       => (int)$num,
                'text'     => $itemText,
                'keywords' => generateKeywords($itemText),
            ];
        }
    }

    if (count($items) < 3) {
        return defaultChecklistItems();
    }

    return array_slice($items, 0, 12);
}

function generateKeywords(string $text): array
{
    $stopwords = ['with','that','this','from','have','been','will','they',
                  'their','which','should','copy','each','item','amount'];
    $words    = preg_split('/\W+/', strtolower($text));
    $keywords = [];
    foreach ($words as $w) {
        if (strlen($w) > 4 && !in_array($w, $stopwords, true)) {
            $keywords[] = $w;
        }
    }
    return array_slice(array_unique($keywords), 0, 6);
}

function defaultChecklistItems(): array
{
    return [
        ['id'=>1,   'text'=>'Date received by DepEd RO III (submission on or before May 15)',                        'keywords'=>['received','submission','may','deped']],
        ['id'=>2,   'text'=>'Letter of advice to the Regional Office signed by the School Head',                     'keywords'=>['letter','advice','regional','signed','school head']],
        ['id'=>3,   'text'=>'Xerox copy of approved tuition, miscellaneous and other school fees (previous SY)',     'keywords'=>['xerox','approved','tuition','miscellaneous','previous']],
        ['id'=>4,   'text'=>'Comparative Schedule of tuition, miscellaneous and other school fees',                  'keywords'=>['comparative','schedule','tuition','miscellaneous']],
        ['id'=>5,   'text'=>'Percentage of increase of tuition/miscellaneous other fees',                            'keywords'=>['percentage','increase','tuition']],
        ['id'=>6,   'text'=>'Certification under Oath (notarized) signed by School Head — RA 6728 compliance',      'keywords'=>['certification','oath','notarized','notary','6728']],
        ['id'=>'6a','text'=>'(a) Consultations conducted with PTA/PTCA and Faculty Association with minutes',        'keywords'=>['consultation','pta','ptca','faculty','minutes']],
        ['id'=>'6b','text'=>'(b) 70% of incremental proceeds went to salaries/wages of teaching personnel',         'keywords'=>['70','seventy','incremental','salaries','wages','teaching']],
        ['id'=>'6c','text'=>'(c) 20% to improvement/modernization of buildings, equipment, libraries',              'keywords'=>['20','twenty','improvement','modernization','building']],
    ];
}

// ─── Resolve School from DB ───────────────────────────────────────────────────
function resolveSchoolFromDb(array $fields, string $text): array
{
    try {
        $pdo = getDb();

        $rows = $pdo->query("
            SELECT id, name, name AS canonical_name,
                   CONCAT_WS(', ', NULLIF(street_address,''), NULLIF(barangay,'')) AS location_address,
                   NULL AS alias
            FROM private_schools WHERE active = 1
        ")->fetchAll(\PDO::FETCH_ASSOC);

        $rawName = strtolower(trim($fields['schoolName'] ?? ''));
        $rawText = strtolower(substr($text, 0, 500));

        $bestScore = 0;
        $bestRow   = null;

        foreach ($rows as $row) {
            $candidates = array_filter([
                strtolower($row['name'] ?? ''),
                strtolower($row['canonical_name'] ?? ''),
                strtolower($row['alias'] ?? ''),
            ]);

            foreach ($candidates as $candidate) {
                if ($rawName === $candidate) { $bestRow = $row; $bestScore = 100; break 2; }

                $score     = wordOverlapScore($rawName, $candidate);
                $scoreText = wordOverlapScore($rawText, $candidate);
                $score     = max($score, $scoreText * 0.85);

                if ($score > $bestScore && $score >= 55) {
                    $bestScore = $score;
                    $bestRow   = $row;
                }
            }
        }

        if ($bestRow) {
            $fields['schoolName']   = $bestRow['canonical_name'] ?: $bestRow['name'];
            $fields['_school_id']   = $bestRow['id'];
            $fields['_match_score'] = round($bestScore);
            if (empty($fields['location']) && !empty($bestRow['location_address'])) {
                $fields['location'] = $bestRow['location_address'];
            }
        }

    } catch (\Throwable $e) {
        // Non-fatal — leave fields as-is
    }

    return $fields;
}

function wordOverlapScore(string $a, string $b): float
{
    $stop = ['inc','incorporated','the','of','and','school','college','high','elementary','national'];
    $tokenize = fn(string $s) => array_filter(
        preg_split('/[\s\-\.,&\/]+/', $s),
        fn($w) => strlen($w) > 2 && !in_array($w, $stop, true)
    );

    $ta = array_values($tokenize($a));
    $tb = array_values($tokenize($b));
    if (!$ta || !$tb) return 0;

    $matches = 0;
    foreach ($ta as $wa) {
        foreach ($tb as $wb) {
            similar_text($wa, $wb, $pct);
            if ($pct >= 75) { $matches++; break; }
        }
    }

    return ($matches / max(count($ta), count($tb))) * 100;
}