// ═══════════════════════════════════════════════════════════════════════════
//  multi-program-report.js  —  v3 (field-name corrected)
//
//  Depends on programs.js globals:
//    State.allPrograms, SIGNATORIES, fetchReportData, loadRatingScales,
//    formatDate, showAlert, escapeHtml, docx (CDN global), CONFIG.API_URL
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1. MODAL HTML ────────────────────────────────────────────────────────
function _injectMultiReportModal() {
    if (document.getElementById('multiProgramReportModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
    <div id="multiProgramReportModal"
         style="display:none;position:fixed;inset:0;z-index:9999;
                background:rgba(0,0,0,.45);align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:12px;width:680px;max-width:95vw;
                  max-height:90vh;display:flex;flex-direction:column;
                  box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;">

        <div style="padding:20px 24px 16px;border-bottom:1px solid #e5e7eb;
                    display:flex;align-items:center;justify-content:space-between;">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#111827;">
              <i class="fa-solid fa-file-word" style="color:#2563eb;margin-right:8px;"></i>
              Export Combined Word Report
            </h3>
            <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">
              Select the programs to include. They will appear in the order selected.
            </p>
          </div>
          <button onclick="closeMultiProgramReportModal()"
                  style="background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;">&times;</button>
        </div>

        <div style="padding:12px 24px;border-bottom:1px solid #f3f4f6;
                    display:flex;align-items:center;gap:10px;">
          <input id="mprSearch" type="text" placeholder="Search programs…"
                 oninput="filterMultiProgramList()"
                 style="flex:1;padding:8px 12px;border:1.5px solid #d1d5db;
                        border-radius:8px;font-size:13px;outline:none;">
          <label style="font-size:13px;color:#374151;white-space:nowrap;cursor:pointer;">
            <input type="checkbox" id="mprSelectAll" onchange="toggleSelectAllPrograms(this)">
            &nbsp;Select all
          </label>
          <span id="mprCount" style="font-size:12px;color:#6b7280;white-space:nowrap;">0 selected</span>
        </div>

        <div id="mprList" style="flex:1;overflow-y:auto;padding:8px 16px;min-height:120px;">
        </div>

        <div style="padding:16px 24px;border-top:1px solid #e5e7eb;
                    display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span id="mprStatus" style="font-size:13px;color:#6b7280;"></span>
          <div style="display:flex;gap:10px;">
            <button onclick="closeMultiProgramReportModal()"
                    style="padding:9px 20px;border:1.5px solid #d1d5db;border-radius:8px;
                           background:#fff;color:#374151;font-size:14px;font-weight:600;cursor:pointer;">
              Cancel
            </button>
            <button id="mprExportBtn" onclick="exportMultiProgramWordReport()"
                    style="padding:9px 20px;border:none;border-radius:8px;
                           background:#1d4ed8;color:#fff;font-size:14px;font-weight:600;
                           cursor:pointer;display:flex;align-items:center;gap:7px;">
              <i class="fa-solid fa-download"></i> Export Word
            </button>
          </div>
        </div>

      </div>
    </div>`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _injectMultiReportModal);
} else {
    _injectMultiReportModal();
}

// ─── 2. OPEN / CLOSE / FILTER ─────────────────────────────────────────────
let _mprAllPrograms = [];
let _mprSelectedOrder = [];

/** Shows a polished empty-state inside the modal when no programs are loaded. */
function _showMultiReportEmptyState(modal) {
    // Replace the modal's inner content with an empty-state panel
    const box = modal.querySelector('div');
    if (!box) return;

    box.innerHTML = `
        <div style="
            padding: 20px 24px 16px;
            border-bottom: 1px solid #e5e7eb;
            display: flex;
            align-items: center;
            justify-content: space-between;">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#111827;">
              <i class="fa-solid fa-file-word" style="color:#2563eb;margin-right:8px;"></i>
              Export Combined Word Report
            </h3>
          </div>
          <button onclick="closeMultiProgramReportModal()"
                  style="background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;">&times;</button>
        </div>

        <div style="
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 48px 32px;
            text-align: center;
            gap: 0;">

          <!-- Animated icon container -->
          <div style="
              position: relative;
              width: 88px;
              height: 88px;
              margin-bottom: 24px;">
            <div style="
                position: absolute;
                inset: 0;
                border-radius: 50%;
                background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
                animation: mpr-pulse 2.2s ease-in-out infinite;"></div>
            <div style="
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;">
              <i class="fa-solid fa-folder-open"
                 style="font-size: 36px; color: #93c5fd;"></i>
            </div>
          </div>

          <!-- Heading -->
          <p style="
              margin: 0 0 10px;
              font-size: 17px;
              font-weight: 700;
              color: #1e293b;
              letter-spacing: -0.01em;">
            No Programs Available
          </p>

          <!-- Sub-text -->
          <p style="
              margin: 0 0 28px;
              font-size: 13.5px;
              color: #64748b;
              max-width: 320px;
              line-height: 1.65;">
            There are no programs loaded yet. Add or import programs first, then come back to generate a combined report.
          </p>

          <!-- Action chips -->
          <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;">
            <button
              onclick="closeMultiProgramReportModal(); openProgramModal('create');"
              style="
                display: inline-flex;
                align-items: center;
                gap: 7px;
                padding: 10px 20px;
                background: #1d4ed8;
                color: #fff;
                border: none;
                border-radius: 8px;
                font-size: 13.5px;
                font-weight: 600;
                cursor: pointer;
                transition: background .18s, transform .15s, box-shadow .15s;"
              onmouseenter="this.style.background='#1e40af';this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 14px rgba(29,78,216,.35)';"
              onmouseleave="this.style.background='#1d4ed8';this.style.transform='';this.style.boxShadow='';">
              <i class="fa-solid fa-plus"></i> Add New Program
            </button>
            <button
              onclick="closeMultiProgramReportModal();"
              style="
                display: inline-flex;
                align-items: center;
                gap: 7px;
                padding: 10px 20px;
                background: #f8fafc;
                color: #374151;
                border: 1.5px solid #e2e8f0;
                border-radius: 8px;
                font-size: 13.5px;
                font-weight: 600;
                cursor: pointer;
                transition: background .18s, transform .15s;"
              onmouseenter="this.style.background='#f1f5f9';this.style.transform='translateY(-1px)';"
              onmouseleave="this.style.background='#f8fafc';this.style.transform='';">
              <i class="fa-solid fa-xmark"></i> Close
            </button>
          </div>
        </div>

        <style>
          @keyframes mpr-pulse {
            0%, 100% { transform: scale(1);   opacity: 1;    }
            50%       { transform: scale(1.12); opacity: 0.65; }
          }
        </style>
    `;

    modal.style.display = 'flex';
}

function openMultiProgramReportModal() {
    _injectMultiReportModal(); // safe re-entrant guard

    const modal = document.getElementById('multiProgramReportModal');
    if (!modal) return;

    const programs = Array.isArray(State.allPrograms) ? State.allPrograms : [];
    if (!programs.length) {
        _showMultiReportEmptyState(modal);
        return;
    }

    _mprSelectedOrder = [];
    _mprAllPrograms = programs; // all programs — no source_type filter (field is p.source)

    const searchEl    = document.getElementById('mprSearch');
    const selectAllEl = document.getElementById('mprSelectAll');
    if (searchEl)    searchEl.value    = '';
    if (selectAllEl) selectAllEl.checked = false;

    _renderMultiProgramList(_mprAllPrograms);
    _updateMprCount();

    modal.style.display = 'flex';
    if (searchEl) searchEl.focus();
}

function closeMultiProgramReportModal() {
    const modal = document.getElementById('multiProgramReportModal');
    if (!modal) return;
    modal.style.display = 'none';
    // Re-inject the real modal structure in case the empty-state replaced it
    modal.remove();
    _injectMultiReportModal();
}

function filterMultiProgramList() {
    const q = (document.getElementById('mprSearch')?.value || '').toLowerCase().trim();
    const filtered = q
        ? _mprAllPrograms.filter(p => (p.title || '').toLowerCase().includes(q))
        : _mprAllPrograms;
    _renderMultiProgramList(filtered);
}

function _renderMultiProgramList(programs) {
    const container = document.getElementById('mprList');
    if (!container) return;

    if (!programs.length) {
        container.innerHTML = '<p style="text-align:center;color:#9ca3af;padding:24px 0;">No programs found.</p>';
        return;
    }

    container.innerHTML = programs.map(p => {
        // ── Correct field names from State.allPrograms objects ──
        const id        = p.id;                          // always p.id
        const isExcel   = p.source === 'excel';
        const isCont    = p.program_type === 'container';
        const dateStr   = p.start_date
            ? (isExcel ? p.start_date : formatDate(p.start_date))
            : '';

        const badge = isCont
            ? '<span style="font-size:10px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:10px;border:1px solid #fcd34d;">Container</span>'
            : isExcel
                ? '<span style="font-size:10px;padding:2px 7px;background:#e0f2fe;color:#0369a1;border-radius:10px;border:1px solid #7dd3fc;">Excel Import</span>'
                : '<span style="font-size:10px;padding:2px 7px;background:#d1fae5;color:#065f46;border-radius:10px;border:1px solid #6ee7b7;">System</span>';

        return `
        <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 8px;
                       border-radius:8px;cursor:pointer;transition:background .15s;"
               onmouseenter="this.style.background='#f9fafb'"
               onmouseleave="this.style.background=''">
          <input type="checkbox" class="mpr-program-check"
                 value="${id}"
                 onchange="updateMprSelectedOrder(this)"
                 style="margin-top:3px;width:15px;height:15px;cursor:pointer;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(p.title || 'Untitled')}
            </div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:3px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${badge}
              ${dateStr ? `<span>${dateStr}</span>` : ''}
              ${p.venue ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${escapeHtml(p.venue)}</span>` : ''}
            </div>
          </div>
        </label>`;
    }).join('');

    _updateMprCount();
}

function updateMprSelectedOrder(checkbox) {
    const id = checkbox.value;
    if (checkbox.checked) {
        if (!_mprSelectedOrder.includes(id)) _mprSelectedOrder.push(id);
    } else {
        _mprSelectedOrder = _mprSelectedOrder.filter(v => v !== id);
    }
    _updateMprCount();
}

function toggleSelectAllPrograms(masterCheckbox) {
    const checks = document.querySelectorAll('.mpr-program-check');
    if (!masterCheckbox.checked) {
        checks.forEach(cb => { cb.checked = false; });
        _mprSelectedOrder = [];
    } else {
        checks.forEach(cb => {
            cb.checked = true;
            if (!_mprSelectedOrder.includes(cb.value)) _mprSelectedOrder.push(cb.value);
        });
    }
    _updateMprCount();
}

function _updateMprCount() {
    const n  = document.querySelectorAll('.mpr-program-check:checked').length;
    const el = document.getElementById('mprCount');
    if (el) el.textContent = `${n} selected`;
}

// ─── 3. RESOLVE FETCH SOURCE for a program from allPrograms ───────────────
/**
 * Returns { id, isRecord, isContainerAllDays } compatible with fetchReportData().
 *
 * Rules (mirrors viewProgram + getReportDataSourceId logic):
 *  • system program  → { id: p.id,             isRecord: false }
 *  • excel import    → { id: p.eval_program_id, isRecord: true  }
 *  • container       → { id: p.id,             isRecord: false, isContainerAllDays: true }
 *                       responses.php?workshop_id=X&feedback=1 already aggregates all
 *                       linked imports and returns day_sheet on every row.
 */
async function _resolveSourceId(p) {
    const isExcel = p.source === 'excel';
    const isCont  = p.program_type === 'container';

    if (isCont) {
        return { id: p.id, isRecord: false, isContainerAllDays: true };
    }

    // Standalone program
    return { id: p.id, isRecord: false, isContainerAllDays: false };
}

// ─── 4. MAIN EXPORT ───────────────────────────────────────────────────────
async function exportMultiProgramWordReport() {
    const checkedBoxes = [...document.querySelectorAll('.mpr-program-check:checked')];
    if (!checkedBoxes.length) {
        showAlert('warning', 'Please select at least one program.');
        return;
    }

    // Build ordered list
    const checkedIds = new Set(checkedBoxes.map(cb => cb.value));
    const orderedIds = _mprSelectedOrder.filter(id => checkedIds.has(id));
    checkedBoxes.forEach(cb => { if (!orderedIds.includes(cb.value)) orderedIds.push(cb.value); });

    const programMap = {};
    (State.allPrograms || []).forEach(p => { programMap[String(p.id)] = p; });
    const selectedPrograms = orderedIds.map(id => programMap[id]).filter(Boolean);

    if (!selectedPrograms.length) {
        showAlert('error', 'Could not resolve selected programs.');
        return;
    }

    const exportBtn = document.getElementById('mprExportBtn');
    const statusEl  = document.getElementById('mprStatus');
    const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };

    if (exportBtn) { exportBtn.disabled = true; exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'; }

    try {
        const {
            Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign,
            PageBreak, Header, Footer, ImageRun, HeightRule
        } = docx;

        // ── Layout constants ──────────────────────────────────────────────
        const PAGE_W    = 12240;
        const MARGIN_L  = 1440;
        const MARGIN_R  = 1181;
        const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;   // 9619
        const DIV_W     = PAGE_W;

        const COL_NUM   = 520;
        const COL_NUM_R = 1400;
        const COL_DESC  = 2800;
        const COL_IND   = CONTENT_W - COL_NUM - COL_NUM_R - COL_DESC;

        // ── Style helpers ─────────────────────────────────────────────────
        const bdr      = (c = '000000') => ({ style: BorderStyle.SINGLE, size: 4, color: c });
        const cellBdrs = (c = '000000') => ({ top: bdr(c), bottom: bdr(c), left: bdr(c), right: bdr(c) });
        const nilBdr   = { style: BorderStyle.NIL };
        const nilBdrs  = { top: nilBdr, bottom: nilBdr, left: nilBdr, right: nilBdr };
        const hdrShd   = { fill: 'FFFFFF', type: ShadingType.CLEAR };
        const CM       = { top: 60, bottom: 60, left: 100, right: 100 };  // cell margin

        const HDR_DIV  = { style: BorderStyle.THICK_THIN_MEDIUM_GAP, size: 24, color: '000000', space: 0 };
        const FTR_DIV  = { style: BorderStyle.THIN_THICK_MEDIUM_GAP, size: 24, color: '000000', space: 0 };

        const run  = (text, opts = {}) => new TextRun({ text: String(text ?? ''), font: 'Bookman Old Style', size: 22, ...opts });
        const bRun = (text, opts = {}) => run(text, { bold: true, ...opts });
        const para = (children, opts = {}) => new Paragraph({
            children: Array.isArray(children) ? children : [run(children)],
            spacing: { after: 60 }, ...opts
        });
        const emptyPara    = () => new Paragraph({ children: [run('')], spacing: { after: 80 } });
        const sectionHead  = text => new Paragraph({
            children: [bRun(text, { size: 22 })],
            spacing: { before: 200, after: 80 },
            indent: { left: COL_NUM },
        });

        const dividerTable = edge => new Table({
            width: { size: DIV_W, type: WidthType.DXA },
            columnWidths: [DIV_W],
            alignment: AlignmentType.LEFT,
            indent: { size: -MARGIN_L, type: WidthType.DXA },
            borders: { top: nilBdr, bottom: nilBdr, left: nilBdr, right: nilBdr, insideH: nilBdr, insideV: nilBdr },
            rows: [new TableRow({
                height: { value: 80, rule: HeightRule.EXACT },
                children: [new TableCell({
                    children: [new Paragraph({ spacing: { before: 0, after: 0 } })],
                    width: { size: DIV_W, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    borders: {
                        top: nilBdr,
                        bottom: edge === 'top' ? FTR_DIV : HDR_DIV,
                        left: nilBdr, right: nilBdr,
                    },
                })],
            })],
        });

        const nilCell = children => new TableCell({
            children,
            borders: nilBdrs,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
        });

        const sigTable = () => {
            const half = Math.floor(CONTENT_W / 2);
            return new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: [half, half],
                borders: { top: nilBdr, bottom: nilBdr, left: nilBdr, right: nilBdr, insideH: nilBdr, insideV: nilBdr },
                rows: [
                    new TableRow({ children: [
                        nilCell([para('Prepared by:'), emptyPara(), para([bRun(SIGNATORIES().preparedBy.name)]), para(SIGNATORIES().preparedBy.title)]),
                        nilCell([para('Checked by:'), emptyPara(), para([bRun(SIGNATORIES().checkedBy.name)]), para(SIGNATORIES().checkedBy.title)]),
                    ]}),
                    new TableRow({ children: [new TableCell({ columnSpan: 2, children: [emptyPara(), para('Noted:')], borders: nilBdrs, margins: { top: 0, bottom: 0, left: 0, right: 0 } })] }),
                    ...SIGNATORIES().noted.map(n => new TableRow({ children: [new TableCell({
                        columnSpan: 2,
                        children: [
                            emptyPara(),
                            new Paragraph({ children: [bRun(n.name)], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
                            new Paragraph({ children: [run(n.title)], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
                        ],
                        borders: nilBdrs, margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    })] })),
                ],
            });
        };

        // ── Fetch shared assets ───────────────────────────────────────────
        setStatus('Fetching logos…');
        const fetchImg = async rel => {
            try {
                const base = window.location.pathname.replace(/\/[^/]*$/, '');
                const r = await fetch(base + rel);
                return r.ok ? await r.arrayBuffer() : null;
            } catch (_) { return null; }
        };
        const [logoData, depedData, bagongData, sdoData, emailData, fbData] = await Promise.all([
            fetchImg('/images/kagawaran-ng-edukasyon-logo.png'),
            fetchImg('/images/DepED-logo.png'),
            fetchImg('/images/bagong-pilipinas-logo.png'),
            fetchImg('/images/SDO-Seal.png'),
            fetchImg('/images/old-gmail-logo.png'),
            fetchImg('/images/Facebook-Logo-Circle-Creation-PNG.png'),
        ]);

        setStatus('Loading rating scales…');
        const scales = await loadRatingScales();

        // ── Shared header / footer ────────────────────────────────────────
        const buildHeader = () => {
            const hc = [];
            if (logoData) hc.push(new Paragraph({
                alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
                children: [new ImageRun({ type: 'png', data: logoData, transformation: { width: 70, height: 70 }, altText: { title: 'Logo', description: 'Logo', name: 'Logo' } })],
            }));
            hc.push(
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'Republic of the Philippines', font: 'Old English Text MT', size: 22 })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'Department of Education', font: 'Old English Text MT', size: 32 })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'REGION III-CENTRAL LUZON', font: 'Tahoma', size: 18, bold: true })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'SCHOOLS DIVISION OF CITY OF BALIWAG', font: 'Tahoma', size: 18, bold: true })] }),
                dividerTable('bottom'),
            );
            return hc;
        };

        const buildFooter = () => {
            const e2e = n => Math.round(n * 914400);
            const e2p = n => Math.round(n * 96);
            const ftR = (text, opts = {}) => new TextRun({ text, font: 'Carmia', size: 16, ...opts });
            const fImg = (data, type, w, h, hPos, vPos, name) => data ? new ImageRun({
                type, data,
                transformation: { width: e2p(w), height: e2p(h) },
                altText: { title: name, description: name, name: name.replace(/\s/g, '') },
                floating: {
                    horizontalPosition: { relative: 'page', offset: e2e(hPos) },
                    verticalPosition:   { relative: 'paragraph', offset: e2e(vPos) },
                    wrap: { type: 'none' }, behindDocument: false,
                },
            }) : null;
            const imgs = [
                fImg(depedData, 'png', 1.06, 0.67, 0.25, 0,    'DepEdLogo'),
                fImg(bagongData,'png', 0.73, 0.73, 1.46, 0,    'BagongPilipinas'),
                fImg(sdoData,   'png', 0.70, 0.70, 2.25, 0,    'SDOSeal'),
                fImg(emailData, 'png', 0.18, 0.14, 3.65, 0.43, 'EmailLogo'),
                fImg(fbData,    'png', 0.28, 0.22, 5.51, 0.38, 'FacebookLogo'),
            ].filter(Boolean);
            return [
                dividerTable('top'),
                new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { before: 0, after: 0 },
                    indent: { left: -1440, right: -821 },
                    children: [
                        ...imgs,
                        ftR('Baliwag North District Compound, J.Buizon St. Poblacion, City of Baliwag, Bulacan'),
                        new TextRun({ break: 1 }),
                        ftR('Telephone No: ', { bold: true }), ftR('(044) 816-6041'),
                        new TextRun({ break: 1 }), new TextRun({ break: 1 }),
                        ftR('      baliwag.city@deped.gov.ph'),
                        ftR('                    '),
                        ftR('      https://www.facebook.com/SDOCityofBaliwag'),
                    ],
                }),
            ];
        };

        // ── Shared table / cell builders ──────────────────────────────────
        const cell = (children, opts = {}) => new TableCell({
            children: Array.isArray(children) ? children : [para(children)],
            margins: CM, borders: cellBdrs(), verticalAlign: VerticalAlign.CENTER, ...opts
        });
        const hCell = (text, w) => new TableCell({
            children: [new Paragraph({ children: [bRun(text)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
            width: { size: w, type: WidthType.DXA }, shading: hdrShd,
            borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
        });

        const build3Col = (headers, rows, widths, avgRow = null) => new Table({
            width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths,
            rows: [
                new TableRow({ children: headers.map((h, i) => hCell(h, widths[i])) }),
                ...rows.map(r => new TableRow({ children: r.map((txt, i) => cell(
                    [new Paragraph({ children: [run(String(txt ?? '—'))], spacing: { after: 0 } })],
                    { width: { size: widths[i], type: WidthType.DXA } }
                )) })),
                ...(avgRow ? [new TableRow({ children: avgRow.map((txt, i) => cell(
                    [new Paragraph({ children: [bRun(String(txt ?? ''))], spacing: { after: 0 } })],
                    { width: { size: widths[i], type: WidthType.DXA } }
                )) })] : []),
            ],
        });

        const buildIndTable = (rows, type = 'category') => {
            const getInterp = (score, t) => {
                const scaleRows = scales[t] || scales['category'] || [];
                const m = scaleRows.find(r => score >= r.min && score <= r.max);
                return m ? (m.desc || m.level || '') : '';
            };
            const fmtScore = v => { const n = parseFloat(v); return (isNaN(n) || n === 0) ? '—' : n.toFixed(2); };
            const nums = rows.map(r => parseFloat(r.score)).filter(n => !isNaN(n));
            const avg  = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : '—';
            const avgD = avg !== '—' ? getInterp(parseFloat(avg), type) : '—';
            return new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: [COL_NUM, COL_IND, COL_NUM_R, COL_DESC],
                rows: [
                    new TableRow({ children: [hCell('', COL_NUM), hCell('INDICATORS', COL_IND), hCell('NUMERICAL RATING', COL_NUM_R), hCell('DESCRIPTIVE RATING', COL_DESC)] }),
                    ...rows.map((r, i) => new TableRow({ children: [
                        cell([new Paragraph({ children: [run(String(i + 1))], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: COL_NUM, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.label)], spacing: { after: 0 } })], { width: { size: COL_IND, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.score)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: COL_NUM_R, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.desc, { italics: true })], spacing: { after: 0 } })], { width: { size: COL_DESC, type: WidthType.DXA } }),
                    ]})),
                    new TableRow({ children: [
                        new TableCell({ columnSpan: 2, children: [new Paragraph({ children: [bRun('Average')], spacing: { after: 0 } })], width: { size: COL_NUM + COL_IND, type: WidthType.DXA }, borders: cellBdrs(), margins: CM }),
                        cell([new Paragraph({ children: [bRun(avg)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: COL_NUM_R, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [bRun(avgD, { italics: true })], spacing: { after: 0 } })], { width: { size: COL_DESC, type: WidthType.DXA } }),
                    ]}),
                ],
            });
        };

        const buildScaleTable = type => {
            const w1 = 1500, w2 = 4000, w3 = CONTENT_W - 5500;
            return new Table({
                width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [w1, w2, w3],
                rows: [
                    new TableRow({ children: ['Scale', 'Level of Agreement', 'Descriptive Equivalent'].map((h, i) => new TableCell({
                        children: [new Paragraph({ children: [run(h, { bold: true, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                        width: { size: [w1, w2, w3][i], type: WidthType.DXA }, shading: hdrShd, borders: cellBdrs(), margins: CM,
                    })) }),
                    ...(scales[type] || []).map(r => new TableRow({ children: [
                        `${r.min.toFixed(2)}–${r.max.toFixed(2)}`, r.level, r.desc
                    ].map((txt, i) => new TableCell({
                        children: [new Paragraph({ children: [run(txt, { italics: true })], alignment: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 0 } })],
                        width: { size: [w1, w2, w3][i], type: WidthType.DXA }, borders: cellBdrs(), margins: CM,
                    })) })),
                ],
            });
        };

        // ── Fetch all program data first ──────────────────────────────────
        const allProgramData = [];

        for (let i = 0; i < selectedPrograms.length; i++) {
            const prog = selectedPrograms[i];
            setStatus(`Fetching data ${i + 1} of ${selectedPrograms.length}: "${prog.title}"…`);
            const sourceId = await _resolveSourceId(prog);
            let data;
            try {
                data = await fetchReportData(sourceId, '', sourceId.isRecord);
            } catch (e) {
                console.warn(`fetchReportData failed for program ${prog.id}:`, e);
                data = { categories: [], columnAverages: [], speakerAverages: [], feedbackData: [], totalRespondents: 0 };
            }

            // responses.php already includes day_sheet on every feedback row (for both
            // Excel and container programs). Group the flat array into per-day buckets
            // so Section IV can render one labelled table per day.
            const allFeedbackRows = data.feedbackData || [];
            const dayMap = new Map(); // preserves insertion order = day order from API

            for (const fb of allFeedbackRows) {
                const label = (fb.day_sheet || '').trim();
                if (!dayMap.has(label)) dayMap.set(label, []);
                dayMap.get(label).push(fb);
            }

            // If only one bucket and it has no label → single-day, no sub-heading needed
            const perDayFeedback = [...dayMap.entries()].map(([label, rows]) => ({ label, rows }));
            if (perDayFeedback.length === 0) perDayFeedback.push({ label: '', rows: [] });

            data.perDayFeedback = perDayFeedback;
            allProgramData.push({ prog, data });
        }

        // ── Shared helpers operating on per-program data ──────────────────
        const normalise  = s => (s || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
        const fmtScore   = v => { const n = parseFloat(v); return (isNaN(n) || n === 0) ? '—' : n.toFixed(2); };
        const getInterp  = (score, type) => {
            const rows = scales[type] || scales['category'] || [];
            const m = rows.find(r => score >= r.min && score <= r.max);
            return m ? (m.desc || m.level || '') : '';
        };
        const getCatAvg  = (cats, cols, key) => {
            const kl  = key.trim().toLowerCase();
            const cat = cats.find(c => (c.category_name || '').trim().toLowerCase() === kl);
            if (cat?.average_score != null) return parseFloat(cat.average_score);
            const col = cols.find(c => normalise(c.question_header || '').includes(kl));
            return col ? parseFloat(col.average_score) : null;
        };

        // Collect the union of all category names across programs (preserving order)
        const allCatNamesSet = new Set();
        allProgramData.forEach(({ data }) => {
            const { categories, columnAverages } = data;
            [...categories.map(c => c.category_name), ...columnAverages.map(c => c.category_name || '')]
                .filter(n => {
                    const nl = (n || '').trim().toLowerCase();
                    return nl && nl !== 'resource speaker' && nl !== 'resource speakers' && nl !== 'feedback';
                })
                .forEach(n => allCatNamesSet.add(n.trim()));
        });
        const allCatNames = [...allCatNamesSet];

        // ── Cover page ────────────────────────────────────────────────────
        const now     = new Date();
        const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
        const coverChildren = [
            emptyPara(), emptyPara(), emptyPara(),
            new Paragraph({ children: [bRun('COMBINED QAME ANALYSIS REPORT', { size: 36, allCaps: true })], alignment: AlignmentType.CENTER, spacing: { after: 160 } }),
            new Paragraph({ children: [run(`${selectedPrograms.length} Program${selectedPrograms.length > 1 ? 's' : ''}`, { size: 24 })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
            new Paragraph({ children: [run(`Generated: ${dateStr}`, { size: 22 })], alignment: AlignmentType.CENTER, spacing: { after: 160 } }),
            ...selectedPrograms.map((p, i) => new Paragraph({ children: [run(`${i + 1}. ${p.title || 'Untitled'}`, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 60 } })),
            new Paragraph({ children: [new PageBreak()] }),
        ];

        // ── Build the combined QAME Analysis section ──────────────────────
        setStatus('Building combined document…');

        // Combined programs info table (one row per program)
        const infoColW = [300, CONTENT_W - 300];   // # | details
        const infoHeaderWidths = [300, 2400, 200, 2200, 1200, 1200, 1119];
        const infoHeaders = ['#', 'Title of Training Program', 'Proponent/s', 'Training Venue / Inclusive Dates', 'Participants', 'Responses', '%'];
        const infoRows = allProgramData.map(({ prog: p, data }, idx) => {
            const isExcel   = p.source === 'excel';
            const numPartic = parseInt(p.total_participants || p.expected_participants || 0) || 0;
            const totalResp = data.totalRespondents || 0;
            // FIX: Use pct_responses already stored by save.php (correctly accounts for
            // per-day participant counts and multi-day programmes). Only fall back to a
            // live calculation when absent — avoids '—' for standalone imports whose
            // total_participants is missing in list-view data, and avoids double-counting
            // for container programmes where numPartic × numDays ≠ unique participants.
            const storedPct = parseFloat(p.pct_responses);
            const displayRate = !isNaN(storedPct) && storedPct > 0
                ? `${Math.min(storedPct, 100).toFixed(0)}%`
                : (numPartic > 0 && totalResp > 0
                    ? `${Math.min((totalResp / numPartic) * 100, 100).toFixed(0)}%`
                    : '—');
            const s = p.start_date ? (isExcel ? p.start_date : formatDate(p.start_date)) : '';
            const e = p.end_date   ? (isExcel ? p.end_date   : formatDate(p.end_date))   : '';
            const displayDates = (!s && !e) ? '—' : ((s && e && s !== e) ? `${s} – ${e}` : (s || e));
            const venueDate = [p.venue || p.training_venue, displayDates].filter(Boolean).join(' / ') || '—';
            return [
                String(idx + 1),
                p.title || '—',
                p.proponents || '—',
                venueDate,
                numPartic > 0 ? String(numPartic) : '—',
                String(totalResp),
                displayRate,
            ];
        });
        const combinedInfoTable = new Table({
            width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: infoHeaderWidths,
            rows: [
                new TableRow({ children: infoHeaders.map((h, i) => hCell(h, infoHeaderWidths[i])) }),
                ...infoRows.map(r => new TableRow({ children: r.map((txt, i) => cell(
                    [new Paragraph({ children: [run(String(txt ?? '—'))], spacing: { after: 0 } })],
                    { width: { size: infoHeaderWidths[i], type: WidthType.DXA } }
                )) })),
            ],
        });

        // Section 1: Combined Summary of Ratings — one row per program + per-category sub-rows
        const SW = CONTENT_W - 3200, NW = 1200, DW = 2000;
        const summaryHeaderWidths = [SW, NW, DW];

        const combinedSummaryRows = allProgramData.map(({ prog: p, data }) => {
            const { categories, columnAverages } = data;
            const catScores = allCatNames.map(n => getCatAvg(categories, columnAverages, n)).filter(v => v !== null);
            const overallAvg = catScores.length ? (catScores.reduce((a, b) => a + b, 0) / catScores.length).toFixed(2) : '—';
            const overallDesc = overallAvg !== '—' ? getInterp(parseFloat(overallAvg), 'overall') : '—';
            return [p.title || '—', overallAvg, overallDesc];
        });

        // Grand overall average across all programs
        const grandScores = combinedSummaryRows.map(r => parseFloat(r[1])).filter(n => !isNaN(n));
        const grandAvg  = grandScores.length ? (grandScores.reduce((a, b) => a + b, 0) / grandScores.length).toFixed(2) : '—';
        const grandDesc = grandAvg !== '—' ? getInterp(parseFloat(grandAvg), 'overall') : '—';

        // Build expanded summary table with per-category sub-rows under each program
        const summaryTableRows = [];
        allProgramData.forEach(({ prog: p, data }, progIdx) => {
            const { categories, columnAverages } = data;
            const catScores = allCatNames.map(n => getCatAvg(categories, columnAverages, n)).filter(v => v !== null);
            const overallAvg = catScores.length ? (catScores.reduce((a, b) => a + b, 0) / catScores.length).toFixed(2) : '—';
            const overallDesc = overallAvg !== '—' ? getInterp(parseFloat(overallAvg), 'overall') : '—';

            // Program row (bold, same style as before)
            summaryTableRows.push(new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ children: [bRun(p.title || '—')], spacing: { after: 0 } })],
                        width: { size: SW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM,
                    }),
                    new TableCell({
                        children: [new Paragraph({ children: [bRun(overallAvg)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                        width: { size: NW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                    }),
                    new TableCell({
                        children: [new Paragraph({ children: [bRun(overallDesc)], spacing: { after: 0 } })],
                        width: { size: DW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                    }),
                ],
            }));

            // Per-category sub-rows (indented, normal weight)
            allCatNames.forEach(catName => {
                const raw = getCatAvg(categories, columnAverages, catName);
                const score = raw !== null ? fmtScore(raw) : '—';
                const desc  = score !== '—' ? getInterp(parseFloat(score), 'category') : '—';
                summaryTableRows.push(new TableRow({
                    children: [
                        new TableCell({
                            children: [new Paragraph({ children: [run(catName, { size: 20 })], spacing: { after: 0 }, indent: { left: 360 } })],
                            width: { size: SW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM,
                        }),
                        new TableCell({
                            children: [new Paragraph({ children: [run(score, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                            width: { size: NW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                        }),
                        new TableCell({
                            children: [new Paragraph({ children: [run(desc, { size: 20, italics: true })], spacing: { after: 0 } })],
                            width: { size: DW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                        }),
                    ],
                }));
            });
        });

        // Grand overall average row
        summaryTableRows.push(new TableRow({
            children: [
                new TableCell({
                    children: [new Paragraph({ children: [bRun('Grand Overall Average')], spacing: { after: 0 } })],
                    width: { size: SW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM,
                }),
                new TableCell({
                    children: [new Paragraph({ children: [bRun(grandAvg)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                    width: { size: NW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                }),
                new TableCell({
                    children: [new Paragraph({ children: [bRun(grandDesc)], spacing: { after: 0 } })],
                    width: { size: DW, type: WidthType.DXA }, borders: cellBdrs(), margins: CM, verticalAlign: VerticalAlign.CENTER,
                }),
            ],
        }));

        const combinedSummaryTable = new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: summaryHeaderWidths,
            rows: [
                new TableRow({
                    children: [
                        hCell('Training Program', SW),
                        hCell('Overall Average Rating', NW),
                        hCell('Descriptive Rating', DW),
                    ],
                }),
                ...summaryTableRows,
            ],
        });

        // Sections 2–N: Per-category indicator tables — each category shows all programs' indicator data
        const catSectionBlocks = allCatNames.flatMap((catName, catIdx) => {
            // Collect union of all indicator labels for this category across programs
            const allIndLabelSet = new Set();
            allProgramData.forEach(({ data }) => {
                data.columnAverages
                    .filter(c => (c.category_name || '').trim().toLowerCase() === catName.trim().toLowerCase())
                    .forEach(c => allIndLabelSet.add(c.question_header || c.question || catName));
            });
            const allIndLabels = [...allIndLabelSet];

            // Build one combined indicator table per category:
            // Rows = indicators, with sub-rows per program showing their score
            const catIndRows = [];
            allIndLabels.forEach((indLabel, iIdx) => {
                allProgramData.forEach(({ prog: p, data }) => {
                    const { categories, columnAverages } = data;
                    const col = columnAverages.find(c =>
                        (c.category_name || '').trim().toLowerCase() === catName.trim().toLowerCase() &&
                        (c.question_header || c.question || '').trim() === indLabel.trim()
                    );
                    let score, desc;
                    if (col) {
                        score = fmtScore(parseFloat(col.average_score));
                    } else {
                        const raw = getCatAvg(categories, columnAverages, catName);
                        score = raw !== null ? fmtScore(raw) : '—';
                    }
                    desc = score !== '—' ? getInterp(parseFloat(score), 'category') : '—';
                    catIndRows.push({ indicator: indLabel, program: p.title || '—', score, desc, iIdx });
                });
            });

            // Use a 5-column table: # | Indicator | Program | Score | Desc
            const C1 = COL_NUM, C2 = COL_IND - 1800, C3 = 1800, C4 = COL_NUM_R, C5 = COL_DESC;
            const catTable = new Table({
                width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [C1, C2, C3, C4, C5],
                rows: [
                    new TableRow({ children: [hCell('#', C1), hCell('INDICATOR', C2), hCell('PROGRAM', C3), hCell('NUMERICAL RATING', C4), hCell('DESCRIPTIVE RATING', C5)] }),
                    ...catIndRows.map((r, rowIdx) => new TableRow({ children: [
                        cell([new Paragraph({ children: [run(rowIdx === 0 || catIndRows[rowIdx - 1]?.iIdx !== r.iIdx ? String(r.iIdx + 1) : '')], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: C1, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(rowIdx === 0 || catIndRows[rowIdx - 1]?.iIdx !== r.iIdx ? r.indicator : '')], spacing: { after: 0 } })], { width: { size: C2, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.program, { size: 20 })], spacing: { after: 0 } })], { width: { size: C3, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.score)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: C4, type: WidthType.DXA } }),
                        cell([new Paragraph({ children: [run(r.desc, { italics: true })], spacing: { after: 0 } })], { width: { size: C5, type: WidthType.DXA } }),
                    ]})),
                ],
            });

            return [sectionHead(`${catIdx + 2}. ${catName.toUpperCase()}`), catTable, emptyPara()];
        });

        // Resource Persons section — combined across all programs, deduplicated by name
        const spkSectionNum = allCatNames.length + 2;
        const seenSpeakers = new Set();
        const combinedSpkBlocks = [];
        const combinedSpkSummaryRows = [];

        const SPEAKER_CRITERIA = [
            { label: 'Knowledgeable of the topic and well organized',      token: 'knowledgeable of the topic' },
            { label: 'The Resource Person was well prepared',               token: 'resource person was well prepared' },
            { label: 'Materials and presentations were relevant',           token: 'materials and presentations were relevant' },
            { label: 'Started and ended on time',                           token: 'start and end on time' },
            { label: 'The Resource Speaker was engaging and supportive',    token: 'engaging and supportive' },
            { label: 'Demonstrated a clear understanding of the content',   token: 'clear understanding of the content' },
        ];

        allProgramData.forEach(({ prog: p, data }) => {
            const { columnAverages, speakerAverages } = data;

            // Build getColAvgSlot helper scoped to this program's columnAverages
            const getColAvgSlot = (token, slot) => {
                const tl = token.toLowerCase();
                const col = columnAverages.find(c => {
                    const q = (c.question_header || c.question || '').toLowerCase();
                    const matchToken = q.includes(tl) || tl.split(' ').slice(0, 3).every(w => q.includes(w));
                    const matchSlot  = !c.slot_number || parseInt(c.slot_number) === slot;
                    return matchToken && matchSlot;
                });
                return col ? parseFloat(col.average_score) : null;
            };

            const sortedSpk = [...speakerAverages].sort((a, b) =>
                String(a.day_sheet || '').localeCompare(String(b.day_sheet || '')) ||
                (a.slot_number || 0) - (b.slot_number || 0)
            );

            sortedSpk.forEach((spk, idx) => {
                const spkName = (spk.speaker_name || spk.name || '').trim() || `Speaker ${idx + 1}`;
                const spkKey  = `${spkName}||${p.id}`;
                if (seenSpeakers.has(spkKey)) return;
                seenSpeakers.add(spkKey);

                const slot     = spk.slot_number || (idx + 1);
                const criteria = spk.criteria || [];

                const rows = SPEAKER_CRITERIA.map((def, ci) => {
                    let s = null;
                    if (criteria.length) {
                        const c = criteria[ci] || criteria.find(c =>
                            (c.criterion_label || '').toLowerCase().includes(def.token.slice(0, 12))
                        );
                        if (c) s = parseFloat(c.average_score);
                    }
                    if (s === null || isNaN(s)) s = getColAvgSlot(def.token, slot);
                    if (s === null || isNaN(s)) s = parseFloat(spk.overall_avg || spk.average_score || spk.avg || 0);
                    const sStr = !isNaN(s) && s > 0 ? s.toFixed(2) : '—';
                    return { label: def.label, score: sStr, desc: sStr !== '—' ? getInterp(parseFloat(sStr), 'speaker') : '—' };
                });

                const spkAvgScore = fmtScore(parseFloat(spk.overall_avg || spk.average_score || spk.avg || 0));
                combinedSpkSummaryRows.push([
                    spkName || '—',
                    p.title || '—',
                    spkAvgScore,
                    spkAvgScore !== '—' ? getInterp(parseFloat(spkAvgScore), 'speaker') : '—',
                ]);

                combinedSpkBlocks.push(
                    new Paragraph({ children: [bRun(spkName, { size: 22 })], spacing: { before: 120, after: 20 }, indent: { left: COL_NUM } }),
                    new Paragraph({ children: [run(`(${p.title || 'Program'})`, { size: 20, italics: true })], spacing: { before: 0, after: 60 }, indent: { left: COL_NUM } }),
                    buildIndTable(rows, 'speaker'),
                    emptyPara(),
                );
            });
        });

        // ── Build per-program Participant Feedback tables (QAME Analysis) ─
        const cleanFbVal = v => {
            const s = String(v || '').replace(/\s+/g, ' ').trim();
            if (!s) return '';
            if (/^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|--|-)$/i.test(s)) return '';
            if (/^\d+(\.\d+)?$/.test(s)) return '';
            if (/^[^a-zA-Z0-9]+$/.test(s)) return '';
            return s;
        };
        const isMeaningfulFb = v => cleanFbVal(v) !== '';

        // ── Dynamic column discovery (mirrors programs.js logic) ─────────────
        // Keys that are metadata, not feedback content
        const FB_SKIP_KEYS = new Set(['respondent_id', 'day_sheet', 'day', 'labels', 'id']);

        // Strip day references so "...for DAY 1..." and "...for DAY 2..." collapse to the same column
        const normFbKey = key =>
            String(key || '')
                .replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')
                .replace(/\bDAY\s+\d+\b/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

        // Build one shared column map across ALL programs so headers are consistent
        const globalRawByNorm = new Map();
        allProgramData.forEach(({ data }) => {
            for (const fb of (data.feedbackData || [])) {
                for (const rawKey of Object.keys(fb)) {
                    if (FB_SKIP_KEYS.has(rawKey)) continue;
                    const norm = rawKey.startsWith('__pos_') ? rawKey : normFbKey(rawKey);
                    if (!globalRawByNorm.has(norm)) globalRawByNorm.set(norm, []);
                    if (!globalRawByNorm.get(norm).includes(rawKey)) globalRawByNorm.get(norm).push(rawKey);
                }
            }
        });

        // Fallback: if no dynamic keys found, try the known old-schema field pairs
        if (!globalRawByNorm.size) {
            [
                ['feedback_expectations', 'expectations', 'met_expectations'],
                ['feedback_improvements', 'improvements'],
                ['feedback_insights',     'insights'],
                ['feedback_further',      'further', 'additional_training'],
            ].forEach(keys => {
                const allFb = allProgramData.flatMap(({ data }) => data.feedbackData || []);
                if (allFb.some(fb => keys.some(k => fb[k]))) globalRawByNorm.set(keys[0], keys);
            });
        }

        const fbColsMaster = [...globalRawByNorm.entries()].map(([normKey, rawKeys], i) => ({
            key: normKey,
            header: normKey.startsWith('__pos_') ? ('Feedback ' + (i + 1)) : normKey,
            value: fb => cleanFbVal(rawKeys.map(k => fb[k] || '').find(v => v) || ''),
        }));

        const buildFbTable = (rows) => {
            const activeCols = fbColsMaster.filter(col => rows.some(fb => isMeaningfulFb(col.value(fb))));
            const activeRows = rows.filter(fb => activeCols.some(col => isMeaningfulFb(col.value(fb))));
            if (!activeCols.length || !activeRows.length) return null;
            const colW = activeCols.map(() => Math.floor(CONTENT_W / activeCols.length));
            const diff = CONTENT_W - colW.reduce((a, b) => a + b, 0);
            if (diff !== 0) colW[colW.length - 1] += diff;
            return new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: colW,
                rows: [
                    new TableRow({ children: activeCols.map((col, i) => new TableCell({
                        children: [new Paragraph({ children: [bRun(col.header, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                        width: { size: colW[i], type: WidthType.DXA }, shading: hdrShd, borders: cellBdrs(), margins: CM,
                    })) }),
                    ...activeRows.map(fb => new TableRow({ children: activeCols.map((col, i) => new TableCell({
                        children: [new Paragraph({ children: [run(col.value(fb), { size: 20 })], spacing: { after: 0 } })],
                        width: { size: colW[i], type: WidthType.DXA }, borders: cellBdrs(), margins: CM,
                    })) })),
                ],
            });
        };

        const qameFeedbackBlocks = [];
        allProgramData.forEach(({ prog: p, data }) => {
            const perDayFeedback = data.perDayFeedback || [{ label: '', rows: data.feedbackData || [] }];
            const hasAny = perDayFeedback.some(({ rows }) => (rows || []).some(fb => fbColsMaster.some(col => isMeaningfulFb(col.value(fb)))));
            if (!hasAny) return;
            qameFeedbackBlocks.push(
                new Paragraph({ children: [bRun(p.title || 'Untitled', { size: 22 })], spacing: { before: 160, after: 60 } })
            );
            perDayFeedback.forEach(({ label, rows }) => {
                if (!rows || !rows.length) return;
                const tbl = buildFbTable(rows);
                if (!tbl) return;
                if (label) {
                    qameFeedbackBlocks.push(
                        new Paragraph({ children: [bRun(label, { size: 21, italics: true })], spacing: { before: 80, after: 40 }, indent: { left: 360 } })
                    );
                }
                qameFeedbackBlocks.push(tbl, emptyPara());
            });
        });

        // ── Derive Section IV highlight bullets from real feedback data ────────
        // Helper: search a feedback row's keys for a keyword substring
        const getFbByKeyword = (fb, keyword) => {
            for (const key of Object.keys(fb)) {
                if (FB_SKIP_KEYS.has(key)) continue;
                if (key.toLowerCase().includes(keyword)) return fb[key] || '';
            }
            return '';
        };

        const allFeedbackRows = allProgramData.flatMap(({ data }) => data.feedbackData || []);

        const cleanFbList = arr =>
            [...new Set(
                arr.map(v => cleanFbVal(v)).filter(Boolean)
            )].slice(0, 10);

        const improvementsList = cleanFbList(allFeedbackRows.map(fb =>
            fb.feedback_improvements || fb.improvements || getFbByKeyword(fb, 'improv') || ''
        ));

        const furtherTopicsList = cleanFbList(allFeedbackRows.map(fb =>
            fb.feedback_further || fb.further || fb.additional_training ||
            getFbByKeyword(fb, 'further') || getFbByKeyword(fb, 'additional') || ''
        ));

        const insightsList = cleanFbList(allFeedbackRows.map(fb =>
            fb.feedback_insights || fb.insights || getFbByKeyword(fb, 'insight') || ''
        ));

        // Build bullet paragraph helper
        const bulletPara = text => new Paragraph({
            children: [run(`• ${text}`, { size: 22 })],
            spacing: { before: 40, after: 40 },
            indent: { left: 360 },
        });

        const sectionABullets = insightsList.length
            ? insightsList.map(bulletPara)
            : [para('No specific strengths were recorded.')];

        const sectionBBullets = improvementsList.length
            ? improvementsList.map(bulletPara)
            : [para('No specific improvement suggestions were recorded.')];

        const sectionCBullets = furtherTopicsList.length
            ? furtherTopicsList.map(bulletPara)
            : [para('No additional training topics were suggested.')];

        // ── Assemble QAME Analysis section ────────────────────────────────
        const qameAnalysisChildren = [
            new Paragraph({ children: [bRun('QAME ANALYSIS', { size: 21, allCaps: true })], alignment: AlignmentType.LEFT, spacing: { after: 60 } }),
            new Paragraph({ spacing: { after: 160 } }),

            combinedInfoTable,
            emptyPara(),
            sectionHead('1. SUMMARY OF RATINGS'),
            combinedSummaryTable,
            emptyPara(),
            ...catSectionBlocks,
            sectionHead(`${spkSectionNum}. RESOURCE PERSONS`),
            ...(combinedSpkBlocks.length ? combinedSpkBlocks : [para('No speaker data available.')]),
            ...(qameFeedbackBlocks.length ? [sectionHead('PARTICIPANT FEEDBACK'), ...qameFeedbackBlocks] : []),
            sigTable(),
            emptyPara(),
            new Paragraph({ children: [run('A. ', { italics: true, bold: true }), run('For Evaluation of PMT, Objectives, Content Relevance, Meals and Venue', { italics: true })], spacing: { before: 240, after: 80 } }),
            buildScaleTable('category'),
            new Paragraph({ children: [run('B. ', { italics: true, bold: true }), run('For Resource Speaker', { italics: true })], spacing: { before: 140, after: 80 } }),
            buildScaleTable('speaker'),
            new Paragraph({ children: [run('C. ', { italics: true, bold: true }), run('Over-all Score', { italics: true })], spacing: { before: 140, after: 80 } }),
            buildScaleTable('overall'),
            emptyPara(),
        ];

        // ── Build the combined Evaluation Summary section ─────────────────
        // Overall ratings table: one row per program (program name | overall avg | desc)
        const evalOverallRows = allProgramData.map(({ prog: p, data }) => {
            const { categories, columnAverages } = data;
            const catScores = allCatNames.map(n => getCatAvg(categories, columnAverages, n)).filter(v => v !== null);
            const avg  = catScores.length ? (catScores.reduce((a, b) => a + b, 0) / catScores.length).toFixed(2) : '—';
            const desc = avg !== '—' ? getInterp(parseFloat(avg), 'overall') : '—';
            return [p.title || '—', avg, desc];
        });
        const grandOverallScores = evalOverallRows.map(r => parseFloat(r[1])).filter(n => !isNaN(n));
        const grandOverallAvg  = grandOverallScores.length ? (grandOverallScores.reduce((a, b) => a + b, 0) / grandOverallScores.length).toFixed(2) : '—';
        const grandOverallDesc = grandOverallAvg !== '—' ? getInterp(parseFloat(grandOverallAvg), 'overall') : '—';
        const evalOverallTable = build3Col(
            ['Training Program', 'Overall Average Rating', 'Descriptive Rating'],
            evalOverallRows,
            [SW, NW, DW],
            ['Grand Overall Average', grandOverallAvg, grandOverallDesc],
        );

        // Category ratings table: one row per category showing grand avg across all programs
        const evalCatRows = allCatNames.map(catName => {
            const scores = allProgramData.map(({ data }) => getCatAvg(data.categories, data.columnAverages, catName)).filter(v => v !== null);
            const avg  = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : '—';
            const desc = avg !== '—' ? getInterp(parseFloat(avg), 'category') : '—';
            return [catName, avg, desc];
        });
        const evalCatTable = build3Col(
            ['Category', 'Average Rating', 'Descriptive Rating'],
            evalCatRows,
            [SW, NW, DW],
            ['Grand Overall Average', grandOverallAvg, grandOverallDesc],
        );

        // Speaker summary table: all speakers across all programs
        const evalSpkTable = combinedSpkSummaryRows.length
            ? new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: [SW - 1400, 1400, NW, DW],
                rows: [
                    new TableRow({ children: [hCell('Speaker Name', SW - 1400), hCell('Program', 1400), hCell('Avg Rating', NW), hCell('Descriptive Rating', DW)] }),
                    ...combinedSpkSummaryRows.map(r => new TableRow({ children: r.map((txt, i) => cell(
                        [new Paragraph({ children: [run(String(txt ?? '—'), { size: i === 1 ? 20 : 22 })], spacing: { after: 0 } })],
                        { width: { size: [SW - 1400, 1400, NW, DW][i], type: WidthType.DXA } }
                    )) })),
                ],
            })
            : null;

        const programTitlesStr = selectedPrograms.map(p => p.title || 'Untitled').join('; ');
        const evalSummaryChildren = [
            new Paragraph({ children: [new PageBreak()] }),
            new Paragraph({ children: [bRun('EVALUATION SUMMARY', { size: 26, underline: {}, allCaps: true })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
            new Paragraph({ children: [bRun(`Combined Report — ${selectedPrograms.length} Program${selectedPrograms.length > 1 ? 's' : ''}`, { size: 22 })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
            new Paragraph({ children: [run(dateStr, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 160 } }),
            new Paragraph({ children: [bRun('I. OVERALL RATINGS')], spacing: { before: 120, after: 80 } }),
            evalOverallTable, emptyPara(),
            new Paragraph({ children: [bRun('II. CATEGORY RATINGS')], spacing: { before: 120, after: 80 } }),
            evalCatTable, emptyPara(),
            new Paragraph({ children: [bRun('III. RESOURCE PERSONS – SUMMARY OF PERFORMANCE')], spacing: { before: 120, after: 80 } }),
            ...(evalSpkTable ? [evalSpkTable] : [para('No speaker data available.')]),
            emptyPara(),
            new Paragraph({ children: [bRun('IV. HIGHLIGHTS FROM PARTICIPANT FEEDBACK')], spacing: { before: 120, after: 80 } }),
            new Paragraph({ children: [bRun('A. STRENGTHS OF THE TRAINING')], spacing: { before: 80, after: 60 } }),
            ...sectionABullets,
            emptyPara(),
            new Paragraph({ children: [bRun('B. AREAS FOR IMPROVEMENT')], spacing: { before: 100, after: 60 } }),
            ...sectionBBullets,
            emptyPara(),
            new Paragraph({ children: [bRun('C. SUGGESTED ADDITIONAL TOPICS')], spacing: { before: 100, after: 60 } }),
            ...sectionCBullets,
            emptyPara(),
            new Paragraph({ children: [bRun('V. CONCLUSION')], spacing: { before: 120, after: 80 } }),
            emptyPara(),
            sigTable(),
        ];

        // ── Assemble all sections ─────────────────────────────────────────
        const allChildren = [
            ...coverChildren,
            ...qameAnalysisChildren,
            ...evalSummaryChildren,
        ];

        // ── Build and download ────────────────────────────────────────────
        setStatus('Building document…');
        const doc = new Document({
            styles: { default: { document: { run: { font: 'Bookman Old Style', size: 22 } } } },
            sections: [{
                properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1181, bottom: 1094, left: 1440, header: 360, footer: 360 } } },
                headers: { default: new Header({ children: buildHeader() }) },
                footers: { default: new Footer({ children: buildFooter() }) },
                children: allChildren,
            }],
        });

        setStatus('Saving…');
        const blob = await Packer.toBlob(doc);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `QAME_Combined_Report_${now.toISOString().slice(0, 10)}_${selectedPrograms.length}progs.docx`;
        a.click();
        URL.revokeObjectURL(url);

        showAlert('success', `Combined Word report exported (${selectedPrograms.length} program${selectedPrograms.length > 1 ? 's' : ''}).`);
        closeMultiProgramReportModal();

    } catch (e) {
        console.error('exportMultiProgramWordReport:', e);
        showAlert('error', 'Export failed — check the browser console for details.');
    } finally {
        if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Export Word'; }
        setStatus('');
    }
}
