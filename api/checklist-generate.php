<?php
/**
 * checklist-generate.php
 *
 * Generates "Processing Checklist for Application for Increase & Notation
 * in School Fees — In Private Pre-Elementary, Elementary and Junior High
 * Schools (per D.O. No. 12, s. 1997)" as a downloadable .docx file.
 *
 * ── Accepted Methods ────────────────────────────────────────────────────────
 *   GET  ?action=download&ids=1,2,3   → streams .docx for DB record IDs
 *   POST (JSON body)                   → streams .docx for supplied school data
 *
 * ── POST body shape (JSON) ──────────────────────────────────────────────────
 * {
 *   "schools": [
 *     {
 *       "schoolName"      : "The Little Campus North Bend School",
 *       "location"        : "27 A. Mabini St., Tibag, Baliwag, Bulacan",
 *       "syApplied"       : "SY 2026-2027",
 *       "govRecogNo"      : "E-021 s. 2000-2001",
 *       "govPermitNo"     : "",
 *       "checklistType"   : "tuition_increase",  // or "no_increase"
 *       "items"           : [],    // optional — leave empty for defaults
 *       "evaluatedBy"     : "",    // optional
 *       "evaluatedByTitle": ""     // optional
 *     }
 *   ],
 *   "fileName"       : "processing_checklist.docx",   // optional
 *   "showCheckmarks" : true                            // optional — default true
 * }
 *
 * ── GET ?action=download&ids=1,2 ────────────────────────────────────────────
 * Loads records from the checklist_reports table and builds the DOCX from
 * the stored JSON.  Requires authentication.
 *
 * ── Dependencies ─────────────────────────────────────────────────────────────
 *   composer require phpoffice/phpword
 *   (PhpWord ^1.x)
 */

declare(strict_types=1);

require_once dirname(__DIR__) . '/config/security.php';
require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

$vendorAutoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!file_exists($vendorAutoload)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Composer dependencies not installed (vendor/autoload.php missing).']);
    exit;
}
require_once $vendorAutoload;

use PhpOffice\PhpWord\PhpWord;
use PhpOffice\PhpWord\IOFactory;
use PhpOffice\PhpWord\Shared\Converter;
use PhpOffice\PhpWord\SimpleType\Jc;
use PhpOffice\PhpWord\Style\BorderStyle;

// ── Security headers & CORS ───────────────────────────────────────────────────
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

$authUser = authenticate();
if (!$authUser) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

requirePermission('checklist', $authUser);

// ── Route ─────────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? '';

if ($action === 'download' && isset($_GET['ids'])) {
    // Load school data from DB records
    $ids     = array_filter(array_map('intval', explode(',', $_GET['ids'])));
    $schools = loadSchoolsFromDb($ids);
    if (!$schools) {
        jsonError('No records found for the given IDs.');
    }
    streamDocx($schools, 'processing_checklist_' . date('Ymd') . '.docx');

} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Accept JSON body
    $raw  = file_get_contents('php://input');
    $body = json_decode($raw, true);
    if (!$body || !isset($body['schools'])) {
        jsonError('Invalid JSON body. Expected { "schools": [...] }.');
    }

    $schools        = normaliseSchools($body['schools']);
    $fileName       = sanitizeFileName($body['fileName'] ?? 'processing_checklist.docx');
    $showCheckmarks = (bool)($body['showCheckmarks'] ?? true);

    streamDocx($schools, $fileName, $showCheckmarks);

} else {
    jsonError('Unknown request. Use GET ?action=download&ids=... or POST with JSON.', 400);
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function loadSchoolsFromDb(array $ids): array
{
    $pdo = getDb();
    if (empty($ids)) return [];

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare(
        "SELECT * FROM checklist_reports WHERE id IN ({$placeholders}) ORDER BY id ASC"
    );
    $stmt->execute($ids);
    $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    $schools = [];
    foreach ($rows as $row) {
        $fields = json_decode($row['fields_json'] ?? '{}', true) ?: [];
        $items  = json_decode($row['items_json']  ?? '[]', true) ?: [];

        $schools[] = [
            'schoolName'      => $row['school_name'] ?? $fields['schoolName'] ?? '',
            'location'        => $row['location']    ?? $fields['location']   ?? '',
            'syApplied'       => $row['sy_applied']  ?? $fields['syApplied']  ?? '',
            'govRecogNo'      => $fields['govRecogNo']  ?? '',
            'govPermitNo'     => $fields['govPermitNo'] ?? '',
            'checklistType'   => $row['checklist_type'] ?? 'tuition_increase',
            'items'           => $items,
            'evaluatedBy'     => $fields['evaluatedBy']      ?? '',
            'evaluatedByTitle'=> $fields['evaluatedByTitle'] ?? '',
            'showCheckmarks'  => true,
        ];
    }
    return $schools;
}

function normaliseSchools(array $raw): array
{
    $schools = [];
    foreach ($raw as $s) {
        $schools[] = [
            'schoolName'       => (string)($s['schoolName']       ?? ''),
            'location'         => (string)($s['location']         ?? ''),
            'syApplied'        => (string)($s['syApplied']        ?? ''),
            'govRecogNo'       => (string)($s['govRecogNo']       ?? ''),
            'govPermitNo'      => (string)($s['govPermitNo']      ?? ''),
            'checklistType'    => in_array($s['checklistType'] ?? '', ['no_increase'], true)
                                    ? 'no_increase' : 'tuition_increase',
            'items'            => is_array($s['items'] ?? null) ? $s['items'] : [],
            'evaluatedBy'      => (string)($s['evaluatedBy']      ?? ''),
            'evaluatedByTitle' => (string)($s['evaluatedByTitle'] ?? ''),
        ];
    }
    return $schools;
}

function sanitizeFileName(string $name): string
{
    $name = preg_replace('/[^a-zA-Z0-9_\-\.]/', '_', $name);
    if (!preg_match('/\.docx$/i', $name)) $name .= '.docx';
    return $name ?: 'processing_checklist.docx';
}

function jsonError(string $msg, int $code = 400): void
{
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['error' => $msg]);
    exit;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CHECKLIST ITEMS
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultItems(string $type): array
{
    if ($type === 'no_increase') {
        return [
            ['id' => 1,    'sub' => false, 'text' => 'Date received by DepEd RO III, City of San Fernando, Pampanga (submission should be on or before May 15)', 'found' => null],
            ['id' => 2,    'sub' => false, 'text' => 'Letter declaring No Increase in tuition and other fees for the school year signed by the School Head.', 'found' => null],
            ['id' => 3,    'sub' => false, 'text' => 'Comparative Schedule of tuition, miscellaneous and other school fees showing no change from previous school year.', 'found' => null],
            ['id' => 4,    'sub' => false, 'text' => 'Signed certification by School Head that there is no increase in any fee for the forthcoming SY.', 'found' => null],
            ['id' => 5,    'sub' => false, 'text' => 'Government Recognition / Permit Number on file.', 'found' => null],
            ['id' => 6,    'sub' => false, 'text' => '1st Indorsement from the Schools Division.', 'found' => null],
        ];
    }

    // tuition_increase (default)
    return [
        ['id' => 1,    'sub' => false, 'text' => 'Date received by DepEd RO III, City of San Fernando, Pampanga (submission should be on or before May 15)', 'found' => null],
        ['id' => 2,    'sub' => false, 'text' => "Letter of advice to the Regional Office signed by the School Head, indicating among others the school\u2019s intention to comply with the provision of R.A. 6728 for the forthcoming SY ___________________.", 'found' => null],
        ['id' => 3,    'sub' => false, 'text' => 'Xerox copy of the approved tuition, miscellaneous and other schools fees SY _____________ (previous school year or latest noted fees).', 'found' => null],
        ['id' => 4,    'sub' => false, 'text' => 'Comparative Schedule of tuition, miscellaneous and other school fees for current school year with that of the previous year indicating in both peso and percentage the forms of increase. (Should be done by the school with increase or no increase) note: The miscellaneous & other fees should be itemized.', 'found' => null],
        ['id' => 5,    'sub' => false, 'text' => 'Percentage of increase of tuition/miscellaneous & other fees.', 'found' => null],
        ['id' => 6,    'sub' => false, 'text' => 'Certification under Oath (notarized by a duly licensed notary public) signed by the School Head that the following requirements of R.A. 6728 have been complied with namely; (a), (b) and (c):', 'found' => null],
        ['id' => '6a', 'sub' => true,  'text' => '(a) Appropriate consultations have been conducted with duly organized PTA / PTCA and Faculty Association.', 'found' => null],
        ['id' => '6a2','sub' => true,  'text' => 'Copy of excerpts of the minutes of the meeting of PTCA or Family Council Association should be submitted.', 'found' => null],
        ['id' => '6a3','sub' => true,  'text' => 'Date of consultation should not be later than March 30.', 'found' => null],
        ['id' => '6b', 'sub' => true,  'text' => '(b) Seventy percent (70%) of the amount of tuition fee increase (incremental proceeds) of the previous school year went to the increase of payment in salaries, wages and other benefits of teaching and non \u2013 teaching personnel except the school administrators who are principal stockholders of the school.', 'found' => null],
        ['id' => '6b2','sub' => true,  'text' => 'Copy of the proof of such increases such as Xerox copies of payroll (before and after the increase) of the concerned teachers and support staff, other teacher benefits such as staff, non-teaching, etc.', 'found' => null],
        ['id' => '6c', 'sub' => true,  'text' => '(c) At least twenty percent (20%) went to the improvement or modernization of building, equipment, libraries and similar facilities. Itemized copy of improvement with the amount written opposite each item with supporting documents and photocopies of sample receipt of purchase and others.', 'found' => null],
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function streamDocx(array $schools, string $fileName, bool $showCheckmarks = true): void
{
    $phpWord = new PhpWord();

    // ── Default font ──
    $phpWord->setDefaultFontName('Calibri');
    $phpWord->setDefaultFontSize(11);

    // ── Styles ──
    $phpWord->addTitleStyle(null, ['name' => 'Calibri', 'size' => 13, 'bold' => true]);

    $titleStyle  = ['name' => 'Calibri', 'size' => 13, 'bold' => true, 'color' => '000000'];
    $bodyStyle   = ['name' => 'Calibri', 'size' => 11, 'color' => '000000'];
    $boldBody    = ['name' => 'Calibri', 'size' => 11, 'bold' => true, 'color' => '000000'];
    $underBody   = ['name' => 'Calibri', 'size' => 11, 'color' => '000000', 'underline' => \PhpOffice\PhpWord\Style\Font::UNDERLINE_SINGLE];

    $centreParaStyle = ['alignment' => Jc::CENTER, 'spaceAfter' => Converter::pointToTwip(3)];
    $bodyParaStyle   = ['spaceAfter' => Converter::pointToTwip(4), 'spaceBefore' => 0];
    $noBorderTbl     = [
        'borderTopSize'    => 0, 'borderTopColor'    => 'FFFFFF',
        'borderBottomSize' => 0, 'borderBottomColor' => 'FFFFFF',
        'borderLeftSize'   => 0, 'borderLeftColor'   => 'FFFFFF',
        'borderRightSize'  => 0, 'borderRightColor'  => 'FFFFFF',
    ];

    // ── Content width ──
    // US Letter: 12240 twips wide, margins 1080 each side → 10080 content twips
    $pageW   = Converter::inchToTwip(8.5);
    $margin  = Converter::inchToTwip(0.75);
    $contentW = (int)($pageW - $margin * 2);   // ~10080 twips

    $labelW  = (int)($contentW * 0.30);
    $valueW  = $contentW - $labelW;

    foreach ($schools as $idx => $school) {
        // Section per school — page break between schools
        $sectionProps = [
            'paperSize'   => 'Letter',
            'marginTop'   => $margin,
            'marginRight' => $margin,
            'marginBottom'=> $margin,
            'marginLeft'  => $margin,
        ];
        if ($idx > 0) {
            $sectionProps['breakType'] = 'nextPage';
        }
        $section = $phpWord->addSection($sectionProps);

        $type         = ($school['checklistType'] === 'no_increase') ? 'no_increase' : 'tuition_increase';
        $items        = (!empty($school['items'])) ? $school['items'] : getDefaultItems($type);
        $evalName     = $school['evaluatedBy']      ?: 'MA. AUREA RHODORA DC. GERONIMO, PhD';
        $evalTitle    = $school['evaluatedByTitle'] ?: 'Chief, SGOD/ In-Charge of Private Schools';

        $titleLine1 = ($type === 'no_increase')
            ? 'Processing Checklist for Application for No Increase in School Fees'
            : 'Processing Checklist for Application for Increase & Notation in School Fees';
        $titleLine2 = 'In Private Pre-Elementary, Elementary and Junior High Schools';
        $titleLine3 = '( per D.O No. 12,  s. 1997)';

        // ── Title block ──
        $section->addText($titleLine1, $titleStyle, $centreParaStyle);
        $section->addText($titleLine2, $titleStyle, $centreParaStyle);
        $section->addText($titleLine3, $titleStyle, array_merge($centreParaStyle, ['spaceAfter' => Converter::pointToTwip(8)]));

        // ── Header fields — rendered as no-border tables so values underline properly ──
        $headerFields = [
            'Name of School:'          => $school['schoolName']  ?? '',
            'Location / Address:'      => $school['location']    ?? '',
            'SY applied for:'          => $school['syApplied']   ?? '',
            'Government Recognition No:'=> $school['govRecogNo'] ?? '',
        ];

        foreach ($headerFields as $label => $value) {
            $tbl = $section->addTable($noBorderTbl);
            $row = $tbl->addRow();

            // Label cell
            $cell = $row->addCell($labelW, ['borderBottomSize' => 0]);
            $cell->addText($label, $bodyStyle, $bodyParaStyle);

            // Value cell with bottom border (underline effect)
            $valueCell = $row->addCell($valueW, [
                'borderTopSize'    => 0, 'borderTopColor'    => 'FFFFFF',
                'borderBottomSize' => 8, 'borderBottomColor' => '000000',
                'borderLeftSize'   => 0, 'borderLeftColor'   => 'FFFFFF',
                'borderRightSize'  => 0, 'borderRightColor'  => 'FFFFFF',
            ]);
            $valueCell->addText($value ?: '', $value ? $underBody : $bodyStyle, $bodyParaStyle);
        }

        // ── Permit No. with SY blank ──
        $permitLabelW = $labelW;
        $permitValueW = (int)($contentW * 0.30);
        $syLabelW     = (int)($contentW * 0.06);
        $syValueW     = $contentW - $permitLabelW - $permitValueW - $syLabelW;

        $ptbl = $section->addTable($noBorderTbl);
        $prow = $ptbl->addRow();
        $prow->addCell($permitLabelW, ['borderBottomSize' => 0])->addText('Government Permit No:', $bodyStyle, $bodyParaStyle);
        $permitVal = $school['govPermitNo'] ?? '';
        $prow->addCell($permitValueW, ['borderBottomSize' => 8, 'borderBottomColor' => '000000', 'borderTopSize' => 0, 'borderTopColor' => 'FFFFFF', 'borderLeftSize' => 0, 'borderLeftColor' => 'FFFFFF', 'borderRightSize' => 0, 'borderRightColor' => 'FFFFFF'])
             ->addText($permitVal ?: '', $permitVal ? $underBody : $bodyStyle, $bodyParaStyle);
        $prow->addCell($syLabelW, ['borderBottomSize' => 0])->addText(' SY ', $bodyStyle, ['alignment' => Jc::CENTER, 'spaceAfter' => Converter::pointToTwip(4)]);
        $prow->addCell($syValueW, ['borderBottomSize' => 8, 'borderBottomColor' => '000000', 'borderTopSize' => 0, 'borderTopColor' => 'FFFFFF', 'borderLeftSize' => 0, 'borderLeftColor' => 'FFFFFF', 'borderRightSize' => 0, 'borderRightColor' => 'FFFFFF'])
             ->addText('', $bodyStyle, $bodyParaStyle);

        $section->addTextBreak(1);

        // ── Checklist items ──
        foreach ($items as $item) {
            $isSub = !empty($item['sub']);
            $found = $item['found'] ?? null;

            if ($showCheckmarks && $found === true)       $tick = "\u{2714}  ";
            elseif ($showCheckmarks && $found === false)  $tick = "\u{2718}  ";
            else                                           $tick = '________  ';

            $paraStyle = ['spaceAfter' => Converter::pointToTwip(3), 'spaceBefore' => 0];
            if ($isSub) {
                $paraStyle['indentation'] = ['left' => Converter::inchToTwip(0.5)];
            }

            $textRun = $section->createTextRun($paraStyle);
            $textRun->addText($tick, $boldBody);
            $textRun->addText($item['text'] ?? '', $bodyStyle);
        }

        $section->addTextBreak(1);

        // ── OTHER FINDINGS ──
        $section->addText('OTHER FINDINGS (specify)', $bodyStyle, $bodyParaStyle);
        for ($i = 0; $i < 5; $i++) {
            $section->addText('', $bodyStyle, [
                'spaceAfter'    => Converter::pointToTwip(5),
                'borderBottom'  => ['color' => '000000', 'size' => 6],
            ]);
        }

        $section->addTextBreak(1);

        // ── RECOMMENDATIONS ──
        $section->addText('RECOMMENDATIONS', $bodyStyle, $bodyParaStyle);
        for ($i = 0; $i < 4; $i++) {
            $section->addText('', $bodyStyle, [
                'spaceAfter'  => Converter::pointToTwip(5),
                'borderBottom'=> ['color' => '000000', 'size' => 6],
            ]);
        }

        $section->addTextBreak(2);

        // ── Signature block ──
        $sigLabelW = (int)($contentW * 0.42);
        $sigValueW = $contentW - $sigLabelW;

        $sigTbl = $section->addTable($noBorderTbl);
        $sigRow = $sigTbl->addRow();

        // LEFT — Validated by
        $leftCell = $sigRow->addCell($sigLabelW, ['borderBottomSize' => 0]);
        $leftCell->addText('Validated by:', $bodyStyle, $bodyParaStyle);
        $leftCell->addText('', $bodyStyle, ['borderBottom' => ['color' => '000000', 'size' => 6], 'spaceAfter' => Converter::pointToTwip(3), 'spaceBefore' => Converter::pointToTwip(16)]);
        $leftCell->addText('Name', $bodyStyle, ['spaceAfter' => Converter::pointToTwip(3)]);
        $leftCell->addText('', $bodyStyle, ['borderBottom' => ['color' => '000000', 'size' => 6], 'spaceAfter' => Converter::pointToTwip(3), 'spaceBefore' => Converter::pointToTwip(16)]);
        $leftCell->addText('RO-QAD', $bodyStyle, $bodyParaStyle);

        // RIGHT — Processed/Evaluated by
        $rightCell = $sigRow->addCell($sigValueW, ['borderBottomSize' => 0]);
        $rightCell->addText('Processed/Evaluated by:', $bodyStyle, $bodyParaStyle);
        $rightCell->addText($evalName, $boldBody, ['borderBottom' => ['color' => '000000', 'size' => 6], 'spaceAfter' => Converter::pointToTwip(3), 'spaceBefore' => Converter::pointToTwip(16)]);
        $rightCell->addText($evalTitle, $bodyStyle, ['spaceAfter' => Converter::pointToTwip(3)]);
        $rightCell->addText('', $bodyStyle, ['borderBottom' => ['color' => '000000', 'size' => 6], 'spaceAfter' => Converter::pointToTwip(3), 'spaceBefore' => Converter::pointToTwip(16)]);
        $rightCell->addText('Date', $bodyStyle, $bodyParaStyle);
    }

    // ── Stream output ─────────────────────────────────────────────────────────
    header('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    header('Content-Disposition: attachment; filename="' . $fileName . '"');
    header('Cache-Control: max-age=0');
    header('Pragma: public');

    $writer = IOFactory::createWriter($phpWord, 'Word2007');

    // Write to a temp file then stream it (avoids output buffering issues)
    $tmpFile = tempnam(sys_get_temp_dir(), 'checklist_') . '.docx';
    try {
        $writer->save($tmpFile);
        readfile($tmpFile);
    } finally {
        @unlink($tmpFile);
    }
    exit;
}
