<?php
// ─── Error logging setup (MUST be first) ──────────────────────────────────────
error_reporting(E_ALL);
ini_set('display_errors', 0);

ob_start();

register_shutdown_function(function() {
    $error = error_get_last();
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
        ob_clean();
        header('Content-Type: application/json');
        echo json_encode([
            'success' => false,
            'message' => 'Server error occurred' // SECURITY: Don't expose error details
        ]);
    } else {
        ob_flush();
    }
});

require __DIR__ . '/../vendor/autoload.php';
require_once '../config/database.php';
require_once '../config/security.php';
require_once '../config/auth_middleware.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

// ─── CORS & Security Headers ──────────────────────────────────────────────────
header('Content-Type: application/json');
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

// SECURITY: Require authentication for file processing
$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized. Please log in.']);
    exit;
}

// ─── Load settings from eval_settings table ───────────────────────────────────
function loadSettings(): array {
    // Minimal fallback - no hardcoded column positions
    // Column mappings should come from:
    // 1. Frontend column_config (preferred - based on UI mapping)
    // 2. Database eval_settings table
    $fallback = [
        'categories' => [],           // No hardcoded category columns
        'speaker_slots' => [],        // No hardcoded speaker slots
        'speaker_criteria' => [       // Default criteria labels (can be overridden)
            'Knowledgeable of topic & well organized',
            'Resource Person was well prepared',
            'Materials & presentations were relevant',
            'Start and end on time',
            'Engaging and supportive',
            'Demonstrated clear understanding of content',
        ],
        'feedback_columns'     => ['expectations' => null, 'improvements' => null, 'insights' => null, 'further' => null],
        'respondent_info_cols' => [
            'fullname'         => null,
            'email'            => null,
            'sex'              => null,
            'participant_type' => null,
            'designation'      => null,
            'school'           => null,
        ],
        'excluded_keywords' => ['start time', 'completion time', 'last modified time', 'timestamp', 'email', 'e-mail'],
        'scale_candidates'  => [4, 5, 7, 10],
        'skip_sheets'    => ['consolidated', 'summary', 'report', 'overview', 'total'],
        // NOTE: 'sheet1' was removed from skip_sheets — it is the default Excel tab name
        // and is a perfectly valid data sheet. Skipping it caused Day 2 imports where
        // the user hadn't renamed the tab to be silently dropped.
        'sheet_overrides'=> [],
    ];

    try {
        $pdo  = getDB();
        $rows = $pdo->query("SELECT setting_key, setting_value FROM eval_settings")
                    ->fetchAll(PDO::FETCH_ASSOC);
        $pdo  = null;
        $db   = [];
        foreach ($rows as $row) $db[$row['setting_key']] = json_decode($row['setting_value'], true);
        return array_merge($fallback, $db);
    } catch (Exception $e) {
        return $fallback;
    }
}

$S = loadSettings();

// ─── Load speaker rating scales from rating_scales table ─────────────────────
// Used by getSpeakerResult() so speaker labels match the DB-configured scale
// (e.g. "Very Satisfactory") instead of the percentage-based result_thresholds
// (which was producing "Outstanding" for high-scoring speakers).
function loadSpeakerRatingScales(): array {
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare("
            SELECT min_score, max_score, descriptive_equivalent
            FROM rating_scales
            WHERE scale_type = 'speaker' AND is_active = 1
            ORDER BY min_score DESC
        ");
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return [];
    }
}

$SPEAKER_RATING_SCALES = loadSpeakerRatingScales();

function loadCategoryRatingScales(): array {
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare("
            SELECT min_score, max_score, descriptive_equivalent
            FROM rating_scales
            WHERE scale_type = 'category' AND is_active = 1
            ORDER BY min_score DESC
        ");
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return [];
    }
}

$CATEGORY_RATING_SCALES = loadCategoryRatingScales();

// ─── Look up a speaker result label by score range ────────────────────────
// Falls back to result_thresholds (percentage-based) only if the DB has no rows.
function getSpeakerResult(float $average, float $maxScale, array $speakerScales, array $thresholds): string {
    if (!empty($speakerScales)) {
        foreach ($speakerScales as $s) {
            if ($average >= (float)$s['min_score'] && $average <= (float)$s['max_score']) {
                return $s['descriptive_equivalent'];
            }
        }
        return $speakerScales[count($speakerScales) - 1]['descriptive_equivalent'] ?? 'Unsatisfactory';
    }
    // Fallback: percentage-based thresholds
    $pct = $maxScale > 0 ? ($average / $maxScale) * 100 : 0;
    foreach ($thresholds as $t) {
        if ($pct >= $t['pct']) return $t['label'];
    }
    return $thresholds[count($thresholds) - 1]['label'] ?? 'Needs Improvement';
}

// ─── Auto-detect a resource speaker's name from a column header ───────────
// Many source forms embed the observed speaker's name as a merged sub-header
// on every criterion column for that speaker, e.g.:
//   "RESOURCE SPEAKER (Cecille. E Cruz, -SEPS -SMME ) .Knowledgeable of the
//    topic and well organized"
// The parenthetical is "Name, -Position -Unit" — we only want the name
// portion, so this trims everything from the first " -" token onward.
// Returns '' when no such prefix is present so callers can fall back cleanly.
function extractSpeakerNameFromHeader(string $header): string {
    if (!preg_match('/resource\s*(?:speaker|person)\s*\(([^)]*)\)/i', $header, $m)) {
        return '';
    }
    $inside = trim($m[1]);
    // Only trim a trailing "-Position -Unit" style suffix when it's preceded
    // by actual whitespace (an optional comma allowed before it) — this avoids
    // clipping genuinely hyphenated surnames like "Santos-Reyes", which have
    // no space before their hyphen.
    $inside = preg_replace('/,?\s+-\S.*$/', '', $inside);
    $inside = trim($inside, " \t\n\r\0\x0B,.");
    return $inside;
}

// ─── Adjust all column indices from 1-based (DB/Excel) → 0-based (PHP array) ─
$CATEGORIES = [];
foreach ($S['categories'] as $catName => $cols) {
    $CATEGORIES[$catName] = array_map(fn($c) => $c - 1, $cols);
}

$SPEAKER_SLOTS = [];
foreach ($S['speaker_slots'] as $slot => $cols) {
    $SPEAKER_SLOTS[$slot] = array_map(fn($c) => $c - 1, $cols);
}

$SPEAKER_CRITERIA  = $S['speaker_criteria'];
$FEEDBACK_COLS     = $S['feedback_columns'] ?? [];  // flat array of 1-based col indices (or empty)
$RESPONDENT_COLS   = $S['respondent_info_cols']; // 1-based
$EXCLUDED_KEYWORDS = $S['excluded_keywords'];
$SCALE_CANDIDATES  = $S['scale_candidates'];
$RESULT_THRESHOLDS = $S['result_thresholds'];
$SKIP_SHEETS       = array_map('strtolower', $S['skip_sheets']);
$SHEET_OVERRIDES   = $S['sheet_overrides'] ?? [];

// ─── Pre-compute demographic 0-based column indices ───────────────────────────
$COL_FULLNAME  = isset($RESPONDENT_COLS['fullname'])         && $RESPONDENT_COLS['fullname']         !== null ? (int)$RESPONDENT_COLS['fullname']         - 1 : null;
$COL_EMAIL     = isset($RESPONDENT_COLS['email'])            && $RESPONDENT_COLS['email']            !== null ? (int)$RESPONDENT_COLS['email']            - 1 : null;
$COL_SEX       = isset($RESPONDENT_COLS['sex'])              && $RESPONDENT_COLS['sex']              !== null ? (int)$RESPONDENT_COLS['sex']              - 1 : null;
$COL_PART_TYPE = isset($RESPONDENT_COLS['participant_type']) && $RESPONDENT_COLS['participant_type'] !== null ? (int)$RESPONDENT_COLS['participant_type'] - 1 : null;
$COL_DESIG     = isset($RESPONDENT_COLS['designation'])      && $RESPONDENT_COLS['designation']      !== null ? (int)$RESPONDENT_COLS['designation']      - 1 : null;
$COL_SCHOOL    = isset($RESPONDENT_COLS['school'])           && $RESPONDENT_COLS['school']           !== null ? (int)$RESPONDENT_COLS['school']           - 1 : null;

/**
 * Build a feedback column map: [ "Actual Header Text" => 1-based-col-index ]
 * for every 1-based column index present in $feedbackColNums.
 * $headers is the 0-based header row array.
 * This replaces keyword-based detection — the header text IS the label.
 */
function buildFeedbackHeaderMap(array $headers, array $feedbackColNums): array {
    $map = [];
    foreach ($feedbackColNums as $colNum) {
        if ($colNum === null || (int)$colNum <= 0) continue;
        $idx = (int)$colNum - 1;
        $label = isset($headers[$idx]) && trim((string)$headers[$idx]) !== ''
            ? trim((string)$headers[$idx])
            : 'Feedback ' . $colNum;
        $map[$label] = (int)$colNum;
    }
    return $map;
}

function hasAnyFeedbackCol(array $feedbackCols): bool {
    foreach ($feedbackCols as $v) {
        if ($v === null) continue;
        if ($v === '') continue;
        if (is_numeric($v) && (int)$v > 0) return true;
    }
    return false;
}

/**
 * Determine which speaker slots are actually present in a sheet.
 * A slot is active if all its columns exist within the sheet's width
 * AND none of its column headers look like a feedback/open-ended question.
 */
function detectActiveSlots(array $headers, array $speakerSlots): array {
    $totalCols   = count($headers);
    // Common substrings that indicate a column is an open-ended feedback question,
    // not a numeric speaker-rating column.
    $feedbackKws = ['expectation', 'improve', 'insight', 'further', 'suggestion', 'comment', 'feedback'];
    $activeSlots = [];

    foreach ($speakerSlots as $slot => $cols0based) {
        $slotPresent = true;
        foreach ($cols0based as $c) {
            if ($c >= $totalCols) { $slotPresent = false; break; }
            $hdr = strtolower(trim((string)($headers[$c] ?? '')));
            foreach ($feedbackKws as $kw) {
                if (stripos($hdr, $kw) !== false) { $slotPresent = false; break 2; }
            }
        }
        if ($slotPresent) $activeSlots[] = (int)$slot;
    }

    return $activeSlots;
}

/**
 * Build effective per-sheet overrides by auto-detecting each sheet's structure.
 * User-configured overrides always take precedence over auto-detection.
 * Returns only sheets that actually differ from the defaults (or have user overrides).
 */
function buildAutoOverrides(
    $spreadsheet,
    array $speakerSlots,        // 0-based
    array $defaultFeedbackCols, // 1-based
    array $skipSheets,
    array $existingOverrides,   // user-configured (take precedence)
    array $categories = []      // 0-based category column indices
): array {
    $autoOverrides = [];
    $defaultSlots  = array_keys($speakerSlots);
    
    // Build list of all score column indices (0-based)
    $allScoreCols = [];
    foreach ($categories as $cols) {
        foreach ($cols as $c) $allScoreCols[] = $c;
    }
    foreach ($speakerSlots as $cols) {
        foreach ($cols as $c) $allScoreCols[] = $c;
    }

    // Build a positional map: Excel tab index → "Day N" label (from $existingOverrides keys)
    // so we can match JS-sent overrides (keyed by "Day N") to actual sheet names.
    $existingOverrideKeys = array_keys($existingOverrides);
    $sheetIdx = 0;
    foreach ($spreadsheet->getSheetNames() as $sheetName) {
        if (in_array(strtolower(trim($sheetName)), $skipSheets)) continue;

        // Match override by exact sheet name first, then by positional "Day N" key.
        $dayKeyByPos   = $existingOverrideKeys[$sheetIdx] ?? null;
        $hasUserOverride = isset($existingOverrides[$sheetName])
                        || ($dayKeyByPos !== null && isset($existingOverrides[$dayKeyByPos]));
        $userOv = $hasUserOverride
            ? ($existingOverrides[$sheetName] ?? $existingOverrides[$dayKeyByPos])
            : [];
        $sheetIdx++;

        $ws      = $spreadsheet->getSheetByName($sheetName);
        $allRows = $ws->rangeToArray('A1:' . $ws->getHighestDataColumn() . '1', null, true, true, true);
        if (empty($allRows)) continue;

        $firstRow = reset($allRows);
        $headers = array_values($firstRow ?: []);

        $activeSlots = (isset($userOv['activeSpeakers']) && is_array($userOv['activeSpeakers']))
            ? $userOv['activeSpeakers']
            : detectActiveSlots($headers, $speakerSlots);

        // Use user-supplied feedback col indices if present, otherwise use defaults.
        // Store as flat array of 1-based indices; header text is resolved at extract time.
        $feedbackColNums = (isset($userOv['feedback']) && is_array($userOv['feedback']) && hasAnyFeedbackCol($userOv['feedback']))
            ? array_values(array_filter($userOv['feedback'], fn($v) => is_numeric($v) && (int)$v > 0))
            : (is_array($defaultFeedbackCols) ? array_values(array_filter($defaultFeedbackCols, fn($v) => is_numeric($v) && (int)$v > 0)) : []);

        $slotsChanged    = $activeSlots !== array_map('intval', $defaultSlots);
        $feedbackChanged = $feedbackColNums !== (is_array($defaultFeedbackCols) ? array_values(array_filter($defaultFeedbackCols, fn($v) => is_numeric($v) && (int)$v > 0)) : []);

        $merged = $userOv;
        $merged['activeSpeakers'] = $activeSlots;
        $merged['feedback']       = $feedbackColNums; // flat array of 1-based indices

        if ($hasUserOverride) {
            $autoOverrides[$sheetName] = $merged;
            continue;
        }

        if ($slotsChanged || $feedbackChanged) {
            $autoOverrides[$sheetName] = $merged;
        }
    }

    return $autoOverrides;
}

// ─── Built-in scale rules ─────────────────────────────────────────────────────
$BUILTIN_RULES = [
    'strongly agree'        => 4, 'agree'                 => 3,
    'disagree'              => 2, 'strongly disagree'     => 1,
    'very satisfied'        => 4, 'somewhat satisfied'    => 3,
    'somewhat dissatisfied' => 2, 'very dissatisfied'     => 1,
    'always'                => 5, 'often'                 => 4,
    'sometimes'             => 3, 'rarely'                => 2,
    'never'                 => 1,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyRules(array &$row, array $rulesMap, array $scoreColIndices): void {
    foreach ($row as $idx => &$val) {
        if ($val === null || $val === '') continue;
        if (!isset($scoreColIndices[$idx])) continue;
        if (is_numeric($val)) continue;
        $key = strtolower(trim((string)$val));
        if (isset($rulesMap[$key])) $val = $rulesMap[$key];
    }
    unset($val);
}

function colAvg(array $rows, array $cols): ?float {
    $vals = [];
    foreach ($rows as $row) {
        foreach ($cols as $c) {
            $v = $row[$c] ?? null;
            if (is_numeric($v)) $vals[] = (float)$v;
        }
    }
    return count($vals) > 0 ? round(array_sum($vals) / count($vals), 2) : null;
}

function getResult(float $average, array $categoryScales): string {
    foreach ($categoryScales as $s) {
        if ($average >= (float)$s['min_score'] && $average <= (float)$s['max_score']) {
            return $s['descriptive_equivalent'];
        }
    }
    return $categoryScales[count($categoryScales) - 1]['descriptive_equivalent'] ?? 'Unsatisfactory';
}

function cellVal(array $row, ?int $idx): string {
    if ($idx === null) return '';
    return trim((string)($row[$idx] ?? ''));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
try {
    if (!isset($_FILES['excel_file'])) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $uploadError = $_FILES['excel_file']['error'];
    if ($uploadError !== UPLOAD_ERR_OK) {
        $uploadErrors = [
            UPLOAD_ERR_INI_SIZE   => 'File exceeds upload_max_filesize in php.ini',
            UPLOAD_ERR_FORM_SIZE  => 'File exceeds MAX_FILE_SIZE in form',
            UPLOAD_ERR_PARTIAL    => 'File was only partially uploaded',
            UPLOAD_ERR_NO_FILE    => 'No file was uploaded',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temp folder',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk',
            UPLOAD_ERR_EXTENSION  => 'A PHP extension blocked the upload',
        ];
        throw new Exception('Upload error: ' . ($uploadErrors[$uploadError] ?? "Code $uploadError"));
    }

    $file = $_FILES['excel_file'];
    $ext  = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, ['xlsx', 'xls', 'csv'])) {
        throw new Exception('Invalid file type. Please upload .xlsx, .xls, or .csv.');
    }

    // ── Parse POST params ────────────────────────────────────────────────────
    $rules = [];
    if (!empty($_POST['rules'])) {
        $d = json_decode($_POST['rules'], true);
        if (is_array($d)) $rules = $d;
    }
    $manuallyExcluded = [];
    if (!empty($_POST['excluded_columns'])) {
        $d = json_decode($_POST['excluded_columns'], true);
        if (is_array($d)) $manuallyExcluded = $d;
    }
    $speakerNames = [];
    if (!empty($_POST['speaker_names'])) {
        $d = json_decode($_POST['speaker_names'], true);
        if (is_array($d)) $speakerNames = $d;
    }
    $previewOnly = isset($_POST['preview_only']) && $_POST['preview_only'] === '1';

    // ── Parse dynamic column config from frontend (replaces hardcoded settings) ─
    $dynamicColumnConfig = null;
    if (!empty($_POST['column_config'])) {
        $d = json_decode($_POST['column_config'], true);
        if (is_array($d)) $dynamicColumnConfig = $d;
    }

    // ── Override settings with dynamic config if provided ─────────────────────
    if ($dynamicColumnConfig) {
        // Override categories (convert 1-based to 0-based)
        if (!empty($dynamicColumnConfig['categories'])) {
            $CATEGORIES = [];
            foreach ($dynamicColumnConfig['categories'] as $catName => $cols) {
                $CATEGORIES[$catName] = array_map(fn($c) => (int)$c - 1, $cols);
            }
        }

        // Safety: 'Feedbacks' is not a score category. Drop it if it was mapped as one.
        foreach (array_keys($CATEGORIES) as $catName) {
            $n = strtolower(trim((string)$catName));
            if ($n === 'feedbacks' || $n === 'feedback') {
                unset($CATEGORIES[$catName]);
            }
        }

        // Override speaker slots (convert 1-based to 0-based)
        if (!empty($dynamicColumnConfig['speaker_slots'])) {
            $SPEAKER_SLOTS = [];
            foreach ($dynamicColumnConfig['speaker_slots'] as $slot => $cols) {
                $SPEAKER_SLOTS[(int)$slot] = array_map(fn($c) => (int)$c - 1, $cols);
            }
        }

        // Override feedback columns — accept either flat array of 1-based indices
        // or legacy keyed map; always store as flat array of valid 1-based indices.
        if (!empty($dynamicColumnConfig['feedback_columns'])
            && is_array($dynamicColumnConfig['feedback_columns'])) {
            $raw = $dynamicColumnConfig['feedback_columns'];
            $flat = array_values(array_filter($raw, fn($v) => is_numeric($v) && (int)$v > 0));
            if (!empty($flat)) $FEEDBACK_COLS = $flat;
        }

        // Override respondent info columns (keep 1-based)
        if (!empty($dynamicColumnConfig['respondent_info_cols'])) {
            $RESPONDENT_COLS = $dynamicColumnConfig['respondent_info_cols'];
            // Recompute 0-based demographic column indices
            $COL_FULLNAME  = isset($RESPONDENT_COLS['fullname'])         && $RESPONDENT_COLS['fullname']         !== null ? (int)$RESPONDENT_COLS['fullname']         - 1 : null;
            $COL_EMAIL     = isset($RESPONDENT_COLS['email'])            && $RESPONDENT_COLS['email']            !== null ? (int)$RESPONDENT_COLS['email']            - 1 : null;
            $COL_SEX       = isset($RESPONDENT_COLS['sex'])              && $RESPONDENT_COLS['sex']              !== null ? (int)$RESPONDENT_COLS['sex']              - 1 : null;
            $COL_PART_TYPE = isset($RESPONDENT_COLS['participant_type']) && $RESPONDENT_COLS['participant_type'] !== null ? (int)$RESPONDENT_COLS['participant_type'] - 1 : null;
            $COL_DESIG     = isset($RESPONDENT_COLS['designation'])      && $RESPONDENT_COLS['designation']      !== null ? (int)$RESPONDENT_COLS['designation']      - 1 : null;
            $COL_SCHOOL    = isset($RESPONDENT_COLS['school'])           && $RESPONDENT_COLS['school']           !== null ? (int)$RESPONDENT_COLS['school']           - 1 : null;
        }

        // Use per-sheet overrides from dynamic config
        if (!empty($dynamicColumnConfig['per_sheet'])) {
            foreach ($dynamicColumnConfig['per_sheet'] as $sheetName => $sheetConfig) {
                $SHEET_OVERRIDES[$sheetName] = [
                    'activeSpeakers' => $sheetConfig['activeSpeakers'] ?? [],
                    'feedback'       => (isset($sheetConfig['feedback']) && is_array($sheetConfig['feedback']))
                                        ? array_values(array_filter($sheetConfig['feedback'], fn($v) => is_numeric($v) && (int)$v > 0))
                                        : [],
                ];

                // Store per-sheet category and speaker_slot column definitions (1-based from JS).
                // These override the global $CATEGORIES/$SPEAKER_SLOTS for this sheet,
                // so sheets with different column counts (e.g. Day 2 with an extra Speaker)
                // use the correct column positions instead of Day 1's positions.
                if (!empty($sheetConfig['categories'])) {
                    $SHEET_OVERRIDES[$sheetName]['categories'] = [];
                    foreach ($sheetConfig['categories'] as $catName => $cols) {
                        $SHEET_OVERRIDES[$sheetName]['categories'][$catName] = array_map(fn($c) => (int)$c - 1, $cols);
                    }
                }
                if (!empty($sheetConfig['speaker_slots'])) {
                    $SHEET_OVERRIDES[$sheetName]['speaker_slots'] = [];
                    foreach ($sheetConfig['speaker_slots'] as $slot => $cols) {
                        $SHEET_OVERRIDES[$sheetName]['speaker_slots'][(int)$slot] = array_map(fn($c) => (int)$c - 1, $cols);
                    }
                }
            }
        }
    }

    // ── Build rules map ───────────────────────────────────────────────────────
    $rulesMap = [];
    foreach ($rules as $r) {
        $find = strtolower(trim($r['find'] ?? ''));
        $repl = $r['replace'] ?? '';
        if ($find !== '') $rulesMap[$find] = is_numeric($repl) ? (float)$repl : $repl;
    }
    $rulesMap = array_merge($BUILTIN_RULES, $rulesMap);

    // ── Load spreadsheet ─────────────────────────────────────────────────────
    $reader = IOFactory::createReaderForFile($file['tmp_name']);
    // Ignore empty styled cells while retaining number/date formatting.
    $reader->setReadEmptyCells(false);
    $spreadsheet = $reader->load($file['tmp_name']);
    // ── AUTO-DETECT per-sheet overrides ───────────────────────────────────────
    // Scans each sheet's headers to find where feedback questions land and
    // which speaker slots are actually present. User-saved overrides in DB
    // always take precedence over auto-detection.
    $effectiveOverrides = buildAutoOverrides(
        $spreadsheet,
        $SPEAKER_SLOTS,
        $FEEDBACK_COLS,
        $SKIP_SHEETS,
        $SHEET_OVERRIDES,
        $CATEGORIES
    );
    // ── Build a sheetName → "Day N" map (skip sheets are excluded) ─────────────
    // This ensures respondents get the same normalized day labels as the
    // consolidated output, regardless of what the Excel tab is named.
    // FIX: If the JS frontend sent a 'sheet_names' array (e.g. ["Day 2"]), use
    // those labels directly so container-linked imports (Add Day Import) get
    // the correct starting day label instead of always counting from Day 1.
    $jsSheetNames = [];
    if (!empty($_POST['sheet_names'])) {
        $decoded = json_decode($_POST['sheet_names'], true);
        if (is_array($decoded)) $jsSheetNames = array_values($decoded);
    }
    $dayLabelMap = [];
    $dayLabelCounter = 1;
    // Start counter from the first JS label, e.g. "Day 2" -> start at 2
    if (!empty($jsSheetNames[0]) && preg_match('/(\d+)/', $jsSheetNames[0], $m)) {
        $dayLabelCounter = (int)$m[1];
    }
    $jsIdx = 0;
    foreach ($spreadsheet->getSheetNames() as $_sn) {
        if (in_array(strtolower(trim($_sn)), $SKIP_SHEETS)) continue;
        // Use the JS-provided label if available, otherwise generate "Day N"
        $dayLabelMap[$_sn] = !empty($jsSheetNames[$jsIdx])
            ? $jsSheetNames[$jsIdx]
            : 'Day ' . $dayLabelCounter;
        $dayLabelCounter++;
        $jsIdx++;
    }
    $sheet           = $spreadsheet->getActiveSheet();
    $activeSheetName = $sheet->getTitle();
    $rawRows         = $sheet->toArray(null, true, true, true);

    if (count($rawRows) < 2) throw new Exception('File appears to be empty or has no data rows.');

    $headerRow = array_shift($rawRows);
    $headers   = array_values($headerRow);

    // ── Auto-detect respondent info columns from headers (fallback when not set by UI) ──
    // Keywords to match against each column name (case-insensitive substring match).
    // Only fills in a slot if the frontend did not already provide it.
    $autoDetectMap = [
        'email'            => ['email address', 'e-mail address', 'email add', 'email', 'e-mail', 'gmail'],
        'fullname'         => ['full name', 'complete name', 'name of respondent', 'full_name'],
        'sex'              => ['sex/gender', 'sex / gender', 'kasarian', 'male/female', 'gender'],
        'participant_type' => ['type of participant', 'participant type', 'participants'],
        'designation'      => ['position/designation', 'designation/position', 'designation', 'position'],
        'school'           => ['office/school', 'school/office', 'school', 'office', 'station'],
    ];
    foreach ($autoDetectMap as $riKey => $keywords) {
        // Skip if already provided by the frontend
        if (!empty($RESPONDENT_COLS[$riKey])) continue;
        // Sort keywords longest-first so more specific phrases match before shorter ones
        usort($keywords, fn($a, $b) => strlen($b) - strlen($a));
        foreach ($headers as $idx => $hdr) {
            $hl = strtolower(trim((string)($hdr ?? '')));
            foreach ($keywords as $kw) {
                if (strpos($hl, $kw) !== false) {
                    $RESPONDENT_COLS[$riKey] = $idx + 1; // store as 1-based
                    break 2; // found — move on to next riKey
                }
            }
        }
    }
    // Re-compute 0-based indices after auto-detection
    $COL_FULLNAME  = isset($RESPONDENT_COLS['fullname'])         && $RESPONDENT_COLS['fullname']         !== null ? (int)$RESPONDENT_COLS['fullname']         - 1 : $COL_FULLNAME;
    $COL_EMAIL     = isset($RESPONDENT_COLS['email'])            && $RESPONDENT_COLS['email']            !== null ? (int)$RESPONDENT_COLS['email']             - 1 : $COL_EMAIL;
    $COL_SEX       = isset($RESPONDENT_COLS['sex'])              && $RESPONDENT_COLS['sex']              !== null ? (int)$RESPONDENT_COLS['sex']               - 1 : $COL_SEX;
    $COL_PART_TYPE = isset($RESPONDENT_COLS['participant_type']) && $RESPONDENT_COLS['participant_type'] !== null ? (int)$RESPONDENT_COLS['participant_type']   - 1 : $COL_PART_TYPE;
    $COL_DESIG     = isset($RESPONDENT_COLS['designation'])      && $RESPONDENT_COLS['designation']      !== null ? (int)$RESPONDENT_COLS['designation']        - 1 : $COL_DESIG;
    $COL_SCHOOL    = isset($RESPONDENT_COLS['school'])           && $RESPONDENT_COLS['school']           !== null ? (int)$RESPONDENT_COLS['school']             - 1 : $COL_SCHOOL;

    // ── Validate email column: if all sampled values are 'anonymous' or blank,
    //    scan headers for a more specific "Email Address" column and prefer it.
    //    This handles the MS Forms pattern where col D is the system "Email" field
    //    (always 'anonymous') while col L is the participant's own "Email Address".
    if ($COL_EMAIL !== null) {
        $ANON_VALUES = ['anonymous', 'n/a', 'na', 'none', '-', ''];
        $sampleSize  = min(5, count($rawRows));
        $allAnon     = true;
        for ($si = 0; $si < $sampleSize; $si++) {
            $rowArr = array_values($rawRows[$si]);
            $v = strtolower(trim((string)($rowArr[$COL_EMAIL] ?? '')));
            if ($v !== '' && !in_array($v, $ANON_VALUES, true)) { $allAnon = false; break; }
        }
        if ($allAnon) {
            // The current email column only has placeholder values.
            // Look for a column whose header contains "email address" or "email add"
            // and whose first non-blank data value looks like a real email.
            $specificKws = ['email address', 'e-mail address', 'email add'];
            foreach ($headers as $idx => $hdr) {
                $hl = strtolower(trim((string)($hdr ?? '')));
                $isSpecific = false;
                foreach ($specificKws as $kw) {
                    if (strpos($hl, $kw) !== false) { $isSpecific = true; break; }
                }
                if (!$isSpecific) continue;
                // Confirm it has at least one real email-looking value in sample rows
                for ($si = 0; $si < $sampleSize; $si++) {
                    $rowArr = array_values($rawRows[$si]);
                    $v = strtolower(trim((string)($rowArr[$idx] ?? '')));
                    if ($v !== '' && !in_array($v, $ANON_VALUES, true) && strpos($v, '@') !== false) {
                        $COL_EMAIL = $idx; // 0-based
                        $RESPONDENT_COLS['email'] = $idx + 1;
                        break 2;
                    }
                }
            }
        }
    }

    $scaleWords = [
        'strongly agree', 'agree', 'disagree', 'strongly disagree',
        'very satisfied', 'satisfied', 'dissatisfied',
        'always', 'often', 'sometimes', 'rarely', 'never',
        'excellent', 'very good', 'good', 'poor', 'neutral', 'outstanding',
    ];

    // ── Build score-only column set (0-based) ─────────────────────────────────
    $scoreColSet = [];
    foreach ($CATEGORIES    as $cols) foreach ($cols as $c) $scoreColSet[$c] = true;
    foreach ($SPEAKER_SLOTS as $cols) foreach ($cols as $c) $scoreColSet[$c] = true;

    // Only exclude respondent/feedback columns that do NOT overlap with score categories
    foreach ($RESPONDENT_COLS as $col) {
        if ($col !== null) {
            $idx0 = (int)$col - 1;
            if (!isset($scoreColSet[$idx0])) continue; // already not in set
            // Check if this column is part of any category or speaker slot
            $isScoreCol = false;
            foreach ($CATEGORIES    as $catCols) { if (in_array($idx0, $catCols)) { $isScoreCol = true; break; } }
            if (!$isScoreCol) foreach ($SPEAKER_SLOTS as $slotCols) { if (in_array($idx0, $slotCols)) { $isScoreCol = true; break; } }
            if (!$isScoreCol) unset($scoreColSet[$idx0]);
        }
    }
    foreach ($FEEDBACK_COLS as $col) {
        if ($col !== null) {
            $idx0 = (int)$col - 1;
            if (!isset($scoreColSet[$idx0])) continue;
            $isScoreCol = false;
            foreach ($CATEGORIES    as $catCols) { if (in_array($idx0, $catCols)) { $isScoreCol = true; break; } }
            if (!$isScoreCol) foreach ($SPEAKER_SLOTS as $slotCols) { if (in_array($idx0, $slotCols)) { $isScoreCol = true; break; } }
            if (!$isScoreCol) unset($scoreColSet[$idx0]);
        }
    }

    // ── Process rows ──────────────────────────────────────────────────────────
    $replacementCount = 0;
    $processedRows    = [];
    foreach ($rawRows as $row) {
        $r = array_values($row);

        // --- FIX: Skip completely blank rows (e.g. trailing empty rows in Excel).
        // A row is considered blank if every cell is null or empty string.
        $rowIsBlank = true;
        foreach ($r as $cell) {
            if ($cell !== null && trim((string)$cell) !== '') { $rowIsBlank = false; break; }
        }
        if ($rowIsBlank) continue;

        foreach ($r as $idx => &$val) {
            if ($val === null || $val === '') continue;
            if (!isset($scoreColSet[$idx])) continue;
            if (is_numeric($val)) continue;
            $key = strtolower(trim((string)$val));
            if (isset($rulesMap[$key])) { $val = $rulesMap[$key]; $replacementCount++; }
        }
        unset($val);
        $processedRows[] = $r;
    }

    // ── Column detection ──────────────────────────────────────────────────────
    $detectedQuestionColumns = [];
    $detectedInfoColumns     = [];
    foreach ($headers as $index => $header) {
        $hl       = strtolower(trim($header ?? ''));
        $excluded = ($hl === 'id');
        if (!$excluded) {
            foreach ($EXCLUDED_KEYWORDS as $kw) {
                if (strpos($hl, $kw) !== false) { $excluded = true; break; }
            }
        }
        if ($excluded) { $detectedInfoColumns[] = $index; continue; }

        $numericCount  = 0;
        $totalCount    = 0;
        $hasScaleWords = false;
        foreach ($processedRows as $row) {
            $v = $row[$index] ?? null;
            if ($v === null || $v === '') continue;
            $totalCount++;
            if (is_numeric($v)) {
                $numericCount++;
            } else {
                $cs = strtolower(trim((string)$v));
                if (in_array($cs, $scaleWords, true)) $hasScaleWords = true;
            }
        }
        $ratio = $totalCount > 0 ? $numericCount / $totalCount : 0;
        if ($totalCount > 0 && ($ratio >= 0.4 || $hasScaleWords)) {
            $detectedQuestionColumns[] = $index;
        } else {
            $detectedInfoColumns[] = $index;
        }
    }

    // ── Preview mode ──────────────────────────────────────────────────────────
    if ($previewOnly) {
        $columnMeta = [];
        foreach ($headers as $index => $header) {
            $samples = [];
            foreach ($processedRows as $row) {
                $v = $row[$index] ?? null;
                if ($v !== null && $v !== '' && count($samples) < 3) $samples[] = (string)$v;
            }
            $columnMeta[] = [
                'index'      => $index,
                'header'     => $header,
                'isQuestion' => in_array($index, $detectedQuestionColumns),
                'samples'    => $samples,
            ];
        }
        $consolidated = computeConsolidated(
            $spreadsheet, $rulesMap, $speakerNames,
            $CATEGORIES, $SPEAKER_SLOTS, $SPEAKER_CRITERIA,
            $RESULT_THRESHOLDS, $SKIP_SHEETS, $BUILTIN_RULES,
            $effectiveOverrides, $FEEDBACK_COLS, 4.0, $RESPONDENT_COLS,
            $dayLabelMap,  // BUG 4 FIX: pass day label map
            $SPEAKER_RATING_SCALES,
            $CATEGORY_RATING_SCALES
        );
        echo json_encode([
            'success'           => true,
            'preview'           => true,
            'columnMeta'        => $columnMeta,
            'totalRows'         => count($processedRows),
            'consolidated'      => $consolidated,
            // Auto-detected overrides are sent back so the UI can offer
            // to save them to the settings page automatically.
            'detectedOverrides' => $effectiveOverrides,
        ]);
        exit;
    }

    // ── Build known score column lookup ───────────────────────────────────────
    // Look up active sheet override by actual name first, then by its day label.
    $activeSheetOv = $effectiveOverrides[$activeSheetName]
                  ?? $effectiveOverrides[$dayLabelMap[$activeSheetName] ?? '']
                  ?? null;
    $activeSlotsList = ($activeSheetOv && isset($activeSheetOv['activeSpeakers'])) ? $activeSheetOv['activeSpeakers'] : null;

    // When dynamic column config is provided from frontend, use it directly
    // Otherwise, fall back to database/default settings for column filtering
    if ($dynamicColumnConfig && (!empty($dynamicColumnConfig['categories']) || !empty($dynamicColumnConfig['speaker_slots']))) {
        // Dynamic mode: score columns are all detected question columns minus excluded
        $questionColumns = array_values(array_filter(
            $detectedQuestionColumns,
            fn($i) => !in_array($i, $manuallyExcluded)
        ));
        $infoColumns = array_merge(
            $detectedInfoColumns,
            array_filter($detectedQuestionColumns, fn($i) => in_array($i, $manuallyExcluded))
        );
    } else {
        // Legacy mode: filter by known score columns from settings
        $allKnownScoreCols = [];
        foreach ($CATEGORIES as $cols) $allKnownScoreCols = array_merge($allKnownScoreCols, $cols);
        foreach ($SPEAKER_SLOTS as $slot => $cols) {
            if (is_array($activeSlotsList) && !in_array((int)$slot, array_map('intval', $activeSlotsList))) {
                continue;
            }
            $allKnownScoreCols = array_merge($allKnownScoreCols, $cols);
        }
        $allKnownScoreCols = array_flip($allKnownScoreCols);

        $questionColumns = array_values(array_filter(
            $detectedQuestionColumns,
            fn($i) => !in_array($i, $manuallyExcluded) && isset($allKnownScoreCols[$i])
        ));

        $infoColumns = array_merge(
            $detectedInfoColumns,
            array_filter($detectedQuestionColumns, fn($i) =>
                in_array($i, $manuallyExcluded) || !isset($allKnownScoreCols[$i])
            )
        );
    }
    sort($infoColumns);

    if (empty($questionColumns)) throw new Exception('No score columns selected. Please map columns in the import interface.');

    // ── Determine active feedback column indices for this sheet (flat 1-based array) ──
    $activeFbColNums = ($activeSheetOv
        && isset($activeSheetOv['feedback'])
        && is_array($activeSheetOv['feedback'])
        && hasAnyFeedbackCol($activeSheetOv['feedback']))
        ? array_values(array_filter($activeSheetOv['feedback'], fn($v) => is_numeric($v) && (int)$v > 0))
        : (is_array($FEEDBACK_COLS) ? array_values(array_filter($FEEDBACK_COLS, fn($v) => is_numeric($v) && (int)$v > 0)) : []);

    // Build header-label → 1-based-index map for the active sheet
    $activeFbCols = buildFeedbackHeaderMap($headers, $activeFbColNums);

    // ── Build respondent list ─────────────────────────────────────────────────
    $respondents    = [];
    $allAverages    = [];
    $globalMaxScore = 0;
    $skippedRows    = 0;

    // Helper: extract respondents from a set of processed rows for a given day
    $extractRespondents = function(
        array $processedRows, string $dayName, array $fbCols,
        array $sheetQuestionColumns = null, array $sheetInfoColumns = null
    ) use (
        $questionColumns, $infoColumns, $rulesMap,
        $COL_FULLNAME, $COL_EMAIL, $COL_SEX, $COL_PART_TYPE, $COL_DESIG, $COL_SCHOOL,
        &$allAverages, &$globalMaxScore, &$skippedRows
    ): array {
        // Use per-sheet columns if provided, otherwise fall back to active sheet's columns
        if ($sheetQuestionColumns !== null) $questionColumns = $sheetQuestionColumns;
        if ($sheetInfoColumns     !== null) $infoColumns     = $sheetInfoColumns;
        $dayRespondents = [];
        foreach ($processedRows as $row) {
            // Skip summary/formula rows that have no respondent identity.
            // These are rows (e.g. Excel average rows at the bottom) that contain
            // numeric values but no name, email, sex, or participant_type.
            // 'anonymous' IS a valid identity — it is a real MS Forms submission
            // in privacy mode and must not be skipped.
            $identityCols = array_filter(
                [$COL_FULLNAME, $COL_EMAIL, $COL_SEX, $COL_PART_TYPE, $COL_DESIG, $COL_SCHOOL],
                fn($c) => $c !== null
            );
            if (!empty($identityCols)) {
                $hasIdentity = false;
                foreach ($identityCols as $ic) {
                    $v = trim((string)($row[$ic] ?? ''));
                    // Accept any non-empty value, including 'anonymous'
                    if ($v !== '') { $hasIdentity = true; break; }
                }
                if (!$hasIdentity) { $skippedRows++; continue; }
            }

            $name = cellVal($row, $COL_FULLNAME);
            if ($name === '' || strtolower($name) === 'anonymous') {
                $emailVal = cellVal($row, $COL_EMAIL);
                $name = ($emailVal !== '' && strtolower($emailVal) !== 'anonymous') ? $emailVal : 'Unknown';
            }

            $hasData = false;
            foreach ($questionColumns as $qi) {
                if (isset($row[$qi]) && $row[$qi] !== null && $row[$qi] !== '') { $hasData = true; break; }
            }
            if (!$hasData) { $skippedRows++; continue; }

            $info = array_map(fn($ii) => trim((string)($row[$ii] ?? '')), $infoColumns);

            $scores = [];
            foreach ($questionColumns as $qi) {
                $v = $row[$qi] ?? null;
                if (is_numeric($v)) {
                    $fv = (float)$v;
                    $scores[] = $fv;
                    if ($fv > $globalMaxScore) $globalMaxScore = $fv;
                } else {
                    $scores[] = null;
                }
            }

            $feedback = [];
            foreach ($fbCols as $label => $colIdx) {
                // $label is the actual column header text; $colIdx is 1-based
                if ($colIdx !== null) {
                    $feedback[$label] = trim((string)($row[$colIdx - 1] ?? ''));
                }
            }

            $valid   = array_filter($scores, fn($s) => $s !== null);
            $average = count($valid) > 0 ? round(array_sum($valid) / count($valid), 2) : 0;
            $allAverages[] = $average;

            $dayRespondents[] = [
                'name'             => $name,
                'fullname'         => $name,
                'day'              => $dayName,
                'info'             => $info,
                'scores'           => $scores,
                'average'          => $average,
                'result'           => '',
                'feedback'         => $feedback,
                'email'            => cellVal($row, $COL_EMAIL),
                'sex'              => cellVal($row, $COL_SEX),
                'participant_type' => cellVal($row, $COL_PART_TYPE),
                'designation'      => cellVal($row, $COL_DESIG),
                'school_office'    => cellVal($row, $COL_SCHOOL),
            ];
        }
        return $dayRespondents;
    };

    // Process active sheet
    $respondents = $extractRespondents($processedRows, $dayLabelMap[$activeSheetName] ?? $activeSheetName, $activeFbCols);

    // Process remaining non-skipped sheets
    foreach ($spreadsheet->getSheetNames() as $otherSheetName) {
        if ($otherSheetName === $activeSheetName) continue;
        if (in_array(strtolower(trim($otherSheetName)), $SKIP_SHEETS)) continue;

        // Determine feedback columns for this sheet (may differ per day)
        // Look up by actual sheet name first, then by its normalised day label.
        $otherOv = $effectiveOverrides[$otherSheetName]
                ?? $effectiveOverrides[$dayLabelMap[$otherSheetName] ?? '']
                ?? null;
        $otherFbColNums = ($otherOv
            && isset($otherOv['feedback'])
            && is_array($otherOv['feedback'])
            && hasAnyFeedbackCol($otherOv['feedback']))
            ? array_values(array_filter($otherOv['feedback'], fn($v) => is_numeric($v) && (int)$v > 0))
            : (is_array($FEEDBACK_COLS) ? array_values(array_filter($FEEDBACK_COLS, fn($v) => is_numeric($v) && (int)$v > 0)) : []);

        $otherWs      = $spreadsheet->getSheetByName($otherSheetName);
        $otherRawRows = $otherWs->toArray(null, true, true, true);
        if (count($otherRawRows) < 2) continue;

        // Build header map for this sheet's feedback columns (before shifting header row)
        $otherSheetHeaderRow = array_values(reset($otherRawRows) ?: []);
        $otherFbCols = buildFeedbackHeaderMap($otherSheetHeaderRow, $otherFbColNums);

        array_shift($otherRawRows); // remove header row

        // Build score column set for rule application
        $otherScoreColSet = [];
        foreach ($CATEGORIES    as $cols) foreach ($cols as $c) $otherScoreColSet[$c] = true;
        foreach ($SPEAKER_SLOTS as $cols) foreach ($cols as $c) $otherScoreColSet[$c] = true;
        // Only exclude respondent/feedback columns that do NOT overlap with score categories
        foreach ($RESPONDENT_COLS as $col) {
            if ($col !== null) {
                $idx0 = (int)$col - 1;
                $isScore = false;
                foreach ($CATEGORIES    as $cc) { if (in_array($idx0, $cc)) { $isScore = true; break; } }
                if (!$isScore) foreach ($SPEAKER_SLOTS as $sc) { if (in_array($idx0, $sc)) { $isScore = true; break; } }
                if (!$isScore) unset($otherScoreColSet[$idx0]);
            }
        }
        foreach ($otherFbCols as $_label => $col) {
            if ($col !== null) {
                $idx0 = (int)$col - 1;
                $isScore = false;
                foreach ($CATEGORIES    as $cc) { if (in_array($idx0, $cc)) { $isScore = true; break; } }
                if (!$isScore) foreach ($SPEAKER_SLOTS as $sc) { if (in_array($idx0, $sc)) { $isScore = true; break; } }
                if (!$isScore) unset($otherScoreColSet[$idx0]);
            }
        }

        // Apply text→numeric rules
        $otherRows = [];
        foreach ($otherRawRows as $row) {
            $r = array_values($row);

            // --- FIX: Skip completely blank rows (e.g. trailing empty rows in Excel).
            $rowIsBlank = true;
            foreach ($r as $cell) {
                if ($cell !== null && trim((string)$cell) !== '') { $rowIsBlank = false; break; }
            }
            if ($rowIsBlank) continue;

            applyRules($r, $rulesMap, $otherScoreColSet);
            $otherRows[] = $r;
        }

        // ── Detect question/info columns specifically for this sheet ──────────
        // Each sheet may have different column layouts; reusing the active sheet's
        // detected columns causes incorrect respondent counts for other days.
        $otherAllRows = $otherWs->toArray(null, true, true, true);
        $otherHeaders = array_values(reset($otherAllRows) ?: []);

        $otherDetectedQuestionColumns = [];
        $otherDetectedInfoColumns     = [];
        foreach ($otherHeaders as $index => $header) {
            $hl       = strtolower(trim($header ?? ''));
            $excluded = ($hl === 'id');
            if (!$excluded) {
                foreach ($EXCLUDED_KEYWORDS as $kw) {
                    if (strpos($hl, $kw) !== false) { $excluded = true; break; }
                }
            }
            if ($excluded) { $otherDetectedInfoColumns[] = $index; continue; }

            $numericCount  = 0;
            $totalCount    = 0;
            $hasScaleWords = false;
            foreach ($otherRows as $row) {
                $v = $row[$index] ?? null;
                if ($v === null || $v === '') continue;
                $totalCount++;
                if (is_numeric($v)) {
                    $numericCount++;
                } else {
                    $cs = strtolower(trim((string)$v));
                    if (in_array($cs, $scaleWords, true)) $hasScaleWords = true;
                }
            }
            $ratio = $totalCount > 0 ? $numericCount / $totalCount : 0;
            if ($totalCount > 0 && ($ratio >= 0.4 || $hasScaleWords)) {
                $otherDetectedQuestionColumns[] = $index;
            } else {
                $otherDetectedInfoColumns[] = $index;
            }
        }

        // Apply same column filtering logic (dynamic vs legacy) per sheet
        // Prefer per-sheet column indices from SHEET_OVERRIDES (sent by frontend) —
        // these are the most accurate since they reflect the actual mapped columns per sheet.
        $otherSheetOv        = $effectiveOverrides[$otherSheetName] ?? null;
        $otherActiveSlotList = ($otherSheetOv && isset($otherSheetOv['activeSpeakers'])) ? $otherSheetOv['activeSpeakers'] : null;

        // Use per-sheet categories/speakers if available, otherwise fall back to global
        $otherSheetCats    = !empty($otherSheetOv['categories'])    ? $otherSheetOv['categories']    : $CATEGORIES;
        $otherSheetSlots   = !empty($otherSheetOv['speaker_slots']) ? $otherSheetOv['speaker_slots'] : $SPEAKER_SLOTS;

        $otherKnownScoreCols = [];
        foreach ($otherSheetCats as $cols) $otherKnownScoreCols = array_merge($otherKnownScoreCols, $cols);
        foreach ($otherSheetSlots as $slot => $cols) {
            if (is_array($otherActiveSlotList) && !in_array((int)$slot, array_map('intval', $otherActiveSlotList))) continue;
            $otherKnownScoreCols = array_merge($otherKnownScoreCols, $cols);
        }
        $otherKnownScoreColsFlipped = array_flip($otherKnownScoreCols);

        if ($dynamicColumnConfig && (!empty($dynamicColumnConfig['categories']) || !empty($dynamicColumnConfig['speaker_slots']))) {
            // Dynamic mode: use detected question cols but restrict to known score cols for this sheet
            $otherSheetQuestionColumns = array_values(array_filter(
                $otherDetectedQuestionColumns,
                fn($i) => !in_array($i, $manuallyExcluded) &&
                    (empty($otherKnownScoreCols) || isset($otherKnownScoreColsFlipped[$i]))
            ));
            $otherSheetInfoColumns = array_merge(
                $otherDetectedInfoColumns,
                array_filter($otherDetectedQuestionColumns, fn($i) =>
                    in_array($i, $manuallyExcluded) ||
                    (!empty($otherKnownScoreCols) && !isset($otherKnownScoreColsFlipped[$i]))
                )
            );
        } else {
            $otherSheetQuestionColumns = array_values(array_filter(
                $otherDetectedQuestionColumns,
                fn($i) => !in_array($i, $manuallyExcluded) && isset($otherKnownScoreColsFlipped[$i])
            ));
            $otherSheetInfoColumns = array_merge(
                $otherDetectedInfoColumns,
                array_filter($otherDetectedQuestionColumns, fn($i) =>
                    in_array($i, $manuallyExcluded) || !isset($otherKnownScoreColsFlipped[$i])
                )
            );
        }

        $otherRespondents = $extractRespondents($otherRows, $dayLabelMap[$otherSheetName] ?? $otherSheetName, $otherFbCols,
            $otherSheetQuestionColumns ?: null, $otherSheetInfoColumns ?: null);
        $respondents = array_merge($respondents, $otherRespondents);

    }

    if (empty($respondents)) throw new Exception('No valid respondent data found.');

    // ── Detect scale ──────────────────────────────────────────────────────────
    $detectedScale = $globalMaxScore;
    foreach ($SCALE_CANDIDATES as $s) {
        if ($globalMaxScore <= $s) { $detectedScale = $s; break; }
    }
    if ($globalMaxScore > max($SCALE_CANDIDATES)) $detectedScale = ceil($globalMaxScore);

    foreach ($respondents as &$r) {
        $r['result'] = getResult($r['average'], $CATEGORY_RATING_SCALES);
    }
    unset($r);

    // ── Consolidated data ─────────────────────────────────────────────────────
    $consolidated = computeConsolidated(
        $spreadsheet, $rulesMap, $speakerNames,
        $CATEGORIES, $SPEAKER_SLOTS, $SPEAKER_CRITERIA,
        $RESULT_THRESHOLDS, $SKIP_SHEETS, $BUILTIN_RULES,
        $effectiveOverrides, $FEEDBACK_COLS, $detectedScale, $RESPONDENT_COLS,
        $dayLabelMap,
        $SPEAKER_RATING_SCALES,
        $CATEGORY_RATING_SCALES
    );

    // ── Question → category map ───────────────────────────────────────────────
    $questionCategoryMap = [];
    foreach ($questionColumns as $qi => $colIdx) {
        foreach ($CATEGORIES as $catName => $catCols) {
            if (in_array($colIdx, $catCols)) { $questionCategoryMap[$qi] = $catName; break; }
        }
    }

    $overallAverage = count($allAverages) > 0
        ? round(array_sum($allAverages) / count($allAverages), 2)
        : 0;

    // Respondent count: each row in each day/sheet is a distinct submission.
    // A person who attended and responded on Day 1, Day 2, and Day 3 has THREE
    // valid responses — one per day. We do NOT deduplicate cross-day here because
    // that would cause the per-day counts (shown in the dashboard) to shrink based
    // on the processing order of sheets, producing wrong numbers like 10, 7, 50.
    //
    // Within a single day, true duplicates (same email submitted twice on the same
    // day) ARE deduplicated.
    $PLACEHOLDER_EMAILS = ['anonymous', 'n/a', 'none', 'na', '-', 'n.a.', 'no email', 'noemail', 'no_email'];
    $uniqueRespondentCount = 0;

    // Group respondents by day first, then dedup within each day
    $respondentsByDay = [];
    foreach ($respondents as $r) {
        $day = $r['day'] ?? '__noday__';
        $respondentsByDay[$day][] = $r;
    }

    foreach ($respondentsByDay as $day => $dayRespondents) {
        $seenEmailsThisDay = [];
        foreach ($dayRespondents as $r) {
            $email  = strtolower(trim($r['email'] ?? ''));
            $isReal = $email !== '' && !in_array($email, $PLACEHOLDER_EMAILS, true);
            if ($isReal) {
                // Dedup within this day only — same person can appear on multiple days
                if (!isset($seenEmailsThisDay[$email])) {
                    $seenEmailsThisDay[$email] = true;
                    $uniqueRespondentCount++;
                }
            } else {
                // Anonymous/blank = count individually (real MS Forms privacy submission)
                $uniqueRespondentCount++;
            }
        }
    }

    echo json_encode(['success' => true, 'data' => [
        'totalRespondents'    => $uniqueRespondentCount,
        'totalQuestions'      => count($questionColumns),
        'overallAverage'      => $overallAverage,
        'highest'             => count($allAverages) > 0 ? round(max($allAverages), 2) : 0,
        'lowest'              => count($allAverages) > 0 ? round(min($allAverages), 2) : 0,
        'detectedScale'       => $detectedScale,
        'replacementCount'    => $replacementCount,
        'infoHeaders'         => array_values(array_map(fn($ii) => $headers[$ii] ?? 'Col' . ($ii + 1), $infoColumns)),
        'questionHeaders'     => array_values(array_map(fn($qi) => $headers[$qi] ?? 'Q' . ($qi + 1), $questionColumns)),
        'respondents'         => $respondents,
        'consolidated'        => $consolidated,
        'questionCategoryMap' => $questionCategoryMap,
        'detectedOverrides'   => $effectiveOverrides,
    ]]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

// ─── Build a header-name → 0-based-index map for a sheet's header row ────────
// Used to remap fixed column indices to their correct positions in sheets that
// have a different number of columns (e.g. Day 2 with an extra Speaker slot).
function buildHeaderMap(array $headerRow): array {
    $map = [];
    foreach ($headerRow as $idx => $hdr) {
        if ($hdr !== null && trim((string)$hdr) !== '') {
            // Normalise: lowercase, collapse whitespace, strip non-breaking spaces
            $key = preg_replace('/\s+/', ' ', strtolower(trim(str_replace("\xc2\xa0", ' ', (string)$hdr))));
            $map[$key] = $idx;
        }
    }
    return $map;
}

// ─── Remap a set of 0-based column indices from a reference header to a
//     target sheet's header by matching column names.
// Returns the remapped indices; indices whose header cannot be found in the
// target sheet are dropped so they never produce false positives.
function remapColsByHeader(array $indices, array $refHeaders, array $targetHeaderMap): array {
    $remapped = [];
    foreach ($indices as $origIdx) {
        $hdr = $refHeaders[$origIdx] ?? null;
        if ($hdr === null) continue;
        $key = preg_replace('/\s+/', ' ', strtolower(trim(str_replace("\xc2\xa0", ' ', (string)$hdr))));
        if (isset($targetHeaderMap[$key])) {
            $remapped[] = $targetHeaderMap[$key];
        }
        // If the column header doesn't exist in the target sheet, simply omit it —
        // that speaker slot is not present in this sheet.
    }
    return array_unique($remapped);
}

// ─── Consolidated computation ──────────────────────────────────────────────────
function computeConsolidated(
    $spreadsheet, array $rulesMap, array $speakerNames,
    array $categories, array $speakerSlots, array $criteria,
    array $thresholds, array $skipSheets, array $builtinRules,
    array $sheetOverrides = [], array $feedbackCols = [],
    float $scale = 4.0, array $respondentCols = [],
    array $dayLabelMap = [],
    array $speakerScales = [],
    array $categoryScales = []
): array {
    $effectiveRules = array_merge($builtinRules, $rulesMap);

    $daySheets            = [];
    $allDayCategoryTotals = [];
    $dayCounter           = 1;

    // ── Build reference header from the first non-skipped sheet ──────────────
    // We use it to remap column indices into each subsequent sheet by name.
    $referenceHeaders = null;
    foreach ($spreadsheet->getSheetNames() as $sn) {
        if (in_array(strtolower(trim($sn)), $skipSheets)) continue;
        $firstSheet       = $spreadsheet->getSheetByName($sn);
        $firstRows        = $firstSheet->rangeToArray('A1:' . $firstSheet->getHighestDataColumn() . '1', null, true, true, true);
        if (!empty($firstRows)) {
            $referenceHeaders = array_values(reset($firstRows));
        }
        break;
    }

    foreach ($spreadsheet->getSheetNames() as $sheetName) {
        if (in_array(strtolower(trim($sheetName)), $skipSheets)) {
            continue;
        }

        $ws      = $spreadsheet->getSheetByName($sheetName);
        $rawRows = $ws->toArray(null, true, true, true);

        if (count($rawRows) < 2) continue;

        // Extract and index this sheet's header row for name-based remapping
        $sheetHeaderRow  = array_values(reset($rawRows));
        $sheetHeaderMap  = buildHeaderMap($sheetHeaderRow);
        array_shift($rawRows);

        // ── Remap categories and speaker slots to this sheet's actual column positions ──
        // Priority: (1) explicit per-sheet column config from frontend (most accurate),
        //           (2) header-name remapping (corrects for column count differences),
        //           (3) global CATEGORIES/SPEAKER_SLOTS as-is (fallback).
        $sheetOvCols = $sheetOverrides[$sheetName] ?? null;

        $sheetCategories   = [];
        if (!empty($sheetOvCols['categories'])) {
            // Use explicit per-sheet col indices from frontend
            $sheetCategories = $sheetOvCols['categories'];
        } else {
            foreach ($categories as $catName => $cols) {
                $remapped = ($referenceHeaders !== null)
                    ? remapColsByHeader($cols, $referenceHeaders, $sheetHeaderMap)
                    : $cols;
                if (!empty($remapped)) $sheetCategories[$catName] = $remapped;
            }
        }

        $sheetSpeakerSlots = [];
        if (!empty($sheetOvCols['speaker_slots'])) {
            // Use explicit per-sheet col indices from frontend
            $sheetSpeakerSlots = $sheetOvCols['speaker_slots'];
        } else {
            foreach ($speakerSlots as $slot => $cols) {
                $remapped = ($referenceHeaders !== null)
                    ? remapColsByHeader($cols, $referenceHeaders, $sheetHeaderMap)
                    : $cols;
                if (!empty($remapped)) $sheetSpeakerSlots[(int)$slot] = $remapped;
            }
        }

        // Flat score col list for this sheet (remapped)
        $sheetAllScoreCols = array_merge(
            ...(!empty($sheetCategories)   ? array_values($sheetCategories)   : [[]]),
            ...(!empty($sheetSpeakerSlots) ? array_values($sheetSpeakerSlots) : [[]])
        );

        $sheetScoreColSet = [];
        foreach ($sheetCategories   as $cols) foreach ($cols as $c) $sheetScoreColSet[$c] = true;
        foreach ($sheetSpeakerSlots as $cols) foreach ($cols as $c) $sheetScoreColSet[$c] = true;

        // Only exclude respondent/feedback columns that do NOT overlap with score categories
        foreach ($respondentCols as $col) {
            if ($col !== null) {
                $idx0 = (int)$col - 1;
                $isScore = false;
                foreach ($sheetCategories   as $cc) { if (in_array($idx0, $cc)) { $isScore = true; break; } }
                if (!$isScore) foreach ($sheetSpeakerSlots as $sc) { if (in_array($idx0, $sc)) { $isScore = true; break; } }
                if (!$isScore) unset($sheetScoreColSet[$idx0]);
            }
        }
        foreach ($feedbackCols as $col) {
            if ($col !== null) {
                $idx0 = (int)$col - 1;
                $isScore = false;
                foreach ($sheetCategories   as $cc) { if (in_array($idx0, $cc)) { $isScore = true; break; } }
                if (!$isScore) foreach ($sheetSpeakerSlots as $sc) { if (in_array($idx0, $sc)) { $isScore = true; break; } }
                if (!$isScore) unset($sheetScoreColSet[$idx0]);
            }
        }

        $rows = [];
        foreach ($rawRows as $row) {
            $r = array_values($row);

            // --- FIX: Skip completely blank rows (e.g. trailing empty rows in Excel).
            // A row is considered blank if every cell is null or empty string.
            $rowIsBlank = true;
            foreach ($r as $cell) {
                if ($cell !== null && trim((string)$cell) !== '') { $rowIsBlank = false; break; }
            }
            if ($rowIsBlank) continue;

            applyRules($r, $effectiveRules, $sheetScoreColSet);
            $rows[] = $r;
        }

        // Build respondent identity column indices (0-based) from respondentCols (1-based)
        $identityColIndices = array_filter(
            array_map(fn($c) => $c !== null ? (int)$c - 1 : null, $respondentCols),
            fn($c) => $c !== null
        );

        $rowsWithData = 0;
        foreach ($rows as $row) {
            // Skip summary/formula rows (e.g. Excel average rows at the bottom).
            // A row needs either:
            //   (a) at least one non-empty identity column value (including 'anonymous'
            //       which is a real MS Forms submission in privacy mode), OR
            //   (b) at least one numeric score if no identity columns are configured.
            if (!empty($identityColIndices)) {
                $hasIdentity = false;
                foreach ($identityColIndices as $ic) {
                    $v = trim((string)($row[$ic] ?? ''));
                    // Accept 'anonymous' — it is a real respondent, just privacy-masked
                    if ($v !== '') { $hasIdentity = true; break; }
                }
                if (!$hasIdentity) continue;
            }
            foreach ($sheetAllScoreCols as $c) {
                $v = $row[$c] ?? null;
                if (is_numeric($v) && (float)$v > 0) { $rowsWithData++; break; }
            }
        }

        if ($rowsWithData < 5) {
            continue;
        }

        // Category averages
        $catResults = [];
        foreach ($sheetCategories as $catName => $cols) {
            $avg     = colAvg($rows, $cols);
            $colAvgs = [];
            foreach ($cols as $c) {
                $vals = [];
                foreach ($rows as $row) {
                    $v = $row[$c] ?? null;
                    if (is_numeric($v)) $vals[] = (float)$v;
                }
                $colAvgs[] = [
                    'colIndex' => $c,
                    'avg'      => count($vals) > 0 ? round(array_sum($vals) / count($vals), 2) : null,
                    'n'        => count($vals),
                ];
            }
            $catResults[$catName] = $avg !== null
                ? ['avg' => $avg, 'result' => getResult($avg, $categoryScales), 'colAvgs' => $colAvgs]
                : null;
            if ($avg !== null) $allDayCategoryTotals[$catName][] = $avg;
        }

        // Speaker averages — respect per-sheet active slot overrides
        $speakers    = [];
        $sheetOv     = $sheetOverrides[$sheetName] ?? null;
        $activeSlots = $sheetOv['activeSpeakers'] ?? null;

        $effectiveSlots = $sheetSpeakerSlots;
        if (is_array($activeSlots) && count($activeSlots) > 0) {
            $effectiveSlots = array_filter($sheetSpeakerSlots, function($slot) use ($activeSlots) {
                return in_array((int)$slot, array_map('intval', $activeSlots));
            }, ARRAY_FILTER_USE_KEY);
        }

        foreach ($effectiveSlots as $slot => $cols) {
            $criteriaAvgs = [];
            $allVals      = [];
            $extractedSpeakerName = ''; // first non-empty name found across this slot's header cells
            foreach ($cols as $ci => $c) {
                $qVals = [];
                foreach ($rows as $row) {
                    $v = $row[$c] ?? null;
                    if (is_numeric($v)) { $qVals[] = (float)$v; $allVals[] = (float)$v; }
                }
                // Prefer this sheet's actual column header text — it's what the
                // evaluation form really asked. $criteria (from eval_settings /
                // fallback config) is only used when the header itself is missing
                // or blank, e.g. a malformed/merged header cell. Previously this
                // always used $criteria[$ci], which meant one shared, positional
                // settings array got applied to every speaker/import regardless
                // of what the actual Excel column said (BUG: caused every
                // speaker's criteria to show whatever text happened to be saved
                // in eval_settings.speaker_criteria, including data-entry noise
                // like an evaluator's name accidentally left in a header cell).
                $realHeader = trim((string)($sheetHeaderRow[$c] ?? ''));
                if ($extractedSpeakerName === '' && $realHeader !== '') {
                    $extractedSpeakerName = extractSpeakerNameFromHeader($realHeader);
                }
                $criteriaAvgs[] = [
                    'label' => $realHeader !== '' ? $realHeader : ($criteria[$ci] ?? ('Criterion ' . ($ci + 1))),
                    'avg'   => count($qVals) > 0 ? round(array_sum($qVals) / count($qVals), 2) : null,
                ];
            }
            $overall = count($allVals) > 0 ? round(array_sum($allVals) / count($allVals), 2) : null;
            if ($overall !== null) {
                // Name priority: an explicit override sent via the
                // speaker_names POST field (user typed it in the modal) wins;
                // otherwise use the name auto-detected from the header above;
                // otherwise fall back to the generic "Speaker N" placeholder.
                $defaultName = $extractedSpeakerName !== '' ? $extractedSpeakerName : ('Speaker ' . $slot);
                $speakers[] = [
                    'slot'         => $slot,
                    'name'         => $speakerNames[$sheetName][(string)$slot] ?? $defaultName,
                    'overall'      => $overall,
                    'result'       => getSpeakerResult($overall, $scale, $speakerScales, $thresholds),
                    'criteriaAvgs' => $criteriaAvgs,
                ];
            }
        }

        $daySheets[] = [
            // BUG 4 FIX: use caller-supplied $dayLabelMap so container imports
            // retain their correct label (e.g. "Day 3") instead of always
            // generating "Day 1", "Day 2", ... from an internal counter
            'day'         => $dayLabelMap[$sheetName] ?? ('Day ' . $dayCounter),
            'respondents' => $rowsWithData,
            'categories'  => $catResults,
            'speakers'    => $speakers,
        ];
        $dayCounter++;
    }

    $overallCategories = [];
    foreach ($allDayCategoryTotals as $catName => $dayAvgs) {
        $avg = round(array_sum($dayAvgs) / count($dayAvgs), 2);
        $overallCategories[$catName] = [
            'avg'    => $avg,
            'result' => getResult($avg, $categoryScales),
        ];
    }

    return ['days' => $daySheets, 'overallCategories' => $overallCategories];
}
?>
