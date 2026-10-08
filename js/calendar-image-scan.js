// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR IMAGE SCAN — Image-based day count verification
// Add this block to checklist.js (e.g. after the buildCalendarInstructions fn)
// ══════════════════════════════════════════════════════════════════════════════

// ── State for image scan ──────────────────────────────────────────────────────
const calImgState = {
    totalFile: null,       // File — the summary/total computation image
    calFiles:  [],         // File[] — the individual monthly calendar images
    scanResult: null,      // Last AI result from image scan
};

// ── Legends (per the school calendar template) ────────────────────────────────
const CAL_LEGEND_INFO = `
CALENDAR LEGEND — READ THIS EXACTLY:

  X  → Declared Holiday. DO NOT COUNT. This is the ONLY mark that removes a day.
  □  → School activity day (teachers/personnel/stakeholders). STILL COUNTS as a school day.
  △  → Quarter or Summative Examination day. STILL COUNTS as a school day.
  No mark on a weekday → Regular class day. COUNTS.
  Saturday (Sa column) → NEVER counts, regardless of any mark.
  Sunday  (Su column)  → NEVER counts, regardless of any mark.

THE ONE RULE: school_days = (all Mon–Fri days in the valid date range) − (days marked X).
□ and △ are informational only — they do NOT subtract from the count. ONLY X subtracts.

IMPORTANT — DO NOT RE-DERIVE THE COUNT YOURSELF FROM SCRATCH.
Each calendar image already has a printed "Class days: N" number at the bottom-right of the
calendar grid. That is the school's own stated count. READ THAT NUMBER DIRECTLY from the image
and use it as stated_school_days. Then do your own independent weekday count to verify it.
If your count differs from the printed number, report both and flag the discrepancy.
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a File to a base64 data string (without the data-URI prefix). */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
        reader.readAsDataURL(file);
    });
}

/** Return a short media-type string accepted by the AI vision API. */
function imageMimeType(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                  gif: 'image/gif',  webp: 'image/webp' };
    return map[ext] || file.type || 'image/jpeg';
}

/** Human-readable file size */
function fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── Render helpers ────────────────────────────────────────────────────────────

/**
 * Render (or re-render) the complete calendar image scan panel.
 * Called once on checklist-type switch to "school_calendar" and again
 * whenever files are added/removed.
 */
function renderCalImgPanel() {
    const container = document.getElementById('calImgScanPanel');
    if (!container) return;

    container.innerHTML = `
    <div class="card" style="margin-top:14px;">
        <div class="card-title">
            <i class="fa-solid fa-images" style="margin-right:6px;color:#6366f1;"></i>
            Calendar Image Scan (Optional)
        </div>
        <div class="card-subtitle" style="margin-bottom:14px;">
            Upload images of the school calendar to let AI count school days directly from the pictures.
            <strong>Step A:</strong> upload the total-computation summary image first,
            then <strong>Step B:</strong> upload the individual monthly calendar page images.
            The AI will use the legend markings (X&nbsp;=&nbsp;holiday,&nbsp;△&nbsp;=&nbsp;school activity,
            boxed&nbsp;=&nbsp;exam day) to tally each month and compare against the stated totals.
        </div>

        <!-- ── LEGEND CARD ── -->
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;
                    padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
            <span style="font-size:12px;font-weight:600;color:#374151;width:100%;margin-bottom:2px;">
                Legend used in these calendars:
            </span>
            <span style="display:flex;align-items:center;gap:5px;font-size:12px;color:#dc2626;">
                <span style="font-size:15px;font-weight:700;line-height:1;">✕</span>
                <span>Holiday — not counted</span>
            </span>
            <span style="display:flex;align-items:center;gap:5px;font-size:12px;color:#d97706;">
                <span style="font-size:15px;font-weight:700;line-height:1;">△</span>
                <span>School activity (teachers / personnel)</span>
            </span>
            <span style="display:flex;align-items:center;gap:5px;font-size:12px;color:#2563eb;">
                <span style="font-size:14px;font-weight:700;line-height:1;
                    border:1.5px solid #2563eb;padding:0 3px;border-radius:3px;">□</span>
                <span>Quarterly / Summative Exam — counted as school day</span>
            </span>
        </div>

        <!-- ── STEP A: Total computation image ── -->
        <div style="margin-bottom:16px;">
            <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">
                <span style="background:#6366f1;color:#fff;border-radius:50%;width:20px;height:20px;
                    display:inline-flex;align-items:center;justify-content:center;
                    font-size:11px;margin-right:6px;">A</span>
                Total Computation Image <span style="color:#6b7280;font-weight:400;">(1 image — the summary table)</span>
            </div>
            <div class="upload-zone" id="calTotalZone" style="padding:16px 12px;"
                 onclick="document.getElementById('calTotalFile').click()"
                 ondragover="event.preventDefault();this.classList.add('drag-over')"
                 ondragleave="this.classList.remove('drag-over')"
                 ondrop="calImgDropTotal(event)">
                <input type="file" id="calTotalFile" accept="image/*" style="display:none;"
                       onchange="calImgSelectTotal(this.files)">
                <div class="upload-zone-inner" style="padding:12px 0;">
                    <i class="fa-solid fa-table upload-icon" style="font-size:24px;"></i>
                    <h3 style="font-size:14px;margin:6px 0 2px;">Drop summary image here or click to browse</h3>
                    <p style="font-size:12px;">PNG, JPG, WEBP · e.g. the Month/School Days summary table</p>
                </div>
            </div>
            <div id="calTotalPreview" style="margin-top:8px;"></div>
        </div>

        <!-- ── STEP B: Monthly calendar images ── -->
        <div style="margin-bottom:16px;">
            <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">
                <span style="background:#6366f1;color:#fff;border-radius:50%;width:20px;height:20px;
                    display:inline-flex;align-items:center;justify-content:center;
                    font-size:11px;margin-right:6px;">B</span>
                Monthly Calendar Images <span style="color:#6b7280;font-weight:400;">(1 or more — each page/month)</span>
            </div>
            <div class="upload-zone" id="calPagesZone" style="padding:16px 12px;"
                 onclick="document.getElementById('calPagesFile').click()"
                 ondragover="event.preventDefault();this.classList.add('drag-over')"
                 ondragleave="this.classList.remove('drag-over')"
                 ondrop="calImgDropPages(event)">
                <input type="file" id="calPagesFile" accept="image/*" multiple style="display:none;"
                       onchange="calImgSelectPages(this.files)">
                <div class="upload-zone-inner" style="padding:12px 0;">
                    <i class="fa-solid fa-calendar-days upload-icon" style="font-size:24px;"></i>
                    <h3 style="font-size:14px;margin:6px 0 2px;">Drop calendar page images here or click to browse</h3>
                    <p style="font-size:12px;">PNG, JPG, WEBP · Upload all monthly pages at once (multi-select OK)</p>
                </div>
            </div>
            <div id="calPagesPreview" style="margin-top:8px;"></div>
        </div>

        <!-- ── Scan button ── -->
        <div class="btn-row" style="margin-top:4px;">
            <button class="btn btn-primary" id="calImgScanBtn"
                    onclick="runCalendarImageScan()" disabled>
                <i class="fa-solid fa-magnifying-glass-chart"></i>
                Scan Calendar Images with AI
            </button>
            <button class="btn btn-secondary" id="calImgClearBtn"
                    onclick="clearCalImgState()" style="display:none;">
                <i class="fa-solid fa-trash"></i> Clear Images
            </button>
        </div>

        <div class="loader" id="calImgLoader" style="margin-top:10px;display:none;">
            <div class="spinner"></div>
            <p id="calImgLoaderMsg">Sending images to AI for analysis…</p>
        </div>
        <div class="msg-box" id="calImgMsg" style="margin-top:8px;"></div>

        <!-- ── Result area ── -->
        <div id="calImgResult" style="margin-top:14px;"></div>
    </div>`;

    _calImgSyncButtons();
}

/** Show/hide the scan button based on whether we have at least one calendar page image. */
function _calImgSyncButtons() {
    const btn   = document.getElementById('calImgScanBtn');
    const clear = document.getElementById('calImgClearBtn');
    if (!btn) return;
    const hasData = calImgState.calFiles.length > 0;
    btn.disabled = !hasData;
    if (clear) clear.style.display = (calImgState.totalFile || hasData) ? '' : 'none';
}

// ── File selection / drop handlers ───────────────────────────────────────────

function calImgDropTotal(e) {
    e.preventDefault();
    document.getElementById('calTotalZone')?.classList.remove('drag-over');
    calImgSelectTotal(e.dataTransfer.files);
}

function calImgDropPages(e) {
    e.preventDefault();
    document.getElementById('calPagesZone')?.classList.remove('drag-over');
    calImgSelectPages(e.dataTransfer.files);
}

function calImgSelectTotal(files) {
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
        _calImgMsg('Only image files are supported (PNG, JPG, WEBP).', 'error'); return;
    }
    calImgState.totalFile = file;
    _renderTotalPreview(file);
    _calImgSyncButtons();
    // Clear any prior result since data changed
    const res = document.getElementById('calImgResult');
    if (res) res.innerHTML = '';
}

function calImgSelectPages(files) {
    if (!files || !files.length) return;
    const newFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!newFiles.length) {
        _calImgMsg('Only image files are supported (PNG, JPG, WEBP).', 'error'); return;
    }
    // Append (don't replace) so user can add pages incrementally
    calImgState.calFiles.push(...newFiles);
    _renderPagesPreview();
    _calImgSyncButtons();
    const res = document.getElementById('calImgResult');
    if (res) res.innerHTML = '';
}

function _renderTotalPreview(file) {
    const el = document.getElementById('calTotalPreview');
    if (!el) return;
    const url = URL.createObjectURL(file);
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
                    background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
            <img src="${url}" alt="Summary" onclick="window.open('${url}')"
                 style="height:60px;width:auto;border-radius:4px;cursor:zoom-in;
                        border:1px solid #e5e7eb;object-fit:contain;background:#fff;">
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:500;color:#166534;
                            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${esc(file.name)}
                </div>
                <div style="font-size:11px;color:#4b7c5a;">${fmtFileSize(file.size)}</div>
            </div>
            <button onclick="clearCalTotalFile()" title="Remove"
                    style="background:none;border:none;cursor:pointer;font-size:16px;
                           color:#dc2626;padding:4px;">✕</button>
        </div>`;
}

function _renderPagesPreview() {
    const el = document.getElementById('calPagesPreview');
    if (!el) return;
    if (!calImgState.calFiles.length) { el.innerHTML = ''; return; }
    const thumbs = calImgState.calFiles.map((f, i) => {
        const url = URL.createObjectURL(f);
        return `
        <div style="display:inline-flex;flex-direction:column;align-items:center;
                    gap:4px;position:relative;width:80px;">
            <img src="${url}" alt="Page ${i+1}" onclick="window.open('${url}')"
                 style="width:72px;height:56px;object-fit:contain;border-radius:4px;
                        border:1px solid #e5e7eb;background:#fff;cursor:zoom-in;">
            <span style="font-size:10px;color:#374151;text-align:center;
                         word-break:break-all;max-width:72px;overflow:hidden;
                         white-space:nowrap;text-overflow:ellipsis;">${esc(f.name)}</span>
            <button onclick="calImgRemovePage(${i})"
                    style="position:absolute;top:-4px;right:0;background:#dc2626;
                           color:#fff;border:none;border-radius:50%;width:16px;height:16px;
                           font-size:10px;cursor:pointer;display:flex;align-items:center;
                           justify-content:center;padding:0;">✕</button>
        </div>`;
    }).join('');
    el.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;
                    background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
            <div style="width:100%;font-size:12px;color:#374151;font-weight:500;margin-bottom:2px;">
                ${calImgState.calFiles.length} calendar image${calImgState.calFiles.length !== 1 ? 's' : ''} selected
            </div>
            ${thumbs}
        </div>`;
}

function clearCalTotalFile() {
    calImgState.totalFile = null;
    const el = document.getElementById('calTotalPreview');
    if (el) el.innerHTML = '';
    const inp = document.getElementById('calTotalFile');
    if (inp) inp.value = '';
    _calImgSyncButtons();
}

function calImgRemovePage(idx) {
    calImgState.calFiles.splice(idx, 1);
    _renderPagesPreview();
    _calImgSyncButtons();
}

function clearCalImgState() {
    calImgState.totalFile = null;
    calImgState.calFiles  = [];
    calImgState.scanResult = null;
    ['calTotalPreview','calPagesPreview','calImgResult'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    ['calTotalFile','calPagesFile'].forEach(id => {
        const inp = document.getElementById(id);
        if (inp) inp.value = '';
    });
    _calImgMsg('', '');
    _calImgSyncButtons();
}

function _calImgMsg(msg, type) {
    const el = document.getElementById('calImgMsg');
    if (!el) return;
    if (!msg) { el.className = 'msg-box'; el.textContent = ''; return; }
    el.textContent = msg;
    el.className   = 'msg-box visible ' + type;
}

// ── Main AI scan function ─────────────────────────────────────────────────────

async function runCalendarImageScan() {
    if (!calImgState.calFiles.length) {
        _calImgMsg('⚠ Please upload at least one monthly calendar image (Step B).', 'error');
        return;
    }

    const btn    = document.getElementById('calImgScanBtn');
    const loader = document.getElementById('calImgLoader');
    const ldrMsg = document.getElementById('calImgLoaderMsg');

    btn.disabled = true;
    if (loader) loader.style.display = '';
    _calImgMsg('', '');

    const loadingSteps = [
        'Sending images to AI for analysis…',
        'Reading total computation table…',
        'Scanning each month for X marks (holidays)…',
        'Counting □ activity days and △ exam days (both counted)…',
        'Tallying weekdays per month…',
        'Comparing AI count vs stated totals…',
        'Almost done…',
    ];
    let li = 0;
    const lTimer = setInterval(() => {
        li = (li + 1) % loadingSteps.length;
        if (ldrMsg) ldrMsg.textContent = loadingSteps[li];
    }, 2000);

    try {
        // ── Build vision message content array ──────────────────────────────
        // Content block order: system instructions first, then images
        const contentBlocks = [];

        // 1. Instruction text block
        contentBlocks.push({
            type: 'text',
            text:
`You are an expert at reading Philippine elementary school calendar documents.
You will be given images of a school calendar for Marian College of Baliuag, Inc.
(Elementary Department) for School Year 2026–2027.

${CAL_LEGEND_INFO}

YOUR TASK:
${calImgState.totalFile
    ? `Image 1 is the TOTAL COMPUTATION TABLE (summary of school days per month). 
       Read all rows: extract the month name and stated school days for each month, and the grand total.`
    : 'No summary table image was provided — skip the total-table analysis.'}

For each MONTHLY CALENDAR PAGE image, follow these steps IN ORDER:

STEP 1 — READ THE PRINTED "Class days: N" NUMBER.
  Look at the bottom-right corner of the calendar grid. There is a line that reads "Class days: N".
  Read that integer N directly. This is stated_school_days. Do NOT skip this step.

STEP 2 — DETECT BOUNDARIES from the activity notes column on the LEFT of the calendar:
  - If you see "Opening of Classes" on a specific date → count_from = that date (days before = pre-opening, skip).
  - If you see "Recognition Day", "Graduation Day", or a note that marks the last school event on a specific
    date → count_to = that date (days after = post-closing, skip).
  - All other months: count_from = 1, count_to = last day of the month.

STEP 3 — IDENTIFY THE CALENDAR GRID STRUCTURE.
  The grid has columns labeled: Su | Mo | Tu | We | Th | Fr | Sa
  Only Mo, Tu, We, Th, Fr (columns 2–6) are school day candidates. Su and Sa are NEVER counted.

STEP 4 — LIST ALL X-MARKED DATES within the count_from–count_to range.
  An X mark means declared holiday — these are the ONLY dates subtracted from the count.

STEP 5 — COUNT: school_days = (number of Mo–Fr dates within count_from to count_to) − (number of X-marked dates in that range).
  □ and △ marks do NOT subtract anything — they are just informational labels on days that are already counted.

STEP 6 — COMPARE your computed count from Step 5 against the printed "Class days: N" from Step 1.
  If they differ, report both and explain.

WORKED EXAMPLE (June 2026 — so you understand the method):
  June 2026 starts on Monday. Classes open June 8 (boundary note).
  Weekdays June 8–30: 8(Mon),9(Tue),10(Wed),11(Thu),12(Fri),15,16,17,18,19,22,23,24,25,26,29,30 = 17 weekdays.
  X marks: June 12 (Independence Day) = 1 holiday.
  school_days = 17 − 1 = 16. Printed "Class days: 16". Match ✓.
  Note: □ on Jun 1–5 (pre-opening activities) are BEFORE the boundary — not counted. No △ this month.

Return ONLY a valid JSON object in this exact format:
{
  "total_table": {
    "found": true|false,
    "stated_grand_total": <integer or null>,
    "months": [
      { "month": "<Month name>", "stated_days": <integer> }
    ]
  },
  "monthly_pages": [
    {
      "month": "<Month name e.g. June>",
      "year": <4-digit integer>,
      "count_from": <first day counted — 1 unless a boundary note says otherwise>,
      "count_to": <last day counted — last day of month unless a boundary note says otherwise>,
      "boundary_note": "<description of the opening/closing boundary if detected, else null>",
      "holidays": ["<date e.g. 12>", ...],
      "activity_days": ["<date with □ mark>", ...],
      "exam_days": ["<date with △ mark>", ...],
      "regular_class_days": ["<date with no special mark, within valid range>", ...],
      "computed_school_days": <integer — all valid weekdays minus holidays>,
      "stated_school_days": <integer or null — read from image "Class days: N">,
      "match": true|false|null,
      "note": "<brief note if discrepancy or if stated count not visible>"
    }
  ],
  "computed_grand_total": <integer — sum of all computed_school_days>,
  "summary": "<2-3 sentence overall assessment of whether the stated totals match the image-based counts>"
}`
        });

        // 2. Total computation image (if provided)
        if (calImgState.totalFile) {
            const b64 = await fileToBase64(calImgState.totalFile);
            contentBlocks.push({
                type: 'image',
                source: {
                    type:       'base64',
                    media_type: imageMimeType(calImgState.totalFile),
                    data:       b64,
                }
            });
        }

        // 3. Monthly calendar images
        for (const f of calImgState.calFiles) {
            const b64 = await fileToBase64(f);
            contentBlocks.push({
                type: 'image',
                source: {
                    type:       'base64',
                    media_type: imageMimeType(f),
                    data:       b64,
                }
            });
        }

        // ── Call AI proxy (same proxy used everywhere in the app) ────────────
        const aiResp = await callAI({
            model:      'claude-opus-4-5',
            max_tokens: 4096,
            messages: [
                { role: 'user', content: contentBlocks }
            ]
        });

        // ── Parse response ───────────────────────────────────────────────────
        const rawText = (aiResp.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        let result;
        try {
            const jsonStr = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            result = JSON.parse(jsonStr);
        } catch (e) {
            throw new Error('AI returned unexpected output. Raw: ' + rawText.slice(0, 300));
        }

        calImgState.scanResult = result;
        renderCalImgResult(result);
        _calImgMsg('✓ Image scan complete. Review results below.', 'success');

    } catch (err) {
        _calImgMsg('⚠ Scan failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        clearInterval(lTimer);
        if (loader) loader.style.display = 'none';
        btn.disabled = false;
    }
}

// ── Render the AI scan result ─────────────────────────────────────────────────

function renderCalImgResult(result) {
    const el = document.getElementById('calImgResult');
    if (!el || !result) return;

    const pages   = result.monthly_pages   || [];
    const totTbl  = result.total_table     || {};
    const grandAI = result.computed_grand_total;
    const grandSt = totTbl.stated_grand_total;
    const grandOk = (grandAI !== null && grandSt !== null) ? grandAI === grandSt : null;

    // ── Grand total summary pill ──────────────────────────────────────────────
    const grandColor = grandOk === true  ? '#166534' :
                       grandOk === false ? '#991b1b' : '#374151';
    const grandBg    = grandOk === true  ? '#dcfce7' :
                       grandOk === false ? '#fee2e2' : '#f3f4f6';
    const grandIcon  = grandOk === true  ? '✓' : grandOk === false ? '✗' : '?';

    let grandHtml = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                padding:12px 16px;border-radius:10px;margin-bottom:14px;
                background:${grandBg};border:1px solid ${grandOk === true ? '#86efac' : grandOk === false ? '#fca5a5' : '#e5e7eb'};">
        <span style="font-size:22px;font-weight:700;color:${grandColor};">${grandIcon}</span>
        <div>
            <div style="font-size:14px;font-weight:600;color:${grandColor};">
                AI-counted total: <strong>${grandAI ?? '—'}</strong> school days
            </div>
            ${grandSt !== null && grandSt !== undefined
                ? `<div style="font-size:12px;color:${grandColor};">
                       Stated total (from summary table): <strong>${grandSt}</strong>
                       ${grandOk === true  ? '— <strong>MATCH ✓</strong>' : ''}
                       ${grandOk === false ? `— <strong>DISCREPANCY ✗ (off by ${Math.abs(grandAI - grandSt)})</strong>` : ''}
                   </div>`
                : `<div style="font-size:12px;color:#6b7280;">No summary table provided — cannot compare against stated total.</div>`
            }
        </div>
    </div>`;

    // ── Stated months from the summary table (if provided) ────────────────────
    let totTableHtml = '';
    if (totTbl.found && totTbl.months?.length) {
        const rows = totTbl.months.map(m => {
            const page = pages.find(p => p.month?.toLowerCase() === m.month?.toLowerCase());
            const aiDays = page ? page.computed_school_days : null;
            const match  = (aiDays !== null && m.stated_days !== null) ? aiDays === m.stated_days : null;
            const mc = match === true ? '#166534' : match === false ? '#991b1b' : '#374151';
            const mb = match === true ? '#dcfce7' : match === false ? '#fee2e2' : 'transparent';
            return `<tr style="background:${mb};">
                <td style="padding:6px 10px;font-size:13px;color:#374151;">${esc(m.month)}</td>
                <td style="padding:6px 10px;font-size:13px;text-align:center;color:#374151;">${m.stated_days ?? '—'}</td>
                <td style="padding:6px 10px;font-size:13px;text-align:center;color:${mc};font-weight:500;">
                    ${aiDays ?? '—'}
                </td>
                <td style="padding:6px 10px;font-size:12px;text-align:center;color:${mc};">
                    ${match === true ? '✓ Match' : match === false ? '✗ Off by ' + Math.abs(aiDays - m.stated_days) : '—'}
                </td>
            </tr>`;
        }).join('');

        totTableHtml = `
        <div style="margin-bottom:16px;">
            <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">
                Summary Table vs AI Image Count
            </div>
            <div style="overflow-x:auto;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="background:#f8fafc;">
                            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;
                                       color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Month</th>
                            <th style="padding:7px 10px;text-align:center;font-size:11px;font-weight:600;
                                       color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Stated Days</th>
                            <th style="padding:7px 10px;text-align:center;font-size:11px;font-weight:600;
                                       color:#6366f1;text-transform:uppercase;letter-spacing:.04em;">AI Count</th>
                            <th style="padding:7px 10px;text-align:center;font-size:11px;font-weight:600;
                                       color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Result</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr style="background:#f0f4ff;border-top:2px solid #c7d2fe;">
                            <td style="padding:7px 10px;font-size:13px;font-weight:700;color:#374151;">TOTAL</td>
                            <td style="padding:7px 10px;text-align:center;font-size:13px;font-weight:700;color:#374151;">${grandSt ?? '—'}</td>
                            <td style="padding:7px 10px;text-align:center;font-size:13px;font-weight:700;color:#6366f1;">${grandAI ?? '—'}</td>
                            <td style="padding:7px 10px;text-align:center;font-size:13px;font-weight:600;
                                       color:${grandOk === true ? '#166534' : grandOk === false ? '#991b1b' : '#374151'};">
                                ${grandOk === true ? '✓ Match' : grandOk === false ? '✗ Discrepancy' : '—'}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>`;
    }

    // ── Per-month detail cards ────────────────────────────────────────────────
    const monthCards = pages.map(p => {
        const ok = p.match;
        const cc = ok === true ? '#166534' : ok === false ? '#991b1b' : '#374151';
        const cb = ok === true ? '#f0fdf4' : ok === false ? '#fef2f2' : '#f8fafc';
        const bdc= ok === true ? '#bbf7d0' : ok === false ? '#fecaca' : '#e2e8f0';

        const tagList = (arr, color, label) => arr?.length
            ? `<div style="margin-top:5px;font-size:11px;color:#6b7280;">
                   <strong style="color:${color};">${label}:</strong>
                   ${arr.map(d => `<span style="background:${color}22;color:${color};
                       border-radius:4px;padding:1px 5px;margin:1px;display:inline-block;">${esc(String(d))}</span>`).join('')}
               </div>`
            : '';

        return `
        <div style="border:1px solid ${bdc};border-radius:8px;padding:12px 14px;
                    margin-bottom:8px;background:${cb};">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
                <span style="font-size:14px;font-weight:600;color:${cc};">
                    ${esc(p.month || '—')} ${p.year || ''}
                </span>
                <span style="font-size:13px;background:${cc}22;color:${cc};
                             padding:3px 10px;border-radius:6px;font-weight:500;">
                    AI: ${p.computed_school_days ?? '—'} days
                    ${p.stated_school_days !== null && p.stated_school_days !== undefined
                        ? ` / Stated: ${p.stated_school_days}`
                        : ''}
                    ${ok === true ? ' ✓' : ok === false ? ' ✗' : ''}
                </span>
            </div>
            ${p.note ? `<div style="font-size:12px;color:#dc2626;margin-top:5px;
                                    padding:4px 8px;background:#fff;border-radius:4px;
                                    border-left:3px solid #dc2626;">${esc(p.note)}</div>` : ''}
            ${tagList(p.holidays,          '#dc2626', '✕ Holidays')}
            ${tagList(p.activity_days,     '#d97706', '△ Activity days')}
            ${tagList(p.exam_days,         '#2563eb', '□ Exam days')}
            ${tagList(p.regular_class_days,'#166534', '● Class days')}
        </div>`;
    }).join('');

    // ── Overall summary ───────────────────────────────────────────────────────
    const summaryHtml = result.summary
        ? `<div style="margin-top:10px;padding:10px 14px;background:#f8fafc;
                       border:1px solid #e2e8f0;border-radius:8px;
                       font-size:13px;color:#374151;line-height:1.6;">
               <strong>AI Assessment:</strong> ${esc(result.summary)}
           </div>`
        : '';

    el.innerHTML = `
    <div style="border-top:2px solid #e2e8f0;padding-top:14px;">
        <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:12px;">
            <i class="fa-solid fa-chart-bar" style="margin-right:6px;color:#6366f1;"></i>
            Image Scan Results
        </div>
        ${grandHtml}
        ${totTableHtml}
        ${monthCards
            ? `<div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">
                   Per-Month Breakdown
               </div>${monthCards}`
            : ''}
        ${summaryHtml}
    </div>`;
}

// ── Hook into checklist type switch ──────────────────────────────────────────
// Call this from setChecklistType() or from the DOMContentLoaded init.
// If setChecklistType() already exists, patch it to also call showHideCalImgPanel().

function showHideCalImgPanel(type) {
    const p = document.getElementById('calImgScanPanel');
    if (!p) return;
    if (type === 'school_calendar') {
        p.style.display = '';
        renderCalImgPanel();
    } else {
        p.style.display = 'none';
    }
}
