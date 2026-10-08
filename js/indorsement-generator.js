/**
 * indorsement-generator.js  –  v2 (redesigned, bug-fixed)
 * Depends on: docx UMD, showToast(), CONFIG.API_URL
 *
 * FIXES applied:
 *  1. .docx body runs now correctly use the updated _indComposeParagraph rich keys
 *  2. Dead `levelText` arg removed from _indComposeParagraph call in generateStandaloneIndorsement
 *  3. _indComposeParagraph: days-only (no dates) case no longer produces garbled sentence
 *  4. HTML fix noted: ind_signatoryWrap duplicate display: style (fix in HTML file)
 *  5. _indPreviewBound reset to false in openIndorsementModal
 *  6. _indSelectNum(1) called in openIndorsementModal to visually reset number buttons
 *  7. saveIndorsement: uses local `sy` variable directly instead of fragile saved.school_year
 *  8. closeIndorsementModal split into direct-close vs overlay-click handler
 */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
let _indSchools = [];
let _indSchoolsLoaded = false;
let _indPersonnel = [];
let _indPersonnelLoaded = false;
let _indCurrentType = null;
let _indSelectedSchoolId = null;
let _indSelectedPrivateSchoolId = null;

const _indTypeMeta = {
    school_calendar: {
        label: 'School Calendar',
        fullLabel: 'School Calendar Indorsement',
        color: '#0369a1', bg: '#f0f9ff', border: '#bae6fd',
        icon: 'fa-calendar-days',
        categoryKey: 'school_calendar',
        steps: { 1: ['Endorsed to RO'], 3: ['Approved'] }
    },
    tuition_increase: {
        label: 'Tuition Fee Increase',
        fullLabel: 'Tuition Fee Increase Indorsement',
        color: '#166534', bg: '#f0fdf4', border: '#bbf7d0',
        icon: 'fa-arrow-trend-up',
        categoryKey: 'tuition_increase',
        steps: { 1: ['Endorsed to RO'], 3: ['Approved'] }
    },
    no_increase: {
        label: 'No Increase',
        fullLabel: 'No Increase Indorsement',
        color: '#92400e', bg: '#fffbeb', border: '#fde68a',
        icon: 'fa-minus-circle',
        categoryKey: 'no_increase',
        steps: { 1: ['Endorsed to RO'], 3: ['Approved'] }
    },
    school_permit: {
        label: 'School Permit',
        fullLabel: 'School Permit Indorsement',
        color: '#6b21a8', bg: '#faf5ff', border: '#d8b4fe',
        icon: 'fa-id-card',
        categoryKey: 'renewal_permit',
        steps: { 1: ['Endorsed to RO'], 3: ['Approved'] }
    },
};

/* ══════════════════════════════════════════════════════
   TYPE ALIASES  —  FIX: "Generate Indorsement" for permits
   silently failed to save.

   Root cause: elsewhere in the app (documents-submitted.php,
   summary-report.js CATEGORIES, and this file's own `categoryKey`
   field) the Permit document type is keyed as "renewal_permit"
   (or the short form "permit"). Whatever caller opens this modal
   for a permit row passes that same key in as `prefill.checklistType`,
   which used to flow straight into _indCurrentType unvalidated and
   then into the save payload's `type` field. school-indorsements.php
   only accepts the literal "school_permit", so the save request was
   rejected with a 400 and nothing ever landed in school_indorsements
   (hence: never shown in the Indorsements view / counts stayed 0).

   This map normalizes any known alias to the canonical key that
   _indTypeMeta / VALID_IND_TYPES on the backend actually expect,
   so it doesn't matter which key an upstream caller passes in.
══════════════════════════════════════════════════════ */
const _indTypeAliases = {
    renewal_permit: 'school_permit',
    permit:         'school_permit',
    calendar:       'school_calendar',
    tuition:        'tuition_increase',
    no_tuition:     'no_increase',
};

function _indNormalizeType(type) {
    const t = String(type || '').trim();
    return _indTypeAliases[t] || t;
}

/**
 * FIX: normalize school-year strings so "2026-2027" (hyphen) and
 * "2026–2027" (en dash — easy to get from autocorrect/smart-punctuation
 * when the value is typed or pasted somewhere upstream) are always
 * treated as the same year. Without this, a permit indorsement saved
 * with a mismatched dash silently fails to match the year filter in
 * the Indorsements view, even though the row is really there.
 */
function _indNormalizeSY(sy) {
    return String(sy || '').trim().replace(/\s*[\u2010-\u2015\u2212-]\s*/g, '-');
}

/* Ordinal label for an indorsement number (1 -> "1st", 2 -> "2nd", ...).
   Used to make the saved-status badge and the post-save confirmation
   banner read the same way the number buttons above them already do
   ("1st", "2nd", "3rd"...), instead of a bare "#1" / "1 indorsement(s)". */
function _indOrdinal(n) {
    const num = parseInt(n, 10) || 0;
    const mod100 = num % 100;
    if (mod100 >= 11 && mod100 <= 13) return num + 'th';
    switch (num % 10) {
        case 1:  return num + 'st';
        case 2:  return num + 'nd';
        case 3:  return num + 'rd';
        default: return num + 'th';
    }
}

const _indLevelOptions = [
    { value: 'pre_elem', label: 'Pre-Elementary Course', shortLabel: 'Pre-Elementary' },
    { value: 'elem',     label: 'Elementary Course',     shortLabel: 'Elementary' },
    { value: 'jhs',      label: 'Junior High School Course', shortLabel: 'Junior High School' },
    { value: 'shs',      label: 'Senior High School Course', shortLabel: 'Senior High School' },
];

/* ══════════════════════════════════════════════════════
   LEVEL HELPERS
══════════════════════════════════════════════════════ */

function _indGetSelectedLevelValues() {
    const sel = document.getElementById('ind_levelSelect');
    if (!sel) return [];
    return Array.from(sel.options).filter(o => o.selected).map(o => o.value).filter(Boolean);
}

function _indComposeLevelTextFromValues(values) {
    const order = _indLevelOptions.map(o => o.value);
    const selected = order.filter(v => (values || []).includes(v));
    if (!selected.length) return '';
    const idxs = selected.map(v => order.indexOf(v));
    const contiguous = idxs.every((n, i) => i === 0 || n === idxs[i - 1] + 1);
    if (contiguous && selected.length >= 3) {
        const first = _indLevelOptions.find(o => o.value === selected[0]);
        const last  = _indLevelOptions.find(o => o.value === selected[selected.length - 1]);
        return `${first.shortLabel} to ${last.shortLabel} Courses`;
    }
    const labels = selected.map(v => (_indLevelOptions.find(o => o.value === v) || {}).label).filter(Boolean);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function _indUpdateLevelFromSelect() {
    const levelHidden = document.getElementById('ind_level');
    if (levelHidden) levelHidden.value = _indComposeLevelTextFromValues(_indGetSelectedLevelValues());
    _indUpdatePreview();
}

function _indSetLevelSelectionFromText(levelText) {
    const sel = document.getElementById('ind_levelSelect');
    if (!sel) return;
    const txt = String(levelText || '').toLowerCase();
    Array.from(sel.options).forEach(o => {
        const opt = _indLevelOptions.find(x => x.value === o.value);
        const label      = (opt?.label || '').toLowerCase();
        const shortLabel = (opt?.shortLabel || '').toLowerCase();
        o.selected = !!txt && (txt.includes(label) || (shortLabel && txt.includes(shortLabel)));
    });
    _indUpdateLevelFromSelect();
}

/* ══════════════════════════════════════════════════════
   TYPE SELECTION
══════════════════════════════════════════════════════ */

function _indSetType(type) {
    // FIX: normalize aliases like 'permit' / 'renewal_permit' -> 'school_permit'
    // so this always matches a real key in _indTypeMeta and the backend's
    // VALID_IND_TYPES, no matter what the caller passes in.
    type = _indNormalizeType(type);
    _indCurrentType = type;

    Object.keys(_indTypeMeta).forEach(t => {
        const btn  = document.getElementById('ind_typeBtn_' + t);
        const meta = _indTypeMeta[t];
        if (!btn) return;
        if (t === type) {
            btn.style.background   = meta.bg;
            btn.style.borderColor  = meta.border;
            btn.style.color        = meta.color;
            btn.style.fontWeight   = '700';
            btn.style.boxShadow    = '0 0 0 3px ' + meta.border;
        } else {
            btn.style.background   = '#fff';
            btn.style.borderColor  = '#e5e7eb';
            btn.style.color        = '#6b7280';
            btn.style.fontWeight   = '600';
            btn.style.boxShadow    = 'none';
        }
    });

    const titleEl = document.getElementById('ind_modalTitle');
    if (titleEl) {
        const meta = _indTypeMeta[type] || _indTypeMeta.school_calendar;
        titleEl.innerHTML = `<i class="fa-solid ${meta.icon}" style="margin-right:6px;color:${meta.color};"></i>${meta.fullLabel}`;
    }

    const fieldsSection = document.getElementById('ind_fieldsSection');
    if (fieldsSection) {
        fieldsSection.style.display   = '';
        fieldsSection.style.opacity   = '0';
        fieldsSection.style.transform = 'translateY(8px)';
        requestAnimationFrame(() => {
            fieldsSection.style.transition = 'opacity .25s ease, transform .25s ease';
            fieldsSection.style.opacity    = '1';
            fieldsSection.style.transform  = 'translateY(0)';
        });
    }

    const calFields = document.getElementById('ind_calendarFields');
    if (calFields) calFields.style.display = (type === 'school_calendar') ? '' : 'none';

    const levelRow = document.getElementById('ind_levelRow');
    if (levelRow) levelRow.style.display = '';

    _indUpdateIndNoteLabel();
    _indUpdatePreview();
    _indUpdateSaveButtonState();
    if (_indSelectedSchoolId || _indSelectedPrivateSchoolId) {
        _indLoadSavedStatus(_indSelectedSchoolId || _indSelectedPrivateSchoolId);
    }
}

/* Number button selection helper */
function _indSelectNum(n) {
    const numEl = document.getElementById('ind_numberSelect');
    if (numEl) numEl.value = String(n);
    [1, 2, 3, 4, 5, 6].forEach(i => {
        const btn = document.getElementById('ind_numBtn' + i);
        if (!btn) return;
        if (i === n) {
            btn.style.borderColor = '#bae6fd';
            btn.style.background = '#f0f9ff';
            btn.style.color = '#0369a1';
        } else {
            btn.style.borderColor = '#e5e7eb';
            btn.style.background = '#fff';
            btn.style.color = '#6b7280';
        }
    });
    if (typeof _indUpdatePreview === 'function') _indUpdatePreview();
    if (_indSelectedSchoolId || _indSelectedPrivateSchoolId) {
        _indLoadSavedStatus(_indSelectedSchoolId || _indSelectedPrivateSchoolId);
    }
}

function _indUpdateIndNoteLabel() {
    const el = document.getElementById('ind_flowNote');
    if (!el || !_indCurrentType) return;
    const meta = _indTypeMeta[_indCurrentType];
    el.innerHTML =
        `<i class="fa-solid fa-circle-info" style="margin-right:5px;color:${meta.color};"></i>` +
        `<strong>Flow:</strong> You (admin) create <em>1st Indorsement</em> → RO creates 2nd → ` +
        `You create <em>3rd Indorsement</em> for school → RO creates 4th → ` +
        `You create <em>5th Indorsement</em> → Final <em>6th Indorsement</em> as needed.<br>` +
        `<span style="opacity:.75;font-size:11px;">Saving a 1st indorsement checks <strong>Endorsed to RO</strong> in the tracker. Saving a 3rd checks <strong>Approved</strong>.</span>`;
}

/* ══════════════════════════════════════════════════════
   SIGNATORY TOGGLE
══════════════════════════════════════════════════════ */

function _indToggleSignatory() {
    const wrap = document.getElementById('ind_signatoryWrap');
    const btn  = document.getElementById('ind_changeSignatoryBtn');
    if (!wrap || !btn) return;
    const isVisible = wrap.style.display !== 'none' && wrap.style.display !== '';
    wrap.style.display = isVisible ? 'none' : 'flex';
    btn.innerHTML = isVisible
        ? '<i class="fa-solid fa-user-pen" style="margin-right:5px;"></i>Change Signatory Name'
        : '<i class="fa-solid fa-chevron-up" style="margin-right:5px;"></i>Hide Signatory';
}

/* ══════════════════════════════════════════════════════
   SCHOOL LOADING & DROPDOWN
══════════════════════════════════════════════════════ */

async function _indLoadSchools() {
    if (_indSchoolsLoaded) return;
    try {
        const res  = await fetch(CONFIG.API_URL + '/get-private-schools.php', { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        _indSchools       = Array.isArray(json) ? json : (json.data || []);
        _indSchoolsLoaded = true;
    } catch (e) {
        console.warn('Could not load private schools:', e);
        _indSchools = [];
    }
}

function _indShowSchoolDropdown() {
    const q = (document.getElementById('ind_schoolSearch')?.value || '').toLowerCase();
    _indRenderSchoolDropdown(q);
    const dd = document.getElementById('ind_schoolDropdown');
    if (dd) dd.style.display = 'block';
}
function _indHideSchoolDropdown() {
    const dd = document.getElementById('ind_schoolDropdown');
    if (dd) dd.style.display = 'none';
}
function _indFilterSchools(q) {
    _indRenderSchoolDropdown((q || '').toLowerCase());
    const dd = document.getElementById('ind_schoolDropdown');
    if (dd) dd.style.display = 'block';
}

function _indRenderSchoolDropdown(q) {
    const dd = document.getElementById('ind_schoolDropdown');
    if (!dd) return;
    const filtered = q ? _indSchools.filter(s => (s.name || '').toLowerCase().includes(q)) : _indSchools;
    if (!filtered.length) {
        dd.innerHTML = '<div style="padding:12px 14px;font-size:13px;color:var(--color-text-secondary);">No schools found.</div>';
        return;
    }
    dd.innerHTML = filtered.slice(0, 60).map(s =>
        `<div onclick="_indSelectSchool(${s.id})"
              style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--color-border-tertiary,#f3f4f6);"
              onmouseenter="this.style.background='var(--color-background-secondary,#f9fafb)'"
              onmouseleave="this.style.background=''">
            <div style="font-size:13px;font-weight:600;color:var(--color-text-primary);">${s.name || ''}</div>
            <div style="font-size:11px;color:var(--color-text-secondary);margin-top:1px;">${s.address || ''}</div>
        </div>`
    ).join('');
}

function _indSelectSchool(id) {
    const s = _indSchools.find(x => Number(x.id) === Number(id));
    if (!s) return;
    _indSelectedSchoolId = Number(s.id);
    _indSetVal('ind_schoolName', (s.name || '').toUpperCase());
    _indSetVal('ind_address', s.address || '');
    _indSetVal('ind_schoolSearch', s.name || '');
    _indHideSchoolDropdown();
    _indUpdatePreview();
    _indUpdateSaveButtonState();
    indClearMsg();
    _indLoadSavedStatus(Number(s.id));
}

async function _indLoadSavedStatus(schoolId) {
    const badge   = document.getElementById('ind_savedBadge');
    const saveBtn = document.getElementById('ind_saveBtn');
    if (!badge) return;
    badge.style.display = 'none';
    if (saveBtn) {
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Indorsement';
    }
    if (!schoolId || !_indCurrentType) return;
    try {
        const indNum = parseInt(document.getElementById('ind_numberSelect')?.value || '1', 10);
        const params = new URLSearchParams({
            school_id:         schoolId,
            private_school_id: _indSelectedPrivateSchoolId || '',
            type:              _indCurrentType,
            ind_number:        indNum,
        });
        const url = CONFIG.API_URL + `/school-indorsements.php?action=status&${params}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return;
        const json = await res.json();
        if (json && json.count > 0) {
            const ord = _indOrdinal(indNum);
            badge.innerHTML =
                `<i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>` +
                `<strong>${ord} Indorsement</strong> already saved for this school — saving again will update it.`;
            badge.style.cssText = 'display:flex;align-items:center;margin-top:6px;font-size:12px;font-weight:500;padding:8px 12px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;';
            if (saveBtn) {
                saveBtn.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Update ${ord} Indorsement`;
            }
        }
    } catch (e) { /* silently ignore */ }
}

/* ══════════════════════════════════════════════════════
   PERSONNEL
══════════════════════════════════════════════════════ */

async function _indLoadPersonnel() {
    if (_indPersonnelLoaded) return;
    try {
        const res  = await fetch(CONFIG.API_URL + '/directory.php', { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        _indPersonnel       = Array.isArray(json) ? json : (json.data || []);
        _indPersonnelLoaded = true;
    } catch (e) {
        console.warn('Could not load personnel directory:', e);
        _indPersonnel = [];
    }
}

function _indShowPersonnelDropdown() {
    const q = (document.getElementById('ind_personnelSearch')?.value || '').toLowerCase();
    _indRenderPersonnelDropdown(q);
    const dd = document.getElementById('ind_personnelDropdown');
    if (dd) dd.style.display = 'block';
}
function _indHidePersonnelDropdown() {
    const dd = document.getElementById('ind_personnelDropdown');
    if (dd) dd.style.display = 'none';
}
function _indFilterPersonnel(q) {
    _indRenderPersonnelDropdown((q || '').toLowerCase());
    const dd = document.getElementById('ind_personnelDropdown');
    if (dd) dd.style.display = 'block';
}

function _indRenderPersonnelDropdown(q) {
    const dd = document.getElementById('ind_personnelDropdown');
    if (!dd) return;
    const filtered = q
        ? _indPersonnel.filter(p =>
            (p.name     || '').toLowerCase().includes(q) ||
            (p.position || '').toLowerCase().includes(q) ||
            (p.unit     || '').toLowerCase().includes(q))
        : _indPersonnel;
    if (!filtered.length) {
        dd.innerHTML = '<div style="padding:12px 14px;font-size:13px;color:var(--color-text-secondary);">No personnel found.</div>';
        return;
    }
    dd.innerHTML = filtered.slice(0, 50).map(p =>
        `<div onclick="_indSelectPersonnel(${p.id})"
              style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--color-border-tertiary,#f3f4f6);"
              onmouseenter="this.style.background='var(--color-background-secondary,#f9fafb)'"
              onmouseleave="this.style.background=''">
            <div style="font-size:13px;font-weight:600;color:var(--color-text-primary);">${p.name || ''}</div>
            <div style="font-size:11px;color:var(--color-text-secondary);margin-top:1px;">${(p.position || '')}${p.unit ? ' · ' + p.unit : ''}</div>
        </div>`
    ).join('');
}

function _indSelectPersonnel(id) {
    const p = _indPersonnel.find(x => Number(x.id) === Number(id));
    if (!p) return;
    _indSetVal('ind_sigName',        (p.name || '').toUpperCase());
    _indSetVal('ind_sigPosition',    p.position || '');
    _indSetVal('ind_personnelSearch', p.name || '');
    _indHidePersonnelDropdown();
    _indUpdatePreview();
    indClearMsg();
}

function _indPrefillSignatory() {
    const nameEl = document.getElementById('ind_sigName');
    const posEl  = document.getElementById('ind_sigPosition');
    if (!nameEl || !posEl) return;
    if (nameEl.value.trim()) return;
    const sds = _indPersonnel.find(p =>
        (p.position || '').toLowerCase().includes('schools division superintendent') &&
        !(p.position || '').toLowerCase().includes('assistant')
    );
    if (sds) {
        nameEl.value = (sds.name || '').toUpperCase();
        posEl.value  = sds.position || 'Schools Division Superintendent';
    } else {
        nameEl.value = 'ROWENA T. QUIAMBAO, CESO VI';
        posEl.value  = 'Schools Division Superintendent';
    }
    _indUpdatePreview();
}

/* ══════════════════════════════════════════════════════
   SCHOOL YEAR OPTIONS
══════════════════════════════════════════════════════ */

function _indPopulateSchoolYearOptions(selectedValue) {
    const sel = document.getElementById('ind_sy');
    if (!sel) return;
    const currentYear = new Date().getFullYear();
    const options = [];
    for (let y = currentYear - 1; y <= currentYear + 3; y++) {
        const sy = y + '-' + (y + 1);
        options.push(`<option value="${sy}">${sy}</option>`);
    }
    sel.innerHTML = '<option value="">— Select School Year —</option>' + options.join('');
    if (selectedValue) {
        if (!Array.from(sel.options).some(o => o.value === selectedValue)) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = selectedValue;
            sel.appendChild(opt);
        }
        sel.value = selectedValue;
    } else {
        sel.value = currentYear + '-' + (currentYear + 1);
    }
}

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */

function _indFormatDate(val) {
    if (!val) return null;
    const d = new Date(val + 'T00:00:00');
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function _indTodayFormatted() {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function _indRefNum() {
    const n = new Date();
    return String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0') + '-' + n.getFullYear();
}
function _indSetVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

/* ══════════════════════════════════════════════════════
   PARAGRAPH COMPOSERS
   FIX #3: _indComposeParagraph now handles all three cases cleanly:
     a) startDate + endDate (+ optional totalDays)
     b) totalDays only (no dates)  — sentence no longer says "which will start on"
     c) neither — ends with period after SY
══════════════════════════════════════════════════════ */

function _indComposeParagraph(schoolName, address, sy, totalDays, startDate, endDate) {
    const base = 'Respectfully forwarded to the Regional Director, DepEd Region III, Government Center, Maimpis, City of San Fernando, Pampanga (Attention: Quality Assurance Division- Focal Person In-Charge of Private Schools), the herein request of the School Head, ';

    let afterSchoolBeforeLevel, afterLevel, daysBold;

    if (startDate && endDate) {
        // Case a: dates are present — use "which will start on X to Y"
        afterSchoolBeforeLevel = `, ${address || ''}, this Schools Division, for the School Calendar of Activities, SY ${sy || '____-____'} which will start on `;
        afterLevel = `${startDate} to ${endDate}`;
        afterLevel += totalDays ? ', with a total of ' : '.';
        daysBold   = totalDays ? `${totalDays} days.` : '';
    } else if (totalDays) {
        // Case b: no dates, but days provided — avoid "which will start on" prefix
        afterSchoolBeforeLevel = `, ${address || ''}, this Schools Division, for the School Calendar of Activities, SY ${sy || '____-____'}, with a total of `;
        afterLevel = '';
        daysBold   = `${totalDays} days.`;
    } else {
        // Case c: nothing extra — clean sentence ending
        afterSchoolBeforeLevel = `, ${address || ''}, this Schools Division, for the School Calendar of Activities, SY ${sy || '____-____'}.`;
        afterLevel = '';
        daysBold   = '';
    }

    return {
        rich: {
            before: base,
            schoolBold: schoolName || '',
            afterSchoolBeforeLevel,
            afterLevel,
            daysBold,
        }
    };
}

function _indComposeParagraphTuition(schoolName, address, sy) {
    const base       = 'Respectfully forwarded to the Regional Director, DepEd Region III, Government Center, Maimpis, City of San Fernando, Pampanga (Attention: Quality Assurance Division- Focal Person In-Charge of Private Schools), the herein request of the School Head of ';
    const afterSchool = ', ' + address + ', this Schools Division, for approval of the proposed Tuition and Miscellaneous Fee Increase for School Year ' + (sy || '____-____') + ', recommending favorable action.';
    return { rich: { before: base, schoolBold: schoolName, afterSchool, daysBold: '' } };
}

function _indComposeParagraphNoIncrease(schoolName, address, sy, level) {
    const afterSchool = ', located at ' + address + ', this Schools Division, for ';
    const boldPart    = 'NO INCREASE';
    const afterBold   = ' in tuition and miscellaneous fees in ' + (level || '[Level]') + ', School Year ' + (sy || '____-____') + ', for information and guidance.';
    return {
        rich: { before: 'Respectfully returned to the School Head of ', schoolBold: schoolName, afterSchool, noIncreaseBold: boldPart, afterBold },
    };
}

function _indComposeParagraphSchoolPermit(schoolName, address, sy, level) {
    const base        = 'Respectfully forwarded to the Regional Director, DepEd, Region III, Government Center, Maimpis, City of San Fernando, Pampanga (Attention: Quality Assurance Division), the herein application of the School Principal, ';
    const afterSchool = ', located at ' + address + ', this Schools Division, on the approval of the ';
    const renewalBold = 'Renewal of Permit';
    const levelText   = (level || '').trim();
    const levelPart   = levelText ? (' for ' + levelText + ',') : '';
    const afterBold   = levelPart + ' School Year ' + (sy || '____-____') + ', with full compliance to the requirements, for notation.';
    return { rich: { before: base, schoolBold: schoolName, afterSchool, noIncreaseBold: renewalBold, afterBold } };
}

/* ══════════════════════════════════════════════════════
   MODAL OPEN / CLOSE
   FIX #5: _indPreviewBound reset on open
   FIX #6: _indSelectNum(1) called to visually reset number buttons
   FIX #8: closeIndorsementModal split into direct vs overlay-click
══════════════════════════════════════════════════════ */

async function openIndorsementModal(prefill) {
    const todayISO = new Date().toISOString().slice(0, 10);
    _indCurrentType      = null;
    _indSelectedSchoolId = null;
    _indSelectedPrivateSchoolId = null;

    // FIX #5: reset listener-bound flag so listeners re-attach cleanly
    _indPreviewBound = false;

    // Reset form fields
    ['ind_schoolName', 'ind_address', 'ind_sy', 'ind_days', 'ind_startDate', 'ind_endDate',
        'ind_letterDate', 'ind_sigName', 'ind_sigPosition', 'ind_personnelSearch', 'ind_schoolSearch', 'ind_level'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.readOnly = false; el.disabled = false; el.style.background = ''; }
    });

    const levelSelect = document.getElementById('ind_levelSelect');
    if (levelSelect) Array.from(levelSelect.options).forEach(opt => { opt.selected = false; });

    _indPopulateSchoolYearOptions(prefill?.sy || '');

    const letterDateEl = document.getElementById('ind_letterDate');
    if (letterDateEl) letterDateEl.value = todayISO;

    // FIX #6: visually reset number buttons to 1st via _indSelectNum
    _indSelectNum(1);

    // Hide all type buttons' active states
    Object.keys(_indTypeMeta).forEach(t => {
        const btn = document.getElementById('ind_typeBtn_' + t);
        if (btn) {
            btn.style.background  = '#fff';
            btn.style.borderColor = '#e5e7eb';
            btn.style.color       = '#6b7280';
            btn.style.fontWeight  = '600';
            btn.style.boxShadow   = 'none';
        }
    });

    // Hide fields section until type chosen
    const fieldsSection = document.getElementById('ind_fieldsSection');
    if (fieldsSection) fieldsSection.style.display = 'none';

    // Hide saved badge
    const badge = document.getElementById('ind_savedBadge');
    if (badge) badge.style.display = 'none';

    // Hide signatory wrap by default (FIX #4 companion: ensure display:none wins)
    const sigWrap = document.getElementById('ind_signatoryWrap');
    if (sigWrap) sigWrap.style.display = 'none';
    const sigBtn = document.getElementById('ind_changeSignatoryBtn');
    if (sigBtn) sigBtn.innerHTML = '<i class="fa-solid fa-user-pen" style="margin-right:5px;"></i>Change Signatory Name';

    // Reset preview
    const preview = document.getElementById('ind_preview');
    if (preview) preview.innerHTML = '<span style="color:var(--color-text-secondary);font-style:italic;font-size:12px;display:flex;align-items:center;justify-content:center;height:100%;text-align:center;">Select an indorsement type to begin…</span>';

    const schoolSearchRow = document.getElementById('ind_schoolSearchRow');

    if (prefill && prefill.schoolName) {
        _indSetVal('ind_schoolName', (prefill.schoolName || '').toUpperCase());
        _indSetVal('ind_address',    prefill.address  || '');
        _indSetVal('ind_sy',         _indNormalizeSY(prefill.sy));
        _indSetVal('ind_days',       prefill.totalDays || '');
        _indSetVal('ind_startDate',  prefill.startDate || '');
        _indSetVal('ind_endDate',    prefill.endDate   || '');
        _indSetLevelSelectionFromText(prefill.level || prefill.course_level || '');
        if (prefill.schoolId) {
            _indSelectedSchoolId = prefill.schoolId;
        }
        if (prefill.privateSchoolId) {
            _indSelectedPrivateSchoolId = Number(prefill.privateSchoolId);
        }
        const lockMap = {
            ind_schoolName: !!prefill.schoolName,
            ind_address: !!prefill.address,
            ind_sy: !!prefill.sy,
        };
        ['ind_schoolName', 'ind_address', 'ind_sy'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (lockMap[id]) {
                if (el.tagName === 'SELECT') el.disabled = true;
                else el.readOnly = true;
                el.style.background = 'var(--color-background-secondary,#f9fafb)';
            } else {
                if (el.tagName === 'SELECT') el.disabled = false;
                else el.readOnly = false;
                el.style.background = '';
            }
        });
        if (schoolSearchRow) schoolSearchRow.style.display = 'none';
        _indSetType(prefill.checklistType || 'school_calendar');
    } else {
        if (schoolSearchRow) schoolSearchRow.style.display = '';
    }

    const titleEl = document.getElementById('ind_modalTitle');
    if (titleEl && !prefill) titleEl.innerHTML = '<i class="fa-solid fa-file-signature" style="margin-right:6px;color:#0369a1;"></i>Generate Indorsement Letter';

    const overlay = document.getElementById('indorsementModalOverlay');
    overlay.style.display = 'flex';
    overlay.style.zIndex  = '3000';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    await Promise.all([_indLoadSchools(), _indLoadPersonnel()]);
    let needsSchoolSearch = false;
    if (prefill && prefill.schoolId) {
        const match = _indSchools.find(s => Number(s.id) === Number(prefill.schoolId));
        if (match) {
            if (!prefill.schoolName) {
                _indSetVal('ind_schoolName', (match.name || '').toUpperCase());
            }
            if (!prefill.address) {
                _indSetVal('ind_address', match.address || '');
            }
            if (!prefill.sy && match.school_year) {
                _indSetVal('ind_sy', _indNormalizeSY(match.school_year));
            }
            _indUpdatePreview();
        } else if (!prefill.address) {
            needsSchoolSearch = true;
        }
    } else if (prefill && !prefill.address) {
        needsSchoolSearch = true;
    }
    if (needsSchoolSearch && schoolSearchRow) {
        schoolSearchRow.style.display = '';
        if (prefill?.schoolName) _indSetVal('ind_schoolSearch', prefill.schoolName);
    }
    _indPrefillSignatory();
    _indAttachPreviewListeners();
    _indUpdateLevelFromSelect();
    if (_indCurrentType) _indUpdatePreview();
}

// FIX #8a: direct close — no event guard, used by Cancel button and header ✕
function closeIndorsementModal(e) {
    // If called with no event (Cancel / ✕ buttons), close directly
    if (!e) { _closeIndorsementModalDirect(); return; }
    // If called from the overlay backdrop click, only close when clicking the backdrop itself
    if (e.target !== document.getElementById('indorsementModalOverlay')) return;
    _closeIndorsementModalDirect();
}

function _closeIndorsementModalDirect() {
    const overlay = document.getElementById('indorsementModalOverlay');
    if (overlay) {
        overlay.classList.remove('open');
        overlay.style.display = 'none';
    }
    document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════
   LIVE PREVIEW
══════════════════════════════════════════════════════ */

let _indPreviewBound   = false;
let _indLastAutoPreviewText = '';

function _indNormalizePreviewText(text) {
    return String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function _indNormalizePreviewHtml(html) {
    return String(html || '').replace(/\r/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}
function _indEscapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function _indApplySavedPreviewText(text) {
    const el = document.getElementById('ind_preview');
    if (!el) return;
    const safe = _indEscapeHtml(text);
    el.innerHTML = `<div style="white-space:pre-wrap;">${safe}</div>`;
    el.dataset.autoText = '';
    el.dataset.autoHtml = '';
    _indLastAutoPreviewText = '';
}
function _indSetPreviewHtml(html) {
    const el = document.getElementById('ind_preview');
    if (!el) return;
    el.innerHTML = html;
    const autoText = _indNormalizePreviewText(el.innerText || el.textContent || '');
    const autoHtml = _indNormalizePreviewHtml(el.innerHTML || '');
    el.dataset.autoText = autoText;
    el.dataset.autoHtml = autoHtml;
    _indLastAutoPreviewText = autoText;
}

function _indGetManualPreviewText() {
    const el = document.getElementById('ind_preview');
    if (!el) return '';
    const currentText = _indNormalizePreviewText(el.innerText || el.textContent || '');
    const autoText    = _indNormalizePreviewText(el.dataset.autoText || _indLastAutoPreviewText || '');
    const currentHtml = _indNormalizePreviewHtml(el.innerHTML || '');
    const autoHtml    = _indNormalizePreviewHtml(el.dataset.autoHtml || '');
    const hasMarkupEdits = !!currentHtml && !!autoHtml && currentHtml !== autoHtml;
    if ((!currentText || currentText === autoText) && !hasMarkupEdits) return '';
    return currentText;
}

function _indGetPreviewBoldPhrases() {
    const el = document.getElementById('ind_preview');
    if (!el) return [];
    const nodes   = el.querySelectorAll('strong,b,span[style*="font-weight"]');
    const phrases = [];
    nodes.forEach(node => {
        const tag      = (node.tagName || '').toLowerCase();
        const style    = (node.getAttribute('style') || '').toLowerCase();
        const isBoldTag   = tag === 'strong' || tag === 'b';
        const isBoldStyle = /font-weight\s*:\s*(bold|[6-9]00)/.test(style);
        if (!isBoldTag && !isBoldStyle) return;
        const txt = _indNormalizePreviewText(node.textContent || '');
        if (!txt || txt.length > 180) return;
        phrases.push(txt);
    });
    return Array.from(new Set(phrases)).sort((a, b) => b.length - a.length);
}

function _indParseManualPreview(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const header    = (lines[0] || '').trim();
    const date      = (lines[1] || '').trim();
    let remainder   = lines.slice(2);
    while (remainder.length && !remainder[0].trim()) remainder.shift();
    let bodyLines   = remainder.slice();
    let signLines   = [];
    for (let i = 0; i < remainder.length - 1; i++) {
        if (!remainder[i].trim() && !remainder[i + 1].trim()) {
            bodyLines  = remainder.slice(0, i);
            signLines  = remainder.slice(i).filter(l => l.trim()).map(l => l.trim());
            break;
        }
    }
    if (!signLines.length) {
        const nonEmpty = remainder.map((line, idx) => ({ line, trimmed: line.trim(), idx })).filter(x => x.trimmed);
        if (nonEmpty.length >= 2) {
            const start = Math.max(nonEmpty.length - 3, 0);
            signLines   = nonEmpty.slice(start).map(x => x.trimmed);
            bodyLines   = remainder.slice(0, nonEmpty[start].idx);
        }
    }
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    return { header, date, bodyLines: bodyLines.map(l => l.replace(/[ \t]+$/g, '')), signLines };
}

function _indAttachPreviewListeners() {
    if (_indPreviewBound) return;
    ['ind_schoolName', 'ind_address', 'ind_sy', 'ind_days', 'ind_startDate', 'ind_endDate',
        'ind_letterDate', 'ind_sigName', 'ind_sigPosition', 'ind_level', 'ind_levelSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input',  _indUpdatePreview);
            el.addEventListener('change', _indUpdatePreview);
        }
    });
    _indPreviewBound = true;
}

function _indUpdatePreview() {
    const el = document.getElementById('ind_preview');
    if (!el || !_indCurrentType) return;

    const schoolName     = ((document.getElementById('ind_schoolName')?.value || '').trim().toUpperCase()) || '[SCHOOL NAME]';
    const address        = (document.getElementById('ind_address')?.value     || '').trim() || '[SCHOOL ADDRESS]';
    const sy             = (document.getElementById('ind_sy')?.value          || '').trim() || '____-____';
    const rawLetter      = document.getElementById('ind_letterDate')?.value   || '';
    const sigName        = (document.getElementById('ind_sigName')?.value     || '').trim() || '[SIGNATORY NAME]';
    const sigPos         = (document.getElementById('ind_sigPosition')?.value || '').trim() || '[POSITION]';
    const letterFormatted = _indFormatDate(rawLetter) || _indTodayFormatted();
    const indNum         = document.getElementById('ind_numberSelect')?.value || '1';
    const meta           = _indTypeMeta[_indCurrentType];

    const headerLabels   = { '1':'1st Indorsement','2':'2nd Indorsement','3':'3rd Indorsement','4':'4th Indorsement','5':'5th Indorsement','6':'6th Indorsement' };
    const headerLabel    = headerLabels[indNum] || '1st Indorsement';

    let bodyHTML = '';
    if (_indCurrentType === 'no_increase') {
        const level = (document.getElementById('ind_level')?.value || '').trim() || '[Level]';
        const { rich } = _indComposeParagraphNoIncrease(schoolName, address, sy, level);
        bodyHTML = rich.before + `<strong>${rich.schoolBold}</strong>` + rich.afterSchool + `<strong>${rich.noIncreaseBold}</strong>` + rich.afterBold;
    } else if (_indCurrentType === 'school_permit') {
        const level = (document.getElementById('ind_level')?.value || '').trim();
        const { rich } = _indComposeParagraphSchoolPermit(schoolName, address, sy, level);
        bodyHTML = rich.before + `<strong>${rich.schoolBold}</strong>` + rich.afterSchool + `<strong>${rich.noIncreaseBold}</strong>` + rich.afterBold;
    } else if (_indCurrentType === 'tuition_increase') {
        const { rich } = _indComposeParagraphTuition(schoolName, address, sy);
        bodyHTML = rich.before + `<strong>${rich.schoolBold}</strong>` + rich.afterSchool;
    } else {
        // school_calendar — FIX: uses updated _indComposeParagraph (no levelText arg)
        const totalDays = (document.getElementById('ind_days')?.value      || '').trim();
        const rawStart  =  document.getElementById('ind_startDate')?.value || '';
        const rawEnd    =  document.getElementById('ind_endDate')?.value   || '';
        const startFmt  = _indFormatDate(rawStart) || '';
        const endFmt    = _indFormatDate(rawEnd)   || '';
        const { rich }  = _indComposeParagraph(schoolName, address, sy, totalDays, startFmt, endFmt);
        bodyHTML =
            rich.before +
            `<strong>${rich.schoolBold}</strong>` +
            rich.afterSchoolBeforeLevel +
            rich.afterLevel +
            (rich.daysBold ? `<strong>${rich.daysBold}</strong>` : '');
    }

    const accentColor = meta?.color || '#0369a1';
    const html = `
<div style="font-family:'Bookman Old Style',Georgia,serif;font-size:12px;line-height:1.8;color:#1a1a1a;background:#fff;padding:24px 28px;border-radius:4px;min-height:200px;">
    <div style="border-bottom:3px double #000;padding-bottom:10px;margin-bottom:14px;text-align:center;">
        <div style="font-family:'Old English Text MT',serif;font-size:10px;">Republic of the Philippines</div>
        <div style="font-family:'Old English Text MT',serif;font-size:18px;font-weight:normal;">Department of Education</div>
        <div style="font-family:'Times New Roman',serif;font-size:10px;font-weight:400;">REGION III-CENTRAL LUZON</div>
        <div style="font-family:'Tahoma',sans-serif;font-size:13px;font-weight:700;">SCHOOLS DIVISION OF CITY OF BALIWAG</div>
        <div style="font-family:'Tahoma',sans-serif;font-size:12px;font-weight:700;">City of Baliwag, Bulacan</div>
    </div>
    <div style="text-align:center;margin-bottom:4px;">
        <strong style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;">${headerLabel}</strong>
    </div>
    <div style="text-align:center;font-size:12px;margin-bottom:18px;color:#374151;">${letterFormatted}</div>
    <div style="text-indent:2em;text-align:justify;margin-bottom:28px;font-size:12px;">${bodyHTML}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <div style="text-align:center;min-width:220px;">
            <div style="height:32px;"></div>
            <div style="font-weight:700;font-size:12px;text-decoration:underline;">${sigName}</div>
            <div style="font-size:11.5px;">${sigPos}</div>
            <div style="font-size:11px;color:#6b7280;">Office of the Schools Division Superintendent</div>
        </div>
    </div>
    <div style="margin-top:28px;border-top:2px solid #000;padding-top:8px;font-size:9px;color:#6b7280;">
        <div>2nd Floor, Bayanihan Building, Doña Remedios Trinidad (DRT) Highway, Barangay Pagala, City of Baliwag, Bulacan</div>
        <div>Telephone No: (044) 762-2793 &nbsp;|&nbsp; baliwag.city@deped.gov.ph &nbsp;|&nbsp; https://www.facebook.com/SDOCityofBaliwag</div>
    </div>
</div>`;

    _indSetPreviewHtml(html);
}

/* ══════════════════════════════════════════════════════
   VALIDATION MESSAGE
══════════════════════════════════════════════════════ */

function indClearMsg() {
    const el = document.getElementById('ind_msg');
    if (el) el.style.display = 'none';
}
function _indShowMsg(text, type) {
    type = type || 'error';
    const el = document.getElementById('ind_msg');
    if (!el) return;
    const colors = {
        error:   { bg: '#fef2f2', border: '#fecaca', color: '#991b1b' },
        warning: { bg: '#fffbeb', border: '#fde68a', color: '#92400e' },
        success: { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534' },
    };
    const c = colors[type] || colors.error;
    el.style.cssText = `display:block;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;background:${c.bg};border:1px solid ${c.border};color:${c.color};`;
    el.textContent   = text;
}

/* ══════════════════════════════════════════════════════
   SAVE INDORSEMENT
   FIX #7: use local `sy` variable directly — not fragile saved.school_year
══════════════════════════════════════════════════════ */

function _indUpdateSaveButtonState() {
    const btn = document.getElementById('ind_saveBtn');
    if (!btn) return;
    const hasSchool = !!document.getElementById('ind_schoolName')?.value?.trim();
    const hasType   = !!_indCurrentType;
    btn.disabled    = !(hasSchool && hasType);
    btn.style.opacity = (hasSchool && hasType) ? '1' : '0.5';
}

async function saveIndorsement() {
    if (!_indCurrentType) { _indShowMsg('Please select an indorsement type first.'); return; }

    // FIX: normalize one more time right before saving, so a mismatched
    // key (e.g. 'renewal_permit') can never reach the backend as `type`.
    _indCurrentType = _indNormalizeType(_indCurrentType);

    const schoolName  = (document.getElementById('ind_schoolName')?.value  || '').trim().toUpperCase();
    const address     = (document.getElementById('ind_address')?.value     || '').trim();
    const sy          = _indNormalizeSY(document.getElementById('ind_sy')?.value);
    const rawLetter   =  document.getElementById('ind_letterDate')?.value  || '';
    const sigName     = (document.getElementById('ind_sigName')?.value     || '').trim().toUpperCase();
    const sigPos      = (document.getElementById('ind_sigPosition')?.value || '').trim();
    const indNum      = parseInt(document.getElementById('ind_numberSelect')?.value || '1', 10);
    const level       = (document.getElementById('ind_level')?.value       || '').trim();

    if (!schoolName) { _indShowMsg('School Name is required.');    return; }
    if (!address)    { _indShowMsg('School Address is required.'); return; }
    if (!sy)         { _indShowMsg('School Year is required.');    return; }
    if (!sigName)    { _indShowMsg('Signatory Name is required.'); return; }

    const letterFormatted = _indFormatDate(rawLetter) || _indTodayFormatted();
    const previewText     = document.getElementById('ind_preview')?.innerText || '';

    const saveBtn = document.getElementById('ind_saveBtn');
    const originalBtnLabel = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    // Hoisted above the try block (was previously declared inside it with
    // `const`) so the finally block below can still reach it to refresh
    // the saved-status badge/button label even on a successful save.
    let schoolId = _indSelectedSchoolId || _indSelectedPrivateSchoolId || null;
    let saveSucceeded = false;

    try {
        const payload = {
            school_id:          _indSelectedSchoolId || null,
            private_school_id:  _indSelectedPrivateSchoolId || null,
            school_name: schoolName,
            address,
            school_year: sy,
            type:        _indCurrentType,
            ind_number:  indNum,
            level,
            letter_date: rawLetter || new Date().toISOString().slice(0, 10),
            sig_name:    sigName,
            sig_position: sigPos,
            preview_text: previewText,
        };

        const saveRes = await fetch(CONFIG.API_URL + '/school-indorsements.php?action=save', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
        });

        let saved = {};
        try { saved = await saveRes.json(); } catch (e) { /* ignore */ }
        if (!saveRes.ok) throw new Error(saved.message || 'Save failed (HTTP ' + saveRes.status + ')');

        // Auto-check tracker step
        const meta         = _indTypeMeta[_indCurrentType];
        const stepsToCheck = meta?.steps?.[indNum] || [];
        schoolId           = _indSelectedSchoolId || saved.school_id || schoolId;

        if (schoolId && stepsToCheck.length) {
            const trackerBase = CONFIG.API_URL + '/school-tracker.php';
            try {
                const yearsRes  = await fetch(trackerBase + '?action=years', { credentials: 'include' });
                const yearsJson = await yearsRes.json();
                const years     = Array.isArray(yearsJson?.years) ? yearsJson.years : [];

                const normalizeSchoolYear  = (value) => String(value || '').replace(/^SY\s*/i, '').trim();
                // FIX #7: always use local `sy`, never rely on saved.school_year
                const requestedSchoolYear  = normalizeSchoolYear(sy);

                let yearId = null;

                if (requestedSchoolYear && years.length) {
                    const matchedYear = years.find(y => normalizeSchoolYear(y.school_year) === requestedSchoolYear);
                    if (matchedYear?.id) yearId = Number(matchedYear.id);
                }

                if (!yearId && /^\d{4}-\d{4}$/.test(requestedSchoolYear)) {
                    const addYearRes  = await fetch(trackerBase + '?action=add_year', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ school_year: requestedSchoolYear, label: 'SY ' + requestedSchoolYear }),
                    });
                    const addYearJson = await addYearRes.json().catch(() => ({}));
                    if (addYearRes.ok && addYearJson?.success && addYearJson?.year?.id) {
                        yearId = Number(addYearJson.year.id);
                    }
                }

                if (!yearId && years.length) {
                    const newestYear = [...years].sort((a, b) =>
                        normalizeSchoolYear(b.school_year).localeCompare(normalizeSchoolYear(a.school_year))
                    )[0];
                    yearId = newestYear?.id ? Number(newestYear.id) : null;
                }

                if (yearId) {
                    const rowLabel = _indGetRowLabelForLevel(level);
                    const cells    = {};
                    for (const stepLabel of stepsToCheck) {
                        cells[`${meta.categoryKey}|${rowLabel}|${stepLabel}`] = true;
                    }
                    await fetch(trackerBase + '?action=save', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ year_id: yearId, school_id: schoolId, cells }),
                    });
                } else {
                    console.warn('Could not auto-check tracker step: no active school year found');
                }
            } catch (err) {
                console.warn('Could not auto-check tracker step:', err);
            }
        }

        if (typeof showToast === 'function') {
            showToast(`${_indOrdinal(indNum)} Indorsement saved!${stepsToCheck.length ? ' "' + stepsToCheck.join(', ') + '" checked in tracker.' : ''}`, 'success');
        }
        _indShowMsg(
            `✓ Saved as ${_indOrdinal(indNum)} Indorsement for ${schoolName}.` +
            (stepsToCheck.length ? ` "${stepsToCheck.join(' & ')}" auto-checked in the tracker.` : ''),
            'success'
        );

        if (typeof ST !== 'undefined' && typeof ST.refresh === 'function') ST.refresh();
        await _indLoadSavedStatus(schoolId);
        saveSucceeded = true;

    } catch (err) {
        console.error('Save error:', err);
        _indShowMsg('Failed to save: ' + err.message);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            // BUG FIX: this used to unconditionally reset the label back to
            // "Save Indorsement", which threw away the "Update Nth
            // Indorsement" label _indLoadSavedStatus() had just set a few
            // lines above on a successful save — so the button (and the
            // saved-status banner) always looked like nothing had happened.
            // On success, leave the label as _indLoadSavedStatus() set it;
            // only restore the pre-save label if the save actually failed.
            if (!saveSucceeded) {
                saveBtn.innerHTML = originalBtnLabel || '<i class="fa-solid fa-floppy-disk"></i> Save Indorsement';
            }
            _indUpdateSaveButtonState();
        }
    }
}

function _indGetRowLabelForLevel(levelText) {
    if (_indCurrentType === 'school_calendar') return 'School Calendar';
    const t = (levelText || '').toLowerCase();
    if (t.includes('pre'))                          return 'Pre-School';
    if (t.includes('elem'))                         return 'Elementary';
    if (t.includes('junior') || t.includes('jhs')) return 'Junior HS';
    if (t.includes('senior') || t.includes('shs')) return 'Senior HS';
    return levelText || '';
}

/* ══════════════════════════════════════════════════════
   DOCX GENERATION
   FIX #1: school_calendar body runs now use correct rich keys
   FIX #2: levelText arg removed from _indComposeParagraph call
══════════════════════════════════════════════════════ */

function _indEscapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _indBuildStyledRunsForLine(line, TextRunCtor, options) {
    const text               = String(line || '');
    const schoolName         = String(options?.schoolName     || '').trim();
    const emphasizeDays      = !!options?.emphasizeDays;
    const totalDays          = String(options?.totalDays      || '').trim();
    const manualBoldPhrases  = Array.isArray(options?.manualBoldPhrases) ? options.manualBoldPhrases : [];

    const patterns = [];
    if (schoolName)    patterns.push(new RegExp(_indEscapeRegExp(schoolName), 'gi'));
    if (emphasizeDays) {
        if (totalDays) patterns.push(new RegExp('\\b' + _indEscapeRegExp(totalDays) + '\\s+days\\b\\.?', 'gi'));
        else           patterns.push(/\b\d{1,3}\s+days\b\.?/gi);
    }
    manualBoldPhrases.forEach(p => {
        const phrase = String(p || '').trim();
        if (phrase) patterns.push(new RegExp(_indEscapeRegExp(phrase), 'gi'));
    });

    if (!patterns.length || !text) return [new TextRunCtor({ text, size: 22, font: 'Bookman Old Style' })];

    const boldFlags = new Array(text.length).fill(false);
    patterns.forEach(pattern => {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const start = match.index;
            const end   = start + String(match[0] || '').length;
            for (let i = start; i < end && i < boldFlags.length; i++) boldFlags[i] = true;
            if (pattern.lastIndex === match.index) pattern.lastIndex++;
        }
    });

    const runs = [];
    let i = 0;
    while (i < text.length) {
        const isBold = boldFlags[i];
        let j = i + 1;
        while (j < text.length && boldFlags[j] === isBold) j++;
        const chunk = text.slice(i, j);
        if (chunk) runs.push(new TextRunCtor({ text: chunk, bold: isBold, size: 22, font: 'Bookman Old Style' }));
        i = j;
    }
    return runs.length ? runs : [new TextRunCtor({ text, size: 22, font: 'Bookman Old Style' })];
}

function _indBuildBodyRunsFromLines(lines, TextRunCtor, options) {
    const runs      = [];
    const safeLines = Array.isArray(lines) ? lines : [];
    safeLines.forEach((line, idx) => {
        if (idx > 0) runs.push(new TextRunCtor({ break: 1 }));
        runs.push(..._indBuildStyledRunsForLine(line, TextRunCtor, options));
    });
    return runs;
}

async function generateStandaloneIndorsement() {
    if (!_indCurrentType) { _indShowMsg('Please select an indorsement type first.'); return; }

    const schoolName = (document.getElementById('ind_schoolName')?.value || '').trim().toUpperCase();
    const address    = (document.getElementById('ind_address')?.value    || '').trim();
    const sy         = (document.getElementById('ind_sy')?.value         || '').trim();
    const rawLetter  =  document.getElementById('ind_letterDate')?.value || '';
    const sigName    = (document.getElementById('ind_sigName')?.value    || '').trim().toUpperCase();
    const sigPos     = (document.getElementById('ind_sigPosition')?.value|| '').trim();

    if (!schoolName) { _indShowMsg('School Name is required.');                           return; }
    if (!address)    { _indShowMsg('School Address is required.');                        return; }
    if (!sy)         { _indShowMsg('School Year is required (e.g. 2025-2026).');          return; }
    if (!sigName)    { _indShowMsg('Signatory Name is required.');                        return; }
    if (!sigPos)     { _indShowMsg('Signatory Position is required.');                    return; }

    const letterFormatted = _indFormatDate(rawLetter) || _indTodayFormatted();
    const totalDaysForBold = (document.getElementById('ind_days')?.value || '').trim();
    const indNum  = document.getElementById('ind_numberSelect')?.value || '1';
    const headerLabels = { '1':'1st Indorsement','2':'2nd Indorsement','3':'3rd Indorsement','4':'4th Indorsement','5':'5th Indorsement','6':'6th Indorsement' };
    const headerLabel  = headerLabels[indNum] || '1st Indorsement';

    let rich, fileLabel;

    if (_indCurrentType === 'no_increase') {
        const level = (document.getElementById('ind_level')?.value || '').trim();
        if (!level) { _indShowMsg('Level is required for No Increase indorsement.'); return; }
        rich      = _indComposeParagraphNoIncrease(schoolName, address, sy, level).rich;
        fileLabel = 'NoIncrease';

    } else if (_indCurrentType === 'school_permit') {
        const level = (document.getElementById('ind_level')?.value || '').trim();
        rich      = _indComposeParagraphSchoolPermit(schoolName, address, sy, level).rich;
        fileLabel = 'SchoolPermit';

    } else if (_indCurrentType === 'tuition_increase') {
        rich      = _indComposeParagraphTuition(schoolName, address, sy).rich;
        fileLabel = 'TuitionIncrease';

    } else {
        // FIX #1 + #2: school_calendar — no levelText arg, use correct rich keys
        const totalDays = (document.getElementById('ind_days')?.value      || '').trim();
        const rawStart  =  document.getElementById('ind_startDate')?.value || '';
        const rawEnd    =  document.getElementById('ind_endDate')?.value   || '';
        const startFmt  = _indFormatDate(rawStart) || '';
        const endFmt    = _indFormatDate(rawEnd)   || '';
        rich      = _indComposeParagraph(schoolName, address, sy, totalDays, startFmt, endFmt).rich;
        fileLabel = 'SchoolCalendar';
    }

    const manualPreviewText = _indGetManualPreviewText();

    const btn = document.getElementById('ind_downloadBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'; }

    try {
        const {
            Document, Packer, Paragraph, TextRun, AlignmentType,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            Header, Footer, ImageRun, HeightRule,
        } = docx;

        const PAGE_W           = 12240;
        const PAGE_MARGIN_LEFT = 1440;
        const DIVIDER_CONTENT_W = PAGE_W;

        const HEADER_DIVIDER_BORDER = { style: BorderStyle.THICK_THIN_MEDIUM_GAP, size: 24, color: '000000', space: 0 };
        const FOOTER_DIVIDER_BORDER = { style: BorderStyle.THIN_THICK_MEDIUM_GAP, size: 24, color: '000000', space: 0 };

        const dividerTable = (edge, labelText = '') => new Table({
            width:        { size: DIVIDER_CONTENT_W, type: WidthType.DXA },
            columnWidths: [DIVIDER_CONTENT_W],
            alignment:    AlignmentType.LEFT,
            indent:       { size: -PAGE_MARGIN_LEFT, type: WidthType.DXA },
            borders: {
                top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL },
                left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL },
                insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL },
            },
            rows: [new TableRow({
                height: { value: 80, rule: HeightRule.EXACT },
                children: [new TableCell({
                    children: labelText
                        ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: labelText, font: 'Cambria', size: 4, bold: true })] })]
                        : [new Paragraph({ spacing: { before: 0, after: 0 } })],
                    width:   { size: DIVIDER_CONTENT_W, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    borders: {
                        top:    { style: BorderStyle.NIL },
                        bottom: edge === 'top'
                            ? FOOTER_DIVIDER_BORDER
                            : (edge === 'bottom' ? HEADER_DIVIDER_BORDER : { style: BorderStyle.NIL }),
                        left:  { style: BorderStyle.NIL },
                        right: { style: BorderStyle.NIL },
                    },
                })],
            })],
        });

        const fetchImg = async relPath => {
            try {
                const base = window.location.pathname.replace(/\/[^/]*$/, '');
                const res  = await fetch(base + relPath);
                return res.ok ? await res.arrayBuffer() : null;
            } catch (_) { return null; }
        };

        const logoData            = await fetchImg('/images/kagawaran-ng-edukasyon-logo.png');
        const depedLogoData       = await fetchImg('/images/DepED-logo.png');
        const bagongPilipinasData = await fetchImg('/images/bagong-pilipinas-logo.png');
        const divisionSealData    = await fetchImg('/images/SDO-Seal.png');
        const emailLogoData       = await fetchImg('/images/old-gmail-logo.png');
        const facebookLogoData    = await fetchImg('/images/Facebook-Logo-Circle-Creation-PNG.png');

        const headerChildren = [];
        if (logoData) {
            headerChildren.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing:   { before: 0, after: 0 },
                children:  [new ImageRun({
                    type: 'png', data: logoData,
                    transformation: { width: 70, height: 70 },
                    altText: { title: 'DepEd Logo', description: 'DepEd Logo', name: 'DepEdLogo' }
                })]
            }));
        }
        headerChildren.push(
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'Republic of the Philippines', font: 'Old English Text MT', size: 22 })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'Department of Education',     font: 'Old English Text MT', size: 32 })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'REGION III-CENTRAL LUZON',                font: 'Times New Roman', size: 18 })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'SCHOOLS DIVISION OF CITY OF BALIWAG',     font: 'Tahoma', size: 22, bold: true })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: 'City of Baliwag, Bulacan',                font: 'Tahoma', size: 20, bold: true })] }),
            dividerTable('bottom', '')
        );

        const in2emu = n => Math.round(n * 914400);
        const in2px  = n => Math.round(n * 96);
        const ftRun  = (text, opts = {}) => new TextRun({ text, font: 'Cambria', size: 18, ...opts });

        const floatingImg = (data, imgType, wIn, hgtIn, hPos, vPos, name) =>
            data ? new ImageRun({
                type: imgType, data,
                transformation: { width: in2px(wIn), height: in2px(hgtIn) },
                altText: { title: name, description: name, name: name.replace(/\s/g, '') },
                floating: {
                    horizontalPosition: { relative: 'page',      offset: in2emu(hPos) },
                    verticalPosition:   { relative: 'paragraph', offset: in2emu(vPos) },
                    wrap: { type: 'none' },
                    behindDocument: false,
                },
            }) : null;

        const imgDepEd    = floatingImg(depedLogoData,       'png', 1.06, 0.67, 0.25, 0,    'DepEdLogo');
        const imgBagong   = floatingImg(bagongPilipinasData, 'png', 0.73, 0.73, 1.46, 0,    'BagongPilipinas');
        const imgSDO      = floatingImg(divisionSealData,    'png', 0.70, 0.70, 2.25, 0,    'SDOSeal');
        const imgEmail    = floatingImg(emailLogoData,       'png', 0.18, 0.14, 3.30, 0.61, 'EmailLogo');
        const imgFacebook = floatingImg(facebookLogoData,    'png', 0.28, 0.22, 5.42, 0.56, 'FacebookLogo');

        const ftCombined = new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing:   { before: 0, after: 0 },
            indent:    { left: -1440, right: -821 },
            children: [
                ...[imgDepEd, imgBagong, imgSDO, imgEmail, imgFacebook].filter(Boolean),
                ftRun('2nd Floor, Bayanihan Building, Doña Remedios Trinidad (DRT) Highway,'),
                new TextRun({ break: 1 }),
                ftRun('Barangay Pagala, City of Baliwag, Bulacan'),
                new TextRun({ break: 1 }),
                ftRun('Telephone No: ', { bold: true }),
                ftRun('(044) 762-2793'),
                new TextRun({ break: 1 }),
                new TextRun({ break: 1 }),
                ftRun('      baliwag.city@deped.gov.ph'),
                ftRun('                    '),
                ftRun('      https://www.facebook.com/SDOCityofBaliwag'),
            ],
        });

        const footerChildren = [dividerTable('top'), ftCombined];

        // FIX #1: build body children correctly for all types using updated rich keys
        let bodyChildren;

        if (_indCurrentType === 'school_calendar') {
            // school_calendar uses: before, schoolBold, afterSchoolBeforeLevel, afterLevel, daysBold
            bodyChildren = [
                new TextRun({ text: rich.before,                 size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.schoolBold, bold: true, size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.afterSchoolBeforeLevel, size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.afterLevel,             size: 22, font: 'Bookman Old Style' }),
                ...(rich.daysBold
                    ? [new TextRun({ text: rich.daysBold, bold: true, size: 22, font: 'Bookman Old Style' })]
                    : []),
            ];
        } else if (_indCurrentType === 'tuition_increase') {
            // tuition uses: before, schoolBold, afterSchool
            bodyChildren = [
                new TextRun({ text: rich.before,                 size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.schoolBold, bold: true, size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.afterSchool,            size: 22, font: 'Bookman Old Style' }),
            ];
        } else {
            // no_increase / school_permit use: before, schoolBold, afterSchool, noIncreaseBold, afterBold
            bodyChildren = [
                new TextRun({ text: rich.before,                       size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.schoolBold,      bold: true,  size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.afterSchool,                  size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.noIncreaseBold,  bold: true,  size: 22, font: 'Bookman Old Style' }),
                new TextRun({ text: rich.afterBold,                    size: 22, font: 'Bookman Old Style' }),
            ];
        }

        let finalHeaderLabel = headerLabel;
        let finalLetterDate  = letterFormatted;
        let finalSigName     = sigName;
        let finalSigPos      = sigPos;
        let finalSigOffice   = 'Office of the Schools Division Superintendent';

        if (manualPreviewText) {
            const parsed           = _indParseManualPreview(manualPreviewText);
            const manualBoldPhrases = _indGetPreviewBoldPhrases();
            if (parsed.header)    finalHeaderLabel = parsed.header;
            if (parsed.date)      finalLetterDate  = parsed.date;
            const customBodyRuns = _indBuildBodyRunsFromLines(parsed.bodyLines, TextRun, {
                schoolName, emphasizeDays: _indCurrentType === 'school_calendar', totalDays: totalDaysForBold, manualBoldPhrases,
            });
            if (customBodyRuns.length) bodyChildren = customBodyRuns;
            if (parsed.signLines[0]) finalSigName   = parsed.signLines[0];
            if (parsed.signLines[1]) finalSigPos    = parsed.signLines[1];
            if (parsed.signLines[2]) finalSigOffice = parsed.signLines[2];
        }

        const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

        const doc = new Document({
            sections: [{
                properties: {
                    page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1181, bottom: 1094, left: 1440, header: 360, footer: 360 } }
                },
                headers: { default: new Header({ children: headerChildren }) },
                footers: { default: new Footer({ children: footerChildren }) },
                children: [
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: finalHeaderLabel, bold: true, size: 22, font: 'Bookman Old Style' })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: finalLetterDate,  size: 22,              font: 'Bookman Old Style' })] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { firstLine: 720 }, spacing: { line: 276, lineRule: 'auto' }, children: bodyChildren }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Table({
                        width:   { size: 100, type: WidthType.PERCENTAGE },
                        borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
                        rows: [new TableRow({
                            children: [
                                new TableCell({
                                    width:   { size: 40, type: WidthType.PERCENTAGE },
                                    borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
                                    children: [new Paragraph({ children: [] })],
                                }),
                                new TableCell({
                                    width:   { size: 60, type: WidthType.PERCENTAGE },
                                    borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
                                    children: [
                                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: finalSigName,   bold: true, size: 22, font: 'Bookman Old Style' })] }),
                                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: finalSigPos,               size: 22, font: 'Bookman Old Style' })] }),
                                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: finalSigOffice,             size: 22, font: 'Bookman Old Style' })] }),
                                    ],
                                }),
                            ],
                        })],
                    }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [] }),
                    new Paragraph({ children: [new TextRun({ text: 'SGOD-SMME-PRIVATESCHOOL', size: 16, font: 'Bookman Old Style', color: '374151' })] }),
                    new Paragraph({ children: [new TextRun({ text: _indCurrentType === 'school_calendar' ? 'School Calendar' : _indCurrentType === 'tuition_increase' ? 'Tuition Fee Increase' : _indCurrentType === 'school_permit' ? 'School Permit' : 'No Increase of Tuition Fee', size: 16, font: 'Bookman Old Style', color: '374151' })] }),
                    new Paragraph({ children: [new TextRun({ text: _indRefNum(), size: 16, font: 'Bookman Old Style', color: '374151' })] }),
                ],
            }],
        });

        const blob = await Packer.toBlob(doc);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        const safeName = schoolName.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
        const safeSY   = sy.replace(/[-–]/g, '_');
        const ordinals = { 1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 5:'5th', 6:'6th' };
        a.download = `Indorsement_${ordinals[indNum] || indNum + 'th'}_${fileLabel}_${safeName}_SY${safeSY}.docx`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast('Indorsement letter downloaded!', 'success');
        _closeIndorsementModalDirect();

    } catch (err) {
        console.error('Indorsement generation error:', err);
        _indShowMsg('Failed to generate letter: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-file-word"></i> Download .docx'; }
    }
}