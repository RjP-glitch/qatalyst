/**
 * summary-report.js  (updated)
 * Schools Submissions Summary — frontend logic
 *
 * Changes:
 *   - Table now shows Q1/Q2/Q3/Q4 quarterly counts (Endorsed / Approved / Released)
 *     instead of per-category step badges.
 *   - Export A: "School List"  — one row per school, overall + per-quarter totals.
 *   - Export B: "Quarterly Counts" — category-level counts for a chosen quarter range.
 */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────
const API_URL = (typeof CONFIG !== 'undefined' && CONFIG.API_URL)
    ? CONFIG.API_URL
    : '/api';

const TRACKER_API         = API_URL + '/school-tracker.php';
const PRIVATE_SCHOOLS_API = API_URL + '/private_schools.php';
const MAIN_SETTINGS_API   = API_URL + '/main-settings.php';

// ─── Category Definitions (mirrors school-tracker.js CATEGORIES) ─────────────
const CATEGORIES = [
    { key: 'school_calendar',      label: 'School Calendar',
      rows: ['School Calendar'],
      steps: ['Received w/ Compliance','Endorsed to RO','Approved','Released'] },
    { key: 'tuition_increase',     label: 'Increase on Tuition Fee',
      rows: ['Pre-School','Elementary','Junior HS','Senior HS'],
      steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'no_increase',          label: 'No Increase on Tuition Fee',
      rows: ['Pre-School','Elementary','Junior HS','Senior HS'],
      steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'authority_new',        label: 'Authority to Operate (New)',
      rows: ['Pre-Elem','Elem','JHS'],
      steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'renewal_permit',       label: 'Renewal of Gov\'t Permit',
      rows: [''], steps: ['Endorsed to RO','Approved','Released'], noRowLabel: true },
    { key: 'app_govt_recognition', label: 'Application for Gov\'t Recognition',
      rows: [''], steps: ['Pre-Elem','Elem','JHS'], noRowLabel: true },
    { key: 'tracks_strand',        label: 'Application for Tracks/Strand',
      rows: ['SHS Tracks/Strands'],
      steps: ['Endorsed to SDS','Approved','Released'] },
    { key: 'special_programs',     label: 'Application for Special Programs',
      rows: ['Special Programs'],
      steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'off_campus',           label: 'Request of Off-Campus Activities',
      rows: ['Off-Campus'], steps: ['Received & Acknowledged'] },
    { key: 'school_campaign',      label: 'School Campaign',
      rows: ['Campaign'], steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'closure',              label: 'Closure',
      rows: ['Closure'], steps: ['Endorsed to RO','Approved','Released'] },
    { key: 'special_order',        label: 'Special Order (SHS)',
      rows: [''], steps: ['Endorsed to RO','Approved','Released'], noRowLabel: true },
    { key: 'special_order_level',  label: 'Level',
      rows: [''], steps: ['Pre-Elem','Elementary','JHS','SHS'], noRowLabel: true },
];

// ─── Quarter Definitions ─────────────────────────────────────────────────────
// Calendar-year quarters:
//   Q1: Jan–Mar  |  Q2: Apr–Jun  |  Q3: Jul–Sep  |  Q4: Oct–Dec
const QUARTERS = [
    { key: 'Q1', label: '1st Quarter', months: [1, 2, 3]    },  // Jan, Feb, Mar
    { key: 'Q2', label: '2nd Quarter', months: [4, 5, 6]    },  // Apr, May, Jun
    { key: 'Q3', label: '3rd Quarter', months: [7, 8, 9]    },  // Jul, Aug, Sep
    { key: 'Q4', label: '4th Quarter', months: [10, 11, 12] },  // Oct, Nov, Dec
];

// Step types mapped to count labels
const STEP_TYPE_MAP = {
    'Endorsed to RO':         'endorsed',
    'Endorsed to SDS':        'endorsed',
    'Received w/ Compliance': 'endorsed',
    'Received & Acknowledged':'endorsed',
    'Approved':               'approved',
    'Released':               'released',
    'Pre-Elem':               'approved',
    'Elem':                   'approved',
    'JHS':                    'approved',
    'SHS':                    'released',
    'Elementary':             'approved',
};

function getStepType(step) {
    return STEP_TYPE_MAP[step] || 'other';
}

// Categories whose "steps" are level names, not workflow stages.
// These are excluded from the quarterly Endorsed/Approved/Released counts
// and shown in a dedicated Level Submissions table instead.
// Categories shown in the separate Level Submissions table
const LEVEL_SUBMISSION_CATS = new Set(['app_govt_recognition', 'special_order_level', 'authority_new', 'off_campus']);

// Categories excluded from the main quarterly Endorsed/Approved/Released table.
// authority_new has real E/A/R steps so it stays in quarterly counts.
// off_campus only has 'Received & Acknowledged' — no A/R steps, exclude it.
const EXCLUDE_FROM_QUARTERLY = new Set(['app_govt_recognition', 'special_order_level', 'off_campus']);

/** True if a category should be excluded from the main quarterly table */
function isLevelCat(catKey) {
    return LEVEL_SUBMISSION_CATS.has(catKey);
}

/** True if a category should be excluded from quarterly E/A/R counts */
function isExcludedFromQuarterly(catKey) {
    return EXCLUDE_FROM_QUARTERLY.has(catKey);
}

/** Get the quarter key ('Q1'–'Q4') from a MySQL DATETIME string */
function tsToQuarter(ts) {
    if (!ts) return null;
    try {
        // Parse without appending Z — treat as local time to avoid UTC offset shifting the month
        const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
        const d   = new Date(iso);
        if (isNaN(d)) return null;
        const m = d.getMonth() + 1; // 1–12
        for (const q of QUARTERS) {
            if (q.months.includes(m)) return q.key;
        }
        return null;
    } catch (_) { return null; }
}

// ─── State ────────────────────────────────────────────────────────────────────
let _years     = [];
let _yearIdMap = {};
let _schools   = [];
let _data      = {};
let _schoolType   = 'private';
let _currentYear  = '';
let _statusFilter = 'all';
let _catFilter    = 'all';
let _search       = '';

// For export modal
let _exportType       = null;   // 'schools' | 'quarterly' | 'word' | 'catfilter'
let _exportQRange     = ['Q1', 'Q2', 'Q3', 'Q4'];
let _exportCatFilters = [];     // [{ catKey, status: 'submitted'|'not_submitted' }]
let _exportCatLogic   = 'AND';  // 'AND' | 'OR'

// ─── Sidebar helpers ──────────────────────────────────────────────────────────
let expandedMenus = {};

function navigate(sectionName) {
	const routes = {
		dashboard: 'dashboard.html',
		programs: 'qatame.html',
		qatame: 'qatame.html',
		qms: 'qms.html',
		sbm: 'sbm.html',
		sgc: 'sgc.html',
		sdopir: 'sdopir.html',
		spir: 'spir.html',
		importfile: 'import-excell.html',
		speakers: 'speaker-roster.html',
		certificates: 'certificate.html',
		certificatesplitter: 'certificates-splitter.html',
		checklist: 'checklist.html',
		documentssubmittedall: 'documents-submitted-all.html',
		settings: 'main-settings.html',
		users: 'user-management.html',
		directory: 'directory.html',
		auditlogs: 'audit-logs.html',
		announcements: 'announcements.html'
	};
	if (routes[sectionName]) {
		closeMobileSidebar();
		window.location.href = routes[sectionName];
	}
}

function toggleSubmenu(name) {
    expandedMenus[name] = !expandedMenus[name];
    const sub   = document.getElementById(name + '-submenu');
    const arrow = document.getElementById(name + '-arrow');
    if (sub)   sub.classList.toggle('expanded', expandedMenus[name]);
    if (arrow) arrow.classList.toggle('rotate',   expandedMenus[name]);
}

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

async function logout() {
    const btn = document.getElementById('logoutBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging out…'; }
    try {
        await fetch(API_URL + '/logout.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
        });
    } catch (e) {
    } finally {
        clearAndRedirect();
    }
}

function showToast(msg, type = 'info') {
    let toast = document.getElementById('_globalToast');
    if (!toast) return;
    const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#6366f1';
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;
        padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;
        color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .3s;
        background:${bg};opacity:1;display:block;`;
    toast.textContent = msg;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3200);
}

// ─── Category Filter Export helpers ──────────────────────────────────────────

function schoolHasCategorySubmission(schoolId, catKey) {
    const sd  = _data[schoolId] || {};
    const cat = CATEGORIES.find(c => c.key === catKey);
    if (!cat) return false;
    return cat.rows.some(row =>
        cat.steps.some(step => normaliseCell(sd[catKey + '|' + row + '|' + step]).checked)
    );
}

function schoolCategoryStatusLabel(schoolId, catKey) {
    return schoolHasCategorySubmission(schoolId, catKey) ? 'Submitted' : 'Not Submitted';
}

function _catFilterOptionsHtml(selectedKey) {
    return CATEGORIES.map(c =>
        `<option value="${c.key}"${c.key === selectedKey ? ' selected' : ''}>${c.label}</option>`
    ).join('');
}

function addCatFilterRow() {
    const container = document.getElementById('catFilterRows');
    if (!container) return;

    const usedKeys   = [...container.querySelectorAll('.cf-cat-select')].map(s => s.value);
    const defaultCat = CATEGORIES.find(c => !usedKeys.includes(c.key)) || CATEGORIES[0];

    const rowId = 'cfrow-' + Date.now();
    const div   = document.createElement('div');
    div.className = 'cat-filter-row';
    div.id        = rowId;
    div.innerHTML = `
        <select class="cf-cat-select ctrl-select" style="flex:1;min-width:0;" onchange="onCatFilterChange()">
            ${_catFilterOptionsHtml(defaultCat.key)}
        </select>
        <select class="cf-status-select ctrl-select" style="width:150px;flex-shrink:0;" onchange="onCatFilterChange()">
            <option value="not_submitted">Not Submitted</option>
            <option value="submitted">Submitted</option>
        </select>
        <button class="cf-remove-btn" onclick="removeCatFilterRow('${rowId}')" title="Remove filter">
            <i class="fa-solid fa-xmark"></i>
        </button>`;
    container.appendChild(div);
    onCatFilterChange();
}

function removeCatFilterRow(rowId) {
    document.getElementById(rowId)?.remove();
    onCatFilterChange();
}

function onCatFilterChange() {
    const rows = document.querySelectorAll('.cat-filter-row');
    _exportCatFilters = [...rows].map(row => ({
        catKey: row.querySelector('.cf-cat-select').value,
        status: row.querySelector('.cf-status-select').value,
    }));
    _updateCatFilterPreview();
    _updateCatFilterExportBtn();
}

function setCatLogic(logic) {
    _exportCatLogic = logic;
    document.getElementById('logicAND')?.classList.toggle('active', logic === 'AND');
    document.getElementById('logicOR')?.classList.toggle('active',  logic === 'OR');
    _updateCatFilterPreview();
}

function _updateCatFilterExportBtn() {
    const btn = document.getElementById('doExportBtn');
    if (btn) btn.disabled = _exportCatFilters.length === 0;
}

function _updateCatFilterPreview() {
    const el = document.getElementById('catFilterPreview');
    if (!el || !_exportCatFilters.length) {
        if (el) el.textContent = '';
        return;
    }
    const schools = filteredSchools();
    const matched = schools.filter(s => _schoolMatchesCatFilters(s.id));
    const logic   = _exportCatLogic === 'AND' ? 'all filters' : 'any filter';
    const parts   = _exportCatFilters.map(f => {
        const cat = CATEGORIES.find(c => c.key === f.catKey);
        const lbl = f.status === 'submitted' ? 'submitted' : 'not submitted';
        return `<strong>${cat ? cat.label : f.catKey}</strong> = ${lbl}`;
    });
    el.innerHTML = `Matching <strong>${matched.length}</strong> of ${schools.length} schools
        (${logic}): ${parts.join(_exportCatLogic === 'AND' ? ' AND ' : ' OR ')}`;
}

function _schoolMatchesCatFilters(schoolId) {
    if (!_exportCatFilters.length) return true;
    if (_exportCatLogic === 'AND') {
        return _exportCatFilters.every(f => {
            const has = schoolHasCategorySubmission(schoolId, f.catKey);
            return f.status === 'submitted' ? has : !has;
        });
    } else {
        return _exportCatFilters.some(f => {
            const has = schoolHasCategorySubmission(schoolId, f.catKey);
            return f.status === 'submitted' ? has : !has;
        });
    }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function checkAuthentication() {
    const cachedUserId = localStorage.getItem('user_id');
    let fullName = localStorage.getItem('full_name');
    let email    = localStorage.getItem('email');

    try {
        const res  = await fetch(MAIN_SETTINGS_API, { credentials: 'include' });
        if (!res.ok) { clearAndRedirect(); return false; }
        const json = await res.json();
        if (!json.success || !json.data?.id) { clearAndRedirect(); return false; }

        const d = json.data;
        if (d.id)           localStorage.setItem('user_id',   String(d.id));
        if (d.full_name)  { fullName = d.full_name;  localStorage.setItem('full_name',  d.full_name); }
        if (d.email)      { email    = d.email;       localStorage.setItem('email',      d.email); }
        if (d.role)         localStorage.setItem('role',       d.role);
        if (d.account_type) localStorage.setItem('account_type', d.account_type);
        if (Array.isArray(d.permissions)) localStorage.setItem('permissions', JSON.stringify(d.permissions));

        if (d.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html'; return false;
        }

        if (d.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) avatar.innerHTML = `<img src="${d.profile_picture}"
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        }

    } catch (e) {
        if (!cachedUserId) { clearAndRedirect(); return false; }
    }

    if (typeof Permissions !== 'undefined' && typeof Permissions.loadRolePermissions === 'function') {
        await Permissions.loadRolePermissions();
    }
    if (typeof Permissions !== 'undefined' && typeof Permissions.has === 'function' && !Permissions.has('checklist')) {
        const fallbackRoutes = [
            { perm: 'dashboard',    url: 'dashboard.html' },
            { perm: 'certificates', url: 'certificate.html' },
            { perm: 'programs',     url: 'programs.html' },
            { perm: 'speakers',     url: 'speaker-roster.html' },
            { perm: 'users',        url: 'user-management.html' },
            { perm: 'settings',     url: 'main-settings.html' },
        ];
        const target = fallbackRoutes.find(r => Permissions.has(r.perm));
        window.location.href = target ? target.url : 'login.html';
        return false;
    }
    if (typeof Permissions !== 'undefined' && typeof Permissions.applyNavPermissions === 'function') {
        Permissions.applyNavPermissions();
    }

    const initial  = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    const avatar   = document.getElementById('sidebarAvatar');
    if (avatar && !avatar.querySelector('img')) avatar.textContent = initial;
    const nameEl   = document.getElementById('sidebarUserName');
    const emailEl  = document.getElementById('sidebarUserEmail');
    if (nameEl)  nameEl.textContent  = fullName || 'User';
    if (emailEl) emailEl.textContent = email    || '';

    return true;
}

function clearAndRedirect() {
    ['user_id','email','full_name','role','permissions','account_type']
        .forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiGet(params) {
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(TRACKER_API + '?' + qs, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadSchools() {
    try {
        const url = PRIVATE_SCHOOLS_API + (_schoolType !== 'private' ? '?school_type=' + encodeURIComponent(_schoolType) : '');
        const res  = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
            _schools = json.data.map(s => ({
                id:   parseInt(s.id, 10),
                name: s.name || '',
            }));
        }
    } catch (e) { console.warn('summary: failed to load schools', e); }
}

async function loadYears() {
    try {
        const json = await apiGet({ action: 'years' });
        if (json.success && json.years.length) {
            _years = json.years.map(y => y.school_year);
            json.years.forEach(y => { _yearIdMap[y.school_year] = y.id; });
        }
    } catch (e) { console.warn('summary: failed to load years', e); }

    if (!_years.length) {
        const cur = new Date().getFullYear();
        _years = [(cur - 1) + '-' + cur];
    }
    _currentYear = _years[_years.length - 1];

    const sel = document.getElementById('yearSelect');
    if (sel) {
        sel.innerHTML = _years.map(y =>
            `<option value="${y}"${y === _currentYear ? ' selected' : ''}>${y}</option>`
        ).join('');
    }
}

async function loadTrackingData() {
    const yid = _yearIdMap[_currentYear];
    if (!yid) return;

    showLoader(true);
    hideError();

    try {
        const json = await apiGet({ action: 'load', year_id: yid, school_type: _schoolType });
        if (!json.success) throw new Error(json.message || 'Load failed');
        _data = {};
        for (const [sid, cells] of Object.entries(json.data || {})) {
            const norm = {};
            for (const [k, v] of Object.entries(cells)) {
                norm[k] = normaliseCell(v);
            }
            _data[parseInt(sid, 10)] = norm;
        }
        showLoader(false);
        renderAll();
    } catch (e) {
        showLoader(false);
        showError(e.message || 'Could not load tracking data.');
    }
}

function normaliseCell(raw) {
    if (!raw) return { checked: false, ts: null, by: null, q: null };
    if (typeof raw === 'boolean') return { checked: raw, ts: null, by: null, q: null };
    if (typeof raw === 'object')  return { checked: !!raw.checked, ts: raw.ts || null, by: raw.by || null, q: normaliseQuarterKey(raw.q || null) };
    return { checked: !!raw, ts: null, by: null, q: null };
}

function normaliseQuarterKey(q) {
    if (typeof q !== 'string') return null;
    const v = q.trim().toUpperCase();
    return /^Q[1-4]$/.test(v) ? v : null;
}

// ─── Progress helpers ─────────────────────────────────────────────────────────
/**
 * Calculates required completion progress for a school.
 * When catFilter === 'all', only REQUIRED categories count toward %:
 *   1. School Calendar (all steps)
 *   2. Tuition fee per level: whichever of tuition_increase OR no_increase
 *      has any checked step is counted; the other is ignored for that level.
 *      If neither is checked, tuition_increase steps count as pending.
 *   3. Renewal of Gov't Permit (all steps)
 * When a specific category is selected, that category's own progress is shown.
 */
function schoolProgress(schoolId, catFilter) {
    const sd = _data[schoolId] || {};
    let total = 0, checked = 0;

    if (catFilter !== 'all') {
        // Single-category view: show that category's own raw progress
        const cat = CATEGORIES.find(c => c.key === catFilter);
        if (cat) {
            for (const row of cat.rows) {
                for (const step of cat.steps) {
                    total++;
                    const cell = normaliseCell(sd[cat.key + '|' + row + '|' + step]);
                    if (cell.checked) checked++;
                }
            }
        }
        const pct = total ? Math.round(checked / total * 100) : 0;
        return { total, checked, pct };
    }

    const TUITION_LEVELS = ['Pre-School', 'Elementary', 'Junior HS', 'Senior HS'];
    const TUITION_STEPS  = ['Endorsed to RO', 'Approved', 'Released'];

    // 1. School Calendar
    const SC = CATEGORIES.find(c => c.key === 'school_calendar');
    if (SC) {
        for (const row of SC.rows) {
            for (const step of SC.steps) {
                total++;
                if (normaliseCell(sd['school_calendar|' + row + '|' + step]).checked) checked++;
            }
        }
    }

    // 2. Tuition fee -- per level, pick whichever was submitted
    for (const level of TUITION_LEVELS) {
        const hasIncrease   = TUITION_STEPS.some(s => normaliseCell(sd['tuition_increase|' + level + '|' + s]).checked);
        const hasNoIncrease = TUITION_STEPS.some(s => normaliseCell(sd['no_increase|'      + level + '|' + s]).checked);
        const activeCat = hasIncrease   ? 'tuition_increase'
                        : hasNoIncrease ? 'no_increase'
                        : 'tuition_increase'; // default pending target
        for (const step of TUITION_STEPS) {
            total++;
            if (normaliseCell(sd[activeCat + '|' + level + '|' + step]).checked) checked++;
        }
    }

    // 3. Renewal of Gov't Permit
    const RP = CATEGORIES.find(c => c.key === 'renewal_permit');
    if (RP) {
        for (const row of RP.rows) {
            for (const step of RP.steps) {
                total++;
                if (normaliseCell(sd['renewal_permit|' + row + '|' + step]).checked) checked++;
            }
        }
    }

    const pct = total ? Math.round(checked / total * 100) : 0;
    return { total, checked, pct };
}

/**
 * Get quarterly counts for a school.
 * Returns { Q1: { endorsed, approved, released, total }, Q2: ..., Q3: ..., Q4: ... }
 */
function schoolQuarterlyCounts(schoolId, catFilter) {
    const sd = _data[schoolId] || {};
    const result = {};
    for (const q of QUARTERS) {
        result[q.key] = { endorsed: 0, approved: 0, released: 0, total: 0,
            endorsedItems: [], approvedItems: [], releasedItems: [] };
    }
    // also an 'unknown' bucket for checked items with no timestamp
    result['unknown'] = { endorsed: 0, approved: 0, released: 0, total: 0,
        endorsedItems: [], approvedItems: [], releasedItems: [] };

    // Exclude categories with no proper E/A/R steps from quarterly counts.
    // authority_new stays (it has real E/A/R steps); off_campus, app_govt_recognition,
    // and special_order_level are excluded and shown in the Level Submissions table.
    const cats = catFilter === 'all'
        ? CATEGORIES.filter(c => !isExcludedFromQuarterly(c.key))
        : CATEGORIES.filter(c => c.key === catFilter && !isExcludedFromQuarterly(c.key));

    for (const cat of cats) {
        // Categories like School Calendar have both 'Received w/ Compliance' AND
        // 'Endorsed to RO' as separate steps, but both map to the 'endorsed' type.
        // That double-counts one row's endorsement across two quarters if the two
        // steps were checked on different dates. 'Endorsed to RO' is the actual
        // endorsement step (it's what the "Endorsed" column means), so that's the
        // one that should count. 'Received w/ Compliance' is just document intake,
        // not an endorsement, so it's skipped here for endorsed-quarter purposes.
        const hasEndorsedStep = cat.steps.includes('Endorsed to RO');

        // Categories with more than one row are "leveled" (e.g. tuition fee has
        // Pre-School/Elementary/Junior HS/Senior HS). Label items with their row
        // name in that case so the summary can show WHICH level was actioned,
        // instead of just an ambiguous per-quarter checkmark.
        const isLeveled = cat.rows.length > 1 && !cat.noRowLabel;

        for (const row of cat.rows) {
            for (const step of cat.steps) {
                if (hasEndorsedStep && step === 'Received w/ Compliance') continue;

                const key  = cat.key + '|' + row + '|' + step;
                const cell = normaliseCell(sd[key]);
                if (!cell.checked) continue;

                const qKey  = cell.q || tsToQuarter(cell.ts) || 'unknown';
                const sType = getStepType(step);
                const bucket = result[qKey] || result['unknown'];
                bucket.total++;

                // Label used in tooltips: "<Level> — <Category>" when the category
                // has multiple levels, otherwise just the category label.
                const itemLabel = isLeveled ? `${row} (${cat.label})` : cat.label;

                if (sType === 'endorsed') { bucket.endorsed++; bucket.endorsedItems.push(itemLabel); }
                else if (sType === 'approved') { bucket.approved++; bucket.approvedItems.push(itemLabel); }
                else if (sType === 'released') { bucket.released++; bucket.releasedItems.push(itemLabel); }
            }
        }
    }
    return result;
}

/**
 * Aggregate quarterly counts across ALL schools, per category.
 * Returns { catKey: { Q1: { endorsed, approved, released, total }, ... }, ... }
 */
function aggregateCategoryQuarterlyCounts(schools) {
    const result = {};
    for (const cat of CATEGORIES) {
        result[cat.key] = {};
        for (const q of QUARTERS) result[cat.key][q.key] = { endorsed: 0, approved: 0, released: 0, total: 0 };
        result[cat.key]['unknown'] = { endorsed: 0, approved: 0, released: 0, total: 0 };
    }

    for (const s of schools) {
        const sd = _data[s.id] || {};
        for (const cat of CATEGORIES) {
            // Same fix as schoolQuarterlyCounts: avoid double-counting an
            // endorsement across two quarters when a category has both
            // 'Received w/ Compliance' and 'Endorsed to RO' steps. 'Endorsed to RO'
            // is the real endorsement action, so 'Received w/ Compliance' (mere
            // intake) is excluded from the endorsed-quarter tally.
            const hasEndorsedStep = cat.steps.includes('Endorsed to RO');

            for (const row of cat.rows) {
                for (const step of cat.steps) {
                    if (hasEndorsedStep && step === 'Received w/ Compliance') continue;

                    const key  = cat.key + '|' + row + '|' + step;
                    const cell = normaliseCell(sd[key]);
                    if (!cell.checked) continue;

                    const qKey  = cell.q || tsToQuarter(cell.ts) || 'unknown';
                    const sType = getStepType(step);
                    const bucket = result[cat.key][qKey] || result[cat.key]['unknown'];
                    bucket.total++;
                    if (sType === 'endorsed') bucket.endorsed++;
                    else if (sType === 'approved') bucket.approved++;
                    else if (sType === 'released') bucket.released++;
                }
            }
        }
    }
    return result;
}

function progressClass(pct) {
    if (pct === 0)  return 'pf-zero';
    if (pct >= 80)  return 'pf-high';
    if (pct >= 40)  return 'pf-mid';
    return 'pf-low';
}

function statusOf(pct) {
    if (pct === 100) return 'done';
    if (pct > 0)     return 'partial';
    return 'none';
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTs(ts) {
    if (!ts) return '';
    try {
        const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
        const d   = new Date(iso);
        if (isNaN(d)) return ts;
        const pad    = n => String(n).padStart(2, '0');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch(_) { return ts; }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
    renderStats();
    renderTable();
    renderLevelSubmissionsTable();
    renderCategoryBars();
}

function renderStats() {
    const filtered = filteredSchools();
    const total    = filtered.length;
    let done = 0, partial = 0, pending = 0, pctSum = 0;

    for (const s of filtered) {
        const { pct } = schoolProgress(s.id, _catFilter);
        pctSum += pct;
        const st = statusOf(pct);
        if (st === 'done')    done++;
        else if (st === 'partial') partial++;
        else pending++;
    }

    const avg = total ? Math.round(pctSum / total) : 0;

    setText('statTotal',   total);
    setText('statDone',    done);
    setText('statPartial', partial);
    setText('statPending', pending);
    setText('statAvgPct',  avg + '%');
}

function filteredSchools() {
    let list = _schoolType === 'private' ? _schools : [];
    const q  = _search.trim().toLowerCase();
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q));

    if (_statusFilter !== 'all') {
        list = list.filter(s => {
            const { pct } = schoolProgress(s.id, _catFilter);
            return statusOf(pct) === _statusFilter;
        });
    }
    return list;
}

function renderTable() {
    const thead   = document.getElementById('summaryThead');
    const tbody   = document.getElementById('summaryTbody');
    const wrap    = document.getElementById('summaryTableWrap');
    const empty   = document.getElementById('emptyState');
    const countEl = document.getElementById('summaryCount');

    if (!thead || !tbody) return;

    if (_schoolType === 'public') {
        showLoader(false);
        wrap.classList.remove('hidden');
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:48px 20px;color:#854d0e;">
            <i class="fa-solid fa-screwdriver-wrench" style="font-size:24px;display:block;margin-bottom:10px;"></i>
            Public Schools tracking is under development.
        </td></tr>`;
        thead.innerHTML = '';
        if (countEl) countEl.textContent = '—';
        return;
    }

    const schools = filteredSchools();
    if (countEl) countEl.textContent = schools.length + ' school' + (schools.length !== 1 ? 's' : '');

    if (!schools.length) {
        wrap.classList.remove('hidden');
        tbody.innerHTML = '';
        thead.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    wrap.classList.remove('hidden');

    // ── Level-based category selected: the quarterly Endorsed/Approved/
    // Released table doesn't apply here (that's why it used to show a wall
    // of "—"). Swap the main table for a level-checkmark table for just
    // this one category instead, and explain why via a banner. ──────────
    if (_catFilter !== 'all' && isExcludedFromQuarterly(_catFilter)) {
        const cat = CATEGORIES.find(c => c.key === _catFilter);
        showCategoryModeBanner(true, cat ? cat.label : _catFilter);
        setText('summaryCardTitle', 'School-by-School Progress — ' + (cat ? cat.label : ''));
        if (cat) {
            const built = buildSingleCategoryLevelTable(cat, schools);
            thead.innerHTML = built.theadHtml;
            tbody.innerHTML = built.tbodyHtml;
        }
        return;
    }
    showCategoryModeBanner(false);
    setText('summaryCardTitle', 'School-by-School Progress');

    // ── Header: Quarterly counts only ─────────────────────────────────────
    let thHtml = `<tr>
        <th style="min-width:220px;" rowspan="3">School</th>
        <th class="th-center" colspan="12">Quarterly</th>
    </tr>`;

    thHtml += `<tr>`;
    for (const q of QUARTERS) {
        const qClass = `qtr-${q.key.toLowerCase()}`;
        thHtml += `<th class="th-center qtr-header ${qClass}" colspan="3" title="${q.label}">
            <span class="qtr-label">${q.key}</span>
            <span class="qtr-sublabel">${q.label}</span>
        </th>`;
    }
    thHtml += `</tr>`;

    thHtml += `<tr class="qtr-subheader-row">`;
    for (const q of QUARTERS) {
        const qClass = `qtr-${q.key.toLowerCase()}`;
        thHtml += `<th class="th-center sub-th endorsed-th ${qClass}" title="Endorsed">Endorsed</th>
                   <th class="th-center sub-th approved-th ${qClass}" title="Approved">Approved</th>
                   <th class="th-center sub-th released-th ${qClass}" title="Released">Released</th>`;
    }
    thHtml += `</tr>`;

    thead.innerHTML = thHtml;

    // ── Rows ──
    let html = '';
    for (const s of schools) {
        const qCounts = schoolQuarterlyCounts(s.id, _catFilter);

        html += `<tr>
            <td><div class="school-name-cell" title="${esc(s.name)}">${esc(s.name)}</div></td>
            `;

        // Quarterly counts (show a checkmark instead of the raw number when a
        // specific category is selected, since the count is no longer meaningful
        // as a tally across categories — it's just "submitted or not" per step).
        // When more than one level/row contributed to a single quarter's check
        // (e.g. Pre-School endorsed in Q1 AND Senior HS also endorsed in Q1), the
        // items list is shown as a tooltip and a small count badge so it's clear
        // the checkmark isn't tied to just one ambiguous "step".
        const isSingleCat = _catFilter !== 'all';
        const badge = (val, cls, items) => {
            if (val <= 0) return `<span class="qtr-zero">—</span>`;
            const tooltip = items && items.length ? esc(items.join(', ')) : '';
            if (isSingleCat) {
                const countTag = items && items.length > 1
                    ? `<sup class="qc-multi-count" style="font-size:9px;margin-left:1px;color:inherit;font-weight:700;">${items.length}</sup>`
                    : '';
                return `<span class="qtr-count ${cls} qc-check" title="${tooltip}">
                    <i class="fa-solid fa-check"></i>${countTag}
                </span>`;
            }
            return `<span class="qtr-count ${cls}" title="${tooltip}">${val}</span>`;
        };
        for (const q of QUARTERS) {
            const qd = qCounts[q.key];
            const qClass = `qtr-${q.key.toLowerCase()}`;
            html += `
            <td class="td-center qtr-cell endorsed-cell qtr-start ${qClass}">
                ${badge(qd.endorsed, 'qc-endorsed', qd.endorsedItems)}
            </td>
            <td class="td-center qtr-cell approved-cell ${qClass}">
                ${badge(qd.approved, 'qc-approved', qd.approvedItems)}
            </td>
            <td class="td-center qtr-cell released-cell ${qClass}">
                ${badge(qd.released, 'qc-released', qd.releasedItems)}
            </td>`;
        }

        html += `</tr>`;
    }

    tbody.innerHTML = html;
}

// ─── Category mode banner (shown when a level-based category replaces the
// quarterly table) ──────────────────────────────────────────────────────────
function showCategoryModeBanner(show, label) {
    const banner = document.getElementById('categoryModeBanner');
    const text   = document.getElementById('categoryModeBannerText');
    if (!banner) return;
    if (show) {
        banner.classList.remove('hidden');
        if (text) {
            text.textContent = `"${label}" is tracked by school level (Pre-Elem / Elem / JHS / SHS), `
                + `not by quarterly Endorsed / Approved / Released steps — so the table below shows `
                + `level checkmarks for this category instead.`;
        }
    } else {
        banner.classList.add('hidden');
    }
}

/** Build a School × Step table for ONE level-based category (used when the
 *  category filter is narrowed to a single such category, replacing the
 *  quarterly Endorsed/Approved/Released table which wouldn't apply). */
function buildSingleCategoryLevelTable(cat, schools) {
    let thead = `<tr><th style="min-width:220px;">School</th>`;
    for (const step of cat.steps) {
        thead += `<th class="th-center sub-th" style="background:#6366f1;color:#fff;">${esc(step)}</th>`;
    }
    thead += `</tr>`;

    let tbody = '';
    for (const s of schools) {
        const sd = _data[s.id] || {};
        tbody += `<tr><td><div class="school-name-cell" title="${esc(s.name)}">${esc(s.name)}</div></td>`;
        for (const step of cat.steps) {
            const key  = cat.key + '||' + step;
            const cell = normaliseCell(sd[key]);
            if (cell.checked) {
                const badge = cell.q
                    ? `<span class="qtr-count qc-approved">${esc(cell.q)}</span>`
                    : cell.ts
                        ? `<span class="qtr-count qc-endorsed" title="${esc(cell.ts)}">✓</span>`
                        : `<span class="qtr-count qc-endorsed">✓</span>`;
                tbody += `<td class="td-center qtr-cell">${badge}</td>`;
            } else {
                tbody += `<td class="td-center qtr-cell"><span class="qtr-zero">&mdash;</span></td>`;
            }
        }
        tbody += `</tr>`;
    }

    tbody += `<tr style="background:#f1f5f9;font-weight:600;"><td style="padding:6px 12px;font-size:12px;">Totals</td>`;
    for (const step of cat.steps) {
        const key   = cat.key + '||' + step;
        const count = schools.filter(s => normaliseCell((_data[s.id] || {})[key]).checked).length;
        tbody += `<td class="td-center" style="font-size:12px;font-weight:700;color:#4f46e5;">${count > 0 ? count : '<span style="color:#cbd5e1">0</span>'}</td>`;
    }
    tbody += `</tr>`;

    return { theadHtml: thead, tbodyHtml: tbody };
}

// ─── Level Submissions Table ──────────────────────────────────────────────────
// Renders a separate per-school table for categories whose steps are level names
// (app_govt_recognition, special_order_level) rather than workflow stages.
function renderLevelSubmissionsTable() {
    const wrap = document.getElementById('levelSubmissionsWrap');
    if (!wrap) return;

    const schools = filteredSchools();
    if (!schools.length || _schoolType !== 'private') {
        wrap.innerHTML = '';
        return;
    }

    // Skip this section when the category filter is already narrowed to a
    // single level-based category — that category is now shown as the main
    // table above (see buildSingleCategoryLevelTable), so repeating it here
    // would just be a confusing duplicate.
    if (_catFilter !== 'all' && isExcludedFromQuarterly(_catFilter)) {
        wrap.innerHTML = '';
        return;
    }

    const levelCats = CATEGORIES.filter(c => isLevelCat(c.key));
    if (!levelCats.length) { wrap.innerHTML = ''; return; }

    let html = `
    <div class="summary-card" style="margin-top:20px;">
        <div class="summary-card-header">
            <div class="summary-card-title">
                <i class="fa-solid fa-list-check"></i>
                Level Submissions
            </div>
            <div class="summary-card-actions">
                <span style="font-size:12px;color:var(--color-text-secondary);">
                    Authority to Operate, Gov't Recognition, Off-Campus &amp; Special Order Level
                </span>
            </div>
        </div>
        <div class="table-scroll">
        <table class="summary-table" style="min-width:0;">
            <thead>
                <tr>
                    <th style="min-width:200px;">School</th>`;

    // Build header columns: one per (cat, step/level)
    for (const cat of levelCats) {
        const span = cat.steps.length;
        html += `<th class="th-center" colspan="${span}" style="background:#6366f1;color:#fff;">${esc(cat.label)}</th>`;
    }
    html += `</tr><tr><th></th>`;
    for (const cat of levelCats) {
        for (const step of cat.steps) {
            html += `<th class="th-center sub-th" style="background:#e0e7ff;color:#3730a3;font-size:11px;">${esc(step)}</th>`;
        }
    }
    html += `</tr></thead><tbody>`;

    for (const s of schools) {
        const sd = _data[s.id] || {};
        html += `<tr><td><div class="school-name-cell" title="${esc(s.name)}">${esc(s.name)}</div></td>`;
        for (const cat of levelCats) {
            for (const step of cat.steps) {
                // level cats use rows: [''] with noRowLabel
                const key  = cat.key + '||' + step;
                const cell = normaliseCell(sd[key]);
                if (cell.checked) {
                    const badge = cell.q
                        ? `<span class="qtr-count qc-approved">${esc(cell.q)}</span>`
                        : cell.ts
                            ? `<span class="qtr-count qc-endorsed" title="${esc(cell.ts)}">✓</span>`
                            : `<span class="qtr-count qc-endorsed">✓</span>`;
                    html += `<td class="td-center qtr-cell">${badge}</td>`;
                } else {
                    html += `<td class="td-center qtr-cell"><span class="qtr-zero">&mdash;</span></td>`;
                }
            }
        }
        html += `</tr>`;
    }

    // Totals row
    html += `<tr style="background:#f1f5f9;font-weight:600;">
        <td style="padding:6px 12px;font-size:12px;">Totals</td>`;
    for (const cat of levelCats) {
        for (const step of cat.steps) {
            const key = cat.key + '||' + step;
            const count = schools.filter(s => normaliseCell((_data[s.id] || {})[key]).checked).length;
            html += `<td class="td-center" style="font-size:12px;font-weight:700;color:#4f46e5;">${count > 0 ? count : '<span style="color:#cbd5e1">0</span>'}</td>`;
        }
    }
    html += `</tr></tbody></table></div></div>`;

    wrap.innerHTML = html;
}

function renderCategoryBars() {
    const wrap = document.getElementById('categoryBars');
    if (!wrap) return;

    const schools = _schoolType === 'private' ? _schools : [];
    if (!schools.length) {
        wrap.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px;padding:8px 0;">No data available.</p>';
        return;
    }

    // Build per-category quarterly totals for the bar chart
    const catQData = aggregateCategoryQuarterlyCounts(schools);

    let html = '';
    for (const cat of CATEGORIES) {
        // Total endorsed+approved+released across all quarters
        let totalChecked = 0, totalCells = 0;
        const sd_all = _data;
        for (const s of schools) {
            const sd = _data[s.id] || {};
            for (const row of cat.rows) {
                for (const step of cat.steps) {
                    totalCells++;
                    const key  = cat.key + '|' + row + '|' + step;
                    const cell = normaliseCell(sd[key]);
                    if (cell.checked) totalChecked++;
                }
            }
        }

        const pct   = totalCells ? Math.round(totalChecked / totalCells * 100) : 0;
        const color = pct >= 80 ? 'var(--color-success)' : pct >= 40 ? 'var(--color-warning)' : 'var(--color-primary)';

        // Quarter mini badges
        const qd = catQData[cat.key];
        let qBadges = '';
        for (const q of QUARTERS) {
            const total = (qd[q.key]?.total || 0);
            if (total > 0) {
                qBadges += `<span class="cat-q-badge" title="${q.label}: ${total} actions">${q.key} <b>${total}</b></span>`;
            }
        }

        html += `<div class="cat-bar-row">
            <div class="cat-bar-label" title="${esc(cat.label)}">${esc(cat.label)}</div>
            <div class="cat-bar-track">
                <div class="cat-bar-fill" style="width:${pct}%;background:${color};"></div>
            </div>
            <div class="cat-bar-pct" style="color:${color};">${pct}%</div>
            <div class="cat-bar-count">${totalChecked}/${totalCells}</div>
            <div class="cat-q-badges">${qBadges}</div>
        </div>`;
    }
    wrap.innerHTML = html;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showLoader(on) {
    const loader = document.getElementById('summaryLoader');
    const wrap   = document.getElementById('summaryTableWrap');
    if (loader) loader.classList.toggle('hidden', !on);
    if (wrap) {
        if (on) wrap.classList.add('hidden');
        else    wrap.classList.remove('hidden');
    }
}

function showError(msg) {
    const el   = document.getElementById('summaryError');
    const msg2 = document.getElementById('summaryErrorMsg');
    if (el)  el.classList.remove('hidden');
    if (msg2) msg2.textContent = msg;
}

function hideError() {
    document.getElementById('summaryError')?.classList.add('hidden');
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

// ─── Event handlers ───────────────────────────────────────────────────────────
function onYearChange() {
    const sel = document.getElementById('yearSelect');
    if (sel) _currentYear = sel.value;
    loadData();
}

function switchType(type, btn) {
    if (_schoolType === type) return;
    _schoolType = type;
    document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadData();
}

function setStatusFilter(f, btn) {
    _statusFilter = f;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderAll();
}

function onCategoryChange() {
    const sel = document.getElementById('categoryFilter');
    _catFilter = sel ? sel.value : 'all';
    renderAll();
}

function toggleMoreBreakdowns() {
    const wrap = document.getElementById('moreBreakdownsWrap');
    const btn  = document.getElementById('moreBreakdownsToggle');
    if (!wrap || !btn) return;
    const nowOpen = wrap.classList.contains('hidden');
    wrap.classList.toggle('hidden', !nowOpen);
    btn.classList.toggle('open', nowOpen);
}

function onSearch(val) {
    _search = val;
    renderAll();
}

// ─── Export Modal ─────────────────────────────────────────────────────────────
function exportReport() {
    const schools = filteredSchools();
    if (!schools.length) {
        showToast('No data to export.', 'error');
        return;
    }
    openExportModal();
}

function openExportModal() {
    let modal = document.getElementById('exportModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'exportModal';
        modal.innerHTML = `
        <div class="emodal-backdrop" onclick="closeExportModal()"></div>
        <div class="emodal-box">
            <div class="emodal-header">
                <h2><i class="fa-solid fa-file-export"></i> Export Report</h2>
                <button class="emodal-close" onclick="closeExportModal()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="emodal-body">
                <p class="emodal-desc">
                    <strong>Not sure which one?</strong> Most people want the
                    <strong>School List (Excel)</strong> below — it's already selected for you.
                    Pick a different option only if you need one of the specific formats described.
                </p>

                <div class="export-type-cards">
                    <div class="export-type-card selected" id="etcard-schools" onclick="selectExportType('schools')">
                        <div class="etc-radio"><i class="fa-solid fa-check"></i></div>
                        <div class="etc-icon"><i class="fa-solid fa-table"></i></div>
                        <div class="etc-info">
                            <div class="etc-title">School List <span class="etc-badge etc-badge-csv">Excel</span> <span class="etc-badge etc-badge-rec">Recommended</span></div>
                            <div class="etc-desc"><strong>Use this for:</strong> a general-purpose spreadsheet — one row per school, with overall progress, step counts, and quarterly totals. Good default for reviewing or sharing.</div>
                        </div>
                    </div>
                    <div class="export-type-card" id="etcard-quarterly" onclick="selectExportType('quarterly')">
                        <div class="etc-radio"><i class="fa-solid fa-check"></i></div>
                        <div class="etc-icon"><i class="fa-solid fa-calendar-days"></i></div>
                        <div class="etc-info">
                            <div class="etc-title">Quarterly Counts <span class="etc-badge etc-badge-csv">Excel</span></div>
                            <div class="etc-desc"><strong>Use this for:</strong> tracking how many Endorsed / Approved / Released actions happened per quarter, per category — not per school.</div>
                        </div>
                    </div>
                    <div class="export-type-card" id="etcard-word" onclick="selectExportType('word')">
                        <div class="etc-radio"><i class="fa-solid fa-check"></i></div>
                        <div class="etc-icon"><i class="fa-solid fa-file-word"></i></div>
                        <div class="etc-info">
                            <div class="etc-title">Official Summary <span class="etc-badge etc-badge-word">Word</span></div>
                            <div class="etc-desc"><strong>Use this for:</strong> a formatted document for printing or submission — matches the official QATALYST template, with a summary table and full school list.</div>
                        </div>
                    </div>
                    <div class="export-type-card" id="etcard-catfilter" onclick="selectExportType('catfilter')">
                        <div class="etc-radio"><i class="fa-solid fa-check"></i></div>
                        <div class="etc-icon"><i class="fa-solid fa-filter"></i></div>
                        <div class="etc-info">
                            <div class="etc-title">Custom Filtered List <span class="etc-badge etc-badge-word">Word</span></div>
                            <div class="etc-desc"><strong>Use this for:</strong> a specific question like "which schools have NOT submitted X" — build your own AND/OR rules across categories.</div>
                        </div>
                    </div>
                </div>

                <!-- Quarterly options -->
                <div id="quarterlyOptions" class="emodal-section hidden">
                    <div class="eopts-label">Include quarters:</div>
                    <div class="qtr-checkboxes">
                        <label class="qtr-cb-item"><input type="checkbox" value="Q1" checked onchange="updateQRange()"><span>Q1 — 1st Quarter <small>(Jan–Mar)</small></span></label>
                        <label class="qtr-cb-item"><input type="checkbox" value="Q2" checked onchange="updateQRange()"><span>Q2 — 2nd Quarter <small>(Apr–Jun)</small></span></label>
                        <label class="qtr-cb-item"><input type="checkbox" value="Q3" checked onchange="updateQRange()"><span>Q3 — 3rd Quarter <small>(Jul–Sep)</small></span></label>
                        <label class="qtr-cb-item"><input type="checkbox" value="Q4" checked onchange="updateQRange()"><span>Q4 — 4th Quarter <small>(Oct–Dec)</small></span></label>
                    </div>
                </div>

                <!-- Category filter options -->
                <div id="catFilterOptions" class="emodal-section hidden">
                    <div class="eopts-label" style="margin-bottom:10px;">Filter logic</div>
                    <div style="display:flex;gap:8px;margin-bottom:16px;">
                        <button id="logicAND" class="logic-btn active" onclick="setCatLogic('AND')">
                            AND &mdash; <small>School must match <strong>all</strong> filters</small>
                        </button>
                        <button id="logicOR" class="logic-btn" onclick="setCatLogic('OR')">
                            OR &mdash; <small>School matches <strong>any</strong> filter</small>
                        </button>
                    </div>
                    <div class="eopts-label" style="margin-bottom:8px;">Category filters
                        <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--color-text-muted);font-size:11px;margin-left:6px;">— add one or more</span>
                    </div>
                    <div id="catFilterRows" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;"></div>
                    <button class="add-cat-filter-btn" onclick="addCatFilterRow()">
                        <i class="fa-solid fa-plus"></i> Add Category Filter
                    </button>
                    <div id="catFilterPreview" style="margin-top:14px;font-size:12px;color:var(--color-text-secondary);min-height:18px;"></div>
                </div>
            </div>
            <div class="emodal-footer">
                <button class="btn btn-secondary" onclick="closeExportModal()">Cancel</button>
                <button class="btn btn-primary" id="doExportBtn" onclick="doExport()">
                    <i class="fa-solid fa-download"></i> Download Excel
                </button>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }

    // Reset state — default to the "School List" export since it's the
    // most generally useful option and works with zero extra setup.
    _exportQRange     = ['Q1','Q2','Q3','Q4'];
    _exportCatFilters = [];
    _exportCatLogic   = 'AND';

    document.getElementById('quarterlyOptions')?.classList.add('hidden');
    document.getElementById('catFilterOptions')?.classList.add('hidden');
    modal.classList.add('open');
    selectExportType('schools');
}

function closeExportModal() {
    document.getElementById('exportModal')?.classList.remove('open');
}

async function exportCatFilterList() {
    const allSchools = filteredSchools();
    const schools    = allSchools.filter(s => _schoolMatchesCatFilters(s.id));

    if (!schools.length) {
        showToast('No schools match the selected filters.', 'error');
        return;
    }

    showToast('Preparing Word document…', 'info');

    const sy    = _currentYear;
    const sType = _schoolType.charAt(0).toUpperCase() + _schoolType.slice(1);

    // ── Build filter description for the document title ──
    const filterParts = _exportCatFilters.map(f => {
        const cat = CATEGORIES.find(c => c.key === f.catKey);
        const lbl = f.status === 'submitted' ? 'Submitted' : 'Not Submitted';
        return { catLabel: cat ? cat.label : f.catKey, status: lbl };
    });
    const logic      = _exportCatLogic;
    const filterDesc = filterParts
        .map(p => `${p.catLabel} = ${p.status}`)
        .join(' ' + logic + ' ');

    // ── Overall summary rows for the summary table ──
    const overallSummary = [
        { category: 'Total Schools (All)',    values: [allSchools.length] },
        { category: 'Schools Matching Filter', values: [schools.length]   },
        { category: 'Filter Logic',            values: [logic]            },
    ];

    // Add one summary row per filter
    for (const f of _exportCatFilters) {
        const cat      = CATEGORIES.find(c => c.key === f.catKey);
        const catLabel = cat ? cat.label : f.catKey;
        const count    = allSchools.filter(s => {
            const has = schoolHasCategorySubmission(s.id, f.catKey);
            return f.status === 'submitted' ? has : !has;
        }).length;
        overallSummary.push({
            category: catLabel + ' (' + (f.status === 'submitted' ? 'Submitted' : 'Not Submitted') + ')',
            values:   [count],
        });
    }

    // ── Sorted school list ──
    const sorted     = [...schools].sort((a, b) => a.name.localeCompare(b.name));
    const schoolNames = sorted.map(s => s.name);

    // ── Per-category breakdown sections ──
    // For each category involved in the filters, build a section
    // showing the matched schools and their submission status.
    const sections = [];

    // Section 1: the filtered list itself
    sections.push({
        title:    'FILTERED SCHOOL LIST — ' + sy,
        subtitle: `${schools.length} school(s) matched: ${filterDesc}`,
        schools:  schoolNames,
    });

    // Section 2+: per-category breakdowns across ALL categories
    // showing submitted vs not submitted counts for the matched schools
    for (const cat of CATEGORIES) {
        const submitted    = sorted.filter(s =>  schoolHasCategorySubmission(s.id, cat.key));
        const notSubmitted = sorted.filter(s => !schoolHasCategorySubmission(s.id, cat.key));

        // Only include categories that have at least one school with activity
        // OR that were part of the filter
        const isFilteredCat = _exportCatFilters.some(f => f.catKey === cat.key);
        if (!isFilteredCat && submitted.length === 0) continue;

        if (submitted.length > 0) {
            sections.push({
                title:    cat.label.toUpperCase() + ' — SUBMITTED (' + sy + ')',
                subtitle: `${submitted.length} of ${schools.length} matched school(s) have submitted ${cat.label}.`,
                schools:  submitted.map(s => s.name),
            });
        }
        if (notSubmitted.length > 0) {
            sections.push({
                title:    cat.label.toUpperCase() + ' — NOT SUBMITTED (' + sy + ')',
                subtitle: `${notSubmitted.length} of ${schools.length} matched school(s) have NOT yet submitted ${cat.label}.`,
                schools:  notSubmitted.map(s => s.name),
            });
        }
    }

    const reportData = {
        schoolYear:    sy,
        schoolType:    sType,
        totalSchools:  schools.length,
        syColumns:     [sy],
        reportTitle:   'CATEGORY FILTER REPORT',
        reportSubtitle: 'Document Tracking System on ' + sType + ' School Application and Request',
        filterDesc,
        overallSummary,
        allSchools:    schoolNames,
        sections,
    };

    if (typeof docx === 'undefined') {
        showToast('Word export library not loaded. Please refresh and try again.', 'error');
        return;
    }

    try {
        const {
            Document, Packer, Paragraph, TextRun,
            Table, TableRow, TableCell,
            WidthType, AlignmentType, BorderStyle, VerticalAlign,
        } = docx;

        const now     = new Date();
        const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });

        // ── Shared border / helper ────────────────────────────────────────────
        const BD = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' };
        const borders = { top: BD, bottom: BD, left: BD, right: BD };
        const spacer  = () => new Paragraph({ children: [new TextRun({ text: '' })] });
        const heading = (text, size = 22) => new Paragraph({
            children: [new TextRun({ text, bold: true, size, color: '1E3A5F' })],
            spacing: { before: 240, after: 80 },
        });

        // ── Two-column summary table ──────────────────────────────────────────
        const mkSummaryTable = (rows) => new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(({ label, value, isHeader }) => new TableRow({
                children: [
                    new TableCell({
                        width: { size: 70, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: isHeader ? '1E3A5F' : 'F9FAFB' },
                        children: [new Paragraph({ children: [new TextRun({ text: String(label), bold: isHeader, color: isHeader ? 'FFFFFF' : '111827', size: 20 })] })],
                    }),
                    new TableCell({
                        width: { size: 30, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: isHeader ? '1E3A5F' : 'FFFFFF' },
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(value), bold: isHeader, color: isHeader ? 'FFFFFF' : '111827', size: 20 })] })],
                    }),
                ],
            })),
        });

        // ── Numbered school list table ────────────────────────────────────────
        const mkSchoolTable = (names) => {
            if (!names.length) return new Paragraph({ children: [new TextRun({ text: 'No schools.', italics: true, color: '9CA3AF', size: 20 })] });
            const hdr = new TableRow({
                children: [
                    new TableCell({ width: { size: 8, type: WidthType.PERCENTAGE }, borders, shading: { fill: '1E3A5F' }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'No.', bold: true, color: 'FFFFFF', size: 20 })] })] }),
                    new TableCell({ width: { size: 92, type: WidthType.PERCENTAGE }, borders, shading: { fill: '1E3A5F' }, children: [new Paragraph({ children: [new TextRun({ text: 'School Name', bold: true, color: 'FFFFFF', size: 20 })] })] }),
                ],
            });
            const dataRows = names.map((name, i) => new TableRow({
                children: [
                    new TableCell({ width: { size: 8, type: WidthType.PERCENTAGE }, borders, shading: { fill: i % 2 === 0 ? 'F9FAFB' : 'FFFFFF' }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), size: 20 })] })] }),
                    new TableCell({ width: { size: 92, type: WidthType.PERCENTAGE }, borders, shading: { fill: i % 2 === 0 ? 'F9FAFB' : 'FFFFFF' }, children: [new Paragraph({ children: [new TextRun({ text: name, size: 20 })] })] }),
                ],
            }));
            return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [hdr, ...dataRows] });
        };

        // ── Assemble document ─────────────────────────────────────────────────
        const children = [
            // Title block
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: reportData.reportTitle || 'CATEGORY FILTER REPORT', bold: true, size: 32, color: '1E3A5F' })], spacing: { after: 80 } }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: reportData.reportSubtitle || '', size: 22, color: '374151' })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `School Year: ${sy}  |  ${sType} Schools`, size: 20, color: '374151' })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Generated: ${dateStr}`, size: 18, color: '9CA3AF' })], spacing: { after: 240 } }),

            // Filter description
            heading('FILTER APPLIED', 22),
            new Paragraph({ children: [new TextRun({ text: filterDesc, italics: true, size: 20, color: '374151' })], spacing: { after: 200 } }),

            // Filter summary table
            heading('SUMMARY', 22),
            mkSummaryTable([
                { label: 'Item', value: 'Count', isHeader: true },
                ...overallSummary.map(r => ({ label: r.category, value: Array.isArray(r.values) ? r.values[0] : r.values })),
            ]),
            spacer(),

            // Matched school list
            heading(`MATCHED SCHOOLS (${schoolNames.length})`, 22),
            mkSchoolTable(schoolNames),
            spacer(),
        ];

        // Per-category breakdown sections
        for (const section of sections) {
            if (section.title.includes('FILTERED SCHOOL LIST')) continue; // already rendered above
            children.push(
                heading(section.title, 20),
                new Paragraph({ children: [new TextRun({ text: section.subtitle, italics: true, size: 18, color: '6B7280' })], spacing: { after: 80 } }),
                mkSchoolTable(section.schools),
                spacer(),
            );
        }

        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        size: { width: 12240, height: 15840 },
                        margin: { top: 1440, right: 1181, bottom: 1094, left: 1440 },
                    },
                },
                children,
            }],
        });

        const blob = await Packer.toBlob(doc);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;

        // Filename encodes the filters for traceability
        const filterSlug = _exportCatFilters
            .map(f => f.catKey.replace(/_/g, '') + '-' + f.status[0])
            .join('_');
        a.download = `CatFilter_Report_${sy}_${_schoolType}_${filterSlug}.docx`;
        // Append to DOM — required for mobile browsers (Android Chrome) to trigger download
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Word report exported — ${schools.length} school(s).`, 'success');
    } catch (err) {
        console.error('Word export error:', err);
        showToast('Failed to export Word document. Check console for details.', 'error');
    }
}

function selectExportType(type) {
    _exportType = type;
    document.querySelectorAll('.export-type-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('etcard-' + type)?.classList.add('selected');

    const qOpts  = document.getElementById('quarterlyOptions');
    const cfOpts = document.getElementById('catFilterOptions');
    if (qOpts)  qOpts.classList.toggle('hidden',  type !== 'quarterly');
    if (cfOpts) cfOpts.classList.toggle('hidden', type !== 'catfilter');

    const btn = document.getElementById('doExportBtn');
    if (type === 'catfilter') {
        if (!document.querySelectorAll('.cat-filter-row').length) addCatFilterRow();
        btn.innerHTML = '<i class="fa-solid fa-download"></i> Download Word';
        _updateCatFilterExportBtn();
    } else if (type === 'word') {
        btn.innerHTML = '<i class="fa-solid fa-download"></i> Download Word';
        btn.disabled = false;
    } else {
        btn.innerHTML = '<i class="fa-solid fa-download"></i> Download CSV';
        btn.disabled = false;
    }
}

function updateQRange() {
    const checked = [...document.querySelectorAll('#quarterlyOptions input[type=checkbox]:checked')];
    _exportQRange = checked.map(c => c.value);
    document.getElementById('doExportBtn').disabled = _exportQRange.length === 0;
}

function doExport() {
    // Close modal AFTER kicking off the export so the async Word
    // functions still run within the user-gesture context on mobile.
    if (_exportType === 'word')           { closeExportModal(); exportWordReport(); }
    else if (_exportType === 'schools')   { closeExportModal(); exportSchoolList(); }
    else if (_exportType === 'quarterly') { closeExportModal(); exportQuarterlyCounts(); }
    else if (_exportType === 'catfilter') { closeExportModal(); exportCatFilterList(); }
}

// ─── Export Word (.docx) ─────────────────────────────────────────────────────
/**
 * Builds the Word report entirely client-side using the docx.js library.
 * No server endpoint required.
 * Requires: <script src="https://unpkg.com/docx@8/build/index.js"></script>
 *           in schools-submissions-summary.html
 */
async function exportWordReport() {
    if (typeof docx === 'undefined') {
        showToast('Word export library not loaded. Please refresh and try again.', 'error');
        return;
    }

    const schools = filteredSchools();
    if (!schools.length) { showToast('No data to export.', 'error'); return; }

    showToast('Preparing Word document…', 'info');

    try {
        const {
            Document, Packer, Paragraph, TextRun,
            Table, TableRow, TableCell,
            WidthType, AlignmentType, BorderStyle, VerticalAlign,
        } = docx;

        const sy    = _currentYear;
        const sType = _schoolType.charAt(0).toUpperCase() + _schoolType.slice(1);
        const now   = new Date();
        const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
        const sorted  = [...schools].sort((a, b) => a.name.localeCompare(b.name));

        // ── Shared border style ──────────────────────────────────────────────
        const BD = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' };
        const borders = { top: BD, bottom: BD, left: BD, right: BD };

        // ── Helper: thin horizontal rule as an empty-row paragraph ──────────
        const spacer = () => new Paragraph({ children: [new TextRun({ text: '' })] });

        // ── Helper: section heading paragraph ───────────────────────────────
        const heading = (text, size = 24) => new Paragraph({
            children: [new TextRun({ text, bold: true, size, color: '1E3A5F' })],
            spacing: { before: 240, after: 80 },
        });

        // ── Helper: build a two-column summary table ─────────────────────────
        const summaryTable = (rows) => new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(({ label, value, isHeader }) => new TableRow({
                children: [
                    new TableCell({
                        width: { size: 70, type: WidthType.PERCENTAGE },
                        borders,
                        shading: isHeader ? { fill: '1E3A5F' } : { fill: 'F9FAFB' },
                        verticalAlign: VerticalAlign.CENTER,
                        children: [new Paragraph({
                            children: [new TextRun({
                                text: String(label),
                                bold: isHeader,
                                color: isHeader ? 'FFFFFF' : '111827',
                                size: 20,
                            })],
                        })],
                    }),
                    new TableCell({
                        width: { size: 30, type: WidthType.PERCENTAGE },
                        borders,
                        shading: isHeader ? { fill: '1E3A5F' } : { fill: 'FFFFFF' },
                        verticalAlign: VerticalAlign.CENTER,
                        children: [new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [new TextRun({
                                text: String(value),
                                bold: isHeader,
                                color: isHeader ? 'FFFFFF' : '111827',
                                size: 20,
                            })],
                        })],
                    }),
                ],
            })),
        });

        // ── Helper: get highest step reached for a school/cat/level ──────────
        const levelStatus = (schoolId, cat, rowLabel) => {
            const sd = _data[schoolId] || {};
            let released = false, approved = false, endorsed = false;
            for (const step of cat.steps) {
                const cell = normaliseCell(sd[`${cat.key}|${rowLabel}|${step}`]);
                if (!cell.checked) continue;
                const t = getStepType(step);
                if (t === 'released')      released = true;
                else if (t === 'approved') approved = true;
                else if (t === 'endorsed') endorsed = true;
            }
            if (released) return 'Released';
            if (approved) return 'Approved';
            if (endorsed) return 'Endorsed';
            return '—';
        };

        // ── Helper: simple numbered school list (no level cols) ───────────────
        const schoolListTable = (names) => {
            const headerRow = new TableRow({
                children: [
                    new TableCell({
                        width: { size: 8, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: '1E3A5F' },
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'No.', bold: true, color: 'FFFFFF', size: 20 })] })],
                    }),
                    new TableCell({
                        width: { size: 92, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: '1E3A5F' },
                        children: [new Paragraph({ children: [new TextRun({ text: 'School Name', bold: true, color: 'FFFFFF', size: 20 })] })],
                    }),
                ],
            });
            const dataRows = names.map((name, i) => new TableRow({
                children: [
                    new TableCell({
                        width: { size: 8, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: i % 2 === 0 ? 'F9FAFB' : 'FFFFFF' },
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), size: 20 })] })],
                    }),
                    new TableCell({
                        width: { size: 92, type: WidthType.PERCENTAGE }, borders,
                        shading: { fill: i % 2 === 0 ? 'F9FAFB' : 'FFFFFF' },
                        children: [new Paragraph({ children: [new TextRun({ text: name, size: 20 })] })],
                    }),
                ],
            }));
            return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
        };

        // ── Helper: full school list table WITH level columns ─────────────────
        // Columns: No. | School Name | [for each cat with levels: level1..levelN]
        // Cell value = "Released" / "Approved" / "Endorsed" / "—"
        const schoolListWithLevelsTable = (schoolList) => {
            // Only include categories that have named level rows
            const levelCats = CATEGORIES.filter(c =>
                c.rows.length > 0 && !(c.rows.length === 1 && c.rows[0] === '')
            );

            // Build flat list of { cat, rowLabel } for all level columns
            const levelCols = [];
            for (const cat of levelCats) {
                for (const rowLabel of cat.rows) {
                    if (rowLabel !== '') levelCols.push({ cat, rowLabel });
                }
            }

            // ── colour lookup for step status ────────────────────────────────
            const STATUS_CLR = { Released: '15803D', Approved: '1D4ED8', Endorsed: 'B45309', '—': '9CA3AF' };
            const STATUS_BG  = { Released: 'DCFCE7', Approved: 'DBEAFE', Endorsed: 'FEF3C7', '—': 'F9FAFB' };

            // Total cols = 2 (No + Name) + levelCols.length
            const totalColPct = 100;
            const nameWidth   = 28;  // %
            const noWidth     = 4;   // %
            const lvlWidth    = Math.max(3, Math.floor((totalColPct - nameWidth - noWidth) / Math.max(levelCols.length, 1)));

            // ── Row 1: group header (category names, merged across their levels)
            const groupHeaderCells = [
                new TableCell({ width: { size: noWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: '1E3A5F' },
                    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'No.', bold: true, color: 'FFFFFF', size: 18 })] })] }),
                new TableCell({ width: { size: nameWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: '1E3A5F' },
                    children: [new Paragraph({ children: [new TextRun({ text: 'School Name', bold: true, color: 'FFFFFF', size: 18 })] })] }),
            ];
            for (const cat of levelCats) {
                const span = cat.rows.filter(r => r !== '').length;
                if (!span) continue;
                groupHeaderCells.push(new TableCell({
                    width: { size: lvlWidth * span, type: WidthType.PERCENTAGE },
                    borders,
                    shading: { fill: '1E3A5F' },
                    columnSpan: span,
                    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: cat.label.toUpperCase(), bold: true, color: 'FFFFFF', size: 16 })] })],
                }));
            }

            // ── Row 2: level sub-headers ─────────────────────────────────────
            const levelHeaderCells = [
                new TableCell({ width: { size: noWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: '2563EB' },
                    children: [new Paragraph({ children: [new TextRun({ text: '', size: 16 })] })] }),
                new TableCell({ width: { size: nameWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: '2563EB' },
                    children: [new Paragraph({ children: [new TextRun({ text: '', size: 16 })] })] }),
            ];
            for (const { rowLabel } of levelCols) {
                levelHeaderCells.push(new TableCell({
                    width: { size: lvlWidth, type: WidthType.PERCENTAGE },
                    borders,
                    shading: { fill: '3B82F6' },
                    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: rowLabel, bold: true, color: 'FFFFFF', size: 16 })] })],
                }));
            }

            // ── Data rows ─────────────────────────────────────────────────────
            const dataRows = schoolList.map((s, i) => {
                const rowBg = i % 2 === 0 ? 'F9FAFB' : 'FFFFFF';
                const cells = [
                    new TableCell({ width: { size: noWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: rowBg },
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), size: 18 })] })] }),
                    new TableCell({ width: { size: nameWidth, type: WidthType.PERCENTAGE }, borders, shading: { fill: rowBg },
                        children: [new Paragraph({ children: [new TextRun({ text: s.name, size: 18 })] })] }),
                ];
                for (const { cat, rowLabel } of levelCols) {
                    const status = levelStatus(s.id, cat, rowLabel);
                    const bg  = STATUS_BG[status]  || 'F9FAFB';
                    const clr = STATUS_CLR[status] || '9CA3AF';
                    cells.push(new TableCell({
                        width: { size: lvlWidth, type: WidthType.PERCENTAGE },
                        borders,
                        shading: { fill: bg },
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: status, bold: status !== '—', color: clr, size: 16 })] })],
                    }));
                }
                return new TableRow({ children: cells });
            });

            return new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [
                    new TableRow({ children: groupHeaderCells }),
                    new TableRow({ children: levelHeaderCells }),
                    ...dataRows,
                ],
            });
        };

        // ── Compute overall summary stats ────────────────────────────────────
        let done = 0, partial = 0, pending = 0;
        for (const s of sorted) {
            const { pct } = schoolProgress(s.id, _catFilter);
            if (pct === 100) done++;
            else if (pct > 0) partial++;
            else pending++;
        }

        // ── Compute per-category submission counts ───────────────────────────
        const catSummaryRows = [
            { label: 'Category', value: 'Schools w/ Submissions', isHeader: true },
        ];
        for (const cat of CATEGORIES) {
            let endorsed = 0, approved = 0, released = 0;
            for (const s of sorted) {
                const sd = _data[s.id] || {};
                for (const row of cat.rows) {
                    for (const step of cat.steps) {
                        const cell = normaliseCell(sd[cat.key + '|' + row + '|' + step]);
                        if (!cell.checked) continue;
                        const t = getStepType(step);
                        if (t === 'endorsed') endorsed++;
                        else if (t === 'approved') approved++;
                        else if (t === 'released') released++;
                    }
                }
            }
            const total = endorsed + approved + released;
            if (total > 0) {
                catSummaryRows.push({
                    label: `${cat.label}  (End: ${endorsed} | App: ${approved} | Rel: ${released})`,
                    value: total,
                });
            }
        }

        // ── Per-category school sections ─────────────────────────────────────
        const sectionBlocks = [];
        for (const cat of CATEGORIES) {
            const catSchools = sorted.filter(s => {
                const sd = _data[s.id] || {};
                return cat.rows.some(row =>
                    cat.steps.some(step => normaliseCell(sd[cat.key + '|' + row + '|' + step]).checked)
                );
            });
            if (!catSchools.length) continue;
            sectionBlocks.push(
                spacer(),
                heading(`${cat.label.toUpperCase()} — ${sy}  (${catSchools.length} school(s))`, 22),
                new Paragraph({
                    children: [new TextRun({ text: `Schools with at least one submission under ${cat.label}.`, italics: true, size: 18, color: '6B7280' })],
                    spacing: { after: 80 },
                }),
                schoolListTable(catSchools.map(s => s.name)),
            );
        }

        // ── Assemble document ────────────────────────────────────────────────
        const children = [
            // Cover / title block
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: 'SCHOOLS SUBMISSIONS SUMMARY REPORT', bold: true, size: 32, color: '1E3A5F' })],
                spacing: { after: 120 },
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `${sType} Schools  |  School Year ${sy}`, size: 24, color: '374151' })],
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `Generated: ${dateStr}`, size: 18, color: '9CA3AF' })],
                spacing: { after: 320 },
            }),

            // Overview stats table
            heading('OVERVIEW', 24),
            summaryTable([
                { label: 'Metric', value: 'Count', isHeader: true },
                { label: 'Total Schools', value: sorted.length },
                { label: 'Fully Completed (100%)', value: done },
                { label: 'Ongoing (1–99%)', value: partial },
                { label: 'Pending (0%)', value: pending },
            ]),
            spacer(),

            // Category submission summary
            heading('CATEGORY SUBMISSION SUMMARY', 24),
            summaryTable(catSummaryRows),
            spacer(),

            // Full school list with level columns
            heading(`ALL SCHOOLS (${sorted.length})`, 24),
            schoolListWithLevelsTable(sorted),

            // Per-category sections
            ...sectionBlocks,
            spacer(),
        ];

        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        size: { width: 12240, height: 15840 },
                        margin: { top: 1440, right: 1181, bottom: 1094, left: 1440 },
                    },
                },
                children,
            }],
        });

        const blob = await Packer.toBlob(doc);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `Summary_Report_${sy}_${_schoolType}.docx`;
        // Append to DOM — required for mobile browsers (Android Chrome) to trigger download
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Word report downloaded successfully.', 'success');

    } catch (err) {
        console.error('Word export error:', err);
        showToast('Failed to export Word document. Check console for details.', 'error');
    }
}

// ─── XLSX helpers ─────────────────────────────────────────────────────────────
// Requires xlsx-js-style loaded in the page:
//   <script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script>

const XL = {
    // Brand colours
    BLUE_DARK:  '1A3F7A',   // header background
    BLUE_MID:   '2563EB',   // section banner
    BLUE_LIGHT: 'DBEAFE',   // alternate row tint
    ACCENT:     '0EA5E9',   // quarter group stripe
    GREEN:      '16A34A',   // Completed status
    AMBER:      'D97706',   // Ongoing status
    RED:        'DC2626',   // Pending status
    WHITE:      'FFFFFF',
    GREY_LIGHT: 'F1F5F9',
    GREY_MID:   'CBD5E1',
    TOTALS_BG:  'E2E8F0',

    font(bold = false, sz = 10, color = '000000', italic = false) {
        return { name: 'Arial', sz, bold, italic, color: { rgb: color } };
    },
    fill(hex) { return { fgColor: { rgb: hex } }; },
    border(style = 'thin', color = 'CBD5E1') {
        const s = { style, color: { rgb: color } };
        return { top: s, bottom: s, left: s, right: s };
    },
    align(h = 'left', v = 'center', wrap = false) {
        return { horizontal: h, vertical: v, wrapText: wrap };
    },

    /** Write a styled cell into the aoa (array-of-arrays) at [r][c]. */
    sc(ws, r, c, value, style) {
        if (!ws[r]) ws[r] = [];
        ws[r][c] = { v: value, t: typeof value === 'number' ? 'n' : 's', s: style };
    },

    /** Convert aoa to worksheet, applying merges array [{s,e}]. */
    aoaToWs(aoa, merges = []) {
        const ws = {};
        let maxCol = 0;
        aoa.forEach((row, R) => {
            if (!row) return;
            row.forEach((cell, C) => {
                if (cell === undefined || cell === null) return;
                const addr = XLSX.utils.encode_cell({ r: R, c: C });
                if (typeof cell === 'object' && 'v' in cell) {
                    ws[addr] = cell;
                } else {
                    ws[addr] = { v: cell, t: typeof cell === 'number' ? 'n' : 's' };
                }
                if (C > maxCol) maxCol = C;
            });
        });
        ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: maxCol } });
        if (merges.length) ws['!merges'] = merges;
        return ws;
    },
};

/** Return a styled cell object. */
function xlCell(value, { bold = false, sz = 10, fontColor = '000000', italic = false,
    bgColor = null, hAlign = 'left', vAlign = 'center', wrap = false, borderColor = 'CBD5E1', borderStyle = 'thin' } = {}) {
    const s = {
        font:      XL.font(bold, sz, fontColor, italic),
        alignment: XL.align(hAlign, vAlign, wrap),
        border:    XL.border(borderStyle, borderColor),
    };
    if (bgColor) s.fill = XL.fill(bgColor);
    return { v: value ?? '', t: typeof value === 'number' ? 'n' : 's', s };
}

function xlStatusCell(label) {
    const map = { Completed: XL.GREEN, Ongoing: XL.AMBER, Pending: XL.RED };
    const color = map[label] || '000000';
    return xlCell(label, { fontColor: color, bold: true, hAlign: 'center' });
}

function xlDownload(wb, filename) {
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob  = new Blob([wbout], { type: 'application/octet-stream' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = filename + '.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ─── Export A: School List ────────────────────────────────────────────────────
function exportSchoolList() {
    const schools = filteredSchools();
    if (!schools.length) { showToast('No data to export.', 'error'); return; }

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const sType   = _schoolType.charAt(0).toUpperCase() + _schoolType.slice(1);

    // Total data columns: 7 base + 4 quarters × 4 cols = 23
    const BASE_COLS = 7;
    const totalCols = BASE_COLS + QUARTERS.length * 4;
    const lastCol   = totalCols - 1;

    const aoa    = [];
    const merges = [];
    let   R      = 0; // current row index

    // ── Title banner ──
    aoa[R] = [xlCell('QATALYST — School List Summary Report',
        { bold: true, sz: 14, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' })];
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: lastCol } });
    R++;

    // ── Metadata rows ──
    const metaStyle  = { sz: 10, fontColor: '334155', bgColor: XL.GREY_LIGHT };
    const metaLStyle = { bold: true, sz: 10, fontColor: XL.BLUE_DARK, bgColor: XL.GREY_LIGHT };
    const meta = [
        ['School Year:', _currentYear],
        ['School Type:', sType],
        ['Exported On:', dateStr + '  ' + timeStr],
        ['Total Schools:', schools.length],
    ];
    for (const [label, value] of meta) {
        aoa[R] = [xlCell(label, metaLStyle), xlCell(value, metaStyle)];
        merges.push({ s: { r: R, c: 1 }, e: { r: R, c: lastCol } });
        R++;
    }
    R++; // blank spacer row

    // ── Quarter group headers (row 1 of header) ──
    aoa[R] = [
        xlCell('', { bgColor: XL.BLUE_DARK }),
        xlCell('', { bgColor: XL.BLUE_DARK }),
        xlCell('Overall Progress (%)', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Steps Completed',      { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Total Steps',          { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Status',               { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Notes',                { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
    ];
    const qColors = ['1E40AF', '0369A1', '0E7490', '0F766E']; // distinct tints per quarter
    QUARTERS.forEach((q, qi) => {
        const bg  = qColors[qi % qColors.length];
        const col = BASE_COLS + qi * 4;
        aoa[R][col] = xlCell(q.label, { bold: true, sz: 10, fontColor: XL.WHITE, bgColor: bg, hAlign: 'center' });
        merges.push({ s: { r: R, c: col }, e: { r: R, c: col + 3 } });
    });
    R++;

    // ── Sub-headers (row 2 of header) ──
    aoa[R] = [
        xlCell('No.',          { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('School Name',  { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK }),
        xlCell('%',            { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Done',         { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Total',        { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Status',       { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        xlCell('Notes',        { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
    ];
    const subLabels = ['Total', 'Endorsed', 'Approved', 'Released'];
    const qColors2  = ['1D4ED8', '0284C7', '0891B2', '0D9488'];
    QUARTERS.forEach((q, qi) => {
        const bg  = qColors2[qi % qColors2.length];
        subLabels.forEach((lbl, li) => {
            aoa[R][BASE_COLS + qi * 4 + li] = xlCell(lbl, { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: bg, hAlign: 'center' });
        });
    });
    R++;
    const dataStartR = R;

    // ── Data rows ──
    const sorted = [...schools].sort((a, b) => {
        const pa = schoolProgress(a.id, _catFilter).pct;
        const pb = schoolProgress(b.id, _catFilter).pct;
        return pb !== pa ? pb - pa : a.name.localeCompare(b.name);
    });

    let rowNo = 1;
    const qSums = {};
    for (const q of QUARTERS) qSums[q.key] = { total: 0, endorsed: 0, approved: 0, released: 0 };
    let sumChecked = 0, sumTotal = 0;

    for (const s of sorted) {
        const { total, checked, pct } = schoolProgress(s.id, _catFilter);
        const st      = statusOf(pct);
        const stLabel = st === 'done' ? 'Completed' : st === 'partial' ? 'Ongoing' : 'Pending';
        const qCounts = schoolQuarterlyCounts(s.id, _catFilter);
        const isEven  = rowNo % 2 === 0;
        const rowBg   = isEven ? XL.BLUE_LIGHT : XL.WHITE;

        sumChecked += checked;
        sumTotal   += total;

        aoa[R] = [
            xlCell(rowNo,     { hAlign: 'center', bgColor: rowBg }),
            xlCell(s.name,    { bgColor: rowBg }),
            xlCell(pct + '%', { hAlign: 'center', bgColor: rowBg }),
            xlCell(checked,   { hAlign: 'center', bgColor: rowBg }),
            xlCell(total,     { hAlign: 'center', bgColor: rowBg }),
            xlStatusCell(stLabel),
            xlCell('',        { bgColor: rowBg }),
        ];

        const qRowColors = ['EFF6FF', 'F0F9FF', 'ECFEFF', 'F0FDFA'];
        QUARTERS.forEach((q, qi) => {
            const qd  = qCounts[q.key];
            const qbg = isEven ? qRowColors[qi] : XL.WHITE;
            qSums[q.key].total    += qd.total;
            qSums[q.key].endorsed += qd.endorsed;
            qSums[q.key].approved += qd.approved;
            qSums[q.key].released += qd.released;
            const base = BASE_COLS + qi * 4;
            aoa[R][base]     = xlCell(qd.total,    { hAlign: 'center', bgColor: qbg, bold: true });
            aoa[R][base + 1] = xlCell(qd.endorsed, { hAlign: 'center', bgColor: qbg });
            aoa[R][base + 2] = xlCell(qd.approved, { hAlign: 'center', bgColor: qbg });
            aoa[R][base + 3] = xlCell(qd.released, { hAlign: 'center', bgColor: qbg });
        });

        rowNo++;
        R++;
    }

    // ── Totals row ──
    const overallPct = sumTotal ? Math.round(sumChecked / sumTotal * 100) : 0;
    aoa[R] = [
        xlCell('',              { bgColor: XL.TOTALS_BG }),
        xlCell('TOTALS',        { bold: true, sz: 10, bgColor: XL.TOTALS_BG }),
        xlCell(overallPct + '%',{ bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG }),
        xlCell(sumChecked,      { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG }),
        xlCell(sumTotal,        { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG }),
        xlCell('',              { bgColor: XL.TOTALS_BG }),
        xlCell('',              { bgColor: XL.TOTALS_BG }),
    ];
    QUARTERS.forEach((q, qi) => {
        const base = BASE_COLS + qi * 4;
        aoa[R][base]     = xlCell(qSums[q.key].total,    { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
        aoa[R][base + 1] = xlCell(qSums[q.key].endorsed, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
        aoa[R][base + 2] = xlCell(qSums[q.key].approved, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
        aoa[R][base + 3] = xlCell(qSums[q.key].released, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
    });

    // ── Build worksheet ──
    const ws  = XL.aoaToWs(aoa, merges);
    ws['!cols'] = [
        { wch: 5 },   // No.
        { wch: 36 },  // School Name
        { wch: 10 },  // %
        { wch: 8 },   // Done
        { wch: 8 },   // Total
        { wch: 12 },  // Status
        { wch: 16 },  // Notes
        ...Array(QUARTERS.length * 4).fill({ wch: 10 }),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'School List');
    xlDownload(wb, `school-list-${_currentYear}-${_schoolType}`);
    showToast('School List exported as Excel.', 'success');
}

// ─── Export B: Quarterly Counts ───────────────────────────────────────────────
function exportQuarterlyCounts() {
    const schools = filteredSchools();
    if (!schools.length) { showToast('No data to export.', 'error'); return; }
    if (!_exportQRange || !_exportQRange.length) {
        showToast('Select at least one quarter.', 'error'); return;
    }

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const sType   = _schoolType.charAt(0).toUpperCase() + _schoolType.slice(1);
    const selQ    = QUARTERS.filter(q => _exportQRange.includes(q.key));

    const wb = XLSX.utils.book_new();

    // ════════════════════════════════════════
    // SHEET 1 — Per-School Quarterly Counts
    // ════════════════════════════════════════
    (function buildSheet1() {
        const BASE   = 3; // No. | School Name | Status
        const QCOLS  = 4; // Endorsed | Approved | Released | Total
        const total  = BASE + selQ.length * QCOLS + 1; // +1 Grand Total
        const lastC  = total - 1;
        const aoa    = [];
        const merges = [];
        let R = 0;

        // Title
        aoa[R] = [xlCell('QATALYST — Per-School Quarterly Counts',
            { bold: true, sz: 13, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' })];
        merges.push({ s: { r: R, c: 0 }, e: { r: R, c: lastC } });
        R++;

        // Metadata
        const metaL = { bold: true, sz: 10, fontColor: XL.BLUE_DARK, bgColor: XL.GREY_LIGHT };
        const metaV = { sz: 10, fontColor: '334155', bgColor: XL.GREY_LIGHT };
        [
            ['School Year:', _currentYear],
            ['School Type:', sType],
            ['Quarters:', selQ.map(q => q.label).join(', ')],
            ['Exported On:', dateStr + '  ' + timeStr],
        ].forEach(([l, v]) => {
            aoa[R] = [xlCell(l, metaL), xlCell(v, metaV)];
            merges.push({ s: { r: R, c: 1 }, e: { r: R, c: lastC } });
            R++;
        });
        R++;

        // Quarter group header
        const qPalette = ['1E3A8A', '075985', '155E75', '134E4A'];
        aoa[R] = [
            xlCell('No.',         { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
            xlCell('School Name', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK }),
            xlCell('Status',      { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        ];
        selQ.forEach((q, qi) => {
            const col = BASE + qi * QCOLS;
            aoa[R][col] = xlCell(q.label, { bold: true, sz: 10, fontColor: XL.WHITE, bgColor: qPalette[qi % qPalette.length], hAlign: 'center' });
            merges.push({ s: { r: R, c: col }, e: { r: R, c: col + QCOLS - 1 } });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell('Grand Total', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' });
        R++;

        // Sub-headers
        const qPalette2 = ['1D4ED8', '0369A1', '0E7490', '0F766E'];
        aoa[R] = [
            xlCell('No.',         { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
            xlCell('School Name', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK }),
            xlCell('Status',      { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_DARK, hAlign: 'center' }),
        ];
        selQ.forEach((q, qi) => {
            const bg   = qPalette2[qi % qPalette2.length];
            const base = BASE + qi * QCOLS;
            ['Endorsed', 'Approved', 'Released', 'Total'].forEach((lbl, li) => {
                aoa[R][base + li] = xlCell(lbl, { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: bg, hAlign: 'center' });
            });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell('', { bgColor: XL.BLUE_DARK });
        R++;

        const sorted = [...schools].sort((a, b) => a.name.localeCompare(b.name));
        let rowNo = 1;

        for (const s of sorted) {
            const { pct }   = schoolProgress(s.id, _catFilter);
            const st        = statusOf(pct);
            const stLabel   = st === 'done' ? 'Completed' : st === 'partial' ? 'Ongoing' : 'Pending';
            const qCounts   = schoolQuarterlyCounts(s.id, _catFilter);
            const isEven    = rowNo % 2 === 0;
            const rowBg     = isEven ? XL.BLUE_LIGHT : XL.WHITE;
            let grandTotal  = 0;

            aoa[R] = [
                xlCell(rowNo,    { hAlign: 'center', bgColor: rowBg }),
                xlCell(s.name,   { bgColor: rowBg }),
                xlStatusCell(stLabel),
            ];

            const qTints = ['EFF6FF', 'F0F9FF', 'ECFEFF', 'F0FDFA'];
            selQ.forEach((q, qi) => {
                const qd   = qCounts[q.key];
                const qbg  = isEven ? qTints[qi % qTints.length] : XL.WHITE;
                const base = BASE + qi * QCOLS;
                grandTotal += qd.total;
                aoa[R][base]     = xlCell(qd.endorsed, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 1] = xlCell(qd.approved, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 2] = xlCell(qd.released, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 3] = xlCell(qd.total,    { hAlign: 'center', bgColor: qbg, bold: true });
            });
            aoa[R][BASE + selQ.length * QCOLS] = xlCell(grandTotal, { bold: true, hAlign: 'center', bgColor: rowBg });

            rowNo++;
            R++;
        }

        // Totals row
        aoa[R] = [
            xlCell('',       { bgColor: XL.TOTALS_BG }),
            xlCell('TOTALS', { bold: true, bgColor: XL.TOTALS_BG }),
            xlCell('',       { bgColor: XL.TOTALS_BG }),
        ];
        let allGrand = 0;
        selQ.forEach((q, qi) => {
            let end = 0, app = 0, rel = 0, tot = 0;
            for (const s of sorted) {
                const qd = schoolQuarterlyCounts(s.id, _catFilter)[q.key];
                end += qd.endorsed; app += qd.approved; rel += qd.released; tot += qd.total;
            }
            allGrand += tot;
            const base = BASE + qi * QCOLS;
            aoa[R][base]     = xlCell(end, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 1] = xlCell(app, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 2] = xlCell(rel, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 3] = xlCell(tot, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell(allGrand, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });

        const ws = XL.aoaToWs(aoa, merges);
        ws['!cols'] = [{ wch: 5 }, { wch: 36 }, { wch: 12 }, ...Array(selQ.length * QCOLS + 1).fill({ wch: 11 })];
        XLSX.utils.book_append_sheet(wb, ws, 'Per-School Counts');
    })();

    // ════════════════════════════════════════
    // SHEET 2 — Category-Level Quarterly Counts
    // ════════════════════════════════════════
    (function buildSheet2() {
        const BASE   = 1; // Category label
        const QCOLS  = 4;
        const total  = BASE + selQ.length * QCOLS + 1;
        const lastC  = total - 1;
        const aoa    = [];
        const merges = [];
        let R = 0;

        // Title
        aoa[R] = [xlCell('QATALYST — Category-Level Quarterly Counts',
            { bold: true, sz: 13, fontColor: XL.WHITE, bgColor: XL.BLUE_MID, hAlign: 'center' })];
        merges.push({ s: { r: R, c: 0 }, e: { r: R, c: lastC } });
        R++;

        const metaL = { bold: true, sz: 10, fontColor: XL.BLUE_DARK, bgColor: XL.GREY_LIGHT };
        const metaV = { sz: 10, fontColor: '334155', bgColor: XL.GREY_LIGHT };
        [
            ['School Year:', _currentYear],
            ['School Type:', sType],
            ['Quarters:', selQ.map(q => q.label).join(', ')],
            ['Exported On:', `${dateStr}  ${timeStr}`],
        ].forEach(([l, v]) => {
            aoa[R] = [xlCell(l, metaL), xlCell(v, metaV)];
            merges.push({ s: { r: R, c: 1 }, e: { r: R, c: lastC } });
            R++;
        });
        R++;

        // Quarter group header
        const qPal = ['1E3A8A', '075985', '155E75', '134E4A'];
        aoa[R] = [xlCell('Category', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_MID })];
        selQ.forEach((q, qi) => {
            const col = BASE + qi * QCOLS;
            aoa[R][col] = xlCell(q.label, { bold: true, sz: 10, fontColor: XL.WHITE, bgColor: qPal[qi % qPal.length], hAlign: 'center' });
            merges.push({ s: { r: R, c: col }, e: { r: R, c: col + QCOLS - 1 } });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell('Grand Total', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_MID, hAlign: 'center' });
        R++;

        // Sub-headers
        const qPal2 = ['1D4ED8', '0369A1', '0E7490', '0F766E'];
        aoa[R] = [xlCell('Category', { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: XL.BLUE_MID })];
        selQ.forEach((q, qi) => {
            const bg   = qPal2[qi % qPal2.length];
            const base = BASE + qi * QCOLS;
            ['Endorsed', 'Approved', 'Released', 'Total'].forEach((lbl, li) => {
                aoa[R][base + li] = xlCell(lbl, { bold: true, sz: 9, fontColor: XL.WHITE, bgColor: bg, hAlign: 'center' });
            });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell('', { bgColor: XL.BLUE_MID });
        R++;

        const catQData = aggregateCategoryQuarterlyCounts(schools);
        let allGrand   = 0;
        const catTotals = { endorsed: 0, approved: 0, released: 0, total: 0 };
        const qTots     = {};
        selQ.forEach(q => { qTots[q.key] = { endorsed: 0, approved: 0, released: 0, total: 0 }; });

        CATEGORIES.forEach((cat, ci) => {
            const isEven = ci % 2 === 0;
            const rowBg  = isEven ? XL.GREY_LIGHT : XL.WHITE;
            aoa[R] = [xlCell(cat.label, { bgColor: rowBg, wrap: true })];
            let catGrand = 0;

            const qTints = ['EFF6FF', 'F0F9FF', 'ECFEFF', 'F0FDFA'];
            selQ.forEach((q, qi) => {
                const qd   = catQData[cat.key][q.key] || { endorsed: 0, approved: 0, released: 0, total: 0 };
                const qbg  = isEven ? qTints[qi % qTints.length] : XL.WHITE;
                const base = BASE + qi * QCOLS;
                catGrand += qd.total;
                qTots[q.key].endorsed += qd.endorsed;
                qTots[q.key].approved += qd.approved;
                qTots[q.key].released += qd.released;
                qTots[q.key].total    += qd.total;
                aoa[R][base]     = xlCell(qd.endorsed, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 1] = xlCell(qd.approved, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 2] = xlCell(qd.released, { hAlign: 'center', bgColor: qbg });
                aoa[R][base + 3] = xlCell(qd.total,    { hAlign: 'center', bgColor: qbg, bold: true });
            });
            allGrand += catGrand;
            aoa[R][BASE + selQ.length * QCOLS] = xlCell(catGrand, { bold: true, hAlign: 'center', bgColor: rowBg });
            R++;
        });

        // Grand totals row
        aoa[R] = [xlCell('TOTAL (All Categories)', { bold: true, sz: 10, bgColor: XL.TOTALS_BG })];
        selQ.forEach((q, qi) => {
            const base = BASE + qi * QCOLS;
            aoa[R][base]     = xlCell(qTots[q.key].endorsed, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 1] = xlCell(qTots[q.key].approved, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 2] = xlCell(qTots[q.key].released, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
            aoa[R][base + 3] = xlCell(qTots[q.key].total,    { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });
        });
        aoa[R][BASE + selQ.length * QCOLS] = xlCell(allGrand, { bold: true, hAlign: 'center', bgColor: XL.TOTALS_BG });

        const ws = XL.aoaToWs(aoa, merges);
        ws['!cols'] = [{ wch: 38 }, ...Array(selQ.length * QCOLS + 1).fill({ wch: 11 })];
        XLSX.utils.book_append_sheet(wb, ws, 'Category Counts');
    })();

    xlDownload(wb, `quarterly-counts-${_currentYear}-${_schoolType}-${_exportQRange.join('')}`);
    showToast('Quarterly Counts exported as Excel.', 'success');
}

// ─── Export C: Document Tracking (checkbox matrix) ───────────────────────────
/**
 * Produces an Excel sheet that mirrors the reference "Document Tracking System"
 * layout:
 *   Row 1  : Big title banner
 *   Row 2  : Metadata
 *   Row 3  : Category group headers  (merged across all their leaf columns)
 *   Row 4  : Level / row sub-headers (e.g. Pre-School, Elem, JHS, SHS …)
 *   Row 5  : Step sub-sub-headers    (Endorsed to RO / Approved / Released …)
 *   Row 6+ : One row per school, ✓ (checked) or ✗ (unchecked) per cell
 *   Last   : TOTAL count row
 *
 * Colour scheme mirrors the reference:
 *   • Category header  — dark teal  (#1A5276)
 *   • Level header     — mid teal   (#2E86C1)
 *   • Step header      — light blue (#AED6F1)
 *   • ✓ checked cell   — white text on green (#1E8449)
 *   • ✗ unchecked cell — dark red   (#922B21) on light pink
 *   • Totals row       — slate grey
 */
function exportDocumentTracking() {
    const schools = filteredSchools();
    if (!schools.length) { showToast('No data to export.', 'error'); return; }

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const sType   = _schoolType.charAt(0).toUpperCase() + _schoolType.slice(1);

    // ── colour palette ──────────────────────────────────────────────────────
    const C = {
        CAT_BG:    '1A3F7A',   // dark navy  — category group header
        CAT_FG:    'FFFFFF',
        LVL_BG:    '2563EB',   // blue       — level sub-header
        LVL_FG:    'FFFFFF',
        STEP_BG:   'DBEAFE',   // light blue — step sub-header
        STEP_FG:   '1E3A8A',
        CHK_BG:    '16A34A',   // green      — checked cell bg
        CHK_FG:    'FFFFFF',   // white tick
        UNK_BG:    'FEF2F2',   // light pink — unchecked
        UNK_FG:    'B91C1C',   // red cross
        NO_BG:     'F8FAFC',   // very light — school has no rows for this level
        TOT_BG:    'E2E8F0',   // slate      — totals row
        META_BG:   'F1F5F9',
        TITLE_BG:  '1A3F7A',
        NO_COL:    'E8EEF7',   // alternating row tint for No. + Name cols
    };

    // ── build the flat list of leaf columns ──────────────────────────────────
    // Each leaf = { catKey, catLabel, rowLabel, step, colIndex }
    const leaves = [];
    for (const cat of CATEGORIES) {
        for (const rowLabel of cat.rows) {
            for (const step of cat.steps) {
                leaves.push({ catKey: cat.key, catLabel: cat.label, rowLabel, step });
            }
        }
    }

    // Fixed left columns: No. (col 0) + School Name (col 1)
    const DATA_START = 2;
    const totalCols  = DATA_START + leaves.length;
    const lastCol    = totalCols - 1;

    // Sort schools alphabetically
    const sorted = [...schools].sort((a, b) => a.name.localeCompare(b.name));

    const aoa    = [];
    const merges = [];
    let R = 0;

    // ── helper: make a styled cell ──────────────────────────────────────────
    const C_ = (value, { bold = false, sz = 9, fg = '000000', bg = null,
        hAlign = 'center', vAlign = 'center', wrap = false } = {}) => {
        const s = {
            font:      { name: 'Arial', bold, sz, color: { rgb: fg } },
            alignment: { horizontal: hAlign, vertical: vAlign, wrapText: wrap },
            border: {
                top:    { style: 'thin', color: { rgb: 'CBD5E1' } },
                bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
                left:   { style: 'thin', color: { rgb: 'CBD5E1' } },
                right:  { style: 'thin', color: { rgb: 'CBD5E1' } },
            },
        };
        if (bg) s.fill = { fgColor: { rgb: bg } };
        return { v: value ?? '', t: typeof value === 'number' ? 'n' : 's', s };
    };

    const M = (r1, r2, c1, c2) => merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });

    // ── ROW 0: Title ────────────────────────────────────────────────────────
    aoa[R] = [ C_('DOCUMENT TRACKING SYSTEM ON PRIVATE SCHOOL APPLICATION AND REQUEST',
        { bold: true, sz: 13, fg: C.CAT_FG, bg: C.TITLE_BG, hAlign: 'center' }) ];
    M(R, R, 0, lastCol);
    R++;

    // ── ROW 1: Metadata ─────────────────────────────────────────────────────
    const metaL = { bold: true, sz: 9, fg: C.CAT_BG, bg: C.META_BG, hAlign: 'left' };
    const metaV = { sz: 9, fg: '334155', bg: C.META_BG, hAlign: 'left' };
    const metaStr = `School Year: ${_currentYear}   |   Type: ${sType}   |   Exported: ${dateStr} ${timeStr}   |   Schools: ${sorted.length}`;
    aoa[R] = [ C_(metaStr, { ...metaL }) ];
    M(R, R, 0, lastCol);
    R++;

    // ── ROW 2: "NO." + "SCHOOL" fixed headers  +  Category group headers ───
    aoa[R] = [];
    aoa[R][0] = C_('NO.',    { bold: true, sz: 9, fg: C.CAT_FG, bg: C.CAT_BG });
    aoa[R][1] = C_('SCHOOL', { bold: true, sz: 9, fg: C.CAT_FG, bg: C.CAT_BG, hAlign: 'left' });

    // Build category group spans
    const catGroups = [];
    {
        let ci = DATA_START;
        for (const cat of CATEGORIES) {
            const spanCols = cat.rows.length * cat.steps.length;
            catGroups.push({ cat, startC: ci, spanCols });
            aoa[R][ci] = C_(cat.label.toUpperCase(), { bold: true, sz: 9, fg: C.CAT_FG, bg: C.CAT_BG });
            if (spanCols > 1) M(R, R, ci, ci + spanCols - 1);
            ci += spanCols;
        }
    }
    R++;

    // ── ROW 3: Level / row sub-headers ──────────────────────────────────────
    aoa[R] = [];
    aoa[R][0] = C_('',  { bg: C.LVL_BG });
    aoa[R][1] = C_('',  { bg: C.LVL_BG });

    for (const { cat, startC } of catGroups) {
        let ci = startC;
        for (const rowLabel of cat.rows) {
            const spanCols = cat.steps.length;
            const label    = cat.noRowLabel ? (cat.label.toUpperCase()) : rowLabel.toUpperCase();
            aoa[R][ci] = C_(label, { bold: true, sz: 9, fg: C.LVL_FG, bg: C.LVL_BG, wrap: true });
            if (spanCols > 1) M(R, R, ci, ci + spanCols - 1);
            ci += spanCols;
        }
    }
    R++;

    // ── ROW 4: Step sub-sub-headers ─────────────────────────────────────────
    aoa[R] = [];
    aoa[R][0] = C_('',  { bg: C.STEP_BG });
    aoa[R][1] = C_('',  { bg: C.STEP_BG });

    {
        let ci = DATA_START;
        for (const cat of CATEGORIES) {
            for (const rowLabel of cat.rows) {
                for (const step of cat.steps) {
                    // Shorten long step labels to fit narrow columns
                    const short = step
                        .replace('Received w/ Compliance', 'Rec. w/ Compl.')
                        .replace('Endorsed to RO',  'Endsd. RO')
                        .replace('Endorsed to SDS', 'Endsd. SDS')
                        .replace('Received & Acknowledged', 'Rec. & Ack.')
                        .replace('Approved',  'Apprvd.')
                        .replace('Released',  'Relsd.');
                    aoa[R][ci] = C_(short, { bold: true, sz: 8, fg: C.STEP_FG, bg: C.STEP_BG, wrap: true });
                    ci++;
                }
            }
        }
    }
    const HEADER_ROWS = R; // last header row index
    R++;

    // ── DATA ROWS: one per school ────────────────────────────────────────────
    const colTotals = new Array(leaves.length).fill(0);

    sorted.forEach((s, idx) => {
        const sd     = _data[s.id] || {};
        const isEven = idx % 2 === 0;
        const nameBg = isEven ? 'F0F4FF' : 'FFFFFF';

        aoa[R] = [];
        aoa[R][0] = C_(idx + 1,  { sz: 9, bg: nameBg, hAlign: 'center' });
        aoa[R][1] = C_(s.name,   { sz: 9, bg: nameBg, hAlign: 'left' });

        leaves.forEach((leaf, li) => {
            const key  = `${leaf.catKey}|${leaf.rowLabel}|${leaf.step}`;
            const cell = normaliseCell(sd[key]);

            if (cell.checked) {
                colTotals[li]++;
                aoa[R][DATA_START + li] = C_('✓', { bold: true, sz: 10, fg: C.CHK_FG, bg: C.CHK_BG });
            } else {
                aoa[R][DATA_START + li] = C_('✗', { sz: 9, fg: C.UNK_FG, bg: C.UNK_BG });
            }
        });

        R++;
    });

    // ── TOTALS row ───────────────────────────────────────────────────────────
    aoa[R] = [];
    aoa[R][0] = C_('',       { bg: C.TOT_BG });
    aoa[R][1] = C_('TOTALS', { bold: true, sz: 9, bg: C.TOT_BG, hAlign: 'left' });
    leaves.forEach((leaf, li) => {
        aoa[R][DATA_START + li] = C_(colTotals[li],
            { bold: true, sz: 9, bg: C.TOT_BG, fg: colTotals[li] > 0 ? '15803D' : '94A3B8' });
    });

    // ── Merge fixed left columns vertically for header rows ─────────────────
    // No. and School columns: merge rows 2-4 (the 3 header rows)
    M(2, HEADER_ROWS, 0, 0);  // NO. col
    M(2, HEADER_ROWS, 1, 1);  // SCHOOL col

    // ── Build worksheet ──────────────────────────────────────────────────────
    const ws = XL.aoaToWs(aoa, merges);

    // Column widths
    ws['!cols'] = [
        { wch: 4  },   // No.
        { wch: 34 },   // School Name
        ...leaves.map(() => ({ wch: 7 })),  // each step column — narrow
    ];

    // Row heights
    ws['!rows'] = [
        { hpt: 24 },  // title
        { hpt: 16 },  // metadata
        { hpt: 52 },  // category headers (tall for wrapped text)
        { hpt: 40 },  // level headers
        { hpt: 40 },  // step headers
        ...sorted.map(() => ({ hpt: 16 })),  // data rows
        { hpt: 18 },  // totals
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Document Tracking');
    xlDownload(wb, `document-tracking-${_currentYear}-${_schoolType}`);
    showToast('Document Tracking sheet exported as Excel.', 'success');
}

// ─── Load data entry point ────────────────────────────────────────────────────
async function loadData() {
    await loadSchools();
    await loadTrackingData();
}

// ─── Indorsements Modal ───────────────────────────────────────────────────────
const IND_TYPE_LABELS = {
    school_calendar: 'School Calendar',
    tuition_increase: 'Tuition Fee Increase',
    no_increase: 'No Increase on Tuition',
    school_permit: 'School Permit',
};
const IND_TYPE_COLORS = {
    school_calendar:  { bg: '#dbeafe', fg: '#1d4ed8', dot: '#3b82f6' },
    tuition_increase: { bg: '#fef9c3', fg: '#854d0e', dot: '#f59e0b' },
    no_increase:      { bg: '#dcfce7', fg: '#15803d', dot: '#22c55e' },
    school_permit:    { bg: '#f3e8ff', fg: '#7e22ce', dot: '#a855f7' },
};

let _indorsements      = [];   // raw data from API
let _indFilter_type    = 'all';
let _indFilter_year    = 'all';
let _indFilter_search  = '';

async function openIndorsementsModal() {
    _buildIndorsementsModal();
    const modal = document.getElementById('indorsementsModal');
    modal.classList.add('open');
    await _loadIndorsements();
}

function closeIndorsementsModal() {
    document.getElementById('indorsementsModal')?.classList.remove('open');
}

function _buildIndorsementsModal() {
    if (document.getElementById('indorsementsModal')) return;

    const modal = document.createElement('div');
    modal.id = 'indorsementsModal';
    modal.innerHTML = `
    <div class="emodal-backdrop" onclick="closeIndorsementsModal()"></div>
    <div class="emodal-box imod-box">
        <div class="emodal-header">
            <h2><i class="fa-solid fa-stamp"></i> Indorsements</h2>
            <button class="emodal-close" onclick="closeIndorsementsModal()"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="imod-toolbar">
            <div class="imod-filters">
                <!-- Type pills -->
                <div class="imod-pill-group" id="indTypePills">
                    <button class="imod-pill active" data-val="all" onclick="setIndFilter('type','all',this)">All Types</button>
                    <button class="imod-pill" data-val="school_calendar"  onclick="setIndFilter('type','school_calendar',this)">
                        <span class="imod-dot" style="background:#3b82f6;"></span> School Calendar
                    </button>
                    <button class="imod-pill" data-val="tuition_increase" onclick="setIndFilter('type','tuition_increase',this)">
                        <span class="imod-dot" style="background:#f59e0b;"></span> Tuition Increase
                    </button>
                    <button class="imod-pill" data-val="no_increase"      onclick="setIndFilter('type','no_increase',this)">
                        <span class="imod-dot" style="background:#22c55e;"></span> No Increase
                    </button>
                    <button class="imod-pill" data-val="school_permit"    onclick="setIndFilter('type','school_permit',this)">
                        <span class="imod-dot" style="background:#a855f7;"></span> School Permit
                    </button>
                </div>
                <!-- Year + search -->
                <div class="imod-filter-row">
                    <select class="ctrl-select imod-year-sel" id="indYearFilter" onchange="setIndFilter('year',this.value,this)">
                        <option value="all">All School Years</option>
                    </select>
                    <div class="imod-search-wrap">
                        <i class="fa-solid fa-magnifying-glass imod-search-icon"></i>
                        <input class="imod-search" type="text" placeholder="Search school…" oninput="setIndFilter('search',this.value,this)">
                    </div>
                </div>
            </div>
            <div class="imod-toolbar-actions">
                <button class="btn btn-secondary imod-export-btn" onclick="exportIndorsementsExcel()" title="Export to Excel">
                    <i class="fa-solid fa-file-excel"></i> Export Excel
                </button>
                <button class="btn btn-primary imod-export-btn" onclick="exportIndorsementsWord()" title="Export to Word">
                    <i class="fa-solid fa-file-word"></i> Export Word
                </button>
            </div>
        </div>
        <div class="imod-stats" id="indStats"></div>
        <div class="imod-body">
            <div id="indLoader" class="summary-loader" style="display:none;">
                <div class="summary-spinner"></div><span>Loading indorsements…</span>
            </div>
            <div id="indError" class="summary-error hidden"></div>
            <div class="table-scroll" id="indTableWrap">
                <table class="summary-table imod-table" id="indTable">
                    <thead>
                        <tr>
                            <th style="width:40px;text-align:center;">#</th>
                            <th>School Name</th>
                            <th>Address</th>
                            <th>School Year</th>
                            <th>Type</th>
                            <th>End No.</th>
                            <th>Level / Course</th>
                            <th>Letter Date</th>
                            <th>Signed By</th>
                            <th>Created At</th>
                        </tr>
                    </thead>
                    <tbody id="indTbody"><tr><td colspan="10" style="text-align:center;color:#94a3b8;padding:40px;">Loading…</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="emodal-footer">
            <span id="indCount" style="font-size:12px;color:var(--color-text-secondary);"></span>
            <button class="btn btn-secondary" onclick="closeIndorsementsModal()">Close</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
}

async function _loadIndorsements() {
    const loader = document.getElementById('indLoader');
    const errEl  = document.getElementById('indError');
    const wrap   = document.getElementById('indTableWrap');
    if (loader) loader.style.display = 'flex';
    if (errEl)  errEl.classList.add('hidden');

    try {
        // Fetch indorsements + calendar docs in parallel
        const [indRes, calRes] = await Promise.all([
            fetch(API_URL + '/school-indorsements.php?action=list', { credentials: 'include' }),
            fetch(API_URL + '/school-calendar-docs.php?action=list', { credentials: 'include' }),
        ]);

        if (!indRes.ok) throw new Error('HTTP ' + indRes.status);
        const json = await indRes.json();
        if (!json.success) throw new Error(json.message || 'Failed to load indorsements');

        // Build a map: private_school_id -> { _startDate, _endDate, _totalDays }
        // keyed by both school_id and school_id_no for flexible matching
        const calDocMap = {};
        if (calRes.ok) {
            try {
                const calJson = await calRes.json();
                const docs = Array.isArray(calJson.data) ? calJson.data : [];
                const fmtDate = d => isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
                for (const doc of docs) {
                    try {
                        const payload = typeof doc.payload_json === 'string' ? JSON.parse(doc.payload_json) : doc.payload_json;
                        const form = payload?.form || payload || {};
                        // Support common field names for opening/closing dates
                        const openRaw  = form.f_opening  || form.opening_date  || form.start_date || '';
                        const closeRaw = form.f_closing  || form.closing_date  || form.end_date   || '';
                        if (!openRaw || !closeRaw) continue;
                        const start = new Date(openRaw);
                        const end   = new Date(closeRaw);
                        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
                        // Count weekdays (Mon–Fri) as calendar school days
                        let days = 0;
                        const cur = new Date(start);
                        while (cur <= end) { if (cur.getDay() !== 0 && cur.getDay() !== 6) days++; cur.setDate(cur.getDate() + 1); }
                        const entry = { _startDate: fmtDate(start), _endDate: fmtDate(end), _totalDays: days + ' Days' };
                        // Index by private_school_id and school_id_no (both strings and ints)
                        if (doc.private_school_id != null) calDocMap[String(doc.private_school_id)] = entry;
                        if (doc.school_id_no)              calDocMap[String(doc.school_id_no)]      = entry;
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // FIX: normalize school_year so visually-identical but byte-different
        // values (e.g. "2026-2027" hyphen vs "2026–2027" en dash) are treated
        // as the same year everywhere below — otherwise rows saved with a
        // mismatched dash silently vanish from the year filter/count even
        // though they exist in the table.
        const _normalizeSY = (sy) => String(sy || '').trim().replace(/\s*[\u2010-\u2015\u2212-]\s*/g, '-');

        // Enrich each school_calendar indorsement with date data
        _indorsements = (json.data || []).map(row => {
            row = { ...row, school_year: _normalizeSY(row.school_year) };
            if (row.type !== 'school_calendar') return row;
            const key = String(row.school_id ?? row.private_school_id ?? '');
            const cal = calDocMap[key] || {};
            // Also try preview_text JSON fallback
            if (!cal._startDate && row.preview_text) {
                try {
                    const pt = JSON.parse(row.preview_text);
                    cal._startDate = pt.startDate || pt.f_opening || '';
                    cal._endDate   = pt.endDate   || pt.f_closing || '';
                    cal._totalDays = pt.totalDays || '';
                } catch (_) {}
            }
            return { ...row, ...cal };
        });

        _populateIndYearFilter();
        _renderIndorsements();
    } catch (e) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(e.message)} <button class="btn btn-secondary" onclick="_loadIndorsements()" style="margin-left:10px;">Retry</button>`;
        }
    } finally {
        if (loader) loader.style.display = 'none';
    }
}

function _populateIndYearFilter() {
    const sel = document.getElementById('indYearFilter');
    if (!sel) return;
    const years = [...new Set(_indorsements.map(i => i.school_year))].sort().reverse();
    sel.innerHTML = `<option value="all">All School Years</option>` +
        years.map(y => `<option value="${esc(y)}"${y === _currentYear ? ' selected' : ''}>${esc(y)}</option>`).join('');
    // Auto-select current year if available
    if (years.includes(_currentYear)) {
        sel.value = _currentYear;
        _indFilter_year = _currentYear;
    }
}

function setIndFilter(key, val, el) {
    if (key === 'type') {
        _indFilter_type = val;
        document.querySelectorAll('#indTypePills .imod-pill').forEach(p => p.classList.remove('active'));
        document.querySelector(`#indTypePills .imod-pill[data-val="${val}"]`)?.classList.add('active');
        // Swap table column headers based on type
        _updateIndTableHeaders(val);
    } else if (key === 'year') {
        _indFilter_year = val;
    } else if (key === 'search') {
        _indFilter_search = val.trim().toLowerCase();
    }
    _renderIndorsements();
}

function _updateIndTableHeaders(type) {
    const thead = document.querySelector('#indTable thead tr');
    if (!thead) return;
    if (type === 'school_calendar') {
        thead.innerHTML = `
            <th style="width:40px;text-align:center;">#</th>
            <th>School Name</th>
            <th>Address</th>
            <th>School Year</th>
            <th>End No.</th>
            <th>Start of Classes</th>
            <th>End of Classes</th>
            <th>Total Calendar Days</th>
            <th>Signed By</th>
            <th>Created At</th>`;
    } else {
        thead.innerHTML = `
            <th style="width:40px;text-align:center;">#</th>
            <th>School Name</th>
            <th>Address</th>
            <th>School Year</th>
            <th>Type</th>
            <th>End No.</th>
            <th>Level / Course</th>
            <th>Letter Date</th>
            <th>Signed By</th>
            <th>Created At</th>`;
    }
}

function _filteredIndorsements() {
    return _indorsements.filter(i => {
        if (_indFilter_type !== 'all' && i.type !== _indFilter_type) return false;
        if (_indFilter_year !== 'all' && i.school_year !== _indFilter_year) return false;
        if (_indFilter_search && !i.school_name.toLowerCase().includes(_indFilter_search) &&
            !(i.address || '').toLowerCase().includes(_indFilter_search)) return false;
        return true;
    });
}

function _renderIndorsements() {
    const tbody  = document.getElementById('indTbody');
    const countEl= document.getElementById('indCount');
    const statsEl= document.getElementById('indStats');
    if (!tbody) return;

    // Always keep column headers in sync with active filter
    _updateIndTableHeaders(_indFilter_type);

    const list = _filteredIndorsements();

    // Stats bar
    if (statsEl) {
        const counts = {};
        for (const k of Object.keys(IND_TYPE_LABELS)) counts[k] = 0;
        for (const i of list) if (counts[i.type] !== undefined) counts[i.type]++;
        statsEl.innerHTML = Object.entries(IND_TYPE_LABELS).map(([k, lbl]) => {
            const c = IND_TYPE_COLORS[k];
            return `<span class="imod-stat-chip" style="background:${c.bg};color:${c.fg};">
                <span class="imod-dot" style="background:${c.dot};"></span>${lbl}: <strong>${counts[k]}</strong>
            </span>`;
        }).join('') + `<span class="imod-stat-chip" style="background:#f1f5f9;color:#475569;">
            Total: <strong>${list.length}</strong>
        </span>`;
    }

    if (countEl) countEl.textContent = `Showing ${list.length} of ${_indorsements.length} indorsements`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#94a3b8;padding:40px;">
            <i class="fa-solid fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;"></i>
            No indorsements match your filters.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((row, idx) => {
        const tc = IND_TYPE_COLORS[row.type] || { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' };
        const tl = IND_TYPE_LABELS[row.type] || row.type;
        const ld = row.letter_date ? new Date(row.letter_date).toLocaleDateString('en-PH',
            { year:'numeric', month:'short', day:'numeric' }) : '—';
        const ca = row.created_at ? fmtTs(row.created_at) : '—';

        if (_indFilter_type === 'school_calendar') {
            // Use pre-enriched calendar date fields merged in _loadIndorsements
            const startDate = row._startDate || '—';
            const endDate   = row._endDate   || '—';
            const totalDays = row._totalDays || '—';
            return `<tr>
                <td style="text-align:center;font-size:12px;color:#94a3b8;">${idx+1}</td>
                <td><div class="school-name-cell" title="${esc(row.school_name)}" style="max-width:220px;">${esc(row.school_name)}</div></td>
                <td style="font-size:11px;color:#64748b;max-width:160px;">${esc(row.address || '—')}</td>
                <td style="text-align:center;font-weight:600;font-size:12px;">${esc(row.school_year)}</td>
                <td style="text-align:center;font-size:12px;">${esc(String(row.ind_number ?? ''))}</td>
                <td style="font-size:12px;white-space:nowrap;color:#0f172a;">${esc(startDate)}</td>
                <td style="font-size:12px;white-space:nowrap;color:#0f172a;">${esc(endDate)}</td>
                <td style="text-align:center;font-size:12px;color:#0f172a;">${esc(totalDays)}</td>
                <td style="font-size:11px;color:#64748b;max-width:160px;"><div style="line-height:1.3;">${esc(row.sig_name || '—')}<br><span style="color:#94a3b8;font-size:10px;">${esc(row.sig_position || '')}</span></div></td>
                <td style="font-size:11px;color:#94a3b8;white-space:nowrap;">${esc(ca)}</td>
            </tr>`;
        }

        return `<tr>
            <td style="text-align:center;font-size:12px;color:#94a3b8;">${idx+1}</td>
            <td><div class="school-name-cell" title="${esc(row.school_name)}" style="max-width:220px;">${esc(row.school_name)}</div></td>
            <td style="font-size:11px;color:#64748b;max-width:160px;">${esc(row.address || '—')}</td>
            <td style="text-align:center;font-weight:600;font-size:12px;">${esc(row.school_year)}</td>
            <td>
                <span class="imod-type-badge" style="background:${tc.bg};color:${tc.fg};">
                    <span class="imod-dot" style="background:${tc.dot};"></span>${esc(tl)}
                </span>
            </td>
            <td style="text-align:center;font-size:12px;">${esc(String(row.ind_number ?? ''))}</td>
            <td style="font-size:11px;color:#64748b;max-width:140px;">${esc(row.level || '—')}</td>
            <td style="font-size:12px;white-space:nowrap;">${esc(ld)}</td>
            <td style="font-size:11px;color:#64748b;max-width:160px;"><div style="line-height:1.3;">${esc(row.sig_name || '—')}<br><span style="color:#94a3b8;font-size:10px;">${esc(row.sig_position || '')}</span></div></td>
            <td style="font-size:11px;color:#94a3b8;white-space:nowrap;">${esc(ca)}</td>
        </tr>`;
    }).join('');
}

function _showUnderDevModal(label) {
    document.getElementById('_underDevModal')?.remove();
    const m = document.createElement('div');
    m.id = '_underDevModal';
    m.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';
    m.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:36px 40px;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.18);">
        <div style="font-size:48px;margin-bottom:12px;">&#128679;</div>
        <h3 style="margin:0 0 10px;font-size:18px;color:#1e293b;">Export Under Development</h3>
        <p style="margin:0 0 20px;color:#64748b;font-size:14px;line-height:1.6;">
            Export Report for <strong>${label}</strong> is currently under development.<br>Please check back later.
        </p>
        <button onclick="document.getElementById('_underDevModal').remove()"
            style="background:#4F46E5;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;font-weight:600;cursor:pointer;">
            OK, Got it
        </button>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
}

function exportIndorsementsExcel() {
    const UNDER_DEV_TYPES = ['tuition_increase', 'no_increase', 'school_permit'];
    if (_indFilter_type !== 'all' && UNDER_DEV_TYPES.includes(_indFilter_type)) {
        _showUnderDevModal(IND_TYPE_LABELS[_indFilter_type] || _indFilter_type);
        return;
    }
    const list = _filteredIndorsements();
    if (!list.length) { showToast('No data to export.', 'error'); return; }
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded.', 'error'); return; }

    const headers = ['#','School Name','Address','School Year','Type','End No.','Level / Course','Letter Date','Signed By','Position','Created At'];
    const rows = list.map((r, i) => [
        i+1,
        r.school_name,
        r.address || '',
        r.school_year,
        IND_TYPE_LABELS[r.type] || r.type,
        r.ind_number ?? '',
        r.level || '',
        r.letter_date || '',
        r.sig_name || '',
        r.sig_position || '',
        r.created_at || '',
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [4,32,28,12,20,6,22,14,28,22,18].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Indorsements');
    XLSX.writeFile(wb, `indorsements-${_indFilter_year === 'all' ? 'all' : _indFilter_year}-${_indFilter_type === 'all' ? 'all-types' : _indFilter_type}.xlsx`);
    showToast('Indorsements exported to Excel.', 'success');
}

async function exportIndorsementsWord() {
    const UNDER_DEV_TYPES = ['tuition_increase', 'no_increase', 'school_permit'];
    if (_indFilter_type !== 'all' && UNDER_DEV_TYPES.includes(_indFilter_type)) {
        _showUnderDevModal(IND_TYPE_LABELS[_indFilter_type] || _indFilter_type);
        return;
    }
    const list = _filteredIndorsements();
    if (!list.length) { showToast('No data to export.', 'error'); return; }
    if (typeof docx === 'undefined') { showToast('Word library not loaded.', 'error'); return; }

    showToast('Preparing Word document…', 'info');

    const { Document, Packer, Paragraph, Table, TableRow, TableCell,
            TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle,
            ShadingType } = docx;

    const typeLabel = _indFilter_type === 'all' ? 'All Types' : (IND_TYPE_LABELS[_indFilter_type] || _indFilter_type);
    const yearLabel = _indFilter_year === 'all' ? 'All School Years' : _indFilter_year;

    const makePara = (text, opts = {}) => new Paragraph({
        children: [new TextRun({ text, ...opts })],
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { after: opts.after ?? 120 },
    });

    const cellStyle = (text, bold = false, bg = 'FFFFFF', sz = 18) => new TableCell({
        children: [new Paragraph({
            children: [new TextRun({ text: String(text || ''), bold, size: sz, font: 'Arial' })],
            alignment: AlignmentType.LEFT,
            spacing: { before: 40, after: 40 },
        })],
        shading: bg !== 'FFFFFF' ? { fill: bg, type: ShadingType.CLEAR } : undefined,
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
    });

    const cellCenter = (text, bold = false, bg = 'FFFFFF', sz = 18) => new TableCell({
        children: [new Paragraph({
            children: [new TextRun({ text: String(text || ''), bold, size: sz, font: 'Arial' })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 40, after: 40 },
        })],
        shading: bg !== 'FFFFFF' ? { fill: bg, type: ShadingType.CLEAR } : undefined,
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
    });

    const headerBg = '4F46E5';
    const altBg    = 'F0F4FF';

    let tableHeaders, headerRow, dataRows, table, docTitle, docSubtitle;

    // ── School Calendar: special formatted report (matches Final Summary Report) ──
    if (_indFilter_type === 'school_calendar') {
        docTitle    = 'FINAL SUMMARY REPORT OF PRIVATE SCHOOLS';
        docSubtitle = `Approved / Noted School Calendar of Activities for SY ${yearLabel}`;

        // Date data is already enriched on each row by _loadIndorsements — no extra fetch needed.

        tableHeaders = ['No.', 'Name of School', 'Start of Classes', 'End of Classes', 'Total Number of Calendar Days'];
        headerRow = new TableRow({
            children: tableHeaders.map(h => new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18, font: 'Arial' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 80, after: 80 },
                })],
                shading: { fill: headerBg, type: ShadingType.CLEAR },
                margins: { top: 80, bottom: 80, left: 80, right: 80 },
            })),
        });

        // Deduplicate by school name for the summary report (one row per school)
        const seen = new Set();
        const dedupList = [];
        for (const r of list) {
            const key = (r.private_school_id || r.school_id || r.school_name);
            if (!seen.has(key)) { seen.add(key); dedupList.push(r); }
        }

        dataRows = dedupList.map((r, i) => {
            const startDate = r._startDate || '';
            const endDate   = r._endDate   || '';
            const totalDays = r._totalDays || '';
            const bg = i % 2 === 0 ? altBg : 'FFFFFF';
            return new TableRow({
                children: [
                    cellCenter(String(i + 1), false, bg),
                    cellStyle(r.school_name, true, bg),
                    cellCenter(startDate, false, bg),
                    cellCenter(endDate, false, bg),
                    cellCenter(totalDays, false, bg),
                ],
            });
        });

        table = new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
        });

    } else {
        // ── Generic indorsements table (All Types) ──
        docTitle    = 'INDORSEMENTS SUMMARY REPORT';
        docSubtitle = `School Year: ${yearLabel}   |   Type: ${typeLabel}   |   Total: ${list.length}`;

        tableHeaders = ['#','School Name','Address','School Year','Type','End No.','Level/Course','Letter Date','Signed By'];
        headerRow = new TableRow({
            children: tableHeaders.map(h => new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18, font: 'Arial' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 60, after: 60 },
                })],
                shading: { fill: headerBg, type: ShadingType.CLEAR },
                margins: { top: 80, bottom: 80, left: 80, right: 80 },
            })),
        });

        dataRows = list.map((r, i) => new TableRow({
            children: [
                cellStyle(i+1, false, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle(r.school_name, true, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle(r.address || '', false, i%2===0 ? altBg : 'FFFFFF', 16),
                cellStyle(r.school_year, false, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle(IND_TYPE_LABELS[r.type] || r.type, false, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle(r.ind_number ?? '', false, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle(r.level || '', false, i%2===0 ? altBg : 'FFFFFF', 16),
                cellStyle(r.letter_date || '', false, i%2===0 ? altBg : 'FFFFFF'),
                cellStyle((r.sig_name || '') + (r.sig_position ? '\n' + r.sig_position : ''), false, i%2===0 ? altBg : 'FFFFFF', 16),
            ],
        }));

        table = new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
        });
    }

    const doc = new Document({
        sections: [{
            properties: { page: { size: { orientation: 'landscape' } } },
            children: [
                makePara(docTitle, { bold: true, center: true, size: 28, after: 80 }),
                makePara(docSubtitle, { center: true, size: 18, after: 200 }),
                table,
                makePara('', { after: 120 }),
                makePara(`Generated: ${new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' })}`, { size: 16, color: '94A3B8', after: 0 }),
            ],
        }],
    });

    const blob = await Packer.toBlob(doc);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `indorsements-${yearLabel.replace(/[^a-zA-Z0-9-]/g,'-')}-${_indFilter_type}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Indorsements exported to Word.', 'success');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');

    const ok = await checkAuthentication();
    if (!ok) return;

    if (overlay) overlay.classList.add('hidden');

    await loadYears();
    await loadData();
});
