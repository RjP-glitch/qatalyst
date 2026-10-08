/**
 * generate-summary-report.js
 *
 * Generates a Word (.docx) Summary Report that matches the format of
 * Summary_Report_Private_Schools.docx exactly:
 *   - Title + subtitle centered bold
 *   - OVERALL SUMMARY table (dark blue header #1F4E79, white text)
 *   - COMPLETE LIST OF SCHOOLS table (No. | School Name)
 *   - Section tables per category (endorsed, tuition, etc.)
 *
 * This script uses STATIC sample data matching the uploaded docx so the
 * output can be validated visually. In production, the exportWordReport()
 * function in summary-report.js will call generateWordDoc(data) with live
 * data from the tracker API.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
    Document, Packer, Paragraph, TextRun,
    Table, TableRow, TableCell,
    AlignmentType, BorderStyle, WidthType,
    ShadingType, VerticalAlign,
    PageOrientation, PageNumber,
    Header, Footer,
} = require('docx');

// ─── Colour palette (matches original docx) ──────────────────────────────────
const DARK_BLUE   = '1F4E79';   // header row fill
const MED_BLUE    = '2E75B6';   // section-title paragraph accent / alt fill
const LIGHT_BLUE  = 'D6E4F0';   // alternating row shade
const WHITE       = 'FFFFFF';
const BLACK       = '000000';
const LIGHT_GRAY  = 'F2F2F2';   // zebra row

// ─── Shared border definitions ────────────────────────────────────────────────
const THIN_BLACK = { style: BorderStyle.SINGLE, size: 2, color: BLACK };
const ALL_BORDERS = { top: THIN_BLACK, bottom: THIN_BLACK, left: THIN_BLACK, right: THIN_BLACK };
const NO_BORDER   = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const NO_BORDERS  = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

// ─── DXA helpers ─────────────────────────────────────────────────────────────
// US Letter, 1" margins → content width = 9360 DXA
const CONTENT_W = 9360;

// ─── Cell margin reused ───────────────────────────────────────────────────────
const CELL_MAR = { top: 80, bottom: 80, left: 120, right: 120 };
const CELL_MAR_SM = { top: 60, bottom: 60, left: 120, right: 120 };

// ─── Font helpers ─────────────────────────────────────────────────────────────
function run(text, opts = {}) {
    return new TextRun({
        text,
        font: 'Arial',
        size:   opts.size   ?? 18,       // default 9pt (sz=18 half-pts)
        bold:   opts.bold   ?? false,
        color:  opts.color  ?? BLACK,
        italics: opts.italics ?? false,
    });
}

function para(children, opts = {}) {
    return new Paragraph({
        alignment: opts.align ?? AlignmentType.LEFT,
        spacing: opts.spacing ?? { before: 0, after: 0 },
        children: Array.isArray(children) ? children : [children],
    });
}

// ─── Table cell helper ────────────────────────────────────────────────────────
function cell(content, opts = {}) {
    const children = typeof content === 'string'
        ? [para(run(content, { size: opts.textSize ?? 18, bold: opts.bold ?? false, color: opts.textColor ?? BLACK }),
               { align: opts.align ?? AlignmentType.LEFT })]
        : content;

    return new TableCell({
        width: { size: opts.width ?? 0, type: WidthType.DXA },
        borders: opts.borders ?? ALL_BORDERS,
        shading: opts.fill
            ? { fill: opts.fill, type: ShadingType.CLEAR, color: 'auto' }
            : undefined,
        margins: opts.margins ?? CELL_MAR_SM,
        verticalAlign: VerticalAlign.CENTER,
        children,
    });
}

// ─── Header row ──────────────────────────────────────────────────────────────
function headerCell(text, width, align = AlignmentType.CENTER) {
    return cell(
        [para(run(text, { bold: true, color: WHITE, size: 20 }), { align })],
        { width, fill: DARK_BLUE, align }
    );
}

// ─── Numbered school list table (No. | School Name) ──────────────────────────
function schoolListTable(schoolList, colWidths = [640, 8720]) {
    const rows = [];

    // Header
    rows.push(new TableRow({
        tableHeader: true,
        children: [
            headerCell('No.',         colWidths[0], AlignmentType.CENTER),
            headerCell('School Name', colWidths[1], AlignmentType.LEFT),
        ],
    }));

    schoolList.forEach((name, i) => {
        const isEven = i % 2 === 0;
        const fill   = isEven ? WHITE : LIGHT_GRAY;
        rows.push(new TableRow({
            children: [
                cell(String(i + 1), { width: colWidths[0], fill, align: AlignmentType.CENTER }),
                cell(name,          { width: colWidths[1], fill }),
            ],
        }));
    });

    return new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: colWidths,
        rows,
    });
}

// ─── Section heading paragraph ────────────────────────────────────────────────
function sectionHeading(text) {
    return new Paragraph({
        spacing: { before: 280, after: 100 },
        children: [
            new TextRun({ text, font: 'Arial', size: 24, bold: true, color: BLACK }),
        ],
        border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: MED_BLUE, space: 1 },
        },
    });
}

// ─── Sub-heading (e.g. "30 school(s) have endorsed…") ───────────────────────
function subHeading(text) {
    return new Paragraph({
        spacing: { before: 120, after: 80 },
        children: [
            new TextRun({ text, font: 'Arial', size: 18, color: BLACK }),
        ],
    });
}

// ─── Spacer paragraph ────────────────────────────────────────────────────────
function spacer(after = 120) {
    return new Paragraph({ spacing: { before: 0, after }, children: [] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * generateWordDoc(data)
 *
 * @param {Object} data  — structured report data (see DATA below for shape)
 * @returns {Promise<Buffer>}
 */
async function generateWordDoc(data) {
    const {
        schoolYear,
        totalSchools,
        overallSummary,
        syColumns,
        allSchools,
        sections,
        reportTitle    = 'SUMMARY REPORT',
        reportSubtitle = 'Document Tracking System on Private School Application and Request',
        filterDesc     = null,
    } = data;

    const children = [];

    // ── TITLE BLOCK ───────────────────────────────────────────────────────────
    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: reportTitle, font: 'Arial', size: 24, bold: true, color: BLACK })],
    }));
    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: filterDesc ? 80 : 160 },
        children: [new TextRun({ text: reportSubtitle, font: 'Arial', size: 24, bold: true, color: BLACK })],
    }));

    // Optional filter description line under the title
    if (filterDesc) {
        children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 160 },
            children: [new TextRun({ text: 'Filter: ' + filterDesc, font: 'Arial', size: 18, italics: true, color: '444444' })],
        }));
    }

    // ── OVERALL SUMMARY TABLE ─────────────────────────────────────────────────
    children.push(new Paragraph({
        spacing: { before: 0, after: 140 },
        children: [new TextRun({ text: 'OVERALL SUMMARY', font: 'Arial', size: 24, bold: true, color: BLACK })],
    }));

    const syColCount     = syColumns.length;
    const firstColW      = 4000;
    const restW          = Math.floor((CONTENT_W - firstColW) / syColCount);
    const overallColWidths = [firstColW, ...Array(syColCount).fill(restW)];

    const overallRows = [];
    overallRows.push(new TableRow({
        tableHeader: true,
        children: [
            headerCell('Category', firstColW),
            ...syColumns.map(sy => headerCell(sy, restW)),
        ],
    }));
    overallSummary.forEach((row, i) => {
        const fill = i % 2 === 0 ? WHITE : LIGHT_GRAY;
        overallRows.push(new TableRow({
            children: [
                cell(row.category, { width: firstColW, fill }),
                ...row.values.map(v => cell(String(v), { width: restW, fill, align: AlignmentType.CENTER })),
            ],
        }));
    });

    children.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: overallColWidths,
        rows: overallRows,
    }));

    children.push(spacer(200));

    // ── COMPLETE LIST OF SCHOOLS ──────────────────────────────────────────────
    children.push(sectionHeading(`COMPLETE LIST OF SCHOOLS (${allSchools.length} Schools)`));
    children.push(spacer(80));
    children.push(schoolListTable(allSchools));
    children.push(spacer(200));

    // ── CATEGORY SECTIONS ─────────────────────────────────────────────────────
    for (const section of sections) {
        children.push(sectionHeading(section.title));
        if (section.subtitle) children.push(subHeading(section.subtitle));
        children.push(spacer(80));
        children.push(schoolListTable(section.schools));
        children.push(spacer(200));
    }

    // ── BUILD DOCUMENT ────────────────────────────────────────────────────────
    const doc = new Document({
        styles: {
            default: {
                document: { run: { font: 'Arial', size: 18 } },
            },
        },
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840 },
                    margin: { top: 1008, right: 1008, bottom: 1008, left: 1008 },
                },
            },
            children,
        }],
    });

    return Packer.toBuffer(doc);
}

// ─── STATIC SAMPLE DATA (mirrors the uploaded docx) ──────────────────────────
const ALL_SCHOOLS = [
    'ACLC College of Baliuag',
    'Asian Institute of Science and Technology Baliuag (AISAT)',
    'Baliuag Alliance Christian Academy (BALCA)',
    'Baliuag Cross and Flame Academy (BCFA)',
    'Baliuag University (BU)',
    'Bulacan College of Computer Science Inc. (BCCSI)',
    'Catholic Servants of Christ Community School (CASECHOM)',
    'Baliwag Polytechnic College (BTECH)',
    'Christ Saviour Christian Academy Inc.',
    'Escuela de Angela Marici Inc. (EDAM)',
    'Fernandez College of Arts and Technology (FCAT)',
    'Grace Christian Academy Ministries of Baliuag',
    'Immaculate Conception School of Baliuag (ICSB)',
    'Integrated College of Business and Technology',
    'Liceo de Bethlehem Inc.',
    'Living Angels Christian Academy (LACA)',
    'M.I. Little Scholars, Inc.',
    'Maranatha Christian Academy of Baliuag',
    'Marian College of Baliuag Inc. (Elementary)',
    'Marian College of Baliuag Inc. (Secondary and SHS)',
    'Marinny Center for Hope, Inc.',
    'Montessori de Sagrada Familia, Inc. (MDSF)',
    'NU Bulacan Incorporated',
    'OLM Institute of Science and Technology Inc.',
    'Our Lady of Guadalupe School of Baliuag Inc.',
    'Our Lady of Mt. Carmel College (Bulacan) Incorporated (OLMCC)',
    'Saint Jean Baptiste Academy Inc. (SJBA)',
    'San Augustin Center for Development of Baliuag Inc.',
    'San Benildo Integrated School Foundation (Baliuag) Inc.',
    'Second Home Academy Inc.',
    'St. Joseph School of Baliuag Inc.',
    'St. Mark College of Baliuag Bulacan Inc.',
    "St. Mary's College of Baliuag",
    'STI College Baliuag',
    'The Little Campus North Bend School, Inc. (TLC)',
];

const SAMPLE_DATA = {
    schoolYear: 'SY 2026-2027',
    totalSchools: 35,
    syColumns: ['SY 2025-2026', 'SY 2026-2027'],
    overallSummary: [
        { category: 'Total Schools',                     values: [35, 35] },
        { category: 'School Calendar Endorsed',          values: [31, 30] },
        { category: 'With Tuition Fee Increase',         values: [6,  5]  },
        { category: 'With No Tuition Fee Increase',      values: [11, 7]  },
        { category: "Submitted Renewal of Gov't Permit", values: [2,  0]  },
        { category: "Did NOT Submit Renewal",            values: [33, 35] },
    ],
    allSchools: ALL_SCHOOLS,
    sections: [
        {
            title: 'SCHOOL CALENDAR \u2014 SY 2026-2027',
            subtitle: '30 school(s) have endorsed their school calendar for SY 2026-2027.',
            schools: [
                'ACLC College of Baliuag',
                'Asian Institute of Science and Technology Baliuag (AISAT)',
                'Baliuag Alliance Christian Academy (BALCA)',
                'Baliuag University (BU)',
                'Bulacan College of Computer Science Inc. (BCCSI)',
                'Catholic Servants of Christ Community School (CASECHOM)',
                'Baliwag Polytechnic College (BTECH)',
                'Christ Saviour Christian Academy Inc.',
                'Fernandez College of Arts and Technology (FCAT)',
                'Grace Christian Academy Ministries of Baliuag',
                'Immaculate Conception School of Baliuag (ICSB)',
                'Integrated College of Business and Technology',
                'Living Angels Christian Academy (LACA)',
                'Marian College of Baliuag Inc. (Elementary)',
                'Marian College of Baliuag Inc. (Secondary and SHS)',
                'Marinny Center for Hope, Inc.',
                'Montessori de Sagrada Familia, Inc. (MDSF)',
                'NU Bulacan Incorporated',
                'OLM Institute of Science and Technology Inc.',
                'Our Lady of Guadalupe School of Baliuag Inc.',
                'Our Lady of Mt. Carmel College (Bulacan) Incorporated (OLMCC)',
                'Saint Jean Baptiste Academy Inc. (SJBA)',
                'San Augustin Center for Development of Baliuag Inc.',
                'San Benildo Integrated School Foundation (Baliuag) Inc.',
                'Second Home Academy Inc.',
                'St. Joseph School of Baliuag Inc.',
                'St. Mark College of Baliuag Bulacan Inc.',
                "St. Mary's College of Baliuag",
                'STI College Baliuag',
                'The Little Campus North Bend School, Inc. (TLC)',
            ],
        },
        {
            title: 'TUITION FEE INCREASE \u2014 SY 2026-2027',
            subtitle: '5 school(s) applied for tuition fee increase for SY 2026-2027.',
            schools: [
                'Baliuag Alliance Christian Academy (BALCA)',
                'Integrated College of Business and Technology',
                'Marian College of Baliuag Inc. (Elementary)',
                'San Benildo Integrated School Foundation (Baliuag) Inc.',
                'Second Home Academy Inc.',
            ],
        },
        {
            title: 'NO TUITION FEE INCREASE \u2014 SY 2026-2027',
            subtitle: '7 school(s) indicated no tuition fee increase for SY 2026-2027.',
            schools: [
                'Asian Institute of Science and Technology Baliuag (AISAT)',
                'Bulacan College of Computer Science Inc. (BCCSI)',
                'Our Lady of Guadalupe School of Baliuag Inc.',
                'NU Bulacan Incorporated',
                'OLM Institute of Science and Technology Inc.',
                'San Benildo Integrated School Foundation (Baliuag) Inc.',
                "St. Mary's College of Baliuag",
            ],
        },
        {
            title: "SCHOOLS THAT HAVE NOT SUBMITTED RENEWAL OF GOV'T PERMIT \u2014 SY 2026-2027",
            subtitle: '35 school(s) have not submitted Renewal of Government Permit for SY 2026-2027.',
            schools: ALL_SCHOOLS,
        },
    ],
};

// ─── Run ──────────────────────────────────────────────────────────────────────
const inputFile  = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
    // No args = run with sample data for local testing
    generateWordDoc(SAMPLE_DATA)
        .then(buf => {
            const out = path.join(__dirname, 'Summary_Report_Private_Schools.docx');
            fs.writeFileSync(out, buf);
            console.log('Written:', out);
        })
        .catch(err => { console.error(err); process.exit(1); });
} else {
    // Called by generate-word-report.php with input JSON + output path
    try {
        const rawData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
        generateWordDoc(rawData)
            .then(buf => {
                fs.writeFileSync(outputFile, buf);
                console.log('Written:', outputFile);
            })
            .catch(err => { console.error(err); process.exit(1); });
    } catch (err) {
        console.error('Failed to read input:', err);
        process.exit(1);
    }
}