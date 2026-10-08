// ═══════════════════════════════════════════════════════════════════════════
//  exportConsolidated.js  (FIXED v2)
//
//  Fixes applied:
//  1. PM&O regex now matches both "& Operations" and "and Operations" (DB
//     inconsistency between programs — Program 63 uses "and", Program 59 "&")
//  2. Removed duplicate S.tranposed style key (typo) — unified to S.transposed
//  3. ws['!ref'] now uses actual tracked _maxR/_maxC (fixed W() to always update)
//  4. Row height override loops over all speaker blocks, not just the first one
//  5. SPK_ROWS derived from _SPK_CRITERIA.length instead of hardcoded 10
//  6. TRANSPOSED speaker column now stacks criterion[0..5] scores correctly
//     (was skipping criterion 0 and duplicating the overall_avg)
//  7. Participant count now reads from a reliable category (Program Management
//     Team) to avoid picking up Meal/Venue rows with lower n_responses
//  8. Added null-safety guard on speakerAverages destructure
// ═══════════════════════════════════════════════════════════════════════════

// ── Category definitions ─────────────────────────────────────────────────────
const _CATS = [
    {
        key: 'pm', nq: 4,
        header: 'PROGRAM MANAGEMENT AND OPERATIONS',
        // FIX 1: added "and\b" branch to match "Program Management and Operations"
        // in addition to "Program Management & Operations"
        catMatch: n => /program management.*(oper|&|and\b)/i.test(n),
        questions: [
            'The activity/program was delivered as planned',
            'The activity/program was managed efficiently',
            'The activity/program was  well-structured',
            'The activity/program has well-detailed and organized Training Matrix',
        ],
        qm: [
            h => /delivered as planned/i.test(h),
            h => /managed efficiently/i.test(h),
            h => /well.structured/i.test(h),
            h => /training matrix/i.test(h),
        ],
    },
    {
        key: 'obj', nq: 4,
        header: 'ATTAINMENT OF OBJECTIVES',
        catMatch: n => /attainment|objectives/i.test(n),
        questions: [
            'The objectives were clearly defined',
            'The objectives were attainable',
            'The objectives were Specific Measurable Attainable Realistic Time -bounded (SMART)',
            'The objectives were presented prior to the session',
        ],
        qm: [
            h => /clearly defined/i.test(h),
            h => /were attainable/i.test(h),
            h => /smart/i.test(h),
            h => /presented prior/i.test(h),
        ],
    },
    {
        key: 'content', nq: 7,
        header: 'DELIVERY OF CONTENT',
        catMatch: n => /delivery of content/i.test(n),
        questions: [
            'Content delivery was based on  reliable sources',
            'The discussions were effective in generating learning',
            'Meet expectations',
            'There was quality and comprehensiveness of the slide presentation',
            'Materials and handouts were relevant, adequate and helpful',
            'The presentation of ideas was organized',
            'The activity/training content was appropriate to trainees roles and responsibilities',
        ],
        qm: [
            h => /reliable sources/i.test(h),
            h => /effective in generating/i.test(h),
            h => /meet expectations/i.test(h),
            h => /comprehensiveness.*slide/i.test(h),
            h => /materials and handouts/i.test(h),
            h => /presentation of ideas/i.test(h),
            h => /appropriate to trainees/i.test(h),
        ],
    },
    {
        key: 'venue', nq: 7,
        header: 'VENUE (FOR IN-PERSON ATTENDEES ONLY)',
        catMatch: n => /^venue/i.test(n.trim()),
        questions: [
            'The conference hall  is adequately lit',
            'The conference hall is well ventilated',
            'Adequate soundproofing (no noise outside)',
            'With sufficient space for the activity',
            'Clean space',
            'Equipment was serviceable',
            'Clean comfort rooms and with adequate toiletries and water supply',
        ],
        qm: [
            h => /adequately lit/i.test(h),
            h => /well ventilated/i.test(h),
            h => /soundproofing/i.test(h),
            h => /sufficient space/i.test(h),
	            h => /\bclean\s+space\b/i.test(h),
            h => /equipment was serviceable/i.test(h),
            h => /comfort rooms/i.test(h),
        ],
    },
    {
        key: 'meal', nq: 6,
        header: 'MEAL (FOR IN-PERSON ATTENDEES)',
        catMatch: n => /^meal/i.test(n.trim()),
        questions: [
            'Sufficient quantity',
            'Sufficient variety',
            'Generally healthy',
            'Utensils like spoons and forks are clean',
            'Meals are served on time',
            'Follows protocol for holding, serving, and portioning of food served',
        ],
        qm: [
            h => /sufficient quantity/i.test(h),
            h => /sufficient variety/i.test(h),
            h => /generally healthy/i.test(h),
            h => /utensils/i.test(h),
            h => /meals are served on time/i.test(h),
            h => /portioning/i.test(h),
        ],
    },
    {
        key: 'pmt', nq: 5,
        header: 'PROGRAM MANAGEMENT TEAM',
        catMatch: n => /program management team/i.test(n),
        questions: [
            'Courteous',
            'Efficient',
            'Responsive to the needs of participants',
            'Safe work techniques',
            'The emcee/host speaks with clarity.',
        ],
        qm: [
	            h => /\bcourteous\b/i.test(h),
	            h => /\befficient\b/i.test(h),
            h => /responsive to the needs/i.test(h),
            h => /safe work/i.test(h),
            h => /emcee/i.test(h),
        ],
    },
];

// Summary ratings columns (4 columns after the category questions)
const _SUMMARY_CATS = [
    // FIX 1 (also applied here): same "and\b" branch
    { label: 'Program Management',      fn: n => /program management.*(oper|&|and\b)/i.test(n) },
    { label: 'Program Objectives',      fn: n => /attainment|objectives/i.test(n) },
    { label: 'Content Relevance',       fn: n => /delivery of content/i.test(n) },
    { label: 'Food and Training Venue', fn: n => /venue|meal/i.test(n) },
];

const _SPK_CRITERIA = [
    'Knowledgeable of the topic and well organized',
    'The Resource Person was well prepared',
    'Materials and presentations were relevant',
    'Start and end on time',
    'The Resource Speaker was engaging and supportive',
    'The Resource Speaker demonstrated a clear understanding of the content delivered',
];

function _buildDynamicCats(baseCats, categories, columnAverages) {
    const norm = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const excluded = n => /resource speaker|feedback/i.test(String(n || ''));
    const escRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const dataRows = Array.isArray(columnAverages) ? columnAverages : [];
    const catRows = Array.isArray(categories) ? categories : [];

    const namesFromRows = new Set();
    dataRows.forEach(r => {
        const n = String(r?.category_name || r?.category || '').trim();
        if (n && !excluded(n)) namesFromRows.add(n);
    });
    catRows.forEach(r => {
        const n = String(r?.category_name || r?.name || '').trim();
        if (n && !excluded(n)) namesFromRows.add(n);
    });

    const usedNames = new Set();
    const activeBase = [];

    for (const cat of baseCats) {
        const hasCategoryRow = catRows.some(r => cat.catMatch(r.category_name || r.name || ''));
        const matchedRows = dataRows.filter(r => {
            const cName = r.category_name || r.category || '';
            const qHead = norm(r.question_header || r.question || '');
            return cat.catMatch(cName) && cat.qm.some(fn => fn(qHead));
        });
        if (hasCategoryRow || matchedRows.length) {
            activeBase.push({ ...cat });
            for (const name of namesFromRows) {
                if (cat.catMatch(name)) usedNames.add(name);
            }
        }
    }

    const dynamicCats = [];
    for (const catName of namesFromRows) {
        if (usedNames.has(catName)) continue;

        const qRows = dataRows
            .filter(r => norm(r.category_name || r.category || '') === norm(catName))
            .sort((a, b) => (Number(a.sort_order) || 999999) - (Number(b.sort_order) || 999999));

        const qNames = [];
        const seen = new Set();
        for (const row of qRows) {
            const q = String(row.question_header || row.question || '').trim();
            const key = norm(q);
            if (!q || seen.has(key)) continue;
            seen.add(key);
            qNames.push(q);
        }

        if (!qNames.length) continue;

        const qm = qNames.map(q => {
            const rx = new RegExp(escRx(norm(q)), 'i');
            return h => rx.test(norm(h));
        });

        dynamicCats.push({
            key: norm(catName).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'dynamic',
            nq: qNames.length,
            header: String(catName).toUpperCase(),
            catMatch: n => norm(n).startsWith(norm(catName)),
            questions: qNames,
            qm,
        });
    }

    return [...activeBase, ...dynamicCats];
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function exportConsolidatedToExcel() {
    if (!State.workshopData) {
        showAlert('error', 'No program loaded. Open a program first.');
        return;
    }
    const btn = document.querySelector('.btn-export-consolidated');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Building…'; btn.disabled = true; }

    try {
        const id       = State.workshopData.id;
        const isRecord = !!(State.isRecord || State.workshopData.is_record);
        const data     = await fetchReportData(id, null, isRecord);

        // Mirror what the HTML report does: inject per-day respondent counts
        // from linked_imports into program.days so the PARTICIPANTS block shows
        // the real per-day counts (67/57/38) instead of the same split value.
        let programForExport = { ...State.workshopData };
        if (
            State.workshopData?.program_type === 'container' &&
            (State.workshopData.linked_imports || []).length > 0
        ) {
            programForExport.days = State.workshopData.linked_imports.map((imp, i) => ({
                day_number:  imp.day_number  || (i + 1),
                title:       imp.day_label   || `Day ${i + 1}`,
                respondents: imp.total_responses || 0,
            }));
            // Derive total_participants from linked imports when not set on container
            if (!programForExport.total_participants) {
                const sumFromImports = State.workshopData.linked_imports
                    .reduce((s, imp) => s + (parseInt(imp.total_participants) || 0), 0);
                if (sumFromImports > 0) programForExport.total_participants = sumFromImports;
            }
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            wb,
            _buildSheet(programForExport, data),
            'CONSOLIDATED'
        );

        const safe = (State.workshopData.title || 'program')
            .replace(/[^a-zA-Z0-9 \-_]/g, '').trim().replace(/\s+/g, '_').slice(0, 50);
        XLSX.writeFile(wb, `Consolidated_${safe}_${new Date().toISOString().slice(0,10)}.xlsx`, { cellStyles: true });
        showAlert('success', 'Consolidated Excel exported.');
    } catch (e) {
        console.error(e);
        showAlert('error', 'Export failed: ' + (e.message || e));
    } finally {
        if (btn) { btn.innerHTML = orig; btn.disabled = false; }
    }
}

// ── Main sheet builder ────────────────────────────────────────────────────────
function _buildSheet(program, reportData) {
    // FIX 8: null-safety guard on destructured fields
    const {
        categories      = [],
        columnAverages  = [],
        speakerAverages = [],
        totalRespondents,
    } = reportData || {};

    const ws = {};
    const merges = [];

    // ── micro-helpers ─────────────────────────────────────────────────────────
    const norm  = s => (s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
    const r2    = v  => { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n*100)/100; };
    const CATS  = _buildDynamicCats(_CATS, categories, columnAverages);

    let _maxR = 0, _maxC = 0;
    const W = (r, c, v, s) => {
        const addr = XLSX.utils.encode_cell({r, c});
        const isNum = typeof v === 'number';
        ws[addr] = { v: v ?? '', t: isNum ? 'n' : (v==null||v==='' ? 'z' : 's'), s: s||{} };
        if (_maxR < r) _maxR = r;
        if (_maxC < c) _maxC = c;
    };
    // WF: write a cell with an Excel formula (cached value v for display)
    const WF = (r, c, formula, v, s) => {
        const addr = XLSX.utils.encode_cell({r, c});
        ws[addr] = { f: formula, v: v ?? 0, t: 'n', s: s||{} };
        if (_maxR < r) _maxR = r;
        if (_maxC < c) _maxC = c;
    };
    // enc: shorthand to get A1-style address from (row, col)
    const enc = (r, c) => XLSX.utils.encode_cell({r, c});
    const M = (r1, r2, c1, c2) => merges.push({s:{r:r1,c:c1},e:{r:r2,c:c2}});

    // ── style factory ─────────────────────────────────────────────────────────
    const F = (bold, sz, rgb) => ({
        name: 'Calibri', bold: !!bold, sz: sz||10,
        ...(rgb ? {color:{rgb}} : {})
    });
    const A = (h, v, wrap, rot) => ({
        horizontal: h||'left', vertical: v||'center',
        wrapText: !!wrap, ...(rot?{textRotation:rot}:{})
    });
    const BG = rgb => ({ patternType:'solid', fgColor:{rgb} });
    const BD = (...sides) => {
        const t = {style:'thin', color:{rgb:'FF999999'}};
        const b = {};
        if (!sides.length || sides.includes('t')) b.top    = t;
        if (!sides.length || sides.includes('b')) b.bottom = t;
        if (!sides.length || sides.includes('l')) b.left   = t;
        if (!sides.length || sides.includes('r')) b.right  = t;
        return b;
    };
    const BDB = (rgb) => {
        const t = {style:'thin', color:{rgb: rgb||'FF000000'}};
        return { top:t, bottom:t, left:t, right:t };
    };

    // ── Styles matching screenshot design ────────────────────────────────────
    const S = {
        // ── Row 1: section headers — bold, no fill, centered, wrapped
        secHdr:    { font:F(true,11),  alignment:A('center','center',true),
                     border:{ bottom:{style:'medium',color:{rgb:'FF000000'}} } },

        // ── Row 2: question sub-headers — small, wrapped, top-aligned, light gray bg
        qHdr:      { font:F(false,9),  alignment:A('center','top',true),
                     fill:BG('FFF2F2F2'),
                     border:BD() },

        // ── TRANSPOSED column header — dark gray, white rotated text
        transposed:{ font:F(true,9,'FFFFFFFF'), alignment:A('center','center',false,90),
                     fill:BG('FF595959'), border:BD() },

        // ── Day score rows
        rowLbl:    { font:F(true,10),  alignment:A('left','center'), fill:BG('FFE8E8E8') },
        score:     { font:F(false,10), alignment:A('center','center'), numFmt:'0.00', border:BD() },
        scoreBold: { font:F(true,10),  alignment:A('center','center'), numFmt:'0.00', border:BD() },

        // ── TRANSPOSED score cells per day
        tScore1:   { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF595959'), numFmt:'0.00', border:BD() },
        tScore2:   { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF404040'), numFmt:'0.00', border:BD() },
        tScore3:   { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF808080'), numFmt:'0.00', border:BD() },

        // ── Row 6: italic averages — cream/yellow background
        avgScore:  { font:{name:'Calibri',italic:true,bold:true,sz:10},
                     alignment:A('center','center'), fill:BG('FFFFFDE7'), numFmt:'0.00', border:BD() },
        avgTransp: { font:{name:'Calibri',italic:true,bold:true,sz:10,color:{rgb:'FFFFFFFF'}},
                     alignment:A('center','center'), fill:BG('FF757575'), numFmt:'0.00', border:BD() },

        // ── Row 7: TOTAL AVE. — gray label, dark TRANSPOSED scores
        totLbl:    { font:F(true,10),  alignment:A('left','center'),
                     fill:BG('FFD9D9D9'), border:BD() },
        totTransp: { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF404040'), numFmt:'0.00', border:BD() },

        // ── PARTICIPANTS block
        pHdr:  { font:F(true,10,'FFFFFFFF'), alignment:A('right','center'),
                 fill:BG('FF595959'), border:BDB('FF000000') },
        pVal:  { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                 fill:BG('FF595959'), border:BDB('FF000000') },
        pDayL: { font:F(false,10), alignment:A('left','center'),
                 fill:BG('FFD9D9D9'), border:BD('l','t','b') },
        pDayN: { font:F(false,10), alignment:A('center','center'),
                 fill:BG('FFD9D9D9'), border:BD('t','b'), numFmt:'0' },
        pDayP: { font:F(false,10), alignment:A('center','center'),
                 fill:BG('FFD9D9D9'), border:BD('t','b','r'), numFmt:'0.00%' },
        pDayLb:{ font:F(false,10), alignment:A('left','center'),
                 fill:BG('FFD9D9D9'), border:BD('l','b') },
        pDayNb:{ font:F(false,10), alignment:A('center','center'),
                 fill:BG('FFD9D9D9'), border:BD('b'), numFmt:'0' },
        pDayPb:{ font:F(false,10), alignment:A('center','center'),
                 fill:BG('FFD9D9D9'), border:BD('b','r'), numFmt:'0.00%' },

        // ── Speaker detail section
        spkDay:    { font:F(true,14),  alignment:A('left','center') },   // "DAY 1" large bold
        spkSub:    { font:F(true,10),  alignment:A('left','center') },   // "SPEAKER - DAY 1"
        spkName:   { font:{name:'Calibri',bold:true,italic:true,sz:11},  // Speaker name
                     alignment:A('left','center') },
        spkCritH:  { font:F(false,9),  alignment:A('center','top',true),  // criteria headers
                     fill:BG('FFF2F2F2'), border:BD() },
        spkTotLbl: { font:F(true,10),  alignment:A('left','center'),      // "TOTAL" label
                     fill:BG('FFE8E8E8') },
        spkSc:     { font:F(false,10), alignment:A('center','center'),
                     numFmt:'0.00', border:BD() },
        spkScGr:   { font:F(false,10), alignment:A('center','center'),
                     fill:BG('FFD9D9D9'), numFmt:'0.00', border:BD() },
        spkTrH:    { font:F(true,9,'FFFFFFFF'),
                     alignment:A('center','center',false,90),
                     fill:BG('FF595959'), border:BD() },                 // "TRANSPOSED" header
        spkTrCrit: { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FFB0B0B0'), numFmt:'0.00', border:BD() }, // criterion scores
        spkTrAvg:  { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF404040'), numFmt:'0.00', border:BD() }, // bold overall avg
        spkTrMain: { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                     fill:BG('FF595959'), numFmt:'0.00', border:BD() },

        // ── Speakers summary table
        ssHdr:  { font:F(true,13),  alignment:A('left','center') },
        ssColH: { font:F(true,9),   alignment:A('center','center'),
                  fill:BG('FFD9D9D9'), border:BDB('FF000000') },
        ssLbl:  { font:F(true,10),  alignment:A('left','center'),
                  border:BDB('FF999999') },
        ssLblG: { font:F(true,10),  alignment:A('left','center'),
                  fill:BG('FFD9D9D9'), border:BDB('FF999999') },
        ssSc:   { font:F(false,10), alignment:A('center','center'),
                  numFmt:'0.00', border:BDB('FF999999') },
        ssTr:   { font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                  fill:BG('FF595959'), numFmt:'0.00', border:BDB('FF000000') },
        ssTrEm: { fill:BG('FFD9D9D9'), border:BDB('FF999999') },
        ssAvgL: { font:F(true,10),  alignment:A('left','center'),
                  fill:BG('FFF2F2F2') },
        ssAvgS: { font:F(true,10),  alignment:A('center','center'),
                  numFmt:'0.00', border:BD('b') },
        ssAvgTr:{ font:F(true,10,'FFFFFFFF'), alignment:A('center','center'),
                  fill:BG('FF595959'), numFmt:'0.00', border:BDB('FF000000') },

        // ── Category ratings block
        crHdr:  { font:F(true,13),  alignment:A('left','center') },
        crTotL: { font:F(true,10),  alignment:A('right','center') },
        crSc:   { font:F(true,11),  alignment:A('center','center'),
                  fill:BG('FFD9D9D9'), numFmt:'0.00', border:BDB('FF000000') },
        crLbl:  { font:F(false,10), alignment:A('left','center'),
                  border:BD('b') },
    };

    // ── resolve days ──────────────────────────────────────────────────────────
    // Build from day_sheet fields first; fall back to program.days if empty
    let days = [...new Set([
        ...categories.map(c => c.day_sheet).filter(Boolean),
        ...speakerAverages.map(s => s.day_sheet).filter(Boolean),
    ])].sort();

    if (!days.length) {
        // No day_sheet on data — derive from program days or default to 1 day
        const progDays = program.days || [];
        if (progDays.length) {
            days = progDays.map(d => `day ${d.day_number || 1}`);
        } else {
            days = ['day 1'];
        }
    }

    // ── compute column positions ──────────────────────────────────────────────
    let colPtr = 1;
    for (const cat of CATS) {
        cat._sc = colPtr;
        cat._tc = colPtr + cat.nq;
        colPtr  = colPtr + cat.nq + 1;
    }
    const SUM_SC = colPtr;
    const SUM_TC = colPtr + 4;
    colPtr = SUM_TC + 1;

    // ── data lookup helpers ───────────────────────────────────────────────────
    // ── Resilient lookup helpers ───────────────────────────────────────────
    // columnAverages entries may or may not carry day_sheet / category_name.
    // Strategy:
    //   • If day_sheet is present on the rows, use it for day filtering.
    //   • If day_sheet is absent (single-day or all-days endpoint), treat
    //     all rows as belonging to every day (best-effort match).
    //   • category_name may also be absent — fall back to question-text-only
    //     matching when needed.

    const hasDaySheet = columnAverages.some(ca => ca.day_sheet != null);
    const hasCatName  = columnAverages.some(ca => ca.category_name != null);

    const qScore = (cat, qIdx, day) => {
        const rows = columnAverages.filter(ca => {
            const hMatch = cat.qm[qIdx](norm(ca.question_header||ca.question||''));
            if (!hMatch) return false;
            const cMatch = !hasCatName || cat.catMatch(ca.category_name||'');
            if (!cMatch) return false;
            // If API doesn't return day_sheet, treat as matching all days
            if (!hasDaySheet) return true;
            return ca.day_sheet === day;
        });
        return rows.length ? r2(rows[0].average_score) : null;
    };

    const catAvg = (cat, day) => {
        // First try categories array (has day_sheet reliably)
        const row = categories.find(c =>
            cat.catMatch(c.category_name||c.name||'') &&
            (day ? c.day_sheet===day : c.is_overall==1||c.day_sheet==null)
        );
        if (row) return r2(row.average_score);
        // Fallback: compute from columnAverages for this cat
        if (day || !hasDaySheet) {
            const rows = columnAverages.filter(ca => {
                const cMatch = !hasCatName || cat.catMatch(ca.category_name||'');
                const hMatch = cat.qm.some(fn => fn(norm(ca.question_header||ca.question||'')));
                const dMatch = !hasDaySheet || !day || ca.day_sheet === day;
                return cMatch && hMatch && dMatch;
            });
            if (!rows.length) return null;
            return r2(rows.reduce((s,r)=>s+parseFloat(r.average_score||0),0)/rows.length);
        }
        return null;
    };

    const qAvgAllDays = (cat, qIdx) => {
        const rows = columnAverages.filter(ca => {
            const hMatch = cat.qm[qIdx](norm(ca.question_header||ca.question||''));
            if (!hMatch) return false;
            return !hasCatName || cat.catMatch(ca.category_name||'');
        });
        if (!rows.length) return null;
        return r2(rows.reduce((s,r)=>s+parseFloat(r.average_score||0),0)/rows.length);
    };

    const overallCats = categories.filter(c => c.is_overall==1 || c.day_sheet==null);

    // ════════════════════════════════════════════════════════════════════════
    // ROW 1 (r=0): Category section headers
    // ════════════════════════════════════════════════════════════════════════
    for (const cat of CATS) {
        W(0, cat._sc, cat.header, S.secHdr);
        if (cat.nq > 1) M(0, 0, cat._sc, cat._sc + cat.nq - 1);
    }
    W(0, SUM_SC, 'SUMMARY RATINGS', S.secHdr);
    M(0, 0, SUM_SC, SUM_SC + 3);

    // ════════════════════════════════════════════════════════════════════════
    // ROW 2 (r=1): Question sub-headers + TRANSPOSED dark cells
    // ════════════════════════════════════════════════════════════════════════
    for (const cat of CATS) {
        for (let qi = 0; qi < cat.nq; qi++) W(1, cat._sc+qi, cat.questions[qi], S.qHdr);
        W(1, cat._tc, 'TRANSPOSED', S.transposed);
        // No downward merge — each day row writes its own dark score cell
    }
    for (let si = 0; si < 4; si++) W(1, SUM_SC+si, _SUMMARY_CATS[si].label, S.qHdr);
    W(1, SUM_TC, 'TRANSPOSED', S.transposed);

    // ════════════════════════════════════════════════════════════════════════
    // ROWS 3-5 (r=2..4): DAY 1 / DAY 2 / DAY 3
    // ════════════════════════════════════════════════════════════════════════
    const NUM_DAY_ROWS = Math.max(days.length, 1);
    for (let di = 0; di < NUM_DAY_ROWS; di++) {
        const r   = 2 + di;
        const day = days[di] || null;
        const lbl = day ? day.toUpperCase() : `DAY ${di+1}`;

        W(r, 0, lbl, S.rowLbl);

        for (const cat of CATS) {
            if (day) {
                for (let qi = 0; qi < cat.nq; qi++) {
                    const v = qScore(cat, qi, day);
                    if (v != null) W(r, cat._sc+qi, v, S.score);
                }
                // TRANSPOSED = AVERAGE of all question columns for this row
                const sc1 = enc(r, cat._sc);
                const sc2 = enc(r, cat._sc + cat.nq - 1);
                const ca  = catAvg(cat, day);
                WF(r, cat._tc, `AVERAGE(${sc1}:${sc2})`, ca ?? 0, S.tScore1);
            }
        }

        if (day) {
            for (let si = 0; si < 4; si++) {
                const isFnV = si === 3;
                if (isFnV) {
                    const venueRow = categories.find(c => /^venue/i.test((c.category_name||c.name||'').trim()) && (!hasDaySheet || c.day_sheet===day));
                    const mealRow  = categories.find(c => /^meal/i.test((c.category_name||c.name||'').trim()) && (!hasDaySheet || c.day_sheet===day));
                    const vals = [venueRow, mealRow].filter(Boolean).map(c => parseFloat(c.average_score));
                    if (vals.length) W(r, SUM_SC+si, r2(vals.reduce((a,b)=>a+b,0)/vals.length), S.score);
                } else {
                    const row = categories.find(c =>
                        _SUMMARY_CATS[si].fn(c.category_name||c.name||'') && (!hasDaySheet || c.day_sheet===day)
                    );
                    if (row) W(r, SUM_SC+si, r2(row.average_score), S.score);
                }
            }
            // Summary TRANSPOSED = AVERAGE of all 4 summary cols for this row
            {
                const s1 = enc(r, SUM_SC);
                const s2 = enc(r, SUM_SC + 3);
                const dc = categories.filter(c => !hasDaySheet || c.day_sheet===day);
                const da = dc.length ? dc.reduce((s,c)=>s+parseFloat(c.average_score||0),0)/dc.length : 0;
                WF(r, SUM_TC, `AVERAGE(${s1}:${s2})`, da, S.tScore1);
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // ROW 6 (r=5): Italic column averages on cream background
    // ════════════════════════════════════════════════════════════════════════
    for (const cat of CATS) {
        for (let qi = 0; qi < cat.nq; qi++) {
            const v = qAvgAllDays(cat, qi);
            if (v != null) W(5, cat._sc+qi, v, S.avgScore);
        }
        // Avg TRANSPOSED = AVERAGE of question avg cells in this row
        const ov = catAvg(cat, null);
        {
            const a1 = enc(5, cat._sc);
            const a2 = enc(5, cat._sc + cat.nq - 1);
            WF(5, cat._tc, `AVERAGE(${a1}:${a2})`, ov ?? 0, S.avgTransp);
        }
    }
    for (let si = 0; si < 4; si++) {
        const isFnV = si === 3;
        if (isFnV) {
            const rows = categories.filter(c => /venue|meal/i.test(c.category_name||c.name||''));
            if (rows.length) {
                W(5, SUM_SC+si, r2(rows.reduce((s,c)=>s+parseFloat(c.average_score||0),0)/rows.length), S.avgScore);
            }
        } else {
            const rows = categories.filter(c => _SUMMARY_CATS[si].fn(c.category_name||c.name||''));
            if (rows.length) {
                W(5, SUM_SC+si, r2(rows.reduce((s,c)=>s+parseFloat(c.average_score||0),0)/rows.length), S.avgScore);
            }
        }
    }
    {
        const grand = overallCats.length
            ? overallCats.reduce((s,c)=>s+parseFloat(c.average_score||0),0)/overallCats.length : 0;
        const a1 = enc(5, SUM_SC);
        const a2 = enc(5, SUM_SC + 3);
        WF(5, SUM_TC, `AVERAGE(${a1}:${a2})`, r2(grand) ?? 0, S.avgTransp);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ROW 7 (r=6): TOTAL AVE.
    // ════════════════════════════════════════════════════════════════════════
    W(6, 0, 'TOTAL AVE.', S.totLbl);
    for (const cat of CATS) {
        const ov = catAvg(cat, null);
        // TOTAL TRANSPOSED = AVERAGE of all day TRANSPOSED cells for this category
        const dayTrCells = days.map((_, di) => enc(2 + di, cat._tc)).join(',');
        const formula = dayTrCells ? `AVERAGE(${dayTrCells})` : enc(5, cat._tc);
        WF(6, cat._tc, formula, ov ?? 0, S.totTransp);
    }
    {
        const grand = overallCats.length
            ? overallCats.reduce((s,c)=>s+parseFloat(c.average_score||0),0)/overallCats.length : 0;
        const dayTrCells = days.map((_, di) => enc(2 + di, SUM_TC)).join(',');
        const formula = dayTrCells ? `AVERAGE(${dayTrCells})` : enc(5, SUM_TC);
        WF(6, SUM_TC, formula, r2(grand) ?? 0, S.totTransp);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ROWS 10-13 (r=9..12): PARTICIPANTS bordered block
    // ════════════════════════════════════════════════════════════════════════
    // FIX: prefer program.total_participants (the actual enrolled headcount, e.g. 70)
    // over totalRespondents (which sums all per-day responses and over-counts, e.g. 67+57+38=162).
    const totalP = parseInt(program.total_participants || totalRespondents || 0);

    W(9, 0, 'PARTICIPANTS', S.pHdr);
    M(9, 9, 0, 1);
    W(9, 2, totalP, S.pVal);
    M(9, 9, 2, 3);

    // Build a map of day_sheet → respondent count from program.days,
    // mirroring exactly what the HTML preview does (programs.js line ~3848).
    const progDays = program.days || [];
    const hasPerDayCounts = progDays.some(d => d.respondents != null && d.respondents > 0);

    for (let di = 0; di < days.length; di++) {
        const r   = 10 + di;
        const day = days[di] || null;
        const lbl = day ? day.toUpperCase() : `DAY ${di+1}`;

        let cnt = 0;

        // 1. Use program.days[i].respondents — the same source the HTML report uses
        if (hasPerDayCounts && progDays[di]) {
            cnt = progDays[di].respondents || 0;
        }
        // 2. Fall back to n_responses on columnAverages (same as before)
        if (!cnt && day && hasDaySheet) {
            const pmtRow = columnAverages.find(c =>
                c.day_sheet === day &&
                /program management team/i.test(c.category_name || '')
            );
            const anyRow = columnAverages.find(c => c.day_sheet === day);
            cnt = pmtRow?.n_responses || anyRow?.n_responses || 0;
        }
        // 3. Last resort: split total evenly
        if (!cnt) {
            cnt = days.length > 0
                ? Math.round((parseInt(totalRespondents) || 0) / days.length)
                : (parseInt(totalRespondents) || 0);
        }

        const pct  = totalP > 0 ? cnt / totalP : 0;
        const last = di === days.length - 1;

        W(r, 0, lbl, last ? S.pDayLb : S.pDayL);
        W(r, 1, cnt, last ? S.pDayNb : S.pDayN);
        W(r, 2, pct, last ? S.pDayPb : S.pDayP);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ROWS 17+ (r=16..): Per-day speaker sections — side by side at col 0
    // ════════════════════════════════════════════════════════════════════════
    const SPK_W    = _SPK_CRITERIA.length + 2;  // TOTAL col + criteria cols + TRANSPOSED col
    const SPK_ROWS = _SPK_CRITERIA.length + 4;  // name + header + TOTAL + nCrit + avg + gap
    const R_SPK_TOP = 16;

    // Criterion score lookup — tries sp.criteria first, then falls back to
    // columnAverages token matching (same strategy as the HTML preview report)
    const _spkTokens = [
        'knowledgeable of the topic',
        'resource person was well prepared',
        'materials and presentations were relevant',
        'start and end on time',
        'engaging and supportive',
        'clear understanding of the content',
    ];
    const getSpkScore = (spk, ci) => {
        const crit = (spk.criteria || []).find(c =>
            norm(c.criterion_label) === norm(_SPK_CRITERIA[ci])
        );
        if (crit) { const v = r2(crit.average_score); if (v != null) return v; }

        const token  = _spkTokens[ci] || '';
        const slot   = spk.slot_number || 1;
        const suffix = slot === 1 ? '' : String(slot);
        const day    = spk.day_sheet;
        const col = columnAverages.find(ca => {
            const h = norm(ca.question_header || ca.question || '');
            if (!h.includes(token)) return false;
            if (day && hasDaySheet && ca.day_sheet !== day) return false;
            const endsDigit = /\d$/.test(h);
            if (suffix === '') return !endsDigit || h.endsWith('1');
            return h.endsWith(suffix);
        });
        return col ? r2(col.average_score) : null;
    };

    for (let di = 0; di < days.length; di++) {
        const day    = days[di];
        const dayLbl = day.toUpperCase();
        const blockSC = di * SPK_W;
        const critSC  = blockSC + 1;
        const tCol    = critSC + _SPK_CRITERIA.length;

        const daySpks = speakerAverages
            .filter(s => s.day_sheet === day)
            .sort((a,b) => (a.slot_number||0) - (b.slot_number||0));

        W(R_SPK_TOP,     blockSC, dayLbl, S.spkDay);
        M(R_SPK_TOP, R_SPK_TOP, blockSC, tCol);

        W(R_SPK_TOP + 1, blockSC, `SPEAKER - ${dayLbl}`, S.spkSub);
        M(R_SPK_TOP + 1, R_SPK_TOP + 1, blockSC, tCol);

        for (let si = 0; si < daySpks.length; si++) {
            const spk = daySpks[si];
            const rB  = R_SPK_TOP + 2 + si * SPK_ROWS;

            W(rB, blockSC, spk.speaker_name || 'NAME', S.spkName);
            M(rB, rB, blockSC, tCol);

            for (let ci = 0; ci < _SPK_CRITERIA.length; ci++) {
                W(rB + 1, critSC + ci, _SPK_CRITERIA[ci], S.spkCritH);
            }
            // TRANSPOSED header — merged over criterion rows only (NOT avg row)
            W(rB + 1, tCol, 'TRANSPOSED', S.spkTrH);
            M(rB + 1, rB + 1 + _SPK_CRITERIA.length - 1, tCol, tCol);

            W(rB + 2, blockSC, 'TOTAL', S.spkTotLbl);

            for (let ci = 0; ci < _SPK_CRITERIA.length; ci++) {
                const v = getSpkScore(spk, ci);
                if (v != null) W(rB + 2, critSC + ci, v, S.spkSc);
            }

            for (let ci = 0; ci < _SPK_CRITERIA.length; ci++) {
                const v = getSpkScore(spk, ci);
                WF(rB + 2 + ci, tCol, enc(rB + 2, critSC + ci), v ?? 0, ci === 0 ? S.spkTrMain : S.spkTrCrit);
            }
            {
                const c1 = enc(rB + 2, critSC);
                const c2 = enc(rB + 2, critSC + _SPK_CRITERIA.length - 1);
                const overall = r2(spk.overall_avg) ?? 0;
                WF(rB + 2 + _SPK_CRITERIA.length, tCol, `IFERROR(AVERAGE(${c1}:${c2}),0)`, overall, S.spkTrAvg);
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SPEAKERS SUMMARY TABLE
    // ════════════════════════════════════════════════════════════════════════
    const pmtCat  = CATS.find(c => c.key === 'pmt') || CATS[CATS.length - 1] || { _tc: SUM_TC };
    const SS_COL  = pmtCat._tc + 2;
    const SS_TCOL = SS_COL + 1 + days.length;
    const R_SS    = R_SPK_TOP - 2;

    W(R_SS, SS_COL, 'SPEAKERS', S.ssHdr);

    W(R_SS + 1, SS_COL, '', S.ssColH);
    for (let di = 0; di < days.length; di++) {
        W(R_SS + 1, SS_COL + 1 + di, days[di].toUpperCase(), S.ssColH);
    }
    W(R_SS + 1, SS_TCOL, 'TRANSPOSED', S.ssTr);

    const maxSlot   = speakerAverages.length ? Math.max(...speakerAverages.map(s => s.slot_number||0)) : 0;
    const showSlots = Math.max(maxSlot, 6);

    for (let si = 1; si <= showSlots; si++) {
        const r      = R_SS + 2 + (si - 1);
        const hasAny = speakerAverages.some(s => s.slot_number === si);
        W(r, SS_COL, `SPEAKER ${si}`, hasAny ? S.ssLbl : S.ssLblG);

        for (let di = 0; di < days.length; di++) {
            const spk = speakerAverages.find(s => s.day_sheet === days[di] && s.slot_number === si);
            if (spk) W(r, SS_COL + 1 + di, r2(spk.overall_avg), S.ssSc);
        }
        // TRANSPOSED = AVERAGE of day score cells for this speaker slot
        {
            const dayCells = days.map((_, di) => enc(r, SS_COL + 1 + di)).join(',');
            const spkAvgs = speakerAverages.filter(s => s.slot_number === si);
            const avg = spkAvgs.length
                ? spkAvgs.reduce((s,x)=>s+parseFloat(x.overall_avg||0),0)/spkAvgs.length : 0;
            if (dayCells && hasAny) {
                WF(r, SS_TCOL, `AVERAGE(${dayCells})`, r2(avg) ?? 0, S.ssTr);
            } else {
                W(r, SS_TCOL, null, S.ssTrEm);
            }
        }
    }

    const rAvg = R_SS + 2 + showSlots;
    W(rAvg, SS_COL, 'AVERAGE:', S.ssAvgL);
    for (let di = 0; di < days.length; di++) {
        const ds = speakerAverages.filter(s => s.day_sheet === days[di]);
        if (ds.length) {
            const avg = ds.reduce((s,x)=>s+parseFloat(x.overall_avg||0),0)/ds.length;
            W(rAvg, SS_COL + 1 + di, r2(avg), S.ssAvgS);
        }
    }
    if (speakerAverages.length) {
        const gAvg = speakerAverages.reduce((s,x)=>s+parseFloat(x.overall_avg||0),0)/speakerAverages.length;
        // AVERAGE of all speaker day columns
        const dayCells = days.map((_, di) => enc(rAvg, SS_COL + 1 + di)).join(',');
        if (dayCells) {
            WF(rAvg, SS_TCOL, `AVERAGE(${dayCells})`, r2(gAvg) ?? 0, S.ssAvgTr);
        } else {
            W(rAvg, SS_TCOL, r2(gAvg), S.ssAvgTr);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // CATEGORY RATINGS block
    // ════════════════════════════════════════════════════════════════════════
    const CR_COL = SS_TCOL + 2;
    const R_CR   = R_SS + 1;

    W(R_CR, CR_COL,     'TOTAL AVE.:', S.crTotL);
    W(R_CR, CR_COL + 1, 'CATEGORY RATINGS', S.crHdr);

    const catRatingDefs = [
        // FIX 1 (also applied here)
        { label:'PROGRAM MANAGEMENT AND OPERATIONS', fn: n => /program management.*(oper|&|and\b)/i.test(n) },
        { label:'ATTAINMENT OF OBJECTIVES',          fn: n => /attainment|objectives/i.test(n) },
        { label:'DELIVERY OF CONTENT',               fn: n => /delivery of content/i.test(n) },
        { label:'VENUE (FOR IN-PERSON ATTENDEES ONLY)', fn: n => /^venue/i.test(n.trim()) },
        { label:'MEAL (FOR IN-PERSON ATTENDEES)',    fn: n => /^meal/i.test(n.trim()) },
        { label:'RESOURCE PERSON (IF ANY)',          fn: null },
        { label:'PROGRAM MANAGEMENT TEAM',           fn: n => /program management team/i.test(n) },
    ];

    const spkGrandAvg = speakerAverages.length
        ? speakerAverages.reduce((s,x)=>s+parseFloat(x.overall_avg||0),0)/speakerAverages.length
        : null;

    for (let ci = 0; ci < catRatingDefs.length; ci++) {
        const r  = R_CR + 1 + ci;
        const cd = catRatingDefs[ci];
        let avg;
        if (!cd.fn) {
            avg = spkGrandAvg;
        } else {
            const row = categories.find(c =>
                cd.fn(c.category_name||c.name||'') && (c.is_overall==1 || c.day_sheet==null)
            );
            avg = row ? parseFloat(row.average_score) : null;
        }
        if (avg != null) W(r, CR_COL,     r2(avg), S.crSc);
        W(r, CR_COL + 1, cd.label, S.crLbl);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Finalize
    // ════════════════════════════════════════════════════════════════════════
    // FIX 3: ws['!ref'] now uses the actual _maxR/_maxC tracked by W(),
    // which covers speaker detail rows, summary table, and category ratings
    // — all of which write cells well beyond the category score rows.
    ws['!ref']    = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:_maxR+2, c:_maxC+1}});
    ws['!merges'] = merges;

    // Column widths
    const colW = [{ wch:10 }];  // col A: day labels
    for (const cat of CATS) {
        for (let qi = 0; qi < cat.nq; qi++) colW.push({ wch:13 });
        colW.push({ wch:5 });   // TRANSPOSED col
    }
    for (let i = 0; i < 4; i++) colW.push({ wch:13 });
    colW.push({ wch:5 });       // Summary TRANSPOSED
    for (let i = 0; i < 3 * SPK_W + 20; i++) colW.push({ wch:13 });
    ws['!cols'] = colW;

    // Row heights
    const rowH = [
        { hpt:30 },   // row 1: section headers
        { hpt:90 },   // row 2: question headers (tall for wrapped text)
    ];
    for (let i = 2; i <= 6; i++) rowH.push({ hpt:18 });  // day rows + avg + total
    for (let i = 7; i <= _maxR + 2; i++) rowH.push({ hpt:18 });

    // FIX 4: set criteria-header row height for EVERY speaker in EVERY day,
    // not just the first speaker of day 1.
    for (let di = 0; di < days.length; di++) {
        const daySpks = speakerAverages.filter(s => s.day_sheet === days[di]);
        for (let si = 0; si < daySpks.length; si++) {
            const critHdrRow = R_SPK_TOP + 2 + si * SPK_ROWS + 1;
            rowH[critHdrRow] = { hpt:72 };
        }
    }

    ws['!rows'] = rowH;

    return ws;
}