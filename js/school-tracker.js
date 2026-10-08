/**
 * school-tracker.js  (v16 — timestamp edition)
 * Document Tracking System — Private School Application and Request
 * Integrates into QRES checklist.html
 *
 * Storage: PHP API (school-tracker.php) → MySQL (school_tracker_checklist)
 *
 * CHANGES vs v15:
 *  - Cell data is now { checked: bool, ts: ISO-string|null, by: string|null }
 *    instead of a plain boolean.
 *  - Checkboxes show a small timestamp badge when checked.
 *  - Each category section has an "Edit Timestamps" button that opens a
 *    modal where the user can pick any checked step and manually change
 *    its timestamp before saving back to the server.
 *  - _saveToServer sends the new object format; the PHP backend accepts both
 *    the old bool format and the new {checked, ts} format (backwards compat).
 */

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // DATA
    // ─────────────────────────────────────────────────────────────────────────
    let SCHOOLS = [];

    const SCHOOLS_API = (typeof CONFIG !== 'undefined' && CONFIG.API_URL)
        ? CONFIG.API_URL + '/private_schools.php'
        : '/api/private_schools.php';

    async function _loadSchools() {
        try {
            const res = await fetch(SCHOOLS_API, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) {
                SCHOOLS = json.data.map(s => ({
                    id:     parseInt(s.id, 10),
                    name:   s.name || '',
                    status: s.status || '',
                    levels: _levelsFromRow(s),
                    _raw:   s,
                }));
            }
        } catch (e) { console.warn('school-tracker: failed to load schools', e); }
    }

    function _setTrackerBodyVisible(visible) {
        const ids = ['st-stats-row', 'st-toolbar', 'st-schools-grid'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = visible ? '' : 'none';
        });
    }

    function _levelsFromRow(row) {
        // Prefer the `levels` JSON column returned by private_schools.php
        // (e.g. '["elem","jhs","shs"]') — same source used by directory.js.
        if (row.levels) {
            try {
                const parsed = Array.isArray(row.levels)
                    ? row.levels
                    : JSON.parse(row.levels);
                if (Array.isArray(parsed) && parsed.length) return parsed;
            } catch (e) { /* fall through to admin-presence detection */ }
        }
        // Fallback: infer from admin/contact field presence (legacy behaviour)
        const lvls = [];
        if (row.elem_admin || row.elem_contact) lvls.push('elem');
        if (row.jhs_admin  || row.jhs_contact)  lvls.push('jhs');
        if (row.shs_admin  || row.shs_contact)  lvls.push('shs');
        if (!lvls.length) lvls.push('elem');
        return lvls;
    }

    const CATEGORIES = [
        { key: 'school_calendar',  label: 'School Calendar',
          rows: ['School Calendar'],
          steps: ['Received w/ Compliance','Endorsed to RO','Approved','Released'] },
        { key: 'tuition_increase', label: 'Increase on Tuition Fee',
          rows: ['Pre-School','Elementary','Junior HS','Senior HS'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'no_increase',      label: 'No Increase on Tuition Fee',
          rows: ['Pre-School','Elementary','Junior HS','Senior HS'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'authority_new',    label: 'Authority to Operate (New)',
          rows: ['Pre-Elem','Elem','JHS','SHS'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'renewal_permit',   label: 'Renewal of Gov\'t Permit',
          rows: [''],
          steps: ['Endorsed to RO','Approved','Released'],
          noRowLabel: true },
        { key: 'app_govt_recognition', label: 'Application for Gov\'t Recognition',
          rows: [''],
          steps: ['Pre-Elem','Elem','JHS'],
          noRowLabel: true },
        { key: 'tracks_strand',    label: 'Application for Tracks/Strand',
          rows: ['SHS Tracks/Strands'],
          steps: ['Endorsed to SDS','Approved','Released'] },
        { key: 'special_programs', label: 'Application for Special Programs',
          rows: ['Special Programs'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'off_campus',       label: 'Request of Off-Campus Activities',
          rows: ['Off-Campus'],
          steps: ['Received & Acknowledged'] },
        { key: 'school_campaign',  label: 'School Campaign',
          rows: ['Campaign'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'closure',          label: 'Closure',
          rows: ['Closure'],
          steps: ['Endorsed to RO','Approved','Released'] },
        { key: 'special_order',    label: 'Special Order (SHS)',
          rows: [''],
          steps: ['Endorsed to RO','Approved','Released'],
          noRowLabel: true },
        { key: 'special_order_level', label: 'Level',
          rows: [''],
          steps: ['Pre-Elem','Elementary','JHS','SHS'],
          noRowLabel: true },
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────
    let _data = {};
    let _years = [];
    let _currentYear = '';
    let _filter = 'all';
    let _view = 'grid';
    let _search = '';
    let _panelSid = null;
    let _panelTemp = {};   // { [compositeKey]: { checked: bool, ts: string|null, by: string|null } }
    let _openActionMenuSchoolId = null;
    let _globalMenuListenersBound = false;
    let _selectedSchoolId = null;

    let PUBLIC_SCHOOLS = [];
    let _schoolType = 'private';

    const PUBLIC_SCHOOLS_API = (typeof CONFIG !== 'undefined' && CONFIG.API_URL)
        ? CONFIG.API_URL + '/public_schools.php'
        : '/api/public_schools.php';

    async function _loadPublicSchools() {
        try {
            const res = await fetch(PUBLIC_SCHOOLS_API, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) {
                PUBLIC_SCHOOLS = json.data.map(s => ({
                    id:     parseInt(s.id, 10),
                    name:   s.name || '',
                    status: s.status || '',
                    levels: _levelsFromRow(s),
                    _raw:   s,
                }));
            }
        } catch (e) { console.warn('school-tracker: failed to load public schools', e); }
    }

    const _cardIndTypeBySchoolId = {};

    /** Schools whose status marks them as closed / temporarily closed are excluded everywhere. */
    function _isClosed(s) {
        const st = (s.status || '').toLowerCase();
        return st.includes('closed'); // catches "Closed" and "Temporarily Closed"
    }

    function _activeSchools() {
        const list = _schoolType === 'public' ? PUBLIC_SCHOOLS : SCHOOLS;
        return list.filter(s => !_isClosed(s));
    }

    const CARD_INDORSEMENT_TYPES = [
        { key: 'school_calendar',  label: 'School Calendar' },
        { key: 'tuition_increase', label: 'Tuition Fee Increase' },
        { key: 'no_increase',      label: 'No Increase of Tuition Fee' },
        { key: 'school_permit',    label: 'School Permit' },
    ];
    const CARD_IND_TYPE_STORAGE_KEY = 'st.card.indorsement.types.v1';

    // ─────────────────────────────────────────────────────────────────────────
    // TIMESTAMP HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns a new cell object.
     * @param {boolean} checked
     * @param {string|null} ts   — ISO / MySQL datetime string
     * @param {string|null} by   — user display name
     */
    function _mkCell(checked, ts, by, q) {
        return {
            checked: !!checked,
            ts:      ts  || null,
            by:      by  || null,
            q:       _validQuarterKey(q) ? q : null,
        };
    }

    function _validQuarterKey(q) {
        return typeof q === 'string' && /^Q[1-4]$/.test(q);
    }

    /**
     * Normalise whatever the backend or legacy code stored into a cell object.
     * Accepts: boolean, or { checked, ts, by }
     */
    function _normaliseCell(raw) {
        if (raw === null || raw === undefined) return _mkCell(false, null, null, null);
        if (typeof raw === 'boolean') return _mkCell(raw, null, null, null);
        if (typeof raw === 'object') {
            return _mkCell(
                !!raw.checked,
                raw.ts  || null,
                raw.by  || null,
                raw.q   || null,
            );
        }
        return _mkCell(!!raw, null, null, null);
    }

    /**
     * Format a timestamp string for display in the panel.
     * Returns a short human-readable string, or '' if null.
     */
    function _fmtTs(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
            if (isNaN(d)) return ts; // show raw if unparseable
            const pad = n => String(n).padStart(2, '0');
            const months = ['Jan','Feb','Mar','Apr','May','Jun',
                            'Jul','Aug','Sep','Oct','Nov','Dec'];
            return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (_) { return ts; }
    }

    /**
     * Convert a displayed timestamp string to the value needed by
     * <input type="datetime-local">.  Returns '' if unparseable.
     */
    function _tsToInputVal(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
            if (isNaN(d)) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (_) { return ''; }
    }

    /**
     * Convert a datetime-local input value to a MySQL-compatible string.
     * e.g. "2025-06-01T09:30" → "2025-06-01 09:30:00"
     */
    function _inputValToTs(val) {
        if (!val) return null;
        return val.replace('T', ' ') + ':00';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PERSISTENCE  (PHP API)
    // ─────────────────────────────────────────────────────────────────────────
    const API_BASE = (typeof CONFIG !== 'undefined' && CONFIG.API_URL)
        ? CONFIG.API_URL + '/school-tracker.php'
        : '/api/school-tracker.php';

    let _yearIdMap = {};

    async function _apiGet(params) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(API_BASE + '?' + qs, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function _apiPost(action, body) {
        const res = await fetch(API_BASE + '?action=' + action, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function _initData() {
        await Promise.all([_loadSchools(), _loadPublicSchools()]);

        try {
            const json = await _apiGet({ action: 'years' });
            if (json.success && json.years.length) {
                _years = json.years.map(y => y.school_year);
                json.years.forEach(y => { _yearIdMap[y.school_year] = y.id; });
            }
        } catch (e) { /* fall through */ }

        if (!_years.length) {
            const cur = new Date().getFullYear();
            _years = [(cur - 1) + '-' + cur];
        }

        _currentYear = _years[0];
        await _loadYearData(_currentYear);
    }

    async function _loadYearData(yr) {
        const yid = _yearIdMap[yr];
        if (!yid) return;
        try {
            const json = await _apiGet({ action: 'load', year_id: yid, school_type: _schoolType });
            if (json.success) {
                if (!_data[yr]) _data[yr] = {};
                for (const [sid, cells] of Object.entries(json.data || {})) {
                    // Normalise every cell to our { checked, ts, by } format
                    const normCells = {};
                    for (const [k, v] of Object.entries(cells)) {
                        normCells[k] = _normaliseCell(v);
                    }
                    _data[yr][parseInt(sid, 10)] = normCells;
                }
            }
        } catch (e) { console.warn('school-tracker: load failed', yr, e); }
    }

    /**
     * Save the full cell map for one school to the server.
     * Sends { checked, ts } objects so the backend can store timestamps.
     */
    async function _saveToServer(yr, sid) {
        const yid = _yearIdMap[yr];
        if (!yid) return;
        const cellsRaw = _schoolData(yr, sid);

        // Build the payload — send full cell objects (PHP handles both formats)
        const cells = {};
        for (const [k, v] of Object.entries(cellsRaw)) {
            cells[k] = { checked: v.checked, ts: v.ts || null, q: v.q || null };
        }

        await _apiPost('save', { year_id: yid, school_id: sid, school_type: _schoolType, cells });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DATA HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function _yrData(yr) {
        if (!_data[yr]) _data[yr] = {};
        return _data[yr];
    }

    function _schoolData(yr, sid) {
        const yd = _yrData(yr);
        if (!yd[sid]) yd[sid] = {};
        return yd[sid];
    }

    function _cbKey(catKey, row, step) {
        return catKey + '|' + row + '|' + step;
    }

    /** Returns the cell object for a given key, always as { checked, ts, by } */
    function _getCell(yr, sid, key) {
        return _normaliseCell((_schoolData(yr, sid) || {})[key]);
    }

    /**
     * Calculates completion progress based only on REQUIRED categories:
     *   1. School Calendar (all steps)
     *   2. Tuition fee per level: whichever of tuition_increase OR no_increase
     *      has any checked step is counted; the other is ignored for that level.
     *      If neither is checked, tuition_increase steps count as pending.
     *   3. Renewal of Gov't Permit (all steps)
     * All other categories are tracked but do NOT affect completion %.
     */
    function _progress(yr, sid) {
        const sd = _schoolData(yr, sid);
        let total = 0, checked = 0;

        const TUITION_LEVELS = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
        const TUITION_STEPS  = ['Endorsed to RO', 'Approved', 'Released'];

        // 1. School Calendar
        const SC = CATEGORIES.find(c => c.key === 'school_calendar');
        for (const row of SC.rows) {
            for (const step of SC.steps) {
                total++;
                if (_normaliseCell(sd[_cbKey('school_calendar', row, step)]).checked) checked++;
            }
        }

        // 2. Tuition fee -- per level, pick whichever was submitted
        for (const level of TUITION_LEVELS) {
            const hasIncrease   = TUITION_STEPS.some(s => _normaliseCell(sd[_cbKey('tuition_increase', level, s)]).checked);
            const hasNoIncrease = TUITION_STEPS.some(s => _normaliseCell(sd[_cbKey('no_increase',      level, s)]).checked);
            const activeCat = hasIncrease   ? 'tuition_increase'
                            : hasNoIncrease ? 'no_increase'
                            : 'tuition_increase'; // default pending target
            for (const step of TUITION_STEPS) {
                total++;
                if (_normaliseCell(sd[_cbKey(activeCat, level, step)]).checked) checked++;
            }
        }

        // 3. Renewal of Gov't Permit
        const RP = CATEGORIES.find(c => c.key === 'renewal_permit');
        for (const row of RP.rows) {
            for (const step of RP.steps) {
                total++;
                if (_normaliseCell(sd[_cbKey('renewal_permit', row, step)]).checked) checked++;
            }
        }

        const pct = total ? Math.round(checked / total * 100) : 0;
        return { total, checked, pct };
    }

    function _statusOf(pct) {
        if (pct === 100) return 'done';
        if (pct > 0)     return 'partial';
        return 'none';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function _levelBadges(levels) {
        const map = {
            pre:  ['Pre-Elem', 'st-level-pre'],
            elem: ['Elem',     'st-level-elem'],
            jhs:  ['JHS',      'st-level-jhs'],
            shs:  ['SHS',      'st-level-shs'],
        };
        return levels.map(l =>
            `<span class="st-level-badge ${map[l][1]}">${map[l][0]}</span>`
        ).join('');
    }

    function _progClass(pct) {
        if (pct === 0)   return 'st-pf-zero';
        if (pct >= 80)   return 'st-pf-high';
        if (pct >= 40)   return 'st-pf-mid';
        return 'st-pf-low';
    }

    function _statusBadge(pct) {
        if (pct === 100) return '<span class="st-sbadge st-sb-done">Completed</span>';
        if (pct > 0)     return '<span class="st-sbadge st-sb-partial">Ongoing</span>';
        return '<span class="st-sbadge st-sb-none">Pending</span>';
    }

    function _loadCardIndTypePrefs() {
        try {
            const raw = window.localStorage ? window.localStorage.getItem(CARD_IND_TYPE_STORAGE_KEY) : '';
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            const validTypes = new Set(CARD_INDORSEMENT_TYPES.map(t => t.key));
            for (const [sid, type] of Object.entries(parsed)) {
                if (validTypes.has(type)) _cardIndTypeBySchoolId[sid] = type;
            }
        } catch (e) { /* ignore */ }
    }

    function _saveCardIndTypePrefs() {
        try {
            if (!window.localStorage) return;
            window.localStorage.setItem(CARD_IND_TYPE_STORAGE_KEY, JSON.stringify(_cardIndTypeBySchoolId));
        } catch (e) { /* ignore */ }
    }

    function _cardIndType(sid) {
        return _cardIndTypeBySchoolId[sid] || 'school_calendar';
    }

    function _indTypeOptionsHtml(selected) {
        return CARD_INDORSEMENT_TYPES.map(t =>
            `<option value="${t.key}"${t.key === selected ? ' selected' : ''}>${_esc(t.label)}</option>`
        ).join('');
    }

    function _levelTextForSchool(levels) {
        const map = {
            pre:  'Pre-Elementary Course',
            elem: 'Elementary Course',
            jhs:  'Junior High School Course',
            shs:  'Senior High School Course',
        };
        return (levels || []).map(l => map[l]).filter(Boolean).join(', ');
    }

    function _renderCardActions(school) {
        const sid = school.id;
        const selectedType = _cardIndType(sid);
        const open = _openActionMenuSchoolId === sid;
        return `<div class="st-card-actions" onclick="event.stopPropagation()">
            <button type="button" class="st-card-menu-btn${open ? ' active' : ''}" aria-label="School actions" aria-expanded="${open ? 'true' : 'false'}" onclick="ST._toggleCardMenu(event, ${sid})">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
            <div class="st-card-menu${open ? ' open' : ''}">
                <div class="st-card-menu-title">Generate Indorsement</div>
                <label class="st-card-menu-label" for="st-ind-type-${sid}">Indorsement Type</label>
                <select id="st-ind-type-${sid}" class="st-card-menu-select" onchange="ST._setCardIndType(event, ${sid})">
                    ${_indTypeOptionsHtml(selectedType)}
                </select>
                <div class="st-card-menu-actions">
                    <button type="button" class="st-card-act st-card-act-open" onclick="ST._openIndorsementFromCard(event, ${sid})"><i class="fa-regular fa-pen-to-square"></i> Open Form</button>
                    <button type="button" class="st-card-act st-card-act-download" onclick="ST._downloadIndorsementFromCard(event, ${sid})"><i class="fa-solid fa-download"></i> Download</button>
                </div>
            </div>
        </div>`;
    }

    function _esc(s) {
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // YEAR BAR
    // ─────────────────────────────────────────────────────────────────────────
    function _renderYrBar() {
        const bar = document.getElementById('st-yr-bar');
        if (!bar) return;

        // ── Private / Public type tabs ──
        let html = `<div style="display:flex;gap:0;border-bottom:1.5px solid var(--color-border-tertiary);margin-bottom:12px;width:100%;">
            <button class="st-type-tab${_schoolType === 'private' ? ' active' : ''}" onclick="ST.switchSchoolType('private')">Private Schools</button>
            <button class="st-type-tab${_schoolType === 'public' ? ' active' : ''}" onclick="ST.switchSchoolType('public')">Public Schools</button>
        </div>`;

        // ── If Public → show under-development banner, hide rest ──
        if (_schoolType === 'public') {
            html += `<div style="padding:40px 20px;text-align:center;">
                <div style="width:56px;height:56px;border-radius:12px;background:#fef9c3;border:1px solid #fde047;
                    display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                    <i class="fa-solid fa-screwdriver-wrench" style="font-size:22px;color:#854d0e;"></i>
                </div>
                <div style="font-size:16px;font-weight:700;color:var(--color-text-primary);margin-bottom:8px;">
                    Public Schools — Under Development
                </div>
                <div style="font-size:13px;color:var(--color-text-secondary);line-height:1.7;max-width:420px;margin:0 auto 16px;">
                    Public school document submissions follow a different process and checklist structure.
                    This section is currently being built to support those workflows.
                </div>
                <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 16px;
                    background:#fef9c3;border:1px solid #fde047;border-radius:20px;
                    font-size:12px;font-weight:600;color:#854d0e;">
                    <i class="fa-solid fa-circle-info" style="font-size:11px;"></i> Coming soon
                </span>
            </div>`;
            bar.innerHTML = html;
            _setTrackerBodyVisible(false);
            return;
        }

        // ── Private → show year pills + school selector ──
        _setTrackerBodyVisible(true);

        const activeSchoolName = _selectedSchoolId
            ? (_activeSchools().find(s => s.id === _selectedSchoolId)?.name || 'All Schools')
            : 'All Schools';

        // Calculate next year for the add button
        const lastYr = _years[_years.length - 1] || '';
        const lastMatch = lastYr.match(/^(\d{4})-(\d{4})$/);
        const nextYr = lastMatch
            ? (parseInt(lastMatch[2]) + '-' + (parseInt(lastMatch[2]) + 1))
            : null;
        const nextExists = nextYr && _years.includes(nextYr);

        html += `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">`;

        // Year pills — each has the year label + a delete × button
        _years.forEach(yr => {
            const isActive = yr === _currentYear;
            const activeBg      = isActive ? '#1d4ed8' : 'transparent';
            const activeColor   = isActive ? '#fff'    : 'var(--color-text-primary)';
            const activeBorder  = isActive ? '#1d4ed8' : '#e5e7eb';
            const delBg         = isActive ? '#1e40af' : '#f9fafb';
            const delColor      = isActive ? '#bfdbfe' : '#9ca3af';
            const delBorderL    = isActive ? '#3b82f6' : '#e5e7eb';

            html += `<div style="display:inline-flex;align-items:stretch;border-radius:20px;
                overflow:hidden;border:1px solid ${activeBorder};">
                <button onclick="ST.switchYear('${_esc(yr)}')"
                    style="padding:5px 10px 5px 14px;border:none;background:${activeBg};
                        color:${activeColor};font-size:13px;font-weight:${isActive ? '600' : '400'};
                        cursor:pointer;font-family:inherit;white-space:nowrap;line-height:1.4;">
                    ${_esc(yr)}
                </button>
                <button onclick="ST._deleteYear('${_esc(yr)}')"
                    title="Delete ${_esc(yr)}"
                    style="padding:5px 9px;border:none;border-left:1px solid ${delBorderL};
                        background:${delBg};color:${delColor};font-size:11px;
                        cursor:pointer;line-height:1;transition:background .15s,color .15s;"
                    onmouseover="this.style.background='#fee2e2';this.style.color='#dc2626';"
                    onmouseout="this.style.background='${delBg}';this.style.color='${delColor}';">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
        });

        // Add year button — shows the pre-calculated next year label, one click adds it
        if (nextYr && !nextExists) {
            html += `<button class="st-yr-add" onclick="ST._addNextYear()"
                title="Add ${_esc(nextYr)}"
                style="display:inline-flex;align-items:center;gap:5px;">
                <i class="fa-solid fa-plus" style="font-size:10px;"></i>
                ${_esc(nextYr)}
            </button>`;
        }

        html += `</div>

            <!-- School selector -->
            <div style="position:relative;" id="stSchoolSelectorWrap">
                <button id="stSchoolSelectorBtn" onclick="ST._toggleSchoolSelector(event)"
                    style="display:flex;align-items:center;gap:7px;padding:7px 14px;
                        background:#eef2ff;border:1.5px solid #c7d2fe;border-radius:8px;
                        color:#3730a3;font-size:12px;font-weight:600;cursor:pointer;
                        font-family:inherit;white-space:nowrap;">
                    <i class="fa-solid fa-school" style="font-size:12px;"></i>
                    <span id="stSchoolSelectorLabel">${_esc(activeSchoolName)}</span>
                    <i class="fa-solid fa-chevron-down" style="font-size:10px;"></i>
                </button>
                <div id="stSchoolDropdown" style="display:none;position:absolute;top:calc(100% + 6px);right:0;
                    width:260px;background:#fff;
                    border:1px solid #e5e7eb;border-radius:10px;
                    box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:300;overflow:hidden;">
                    <div style="padding:8px 10px;border-bottom:1px solid #f3f4f6;background:#fff;">
                        <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;
                            background:#f3f4f6;border-radius:6px;">
                            <i class="fa-solid fa-magnifying-glass" style="font-size:11px;color:#9ca3af;flex-shrink:0;"></i>
                            <input type="text" id="stSchoolSearchInput" placeholder="Search school…"
                                oninput="ST._filterSchoolSelector(this.value)"
                                style="border:none;background:transparent;font-size:12px;
                                    color:#111827;outline:none;font-family:inherit;width:100%;">
                        </div>
                    </div>
                    <div id="stSchoolSelectorList" style="max-height:220px;overflow-y:auto;padding:5px 6px 8px;background:#fff;">
                        <button onclick="ST._selectSchool(null, this)"
                            style="width:100%;text-align:left;padding:7px 10px;border:none;
                                border-radius:6px;font-size:13px;cursor:pointer;
                                font-family:inherit;margin-bottom:2px;display:flex;
                                align-items:center;gap:7px;
                                background:${!_selectedSchoolId ? '#eef2ff' : '#fff'};
                                color:${!_selectedSchoolId ? '#3730a3' : '#111827'};
                                font-weight:${!_selectedSchoolId ? '600' : '400'};">
                            <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;
                                background:${!_selectedSchoolId ? '#6366f1' : '#d1d5db'};"></span>
                            All Schools (${_activeSchools().length})
                        </button>
                        ${_activeSchools().map(s => `
                            <button onclick="ST._selectSchool(${s.id}, this)"
                                style="width:100%;text-align:left;padding:7px 10px;border:none;
                                    border-radius:6px;font-size:12px;cursor:pointer;
                                    font-family:inherit;margin-bottom:1px;display:block;
                                    background:${_selectedSchoolId === s.id ? '#eef2ff' : '#fff'};
                                    color:${_selectedSchoolId === s.id ? '#3730a3' : '#111827'};
                                    font-weight:${_selectedSchoolId === s.id ? '600' : '400'};"
                                onmouseover="if(this.style.background==='rgb(255, 255, 255)')this.style.background='#f9fafb';"
                                onmouseout="this.style.background='${_selectedSchoolId === s.id ? '#eef2ff' : '#fff'}';">
                                ${_esc(s.name)}
                            </button>`
                        ).join('')}
                    </div>
                </div>
            </div>
        </div>`;

        bar.innerHTML = html;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATS BAR
    // ─────────────────────────────────────────────────────────────────────────
    function _renderStats() {
        const el = document.getElementById('st-stats-row');
        if (!el) return;
        let done = 0, partial = 0, none = 0;
        for (const s of _activeSchools()) {
            const { pct } = _progress(_currentYear, s.id);
            if (pct === 100) done++;
            else if (pct > 0) partial++;
            else none++;
        }
        el.innerHTML = `
            <div class="st-stat-card">
                <div class="st-stat-label">Total Schools</div>
                <div class="st-stat-val st-sv-blue">${_activeSchools().length}</div>
            </div>
            <div class="st-stat-card">
                <div class="st-stat-label">Completed</div>
                <div class="st-stat-val st-sv-green">${done}</div>
            </div>
            <div class="st-stat-card">
                <div class="st-stat-label">Ongoing</div>
                <div class="st-stat-val st-sv-amber">${partial}</div>
            </div>
            <div class="st-stat-card">
                <div class="st-stat-label">Pending</div>
                <div class="st-stat-val st-sv-red">${none}</div>
            </div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SCHOOL CARDS
    // ─────────────────────────────────────────────────────────────────────────
    function _filteredSchools() {
        const q = _search.toLowerCase();
        return _activeSchools().filter(s => {
            if (_selectedSchoolId !== null && s.id !== _selectedSchoolId) return false;
            if (q && !s.name.toLowerCase().includes(q)) return false;
            if (_filter === 'all') return true;
            const { pct } = _progress(_currentYear, s.id);
            return _statusOf(pct) === _filter;
        });
    }

    function _renderSchools() {
        const grid = document.getElementById('st-schools-grid');
        if (!grid) return;
        const schools = _filteredSchools();

        if (!schools.length) {
            grid.innerHTML = '<div class="st-empty">No schools match your search or filter.</div>';
            return;
        }

        if (_view === 'list') {
            grid.innerHTML = schools.map(s => {
                const { checked, total, pct } = _progress(_currentYear, s.id);
                return `<div class="st-card" onclick="ST._openPanel(${s.id})">
                    <span class="st-card-num">#${s.id}</span>
                    <span class="st-card-name">${_esc(s.name)}</span>
                    <div class="st-prog-wrap">
                        <div class="st-prog-labels"><span>${checked}/${total}</span><span>${pct}%</span></div>
                        <div class="st-prog-bar"><div class="st-prog-fill ${_progClass(pct)}" style="width:${pct}%"></div></div>
                    </div>
                    <div class="st-card-badges">${_levelBadges(s.levels)}</div>
                    ${_renderCardActions(s)}
                </div>`;
            }).join('');
            return;
        }

        grid.innerHTML = schools.map(s => {
            const { checked, total, pct } = _progress(_currentYear, s.id);
            return `<div class="st-card" onclick="ST._openPanel(${s.id})">
                <div class="st-card-header">
                    <span class="st-card-num">#${s.id} &middot; ${_esc(_currentYear)}</span>
                    <div class="st-card-header-actions">
                        <div class="st-card-badges">${_levelBadges(s.levels)}</div>
                        ${_renderCardActions(s)}
                    </div>
                </div>
                <div class="st-card-name">${_esc(s.name)}</div>
                <div class="st-prog-wrap">
                    <div class="st-prog-labels"><span>${pct}% complete</span><span>${checked}/${total} steps</span></div>
                    <div class="st-prog-bar"><div class="st-prog-fill ${_progClass(pct)}" style="width:${pct}%"></div></div>
                </div>
                ${_statusBadge(pct)}
            </div>`;
        }).join('');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SLIDE-OUT PANEL
    // ─────────────────────────────────────────────────────────────────────────
    function _openPanel(sid) {
        const s = _activeSchools().find(x => x.id === sid);
        if (!s) return;
        _panelSid  = sid;

        // Deep-clone the school data into _panelTemp as normalised cells
        const src = _schoolData(_currentYear, sid);
        _panelTemp = {};
        for (const [k, v] of Object.entries(src)) {
            _panelTemp[k] = _normaliseCell(v);
        }

        document.getElementById('st-panel-title').textContent = s.name;
        document.getElementById('st-panel-sub').textContent   = 'SY ' + _currentYear + ' · Document Tracking';

        _renderPanelBody(s);
        _updatePanelRing();

        document.getElementById('st-panel-overlay').classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    /**
     * Renders a single timestamp badge for display inside a table cell.
     * Shows date + time if available, greyed out "—" otherwise.
     */
    function _tsBadgeHtml(cell) {
        if (!cell || !cell.checked) return '';
        if (cell.ts) {
            const formatted = _fmtTs(cell.ts);
            if (!formatted) return '';
            return `<div class="st-ts-badge" title="${_esc(cell.by ? 'by ' + cell.by : '')}">${_esc(formatted)}</div>`;
        }
        if (cell.q) {
            return `<div class="st-ts-badge" title="${_esc(cell.by ? 'by ' + cell.by : '')}">${_esc(cell.q)}</div>`;
        }
        return '';
    }

    function _renderPanelBody(s) {
        const body = document.getElementById('st-panel-body');
        const { checked, total, pct } = _progress(_currentYear, s.id);

        let html = `
            <div class="st-panel-score-row">
                <div class="st-ring-wrap">
                    <svg id="st-ring-svg" width="60" height="60" viewBox="0 0 60 60"></svg>
                    <div class="st-ring-num" id="st-ring-num">${pct}%</div>
                </div>
                <div class="st-panel-meta">
                    <div class="st-panel-school-name">${_esc(s.name)}</div>
                    <div class="st-panel-school-sub" id="st-panel-checked-label">${checked} of ${total} steps completed &middot; ${_esc(_currentYear)}</div>
                    <div class="st-card-badges" style="margin-top:6px;">${_levelBadges(s.levels)}</div>
                </div>
            </div>`;

        for (const cat of CATEGORIES) {
            // Collect all checked keys in this category for the timestamp editor
            const catCheckedKeys = [];
            for (const row of cat.rows) {
                for (const step of cat.steps) {
                    const k = _cbKey(cat.key, row, step);
                    const cell = _normaliseCell(_panelTemp[k]);
                    if (cell.checked) catCheckedKeys.push(k);
                }
            }

            html += `<div class="st-cat-section">
                <div class="st-cat-title-row">
                    <span class="st-cat-title">${_esc(cat.label)}</span>
                    <button class="st-ts-edit-btn" 
                        onclick="ST._openTsEditor('${_esc(cat.key)}')"
                        title="Edit timestamps for this section">
                        <i class="fa-solid fa-clock"></i> Edit Timestamps
                    </button>
                </div>
                <div class="st-cat-table-wrap">
                <table class="st-doc-table">
                    <thead><tr>
                        ${cat.noRowLabel ? '' : '<th>Document / Level</th>'}
                        ${cat.steps.map(st => `<th>${_esc(st)}</th>`).join('')}
                    </tr></thead>
                    <tbody>`;

            for (const row of cat.rows) {
                html += `<tr>${cat.noRowLabel ? '' : `<td class="st-row-label">${_esc(row)}</td>`}`;
                for (const step of cat.steps) {
                    const k    = _cbKey(cat.key, row, step);
                    const cell = _normaliseCell(_panelTemp[k]);
                    html += `<td class="st-cb-cell">
                        <input type="checkbox"${cell.checked ? ' checked' : ''} data-key="${_esc(k)}" onchange="ST._onCbChange(this)">
                        ${_tsBadgeHtml(cell)}
                    </td>`;
                }
                html += '</tr>';
            }

            html += `</tbody></table></div></div>`;
        }

        body.innerHTML = html;
        _updatePanelRing();
    }

    function _updatePanelRing() {
        let total = 0, checked = 0;
        for (const cat of CATEGORIES) {
            for (const row of cat.rows) {
                for (const step of cat.steps) {
                    total++;
                    const cell = _normaliseCell(_panelTemp[_cbKey(cat.key, row, step)]);
                    if (cell.checked) checked++;
                }
            }
        }
        const pct = total ? Math.round(checked / total * 100) : 0;
        const color = pct >= 80 ? 'var(--color-text-success,#16a34a)'
                    : pct >= 40 ? 'var(--color-text-warning,#d97706)'
                    : 'var(--color-text-danger,#dc2626)';

        const r = 22, cx = 30, cy = 30;
        const circ = 2 * Math.PI * r;
        const dash  = (pct / 100) * circ;

        const svg = document.getElementById('st-ring-svg');
        if (svg) {
            svg.innerHTML = `
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--color-border-tertiary)" stroke-width="5"/>
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
                    stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
                    stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
        }
        const num = document.getElementById('st-ring-num');
        if (num) { num.textContent = pct + '%'; num.style.color = color; }

        const lbl = document.getElementById('st-panel-checked-label');
        if (lbl) lbl.textContent = checked + ' of ' + total + ' steps completed \u00B7 ' + _currentYear;
    }

    /**
     * Called when a checkbox is toggled in the panel.
     * Stamps the current time when checking; clears the timestamp when unchecking.
     */
    function _onCbChange(el) {
        const key = el.dataset.key;
        const existing = _normaliseCell(_panelTemp[key]);
        const nowChecked = el.checked;

        _panelTemp[key] = _mkCell(
            nowChecked,
            nowChecked
                ? (existing.ts || new Date().toISOString())  // keep existing ts if re-checking
                : null,
            existing.by || null,
            nowChecked ? (existing.q || null) : null,
        );

        // Update the timestamp badge in the same cell without re-rendering the entire panel
        const cell = el.closest('.st-cb-cell');
        if (cell) {
            // Remove old badge
            const oldBadge = cell.querySelector('.st-ts-badge');
            if (oldBadge) oldBadge.remove();
            // Insert new badge after checkbox
            const badge = _tsBadgeHtml(_panelTemp[key]);
            if (badge) el.insertAdjacentHTML('afterend', badge);
        }

        _updatePanelRing();
    }

    async function _savePanel() {
        if (_panelSid === null) return;
        const sid = _panelSid;
        _yrData(_currentYear)[sid] = JSON.parse(JSON.stringify(_panelTemp));
        _closePanel();
        _renderAll();
        try {
            await _saveToServer(_currentYear, sid);
            if (typeof showToast === 'function') showToast('Changes saved successfully.', 'success');
        } catch (e) {
            if (typeof showToast === 'function') showToast('Failed to save changes. Please try again.', 'error');
        }
    }

    function _cancelPanel() {
        _panelTemp = {};
        _closePanel();
    }

    function _closePanel() {
        document.getElementById('st-panel-overlay').classList.remove('open');
        document.body.style.overflow = '';
        _panelSid = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIMESTAMP EDITOR MODAL
    // Opens when the user clicks "Edit Timestamps" on a category section.
    // Shows every checked step in that category with a datetime-local input.
    // ─────────────────────────────────────────────────────────────────────────

    function _openTsEditor(catKey) {
        // Find the matching category
        const cat = CATEGORIES.find(c => c.key === catKey);
        if (!cat) return;
        const catLabel = cat.label;

        // Collect all checked steps in this category from _panelTemp
        const entries = []; // { key, rowLabel, stepLabel, cell }
        for (const row of cat.rows) {
            for (const step of cat.steps) {
                const k    = _cbKey(cat.key, row, step);
                const cell = _normaliseCell(_panelTemp[k]);
                entries.push({ key: k, rowLabel: row, stepLabel: step, cell });
            }
        }

        const checkedEntries  = entries.filter(e => e.cell.checked);
        const allEntries      = entries; // show all for unchecked grayed out

        // Remove any existing modal
        const existing = document.getElementById('stTsEditorOverlay');
        if (existing) existing.remove();

        // Build modal HTML
        const rowsHtml = allEntries.map(e => {
            const isChecked = e.cell.checked;
            const inputVal  = _tsToInputVal(e.cell.ts);
            const modeVal   = (e.cell.q && !e.cell.ts) ? 'quarter' : 'exact';
            const qVal      = _validQuarterKey(e.cell.q) ? e.cell.q : '';
            const labelText = cat.noRowLabel
                ? e.stepLabel
                : (e.rowLabel ? `${e.rowLabel} — ${e.stepLabel}` : e.stepLabel);
            return `<div class="st-ts-row${isChecked ? '' : ' st-ts-row--unchecked'}">
                <div class="st-ts-row-label">
                    <span class="st-ts-row-check">${isChecked ? '✓' : '○'}</span>
                    <span>${_esc(labelText)}</span>
                </div>
                ${isChecked
                    ? `<div class="st-ts-row-input-wrap">
                            <select class="st-ts-mode" data-key="${_esc(e.key)}" onchange="ST._onTsModeChange(this)" title="Choose exact date/time or quarter-only">
                                <option value="exact"${modeVal === 'exact' ? ' selected' : ''}>Exact</option>
                                <option value="quarter"${modeVal === 'quarter' ? ' selected' : ''}>Quarter</option>
                            </select>
                            <input type="datetime-local" class="st-ts-input"
                                data-key="${_esc(e.key)}"
                                value="${_esc(inputVal)}"
                                title="Set the date and time this step was completed" ${modeVal === 'quarter' ? 'style="display:none"' : ''} />
                            <select class="st-ts-qselect" data-key="${_esc(e.key)}" title="Select quarter" ${modeVal === 'quarter' ? '' : 'style="display:none"'}>
                                <option value=""${qVal === '' ? ' selected' : ''}>Select…</option>
                                <option value="Q1"${qVal === 'Q1' ? ' selected' : ''}>Q1</option>
                                <option value="Q2"${qVal === 'Q2' ? ' selected' : ''}>Q2</option>
                                <option value="Q3"${qVal === 'Q3' ? ' selected' : ''}>Q3</option>
                                <option value="Q4"${qVal === 'Q4' ? ' selected' : ''}>Q4</option>
                            </select>
                            <button type="button" class="st-ts-clear-btn"
                                onclick="ST._clearTsInput('${_esc(e.key)}')"
                                title="Clear timestamp / quarter">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                       </div>`
                    : `<div class="st-ts-row-disabled">Not checked — check the box first</div>`
                }
            </div>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.id = 'stTsEditorOverlay';
        overlay.className = 'st-ts-overlay';
        overlay.innerHTML = `
            <div class="st-ts-modal" role="dialog" aria-modal="true" aria-label="Edit Timestamps">
                <div class="st-ts-modal-header">
                    <div>
                        <div class="st-ts-modal-title">
                            <i class="fa-solid fa-clock" style="color:#6366f1;margin-right:7px;"></i>
                            Edit Timestamps
                        </div>
                        <div class="st-ts-modal-sub">${_esc(catLabel)} &middot; ${_esc(_currentYear)}</div>
                    </div>
                    <button class="st-ts-modal-close" onclick="ST._closeTsEditor()" title="Close">&times;</button>
                </div>
                <div class="st-ts-modal-body">
                    <div class="st-ts-help">
                        <i class="fa-solid fa-circle-info" style="color:#6366f1;flex-shrink:0;"></i>
                        <span>Set an exact date/time, or choose a quarter when the exact date is unknown.
                            Changes apply when you click <strong>Apply</strong>.</span>
                    </div>
                    <div class="st-ts-rows" id="stTsRows">
                        ${rowsHtml || '<p style="color:var(--color-text-secondary);font-size:13px;padding:8px 0;">No steps in this section yet.</p>'}
                    </div>
                </div>
                <div class="st-ts-modal-footer">
                    <button class="st-ts-btn-cancel" onclick="ST._closeTsEditor()">Cancel</button>
                    <button class="st-ts-btn-apply" onclick="ST._applyTsEditor('${_esc(catKey)}')">
                        <i class="fa-solid fa-check" style="margin-right:5px;"></i>Apply
                    </button>
                </div>
            </div>`;

        overlay.addEventListener('click', e => {
            if (e.target === overlay) ST._closeTsEditor();
        });

        document.body.appendChild(overlay);

        // Trap Escape key
        const onKey = e => {
            if (e.key === 'Escape') { ST._closeTsEditor(); document.removeEventListener('keydown', onKey); }
        };
        document.addEventListener('keydown', onKey);
    }

    function _closeTsEditor() {
        const el = document.getElementById('stTsEditorOverlay');
        if (el) el.remove();
    }

    /**
     * Clear the timestamp input for a specific key inside the ts editor.
     */
    function _clearTsInput(key) {
        const input = document.querySelector(`#stTsRows input[data-key="${CSS.escape(key)}"]`);
        if (input) input.value = '';
        const qsel = document.querySelector(`#stTsRows select.st-ts-qselect[data-key="${CSS.escape(key)}"]`);
        if (qsel) qsel.value = '';
    }

    /**
     * Read all datetime-local inputs inside the ts editor and write the
     * values back into _panelTemp, then close the modal.
     */
    function _applyTsEditor(catKey) {
        const modeEls = document.querySelectorAll('#stTsRows select.st-ts-mode');
        modeEls.forEach(modeEl => {
            const key = modeEl.dataset.key;
            const cell = _normaliseCell(_panelTemp[key]);
            if (!cell.checked) return;

            const mode = modeEl.value;
            const dtInput = document.querySelector(`#stTsRows input.st-ts-input[data-key="${CSS.escape(key)}"]`);
            const qSel    = document.querySelector(`#stTsRows select.st-ts-qselect[data-key="${CSS.escape(key)}"]`);

            if (mode === 'quarter') {
                const q = qSel ? String(qSel.value || '').trim().toUpperCase() : '';
                _panelTemp[key] = _mkCell(true, null, cell.by, _validQuarterKey(q) ? q : null);
            } else {
                const newTs = _inputValToTs(dtInput ? dtInput.value : '');
                _panelTemp[key] = _mkCell(true, newTs, cell.by, null);
            }

            // Update the badge in the panel if it's still open
            const cbCell = document.querySelector(`.st-cb-cell input[data-key="${CSS.escape(key)}"]`);
            if (cbCell) {
                const wrap = cbCell.closest('.st-cb-cell');
                if (wrap) {
                    const old = wrap.querySelector('.st-ts-badge');
                    if (old) old.remove();
                    const badge = _tsBadgeHtml(_panelTemp[key]);
                    if (badge) cbCell.insertAdjacentHTML('afterend', badge);
                }
            }
        });

        _closeTsEditor();
        _updatePanelRing();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FULL RE-RENDER
    // ─────────────────────────────────────────────────────────────────────────
    function _renderAll() {
        _renderYrBar();
        _renderStats();
        _renderSchools();
    }

    function _closeCardMenu() {
        if (_openActionMenuSchoolId === null) return;
        _openActionMenuSchoolId = null;
        _renderSchools();
    }

    async function _openIndorsementFromCard(event, sid, triggerDownload) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        const school = _activeSchools().find(x => x.id === sid);
        if (!school) return;

        const selectedType = _cardIndType(sid);
        const sy = _currentYear;
        const levelText = _levelTextForSchool(school.levels);

        try {
            if (typeof window.openIndorsementModal !== 'function') {
                if (typeof showToast === 'function') showToast('Indorsement form is unavailable on this page.', 'error');
                return;
            }

            _openActionMenuSchoolId = null;
            _renderSchools();

            await window.openIndorsementModal();

            if (typeof window._indSetType === 'function') {
                window._indSetType(selectedType);
            }

            if (typeof window._indSelectSchool === 'function') {
                window._indSelectSchool(sid);
            }

            const schoolNameEl = document.getElementById('ind_schoolName');
            if (schoolNameEl && !schoolNameEl.value.trim()) schoolNameEl.value = school.name.toUpperCase();

            const syEl = document.getElementById('ind_sy');
            if (syEl && sy) {
                if (!Array.from(syEl.options).some(o => o.value === sy)) {
                    const opt = document.createElement('option');
                    opt.value = sy;
                    opt.textContent = sy;
                    syEl.appendChild(opt);
                }
                syEl.value = sy;
                syEl.dispatchEvent(new Event('change', { bubbles: true }));
            }

            if (levelText && typeof window._indSetLevelSelectionFromText === 'function') {
                window._indSetLevelSelectionFromText(levelText);
            }

            if (typeof window._indUpdateSaveButtonState === 'function') {
                window._indUpdateSaveButtonState();
            }

            if (triggerDownload) {
                if (typeof window.generateStandaloneIndorsement === 'function') {
                    await window.generateStandaloneIndorsement();
                } else if (typeof showToast === 'function') {
                    showToast('Download action is unavailable on this page.', 'warning');
                }
            }
        } catch (err) {
            console.error('Could not open indorsement form:', err);
            if (typeof showToast === 'function') showToast('Could not open indorsement form.', 'error');
        }
    }

    function _bindGlobalCardMenuListeners() {
        if (_globalMenuListenersBound) return;
        _globalMenuListenersBound = true;

        document.addEventListener('click', (event) => {
            if (_openActionMenuSchoolId === null) return;
            if (event.target.closest('.st-card-actions')) return;
            _closeCardMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            _closeCardMenu();
        });

        document.addEventListener('click', (event) => {
            const wrap = document.getElementById('stSchoolSelectorWrap');
            if (!wrap) return;
            if (!wrap.contains(event.target)) {
                const dd = document.getElementById('stSchoolDropdown');
                if (dd) dd.style.display = 'none';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API  (exposed as window.ST)
    // ─────────────────────────────────────────────────────────────────────────
    window.ST = {
        async switchSchoolType(type) {
            _schoolType = type;
            if (_yearIdMap[_currentYear]) {
                await _loadYearData(_currentYear);
            }
            _renderAll();
        },
        async init() {
            await _initData();
            _loadCardIndTypePrefs();
            _bindGlobalCardMenuListeners();
            _renderAll();
        },
        async switchYear(yr) {
            _currentYear = yr;
            if (!_data[yr]) await _loadYearData(yr);
            _renderAll();
        },

        // ── Add next year automatically (no text input) ──
        _addNextYear() {
            const lastYear = _years[_years.length - 1] || '';
            const match = lastYear.match(/^(\d{4})-(\d{4})$/);
            if (!match) return;
            const nextStart = parseInt(match[2]);
            const nextYear  = nextStart + '-' + (nextStart + 1);
            if (_years.includes(nextYear)) return;

            _years.push(nextYear);
            _currentYear = nextYear;
            _renderAll();

            _apiPost('add_year', { school_year: nextYear }).then(json => {
                if (json.success && json.year) {
                    _yearIdMap[nextYear] = json.year.id;
                }
            }).catch(() => {});
        },

        // ── Delete year (only if no checked records) ──
        async _deleteYear(yr) {
            if (_years.length <= 1) {
                alert('You must keep at least one school year.');
                return;
            }
            const yid = _yearIdMap[yr];
            if (yid) {
                try {
                    const json = await _apiGet({ action: 'check_year_empty', year_id: yid });
                    if (!json.success || !json.empty) {
                        alert('Cannot delete "' + yr + '" — it has existing tracking records.\nClear all records for this year before deleting it.');
                        return;
                    }
                } catch (e) {
                    alert('Could not verify whether this year has records. Please try again.');
                    return;
                }
            }
            if (!confirm('Delete school year "' + yr + '"?\nThis cannot be undone.')) return;
            _years = _years.filter(y => y !== yr);
            if (_currentYear === yr) _currentYear = _years[0] || '';
            _renderAll();
            if (yid) {
                _apiPost('delete_year', { year_id: yid }).catch(() => {});
            }
        },

        // Kept for backwards compatibility — no longer renders an input
        _toggleAddYr() { this._addNextYear(); },
        _confirmAddYr() {},

        setFilter(f, el) {
            _filter = f;
            document.querySelectorAll('.st-fpill').forEach(p => p.classList.remove('active'));
            if (el) el.classList.add('active');
            _renderSchools();
            _renderStats();
        },
        setView(v, el) {
            _view = v;
            document.querySelectorAll('.st-vbtn').forEach(b => b.classList.remove('active'));
            if (el) el.classList.add('active');
            const grid = document.getElementById('st-schools-grid');
            if (grid) grid.className = 'st-schools-grid st-view-' + v;
            _renderSchools();
        },

        _onTsModeChange(sel) {
            const key = sel.dataset.key;
            const mode = sel.value;
            const dtInput = document.querySelector(`#stTsRows input.st-ts-input[data-key="${CSS.escape(key)}"]`);
            const qSel    = document.querySelector(`#stTsRows select.st-ts-qselect[data-key="${CSS.escape(key)}"]`);
            if (mode === 'quarter') {
                if (dtInput) dtInput.style.display = 'none';
                if (qSel) qSel.style.display = '';
            } else {
                if (dtInput) dtInput.style.display = '';
                if (qSel) qSel.style.display = 'none';
            }
        },
        onSearch(val) {
            _search = val;
            _renderSchools();
            _renderStats();
        },
        _toggleCardMenu(event, sid) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            _openActionMenuSchoolId = (_openActionMenuSchoolId === sid) ? null : sid;
            _renderSchools();
        },
        _setCardIndType(event, sid) {
            if (event) event.stopPropagation();
            _cardIndTypeBySchoolId[sid] = event && event.target ? event.target.value : 'school_calendar';
            _saveCardIndTypePrefs();
        },
        _openIndorsementFromCard(event, sid) {
            _openIndorsementFromCard(event, sid, false);
        },
        _downloadIndorsementFromCard(event, sid) {
            _openIndorsementFromCard(event, sid, true);
        },
        _openPanel,
        _onCbChange,
        _savePanel,
        _cancelPanel,
        _closePanelOnBg(e) {
            if (e.target === document.getElementById('st-panel-overlay')) _cancelPanel();
        },
        _toggleSchoolSelector(event) {
            if (event) event.stopPropagation();
            const dd = document.getElementById('stSchoolDropdown');
            if (!dd) return;
            const isOpen = dd.style.display !== 'none';
            dd.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) {
                setTimeout(() => document.getElementById('stSchoolSearchInput')?.focus(), 50);
            }
        },
        _filterSchoolSelector(val) {
            const list = document.getElementById('stSchoolSelectorList');
            if (!list) return;
            const btns = list.querySelectorAll('button:not(:first-child)');
            btns.forEach(b => {
                b.style.display = b.textContent.trim().toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
            });
        },
        _selectSchool(id, btn) {
            _selectedSchoolId = id;
            const dd = document.getElementById('stSchoolDropdown');
            if (dd) dd.style.display = 'none';
            _renderYrBar();
            _renderSchools();
            _renderStats();
        },

        // ── Timestamp editor API ──
        _openTsEditor,
        _closeTsEditor,
        _applyTsEditor,
        _clearTsInput,
    };

})();