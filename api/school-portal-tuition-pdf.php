<?php
/**
 * GET /api/school-portal-tuition-pdf.php?id=N
 *
 * Generates a DepEd-style tuition fee submission PDF matching the official
 * DECS Order No. 12, s. 1997 / DepEd Order No. 88, s. 2010 format.
 *
 * Sections:
 *   1. Comparative Schedule — TUITION FEES | MISCELLANEOUS AND OTHER FEES (side-by-side columns, per grade row)
 *   2. Breakdown of School Fees (per grade, fee rows)
 *   3. Program of Expenditures (70-20-10)
 *   4. Justification of Fee Items
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

require_once dirname(__DIR__) . '/config/database.php';
require_once dirname(__DIR__) . '/config/auth_middleware.php';

// ── TCPDF autoload ────────────────────────────────────────────────────────────
$tcpdfPaths = [
    dirname(__DIR__) . '/vendor/autoload.php',
    dirname(__DIR__, 2) . '/vendor/autoload.php',
    __DIR__ . '/vendor/autoload.php',
];
$loaded = false;
foreach ($tcpdfPaths as $p) {
    if (file_exists($p)) { require_once $p; $loaded = true; break; }
}
if (!$loaded) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'TCPDF not found. Run: composer require tecnickcom/tcpdf']);
    exit;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
$user = authenticate('portal_user');
    if ($user) requireSchoolApproval($user);
if (!$user) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// ── Load document ─────────────────────────────────────────────────────────────
$docId = isset($_GET['id']) && is_numeric($_GET['id']) ? (int)$_GET['id'] : 0;
if ($docId <= 0) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Missing document id.']);
    exit;
}

$pdo  = getDB();
$stmt = $pdo->prepare('SELECT * FROM school_tuition_documents WHERE id = :id AND user_id = :uid LIMIT 1');
$stmt->execute([':id' => $docId, ':uid' => (int)$user['id']]);
$doc = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$doc) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Document not found or access denied.']);
    exit;
}

$payload    = json_decode((string)$doc['payload_json'], true) ?? [];
$form       = $payload['form']   ?? [];
$kinder     = $payload['kinder'] ?? [];
$elem       = $payload['elem']   ?? [];
$jhs        = $payload['jhs']    ?? [];
$shs        = $payload['shs']    ?? [];
$isIncrease = $doc['mode'] === 'increase';
$pct        = (float)($form['increase_pct'] ?? $doc['increase_pct'] ?? 0);
$schoolName = trim((string)($form['school_name'] ?? ''));
$division   = trim((string)($form['division']    ?? ''));
$address    = trim((string)($form['address']     ?? ''));
$currentSY  = trim((string)($form['current_sy']  ?? $doc['current_sy']  ?? ''));
$proposedSY = trim((string)($form['proposed_sy'] ?? $doc['proposed_sy'] ?? ''));
$schoolId   = trim((string)($form['school_id']   ?? ''));
$contact    = trim((string)($form['principal_contact'] ?? ''));
$hasKinder  = (bool)$doc['has_kinder'];
$hasElem    = (bool)$doc['has_elem'];
$hasJHS     = (bool)$doc['has_jhs'];
$hasSHS     = (bool)$doc['has_shs'];

// Signatories — sourced from the actual submitted form fields (the same
// fields the builder's signatory picker / preview use), NOT from whichever
// account happens to be logged in when the PDF is generated, and NOT
// hardcoded office names. Falls back to the current user's name only for
// "Prepared by" when the school never filled that field in, and to the
// office defaults for Regional Office roles the school doesn't set itself.
$principal           = strtoupper(trim((string)($form['principal']            ?? $user['full_name'] ?? 'SCHOOL PRINCIPAL')));
$principalPosition   = trim((string)($form['principal_position']    ?? '')) ?: 'School Principal';
$reviewedBy          = strtoupper(trim((string)($form['reviewed_by']          ?? '')));
$reviewedByPosition  = trim((string)($form['reviewed_by_position']  ?? '')) ?: 'SDO, EPS In Charge';
$validatedBy         = strtoupper(trim((string)($form['validated_by']         ?? '')));
$validatedByPosition = trim((string)($form['validated_by_position'] ?? '')) ?: 'EPS, QAD DepEd RO 3';
$notedBy             = strtoupper(trim((string)($form['noted_by']             ?? ''))) ?: 'MAY B. ECLAR, PhD, CESO III';
$notedByPosition     = trim((string)($form['noted_by_position']     ?? '')) ?: 'Regional Director';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPeso(float $n): string {
    return 'P ' . number_format($n, 2);
}
function fmtPct(float $n): string {
    return number_format($n, 2) . '%';
}
function applyIncrease(float $curr, float $pct): float {
    return round($curr * (1 + $pct / 100), 2);
}

function tfImgPath(string $fileName): string {
    $path = dirname(__DIR__) . '/images/' . $fileName;
    return file_exists($path) ? $path : '';
}

// ── TCPDF subclass ────────────────────────────────────────────────────────────
class TuitionPDF extends TCPDF {
    public string $schoolName = '';
    public string $address    = '';
    public string $proposedSY = '';
    public array $assets = [];

    public function Header(): void {
        $pageW = $this->getPageWidth();

        // Seal
        $seal = $this->assets['seal'] ?? '';
        if ($seal) {
            $sealW = 14;
            $x = ($pageW - $sealW) / 2;
            $this->Image($seal, $x, 6, $sealW, 0, '', '', '', false, 300, '', false, false, 0);
        }

        // Letterhead text
        $this->SetY(21);
        $this->SetTextColor(0, 0, 0);
        $this->SetFont('times', '', 9);
        $this->Cell(0, 4, 'Republic of the Philippines', 0, 1, 'C');
        $this->SetFont('times', 'B', 12);
        $this->Cell(0, 5, 'Department of Education', 0, 1, 'C');
        $this->SetFont('times', '', 9.5);
        $this->Cell(0, 4, 'REGION III-CENTRAL LUZON', 0, 1, 'C');

        // Divider line
        $this->SetDrawColor(0, 0, 0);
        $this->SetLineWidth(0.6);
        $this->Line(15, $this->GetY() + 2, $pageW - 15, $this->GetY() + 2);
        $this->Ln(6);
    }

    public function Footer(): void {
        $pageW = $this->getPageWidth();
        $this->SetY(-30);

        // Top divider
        $this->SetDrawColor(0, 0, 0);
        $this->SetLineWidth(0.6);
        $y = $this->GetY();
        $this->Line(15, $y, $pageW - 15, $y);

        // Logos
        $yLogo = $y + 3;
        $xLeft = 15;
        $logoH = 9;

        $deped = $this->assets['deped'] ?? '';
        $bagong = $this->assets['bagong'] ?? '';
        $region = $this->assets['region'] ?? '';
        $pgs = $this->assets['pgs'] ?? '';
        $iso = $this->assets['iso'] ?? '';

        if ($deped)  { $this->Image($deped,  $xLeft,      $yLogo, 20, 0, '', '', '', false, 300); }
        if ($bagong) { $this->Image($bagong, $xLeft + 22, $yLogo, 16, 0, '', '', '', false, 300); }
        if ($region) { $this->Image($region, $xLeft + 40, $yLogo, 9,  0, '', '', '', false, 300); }

        // Right logos
        $xRight = $pageW - 15;
        if ($iso) { $this->Image($iso, $xRight - 12, $yLogo - 1, 12, 0, '', '', '', false, 300); }
        if ($pgs) { $this->Image($pgs, $xRight - 38, $yLogo + 2, 24, 0, '', '', '', false, 300); }

        // Center contact text
        $this->SetY($y + 3);
        $this->SetFont('times', '', 6.8);
        $this->SetTextColor(0, 0, 0);
        $this->Cell(0, 3.2, 'Address: Matalino St. D.M. Government Center, Maimpis, City of San Fernando (P)', 0, 1, 'C');
        $this->Cell(0, 3.2, 'Telephone Number: (045) 598-8580 to 89     Email Address: region3@deped.gov.ph', 0, 1, 'C');
        $this->Cell(0, 3.2, 'Website: https://region3.deped.gov.ph     Page ' . $this->getAliasNumPage() . ' of ' . $this->getAliasNbPages(), 0, 0, 'C');
    }
}

// ── Init PDF ──────────────────────────────────────────────────────────────────
// Portrait Letter for the comparative schedule — matches the DepEd reference doc.
// Margins: 15mm left/right (tight, to fill the table edge-to-edge like the original).
$pdf = new TuitionPDF('P', 'mm', 'LETTER', true, 'UTF-8', false);
$pdf->schoolName = $schoolName ?: 'School Name';
$pdf->address    = $address    ?: '';
$pdf->proposedSY = $proposedSY;
$pdf->assets = [
    'seal'   => tfImgPath('kagawaran-ng-edukasyon-logo.png'),
    'deped'  => tfImgPath('DepED-logo.png'),
    'bagong' => tfImgPath('bagong-pilipinas-logo.png'),
    'region' => tfImgPath('dept-of-educ-central-luzon.png'),
    'pgs'    => tfImgPath('performance-governance-system.png'),
    'iso'    => tfImgPath('iso-9001.png'),
];
$pdf->SetCreator('QATALYST School Portal');
$pdf->SetAuthor($schoolName);
$pdf->SetTitle('Tuition Fee Schedule — ' . $proposedSY);
$pdf->SetSubject('DepEd Region III Tuition Fee Submission');
$pdf->SetMargins(15, 42, 15);   // extra top room for official letterhead
$pdf->SetHeaderMargin(5);
$pdf->SetFooterMargin(12);
$pdf->SetAutoPageBreak(true, 30);
$pdf->setImageScale(PDF_IMAGE_SCALE_RATIO);
$pdf->SetFont('helvetica', '', 9);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — COMPARATIVE SCHEDULE  (Portrait, matching DepEd reference)
//
// Layout (portrait Letter = 215.9mm wide, 15mm margins each side → 185.9mm usable)
// Columns: LEVEL | T.Prev | T.Prop | T.Amt | T.% | M.Prev | M.Prop | M.Amt | M.%
//          (no-increase mode drops the Amt+% columns → 5 cols only)
//
// Pre-School has TWO rows:  Pre-Kinder  +  Kindergarten
// ══════════════════════════════════════════════════════════════════════════════
$pdf->AddPage('P');

$pdf->SetFont('times', 'B', 11);
$pdf->SetTextColor(0, 0, 0);
$pdf->Cell(0, 6, 'COMPARATIVE SCHEDULE OF TUITION, MISCELLANEOUS & OTHER FEES', 0, 1, 'C');
$pdf->SetFont('times', '', 9.5);
$pdf->Cell(0, 5, 'for S.Y. ' . $proposedSY, 0, 1, 'C');
$pdf->Ln(2);

// ── Portrait column widths  (185.9mm usable) ──────────────────────────────────
// increase mode  : 1 + 4 + 4 = 9 cols  → level=22, data=(185.9-22)/8 = 20.49 ≈ 20.5
// no-inc mode    : 1 + 2 + 2 = 5 cols  → level=22, data=(185.9-22)/4 = 40.975 ≈ 41
$wLevel  = 22;
$usable  = 185.9;
$wTinc   = ($usable - $wLevel) / 8;   // each data col, increase mode
$wTnoinc = ($usable - $wLevel) / 4;   // each data col, no-increase mode

// ── Section subheading bar ────────────────────────────────────────────────────
function compSectionHead(TuitionPDF $pdf, string $label): void {
    $pdf->SetFillColor(200, 200, 200);
    $pdf->SetFont('helvetica', 'B', 8);
    $pdf->SetTextColor(0, 0, 0);
    $pdf->Cell(0, 5.5, '  ' . $label, 1, 1, 'L', true);
}

// ── Comparative table ─────────────────────────────────────────────────────────
// $rows: array of ['level'=>string, 'tuition_curr'=>float, 'tuition_prop'=>float,
//                  'misc_curr'=>float, 'misc_prop'=>float, 'type'=>'total'|'']
function comparativeTable(
    TuitionPDF $pdf,
    array      $rows,
    string     $currentSY,
    string     $proposedSY,
    bool       $isIncrease,
    float      $wLevel,
    float      $wCol        // single data-column width (already correct for mode)
): void {
    $rowH  = 6.0;   // data row height
    $hdrH  = 5.5;   // header row height

    // ── Row 1: group spans ────────────────────────────────────────────────────
    $pdf->SetFillColor(200, 200, 200);
    $pdf->SetFont('helvetica', 'B', 7);
    $pdf->SetTextColor(0, 0, 0);

    $nDataCols   = $isIncrease ? 4 : 2;
    $tuitionSpan = $wCol * $nDataCols;
    $miscSpan    = $wCol * $nDataCols;

    $pdf->Cell($wLevel,      $hdrH, '',                             1, 0, 'C', true);
    $pdf->Cell($tuitionSpan, $hdrH, 'TUITION FEES',                 1, 0, 'C', true);
    $pdf->Cell($miscSpan,    $hdrH, 'MISCELLANEOUS AND OTHER FEES', 1, 1, 'C', true);

    // ── Row 2: column headers ─────────────────────────────────────────────────
    $pdf->SetFillColor(220, 220, 220);
    $pdf->SetFont('helvetica', 'B', 6);
    $pdf->Cell($wLevel, $hdrH, 'LEVEL',                                         1, 0, 'C', true);
    $pdf->Cell($wCol,   $hdrH, 'Previous' . "\n" . 'SY ' . $currentSY,         1, 0, 'C', true);
    $pdf->Cell($wCol,   $hdrH, 'Proposal' . "\n" . 'SY ' . $proposedSY,        1, 0, 'C', true);
    if ($isIncrease) {
        $pdf->Cell($wCol, $hdrH, 'Amount of' . "\n" . 'Increase',              1, 0, 'C', true);
        $pdf->Cell($wCol, $hdrH, 'Percentage' . "\n" . 'of Increase',          1, 0, 'C', true);
    }
    $pdf->Cell($wCol,   $hdrH, 'Previous' . "\n" . 'SY ' . $currentSY,         1, 0, 'C', true);
    $pdf->Cell($wCol,   $hdrH, 'Proposal' . "\n" . 'SY ' . $proposedSY,        1, 0, 'C', true);
    if ($isIncrease) {
        $pdf->Cell($wCol, $hdrH, 'Amount of' . "\n" . 'Increase',              1, 0, 'C', true);
        $pdf->Cell($wCol, $hdrH, 'Percentage' . "\n" . 'of Increase',          1, 1, 'C', true);
    } else {
        $pdf->Ln();
    }

    // ── Data rows ─────────────────────────────────────────────────────────────
    $pdf->SetTextColor(0, 0, 0);

    foreach ($rows as $row) {
        $isTotal = ($row['type'] ?? '') === 'total';
        if ($isTotal) {
            $pdf->SetFont('helvetica', 'B', 7.5);
            $pdf->SetFillColor(235, 235, 235);
        } else {
            $pdf->SetFont('helvetica', '', 7.5);
            $pdf->SetFillColor(255, 255, 255);
        }

        $tCurr = (float)$row['tuition_curr'];
        $tProp = (float)$row['tuition_prop'];
        $mCurr = (float)$row['misc_curr'];
        $mProp = (float)$row['misc_prop'];
        $tAmt  = $tProp - $tCurr;
        $mAmt  = $mProp - $mCurr;
        // Percentage: computed per-row from its own curr value (fixes pink-note issue)
        $tPct  = $tCurr > 0 ? number_format(($tAmt / $tCurr) * 100, 2) . '%' : ($isIncrease ? '0.00%' : '-');
        $mPct  = $mCurr > 0 ? number_format(($mAmt / $mCurr) * 100, 2) . '%' : ($isIncrease ? '0.00%' : '-');

        $pdf->Cell($wLevel, $rowH, $row['level'],                         1, 0, 'L', $isTotal);
        $pdf->Cell($wCol,   $rowH, $tCurr > 0 ? fmtPeso($tCurr) : '-',   1, 0, 'R', $isTotal);
        $pdf->Cell($wCol,   $rowH, $tProp > 0 ? fmtPeso($tProp) : '-',   1, 0, 'R', $isTotal);
        if ($isIncrease) {
            $pdf->Cell($wCol, $rowH, $tCurr > 0 ? fmtPeso($tAmt) : '-',  1, 0, 'R', $isTotal);
            $pdf->Cell($wCol, $rowH, $tCurr > 0 ? $tPct : '-',            1, 0, 'C', $isTotal);
        }
        $pdf->Cell($wCol,   $rowH, $mCurr > 0 ? fmtPeso($mCurr) : '-',   1, 0, 'R', $isTotal);
        $pdf->Cell($wCol,   $rowH, $mProp > 0 ? fmtPeso($mProp) : '-',   1, 0, 'R', $isTotal);
        if ($isIncrease) {
            $pdf->Cell($wCol, $rowH, $mCurr > 0 ? fmtPeso($mAmt) : '-',  1, 0, 'R', $isTotal);
            $pdf->Cell($wCol, $rowH, $mCurr > 0 ? $mPct : '-',            1, 1, 'C', $isTotal);
        } else {
            $pdf->Ln();
        }
    }
}

// ── Signature block matching the DepEd reference ─────────────────────────────
// Layout (from Image 1):
//   ┌──────────────────────────────────────────────────────────┐
//   │  Prepared by:                    Received by:            │
//   │                                                          │
//   │  PRINCIPAL NAME (underlined)     ____________________    │
//   │  School Principal                SGOD Chief / ...        │
//   ├──────────────────────────────────────────────────────────┤
//   │  Validated by:                                           │
//   │  ___________________________  EPS, QAD DepEd R03         │
//   └──────────────────────────────────────────────────────────┘
//        (Regional Director block centered, outside the box)
function drawSignatureBlock(
    TuitionPDF $pdf,
    string     $principal,
    string     $principalPosition,
    string     $reviewedBy,
    string     $reviewedByPosition,
    string     $validatedBy,
    string     $validatedByPosition,
    string     $notedBy,
    string     $notedByPosition,
    float      $pageW,
    float      $lMargin
): void
{
    $boxW   = $pageW - ($lMargin * 2);   // full usable width
    $halfW  = $boxW / 2;
    $startX = $lMargin;
    $startY = $pdf->GetY() + 4;

    // ── Top half: Prepared by | Processed and Evaluated by ───────────────────
    $topH = 22;   // height of the top signature box

    // outer border top half
    $pdf->SetDrawColor(0, 0, 0);
    $pdf->SetLineWidth(0.3);
    $pdf->Rect($startX, $startY, $boxW, $topH);
    // vertical divider
    $pdf->Line($startX + $halfW, $startY, $startX + $halfW, $startY + $topH);

    // "Prepared by:" label — left cell
    $pdf->SetFont('helvetica', '', 8);
    $pdf->SetXY($startX + 2, $startY + 2);
    $pdf->Cell($halfW - 4, 5, 'Prepared by:', 0, 1, 'L');

    // Principal name (bold underlined) — left cell, with space for signature
    $pdf->SetFont('helvetica', 'BU', 8.5);
    $pdf->SetXY($startX + 2, $startY + $topH - 10);
    $pdf->Cell($halfW - 4, 5, $principal, 0, 1, 'L');

    // "School Principal" label — left cell
    $pdf->SetFont('helvetica', '', 7.5);
    $pdf->SetXY($startX + 2, $startY + $topH - 5);
    $pdf->Cell($halfW - 4, 4.5, $principalPosition, 0, 1, 'L');

    // "Processed and Evaluated by:" label — right cell
    $pdf->SetFont('helvetica', '', 8);
    $pdf->SetXY($startX + $halfW + 2, $startY + 2);
    $pdf->Cell($halfW - 4, 5, 'Processed and Evaluated by:', 0, 1, 'L');

    // Reviewed-by name (bold underlined) — right cell
    $pdf->SetFont('helvetica', 'BU', 8.5);
    $pdf->SetXY($startX + $halfW + 2, $startY + $topH - 10);
    $pdf->Cell($halfW - 4, 5, $reviewedBy, 0, 1, 'L');

    // Signature line (blank, under the name) — right cell
    $pdf->SetLineWidth(0.3);
    $pdf->Line(
        $startX + $halfW + 4,
        $startY + $topH - 6,
        $startX + $boxW - 4,
        $startY + $topH - 6
    );

    // reviewed-by position — right cell
    $pdf->SetFont('helvetica', '', 7.5);
    $pdf->SetXY($startX + $halfW + 2, $startY + $topH - 5);
    $pdf->Cell($halfW - 4, 4.5, $reviewedByPosition, 0, 1, 'L');

    // ── Bottom half: Validated by ─────────────────────────────────────────────
    $botH   = 14;
    $botY   = $startY + $topH;

    $pdf->Rect($startX, $botY, $boxW, $botH);

    $pdf->SetFont('helvetica', '', 8);
    $pdf->SetXY($startX + 2, $botY + 2);
    $pdf->Cell($boxW - 4, 5, 'Validated by:', 0, 1, 'L');

    // Validated-by name + position
    $pdf->SetFont('helvetica', 'BU', 8);
    $pdf->SetXY($startX + 2, $botY + $botH - 6);
    $pdf->Cell(90, 4.5, $validatedBy !== '' ? $validatedBy : '________________________________', 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8);
    $pdf->Cell(0,  4.5, $validatedByPosition, 0, 1, 'L');

    // ── Regional Director block (centered, below the box) ────────────────────
    $rdY = $botY + $botH + 6;
    $pdf->SetFont('helvetica', '', 7.5);
    $pdf->SetTextColor(80, 80, 80);
    $pdf->SetXY($startX, $rdY);
    $pdf->Cell($boxW, 4.5, 'NOTED pursuant to D.O. No. 12, s. 1997', 0, 1, 'C');
    $pdf->Ln(2);
    $pdf->SetFont('helvetica', 'B', 8);
    $pdf->SetTextColor(0, 0, 0);
    $pdf->SetX($startX);
    $pdf->Cell($boxW, 5, $notedBy, 0, 1, 'C');
    $pdf->SetFont('helvetica', '', 7.5);
    $pdf->SetX($startX);
    $pdf->Cell($boxW, 4.5, $notedByPosition, 0, 1, 'C');

    // Move Y past the whole block
    $pdf->SetY($pdf->GetY() + 4);
    $pdf->SetTextColor(0, 0, 0);
}

// ── Build Kinder rows ─────────────────────────────────────────────────────────
if ($hasKinder) {
    $kTuitionCurr = (float)($kinder['k_tuition_curr'] ?? 0);
    $kTuitionProp = (float)($kinder['k_tuition_prop'] ?? 0);

    // Fix #5: corrected field names to match JS KINDER_FIELDS (old names k_lms/k_av/k_assess don't exist in payload)
    $kinderMiscFields = ['k_id', 'k_ins', 'k_handbook', 'k_water', 'k_itm', 'k_med', 'k_reg', 'k_books', 'k_dev'];
    $kMiscCurr = array_sum(array_map(fn($f) => (float)($kinder[$f . '_curr'] ?? 0), $kinderMiscFields));
    $kMiscProp = array_sum(array_map(fn($f) => (float)($kinder[$f . '_prop'] ?? 0), $kinderMiscFields));

    // PRE-SCHOOL has Pre-Kinder AND Kindergarten rows (matching Image 1).
    // Both share the same fee schedule entered in the form — if the school
    // only has one pre-school level the Pre-Kinder row will still display
    // the same values (DepEd forms list both rows regardless).
    compSectionHead($pdf, 'PRE-SCHOOL');
    $wCol = $isIncrease ? $wTinc : $wTnoinc;
    comparativeTable($pdf, [
        ['level' => 'Pre-Kinder',
         'tuition_curr' => $kTuitionCurr, 'tuition_prop' => $kTuitionProp,
         'misc_curr'    => $kMiscCurr,    'misc_prop'    => $kMiscProp],
        ['level' => 'Kindergarten',
         'tuition_curr' => $kTuitionCurr, 'tuition_prop' => $kTuitionProp,
         'misc_curr'    => $kMiscCurr,    'misc_prop'    => $kMiscProp],
        ['level' => 'TOTAL', 'type' => 'total',
         'tuition_curr' => $kTuitionCurr * 2, 'tuition_prop' => $kTuitionProp * 2,
         'misc_curr'    => $kMiscCurr * 2,    'misc_prop'    => $kMiscProp * 2],
    ], $currentSY, $proposedSY, $isIncrease, $wLevel, $wCol);

    drawSignatureBlock($pdf, $principal, $principalPosition, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition, $pdf->getPageWidth(), 15);
}

// ── Build Elementary rows (one row per grade) ─────────────────────────────────
if ($hasElem) {
    if ($pdf->GetY() > 180) { $pdf->AddPage('P'); }

    $eTuitionCurr = (float)($elem['e_tuition_curr'] ?? 0);
    $eTuitionProp = (float)($elem['e_tuition_prop'] ?? 0);

    $elemMiscFields = ['e_id', 'e_ins', 'e_handbook', 'e_lab', 'e_water', 'e_itm', 'e_med', 'e_reg', 'e_books', 'e_paces1', 'e_paces2'];
    $eMiscCurr = array_sum(array_map(fn($f) => (float)($elem[$f . '_curr'] ?? 0), $elemMiscFields));
    $eMiscProp = array_sum(array_map(fn($f) => (float)($elem[$f . '_prop'] ?? 0), $elemMiscFields));

    $elemRows = [];
    foreach ([1, 2, 3, 4, 5, 6] as $g) {
        $elemRows[] = [
            'level'        => 'Grade ' . $g,
            'tuition_curr' => $eTuitionCurr,
            'tuition_prop' => $eTuitionProp,
            'misc_curr'    => $eMiscCurr,
            'misc_prop'    => $eMiscProp,
        ];
    }
    $elemRows[] = [
        'level'        => 'TOTAL',
        'type'         => 'total',
        'tuition_curr' => $eTuitionCurr * 6,
        'tuition_prop' => $eTuitionProp * 6,
        'misc_curr'    => $eMiscCurr * 6,
        'misc_prop'    => $eMiscProp * 6,
    ];

    compSectionHead($pdf, 'ELEMENTARY');
    $wCol = $isIncrease ? $wTinc : $wTnoinc;
    comparativeTable($pdf, $elemRows, $currentSY, $proposedSY, $isIncrease, $wLevel, $wCol);

    drawSignatureBlock($pdf, $principal, $principalPosition, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition, $pdf->getPageWidth(), 15);
}
if ($hasJHS) {
    if ($pdf->GetY() > 180) { $pdf->AddPage('P'); }

    $jTuitionCurr = (float)($jhs['j_tuition_curr'] ?? 0);
    $jTuitionProp = (float)($jhs['j_tuition_prop'] ?? 0);

    // Fix #5: corrected field names to match JS JHS_FIELDS (old names j_lms/j_sci/j_tle/j_lib/j_guid don't exist in payload)
    $jhsMiscFields = ['j_id', 'j_ins', 'j_handbook', 'j_comp', 'j_water', 'j_itm', 'j_med', 'j_reg', 'j_books', 'j_paces1', 'j_paces2'];
    $jMiscCurr = array_sum(array_map(fn($f) => (float)($jhs[$f . '_curr'] ?? 0), $jhsMiscFields));
    $jMiscProp = array_sum(array_map(fn($f) => (float)($jhs[$f . '_prop'] ?? 0), $jhsMiscFields));

    $jhsRows = [];
    foreach ([7, 8, 9, 10] as $g) {
        $jhsRows[] = [
            'level'        => 'Grade ' . $g,
            'tuition_curr' => $jTuitionCurr,
            'tuition_prop' => $jTuitionProp,
            'misc_curr'    => $jMiscCurr,
            'misc_prop'    => $jMiscProp,
        ];
    }
    $jhsRows[] = [
        'level'        => 'TOTAL',
        'type'         => 'total',
        'tuition_curr' => $jTuitionCurr * 4,
        'tuition_prop' => $jTuitionProp * 4,
        'misc_curr'    => $jMiscCurr * 4,
        'misc_prop'    => $jMiscProp * 4,
    ];

    compSectionHead($pdf, 'JUNIOR HIGH SCHOOL');
    $wCol = $isIncrease ? $wTinc : $wTnoinc;
    comparativeTable($pdf, $jhsRows, $currentSY, $proposedSY, $isIncrease, $wLevel, $wCol);

    drawSignatureBlock($pdf, $principal, $principalPosition, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition, $pdf->getPageWidth(), 15);
}

// ── Build SHS rows (Grade 11 / Grade 12) ──────────────────────────────────────
if ($hasSHS) {
    if ($pdf->GetY() > 180) { $pdf->AddPage('P'); }

    // Tuition may be entered as one shared value (s_tuition) or split per
    // grade (s11_tuition / s12_tuition) depending on the builder's
    // "different fee per grade" toggle — only one of these paths is ever
    // populated for a given submission, so summing them is safe.
    $s11TuitionCurr = (float)($shs['s_tuition_curr'] ?? 0) + (float)($shs['s11_tuition_curr'] ?? 0);
    $s11TuitionProp = (float)($shs['s_tuition_prop'] ?? 0) + (float)($shs['s11_tuition_prop'] ?? 0);
    $s12TuitionCurr = (float)($shs['s_tuition_curr'] ?? 0) + (float)($shs['s12_tuition_curr'] ?? 0);
    $s12TuitionProp = (float)($shs['s_tuition_prop'] ?? 0) + (float)($shs['s12_tuition_prop'] ?? 0);

    $shsMiscFields = ['s_id', 's_ins', 's_exam', 's_sports', 's_sid', 's_handbook', 's_comp', 's_water', 's_itm', 's_med', 's_reg', 's_books', 's_dev'];
    $sMiscCurr = array_sum(array_map(fn($f) => (float)($shs[$f . '_curr'] ?? 0), $shsMiscFields));
    $sMiscProp = array_sum(array_map(fn($f) => (float)($shs[$f . '_prop'] ?? 0), $shsMiscFields));

    $shsRows = [
        ['level' => 'Grade 11', 'tuition_curr' => $s11TuitionCurr, 'tuition_prop' => $s11TuitionProp, 'misc_curr' => $sMiscCurr, 'misc_prop' => $sMiscProp],
        ['level' => 'Grade 12', 'tuition_curr' => $s12TuitionCurr, 'tuition_prop' => $s12TuitionProp, 'misc_curr' => $sMiscCurr, 'misc_prop' => $sMiscProp],
        ['level' => 'TOTAL', 'type' => 'total',
         'tuition_curr' => $s11TuitionCurr + $s12TuitionCurr, 'tuition_prop' => $s11TuitionProp + $s12TuitionProp,
         'misc_curr'    => $sMiscCurr * 2,                    'misc_prop'    => $sMiscProp * 2],
    ];

    compSectionHead($pdf, 'SENIOR HIGH SCHOOL');
    $wCol = $isIncrease ? $wTinc : $wTnoinc;
    comparativeTable($pdf, $shsRows, $currentSY, $proposedSY, $isIncrease, $wLevel, $wCol);

    drawSignatureBlock($pdf, $principal, $principalPosition, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition, $pdf->getPageWidth(), 15);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — BREAKDOWN OF SCHOOL FEES (Portrait, per-grade fee rows)
//
// Matches the official DepEd Region III "Breakdown of School Fees" template:
//   - School Name / School Year / School Address / School ID fields
//   - "BREAKDOWN OF SCHOOL FEES" title + "Part I" label
//   - Plain-bordered table with roman-numeral section column (I., II., III.)
//     and NO shading — section header rows (MISCELLANEOUS FEES, OTHER FEES)
//     are plain bold rows, not gray boxes.
//   - Prepared by / Processed and Evaluated by / Validated by /
//     "NOTED pursuant to D.O. No. 12, s. 1997" / Assistant Regional Director
// ══════════════════════════════════════════════════════════════════════════════

// ── School info fields (School Name / Year / Address / ID) ───────────────────
function breakdownSchoolInfo(TuitionPDF $pdf, string $schoolName, string $address, string $proposedSY, string $schoolId): void {
    $pageW   = $pdf->getPageWidth();
    $lMargin = 15;
    $usable  = $pageW - 30;
    $half    = $usable / 2;

    $pdf->SetTextColor(0, 0, 0);

    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell(28, 5, 'School Name: ', 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->Cell($half - 28, 5, $schoolName, 'B', 0, 'L');

    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell(24, 5, 'School Year: ', 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->Cell($half - 24, 5, $proposedSY, 'B', 1, 'L');

    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell(30, 5, 'School Address: ', 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->Cell($usable - 30, 5, $address, 'B', 1, 'L');

    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell(22, 5, 'School ID: ', 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->Cell($half - 22, 5, $schoolId, 'B', 1, 'L');

    $pdf->Ln(3);
}

// ── Title + "Part I" label ────────────────────────────────────────────────────
function breakdownTitle(TuitionPDF $pdf): void {
    $pdf->SetFont('helvetica', 'B', 11);
    $pdf->SetTextColor(0, 0, 0);
    $pdf->Cell(0, 6, 'BREAKDOWN OF SCHOOL FEES', 0, 1, 'C');
    $pdf->SetFont('helvetica', 'B', 9);
    $pdf->Cell(0, 5, 'Part I', 0, 1, 'L');
    $pdf->Ln(1);
}

// ── Breakdown table — plain borders, roman-numeral column, no shading ────────
// $feeItems: array of rows shaped as either
//   ['type'=>'section','roman'=>'I.','label'=>'TUITION FEE']
//   ['label'=>'Tuition Fee','amounts'=>[..one value per grade column..]]
//   ['type'=>'total','amounts'=>[..]]
function breakdownTable(TuitionPDF $pdf, array $feeItems, array $gradeLabels): void {
    $pageW     = $pdf->getPageWidth();
    $margins   = 30; // 15 left + 15 right
    $usable    = $pageW - $margins;
    $numGrades = count($gradeLabels);
    $wRoman    = 8;
    $wFees     = 62;
    $wGrade    = ($usable - $wRoman - $wFees) / $numGrades;

    $pdf->SetDrawColor(0, 0, 0);
    $pdf->SetLineWidth(0.2);
    $pdf->SetTextColor(0, 0, 0);

    // Header row: "FEES" spans the roman + label columns, then grade column(s)
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell($wRoman + $wFees, 6, 'FEES', 1, 0, 'C', false);
    foreach ($gradeLabels as $i => $gl) {
        $last = ($i === $numGrades - 1);
        $pdf->Cell($wGrade, 6, $gl, 1, $last ? 1 : 0, 'C', false);
    }

    // Data rows
    foreach ($feeItems as $item) {
        $type = $item['type'] ?? 'fee';

        if ($type === 'section') {
            $pdf->SetFont('helvetica', 'B', 8.5);
            $pdf->Cell($wRoman, 5.5, $item['roman'] ?? '', 1, 0, 'C', false);
            $pdf->Cell($wFees,  5.5, $item['label'],       1, 0, 'L', false);
            foreach ($gradeLabels as $i => $gl) {
                $last = ($i === $numGrades - 1);
                $pdf->Cell($wGrade, 5.5, '', 1, $last ? 1 : 0, 'C', false);
            }
        } elseif ($type === 'total') {
            $pdf->SetFont('helvetica', 'B', 8.5);
            $pdf->Cell($wRoman, 6, '', 1, 0, 'C', false);
            $pdf->Cell($wFees,  6, 'TOTAL', 1, 0, 'L', false);
            $amounts = $item['amounts'] ?? [];
            foreach ($gradeLabels as $i => $gl) {
                $last = ($i === $numGrades - 1);
                $amt  = isset($amounts[$i]) ? fmtPeso((float)$amounts[$i]) : '';
                $pdf->Cell($wGrade, 6, $amt, 1, $last ? 1 : 0, 'R', false);
            }
        } else {
            $pdf->SetFont('helvetica', '', 8);
            $pdf->Cell($wRoman, 5.5, '', 1, 0, 'C', false);
            $pdf->Cell($wFees,  5.5, '   ' . $item['label'], 1, 0, 'L', false);
            $amounts = $item['amounts'] ?? [];
            foreach ($gradeLabels as $i => $gl) {
                $last = ($i === $numGrades - 1);
                $val  = isset($amounts[$i]) ? (float)$amounts[$i] : 0.0;
                $amt  = $val > 0 ? fmtPeso($val) : '-';
                $pdf->Cell($wGrade, 5.5, $amt, 1, $last ? 1 : 0, 'R', false);
            }
        }
    }
    $pdf->Ln(3);
}

// ── Prepared by / Processed & Evaluated by / Validated by / NOTED block ──────
function breakdownSigBlock(
    TuitionPDF $pdf,
    string     $principal,
    string     $principalPosition,
    string     $contact,
    string     $reviewedBy,
    string     $reviewedByPosition,
    string     $validatedBy,
    string     $validatedByPosition,
    string     $notedBy,
    string     $notedByPosition
): void {
    $pageW   = $pdf->getPageWidth();
    $lMargin = 15;
    $usable  = $pageW - 30;
    $half    = $usable / 2;

    $pdf->SetTextColor(0, 0, 0);
    $pdf->Ln(4);

    // Labels
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->SetX($lMargin);
    $pdf->Cell($half, 5, 'Prepared by:', 0, 0, 'L');
    $pdf->Cell($half, 5, 'Processed and Evaluated by:', 0, 1, 'L');

    // Signature lines
    $pdf->Ln(8);
    $lineY = $pdf->GetY();
    $pdf->SetDrawColor(0, 0, 0);
    $pdf->SetLineWidth(0.2);
    $pdf->Line($lMargin,         $lineY, $lMargin + $half - 10, $lineY);
    $pdf->Line($lMargin + $half, $lineY, $lMargin + $usable - 10, $lineY);

    // Name under each line
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->SetXY($lMargin, $lineY + 1);
    $pdf->Cell($half, 5, $principal, 0, 0, 'L');
    $pdf->Cell($half, 5, $reviewedBy, 0, 1, 'L');

    $pdf->SetFont('helvetica', '', 8);
    $pdf->SetX($lMargin);
    $pdf->Cell($half, 5, $principalPosition, 0, 0, 'L');
    $pdf->Cell($half, 5, $reviewedByPosition, 0, 1, 'L');

    if ($contact !== '') {
        $pdf->SetX($lMargin);
        $pdf->Cell($half, 5, 'Contact # ' . $contact, 0, 1, 'L');
    }

    // Validated by
    $pdf->Ln(4);
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->SetX($lMargin);
    $pdf->Cell(0, 5, 'Validated by:', 0, 1, 'L');
    $pdf->Ln(8);
    $vy = $pdf->GetY();
    $pdf->Line($lMargin, $vy, $lMargin + 70, $vy);
    $pdf->SetFont('helvetica', 'B', 8);
    $pdf->SetXY($lMargin, $vy + 1);
    $pdf->Cell(70, 5, $validatedBy, 0, 0, 'L');
    $pdf->SetFont('helvetica', '', 8);
    $pdf->Cell(0, 5, $validatedByPosition, 0, 1, 'L');

    // NOTED pursuant to D.O. No. 12, s. 1997
    $pdf->Ln(4);
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell(0, 5, 'NOTED pursuant to D.O. No. 12, s. 1997', 0, 1, 'C');
    $pdf->SetFont('helvetica', 'B', 9);
    $pdf->Cell(0, 5, $notedBy, 0, 1, 'C');
    $pdf->SetFont('helvetica', '', 8);
    $pdf->Cell(0, 5, $notedByPosition, 0, 1, 'C');
}

// ── Kinder breakdown ──────────────────────────────────────────────────────────
if ($hasKinder) {
    $pdf->AddPage('P');
    breakdownSchoolInfo($pdf, $schoolName, $address, $proposedSY, $schoolId);
    breakdownTitle($pdf);

    $kinderItems = [
        ['type' => 'section', 'roman' => 'I.',   'label' => 'TUITION FEE'],
        ['label' => 'Tuition Fee',                  'amounts' => [$kinder['k_tuition_prop']  ?? 0]],
        ['type' => 'section', 'roman' => 'II.',  'label' => 'MISCELLANEOUS FEES'],
        ['label' => 'Identification Card',          'amounts' => [$kinder['k_id_prop']       ?? 0]],
        ['label' => 'Insurance',                    'amounts' => [$kinder['k_ins_prop']      ?? 0]],
        ['label' => 'Handbook Fee',                 'amounts' => [$kinder['k_handbook_prop'] ?? 0]],
        ['label' => 'Water Fee',                    'amounts' => [$kinder['k_water_prop']    ?? 0]],
        ['label' => 'Instructional & Test Mat.',    'amounts' => [$kinder['k_itm_prop']      ?? 0]],
        ['label' => 'Medical Supplies',             'amounts' => [$kinder['k_med_prop']      ?? 0]],
        ['type' => 'section', 'roman' => 'III.', 'label' => 'OTHER FEES'],
        ['label' => 'Registration Fee',             'amounts' => [$kinder['k_reg_prop']      ?? 0]],
        ['label' => 'Books',                        'amounts' => [$kinder['k_books_prop']    ?? 0]],
        ['label' => 'Development Fee',              'amounts' => [$kinder['k_dev_prop']      ?? 0]],
        ['type' => 'total', 'amounts' => [$kinder['k_total_prop'] ?? 0]],
    ];
    breakdownTable($pdf, $kinderItems, ['KINDERGARTEN']);
    breakdownSigBlock($pdf, $principal, $principalPosition, $contact, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition);
}

// ── Elementary breakdown (6 grade columns side by side) ──────────────────────
if ($hasElem) {
    $pdf->AddPage('P');
    breakdownSchoolInfo($pdf, $schoolName, $address, $proposedSY, $schoolId);
    breakdownTitle($pdf);

    $eVal = fn(string $f): float => (float)($elem[$f . '_prop'] ?? 0);
    $rep6 = fn(float $v): array => array_fill(0, 6, $v);

    $elemItems = [
        ['type' => 'section', 'roman' => 'I.',   'label' => 'TUITION FEE'],
        ['label' => 'Tuition Fee',               'amounts' => $rep6($eVal('e_tuition'))],
        ['type' => 'section', 'roman' => 'II.',  'label' => 'MISCELLANEOUS FEES'],
        ['label' => 'Identification Card',        'amounts' => $rep6($eVal('e_id'))],
        ['label' => 'Insurance',                  'amounts' => $rep6($eVal('e_ins'))],
        ['label' => 'Handbook Fee',               'amounts' => $rep6($eVal('e_handbook'))],
        ['label' => 'Laboratory Fee',              'amounts' => $rep6($eVal('e_lab'))],
        ['label' => 'Water Fee',                  'amounts' => $rep6($eVal('e_water'))],
        ['label' => 'Instructional & Test Mat.',  'amounts' => $rep6($eVal('e_itm'))],
        ['label' => 'Medical Supplies',           'amounts' => $rep6($eVal('e_med'))],
        ['type' => 'section', 'roman' => 'III.', 'label' => 'OTHER FEES'],
        ['label' => 'Registration Fee',           'amounts' => $rep6($eVal('e_reg'))],
        ['label' => 'Books',                      'amounts' => $rep6($eVal('e_books'))],
        ['label' => 'PACEs 1st Deposit',          'amounts' => $rep6($eVal('e_paces1'))],
        ['label' => 'PACEs 2nd Deposit',          'amounts' => $rep6($eVal('e_paces2'))],
        ['type' => 'total', 'amounts' => $rep6($eVal('e_total'))],
    ];
    breakdownTable($pdf, $elemItems, ['GRADE 1', 'GRADE 2', 'GRADE 3', 'GRADE 4', 'GRADE 5', 'GRADE 6']);
    breakdownSigBlock($pdf, $principal, $principalPosition, $contact, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition);
}

// ── JHS breakdown (4 grade columns side by side) ──────────────────────────────
if ($hasJHS) {
    $pdf->AddPage('P');
    breakdownSchoolInfo($pdf, $schoolName, $address, $proposedSY, $schoolId);
    breakdownTitle($pdf);

    $jVal = fn(string $f): float => (float)($jhs[$f . '_prop'] ?? 0);
    $rep4 = fn(float $v): array => array_fill(0, 4, $v);

    $jhsItems = [
        ['type' => 'section', 'roman' => 'I.',   'label' => 'TUITION FEE'],
        ['label' => 'Tuition Fee',               'amounts' => $rep4($jVal('j_tuition'))],
        ['type' => 'section', 'roman' => 'II.',  'label' => 'MISCELLANEOUS FEES'],
        ['label' => 'Identification Card',        'amounts' => $rep4($jVal('j_id'))],
        ['label' => 'Insurance',                  'amounts' => $rep4($jVal('j_ins'))],
        ['label' => 'Handbook Fee',               'amounts' => $rep4($jVal('j_handbook'))],
        ['label' => 'Computer Laboratory Fee',    'amounts' => $rep4($jVal('j_comp'))],
        ['label' => 'Water Fee',                  'amounts' => $rep4($jVal('j_water'))],
        ['label' => 'Instructional & Test Mat.',  'amounts' => $rep4($jVal('j_itm'))],
        ['label' => 'Medical Supplies',           'amounts' => $rep4($jVal('j_med'))],
        ['type' => 'section', 'roman' => 'III.', 'label' => 'OTHER FEES'],
        ['label' => 'Registration Fee',           'amounts' => $rep4($jVal('j_reg'))],
        ['label' => 'Books',                      'amounts' => $rep4($jVal('j_books'))],
        ['label' => 'PACEs 1st Deposit',          'amounts' => $rep4($jVal('j_paces1'))],
        ['label' => 'PACEs 2nd Deposit',          'amounts' => $rep4($jVal('j_paces2'))],
        ['type' => 'total', 'amounts' => $rep4($jVal('j_total'))],
    ];
    breakdownTable($pdf, $jhsItems, ['GRADE 7', 'GRADE 8', 'GRADE 9', 'GRADE 10']);
    breakdownSigBlock($pdf, $principal, $principalPosition, $contact, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition);
}

// ── SHS breakdown (Grade 11 / Grade 12 columns) ───────────────────────────────
if ($hasSHS) {
    $pdf->AddPage('P');
    breakdownSchoolInfo($pdf, $schoolName, $address, $proposedSY, $schoolId);
    breakdownTitle($pdf);

    // Tuition may be a single shared value (s_tuition) or split per grade
    // (s11_tuition / s12_tuition); only one path is ever populated for a
    // given submission, so summing them per column is safe.
    $sSharedTuition = (float)($shs['s_tuition_prop'] ?? 0);
    $s11Tuition     = $sSharedTuition + (float)($shs['s11_tuition_prop'] ?? 0);
    $s12Tuition     = $sSharedTuition + (float)($shs['s12_tuition_prop'] ?? 0);
    $sVal = fn(string $f): float => (float)($shs[$f . '_prop'] ?? 0);
    $rep2 = fn(float $v): array => [$v, $v];

    $shsItems = [
        ['type' => 'section', 'roman' => 'I.',   'label' => 'TUITION FEE'],
        ['label' => 'Tuition Fee',                 'amounts' => [$s11Tuition, $s12Tuition]],
        ['type' => 'section', 'roman' => 'II.',  'label' => 'MISCELLANEOUS FEES'],
        ['label' => 'Identification Card',          'amounts' => $rep2($sVal('s_id'))],
        ['label' => 'Insurance',                    'amounts' => $rep2($sVal('s_ins'))],
        ['label' => 'Examination Fee',               'amounts' => $rep2($sVal('s_exam'))],
        ['label' => 'Sports Development / Athletics','amounts' => $rep2($sVal('s_sports'))],
        ['label' => 'Student ID Card (SID)',        'amounts' => $rep2($sVal('s_sid'))],
        ['label' => 'Handbook Fee',                 'amounts' => $rep2($sVal('s_handbook'))],
        ['label' => 'Computer Laboratory Fee',       'amounts' => $rep2($sVal('s_comp'))],
        ['label' => 'Water Fee',                    'amounts' => $rep2($sVal('s_water'))],
        ['label' => 'Instructional & Test Mat.',    'amounts' => $rep2($sVal('s_itm'))],
        ['label' => 'Medical Supplies',             'amounts' => $rep2($sVal('s_med'))],
        ['type' => 'section', 'roman' => 'III.', 'label' => 'OTHER FEES'],
        ['label' => 'Registration Fee',             'amounts' => $rep2($sVal('s_reg'))],
        ['label' => 'Books',                        'amounts' => $rep2($sVal('s_books'))],
        ['label' => 'Development Fee',              'amounts' => $rep2($sVal('s_dev'))],
        ['type' => 'total', 'amounts' => $rep2($sVal('s_total'))],
    ];
    breakdownTable($pdf, $shsItems, ['GRADE 11', 'GRADE 12']);
    breakdownSigBlock($pdf, $principal, $principalPosition, $contact, $reviewedBy, $reviewedByPosition, $validatedBy, $validatedByPosition, $notedBy, $notedByPosition);
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — PROGRAM OF EXPENDITURES (70-20-10)
// ══════════════════════════════════════════════════════════════════════════════
$pdf->AddPage('P');
$pdf->SetFont('helvetica', 'B', 10);
$pdf->SetTextColor(0, 0, 0);
$pdf->Cell(0, 7, 'PROGRAM OF EXPENDITURES', 0, 1, 'C');
$pdf->Ln(2);

if (!$isIncrease) {
    $pdf->SetFont('helvetica', 'I', 9);
    $pdf->SetTextColor(80, 80, 80);
    $pdf->MultiCell(0, 6, 'No increase submitted. Program of Expenditures does not apply for this submission.', 0, 'C');
} else {
    // Compute total increase across all levels
    $totalIncrease = 0;
    if ($hasKinder) {
        $totalIncrease += (float)($kinder['total_prop'] ?? 0) - (float)($kinder['total_curr'] ?? 0);
    }
    if ($hasElem) {
        $totalIncrease += (float)($elem['total_prop'] ?? 0) - (float)($elem['total_curr'] ?? 0);
    }
    if ($hasJHS) {
        $totalIncrease += (float)($jhs['total_prop'] ?? 0) - (float)($jhs['total_curr'] ?? 0);
    }
    if ($hasSHS) {
        $totalIncrease += (float)($shs['total_prop'] ?? 0) - (float)($shs['total_curr'] ?? 0);
    }
    $p70 = $totalIncrease * 0.70;
    $p20 = $totalIncrease * 0.20;
    $p10 = $totalIncrease * 0.10;

    // Table header
    $wAlloc = 25;
    $wAmt   = 40;
    $wDesc  = 0;

    $pdf->SetFillColor(200, 214, 229);
    $pdf->SetFont('helvetica', 'B', 8.5);
    $pdf->Cell($wAlloc, 7, '',                    1, 0, 'C', true);
    $pdf->Cell($wAmt,   7, 'Allocation',          1, 0, 'C', true);
    $pdf->Cell(0,       7, 'Program Expenditure', 1, 1, 'C', true);

    $allocRows = [
        ['pct' => '70%', 'amount' => $p70, 'lines' => [
            '- for equitable basic salary/salary increase for all personnel concerned',
            '- for retirements benefits',
            '- for allowance of other benefits',
            '- for faculty development',
        ]],
        ['pct' => '20%', 'amount' => $p20, 'lines' => [
            '- for improvement of instruction library, laboratory facilities and research',
            '- for student service',
            '- for extension',
        ]],
        ['pct' => '10%', 'amount' => $p10, 'lines' => [
            'for return of investment',
        ]],
    ];

    foreach ($allocRows as $row) {
        $lineH    = 5.0;
        $rowH     = max(10.0, count($row['lines']) * $lineH + 4);
        $startY   = $pdf->GetY();

        $pdf->SetFont('helvetica', 'B', 12);
        $pdf->SetFillColor(255, 255, 255);
        $pdf->SetTextColor(0, 0, 0);
        $pdf->MultiCell($wAlloc, $rowH, $row['pct'], 1, 'C', false, 0, '', $startY);

        $pdf->SetFont('helvetica', '', 9);
        $pdf->MultiCell($wAmt, $rowH, fmtPeso($row['amount']), 1, 'R', false, 0, '', $startY);

        $pdf->SetFont('helvetica', '', 8);
        $desc = implode("\n", $row['lines']);
        $pdf->MultiCell(0, $rowH, $desc, 1, 'L', false, 1, '', $startY);
    }

    $pdf->Ln(6);
    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->Cell(0, 5, 'Prepared by:', 0, 1);
    $pdf->Ln(10);
    $pdf->SetFont('helvetica', 'BU', 9);
    $pdf->Cell(0, 5, $principal, 0, 1);
    $pdf->SetFont('helvetica', '', 8);
    $pdf->Cell(0, 5, $principalPosition, 0, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — JUSTIFICATION OF FEE ITEMS
// ══════════════════════════════════════════════════════════════════════════════
$pdf->AddPage('P');
$pdf->SetFont('helvetica', 'B', 10);
$pdf->SetTextColor(0, 0, 0);
$pdf->Cell(0, 7, 'PURPOSE AND JUSTIFICATION OF EACH ITEM IN PROPOSED TUITION AND OTHER SCHOOL FEES', 0, 1, 'C');
$pdf->Ln(2);

// Build fee items from whichever levels are active
$justItems = [];
if ($hasKinder) {
    // Fix #5e: justification items use corrected field names
    $justItems[] = ['label' => 'Tuition Fee (Kindergarten)',                  'amount' => $kinder['k_tuition_prop']  ?? 0, 'just' => 'Covers instruction delivery costs for the approved Kindergarten curriculum including teacher compensation and classroom operations.'];
    $justItems[] = ['label' => 'Identification Card (Kindergarten)',          'amount' => $kinder['k_id_prop']       ?? 0, 'just' => 'Covers production of official school identification cards required for student verification and facility access.'];
    $justItems[] = ['label' => 'Insurance (Kindergarten)',                    'amount' => $kinder['k_ins_prop']      ?? 0, 'just' => 'Provides personal accident insurance coverage for each enrolled student throughout the school year.'];
    $justItems[] = ['label' => 'Handbook Fee (Kindergarten)',                 'amount' => $kinder['k_handbook_prop'] ?? 0, 'just' => 'Covers the cost of the student handbook containing school policies, guidelines, and academic calendar.'];
    $justItems[] = ['label' => 'Water Fee (Kindergarten)',                    'amount' => $kinder['k_water_prop']    ?? 0, 'just' => 'Covers potable water supply and energy utility costs shared across school facilities.'];
    $justItems[] = ['label' => 'Instructional & Test Materials (Kindergarten)','amount' => $kinder['k_itm_prop']     ?? 0, 'just' => 'Funds preparation, printing, and administration of periodic assessments and instructional materials aligned with the DepEd curriculum.'];
    $justItems[] = ['label' => 'Medical Supplies (Kindergarten)',             'amount' => $kinder['k_med_prop']      ?? 0, 'just' => 'Provides for routine medical and dental check-ups, first aid supplies, and health maintenance services for all enrolled students.'];
    $justItems[] = ['label' => 'Registration Fee (Kindergarten)',             'amount' => $kinder['k_reg_prop']      ?? 0, 'just' => 'Covers administrative processing for enrollment, record keeping, and certificate issuance at the start of each school year.'];
    $justItems[] = ['label' => 'Books (Kindergarten)',                        'amount' => $kinder['k_books_prop']    ?? 0, 'just' => 'Covers cost of required textbooks and supplementary reading materials for the Kindergarten curriculum.'];
    $justItems[] = ['label' => 'Development Fee (Kindergarten)',              'amount' => $kinder['k_dev_prop']      ?? 0, 'just' => 'Funds school infrastructure improvements, equipment upgrades, and general facility development projects.'];
}
if ($hasElem) {
    $justItems[] = ['label' => 'Tuition Fee (Elementary Grades 1-6)',         'amount' => $elem['e_tuition_prop']  ?? 0, 'just' => 'Covers instruction delivery costs for the approved Elementary curriculum including teacher compensation and classroom operations.'];
    $justItems[] = ['label' => 'Identification Card (Elementary)',           'amount' => $elem['e_id_prop']       ?? 0, 'just' => 'Covers production of official school identification cards required for student verification and facility access.'];
    $justItems[] = ['label' => 'Insurance (Elementary)',                     'amount' => $elem['e_ins_prop']      ?? 0, 'just' => 'Provides personal accident insurance coverage for each enrolled student throughout the school year.'];
    $justItems[] = ['label' => 'Handbook Fee (Elementary)',                  'amount' => $elem['e_handbook_prop'] ?? 0, 'just' => 'Covers the cost of the student handbook containing school policies, guidelines, and academic calendar.'];
    $justItems[] = ['label' => 'Laboratory Fee (Elementary)',                'amount' => $elem['e_lab_prop']      ?? 0, 'just' => 'Covers maintenance and materials for science/computer laboratory activities aligned with the curriculum.'];
    $justItems[] = ['label' => 'Water Fee (Elementary)',                     'amount' => $elem['e_water_prop']    ?? 0, 'just' => 'Covers potable water supply and energy utility costs shared across school facilities.'];
    $justItems[] = ['label' => 'Instructional & Test Materials (Elementary)','amount' => $elem['e_itm_prop']      ?? 0, 'just' => 'Funds preparation, printing, and administration of periodic assessments and instructional materials aligned with the DepEd curriculum.'];
    $justItems[] = ['label' => 'Medical Supplies (Elementary)',              'amount' => $elem['e_med_prop']      ?? 0, 'just' => 'Provides for routine medical and dental check-ups, first aid supplies, and health maintenance services for all enrolled students.'];
    $justItems[] = ['label' => 'Registration Fee (Elementary)',              'amount' => $elem['e_reg_prop']      ?? 0, 'just' => 'Covers administrative processing for enrollment, record keeping, and certificate issuance at the start of each school year.'];
    $justItems[] = ['label' => 'Books (Elementary)',                        'amount' => $elem['e_books_prop']     ?? 0, 'just' => 'Covers cost of required textbooks and supplementary reading materials for the Elementary curriculum.'];
    $justItems[] = ['label' => 'PACEs 1st Deposit — May (Elementary)',       'amount' => $elem['e_paces1_prop']    ?? 0, 'just' => 'First installment for Personalized Accelerated Christian Education (PACE) learning materials deposited at the start of the school year.'];
    $justItems[] = ['label' => 'PACEs 2nd Deposit — October (Elementary)',   'amount' => $elem['e_paces2_prop']    ?? 0, 'just' => 'Second installment for PACE learning materials for the second semester of the school year.'];
}
if ($hasJHS) {
    // Fix #5f: JHS justification items use corrected field names
    $justItems[] = ['label' => 'Tuition Fee (JHS Grades 7-10)',               'amount' => $jhs['j_tuition_prop']  ?? 0, 'just' => 'Covers instruction costs for all JHS grade levels including teacher salaries, professional development, and full curriculum delivery.'];
    $justItems[] = ['label' => 'Identification Card (JHS)',                   'amount' => $jhs['j_id_prop']       ?? 0, 'just' => 'Covers issuance of official student identification cards required for school security and attendance monitoring.'];
    $justItems[] = ['label' => 'Insurance (JHS)',                             'amount' => $jhs['j_ins_prop']      ?? 0, 'just' => 'Provides personal accident insurance for all enrolled JHS students covering medical expenses from accidents.'];
    $justItems[] = ['label' => 'Handbook Fee (JHS)',                          'amount' => $jhs['j_handbook_prop'] ?? 0, 'just' => 'Covers the cost of the student handbook containing school policies, guidelines, and academic calendar.'];
    $justItems[] = ['label' => 'Computer Laboratory (JHS)',                   'amount' => $jhs['j_comp_prop']     ?? 0, 'just' => 'Covers maintenance, software licensing, and equipment upgrades for the computer laboratory aligned with the ICT curriculum.'];
    $justItems[] = ['label' => 'Water Fee (JHS)',                             'amount' => $jhs['j_water_prop']    ?? 0, 'just' => 'Covers potable water supply and energy utility costs shared across school facilities.'];
    $justItems[] = ['label' => 'Instructional & Test Materials (JHS)',        'amount' => $jhs['j_itm_prop']      ?? 0, 'just' => 'Supports procurement of printed instructional materials and workbooks per subject, aligned with the DepEd curriculum.'];
    $justItems[] = ['label' => 'Medical Supplies (JHS)',                      'amount' => $jhs['j_med_prop']      ?? 0, 'just' => 'Provides routine medical and dental services, first aid supplies, and health monitoring for all JHS students.'];
    $justItems[] = ['label' => 'Registration Fee (JHS)',                      'amount' => $jhs['j_reg_prop']      ?? 0, 'just' => 'Covers administrative processing, enrollment documentation, and records management for each student.'];
    $justItems[] = ['label' => 'Books (JHS)',                                 'amount' => $jhs['j_books_prop']    ?? 0, 'just' => 'Covers cost of required textbooks and reference materials for all JHS subjects.'];
    $justItems[] = ['label' => 'PACEs 1st Deposit — May (JHS)',               'amount' => $jhs['j_paces1_prop']   ?? 0, 'just' => 'First installment for Personalized Accelerated Christian Education (PACE) learning materials deposited at the start of the school year.'];
    $justItems[] = ['label' => 'PACEs 2nd Deposit — October (JHS)',           'amount' => $jhs['j_paces2_prop']   ?? 0, 'just' => 'Second installment for PACE learning materials for the second semester of the school year.'];
}
if ($hasSHS) {
    $sSharedTuitionJust = (float)($shs['s_tuition_prop'] ?? 0);
    $shsTuitionJustAmt  = $sSharedTuitionJust > 0 ? $sSharedTuitionJust : ((float)($shs['s11_tuition_prop'] ?? 0) + (float)($shs['s12_tuition_prop'] ?? 0));
    $justItems[] = ['label' => 'Tuition Fee (SHS Grades 11-12)',              'amount' => $shsTuitionJustAmt,          'just' => 'Covers instruction costs for all SHS grade levels including teacher salaries, professional development, and full curriculum delivery.'];
    $justItems[] = ['label' => 'Identification Card (SHS)',                   'amount' => $shs['s_id_prop']       ?? 0, 'just' => 'Covers issuance of official student identification cards required for school security and attendance monitoring.'];
    $justItems[] = ['label' => 'Insurance (SHS)',                             'amount' => $shs['s_ins_prop']      ?? 0, 'just' => 'Provides personal accident insurance for all enrolled SHS students covering medical expenses from accidents.'];
    $justItems[] = ['label' => 'Examination Fee (SHS)',                       'amount' => $shs['s_exam_prop']     ?? 0, 'just' => 'Covers preparation, printing, and administration of periodic examinations for the SHS curriculum.'];
    $justItems[] = ['label' => 'Sports Development / Athletics (SHS)',        'amount' => $shs['s_sports_prop']   ?? 0, 'just' => 'Funds athletics programs, sports equipment, and facility maintenance for student physical education.'];
    $justItems[] = ['label' => 'Student ID Card / SID (SHS)',                 'amount' => $shs['s_sid_prop']      ?? 0, 'just' => 'Covers production of the official DepEd School ID (SID) required for enrollment verification.'];
    $justItems[] = ['label' => 'Handbook Fee (SHS)',                          'amount' => $shs['s_handbook_prop'] ?? 0, 'just' => 'Covers the cost of the student handbook containing school policies, guidelines, and academic calendar.'];
    $justItems[] = ['label' => 'Computer Laboratory (SHS)',                   'amount' => $shs['s_comp_prop']     ?? 0, 'just' => 'Covers maintenance, software licensing, and equipment upgrades for the computer laboratory aligned with the ICT curriculum.'];
    $justItems[] = ['label' => 'Water Fee (SHS)',                             'amount' => $shs['s_water_prop']    ?? 0, 'just' => 'Covers potable water supply and energy utility costs shared across school facilities.'];
    $justItems[] = ['label' => 'Instructional & Test Materials (SHS)',        'amount' => $shs['s_itm_prop']      ?? 0, 'just' => 'Supports procurement of printed instructional materials and workbooks per subject, aligned with the DepEd curriculum.'];
    $justItems[] = ['label' => 'Medical Supplies (SHS)',                      'amount' => $shs['s_med_prop']      ?? 0, 'just' => 'Provides routine medical and dental services, first aid supplies, and health monitoring for all SHS students.'];
    $justItems[] = ['label' => 'Registration Fee (SHS)',                      'amount' => $shs['s_reg_prop']      ?? 0, 'just' => 'Covers administrative processing, enrollment documentation, and records management for each student.'];
    $justItems[] = ['label' => 'Books (SHS)',                                 'amount' => $shs['s_books_prop']    ?? 0, 'just' => 'Covers cost of required textbooks and reference materials for all SHS subjects.'];
    $justItems[] = ['label' => 'Development Fee (SHS)',                       'amount' => $shs['s_dev_prop']      ?? 0, 'just' => 'Funds school infrastructure improvements, equipment upgrades, and general facility development projects.'];
}

// De-duplicate by label+amount
$seen    = [];
$unique  = [];
foreach ($justItems as $item) {
    $key = $item['label'] . '|' . $item['amount'];
    if (!isset($seen[$key]) && (float)$item['amount'] > 0) {
        $seen[$key] = true;
        $unique[] = $item;
    }
}

$n = 1;
foreach ($unique as $item) {
    if ($pdf->GetY() > 230) { $pdf->AddPage('P'); }

    $pdf->SetFont('helvetica', 'BU', 9);
    $pdf->SetTextColor(0, 0, 0);
    $amtDisplay = fmtPeso((float)$item['amount']);
    $pdf->Cell(0, 5.5, $n . '. ' . $item['label'] . ' – ' . $amtDisplay, 0, 1);

    $pdf->SetFont('helvetica', '', 8.5);
    $pdf->SetTextColor(40, 40, 40);
    $pdf->MultiCell(0, 5, $item['just'], 0, 'J');
    $pdf->Ln(2);
    $n++;
}

// Closing
if ($pdf->GetY() > 220) { $pdf->AddPage('P'); }
$pdf->Ln(4);
$pdf->SetFont('helvetica', '', 9);
$pdf->SetTextColor(0, 0, 0);

if ($isIncrease) {
    $pdf->MultiCell(0, 5.5,
        'The proposed ' . fmtPct($pct) . ' increase in tuition fee shall be allocated in accordance with the 70-20-10 statutory distribution as required under DepEd Order No. 88, s. 2010: 70% for personnel salaries and benefits, 20% for facility improvements and student services, and 10% for return on investment.',
        0, 'J');
} else {
    $pdf->MultiCell(0, 5.5,
        'The school commits to maintaining the quality of its educational programs and services for the upcoming school year at no additional cost to parents and guardians.',
        0, 'J');
}
$pdf->Ln(4);
$pdf->MultiCell(0, 5.5,
    'We hereby certify that all fees collected shall be used exclusively for the purposes stated herein, in compliance with all applicable DepEd regulations.',
    0, 'J');

$pdf->Ln(12);
$pdf->SetFont('helvetica', '', 9);
$pdf->Cell(0, 5, 'Prepared by:', 0, 1);
$pdf->Ln(10);
$pdf->SetFont('helvetica', 'BU', 10);
$pdf->SetTextColor(0, 0, 0);
$pdf->Cell(0, 5, $principal, 0, 1);
$pdf->SetFont('helvetica', '', 9);
$pdf->Cell(0, 5, $principalPosition, 0, 1);
$pdf->Cell(0, 5, $schoolName, 0, 1);
$pdf->Cell(0, 5, 'Date: ' . date('F d, Y'), 0, 1);

// ── Output ────────────────────────────────────────────────────────────────────
$safeName = preg_replace('/[^A-Za-z0-9\-_]/', '_', $schoolName ?: 'school');
$filename = 'TuitionFee_' . $safeName . '_SY' . str_replace('-', '_', $proposedSY) . '.pdf';
$pdf->Output($filename, 'D');