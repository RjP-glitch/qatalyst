/**
 * checklist-generator-modal.js
 *
 * Full-featured checklist generator modal.
 * - Two-panel layout: fields (left) + live preview (right)
 * - Pre-fill from: manual input, current Step 3 report, or saved records
 * - Per-item: cycle ✓ / ✗ / N/A / blank  +  editable text  +  add/remove
 * - Editable OTHER FINDINGS and RECOMMENDATIONS sections
 * - Evaluated By name + title
 * - Live document-style preview
 * - Downloads .docx via checklist-generator.js (generateChecklistDocx)
 *
 * Depends on:
 *   - checklist-generator.js (generateChecklistDocx, CHECKLIST_ITEM_DEFAULTS)
 *   - docx UMD library
 *   - Font Awesome icons
 */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
const _clgen = {
    type: null,
    schools: [],
    schoolsLoaded: false,
    selectedSchoolId: null,
    items: [],        // [{id, text, found, sub}]  found: true|false|null|'na'
    findings: '',
    recommendations: '',
};

/* ══════════════════════════════════════════════════════
   OPEN / CLOSE
══════════════════════════════════════════════════════ */

/**
 * openChecklistGeneratorModal(prefill?)
 *
 * prefill shape (all optional):
 * {
 *   checklistType, schoolName, location, syApplied,
 *   govRecogNo, govPermitNo,
 *   items: [{id, text, found, sub}],
 *   evaluatedBy, evaluatedByTitle,
 *   findings, recommendations,
 * }
 */
function openChecklistGeneratorModal(prefill) {
    _clgen.type = null;
    _clgen.selectedSchoolId = null;
    _clgen.items = [];
    _clgen.findings = '';
    _clgen.recommendations = '';

    // Reset all inputs
    [
        'clgen_schoolSearch', 'clgen_schoolName', 'clgen_location',
        'clgen_govRecogNo', 'clgen_govPermitNo',
        'clgen_findings', 'clgen_recommendations',
        'clgen_evalName', 'clgen_evalTitle',
    ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

    // Populate school year dropdown
    _clgenPopulateSY(prefill?.syApplied || '');

    // Reset type buttons
    ['tuition_increase', 'no_increase'].forEach(t => {
        const btn = document.getElementById('clgenType_' + t);
        if (btn) { btn.className = 'clgen-type-btn'; }
    });

    // Hide fields section
    const fs = document.getElementById('clgenFieldsSection');
    if (fs) fs.style.display = 'none';

    const resetBtn = document.getElementById('clgenResetBtn');
    if (resetBtn) resetBtn.style.display = 'none';

    // Reset preview
    const preview = document.getElementById('clgenPreview');
    if (preview) preview.innerHTML = '<div class="clgen-preview-placeholder">Select a checklist type to begin…</div>';

    _clgenHideMsg();

    // Pre-fill if data provided
    if (prefill) {
        _clgenApplyPrefill(prefill);
    }

    // Show modal
    const overlay = document.getElementById('clgenOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        requestAnimationFrame(() => overlay.classList.add('open'));
    }
    document.body.style.overflow = 'hidden';

    // Load schools in background
    _clgenLoadSchools();
}

function clgenClose(e) {
    if (e && e.target !== document.getElementById('clgenOverlay')) return;
    const overlay = document.getElementById('clgenOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => { overlay.style.display = 'none'; }, 230);
    document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════
   PRE-FILL SOURCES
══════════════════════════════════════════════════════ */

function _clgenApplyPrefill(prefill) {
    _clgenSetVal('clgen_schoolName',  (prefill.schoolName  || '').toUpperCase());
    _clgenSetVal('clgen_location',     prefill.location     || '');
    _clgenSetVal('clgen_govRecogNo',   prefill.govRecogNo   || '');
    _clgenSetVal('clgen_govPermitNo',  prefill.govPermitNo  || '');
    _clgenSetVal('clgen_findings',     prefill.findings     || '');
    _clgenSetVal('clgen_recommendations', prefill.recommendations || '');
    _clgenSetVal('clgen_evalName',     prefill.evaluatedBy      || 'MA. AUREA RHODORA DC. GERONIMO, PhD');
    _clgenSetVal('clgen_evalTitle',    prefill.evaluatedByTitle || 'Chief, SGOD/ In-Charge of Private Schools');

    if (prefill.syApplied) {
        const sel = document.getElementById('clgen_sy');
        if (sel) sel.value = prefill.syApplied;
    }

    if (prefill.checklistType) {
        const btn = document.getElementById('clgenType_' + prefill.checklistType);
        if (btn) clgenSetType(prefill.checklistType, btn);
    }

    if (prefill.items && prefill.items.length) {
        _clgen.items = prefill.items.map(i => ({ ...i }));
        _clgenRenderItems();
    }
}

/**
 * Auto-fills from the current Step 3 compliance report (state object).
 * Call this when the user opens the modal from the "Generate checklist" button
 * in the page header while a report is loaded.
 */
function _clgenPrefillFromCurrentReport() {
    if (typeof state === 'undefined' || !state.extractedText) return null;

    const matched = state.matchedData || {};
    return {
        checklistType:    state.checklistType || 'tuition_increase',
        schoolName:       matched.schoolName  || '',
        location:         matched.location    || '',
        syApplied:        matched.syApplied   || '',
        govRecogNo:       matched.govRecogNo  || '',
        govPermitNo:      matched.govPermitNo || '',
        evaluatedBy:      matched.evaluatedBy || '',
        items:            (state.checklistItems || []).map(i => ({
            id:    i.id,
            text:  i.text,
            found: i.found,   // true | false | null
            sub:   i.sub || false,
        })),
    };
}

/**
 * Pre-fills from a saved record object (from _allRecords).
 */
function _clgenPrefillFromRecord(record) {
    if (!record) return null;
    let fields = {};
    let items = [];
    try { fields = JSON.parse(record.fields_json || '{}'); } catch(e) {}
    try { items  = JSON.parse(record.items_json  || '[]'); } catch(e) {}
    return {
        checklistType:    record.checklist_type  || 'tuition_increase',
        schoolName:       record.school_name     || fields.schoolName || '',
        location:         record.location        || fields.location   || '',
        syApplied:        record.sy_applied      || fields.syApplied  || '',
        govRecogNo:       fields.govRecogNo      || '',
        govPermitNo:      fields.govPermitNo     || '',
        evaluatedBy:      fields.evaluatedBy     || '',
        evaluatedByTitle: fields.evaluatedByTitle|| '',
        items:            items.map(i => ({ id: i.id, text: i.text, found: i.found, sub: i.sub || false })),
    };
}

/* ══════════════════════════════════════════════════════
   TYPE SELECTION
══════════════════════════════════════════════════════ */

function clgenSetType(type, btn) {
    _clgen.type = type;

    // Style buttons
    ['tuition_increase', 'no_increase'].forEach(t => {
        const b = document.getElementById('clgenType_' + t);
        if (b) b.className = 'clgen-type-btn' + (t === type ? ' active' : '');
    });

    // Update modal title
    const titleEl = document.getElementById('clgen_modalTitle');
    if (titleEl) {
        const labels = {
            tuition_increase: 'Tuition Fee Increase Checklist',
            no_increase:      'No Increase Checklist',
        };
        titleEl.textContent = labels[type] || 'Generate Processing Checklist';
    }

    // Show fields section
    const fs = document.getElementById('clgenFieldsSection');
    if (fs) {
        fs.style.display = '';
        fs.style.opacity = '0';
        fs.style.transform = 'translateY(8px)';
        requestAnimationFrame(() => {
            fs.style.transition = 'opacity .22s ease, transform .22s ease';
            fs.style.opacity = '1';
            fs.style.transform = 'translateY(0)';
        });
    }

    // Show reset button
    const resetBtn = document.getElementById('clgenResetBtn');
    if (resetBtn) resetBtn.style.display = '';

    // Load default items if none set yet
    if (!_clgen.items.length) {
        _clgenLoadDefaultItems(type);
    }

    clgenUpdatePreview();
}

function _clgenLoadDefaultItems(type) {
    const defaults = (typeof CHECKLIST_ITEM_DEFAULTS !== 'undefined')
        ? CHECKLIST_ITEM_DEFAULTS
        : _clgenBuiltInDefaults;

    const src = defaults[type] || defaults.tuition_increase || [];
    _clgen.items = src.map(i => ({ id: i.id, text: i.text, found: null, sub: !!i.sub }));
    _clgenRenderItems();
}

function clgenResetItems() {
    if (!_clgen.type) return;
    if (!confirm('Reset all checklist items to DepEd defaults? Custom changes will be lost.')) return;
    _clgenLoadDefaultItems(_clgen.type);
    clgenUpdatePreview();
}

/* ══════════════════════════════════════════════════════
   ITEMS EDITOR
══════════════════════════════════════════════════════ */

const _clgenStatusCycle = ['blank', 'found', 'missing', 'na'];
const _clgenStatusLabel = { blank: '—', found: '✓', missing: '✗', na: 'N/A' };

function _clgenItemStatusKey(found) {
    if (found === true)   return 'found';
    if (found === false)  return 'missing';
    if (found === 'na')   return 'na';
    return 'blank';
}

function _clgenRenderItems() {
    const editor = document.getElementById('clgenItemsEditor');
    if (!editor) return;

    editor.innerHTML = _clgen.items.map((item, idx) => {
        const statusKey = _clgenItemStatusKey(item.found);
        const subBadge = item.sub
            ? `<span class="clgen-item-sub-badge">sub</span>` : '';
        return `
        <div class="clgen-item-row" id="clgenRow_${idx}">
          <div class="clgen-item-status">
            <button class="clgen-status-cycle"
              data-status="${statusKey}"
              onclick="clgenCycleStatus(${idx})"
              title="Click to cycle: blank → ✓ → ✗ → N/A">
              ${_clgenStatusLabel[statusKey]}
            </button>
          </div>
          <div class="clgen-item-body">
            ${subBadge}
            <textarea class="clgen-item-text" rows="2"
              oninput="clgenUpdateItemText(${idx}, this.value)"
            >${_escHtml(item.text)}</textarea>
          </div>
          <button class="clgen-item-del" onclick="clgenDeleteItem(${idx})" title="Remove item">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`;
    }).join('');
}

function clgenCycleStatus(idx) {
    const item = _clgen.items[idx];
    if (!item) return;
    const cur  = _clgenItemStatusKey(item.found);
    const pos  = _clgenStatusCycle.indexOf(cur);
    const next = _clgenStatusCycle[(pos + 1) % _clgenStatusCycle.length];
    // Convert back to found value
    if (next === 'found')   item.found = true;
    else if (next === 'missing') item.found = false;
    else if (next === 'na') item.found = 'na';
    else                    item.found = null;

    // Update just the button (fast, no full re-render)
    const btn = document.querySelector(`#clgenRow_${idx} .clgen-status-cycle`);
    if (btn) {
        btn.dataset.status = next;
        btn.textContent = _clgenStatusLabel[next];
    }
    clgenUpdatePreview();
}

function clgenUpdateItemText(idx, val) {
    if (_clgen.items[idx]) _clgen.items[idx].text = val;
    clgenUpdatePreview();
}

function clgenDeleteItem(idx) {
    _clgen.items.splice(idx, 1);
    _clgenRenderItems();
    clgenUpdatePreview();
}

function clgenAddItem() {
    _clgen.items.push({ id: _clgen.items.length + 1, text: '', found: null, sub: false });
    _clgenRenderItems();
    clgenUpdatePreview();
    // Focus the new textarea
    setTimeout(() => {
        const rows = document.querySelectorAll('.clgen-item-text');
        if (rows.length) rows[rows.length - 1].focus();
    }, 50);
}

/* ══════════════════════════════════════════════════════
   LIVE PREVIEW
══════════════════════════════════════════════════════ */

function clgenUpdatePreview() {
    const preview = document.getElementById('clgenPreview');
    if (!preview || !_clgen.type) return;

    const schoolName  = (document.getElementById('clgen_schoolName')?.value  || '').toUpperCase() || '[SCHOOL NAME]';
    const location    = document.getElementById('clgen_location')?.value    || '';
    const sy          = document.getElementById('clgen_sy')?.value          || '____-____';
    const govRecogNo  = document.getElementById('clgen_govRecogNo')?.value  || '';
    const govPermitNo = document.getElementById('clgen_govPermitNo')?.value || '';
    const findings    = document.getElementById('clgen_findings')?.value     || '';
    const recos       = document.getElementById('clgen_recommendations')?.value || '';
    const evalName    = document.getElementById('clgen_evalName')?.value    || 'MA. AUREA RHODORA DC. GERONIMO, PhD';
    const evalTitle   = document.getElementById('clgen_evalTitle')?.value   || 'Chief, SGOD/ In-Charge of Private Schools';

    const titleLine1 = (_clgen.type === 'no_increase')
        ? 'Processing Checklist for Application for No Increase in School Fees'
        : 'Processing Checklist for Application for Increase &amp; Notation in School Fees';

    // Header table rows
    const hRow = (lbl, val) => `
      <tr>
        <td class="label">${lbl}</td>
        <td class="value">${_escHtml(val)}</td>
      </tr>`;

        const sectionLinesHtml = (label, text, totalLines) => {
                const rows = [];
                rows.push(`
                    <tr>
                        <td class="clgen-doc-sec-label">${label}</td>
                        <td class="clgen-doc-sec-line">${_escHtml(text || '')}</td>
                    </tr>`);
                for (let i = 1; i < totalLines; i++) {
                        rows.push(`
                    <tr>
                        <td class="clgen-doc-sec-label"></td>
                        <td class="clgen-doc-sec-line">&nbsp;</td>
                    </tr>`);
                }
                return `<table class="clgen-doc-sec-table">${rows.join('')}</table>`;
        };

        const signatoryHtml = `
            <table class="clgen-doc-sign-block">
                <tr>
                    <td class="clgen-doc-sign-left">
                        <div class="clgen-doc-sign-label">Validated by:</div>
                        <div class="clgen-doc-sign-line">&nbsp;</div>
                        <div class="clgen-doc-sign-caption">Name</div>
                        <div class="clgen-doc-sign-line">&nbsp;</div>
                        <div class="clgen-doc-sign-caption">RO-QAD</div>
                    </td>
                    <td class="clgen-doc-sign-gap"></td>
                    <td class="clgen-doc-sign-right">
                        <div class="clgen-doc-sign-label clgen-doc-sign-label-right">Processed/Evaluated by:</div>
                        <div class="clgen-doc-sign-line clgen-doc-sign-name">${_escHtml(evalName)}</div>
                        <div class="clgen-doc-sign-caption clgen-doc-sign-caption-bold">${_escHtml(evalTitle)}</div>
                        <div class="clgen-doc-sign-line">&nbsp;</div>
                        <div class="clgen-doc-sign-caption">Date</div>
                    </td>
                </tr>
            </table>`;

    // Checklist items
            const itemsHtml = _clgen.items.map(item => {
                const statusKey = _clgenItemStatusKey(item.found);
                let tick, label = '', rest = '';
                // Detect (a)/(b)/(c) at start
                const match = item.text.match(/^\((a|b|c)\)\s*(.*)$/i);
                const isMainNumber = !item.sub && /^\d+$/.test(String(item.id || ''));
                const numLabel = isMainNumber ? `${item.id}. ` : '';
                if (item.sub && match) {
                        label = match[1].toLowerCase();
                        rest = match[2];
                }
                if (statusKey === 'found')   tick = `<span class="clgen-doc-item-tick found"><span class="clgen-doc-checkline">&#10004;</span></span>`;
                else if (statusKey === 'missing') tick = `<span class="clgen-doc-item-tick missing">&#10008;&nbsp;&nbsp;</span>`;
                else if (statusKey === 'na') tick = `<span class="clgen-doc-item-tick na">N/A&nbsp;&nbsp;&nbsp;</span>`;
                else if (item.sub && match)  tick = `<span class="clgen-doc-item-tick">________(${label})</span>`;
                else                         tick = `<span class="clgen-doc-item-tick">________</span>`;

                // For sub-items with (a)/(b)/(c), show underline before label
                if (item.sub && match) {
                        return `<div class="clgen-doc-item sub">
                            ${tick}
                            <span>${_escHtml(rest)}</span>
                        </div>`;
                } else {
                        return `<div class="clgen-doc-item${item.sub ? ' sub' : ''}">
                            ${tick}
                        <span>${_escHtml(numLabel)}${_escHtml(item.text)}</span>
                        </div>`;
                }
        }).join('');

    const findingsHtml = sectionLinesHtml('OTHER FINDINGS (specify)', findings, 4);
    const recosHtml    = sectionLinesHtml('RECOMMENDATIONS', recos, 4);

    preview.innerHTML = `
<div class="clgen-doc">
  <div class="clgen-doc-title">${titleLine1}</div>
  <div class="clgen-doc-title">In Private Pre-Elementary, Elementary and Junior High Schools</div>
  <div class="clgen-doc-subtitle">( per D.O No. 12, s. 1997)</div>

  <table class="clgen-doc-header-table">
    ${hRow('Name of School:', schoolName)}
    ${hRow('Location / Address:', location)}
    ${hRow('SY applied for:', sy)}
    ${hRow('Government Recognition No:', govRecogNo)}
    <tr>
      <td class="label">Government Permit No:</td>
      <td class="value" style="width:40%;">${_escHtml(govPermitNo)}</td>
      <td style="width:30px;padding:0 6px;font-size:12px;vertical-align:bottom;"> SY </td>
      <td style="border-bottom:1px solid #111;width:80px;"></td>
    </tr>
  </table>

  <div class="clgen-doc-items">${itemsHtml || '<div style="color:#9ca3af;font-size:12px;font-style:italic;">No items — add some using the editor on the left.</div>'}</div>

    ${findingsHtml}

    ${recosHtml}

    ${signatoryHtml}
</div>`;
}

/* ══════════════════════════════════════════════════════
   SCHOOL SEARCH
══════════════════════════════════════════════════════ */

async function _clgenLoadSchools() {
    if (_clgen.schoolsLoaded) return;
    try {
        const res = await fetch(
            (typeof CONFIG !== 'undefined' ? CONFIG.API_URL : '') + '/get-private-schools.php',
            { credentials: 'include' }
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        _clgen.schools = Array.isArray(json) ? json : (json.data || []);
        _clgen.schoolsLoaded = true;
    } catch(e) {
        console.warn('Could not load schools for checklist modal:', e);
        _clgen.schools = [];
    }
}

function clgenShowSchoolDd() {
    const q = (document.getElementById('clgen_schoolSearch')?.value || '').toLowerCase();
    _clgenRenderSchoolDd(q);
    const dd = document.getElementById('clgenSchoolDd');
    if (dd) dd.style.display = 'block';
}
function clgenHideSchoolDd() {
    const dd = document.getElementById('clgenSchoolDd');
    if (dd) dd.style.display = 'none';
}
function clgenFilterSchools(q) {
    _clgenRenderSchoolDd((q||'').toLowerCase());
    const dd = document.getElementById('clgenSchoolDd');
    if (dd) dd.style.display = 'block';
}
function _clgenRenderSchoolDd(q) {
    const dd = document.getElementById('clgenSchoolDd');
    if (!dd) return;
    const list = q
        ? _clgen.schools.filter(s => (s.name||'').toLowerCase().includes(q))
        : _clgen.schools;
    if (!list.length) {
        dd.innerHTML = '<div style="padding:10px 14px;font-size:13px;color:#9ca3af;">No schools found.</div>';
        return;
    }
    dd.innerHTML = list.slice(0, 60).map(s =>
        `<div onclick="clgenSelectSchool(${s.id})"
          style="padding:9px 14px;cursor:pointer;border-bottom:1px solid #f3f4f6;font-size:13px;"
          onmouseenter="this.style.background='#f9fafb'"
          onmouseleave="this.style.background=''">
          <div style="font-weight:600;color:#1e293b;">${_escHtml(s.name||'')}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${_escHtml(s.address||'')}</div>
        </div>`
    ).join('');
}
function clgenSelectSchool(id) {
    const s = _clgen.schools.find(x => Number(x.id) === Number(id));
    if (!s) return;
    _clgen.selectedSchoolId = Number(s.id);
    _clgenSetVal('clgen_schoolName', (s.name||'').toUpperCase());
    _clgenSetVal('clgen_location',   s.address || '');
    _clgenSetVal('clgen_schoolSearch', s.name || '');
    clgenHideSchoolDd();
    clgenUpdatePreview();
}

/* ══════════════════════════════════════════════════════
   SCHOOL YEAR DROPDOWN
══════════════════════════════════════════════════════ */

function _clgenPopulateSY(selected) {
    const sel = document.getElementById('clgen_sy');
    if (!sel) return;
    const cur = new Date().getFullYear();
    let opts = '<option value="">— Select School Year —</option>';
    for (let y = cur - 1; y <= cur + 3; y++) {
        const sy = `${y}-${y+1}`;
        opts += `<option value="${sy}"${sy === selected ? ' selected' : ''}>${sy}</option>`;
    }
    // If selected value not in range, add it
    if (selected && !sel.querySelector(`option[value="${selected}"]`)) {
        opts += `<option value="${selected}" selected>${selected}</option>`;
    }
    sel.innerHTML = opts;
    if (selected) sel.value = selected;
    else sel.value = `${cur}-${cur+1}`;
}

/* ══════════════════════════════════════════════════════
   MOBILE TABS
══════════════════════════════════════════════════════ */

function clgenSwitchTab(tab) {
    const left  = document.getElementById('clgenLeft');
    const right = document.getElementById('clgenRight');
    const btnF  = document.getElementById('clgenTabFields');
    const btnP  = document.getElementById('clgenTabPreview');
    if (!left || !right) return;
    if (tab === 'fields') {
        left.classList.remove('clgen-hidden');
        right.classList.add('clgen-hidden');
        btnF?.classList.add('active');
        btnP?.classList.remove('active');
    } else {
        right.classList.remove('clgen-hidden');
        left.classList.add('clgen-hidden');
        btnP?.classList.add('active');
        btnF?.classList.remove('active');
    }
}

/* ══════════════════════════════════════════════════════
   DOWNLOAD .DOCX
══════════════════════════════════════════════════════ */

async function clgenDownload() {
    if (!_clgen.type) {
        _clgenShowMsg('Please select a checklist type first.', 'error'); return;
    }
    const schoolName  = document.getElementById('clgen_schoolName')?.value?.trim();
    const sy          = document.getElementById('clgen_sy')?.value?.trim();
    if (!schoolName) { _clgenShowMsg('School Name is required.', 'error'); return; }
    if (!sy)         { _clgenShowMsg('School Year is required.', 'error'); return; }

    // Sync any textarea edits into state
    _clgen.items.forEach((item, idx) => {
        const el = document.querySelector(`#clgenRow_${idx} .clgen-item-text`);
        if (el) item.text = el.value;
    });

    const btn = document.getElementById('clgenDownloadBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'; }

    try {
        const schoolData = {
            schoolName,
            location:        document.getElementById('clgen_location')?.value?.trim()    || '',
            syApplied:       sy,
            govRecogNo:      document.getElementById('clgen_govRecogNo')?.value?.trim()  || '',
            govPermitNo:     document.getElementById('clgen_govPermitNo')?.value?.trim() || '',
            checklistType:   _clgen.type,
            items:           _clgen.items.map(i => ({
                id:    i.id,
                text:  i.text,
                sub:   !!i.sub,
                // Map 'na' → null so the docx generator renders "N/A" placeholder
                found: i.found === 'na' ? 'na' : i.found,
            })),
            evaluatedBy:      document.getElementById('clgen_evalName')?.value?.trim()  || 'MA. AUREA RHODORA DC. GERONIMO, PhD',
            evaluatedByTitle: document.getElementById('clgen_evalTitle')?.value?.trim() || 'Chief, SGOD/ In-Charge of Private Schools',
            findings:         document.getElementById('clgen_findings')?.value?.trim()  || '',
            recommendations:  document.getElementById('clgen_recommendations')?.value?.trim() || '',
        };

        // Use the extended generator that supports findings/recommendations + N/A
        const safeName = schoolName.replace(/[^a-zA-Z0-9 ]/g,'').trim().replace(/\s+/g,'_').slice(0,30);
        const safeSY   = sy.replace(/[-–]/g,'_');
        const fileName = `Checklist_${safeName}_SY${safeSY}.docx`;

        await generateChecklistDocxExtended(schoolData, { fileName, showCheckmarks: true });

        _clgenShowMsg('✓ Checklist downloaded successfully.', 'success');
        if (typeof showToast === 'function') showToast('Checklist downloaded!', 'success');

    } catch(err) {
        console.error('Checklist generation error:', err);
        _clgenShowMsg('Failed to generate: ' + (err.message || err), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-file-word"></i> Download .docx'; }
    }
}

/* ══════════════════════════════════════════════════════
   EXTENDED DOCX GENERATOR
   (Extends the base checklist-generator.js to support:
    - N/A items
    - OTHER FINDINGS text
    - RECOMMENDATIONS text
   )
══════════════════════════════════════════════════════ */

async function generateChecklistDocxExtended(school, options = {}) {
    const docxLib = window.docx;
    if (!docxLib) throw new Error('docx library not loaded.');

        const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            WidthType, BorderStyle, VerticalAlign, TabStopType } = docxLib;

    const FONT   = 'Calibri';
    const SZ_TTL = 26;
    const SZ     = 22;
    const PAGE_W = 12240;
    const MARGIN_LR = 1440; // 1.0 in
    const MARGIN_TB = 245;  // 0.17 in
    const CW     = PAGE_W - MARGIN_LR * 2;

    // ── Helpers ─────────────────────────────────────────────────────────────
    const noBorderStyle = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = {
        top: noBorderStyle,
        bottom: noBorderStyle,
        left: noBorderStyle,
        right: noBorderStyle,
        insideHorizontal: noBorderStyle,
        insideVertical: noBorderStyle,
    };
    const underlineBorder = { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } };

    const run = (text, opts = {}) => new TextRun({
        text, font: FONT, size: opts.size || SZ,
        bold: !!opts.bold, underline: opts.underline ? {} : undefined,
        color: '000000',
    });

    const para = (text, opts = {}) => {
        const children = Array.isArray(text) ? text : [run(text, opts)];
        return new Paragraph({
            alignment: opts.align || 'left',
            spacing: { before: opts.spBefore || 0, after: opts.spAfter || 0 },
            indent: opts.indent,
            border: opts.border,
            children,
        });
    };

    const rulePara = () => new Paragraph({
        spacing: { before: 0, after: 0 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
        children: [run('')],
    });

    // Filled text line (for findings / recommendations)
    const textPara = (text) => new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [run(text || '')],
    });

    // ── Header field 2-col table ─────────────────────────────────────────────
    const hFieldTable = (label, value) => {
        const LW = 3000, VW = CW - 3000;
        return new Table({
            width: { size: CW, type: WidthType.DXA },
            columnWidths: [LW, VW],
            borders: noBorders,
            rows: [new TableRow({ children: [
                new TableCell({
                    borders: noBorders, width: { size: LW, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.BOTTOM,
                    margins: { top:0, bottom:0, left:0, right:80 },
                    children: [para(label, { spAfter: 0 })],
                }),
                new TableCell({
                    borders: noBorders, width: { size: VW, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.BOTTOM,
                    children: [new Paragraph({
                        spacing: { before:0, after:0 },
                        border: underlineBorder,
                        children: [new TextRun({ text: value||'', font:FONT, size:SZ, color:'000000' })],
                    })],
                }),
            ]})],
        });
    };

    // ── Permit No row (4-col) ────────────────────────────────────────────────
    const permitTable = (value) => {
        const LW = 3000, VW = 2900, SL = 480, SV = CW - 3000 - 2900 - 480;
        const cellWith = (w, children, border) => new TableCell({
            borders: noBorders, width: { size: w, type: WidthType.DXA },
            verticalAlign: VerticalAlign.BOTTOM,
            margins: { top:0, bottom:0, left:0, right:80 },
            children: [new Paragraph({ spacing:{before:0,after:0}, border: border||undefined, children })],
        });
        return new Table({
            width: { size: CW, type: WidthType.DXA },
            columnWidths: [LW, VW, SL, SV], borders: noBorders,
            rows: [new TableRow({ children: [
                cellWith(LW, [new TextRun({ text:'Government Permit No:', font:FONT, size:SZ, color:'000000' })]),
                cellWith(VW, [new TextRun({ text:value||'', font:FONT, size:SZ, color:'000000', underline:value?{}:undefined })], underlineBorder),
                cellWith(SL, [new TextRun({ text:' SY ', font:FONT, size:SZ, color:'000000' })]),
                cellWith(SV, [new TextRun({ text:'', font:FONT, size:SZ })], underlineBorder),
            ]})],
        });
    };

    // ── Checklist item paragraph ──────────────────────────────────────────────
    const itemPara = (item, showCheckmarks) => {
        const found = item.found;
        let tick, label = '', rest = '';
        // Detect (a)/(b)/(c) at start
        const match = item.text && item.text.match(/^\((a|b|c)\)\s*(.*)$/i);
        if (item.sub && match) {
            label = match[1].toLowerCase();
            rest = match[2];
        }
        if (found === 'na')                      tick = 'N/A       ';
        else if (showCheckmarks && found === true)  tick = '   \u2714   ';
        else if (showCheckmarks && found === false) tick = '\u2718  ';
        else if (item.sub && match)  tick = '________(' + label + ')';
        else                                        tick = '________  ';

        const isBold = showCheckmarks && (found === true || found === false);
        if (item.sub) {
            let subTick;
            let subTail = '';
            if (match) {
                subTail = '(' + label + ')';
                if (found === 'na') subTick = 'N/A____';
                else if (showCheckmarks && found === true) subTick = '   \u2714   ';
                else if (showCheckmarks && found === false) subTick = '   \u2718   ';
                else subTick = '________';
            } else {
                if (found === 'na') subTick = 'N/A____';
                else if (showCheckmarks && found === true) subTick = '   \u2714   ';
                else if (showCheckmarks && found === false) subTick = '   \u2718   ';
                else subTick = '________';
            }

            const subText = match ? (rest || '') : (item.text || '');
            const leftWidth = 2200;
            const rightWidth = CW - leftWidth;
            return new Table({
                width: { size: CW, type: WidthType.DXA },
                columnWidths: [leftWidth, rightWidth],
                borders: noBorders,
                rows: [new TableRow({ children: [
                    new TableCell({
                        borders: noBorders,
                        width: { size: leftWidth, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.TOP,
                        margins: { top: 0, bottom: 0, left: 0, right: 80 },
                        children: [new Paragraph({
                            spacing: { before:0, after:0 },
                            alignment: match ? 'left' : 'center',
                            children: [
                                new TextRun({
                                    text: subTick,
                                    font: FONT,
                                    size: SZ,
                                    bold: isBold || found === 'na',
                                    color: '000000',
                                    underline: (showCheckmarks && (found === true || found === false)) ? {} : undefined,
                                }),
                                new TextRun({
                                    text: subTail,
                                    font: FONT,
                                    size: SZ,
                                    bold: false,
                                    color: '000000',
                                }),
                            ],
                        })],
                    }),
                    new TableCell({
                        borders: noBorders,
                        width: { size: rightWidth, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.TOP,
                        margins: { top: 0, bottom: 0, left: 0, right: 0 },
                        children: [new Paragraph({
                            spacing: { before:0, after:0 },
                            children: [
                                new TextRun({ text: subText, font:FONT, size:SZ, color:'000000' }),
                            ],
                        })],
                    }),
                ]})],
            });
        }

        const isMainNumber = !item.sub && /^\d+$/.test(String(item.id || ''));
        const numLabel = isMainNumber ? `${item.id}. ` : '';
        const leftWidth = 600;
        const rightWidth = CW - 600;
        return new Table({
            width: { size: CW, type: WidthType.DXA },
            columnWidths: [leftWidth, rightWidth],
            borders: noBorders,
            rows: [new TableRow({ children: [
                new TableCell({
                    borders: noBorders,
                    width: { size: leftWidth, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.TOP,
                    margins: { top: 0, bottom: 0, left: 0, right: 80 },
                    children: [new Paragraph({
                        spacing: { before: 0, after: 0 },
                        alignment: 'left',
                        children: [
                            new TextRun({
                                text: tick,   // ← only the tick/underline stays here
                                font: FONT,
                                size: SZ,
                                bold: isBold || found === 'na',
                                color: '000000',
                                underline: (showCheckmarks && found === true) ? {} : undefined,
                            }),
                        ],
                    })],
                }),
                new TableCell({
                    borders: noBorders,
                    width: { size: rightWidth, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.TOP,
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    children: [new Paragraph({
                        spacing: { before: 0, after: 0 },
                        children: [new TextRun({ text: (numLabel + (item.text || '')), font: FONT, size: SZ, color: '000000' })],
                    })],
                }),
            ]})],
        });
    };

    // ── Signature block ───────────────────────────────────────────────────────
    const sigBlock = (school) => {
        const evalName  = school.evaluatedBy      || 'MA. AUREA RHODORA DC. GERONIMO, PhD';
        const evalTitle = school.evaluatedByTitle || 'Chief, SGOD/ In-Charge of Private Schools';
        const LW = Math.floor(CW * 0.42), RW = CW - Math.floor(CW * 0.42);

        const blankLine = () => new Paragraph({
            spacing: { before: 0, after: 0 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
            children: [new TextRun({ text: '', font: FONT, size: SZ, color: '000000' })],
        });
        const textLine = (text, opts = {}) => new Paragraph({
            spacing: { before: opts.before ?? 0, after: 0 },
            alignment: opts.align || 'center',
            border: opts.underline ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } } : undefined,
            children: [new TextRun({ text: text || '', font: FONT, size: SZ, bold: !!opts.bold, color: '000000' })],
        });

        // const signatoryRows = [
        //     new TableRow({ children: [
        //         new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [textLine('Validated by:', { before: 0, align: 'left', bold: true })] }),
        //         new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine('Processed/Evaluated by:', { before: 0, align: 'right', bold: true })] }),
        //     ]}),
        //     new TableRow({ children: [
        //         new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine(), textLine('Name', { before: 40, align: 'center', bold: true })] }),
        //         new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine(evalName, { before: 220, align: 'center', bold: true, underline: true })] }),
        //     ]}),
        //     new TableRow({ children: [
        //         new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine(), textLine('RO-QAD', { before: 40, align: 'center', bold: true })] }),
        //         new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine(evalTitle, { before: 80, align: 'center', bold: true })] }),
        //     ]}),
        //     new TableRow({ children: [
        //         new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 220, after: 0 }, children: [] })] }),
        //         new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [blankLine(), textLine('Date', { before: 40, align: 'center', bold: true })] }),
        //     ]}),
        // ];

        const signatoryRows = [
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine('Processed/Evaluated by:', { before: 0, align: 'left', bold: true })] }),
            ]}),
            // new TableRow({ children: [
            //     new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 40, after: 0 }, children: [] })] }),
            //     new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine()] }),
            // ]}),
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine(evalName, { before: 220, align: 'center', bold: true, underline: true })] }),
            ]}),
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: RW, type: WidthType.DXA }, children: [textLine(evalTitle, { before: 0, align: 'center', bold: true })] }),
            ]}),
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [textLine('Validated by:', { before: 0, align: 'left', bold: true })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
            ]}),
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine(), textLine('Name', { before: 0, align: 'center', bold: true })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [new Paragraph({ spacing:{ before: 0, after: 0 }, children: [] })] }),
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine(), textLine('Date', { before: 0, align: 'center', bold: true })] }),
            ]}),
            new TableRow({ children: [
                new TableCell({ borders: noBorders, width:{ size: LW, type: WidthType.DXA }, children: [blankLine(), textLine('RO-QAD', { before: 0, align: 'center', bold: true })] }),
            ]}),
        ];

        return new Table({
            width: { size:CW, type:WidthType.DXA },
            columnWidths: [LW, RW],
            borders: noBorders,
            rows: signatoryRows,
        });
    };

    // ── Build all children ────────────────────────────────────────────────────
    const showCheckmarks = options.showCheckmarks !== false;
    const type  = school.checklistType === 'no_increase' ? 'no_increase' : 'tuition_increase';
    const items = (school.items && school.items.length) ? school.items : [];

    const titleLine1 = type === 'no_increase'
        ? 'Processing Checklist for Application for No Increase in School Fees'
        : 'Processing Checklist for Application for Increase & Notation in School Fees';

    const children = [
        para(titleLine1,     { align:'center', bold:true, size:SZ_TTL, spAfter:0 }),
        para('In Private Pre-Elementary, Elementary and Junior High Schools', { align:'center', bold:true, size:SZ_TTL, spAfter:0 }),
        para('( per D.O No. 12,  s. 1997)', { align:'center', bold:true, size:SZ_TTL, spAfter:0 }),

        hFieldTable('Name of School:',            school.schoolName || ''),
        hFieldTable('Location / Address:',        school.location   || ''),
        hFieldTable('SY applied for:',            school.syApplied  || ''),
        hFieldTable('Government Recognition No:', school.govRecogNo || ''),
        permitTable(school.govPermitNo || ''),

        para('', { spAfter:5 }) // Extra spacing before items,
    ];

    // Items
    items.forEach(item => children.push(itemPara(item, showCheckmarks)));

    children.push(para('', { spAfter:0 }));

    const sectionTable = (label, value) => {
        const LW = Math.floor(CW * 0.31);
        const RW = CW - LW;
        const lineRow = (text) => new TableRow({ children: [
            new TableCell({
                borders: noBorders,
                width: { size: LW, type: WidthType.DXA },
                margins: { top: 0, bottom: 0, left: 0, right: 80 },
                children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: '', font: FONT, size: SZ })] })],
            }),
            new TableCell({
                borders: noBorders,
                width: { size: RW, type: WidthType.DXA },
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                children: [new Paragraph({
                    spacing: { before: 0, after: 0 },
                    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
                    children: [new TextRun({ text: text || '', font: FONT, size: SZ, color: '000000' })],
                })],
            }),
        ]});

        return new Table({
            width: { size: CW, type: WidthType.DXA },
            columnWidths: [LW, RW],
            borders: noBorders,
            rows: [
                new TableRow({ children: [
                    new TableCell({
                        borders: noBorders,
                        width: { size: LW, type: WidthType.DXA },
                        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: label, font: FONT, size: SZ, color: '000000' })] })],
                    }),
                    new TableCell({
                        borders: noBorders,
                        width: { size: RW, type: WidthType.DXA },
                        children: [new Paragraph({
                            spacing: { before: 0, after: 0 },
                            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
                            children: [new TextRun({ text: value || '', font: FONT, size: SZ, color: '000000' })],
                        })],
                    }),
                ]}),
                lineRow(''),
                lineRow(''),
                lineRow(''),
            ],
        });
    };

    children.push(sectionTable('OTHER FINDINGS (specify)', school.findings || ''));
    children.push(para('', { spAfter:0 }));
    children.push(sectionTable('RECOMMENDATIONS', school.recommendations || ''));
    children.push(para('', { spAfter:0 }));
    children.push(sigBlock(school));

    // ── Assemble doc ──────────────────────────────────────────────────────────
    const doc = new Document({
        styles: { default: { document: { run: { font: FONT, size: SZ } } } },
        sections: [{
            properties: {
                page: {
                    size: { width: PAGE_W, height: 15840 },
                    margin: { top: MARGIN_TB, right: MARGIN_LR, bottom: MARGIN_TB, left: MARGIN_LR },
                },
            },
            children,
        }],
    });

    const blob = await Packer.toBlob(doc);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = options.fileName || 'processing_checklist.docx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/* ══════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════ */

function _clgenSetVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function _clgenShowMsg(text, type = 'error') {
    const el = document.getElementById('clgenMsg');
    if (!el) return;
    el.style.display = 'block';
    el.className = type;
    el.textContent = text;
}

function _clgenHideMsg() {
    const el = document.getElementById('clgenMsg');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
}

// Reuse the global _escHtml if available, otherwise define locally
if (typeof _escHtml === 'undefined') {
    window._escHtml = function(v) {
        return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    };
}

/* ══════════════════════════════════════════════════════
   BUILT-IN DEFAULTS  (fallback if CHECKLIST_ITEM_DEFAULTS unavailable)
══════════════════════════════════════════════════════ */

const _clgenBuiltInDefaults = {
    tuition_increase: [
        { id:1,    sub:false, text:'Date received by DepEd RO III, City of San Fernando, Pampanga (submission should be on or before May 15)' },
        { id:2,    sub:false, text:"Letter of advice to the Regional Office signed by the School Head, indicating among others the school\u2019s intention to comply with the provision of R.A. 6728 for the forthcoming SY ___________________." },
        { id:3,    sub:false, text:'Xerox copy of the approved tuition, miscellaneous and other schools fees SY _____________ (previous school year or latest noted fees).' },
        { id:4,    sub:false, text:'Comparative Schedule of tuition, miscellaneous and other school fees for current school year with that of the previous year indicating in both peso and percentage the forms of increase.' },
        { id:5,    sub:false, text:'Percentage of increase of tuition/miscellaneous & other fees.' },
        { id:6,    sub:false, text:'Certification under Oath (notarized by a duly licensed notary public) signed by the School Head that the following requirements of R.A. 6728 have been complied with namely; (a), (b) and (c):' },
        { id:'6a', sub:true,  text:'(a) Appropriate consultations have been conducted with duly organized PTA / PTCA and Faculty Association.' },
        { id:'6a2',sub:true,  text:'Copy of excerpts of the minutes of the meeting of PTCA or Family Council Association should be submitted.' },
        { id:'6a3',sub:true,  text:'Date of consultation should not be later than March 30.' },
        { id:'6b', sub:true,  text:'(b) Seventy percent (70%) of the amount of tuition fee increase (incremental proceeds) of the previous school year went to the increase of payment in salaries, wages and other benefits of teaching and non-teaching personnel.' },
        { id:'6b2',sub:true,  text:'Copy of the proof of such increases such as Xerox copies of payroll (before and after the increase) of the concerned teachers and support staff.' },
        { id:'6c', sub:true,  text:'(c) At least twenty percent (20%) went to the improvement or modernization of building, equipment, libraries and similar facilities.' },
    ],
    no_increase: [
        { id:1, sub:false, text:'Date received by DepEd RO III, City of San Fernando, Pampanga (submission should be on or before May 15)' },
        { id:2, sub:false, text:'Letter declaring No Increase in tuition and other fees for the school year signed by the School Head.' },
        { id:3, sub:false, text:'Comparative Schedule of tuition, miscellaneous and other school fees showing no change from the previous school year.' },
        { id:4, sub:false, text:'Signed certification by School Head that there is no increase in any fee for the forthcoming SY.' },
        { id:5, sub:false, text:'Government Recognition / Permit Number on file.' },
        { id:6, sub:false, text:'1st Indorsement from the Schools Division.' },
    ],
};

/* ══════════════════════════════════════════════════════
   WIRE UP  "Generate checklist" HEADER BUTTON
   (replaces / wraps the existing generateChecklistFromReport)
══════════════════════════════════════════════════════ */

// Override the existing button handler so it opens the new modal
// (the original function can still be called separately if needed)
const _originalGenerateChecklistFromReport = window.generateChecklistFromReport;
window.generateChecklistFromReport = function() {
    // Try to pre-fill from current Step 3 report first
    const fromReport = _clgenPrefillFromCurrentReport();
    openChecklistGeneratorModal(fromReport || undefined);
};

// Expose helper so record cards can open the modal pre-filled
window.openChecklistGeneratorFromRecord = function(id) {
    const r = (typeof _allRecords !== 'undefined' ? _allRecords : []).find(x => x.id === id);
    const prefill = r ? _clgenPrefillFromRecord(r) : null;
    openChecklistGeneratorModal(prefill || undefined);
};
