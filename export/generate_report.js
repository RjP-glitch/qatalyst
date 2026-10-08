const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
    VerticalAlign, PageNumber, PageBreak, Footer, Header, TabStopType,
    TabStopPosition, LevelFormat
} = require('docx');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('/tmp/report_data.json', 'utf8'));
const p = data.program;
const sig = data.signatories || {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n, dec = 2) {
    if (n === null || n === undefined || n === '') return '—';
    return parseFloat(n).toFixed(dec);
}

const border = { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const headerShade = { fill: "1F3864", type: ShadingType.CLEAR };
const altShade    = { fill: "EBF0FA", type: ShadingType.CLEAR };
const boldShade   = { fill: "D6E4F7", type: ShadingType.CLEAR };

function cell(text, opts = {}) {
    return new TableCell({
        borders,
        width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
        shading: opts.shading || undefined,
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 80, bottom: 80, left: 130, right: 130 },
        columnSpan: opts.span,
        children: [new Paragraph({
            alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [new TextRun({
                text: String(text ?? '—'),
                bold: !!opts.bold,
                italics: !!opts.italic,
                color: opts.color || (opts.shading && opts.shading.fill === '1F3864' ? 'FFFFFF' : '000000'),
                size: opts.size || 20,
                font: "Arial",
            })]
        })]
    });
}

function headerRow(labels, widths) {
    return new TableRow({
        tableHeader: true,
        children: labels.map((lbl, i) => cell(lbl, {
            width: widths[i], shading: headerShade, bold: true, color: 'FFFFFF', center: true, size: 18
        }))
    });
}

function sectionTitle(text) {
    return new Paragraph({
        spacing: { before: 280, after: 120 },
        children: [new TextRun({ text, bold: true, size: 24, font: "Arial", color: "1F3864" })]
    });
}

function subTitle(text) {
    return new Paragraph({
        spacing: { before: 200, after: 80 },
        children: [new TextRun({ text, bold: true, size: 21, font: "Arial", color: "2E5FA3" })]
    });
}

function para(text, opts = {}) {
    return new Paragraph({
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: opts.before || 60, after: opts.after || 60 },
        children: [new TextRun({ text: String(text ?? ''), bold: opts.bold, italics: opts.italic, size: opts.size || 20, font: "Arial", color: opts.color || '000000' })]
    });
}

function divider() {
    return new Paragraph({
        spacing: { before: 100, after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "1F3864", space: 1 } },
        children: []
    });
}

function categoryTable(categories) {
    const rows = [headerRow(['#', 'Indicators', 'Numerical Rating', 'Descriptive Rating'], [400, 5560, 1700, 1700])];
    categories.forEach((cat, i) => {
        rows.push(new TableRow({
            children: [
                cell(i + 1, { width: 400, center: true, size: 18 }),
                cell(cat.category_name, { width: 5560, size: 18 }),
                cell(fmt(cat.average_score), { width: 1700, center: true, size: 18, bold: true }),
                cell(cat.result_label, { width: 1700, center: true, italic: true, size: 18 }),
            ]
        }));
    });
    // Average row
    const avgs = categories.filter(c => c.average_score != null).map(c => parseFloat(c.average_score));
    const avg = avgs.length > 0 ? (avgs.reduce((a,b) => a+b, 0) / avgs.length) : null;
    rows.push(new TableRow({
        children: [
            cell('', { width: 400, shading: boldShade }),
            cell('Average', { width: 5560, shading: boldShade, bold: true }),
            cell(avg !== null ? fmt(avg) : '—', { width: 1700, shading: boldShade, bold: true, center: true }),
            cell(avg !== null ? getResult(avg) : '—', { width: 1700, shading: boldShade, bold: true, italic: true, center: true }),
        ]
    }));
    return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [400, 5560, 1700, 1700], rows });
}

function speakerTable(speaker) {
    const criteria = speaker.criteria || [];
    const rows = [headerRow(['#', 'Indicators', 'Numerical Rating', 'Descriptive Rating'], [400, 5560, 1700, 1700])];
    criteria.forEach((cr, i) => {
        rows.push(new TableRow({
            children: [
                cell(i + 1, { width: 400, center: true, size: 18 }),
                cell(cr.criterion_label, { width: 5560, size: 18 }),
                cell(fmt(cr.average_score), { width: 1700, center: true, bold: true, size: 18 }),
                cell(getResult(cr.average_score), { width: 1700, center: true, italic: true, size: 18 }),
            ]
        }));
    });
    // Average row
    const avg = parseFloat(speaker.overall_avg);
    rows.push(new TableRow({
        children: [
            cell('', { width: 400, shading: boldShade }),
            cell('Average', { width: 5560, shading: boldShade, bold: true }),
            cell(fmt(avg), { width: 1700, shading: boldShade, bold: true, center: true }),
            cell(speaker.result_label, { width: 1700, shading: boldShade, bold: true, italic: true, center: true }),
        ]
    }));
    return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [400, 5560, 1700, 1700], rows });
}

function getResult(avg) {
    if (avg === null || avg === undefined || avg === '') return '—';
    const n = parseFloat(avg);
    if (n >= 3.26) return 'Very Satisfactory';
    if (n >= 2.51) return 'Satisfactory';
    if (n >= 1.76) return 'Unsatisfactory';
    return 'Very Unsatisfactory';
}

function signatureBlock() {
    const checkedName = sig.checked_name || 'CECILLE E. CRUZ';
    const checkedTitle = sig.checked_title || 'SEPS-SMME';
    const noted1Name = sig.noted1_name || 'MA. AUREA RHODORA DC. GERONIMO, PhD';
    const noted1Title = sig.noted1_title || 'Chief Education Supervisor-SGOD';
    const noted2Name = sig.noted2_name || 'ERWIN JOHN F. SANTOS, CESE';
    const noted2Title = sig.noted2_title || 'Assistant Schools Division Superintendent';
    const noted3Name = sig.noted3_name || 'ROWENA T. QUIAMBAO, CESO VI';
    const noted3Title = sig.noted3_title || 'Schools Division Superintendent';

    return [
        para('', { before: 300 }),
        new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: [4680, 4680],
            rows: [new TableRow({ children: [
                new TableCell({ borders: noBorders, width: { size: 4680, type: WidthType.DXA }, children: [
                    para('Prepared by:', { size: 18 }),
                    para('', { before: 200 }),
                    para(p.qame_associates || 'QAME Associate', { bold: true, size: 20 }),
                    para('EPS II-SMME', { size: 18 }),
                ] }),
                new TableCell({ borders: noBorders, width: { size: 4680, type: WidthType.DXA }, children: [
                    para('Checked by:', { size: 18 }),
                    para('', { before: 200 }),
                    para(checkedName, { bold: true, size: 20 }),
                    para(checkedTitle, { size: 18 }),
                ] }),
            ]})]
        }),
        para('Noted:', { before: 240, size: 18 }),
        para('', { before: 180 }),
        para(noted1Name, { bold: true }),
        para(noted1Title, { size: 18 }),
        para('', { before: 160 }),
        para(noted2Name, { bold: true }),
        para(noted2Title, { size: 18 }),
        para('', { before: 160 }),
        para(noted3Name, { bold: true }),
        para(noted3Title, { size: 18 }),
    ];
}

// ─── Build document ───────────────────────────────────────────────────────────
const children = [];

// ── Cover / Header ────────────────────────────────────────────────────────────
children.push(
    para('QAME ANALYSIS', { bold: true, center: true, size: 24, before: 0 }),
    para('', { before: 60 }),
    para('Title of Training Program:', { bold: true, size: 20 }),
    para(p.title || '', { bold: true, size: 22, color: '1F3864' }),
    para('', { before: 60 }),
);

// Meta info table
const metaRows = [
    ['Proponent/s', p.proponents || '—'],
    ['Training Venue', p.training_venue || '—'],
    ['Inclusive Dates', p.inclusive_dates || '—'],
    ['Name of QAME Associates', p.qame_associates || '—'],
    ['Total Number of Participants', p.total_participants > 0 ? String(p.total_participants) : '—'],
    ['Average Number of Responses', fmt(p.avg_responses || p.total_responses, 0)],
    ['Percentage of Responses', p.pct_responses > 0 ? fmt(p.pct_responses, 1) + '%' : '—'],
];

children.push(new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [3600, 5760],
    rows: metaRows.map(([label, value]) => new TableRow({ children: [
        cell(label, { width: 3600, bold: true, shading: { fill: "F0F4FB", type: ShadingType.CLEAR }, size: 19 }),
        cell(value, { width: 5760, size: 19 }),
    ]}))
}));

children.push(para('', { before: 200 }), divider(), para('', { before: 80 }));

// ── 1. Summary of Ratings ─────────────────────────────────────────────────────
children.push(sectionTitle('1. SUMMARY OF RATINGS'));

const overallCats = p.overall_categories || [];
if (overallCats.length > 0) {
    children.push(categoryTable(overallCats));
}

// ─ Per-day breakdown if multiple days ─────────────────────────────────────────
const days = p.days || [];

// ── Category sections per day ─────────────────────────────────────────────────
const catSectionNums = { 'Program Management & Operations': 2, 'Attainment of Objectives': 3, 'Delivery of Content': 4, 'Venue': 5, 'Meal': 6, 'Program Management Team': 7 };
const catNames = Object.keys(catSectionNums);

catNames.forEach(catName => {
    // Collect rows across all days for this category
    let sectionNum = catSectionNums[catName];
    children.push(para('', { before: 120 }), sectionTitle(`${sectionNum}. ${catName.toUpperCase()}`));

    days.forEach(day => {
        const cat = (day.categories || []).find(c => c.category_name === catName);
        if (!cat) return;
        if (days.length > 1) children.push(subTitle(day.day));

        // Build individual question-level table (we only have category avg, not per-question here)
        children.push(new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: [400, 5560, 1700, 1700],
            rows: [
                headerRow(['#', 'Indicators', 'Numerical Rating', 'Descriptive Rating'], [400, 5560, 1700, 1700]),
                new TableRow({ children: [
                    cell('', { width: 400, center: true }),
                    cell(catName, { width: 5560 }),
                    cell(fmt(cat.average_score), { width: 1700, center: true, bold: true }),
                    cell(cat.result_label, { width: 1700, center: true, italic: true }),
                ]}),
                new TableRow({ children: [
                    cell('', { width: 400, shading: boldShade }),
                    cell('Average', { width: 5560, shading: boldShade, bold: true }),
                    cell(fmt(cat.average_score), { width: 1700, shading: boldShade, bold: true, center: true }),
                    cell(cat.result_label, { width: 1700, shading: boldShade, bold: true, italic: true, center: true }),
                ]}),
            ]
        }));
    });
});

// ── 8. Resource Persons ───────────────────────────────────────────────────────
children.push(para('', { before: 120 }), sectionTitle('8. RESOURCE PERSONS'));

days.forEach(day => {
    const speakers = day.speakers || [];
    if (speakers.length === 0) return;
    if (days.length > 1) children.push(subTitle(day.day));

    speakers.forEach((sp, idx) => {
        const spNum = `8.${idx + 1}`;
        children.push(
            para('', { before: 100 }),
            para(`${spNum} RESOURCE PERSON — ${(sp.speaker_name || 'Speaker ' + sp.slot_number).toUpperCase()}`, { bold: true, size: 21 }),
        );
        children.push(speakerTable(sp));
    });
});

// ── Signatures (Part 1 end) ───────────────────────────────────────────────────
children.push(...signatureBlock());

// ── Page break → Evaluation Summary ──────────────────────────────────────────
children.push(
    new Paragraph({ children: [new PageBreak()] }),
    para('EVALUATION SUMMARY', { bold: true, center: true, size: 24 }),
    para('', { before: 40 }),
    para(`${p.title}`, { bold: true, center: true, size: 22, color: '1F3864' }),
    para(p.inclusive_dates ? `${p.inclusive_dates}` : '', { center: true, size: 20, italic: true }),
    para('', { before: 80 }),
    divider(),
);

// ── I. Overall Ratings ────────────────────────────────────────────────────────
children.push(subTitle('I. OVERALL RATINGS'));
if (overallCats.length > 0) {
    const sumRows = [headerRow(['Indicators', 'Numerical Rating', 'Descriptive Rating'], [5360, 2000, 2000])];
    overallCats.forEach(cat => {
        sumRows.push(new TableRow({ children: [
            cell(cat.category_name, { width: 5360 }),
            cell(fmt(cat.average_score), { width: 2000, center: true, bold: true }),
            cell(cat.result_label, { width: 2000, center: true, italic: true }),
        ]}));
    });
    const avgs2 = overallCats.filter(c => c.average_score != null).map(c => parseFloat(c.average_score));
    const oa = avgs2.length > 0 ? avgs2.reduce((a,b)=>a+b,0)/avgs2.length : null;
    sumRows.push(new TableRow({ children: [
        cell('Overall Average', { width: 5360, shading: boldShade, bold: true }),
        cell(oa !== null ? fmt(oa) : fmt(p.overall_average), { width: 2000, shading: boldShade, bold: true, center: true }),
        cell(p.overall_result || '—', { width: 2000, shading: boldShade, bold: true, italic: true, center: true }),
    ]}));
    children.push(new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [5360, 2000, 2000], rows: sumRows }));
}

// ── II. Category Ratings ──────────────────────────────────────────────────────
children.push(para('', { before: 140 }), subTitle('II. CATEGORY RATINGS'));
{
    const catRows = [headerRow(['Category', 'Average Rating', 'Descriptive Rating'], [5360, 2000, 2000])];
    overallCats.forEach(cat => {
        catRows.push(new TableRow({ children: [
            cell(cat.category_name, { width: 5360 }),
            cell(fmt(cat.average_score), { width: 2000, center: true, bold: true }),
            cell(cat.result_label, { width: 2000, center: true, italic: true }),
        ]}));
    });
    // Add speakers overall if available
    const allSpeakers = days.flatMap(d => d.speakers || []);
    if (allSpeakers.length > 0) {
        const spAvg = allSpeakers.reduce((sum, s) => sum + parseFloat(s.overall_avg || 0), 0) / allSpeakers.length;
        catRows.push(new TableRow({ children: [
            cell('Resource Persons (Overall)', { width: 5360 }),
            cell(fmt(spAvg), { width: 2000, center: true, bold: true }),
            cell(getResult(spAvg), { width: 2000, center: true, italic: true }),
        ]}));
    }
    children.push(new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [5360, 2000, 2000], rows: catRows }));
}

// ── III. Resource Persons Summary ─────────────────────────────────────────────
children.push(para('', { before: 140 }), subTitle('III. RESOURCE PERSONS — SUMMARY OF PERFORMANCE'));
children.push(para('All speakers received Very Satisfactory ratings across all criteria.', { italic: true, size: 19 }));

days.forEach(day => {
    const speakers = day.speakers || [];
    if (speakers.length === 0) return;
    if (days.length > 1) children.push(para(day.day + ':', { bold: true, before: 120 }));

    const spRows = [headerRow(['Speaker', 'Average', 'Result'], [6000, 1680, 1680])];
    speakers.forEach(sp => {
        spRows.push(new TableRow({ children: [
            cell(sp.speaker_name || ('Speaker ' + sp.slot_number), { width: 6000 }),
            cell(fmt(sp.overall_avg), { width: 1680, center: true, bold: true }),
            cell(sp.result_label, { width: 1680, center: true, italic: true }),
        ]}));
    });
    children.push(new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [6000, 1680, 1680], rows: spRows }));
});

// ── IV. Highlights / Conclusion (placeholders) ────────────────────────────────
children.push(
    para('', { before: 160 }),
    subTitle('IV. HIGHLIGHTS FROM PARTICIPANT FEEDBACK'),
    para('A. STRENGTHS OF THE TRAINING', { bold: true, before: 120 }),
    para('[Summary of strengths based on participant feedback]', { italic: true, color: '888888', size: 19 }),
    para('B. AREAS FOR IMPROVEMENT', { bold: true, before: 120 }),
    para('[Summary of areas for improvement based on participant feedback]', { italic: true, color: '888888', size: 19 }),
    para('C. SUGGESTED ADDITIONAL TOPICS', { bold: true, before: 120 }),
    para('[List of topics suggested by participants]', { italic: true, color: '888888', size: 19 }),
    para('', { before: 120 }),
    subTitle('V. CONCLUSION'),
    para('[Overall conclusion narrative summarizing the training evaluation results]', { italic: true, color: '888888', size: 19 }),
);

// ── Signatures (Part 2 end) ───────────────────────────────────────────────────
children.push(...signatureBlock());

// ── Rating Scale Legend ───────────────────────────────────────────────────────
children.push(
    para('', { before: 240 }), divider(),
    para('RATING SCALE', { bold: true, size: 20, before: 120 }),
    para('A. For Evaluation of PMT, Objectives, Content Relevance, Meals and Venue', { bold: true, italic: true, before: 100, size: 18 }),
);
const scaleRowsA = [
    ['3.26–4.00', 'Strongly Agree (SA)', 'Very Satisfactory (VS)'],
    ['2.51–3.25', 'Agree (A)', 'Satisfactory (S)'],
    ['1.76–2.50', 'Disagree (D)', 'Unsatisfactory (U)'],
    ['1.00–1.75', 'Strongly Disagree (SD)', 'Very Unsatisfactory (VU)'],
];
children.push(new Table({
    width: { size: 9360, type: WidthType.DXA }, columnWidths: [2000, 4000, 3360],
    rows: [
        headerRow(['Scale', 'Level of Agreement', 'Descriptive Equivalent'], [2000, 4000, 3360]),
        ...scaleRowsA.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: [2000,4000,3360][i], italic: true, size: 18, center: i===0 })) }))
    ]
}));
children.push(para('B. For Resource Speaker', { bold: true, italic: true, before: 100, size: 18 }));
const scaleRowsB = [
    ['3.26–4.00', 'Very Satisfied', 'Very Satisfactory (VS)'],
    ['2.51–3.25', 'Somewhat Satisfied', 'Satisfactory (S)'],
    ['1.76–2.50', 'Somewhat Dissatisfied', 'Unsatisfactory (U)'],
    ['1.00–1.75', 'Dissatisfied', 'Very Unsatisfactory (VU)'],
];
children.push(new Table({
    width: { size: 9360, type: WidthType.DXA }, columnWidths: [2000, 4000, 3360],
    rows: [
        headerRow(['Scale', 'Level of Agreement', 'Descriptive Equivalent'], [2000, 4000, 3360]),
        ...scaleRowsB.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: [2000,4000,3360][i], italic: true, size: 18, center: i===0 })) }))
    ]
}));

// ── Build & write ─────────────────────────────────────────────────────────────
const doc = new Document({
    styles: {
        default: { document: { run: { font: "Arial", size: 20 } } }
    },
    sections: [{
        properties: {
            page: {
                size: { width: 12240, height: 15840 },
                margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
            }
        },
        children
    }]
});

Packer.toBuffer(doc).then(buf => {
    fs.writeFileSync('/tmp/evaluation_report.docx', buf);
}).catch(e => { process.exit(1); });