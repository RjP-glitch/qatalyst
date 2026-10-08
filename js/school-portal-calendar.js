/* ═══════════════════════════════════════════════════════════════════════════
   school-portal-calendar-merged.js
   ─────────────────────────────────────────────────────────────────────────
   Single-file merge of:
     • school-portal-calendar.js          (base module)
     • school-portal-calendar-enhanced.js (stepper, health, locking, cards)
     • school-portal-calendar-savepatch.js (save progress UI + eligibility guard)
     • school-portal-calendar-editrequest.js (real edit-request API call)
     • school-portal-calendar-returnpatch.js (returned-for-correction flow)
   ─────────────────────────────────────────────────────────────────────────
   All monkey-patching / wrap chains have been collapsed into direct
   function definitions. Load order conflicts are eliminated.
   Replace ALL five <script> tags with this one file.
   ═══════════════════════════════════════════════════════════════════════════ */

const API_BASE = CONFIG.API_URL;
const CALENDAR_API = `${API_BASE}/school-portal-calendar.php`;

/* ── Core DOM helpers (defined first — used throughout the file) ─────────── */
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function setText(id, val, fallback = '') { const el = document.getElementById(id); if (el) el.textContent = val || fallback; }

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}
function getInitials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
}
function setPortalAvatars(profilePicture, fullNameValue) {
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const fallback = getInitials(fullNameValue);
    if (!sidebarAvatar) return;
    if (profilePicture) {
        // Only allow data URIs and http(s) URLs — reject anything that could
        // inject script (e.g. javascript: URIs or HTML in the src attribute).
        const isSafe = /^(https?:\/\/|data:image\/(png|jpeg|jpg|gif|webp);base64,)/i.test(profilePicture);
        if (isSafe) {
            sidebarAvatar.innerHTML = `<img src="${profilePicture}" alt="Profile photo">`;
        } else {
            sidebarAvatar.textContent = fallback;
        }
    } else {
        sidebarAvatar.textContent = fallback;
    }
}
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
}
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    // Only clear UI preference keys — sensitive identity fields (edu_user_id, edu_email,
    // edu_role, edu_school_id, etc.) are no longer stored in localStorage (Issue 2).
    ['edu_full_name','edu_role','edu_profile_picture','edu_school_name','edu_district_name',
     'edu_school_logo','edu_school_id_no','edu_grade','edu_school_address',
     'edu_elem_principal','edu_elem_contact','edu_jhs_principal','edu_jhs_contact',
     'edu_shs_principal','edu_shs_contact','edu_cp_categories_visible','edu_cal_tour_seen',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}
/* ── Session auth check — DISABLED. This previously pinged a dedicated
   /api/auth-check.php endpoint on pageshow/visibilitychange to validate
   the session without hitting school-portal-dashboard.php. That endpoint
   does not exist on this server (was causing repeated 404s in the Network
   tab every time the tab regained focus), so the calls have been removed.
   If you add an auth-check.php endpoint later, restore _checkAuthSession()
   and the two event listeners below it.                                  */
function getGlobalToastElement() {
    let el = document.getElementById('globalToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'globalToast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    return el;
}
function showToast(msg, icon = 'fa-circle-check') {
    const t = getGlobalToastElement();
    t.innerHTML = `<i class="fa-solid ${icon}"></i> ${msg}`;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
function escHtml(v) {
    return String(v || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
// fmtSavedDate was a duplicate of formatDate — removed. Use formatDate() instead.
/* Formats a plain YYYY-MM-DD date (no time component) without timezone
   drift — used for opening/closing dates shown on saved-doc cards. */
function fmtPlainDate(v) {
    if (!v) return null;
    const d = new Date(String(v) + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
/* Color-codes a department/level badge so a row of cards for the same
   school can be scanned at a glance. */
function deptBadgeMeta(dept) {
    const d = String(dept || '').toLowerCase();
    if (d.includes('kinder') || d.includes('preschool')) return { css: 'sdc-dept-kinder' };
    if (d.includes('elementary'))                        return { css: 'sdc-dept-elem' };
    if (d.includes('junior high') || d === 'jhs')         return { css: 'sdc-dept-jhs' };
    if (d.includes('senior high') || d === 'shs')         return { css: 'sdc-dept-shs' };
    if (d.includes('college'))                            return { css: 'sdc-dept-college' };
    if (d.includes('sped'))                               return { css: 'sdc-dept-sped' };
    return { css: 'sdc-dept-other' };
}
/* Fallback for cards saved before the department/school_year summary
   columns existed — pulls the level back out of the generated title
   (see buildCalendarDocumentTitle: "... - {dept} (sy1-sy2)"). */
function deptFromTitleFallback(title) {
    const m = String(title || '').match(/-\s*([^-()]+?)\s*\(\d{4}-\d{4}\)\s*$/);
    return m ? m[1].trim() : '';
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════════════ */
let logoDataUrl = '';
const marks = {};
const savedMarks = {};
const remarks = {};
const savedRemarks = {};
/* School Calendar checklist.
   - CHK_HARDCODED_ITEMS: the two requirements THIS builder itself
     generates (Letter of Intent page, Monthly Calendar pages). These are
     always shown, in this order, regardless of what's configured in
     Settings — they're guaranteed by the builder, not admin-configurable.
   - CALENDAR_CHECKLIST_ITEMS: the remaining requirements, fetched from
     Settings → Supporting Docs (doc_type='school_calendar'). These are the
     ones a school must actually upload proof for (Board Resolution, SEC
     registration, etc.), tracked in chkUploads.
   - chkUploads maps slug -> { original_filename, file_size, uploaded_at }
     for whatever has been uploaded for the CURRENT document
     (currentCalendarDocumentId). Cleared/reloaded whenever the open
     document changes. */
const CHK_HARDCODED_ITEMS = [
    { slug: 'sd_cal_loi', label: 'Letter of Intent',
      remark: '✓ Included (Pages 4 of this document)' },
    { slug: 'sd_cal_activities', label: 'Calendar of Activities (200–220 school days, per RA 11480)',
      remark: '✓ Included (Monthly Calendar pages of this document)' },
];
let CALENDAR_CHECKLIST_ITEMS = [];
let _checklistItemsLoaded = false;
const chkUploads = {};
let _uploadsLoadedForDocId = null;

/* Hardcoded items + admin-configured items, de-duplicated by slug so a
   leftover Settings row for the same slug never shows twice. */
function getChecklistDisplayItems() {
    const hardcodedSlugs = new Set(CHK_HARDCODED_ITEMS.map(i => i.slug));
    return [...CHK_HARDCODED_ITEMS, ...CALENDAR_CHECKLIST_ITEMS.filter(i => !hardcodedSlugs.has(i.slug))];
}

/* Hardcoded items carry their own fixed `remark`; everything else's
   remark is derived from whether a file has actually been uploaded for
   it — this is what makes the checklist a real submission, not a
   self-reported checkbox. */
function getChecklistRemarkText(item) {
    if (item.remark) return item.remark;
    const upload = chkUploads[item.slug];
    return upload ? `✓ Uploaded (${upload.original_filename})` : 'Not yet uploaded';
}

const legends = {
    holiday:  { label: 'Holiday',        color: '#dc2626', symbol: 'X',  includeInSchoolDays: false },
    activity: { label: 'School Activity', color: '#374151', symbol: '□',  includeInSchoolDays: true  },
    exam:     { label: 'Exam / Quarter',  color: '#854d0e', symbol: '△',  includeInSchoolDays: true  },
};
const DEFAULT_LEGENDS = {
    holiday:  { label: 'Holiday',        color: '#dc2626', symbol: 'X',  includeInSchoolDays: false },
    activity: { label: 'School Activity', color: '#374151', symbol: '□',  includeInSchoolDays: true  },
    exam:     { label: 'Exam / Quarter',  color: '#854d0e', symbol: '△',  includeInSchoolDays: true  },
};
/* SVG symbol helper — boxed-X / square / triangle marks shown in the review calendar and legend */
function legendSymbolSvg(key, color, size = 12) {
    const s = size;
    if (key === 'holiday') return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><rect x="1" y="1" width="16" height="16" fill="none" stroke="${color}" stroke-width="1.8"/><line x1="1" y1="1" x2="17" y2="17" stroke="${color}" stroke-width="1.8"/><line x1="17" y1="1" x2="1" y2="17" stroke="${color}" stroke-width="1.8"/></svg>`;
    if (key === 'activity') return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><rect x="1" y="1" width="16" height="16" fill="none" stroke="${color}" stroke-width="1.8"/></svg>`;
    if (key === 'exam') return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><polygon points="9,1 17,17 1,17" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
    return `<span style="display:inline-block;width:${s}px;height:${s}px;border-radius:50%;background:${color};vertical-align:middle;"></span>`;
}

let cpSelected = 'holiday';
const CP_NOTE_ONLY_KEY = '__note_only__';

/* ── Academic month list — derived dynamically from the school year form
   fields (f_sy1, f_sy2) so it never needs manual editing between school
   years. Falls back to the current hard-coded range only on first render
   before the form fields are available. Call refreshAcadMonths() whenever
   f_sy1 or f_sy2 change. See Issue 1 in code review.                       */
let ACAD_MONTHS = _buildAcadMonths(2026, 2027); // initial fallback

function _buildAcadMonths(sy1, sy2) {
    // School year runs June of sy1 through April of sy2 (11 months)
    const months = [];
    for (let m = 5; m <= 11; m++) months.push({ y: sy1, m }); // Jun–Dec
    for (let m = 0; m <= 3;  m++) months.push({ y: sy2, m }); // Jan–Apr
    return months;
}

/* ── Period structure per department/level ───────────────────────────
   DepEd-aligned convention used by private schools reporting to SDO:
     • Kindergarten, Preschool, Elementary, Junior High School, SPED  → 4 QUARTERS
     • Senior High School, College                                    → 2 SEMESTERS
   PERIOD_LEVEL_MAP keys are matched against the f_dept value (case-
   insensitive, partial match) so any custom/"Other" entry safely falls
   back to the 4-quarter default. */
const PERIOD_LEVEL_MAP = [
    { test: d => d.includes('senior high') || d === 'shs',  type: 'semester', count: 2 },
    { test: d => d.includes('college'),                      type: 'semester', count: 2 },
    { test: d => d.includes('kinder'),                        type: 'quarter',  count: 4 },
    { test: d => d.includes('preschool'),                     type: 'quarter',  count: 4 },
    { test: d => d.includes('elementary'),                    type: 'quarter',  count: 4 },
    { test: d => d.includes('junior high') || d === 'jhs',   type: 'quarter',  count: 4 },
    { test: d => d.includes('sped'),                          type: 'quarter',  count: 4 },
];
function getPeriodConfigForLevel(rawDept) {
    const d = String(rawDept || '').toLowerCase().trim();
    const match = PERIOD_LEVEL_MAP.find(p => p.test(d));
    const type  = match ? match.type  : 'quarter';
    const count = match ? match.count : 4;
    return { type, count, label: type === 'semester' ? 'SEMESTER' : type === 'trimester' ? 'TRIMESTER' : 'QUARTER' };
}
/* Manual override for the term/quarter grouping (set via the "Term
   Structure" dropdown on the Summary tab). When empty/null, the grouping
   is auto-derived from the selected department/level as before. Format
   of the dropdown value is "type:count", e.g. "semester:2". */
function getPeriodOverrideConfig() {
    const raw = v('f_period_override');
    if (!raw) return null;
    const [type, countStr] = raw.split(':');
    const count = parseInt(countStr, 10);
    if (!type || !count) return null;
    const label = type === 'semester' ? 'SEMESTER' : type === 'trimester' ? 'TRIMESTER' : 'QUARTER';
    return { type, count, label };
}
function handlePeriodOverrideChange() {
    liveUpdate();
    showToast('Term structure updated.', 'fa-layer-group');
}
/* Splits the 11 academic months (Jun–Apr) as evenly as possible into
   `count` consecutive buckets, returning an array of month-counts that
   always sums to 11 (e.g. 4 quarters → [3,3,3,2]; 2 semesters → [6,5]). */
function _splitAcadMonths(count) {
    const total = 11;
    const base = Math.floor(total / count);
    const extra = total % count;
    const parts = [];
    for (let i = 0; i < count; i++) parts.push(base + (i < extra ? 1 : 0));
    return parts;
}
let CURRENT_PERIOD_CONFIG = { type: 'quarter', count: 4, label: 'QUARTER' };
function refreshAcadMonths() {
    const sy1 = parseInt(v('f_sy1'), 10);
    const sy2 = parseInt(v('f_sy2'), 10);
    if (!sy1 || !sy2 || sy2 !== sy1 + 1) return; // guard: require consecutive years
    ACAD_MONTHS = _buildAcadMonths(sy1, sy2);
    // Rebuild TERM_MAP to match the new year range AND the currently
    // selected department/level (Quarters for basic ed, Semesters for
    // SHS/College) — clean reassignment (safe now that TERM_MAP is
    // declared with `let` instead of `const`).
    const periodCfg = getPeriodOverrideConfig() || getPeriodConfigForLevel(v('f_dept'));
    CURRENT_PERIOD_CONFIG = periodCfg;
    const monthCounts = _splitAcadMonths(periodCfg.count);
    const tm = {};
    let idx = 0;
    monthCounts.forEach((numMonths, periodIdx) => {
        for (let i = 0; i < numMonths; i++) {
            const { y, m } = ACAD_MONTHS[idx++];
            tm[`${y}-${m}`] = `${periodCfg.label} ${periodIdx + 1}`;
        }
    });
    TERM_MAP = tm;
    // Reset cpYear/cpMonth to start of new range if out of bounds
    if (!ACAD_MONTHS.find(e => e.y === cpYear && e.m === cpMonth)) {
        cpYear  = ACAD_MONTHS[0].y;
        cpMonth = ACAD_MONTHS[0].m;
    }
}
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];
/* Initial fallback (4-quarter default for Elementary School) — actually
   rebuilt by refreshAcadMonths() as soon as f_sy1/f_sy2/f_dept are read,
   based on the level-aware PERIOD_LEVEL_MAP above. */
let TERM_MAP = {
    '2026-5':'QUARTER 1','2026-6':'QUARTER 1','2026-7':'QUARTER 1',
    '2026-8':'QUARTER 2','2026-9':'QUARTER 2','2026-10':'QUARTER 2',
    '2026-11':'QUARTER 3','2027-0':'QUARTER 3','2027-1':'QUARTER 3',
    '2027-2':'QUARTER 4','2027-3':'QUARTER 4'
};
let cpYear = 2026, cpMonth = 5;
let cpEditingLegendKey = null;
let cpCategoryListVisible = localStorage.getItem('edu_cp_categories_visible') !== '0';
let builderInitialized = false;
let currentCalendarDocumentId = null;
let allCalendarDocs = [];
let savedDocsSearchTerm = '';
let savedDocsStatusFilter = 'all';
let currentActivePage = 'pg-cover';

/* ── Doc-flow navigation state (from enhanced) ── */
const BUILDER_STEPS = [
    { id:1, label:'School Info',  icon:'fa-school',       page:'pg-cover',       desc:'Fill in your school name, ID, and upload your school logo.' },
    { id:2, label:'Letters',      icon:'fa-envelope',     page:'pg-transmittal', desc:'Complete the transmittal letter and letter of intent.' },
    { id:3, label:'Mark Dates',   icon:'fa-calendar-plus',page:null,             desc:'Open the Calendar Picker to mark holidays, activities, and exams.' },
    { id:4, label:'Review',       icon:'fa-table-list',   page:'pg-summary',     desc:'Check the summary table. Total must be 200–220 school days.' },
    { id:5, label:'Submit',       icon:'fa-paper-plane',  page:null,             desc:'Save your final calendar and submit it for approval.' },
];
let currentBuilderStep = 1;
const DOC_FLOW_PAGES = ['pg-cover','pg-transmittal','pg-loi-cover','pg-loi','pg-cal-cover','pg-summary','pg-checklist','pg-monthly'];
let docFlowUnlockedIndex = 0;
let docFlowCurrentIndex = 0;

/* ── Builder lock state ── */
var _builderLocked = false;

/* ══════════════════════════════════════════════════════════════════════════
   CALENDAR UTILS
══════════════════════════════════════════════════════════════════════════ */
function isWeekend(y, m, d) { const dow = (new Date(y, m, d)).getDay(); return dow === 0 || dow === 6; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function mkKey(y, m, d) { return y + '-' + m + '-' + d; }
function parseDateOnly(value) {
    if (!value) return null;
    const d = new Date(String(value) + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? null : d;
}
function getPickerDateBounds() {
    const start = parseDateOnly(v('f_opening'));
    const end   = parseDateOnly(v('f_closing'));
    if (!start || !end || end < start) return { start: null, end: null };
    return { start, end };
}
function monthSerial(year, month) { return year * 12 + month; }
function isDateWithinPickerRange(year, month, day, bounds) {
    if (!bounds?.start || !bounds?.end) return true;
    const d = new Date(year, month, day);
    return d >= bounds.start && d <= bounds.end;
}
function isMonthWithinPickerRange(year, month, bounds) {
    if (!bounds?.start || !bounds?.end) return true;
    const current = monthSerial(year, month);
    const min = monthSerial(bounds.start.getFullYear(), bounds.start.getMonth());
    const max = monthSerial(bounds.end.getFullYear(), bounds.end.getMonth());
    return current >= min && current <= max;
}
function syncPickerMonthToBounds() {
    const bounds = getPickerDateBounds();
    if (!bounds.start || !bounds.end) return;
    const minSerial = monthSerial(bounds.start.getFullYear(), bounds.start.getMonth());
    const maxSerial = monthSerial(bounds.end.getFullYear(), bounds.end.getMonth());
    let currentSerial = monthSerial(cpYear, cpMonth);
    if (currentSerial < minSerial || currentSerial > maxSerial) {
        cpYear = bounds.start.getFullYear();
        cpMonth = bounds.start.getMonth();
    }
    const rangeLabel = document.getElementById('cp_range_label');
    if (rangeLabel) {
        const startTxt = bounds.start.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });
        const endTxt   = bounds.end.toLocaleDateString('en-PH',   { month:'short', day:'numeric', year:'numeric' });
        rangeLabel.textContent = `Editable range: ${startTxt} to ${endTxt}`;
    }
}
function syncPickerBoundInputs() {
    const startMain   = document.getElementById('f_opening');
    const endMain     = document.getElementById('f_closing');
    const startPicker = document.getElementById('cpBoundStart');
    const endPicker   = document.getElementById('cpBoundEnd');
    if (startPicker && startMain) startPicker.value = startMain.value || '';
    if (endPicker   && endMain)   endPicker.value   = endMain.value   || '';
}
function cpUpdateBoundsFromPicker() {
    const startMain   = document.getElementById('f_opening');
    const endMain     = document.getElementById('f_closing');
    const startPicker = document.getElementById('cpBoundStart');
    const endPicker   = document.getElementById('cpBoundEnd');
    if (startMain && startPicker) startMain.value = startPicker.value || '';
    if (endMain   && endPicker)   endMain.value   = endPicker.value   || '';
    liveUpdate();
    syncPickerMonthToBounds();
    buildCpGrid();
}
function schoolDaysInMonth(y, m) {
    const hasSavedMarks = Object.keys(savedMarks).length > 0;
    if (!hasSavedMarks) return 0;
    const bounds = getPickerDateBounds();
    const total  = daysInMonth(y, m);
    let count = 0;
    for (let d = 1; d <= total; d++) {
        if (!isDateWithinPickerRange(y, m, d, bounds)) continue;
        const isWknd = isWeekend(y, m, d);
        const k = mkKey(y, m, d);
        const markKey = savedMarks[k];
        if (!markKey) { if (!isWknd) count++; continue; }
        const legend = legends[markKey];
        const inc = legend ? legend.includeInSchoolDays !== false : true;
        if (inc) count++;
    }
    return count;
}

/* ══════════════════════════════════════════════════════════════════════════
   DOC-FLOW NAVIGATION (from enhanced)
══════════════════════════════════════════════════════════════════════════ */
function getDocFlowIndex(pageId) { return DOC_FLOW_PAGES.indexOf(pageId); }

function syncDocFlowNavLocks() {
    document.querySelectorAll('.dsn-btn').forEach((btn) => {
        const pageId = btn.dataset.page || '';
        // 'Show All Fields' is a view mode, not part of the sequential doc-flow.
        if (pageId === 'all') {
            btn.classList.remove('dsn-locked');
            btn.disabled = false;
            btn.setAttribute('aria-disabled', 'false');
            btn.title = '';
            return;
        }

        const idx = getDocFlowIndex(pageId);
        if (idx < 0) {
            btn.classList.add('dsn-locked'); btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
            btn.title = 'Please follow the page flow.';
            return;
        }
        const locked = idx > docFlowUnlockedIndex;
        btn.classList.toggle('dsn-locked', locked);
        btn.disabled = locked;
        btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
        btn.title = locked ? 'Save current page to continue.' : '';
    });
}
function resetDocFlowNavigation() {
    docFlowUnlockedIndex = 0; docFlowCurrentIndex = 0; syncDocFlowNavLocks();
}
function getTrackedActivePage() {
    if (typeof currentActivePage === 'string' && currentActivePage) return currentActivePage;
    const activePage = document.querySelector('.doc-page.active');
    if (activePage?.id) return activePage.id;
    return DOC_FLOW_PAGES[0];
}
function setTrackedActivePage(pageId) {
    if (!pageId) return;
    try { currentActivePage = pageId; } catch (_) { window.currentActivePage = pageId; }
}
function restoreDocFlowFromActiveTab(pageId) {
    const targetPage = pageId || getTrackedActivePage();
    const idx = getDocFlowIndex(targetPage);
    if (idx < 0) { resetDocFlowNavigation(); return; }
    docFlowUnlockedIndex = idx; docFlowCurrentIndex = idx;
    _switchPageBase(targetPage);
    syncDocFlowNavLocks();
}
function unlockNextDocFlowPage() {
    if (docFlowUnlockedIndex < DOC_FLOW_PAGES.length - 1) docFlowUnlockedIndex += 1;
    syncDocFlowNavLocks();
}

/* ══════════════════════════════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════════════════════════════ */
/* Internal base — does the actual DOM work, no guard checks */
function _switchPageBase(id) {
    currentActivePage = id;
    if (id !== 'all') {
        document.querySelectorAll('.doc-page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById(id);
        if (target) target.classList.add('active');
        // The "Days per Quarter" term-breakdown page (page 7) no longer has
        // its own sidebar entry — it rides along directly underneath the
        // Summary page (page 6) whenever Summary is opened.
        if (id === 'pg-summary') {
            const termPage = document.getElementById('pg-summary-term');
            if (termPage) termPage.classList.add('active');
        }
    }
    document.querySelectorAll('.doc-nav-btn, .dsn-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.page === id);
    });
    const sections = document.querySelectorAll('.form-section[data-tabs], .form-divider[data-tabs]');
    let visibleCount = 0;
    sections.forEach(el => {
        const tabs = el.dataset.tabs.split(' ');
        const show = id === 'all' || tabs.includes('all') || tabs.includes(id);
        el.classList.toggle('fs-hidden', !show);
        if (show && el.classList.contains('form-section')) visibleCount++;
    });
    const allNodes = Array.from(document.querySelectorAll('#formPanel .form-section[data-tabs], #formPanel .form-divider[data-tabs]'));
    for (let i = allNodes.length - 1; i >= 0; i--) {
        const el = allNodes[i];
        if (el.classList.contains('fs-hidden')) continue;
        if (el.classList.contains('form-divider')) { el.classList.add('fs-hidden'); } else { break; }
    }
    const notice = document.getElementById('fsEmptyNotice');
    if (notice) notice.classList.toggle('visible', visibleCount === 0);
}

/* Public switchPage — enforces doc-flow lock, updates sidebar nav, auto-opens picker on Summary */
function switchPage(id) {
    const idx = getDocFlowIndex(id);
    if (idx >= 0 && idx > docFlowUnlockedIndex) {
        showToast('Please save this page first before opening the next one.', 'fa-lock');
        syncDocFlowNavLocks();
        return;
    }
    _switchPageBase(id);
    if (idx >= 0) docFlowCurrentIndex = idx;
    syncDocFlowNavLocks();
    if (id === 'pg-summary' && typeof openCalPicker === 'function') {
        setTimeout(openCalPicker, 150);
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   LOGO UPLOAD
══════════════════════════════════════════════════════════════════════════ */
let _logoUploading = false;
function handleLogo(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (_logoUploading) return;
    _logoUploading = true;
    // Reset the input immediately so the same file can re-trigger a change event later if needed,
    // and so that this handler cannot fire a second time for the same interaction.
    e.target.value = '';
    if (file.size > 2 * 1024 * 1024) {
        _logoUploading = false;
        showToast('Logo is too large. Please use an image under 2MB.', 'fa-triangle-exclamation');
        return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
        logoDataUrl = ev.target.result;
        applyCalendarLogo(logoDataUrl);
        try { localStorage.setItem('edu_school_logo', logoDataUrl); } catch (_) {}
        try {
            const res = await fetch(`${API_BASE}/update-school-logo.php`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ logo_data_url: logoDataUrl }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.message || 'Failed to save logo.');
            showToast('School logo saved!', 'fa-image');
        } catch (err) {
            showToast('Logo applied locally but could not save to server: ' + err.message, 'fa-triangle-exclamation');
        } finally {
            // Release the guard only after the async server call finishes,
            // not at onloadend which fires before the fetch completes.
            _logoUploading = false;
        }
    };
    reader.onerror = () => {
        _logoUploading = false;
        showToast('Failed to read the selected image file.', 'fa-triangle-exclamation');
    };
    reader.readAsDataURL(file);
}
function applyCalendarLogo(dataUrl) {
    const preview = document.getElementById('logoPreview');
    const icon    = document.getElementById('logoIcon');
    if (!dataUrl) {
        if (preview) preview.style.display = 'none';
        if (icon)    icon.style.display = 'block';
        for (let i = 1; i <= 10; i++) {
            const img = document.getElementById('lhLogo' + i);
            const ph  = document.getElementById('lhLogoPlaceholder' + i);
            if (img) img.style.display = 'none';
            if (ph)  ph.style.display = 'flex';
        }
        return;
    }
    if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
    if (icon) icon.style.display = 'none';
    for (let i = 1; i <= 10; i++) {
        const img = document.getElementById('lhLogo' + i);
        const ph  = document.getElementById('lhLogoPlaceholder' + i);
        if (img && ph) { img.src = dataUrl; img.style.display = 'block'; ph.style.display = 'none'; }
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE UPDATE
══════════════════════════════════════════════════════════════════════════ */
function fmtDate(d) {
    if (!d) return '— — —';
    const dt = new Date(d + 'T00:00');
    return dt.toLocaleDateString('en-PH', { day:'2-digit', month:'short', year:'numeric' }).toUpperCase();
}
function getTransmittalThruValues() {
    return {
        name: v('f_loi_thru_name') || v('f_sds_name') || '',
        pos: v('f_loi_thru_pos') || v('f_sds_pos') || '',
        org1: v('f_loi_thru_org1') || v('f_sds_office') || '',
        org2: v('f_loi_thru_org2') || v('f_sds_city') || '',
    };
}
function liveUpdate() {
    refreshAcadMonths(); // keep ACAD_MONTHS in sync with f_sy1/f_sy2 — Issue 1
    _markFormDirty();    // track unsaved changes — UX Issue B
    const school = v('f_school'), dept = v('f_dept'), sid = v('f_sid'), gov = v('f_gov');
    const sy1 = v('f_sy1') || '20__', sy2 = v('f_sy2') || '20__';
    const syStr = sy1 + '–' + sy2;
    const meta = `School ID: ${sid}   ${gov}`;
    const cpSyLabel = document.getElementById('cp_sy_label');
    if (cpSyLabel) cpSyLabel.textContent = syStr;
    for (let i = 1; i <= 10; i++) {
        setText('pv_school' + i, school, 'pv_school');
        setText('pv_dept' + i, dept, 'pv_dept');
        setText('pv_meta' + i, meta, 'pv_meta');
    }
    setText('pv_school', school); setText('pv_dept', dept); setText('pv_meta', meta);
    const deptShort = dept.replace(' School', '');
    const pvCoverDept = document.getElementById('pv_cover_dept');
    if (pvCoverDept) pvCoverDept.innerHTML = deptShort + '<br>School Calendar';
    const pvCoverSy = document.getElementById('pv_cover_sy');
    if (pvCoverSy) pvCoverSy.textContent = 'S.Y. ' + syStr;
    const pvRcvBy = document.getElementById('pv_rcvby'), pvRcvCtrl = document.getElementById('pv_rcvctrl');
    if (pvRcvBy) pvRcvBy.textContent = v('f_rcvby') || '___________';
    if (pvRcvCtrl) pvRcvCtrl.textContent = v('f_rcvctrl') || '___________';
    const rdName = v('f_rd_name'), rdPos = v('f_rd_pos'), rdOfc = v('f_rd_office');
    setText('pv_rd_name', rdName); setText('pv_rd_pos', rdPos); setText('pv_rd_office', rdOfc);
    setText('pv_rd_name2', rdName); setText('pv_rd_pos2', rdPos); setText('pv_rd_office2', rdOfc);
    const sdsName = v('f_sds_name'), sdsPos = v('f_sds_pos'), sdsOfc = v('f_sds_office'), sdsCity = v('f_sds_city');
    setText('pv_sds_name', sdsName); setText('pv_sds_pos', sdsPos); setText('pv_sds_office', sdsOfc); setText('pv_sds_city', sdsCity);
    setText('pv_sds_name2', sdsName); setText('pv_sds_pos2', sdsPos); setText('pv_sds_office2', sdsOfc); setText('pv_sds_city2', sdsCity);
    setText('pv_sy_ltr', syStr);
    setText('pv_sy_ltr2', syStr);
    const attachedEl = document.getElementById('f_attached');
    if (attachedEl) {
        const updated = attachedEl.value.replace(/S\.Y\.\s*\d{4}-\d{4}/g, 'S.Y. ' + sy1 + '-' + sy2);
        if (updated !== attachedEl.value) attachedEl.value = updated;
    }
    const attached = v('f_attached').split('\n').filter(s => s.trim());
    const listEl = document.getElementById('pv_attached_list');
    if (listEl) listEl.innerHTML = attached.map(a => `<li>${a}</li>`).join('');
    setText('pv_chk_school', v('f_chk_school')); setText('pv_chk_address', v('f_chk_address'));
    setText('pv_chk_school_id', v('f_chk_school_id')); setText('pv_chk_proposed', v('f_chk_proposed'));
    setText('pv_chk_checked_by', v('f_chk_checked_by'));
    // Checklist requirements: the Letter of Intent and Calendar of
    // Activities rows are hardcoded (see CHK_HARDCODED_ITEMS) since this
    // builder generates those pages itself; everything else comes from
    // Settings → Supporting Docs and shows real upload status.
    const chkTbody = document.getElementById('pv_chk_items_tbody');
    if (chkTbody) {
        const items = getChecklistDisplayItems();
        chkTbody.innerHTML = items.map((item, idx) => {
            const remarkText = getChecklistRemarkText(item);
            const isSatisfied = !!item.remark || !!chkUploads[item.slug];
            const remarkCls = isSatisfied ? 'chk-remark chk-remark-auto' : 'chk-remark';
            return `<tr>
                <td>${idx + 1}.</td>
                <td>${_escHtmlSig(item.label)}</td>
                <td><span class="${remarkCls}">${_escHtmlSig(remarkText)}</span></td>
            </tr>`;
        }).join('');
    }
    setText('pv_loi_date', v('f_loi_date')); setText('pv_loi_to_name', v('f_loi_to_name'));
    setText('pv_loi_to_pos', v('f_loi_to_pos')); setText('pv_loi_to_org1', v('f_loi_to_org1'));
    setText('pv_loi_to_org2', v('f_loi_to_org2')); setText('pv_loi_to_org3', v('f_loi_to_org3'));
    const thruValues = getTransmittalThruValues();
    setText('pv_loi_thru_name', thruValues.name);
    setText('pv_loi_thru_pos', thruValues.pos);
    setText('pv_loi_thru_org1', thruValues.org1);
    setText('pv_loi_thru_org2', thruValues.org2);
    setText('pv_loi_salutation', v('f_loi_salutation'));
    setText('pv_loi_greeting', v('f_loi_greeting')); setText('pv_loi_complclose', v('f_loi_complclose'));
    const openingRaw = v('f_opening');
    const openingFormatted = openingRaw
        ? new Date(openingRaw + 'T00:00').toLocaleDateString('en-PH', { month:'long', day:'numeric', year:'numeric' })
        : 'the opening date';
    const closingRaw = v('f_closing');
    const closingFormatted = closingRaw
        ? new Date(closingRaw + 'T00:00').toLocaleDateString('en-PH', { month:'long', day:'numeric', year:'numeric' })
        : 'the closing date';
    setText('pv_trans_opening', openingFormatted);
    setText('pv_trans_closing', closingFormatted);
    const totalDays = computeGrandTotal();
    setText('pv_trans_total_days', totalDays ? String(totalDays) : '—');
    const loiP1El = document.getElementById('f_loi_p1');
    if (loiP1El) {
        const updatedP1 = loiP1El.value
            .replace(/reopening of classes on [A-Za-z]+ \d{1,2},? \d{4}\./, 'reopening of classes on ' + openingFormatted + '.')
            .replace(/School Year \d{4}-\d{4}/, 'School Year ' + sy1 + '-' + sy2);
        if (updatedP1 !== loiP1El.value) loiP1El.value = updatedP1;
    }
    setText('pv_loi_p1', v('f_loi_p1')); setText('pv_loi_p2', v('f_loi_p2')); setText('pv_loi_closing', v('f_loi_closing'));
    const pvCalCoverTitle = document.getElementById('pv_cal_cover_title');
    if (pvCalCoverTitle) pvCalCoverTitle.innerHTML = 'School Calendar<br>for';
    const pvCalCoverSy = document.getElementById('pv_cal_cover_sy');
    if (pvCalCoverSy) pvCalCoverSy.textContent = 'S.Y. ' + syStr;
    const prin = v('f_principal'), prinTitle = v('f_principal_title');
    const prinContact = v('f_principal_contact');
    const rec = v('f_recommending'), recPos = v('f_rec_pos'), recOrg = v('f_rec_org');
    const app = v('f_approved'), appPos = v('f_app_pos'), appOrg = v('f_app_org');
    const appOrg2 = v('f_app_org2'), appOrg3 = v('f_app_org3'), appOrg4 = v('f_app_org4');
    ['pv_principal','pv_sum_principal','pv_sum_principal2','pv_sum_principal3','pv_sum_principal7'].forEach(id => setText(id, prin));
    ['pv_principal_title','pv_sum_principal_title','pv_sum_principal_title2','pv_sum_principal_title3','pv_sum_principal_title7'].forEach(id => setText(id, prinTitle));
    setText('pv_principal2', prin); setText('pv_principal_title2', prinTitle);
    ['pv_principal_contact','pv_principal_contact2'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = prinContact;
        el.style.display = prinContact ? 'block' : 'none';
    });
    ['pv_recommending','pv_recommending2','pv_recommending3','pv_recommending7'].forEach(id => setText(id, rec));
    ['pv_rec_pos','pv_rec_pos2','pv_rec_pos3','pv_rec_pos7'].forEach(id => setText(id, recPos));
    ['pv_rec_org','pv_rec_org2','pv_rec_org3','pv_rec_org7'].forEach(id => setText(id, recOrg));
    ['pv_approved','pv_approved2','pv_approved3','pv_approved7'].forEach(id => setText(id, app));
    ['pv_app_pos','pv_app_pos2','pv_app_pos3','pv_app_pos7'].forEach(id => setText(id, appPos));
    ['pv_app_org','pv_app_org2','pv_app_org3','pv_app_org7'].forEach(id => setText(id, appOrg));
    ['pv_app_org_line2','pv_app_org2_line2'].forEach(id => setText(id, appOrg2));
    ['pv_app_org_line3','pv_app_org2_line3'].forEach(id => setText(id, appOrg3));
    ['pv_app_org_line4','pv_app_org2_line4'].forEach(id => setText(id, appOrg4));
    const dept6 = dept.replace(/\s*School\s*$/i, '').toUpperCase();
    const heading = dept6 + ' SCHOOL CALENDAR<br>FOR SCHOOL YEAR ' + sy1 + '–' + sy2;
    const pvSumHeading = document.getElementById('pv_sum_heading');
    const pvSumHeading2 = document.getElementById('pv_sum_heading2');
    if (pvSumHeading) pvSumHeading.innerHTML = heading;
    if (pvSumHeading2) pvSumHeading2.innerHTML = heading;
    const pvMH1 = document.getElementById('pv_monthly_heading_1');
    const pvMH2 = document.getElementById('pv_monthly_heading_2');
    if (pvMH1) pvMH1.textContent = 'SCHOOL CALENDAR FOR SCHOOL YEAR ' + sy1 + '–' + sy2;
    if (pvMH2) pvMH2.textContent = 'SCHOOL CALENDAR FOR SCHOOL YEAR ' + sy1 + '–' + sy2;
    buildSummaryTables();
    buildMonthlyGrid();
    renderBuilderStepper();
    renderMonthHealthPanel();
}

/* ══════════════════════════════════════════════════════════════════════════
   BUILDER STEPPER (from enhanced)
══════════════════════════════════════════════════════════════════════════ */
function computeGrandTotal() {
    return ACAD_MONTHS.reduce((sum, { y, m }) => sum + schoolDaysInMonth(y, m), 0);
}
function renderBuilderStepper() {
    let el = document.getElementById('calBuilderStepper');
    if (!el) {
        el = document.createElement('div');
        el.id = 'calBuilderStepper';
        el.className = 'cal-stepper';
        const topBar = document.querySelector('.top-bar');
        if (topBar && topBar.parentNode) topBar.parentNode.insertBefore(el, topBar.nextSibling);
    }
    const grand = computeGrandTotal();
    const isValid = grand >= 200 && grand <= 220;
    el.innerHTML = `<div class="cal-stepper-inner">${BUILDER_STEPS.map(step => {
        const done = currentBuilderStep > step.id;
        const active = currentBuilderStep === step.id;
        const cls = done ? 'cs-done' : active ? 'cs-active' : '';
        return `<div class="cs-step ${cls}" onclick="goToBuilderStep(${step.id})" title="${step.desc}">
            <div class="cs-bubble">${done ? '<i class="fa-solid fa-check"></i>' : `<i class="fa-solid ${step.icon}"></i>`}</div>
            <div class="cs-label">${step.label}</div>
        </div>${step.id < BUILDER_STEPS.length ? '<div class="cs-line' + (done ? ' cs-line-done' : '') + '"></div>' : ''}`;
    }).join('')}</div>`;
    let subBar = document.getElementById('calStepperSubBar');
    if (!subBar) {
        subBar = document.createElement('div');
        subBar.id = 'calStepperSubBar';
        subBar.className = 'cal-stepper-subbar';
        el.parentNode.insertBefore(subBar, el.nextSibling);
    }
    subBar.innerHTML = `<div class="cs-hint">${BUILDER_STEPS[currentBuilderStep - 1]?.desc || ''}</div>
        ${grand > 0 ? `<div class="cs-days-badge ${isValid ? 'cs-days-ok' : 'cs-days-warn'}">
            <i class="fa-solid ${isValid ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            Total school days: <strong>${grand}</strong>
            ${isValid ? '✓ Within 200–220' : grand < 200 ? '— Below minimum 200' : '— Exceeds maximum 220'}
        </div>` : ''}`;
}
function goToBuilderStep(stepId) {
    currentBuilderStep = stepId;
    const step = BUILDER_STEPS.find(s => s.id === stepId);
    if (step && step.page) switchPage(step.page);
    else if (stepId === 3) openCalPicker();
    else if (stepId === 5) showFinalSubmitDialog();
    renderBuilderStepper();
}
function advanceBuilderStep() {
    if (currentBuilderStep < BUILDER_STEPS.length) { currentBuilderStep++; renderBuilderStepper(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   HEALTH PANEL (from enhanced)
══════════════════════════════════════════════════════════════════════════ */
function getMonthHealthReport() {
    const hasSaved = Object.keys(savedMarks).length > 0;
    if (!hasSaved) return [];
    return ACAD_MONTHS.map(({ y, m }) => {
        const sd = schoolDaysInMonth(y, m);
        const totalDays = daysInMonth(y, m);
        const firstDow = new Date(y, m, 1).getDay();
        const weekdays = totalDays - Math.floor((totalDays + firstDow) / 7) * 2
            - ([0, 6].includes(firstDow) ? 1 : 0);
        const status = sd < 15 ? 'low' : sd > 27 ? 'high' : 'ok';
        return { y, m, name: MONTH_NAMES[m], sd, status };
    });
}
function renderMonthHealthPanel() {
    let panel = document.getElementById('calHealthPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'calHealthPanel';
        panel.className = 'cal-health-panel';
        const statusEl = document.getElementById('pv_days_status');
        if (statusEl && statusEl.parentNode) statusEl.parentNode.insertBefore(panel, statusEl.nextSibling);
    }
    const report = getMonthHealthReport();
    if (!report.length) { panel.innerHTML = ''; return; }
    const issues = report.filter(r => r.status !== 'ok');
    if (!issues.length) {
        panel.innerHTML = `<div class="chp-all-ok"><i class="fa-solid fa-circle-check"></i> All months look healthy.</div>`;
        return;
    }
    panel.innerHTML = `<div class="chp-title"><i class="fa-solid fa-triangle-exclamation"></i> Month Issues</div>
        ${issues.map(r => `<div class="chp-row chp-${r.status}">
            <span class="chp-month">${r.name}</span>
            <span class="chp-days">${r.sd} days</span>
            <span class="chp-msg">${r.status === 'low' ? 'Too few school days' : 'Many school days'}</span>
        </div>`).join('')}
        <div class="chp-tip">Use the Calendar Picker to adjust holidays and activities for flagged months.</div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   SUMMARY TABLES
══════════════════════════════════════════════════════════════════════════ */
function buildSummaryTables() {
    const simple = document.getElementById('pv_sum_simple');
    const term   = document.getElementById('pv_sum_term_page');
    const termHeading = document.getElementById('pv_sum_heading7');
    if (!simple) return;
    let simplRows = '', grandTotal = 0;
    const termTotals = {}; // keyed by period label, e.g. "QUARTER 1"
    ACAD_MONTHS.forEach(({ y, m }) => {
        const sd = schoolDaysInMonth(y, m);
        grandTotal += sd;
        simplRows += `<tr><td>${MONTH_NAMES[m]}</td><td>${sd}</td></tr>`;
        const tk = y + '-' + m;
        const tLabel = TERM_MAP[tk] || `${CURRENT_PERIOD_CONFIG.label} 1`;
        termTotals[tLabel] = (termTotals[tLabel] || 0) + sd;
    });
    const totalColor = grandTotal === 0 ? '' : grandTotal < 200 ? 'color:#ef4444;' : grandTotal <= 220 ? 'color:#22c55e;' : 'color:#f59e0b;';
    const totalIcon  = grandTotal === 0 ? '' : grandTotal < 200 ? ' ⚠ Below minimum' : grandTotal <= 220 ? ' ✓' : ' ⚠ Above maximum';
    simplRows += `<tr class="total-row"><td>TOTAL${totalIcon}</td><td style="${totalColor}font-weight:900;">${grandTotal}</td></tr>`;
    simple.innerHTML = simplRows;
    if (termHeading) {
        const srcHeading = document.getElementById('pv_sum_heading');
        if (srcHeading) termHeading.innerHTML = srcHeading.innerHTML;
    }
    if (term) {
        let prevTerm = '', termRowsArr = [];
        ACAD_MONTHS.forEach(({ y, m }) => {
            const sd = schoolDaysInMonth(y, m);
            const tk = y + '-' + m, tLabel = TERM_MAP[tk] || `${CURRENT_PERIOD_CONFIG.label} 1`;
            if (tLabel !== prevTerm) { termRowsArr.push(`<tr class="term-hdr"><td colspan="2">${tLabel}</td></tr>`); prevTerm = tLabel; }
            termRowsArr.push(`<tr><td>${MONTH_NAMES[m]}</td><td>${sd}</td></tr>`);
            const nextIdx = ACAD_MONTHS.findIndex(a => a.y === y && a.m === m) + 1;
            const nextTk = nextIdx < ACAD_MONTHS.length ? ACAD_MONTHS[nextIdx].y + '-' + ACAD_MONTHS[nextIdx].m : null;
            const nextTLabel = nextTk ? (TERM_MAP[nextTk] || tLabel) : null;
            if (!nextTLabel || nextTLabel !== tLabel) {
                termRowsArr.push(`<tr class="sub-total"><td>TOTAL</td><td>${termTotals[tLabel] || 0}</td></tr>`);
            }
        });
        termRowsArr.push(`<tr class="total-row"><td>TOTAL${totalIcon}</td><td style="${totalColor}font-weight:900;">${grandTotal}</td></tr>`);
        term.innerHTML = termRowsArr.join('');
    }
    const statusEl = document.getElementById('pv_days_status');
    if (statusEl) {
        const hasSaved = Object.keys(savedMarks).length > 0;
        if (!hasSaved) {
            statusEl.style.cssText = 'background:#f1f5f9;color:#64748b;border-color:#e2e8f0;';
            statusEl.innerHTML = 'Use the Calendar Picker and click "Save &amp; Apply" to compute school days.';
        } else if (grandTotal < 200) {
            statusEl.style.cssText = 'background:#fef2f2;color:#dc2626;border-color:#fca5a5;';
            statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Total: <strong>${grandTotal} days</strong> — Below minimum of <strong>200 days</strong>. Add more school days.`;
        } else if (grandTotal <= 220) {
            statusEl.style.cssText = 'background:#f0fdf4;color:#16a34a;border-color:#86efac;';
            statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Total: <strong>${grandTotal} days</strong> — Within the required range (200–220 days). ✓`;
        } else {
            statusEl.style.cssText = 'background:#fffbeb;color:#d97706;border-color:#fcd34d;';
            statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Total: <strong>${grandTotal} days</strong> — Exceeds maximum of <strong>220 days</strong>. Mark more holidays.`;
        }
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   MONTHLY GRID
══════════════════════════════════════════════════════════════════════════ */
function buildMonthlyGrid() {
    const container1 = document.getElementById('pv_monthly_grid_1');
    const container2 = document.getElementById('pv_monthly_grid_2');
    if (!container1 && !container2) return;
    const openingRaw = document.getElementById('f_opening')?.value || '';
    let openingYear = null, openingMonth = null, openingDay = null;
    if (openingRaw) {
        const op = new Date(openingRaw + 'T00:00');
        openingYear = op.getFullYear(); openingMonth = op.getMonth(); openingDay = op.getDate();
    }
    const closingRaw = document.getElementById('f_closing')?.value || '';
    let closingYear = null, closingMonth = null, closingDay = null;
    if (closingRaw) {
        const cl = new Date(closingRaw + 'T00:00');
        closingYear = cl.getFullYear(); closingMonth = cl.getMonth(); closingDay = cl.getDate();
    }
    const sameStartEnd = openingYear === closingYear
        && openingMonth === closingMonth
        && openingDay === closingDay
        && openingDay !== null;
    const renderMonthlyHtml = (months) => {
        let html = '';
        months.forEach(({ y, m }) => {
            const mName = MONTH_NAMES[m].toUpperCase();
            const totalDays = daysInMonth(y, m);
            const firstDow = new Date(y, m, 1).getDay();
            const sd = schoolDaysInMonth(y, m);
            const isOpeningMonth = (openingYear === y && openingMonth === m);
            const isClosingMonth = (closingYear === y && closingMonth === m);
            let calHtml = `<div class="mini-cal-header">${MONTH_NAMES[m]}</div>`;
            calHtml += `<table class="mini-cal"><thead><tr>`;
            DAY_SHORT.forEach(d => calHtml += `<th class="${d==='Su'?'sun':d==='Sa'?'sat':''}">${d}</th>`);
            calHtml += `</tr></thead><tbody><tr>`;
            let cellCount = 0;
            for (let i = 0; i < firstDow; i++) { calHtml += `<td></td>`; cellCount++; }
            for (let d = 1; d <= totalDays; d++) {
                if (cellCount % 7 === 0 && cellCount > 0) calHtml += `</tr><tr>`;
                const dow = new Date(y, m, d).getDay();
                const isWknd = dow === 0 || dow === 6;
                const k = mkKey(y, m, d);
                const mark = marks[k];
                const isStartDay = isOpeningMonth && d === openingDay;
                const isEndDay = isClosingMonth && d === closingDay;
                let cls = isWknd ? (dow === 0 ? 'sun' : 'sat') : '';
                if (isStartDay) cls += ' start-day';
                if (isEndDay) cls += ' end-day';
                if (isStartDay && isEndDay) cls += ' start-end-day';
                let content = d;
                if (mark === 'holiday') { cls += ' holiday-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="1" x2="17" y2="17" stroke="currentColor" stroke-width="1.5"/><line x1="17" y1="1" x2="1" y2="17" stroke="currentColor" stroke-width="1.5"/><text x="9" y="12" text-anchor="middle" font-size="8" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                else if (mark === 'activity') { cls += ' activity-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="9" y="12" text-anchor="middle" font-size="8" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                else if (mark === 'exam')     { cls += ' exam-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><polygon points="9,1 17,17 1,17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><text x="9" y="15" text-anchor="middle" font-size="7" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                else if (mark && legends[mark]) {
                    /* Custom user-created legend category — apply its own
                       color as a filled pill behind the day number, so the
                       preview calendar box itself reflects the chosen color
                       (not just the activity list below). */
                    const customLeg = legends[mark];
                    const customColor = customLeg.color || '#64748b';
                    cls += ' custom-mark-day';
                    content = `<span class="custom-mark-pill" style="background:${customColor};" title="${(customLeg.label||mark).replace(/"/g,'&quot;')}">${d}</span>`;
                }
                calHtml += `<td class="${cls}">${content}</td>`;
                cellCount++;
            }
            const remainder = 7 - (cellCount % 7);
            if (remainder < 7) for (let i = 0; i < remainder; i++) calHtml += `<td></td>`;
            calHtml += `</tr></tbody></table><div class="class-days-row">Class days: ${sd}</div>`;
            let actHtml = `<div class="month-name">${mName}</div><ul class="activity-list">`;
            const monthMarks = Object.entries(marks).filter(([k]) => {
                const [ky, km] = k.split('-').map(Number); return ky === y && km === m;
            }).sort((a, b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));
            const monthNoteOnly = Object.entries(savedRemarks).filter(([k]) => {
                const [ky, km] = k.split('-').map(Number); return ky === y && km === m && !savedMarks[k];
            }).map(([k]) => [k, '__note_only__']);
            let combined = [...monthMarks, ...monthNoteOnly];
            if (sameStartEnd && isOpeningMonth && openingDay) {
                combined.push([mkKey(openingYear, openingMonth, openingDay), '__start_end__']);
            } else {
                if (isOpeningMonth && openingDay) {
                    combined.push([mkKey(openingYear, openingMonth, openingDay), '__start__']);
                }
                if (isClosingMonth && closingDay) {
                    combined.push([mkKey(closingYear, closingMonth, closingDay), '__end__']);
                }
            }
            if (combined.length > 0) {
                combined.sort((a, b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));
            }
            if (combined.length === 0) {
                actHtml += `<li><span class="act-date" style="color:#94a3b8;">—</span> <span style="color:#94a3b8;">No activities marked</span></li>`;
            } else {
                const grouped = [];
                combined.forEach(([k, type]) => {
                    const day = parseInt(k.split('-')[2], 10);
                    const remark = savedRemarks[k] || '';
                    const last = grouped[grouped.length - 1];
                    const canMerge = !!last && last.type === type && last.remark === remark && day === last.endDay + 1 && type !== '__start__';
                    if (canMerge) { last.endDay = day; return; }
                    grouped.push({ type, remark, startDay: day, endDay: day });
                });
                grouped.forEach((entry) => {
                    const dayLabel = entry.startDay === entry.endDay ? String(entry.startDay) : `${entry.startDay}-${entry.endDay}`;
                    if (entry.type === '__start_end__') {
                        actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:13px;border-radius:6px;background:#0a1f3d;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;letter-spacing:.5px;padding:0 5px;">START/END</span> <strong>Start and End of Classes</strong></li>`; return;
                    }
                    if (entry.type === '__start__') {
                        actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#0a1f3d;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;">★</span> <strong>Start of Classes</strong></li>`; return;
                    }
                    if (entry.type === '__end__') {
                        actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:13px;border-radius:6px;background:#991b1b;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;letter-spacing:.5px;padding:0 5px;">END</span> <strong>End of Classes</strong></li>`; return;
                    }
                    if (entry.type === '__note_only__') {
                        const rmk = entry.remark ? ` — <em style="color:#475569;">${entry.remark}</em>` : '';
                        actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#0f172a;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;">✎</span> <strong>Note</strong>${rmk}</li>`; return;
                    }
                    const leg = legends[entry.type] || { label: entry.type, symbol: '●', color: '#64748b' };
                    if (entry.remark) {
                        actHtml += `<li><span class="act-date">${dayLabel}</span> <strong>${entry.remark}</strong></li>`;
                        return;
                    }
                    actHtml += `<li><span class="act-date">${dayLabel}</span> ${legendSymbolSvg(entry.type, leg.color || '#64748b', 12)} ${leg.label}</li>`;
                });
            }
            actHtml += `</ul>`;
            html += `<div class="month-block"><div class="mb-left">${actHtml}</div><div class="mb-right">${calHtml}</div></div>`;
        });
        return html;
    };
    if (container1) container1.innerHTML = renderMonthlyHtml(ACAD_MONTHS.slice(0, 6));
    if (container2) container2.innerHTML = renderMonthlyHtml(ACAD_MONTHS.slice(6));
    renderCustomLegendItems();
}

/* Populate the "Legend:" box on the monthly preview page with any
   custom categories the user created in the Calendar Picker (the 5
   built-in ones — Holiday / Activity / Exam / Start / End — are already
   hard-coded in the markup, so only non-default legends are injected
   here). Each entry shows the same color swatch used for that
   category's day boxes, so the legend always matches what's on the
   calendar. */
function renderCustomLegendItems() {
    const host = document.getElementById('pv_legend_custom');
    if (!host) return;
    const customKeys = Object.keys(legends).filter(k => !DEFAULT_LEGENDS[k]);
    if (!customKeys.length) { host.innerHTML = ''; return; }
    host.innerHTML = customKeys.map(key => {
        const leg = legends[key];
        const color = leg.color || '#64748b';
        const label = leg.label || key;
        return `<div class="legend-item"><span class="custom-mark-pill custom-mark-pill-sm" style="background:${color};"></span><span>— ${label}</span></div>`;
    }).join('');
}


/* ══════════════════════════════════════════════════════════════════════════
   CALENDAR PICKER
══════════════════════════════════════════════════════════════════════════ */
function openCalPicker() {
    if (_builderLocked) {
        showToast('This calendar is locked. Request edit approval first.', 'fa-lock');
        return;
    }
    document.getElementById('cpOverlay').classList.add('open');
    closeCpAddCategoryModal();
    syncPickerBoundInputs();
    syncPickerMonthToBounds();
    applyCpCategoryListVisibility();
    buildCpModes();
    buildCpGrid();
    if (!_legendsLoaded) {
        loadCalendarLegends().then(() => { buildCpModes(); buildCpGrid(); liveUpdate(); });
    }
}
function closeCalPicker() {
    document.getElementById('cpOverlay').classList.remove('open');
    closeCpAddCategoryModal();
    document.getElementById('cpEligibilityBanner')?.remove();
}
function openCpAddCategoryModal() {
    const overlay = document.getElementById('cpAddCatOverlay');
    if (!overlay) return;
    cpEditingLegendKey = null;
    const title = document.getElementById('cp_addcat_title');
    const submitBtn = document.getElementById('cp_addcat_submit');
    const nameInput = document.getElementById('cp_custom_name');
    const colorInput = document.getElementById('cp_custom_color');
    if (title) title.innerHTML = '<i class="fa-solid fa-plus"></i> Add Custom Category';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Category';
    if (nameInput) nameInput.value = '';
    if (colorInput) colorInput.value = '#7c3aed';
    overlay.classList.add('open');
    setTimeout(() => document.getElementById('cp_custom_name')?.focus(), 100);
    const countsToggle = document.getElementById('cp_custom_counts_schoolday');
    if (countsToggle) countsToggle.checked = true;
}
function closeCpAddCategoryModal(event) {
    if (event && event.target && event.target.id !== 'cpAddCatOverlay') return;
    document.getElementById('cpAddCatOverlay')?.classList.remove('open');
    cpEditingLegendKey = null;
}
function applyCpCategoryListVisibility() {
    const body = document.querySelector('.cp-body');
    const toggleBtn = document.getElementById('cpToggleCategoriesBtn');
    if (!body) return;
    body.classList.toggle('cp-categories-hidden', !cpCategoryListVisible);
    if (toggleBtn) {
        toggleBtn.innerHTML = cpCategoryListVisible
            ? '<i class="fa-solid fa-list"></i> Hide Categories'
            : '<i class="fa-solid fa-list"></i> Show Categories';
    }
}
function cpToggleCategoryList() {
    cpCategoryListVisible = !cpCategoryListVisible;
    localStorage.setItem('edu_cp_categories_visible', cpCategoryListVisible ? '1' : '0');
    applyCpCategoryListVisibility();
}
function openCpEditCategoryModal(key, event) {
    if (event) event.stopPropagation();
    const legend = legends[key];
    const overlay = document.getElementById('cpAddCatOverlay');
    if (!overlay || !legend) return;
    cpEditingLegendKey = key;
    const title = document.getElementById('cp_addcat_title');
    const submitBtn = document.getElementById('cp_addcat_submit');
    const nameInput = document.getElementById('cp_custom_name');
    const colorInput = document.getElementById('cp_custom_color');
    const countsToggle = document.getElementById('cp_custom_counts_schoolday');
    if (title) title.innerHTML = '<i class="fa-solid fa-pen"></i> Edit Category';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    if (nameInput) nameInput.value = legend.label || key;
    if (colorInput) colorInput.value = legend.color || '#64748b';
    if (countsToggle) countsToggle.checked = legend.includeInSchoolDays !== false;
    overlay.classList.add('open');
    setTimeout(() => { nameInput?.focus(); nameInput?.select(); }, 40);
}
function buildCpModes() {
    const container = document.getElementById('cp_modes');
    if (!container) return;
    container.innerHTML = '';
    const noteOnlyCount = Object.keys(remarks).filter(k => !marks[k]).length;
    const noteBtn = document.createElement('button');
    noteBtn.className = 'cp-mode-btn' + (cpSelected === CP_NOTE_ONLY_KEY ? ' sel' : '');
    noteBtn.style.setProperty('--mc', '#0f172a');
    noteBtn.innerHTML = `<span class="cp-dot" style="background:#0f172a">✎</span>Note Only<span class="cp-count">${noteOnlyCount}</span>`;
    noteBtn.onclick = () => { cpSelected = CP_NOTE_ONLY_KEY; buildCpModes(); };
    container.appendChild(noteBtn);
    Object.entries(legends).forEach(([key, leg]) => {
        const count = Object.values(marks).filter(v => v === key).length;
        const isSel = cpSelected === key;
        const isDefaultLegend = !!DEFAULT_LEGENDS[key];
        const includeChecked = leg.includeInSchoolDays !== false ? 'checked' : '';
        const btn = document.createElement('button');
        btn.className = 'cp-mode-btn' + (isSel ? ' sel' : '');
        btn.style.setProperty('--mc', leg.color);
        btn.innerHTML = `<span class="cp-mode-main"><span class="cp-dot" style="background:${leg.color}">${leg.symbol || '●'}</span>${leg.label}<span class="cp-count">${count}</span></span><label class="cp-day-toggle" title="Include this legend in total school days"><input type="checkbox" ${includeChecked} onclick="cpToggleLegendSchoolDay('${key}', this.checked, event)"><span>School day</span></label><span class="cp-legend-actions"><button type="button" class="cp-legend-action" onclick="cpEditLegend('${key}', event)" title="Edit category"><i class="fa-solid fa-pen"></i></button><button type="button" class="cp-legend-action cp-legend-action-danger" onclick="cpDeleteLegend('${key}', event)" title="Delete category" ${isDefaultLegend ? 'disabled' : ''}><i class="fa-solid fa-trash"></i></button></span>`;
        btn.onclick = () => { cpSelected = key; buildCpModes(); };
        container.appendChild(btn);
    });
}
function cpEditLegend(key, event) { openCpEditCategoryModal(key, event); }
async function cpDeleteLegend(key, event) {
    if (event) event.stopPropagation();
    if (DEFAULT_LEGENDS[key]) { showToast('Default categories cannot be deleted.', 'fa-lock'); return; }
    if (!legends[key]) return;
    const hasMarks = Object.values(marks).some(v => v === key) || Object.values(savedMarks).some(v => v === key);
    if (!confirm(hasMarks ? 'Delete this category? Existing marks using it will be removed.' : 'Delete this category?')) return;
    delete legends[key];
    [marks, savedMarks].forEach(store => { Object.keys(store).forEach(k => { if (store[k] === key) delete store[k]; }); });
    if (cpSelected === key) cpSelected = 'holiday';
    buildCpModes(); buildCpGrid(); liveUpdate(); renderCustomLegendItems();
    showToast('Category deleted', 'fa-trash');
    await deleteCalendarLegendFromServer(key);
    delete _legendIdByKey[key];
}
function cpToggleLegendSchoolDay(key, isIncluded, event) {
    if (event) event.stopPropagation();
    if (!legends[key]) return;
    legends[key].includeInSchoolDays = !!isIncluded;
    buildCpGrid(); liveUpdate();
}
function buildCpGrid() {
    const grid  = document.getElementById('cp_grid');
    const label = document.getElementById('cp_month_label');
    if (label) label.textContent = MONTH_NAMES[cpMonth] + ' ' + cpYear;
    const totalDays = daysInMonth(cpYear, cpMonth);
    const firstDow  = new Date(cpYear, cpMonth, 1).getDay();
    const today     = new Date();
    const bounds    = getPickerDateBounds();
    const canEditMonth = isMonthWithinPickerRange(cpYear, cpMonth, bounds);
    const totalDaysEl  = document.getElementById('cpTotalDays');
    const weekdaysEl   = document.getElementById('cpWeekdays');
    const schoolDaysEl = document.getElementById('cpSchoolDays');
    const markedDaysEl = document.getElementById('cpMarkedDays');
    if (totalDaysEl) totalDaysEl.textContent = String(totalDays);
    let weekdays = 0, schoolDays = 0, markedInMonth = 0, html = '';
    DAY_SHORT.forEach(d => html += `<div class="cp-day-hdr">${d}</div>`);
    for (let i = 0; i < firstDow; i++) html += `<div class="cp-cell empty"></div>`;
    for (let d = 1; d <= totalDays; d++) {
        const dow = new Date(cpYear, cpMonth, d).getDay();
        const isWknd = dow === 0 || dow === 6;
        const isInCountRange = isDateWithinPickerRange(cpYear, cpMonth, d, bounds);
        const k = mkKey(cpYear, cpMonth, d);
        const mark = marks[k], rmk = remarks[k] || '';
        if (isInCountRange) {
            if (!isWknd) weekdays++;
            if (!mark) { if (!isWknd) schoolDays++; }
            else { const legend = legends[mark]; const inc = legend ? legend.includeInSchoolDays !== false : true; if (inc) schoolDays++; }
        }
        if (isInCountRange && (mark || rmk)) markedInMonth++;
        const isToday = cpYear === today.getFullYear() && cpMonth === today.getMonth() && d === today.getDate();
        const isStart = bounds?.start
            && cpYear === bounds.start.getFullYear()
            && cpMonth === bounds.start.getMonth()
            && d === bounds.start.getDate();
        const isEnd = bounds?.end
            && cpYear === bounds.end.getFullYear()
            && cpMonth === bounds.end.getMonth()
            && d === bounds.end.getDate();
        let cls = 'cp-cell' + (isWknd ? ' wknd' : '') + (isToday ? ' today' : '') + (canEditMonth ? '' : ' out-range');
        let cellStyle = '', markersHtml = '';
        let boundaryHtml = '';
        if (isStart && isEnd) {
            boundaryHtml = '<div class="cp-boundary cp-boundary-both" title="Start and end of classes">Start/End</div>';
            cls += ' boundary';
        } else if (isStart) {
            boundaryHtml = '<div class="cp-boundary cp-boundary-start" title="Start of classes">Start</div>';
            cls += ' boundary';
        } else if (isEnd) {
            boundaryHtml = '<div class="cp-boundary cp-boundary-end" title="End of classes">End</div>';
            cls += ' boundary';
        }
        if (mark) {
            cls += ' marked';
            const leg = legends[mark] || { color: '#6b7280', symbol: '?' };
            cellStyle = `background:${leg.color}26;border-color:${leg.color}99;`;
            const remarkTag = rmk ? `<div class="cp-remark-tag" title="${rmk}">${rmk}</div>` : '';
            markersHtml = `<div class="cp-markers"><div class="cp-marker ${Object.keys(legends).includes(mark) ? mark : ''}" style="background:${leg.color};color:#fff;border:1px solid ${leg.color};">${leg.symbol}</div></div>${remarkTag}`;
        } else if (rmk) {
            markersHtml = `<div class="cp-markers"><div class="cp-marker cp-note-marker" title="Note">✎</div></div><div class="cp-remark-tag" title="${rmk}">${rmk}</div>`;
        }
        const dayTitle = canEditMonth
            ? `${MONTH_NAMES[cpMonth]} ${d}${remarks[k] ? ' — ' + remarks[k] : ''}`
            : `${MONTH_NAMES[cpMonth]} ${d} is outside the opening/closing month range`;
        html += `<div class="${cls}" style="${cellStyle}" onclick="cpToggleDay(${d},event)" title="${dayTitle}"><div class="cp-daynum">${d}</div>${boundaryHtml}${markersHtml}</div>`;
    }
    const remainder = 7 - (totalDays + firstDow) % 7;
    if (remainder < 7) for (let i = 0; i < remainder; i++) html += `<div class="cp-cell empty"></div>`;
    if (grid) grid.innerHTML = html;
    if (weekdaysEl)   weekdaysEl.textContent   = String(weekdays);
    if (schoolDaysEl) schoolDaysEl.textContent = String(schoolDays);
    if (markedDaysEl) markedDaysEl.textContent = String(markedInMonth);
    buildCpSummary();
    updateCpYearSchoolDaysPanel();
}
function updateCpYearSchoolDaysPanel() {
    const yearEl   = document.getElementById('cpYearSchoolDays');
    const statusEl = document.getElementById('cpYearDaysStatus');
    if (!yearEl) return;
    const bounds = getPickerDateBounds();
    let yearTotal = 0;
    ACAD_MONTHS.forEach(({ y, m }) => {
        const total = daysInMonth(y, m);
        for (let d = 1; d <= total; d++) {
            if (!isDateWithinPickerRange(y, m, d, bounds)) continue;
            const k = mkKey(y, m, d);
            const mark = marks[k];
            const isWknd = isWeekend(y, m, d);
            if (!mark) { if (!isWknd) yearTotal++; }
            else { const leg = legends[mark]; const inc = leg ? leg.includeInSchoolDays !== false : true; if (inc) yearTotal++; }
        }
    });
    yearEl.textContent = String(yearTotal);
    if (statusEl) {
        if (yearTotal === 0) { statusEl.textContent = ''; statusEl.className = 'cp-year-days-status'; }
        else if (yearTotal >= 200 && yearTotal <= 220) { statusEl.textContent = '✓ Within 200–220 target'; statusEl.className = 'cp-year-days-status status-ok'; }
        else if (yearTotal < 200) { statusEl.textContent = `⚠ ${200 - yearTotal} days below minimum`; statusEl.className = 'cp-year-days-status status-low'; }
        else { statusEl.textContent = `⚠ ${yearTotal - 220} days above maximum`; statusEl.className = 'cp-year-days-status status-high'; }
    }
}
function cpToggleDay(d, event) {
    if (event) event.stopPropagation();
    const bounds = getPickerDateBounds();
    if (!isMonthWithinPickerRange(cpYear, cpMonth, bounds)) {
        showToast('That month is outside the opening/closing range.', 'fa-calendar-xmark'); return;
    }
    openRemarkPopup(d, event);
}
let _remarkDay = null, _remarkRangeEndDay = null;
function getRemarkRangeDays() {
    if (_remarkDay === null) return [];
    const start = Math.min(_remarkDay, _remarkRangeEndDay ?? _remarkDay);
    const end   = Math.max(_remarkDay, _remarkRangeEndDay ?? _remarkDay);
    const days  = [];
    for (let d = start; d <= end; d++) days.push(d);
    return days;
}
function updateRemarkRangeUi() {
    const input   = document.getElementById('cpRangeEndInput');
    const preview = document.getElementById('cpRangePreview');
    const rangeDays = getRemarkRangeDays();
    const max = daysInMonth(cpYear, cpMonth);
    if (input)   { input.min = '1'; input.max = String(max); input.value = String(_remarkRangeEndDay ?? _remarkDay ?? 1); }
    if (preview) {
        if (!rangeDays.length)        preview.textContent = 'Range: -';
        else if (rangeDays.length === 1) preview.textContent = `Range: Day ${rangeDays[0]} only`;
        else preview.textContent = `Range: Day ${rangeDays[0]} to Day ${rangeDays[rangeDays.length - 1]} (${rangeDays.length} days)`;
    }
}
function setRemarkRangeEndDay(day) {
    if (_remarkDay === null) return;
    const max = daysInMonth(cpYear, cpMonth);
    const numeric = Number.isFinite(day) ? day : parseInt(day, 10);
    const target  = Number.isFinite(numeric) ? numeric : _remarkDay;
    _remarkRangeEndDay = Math.min(max, Math.max(1, target));
    updateRemarkRangeUi();
}
function cpSetRangeEndFromInput(value) { setRemarkRangeEndDay(parseInt(value, 10)); }
function cpStepRangeEnd(delta) { setRemarkRangeEndDay((_remarkRangeEndDay ?? _remarkDay ?? 1) + delta); }
function openRemarkPopup(d, event) {
    _remarkDay = d; _remarkRangeEndDay = d;
    const k = mkKey(cpYear, cpMonth, d);
    const mark = marks[k];
    const isNoteOnly = !!remarks[k] && !mark;
    const leg = mark
        ? (legends[mark] || { label: mark })
        : (isNoteOnly ? { label:'Note Only', symbol:'✎', color:'#0f172a' } : { label:'Day', symbol:'●', color:'#64748b' });
    const defaultPopupMark = mark || (isNoteOnly ? CP_NOTE_ONLY_KEY : (cpSelected === CP_NOTE_ONLY_KEY ? 'holiday' : cpSelected));
    const existing = remarks[k] || '';
    const dateLabel = `${MONTH_NAMES[cpMonth]} ${d}, ${cpYear}`;
    const markOptions = [`<option value="${CP_NOTE_ONLY_KEY}">✎ Note Only (no legend mark)</option>`]
        .concat(Object.entries(legends).map(([key, info]) => `<option value="${key}">${info.symbol || '●'} ${info.label}</option>`))
        .concat([`<option value="__clear_mark__">Clear Mark</option>`]).join('');
    document.getElementById('cpRemarkPopup')?.remove();
    const popup = document.createElement('div');
    popup.className = 'cp-remark-popup'; popup.id = 'cpRemarkPopup';
    popup.innerHTML = `
    <h4><i class="fa-solid fa-pen-to-square" style="color:#2456a4;margin-right:5px;"></i>${dateLabel}</h4>
    <p style="display:flex;align-items:center;gap:6px;">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:${leg.color}20;border:1px solid ${leg.color}50;color:${leg.color};font-size:11px;font-weight:800;">${leg.symbol || '●'}</span>
      Marked as: <strong>${leg.label}</strong></p>
    <div class="cp-mark-row"><label class="cp-mark-label" for="cpMarkSelect">Legend / Mark</label>
      <select id="cpMarkSelect" class="cp-mark-select">${markOptions}</select></div>
    <div class="cp-range-row">
      <div class="cp-range-head"><span class="cp-range-label">Apply To Range</span><span class="cp-range-start">Start: Day ${d}</span></div>
      <div class="cp-range-controls">
        <button type="button" class="cp-range-btn" onclick="cpStepRangeEnd(-1)"><i class="fa-solid fa-chevron-left"></i></button>
        <input id="cpRangeEndInput" class="cp-range-input" type="number" min="1" max="${daysInMonth(cpYear, cpMonth)}" value="${d}" oninput="cpSetRangeEndFromInput(this.value)">
        <button type="button" class="cp-range-btn" onclick="cpStepRangeEnd(1)"><i class="fa-solid fa-chevron-right"></i></button>
      </div>
      <div class="cp-range-preview" id="cpRangePreview">Range: Day ${d} only</div></div>
    <textarea id="cpRemarkInput" placeholder="e.g. National Heroes Day, Grade 6 Exams, Field Trip...">${existing}</textarea>
    <div class="cp-remark-popup-btns">
      <button class="cp-remark-save" onclick="saveRemark()"><i class="fa-solid fa-check"></i> Save Remark</button>
      <button class="cp-remark-clear" onclick="clearRemark()" title="Clear remark text only"><i class="fa-solid fa-eraser"></i></button>
      <button class="cp-remark-cancel" onclick="closeRemarkPopup()"><i class="fa-solid fa-xmark"></i></button></div>
    <button class="cp-remark-remove" onclick="removeMarkDay()"><i class="fa-solid fa-trash"></i> Remove Mark from This Day</button>`;
    document.body.appendChild(popup);
    const cpRect = document.getElementById('cpOverlay').getBoundingClientRect();
    popup.style.top  = (cpRect.top + cpRect.height / 2 - 120) + 'px';
    popup.style.left = (cpRect.left + cpRect.width / 2 - 140) + 'px';
    updateRemarkRangeUi();
    const markSelect = document.getElementById('cpMarkSelect');
    if (markSelect) markSelect.value = defaultPopupMark;
    document.getElementById('cpRemarkInput')?.focus();
    setTimeout(() => { document.addEventListener('mousedown', _closeRemarkOutside, { once: true }); }, 50);
}
function _closeRemarkOutside(e) {
    const popup = document.getElementById('cpRemarkPopup');
    if (popup && !popup.contains(e.target)) closeRemarkPopup();
    else if (popup) document.addEventListener('mousedown', _closeRemarkOutside, { once: true });
}
function saveRemark() {
    if (_remarkDay === null) return;
    const days = getRemarkRangeDays();
    const selectedMark = document.getElementById('cpMarkSelect')?.value || CP_NOTE_ONLY_KEY;
    const val = document.getElementById('cpRemarkInput').value.trim();
    days.forEach(day => {
        const k = mkKey(cpYear, cpMonth, day);
        if (selectedMark === CP_NOTE_ONLY_KEY || selectedMark === '__clear_mark__') delete marks[k];
        else marks[k] = selectedMark;
        if (val) remarks[k] = val; else delete remarks[k];
    });
    closeRemarkPopup(); buildCpGrid(); buildCpModes();
}
function clearRemark() {
    if (_remarkDay === null) return;
    getRemarkRangeDays().forEach(day => { delete remarks[mkKey(cpYear, cpMonth, day)]; });
    closeRemarkPopup(); buildCpGrid();
}
function closeRemarkPopup() {
    document.getElementById('cpRemarkPopup')?.remove();
    _remarkDay = null; _remarkRangeEndDay = null;
}
function removeMarkDay() {
    if (_remarkDay === null) return;
    getRemarkRangeDays().forEach(day => { const k = mkKey(cpYear, cpMonth, day); delete marks[k]; delete remarks[k]; });
    closeRemarkPopup(); buildCpGrid(); buildCpModes();
    showToast('Mark removed', 'fa-trash');
}
function buildCpSummary() {
    const container = document.getElementById('cp_summary');
    if (!container) return;
    const counts = {};
    Object.values(marks).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const noteOnlyCount = Object.keys(remarks).filter(k => !marks[k]).length;
    let html = '<span style="font-size:10.5px;font-weight:700;color:#64748b;white-space:nowrap;">Year Summary:</span>';
    html += `<div class="cp-sum-chip">X - Declared Holidays: <strong>${counts.holiday || 0}</strong></div>`;
    html += `<div class="cp-sum-chip">□ - School Activities: <strong>${counts.activity || 0}</strong></div>`;
    html += `<div class="cp-sum-chip">△ - Administration of Quarter Examination: <strong>${counts.exam || 0}</strong></div>`;
    html += `<div class="cp-sum-chip">Notes Only: <strong>${noteOnlyCount}</strong></div>`;
    Object.entries(legends).forEach(([key, leg]) => {
        if (['holiday','activity','exam'].includes(key)) return;
        html += `<div class="cp-sum-chip"><span style="color:${leg.color};font-weight:900;">●</span> ${leg.label}: <strong>${counts[key] || 0}</strong></div>`;
    });
    container.innerHTML = html;
}
function cpPrevMonth() {
    const bounds = getPickerDateBounds();
    if (bounds.start) { const minSerial = monthSerial(bounds.start.getFullYear(), bounds.start.getMonth()); if (monthSerial(cpYear, cpMonth) <= minSerial) return; }
    cpMonth--; if (cpMonth < 0) { cpMonth = 11; cpYear--; } buildCpGrid();
}
function cpNextMonth() {
    const bounds = getPickerDateBounds();
    if (bounds.end) { const maxSerial = monthSerial(bounds.end.getFullYear(), bounds.end.getMonth()); if (monthSerial(cpYear, cpMonth) >= maxSerial) return; }
    cpMonth++; if (cpMonth > 11) { cpMonth = 0; cpYear++; } buildCpGrid();
}
async function cpAddLegend() {
    const name  = document.getElementById('cp_custom_name')?.value.trim();
    const color = document.getElementById('cp_custom_color')?.value;
    const includeInSchoolDays = document.getElementById('cp_custom_counts_schoolday')?.checked !== false;
    if (!name) { showToast('Category name cannot be empty.', 'fa-triangle-exclamation'); return; }
    const isEditing = !!cpEditingLegendKey && !!legends[cpEditingLegendKey];
    const key = isEditing ? cpEditingLegendKey : ('custom_' + Date.now());
    const existingSymbol = legends[key]?.symbol || '●';
    const legendData = { label: name, color, symbol: existingSymbol, includeInSchoolDays };
    legends[key] = legendData;
    cpSelected = key;
    closeCpAddCategoryModal();
    buildCpModes(); buildCpGrid(); liveUpdate(); renderCustomLegendItems();
    showToast(isEditing ? 'Category updated' : 'Category added', isEditing ? 'fa-pen' : 'fa-plus');
    /* Persist to the school's account (shared across all of that school's
       calendar documents) — fire-and-forget so the UI doesn't block on it. */
    await saveCalendarLegendToServer(key, legendData);
}
function cpClearAll() {
    if (!confirm('Clear all marked dates and remarks?')) return;
    Object.keys(marks).forEach(k => delete marks[k]);
    Object.keys(remarks).forEach(k => delete remarks[k]);
    buildCpGrid(); buildCpModes();
}
async function cpSaveAndApply() {
    if (_builderLocked) {
        showToast('This calendar is locked. Request edit approval first.', 'fa-lock');
        return;
    }
    Object.keys(savedMarks).forEach(k => delete savedMarks[k]);
    Object.entries(marks).forEach(([k, v]) => { savedMarks[k] = v; });
    Object.keys(savedRemarks).forEach(k => delete savedRemarks[k]);
    Object.entries(remarks).forEach(([k, v]) => { savedRemarks[k] = v; });
    closeRemarkPopup();
    document.getElementById('cpOverlay').classList.remove('open');
    liveUpdate();
    renderBuilderStepper();
    renderMonthHealthPanel();
    advanceBuilderStep();
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ document_id: currentCalendarDocumentId, title: buildCalendarDocumentTitle(), status: 'draft', payload: buildCalendarSavePayload() })
        });
        const payload = await res.json();
        if (!payload.success) throw new Error(payload.message || 'Failed to save calendar document.');
        currentCalendarDocumentId = payload.data?.document_id || currentCalendarDocumentId;
        await loadSavedCalendarDocs();
        showToast('Calendar saved & applied to preview!', 'fa-floppy-disk');
    } catch (err) {
        showToast(err.message || 'Could not save calendar document.', 'fa-triangle-exclamation');
    }
}
function normalizeLegendSettings() {
    Object.entries(legends).forEach(([key, legend]) => {
        if (!legend || typeof legend !== 'object') {
            legends[key] = { ...(DEFAULT_LEGENDS[key] || { label: key, color: '#64748b', symbol: '●', includeInSchoolDays: true }) }; return;
        }
        if (typeof legend.includeInSchoolDays === 'undefined') legend.includeInSchoolDays = key === 'holiday' ? false : true;
    });
}
function cpRevertLegends() {
    if (!confirm('Remove all custom categories and restore the 3 default legends?')) return;
    Object.keys(legends).forEach(k => { if (!DEFAULT_LEGENDS[k]) delete legends[k]; });
    Object.entries(DEFAULT_LEGENDS).forEach(([k, v]) => { legends[k] = { ...v }; });
    normalizeLegendSettings();
    [marks, savedMarks].forEach(store => { Object.keys(store).forEach(k => { if (!legends[store[k]]) delete store[k]; }); });
    cpSelected = 'holiday';
    buildCpModes(); buildCpGrid();
    showToast('Legends reverted to defaults', 'fa-rotate-left');
}

/* ══════════════════════════════════════════════════════════════════════════
   ELIGIBILITY GUARD (from savepatch + inline HTML script — unified)
══════════════════════════════════════════════════════════════════════════ */
// Note: 'all' (Show All Fields) is intentionally excluded — it is a view mode,
// not a document-flow page, so saving from it should not trigger the eligibility guard.
const _GATED_PAGES = new Set(['pg-summary', 'pg-checklist', 'pg-monthly']);

function _getActiveDomPage() {
    const el = document.querySelector('.doc-page.active');
    if (el?.id) return el.id;
    return DOC_FLOW_PAGES[docFlowCurrentIndex] || '';
}
function _getTotalSchoolDays() {
    return computeGrandTotal();
}
function showCalPickerEligibilityBanner(total) {
    document.getElementById('cpEligibilityBanner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'cpEligibilityBanner';
    let msg, color, bg, border;
    if (total === 0) {
        msg = `<strong>No school days have been marked yet.</strong> Please use the Calendar Picker to mark your school days, holidays, and activities. You need <strong>200–220 school days</strong> to proceed.`;
        color = '#1e40af'; bg = '#eff6ff'; border = '#93c5fd';
    } else if (total < 200) {
        msg = `<strong>Only ${total} school days marked</strong> — you need at least <strong>200</strong>. Please add more school days before proceeding.`;
        color = '#991b1b'; bg = '#fef2f2'; border = '#fca5a5';
    } else {
        msg = `<strong>${total} school days marked</strong> — maximum is <strong>220</strong>. Please mark more holidays or reduce activities to proceed.`;
        color = '#92400e'; bg = '#fffbeb'; border = '#fcd34d';
    }
    banner.style.cssText = `margin:0 0 12px;padding:12px 16px;background:${bg};border:1.5px solid ${border};border-radius:8px;color:${color};font-size:13px;line-height:1.55;display:flex;align-items:flex-start;gap:10px;`;
    banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="margin-top:2px;flex-shrink:0;font-size:15px;"></i><span>${msg}</span>`;
    const cpBody = document.querySelector('.cp-body');
    if (cpBody) cpBody.insertAdjacentElement('beforebegin', banner);
}
function _isEligibilityBlocking() {
    const page = _getActiveDomPage();
    if (!_GATED_PAGES.has(page)) return false;
    const total = _getTotalSchoolDays();
    return total < 200 || total > 220;
}

/* ══════════════════════════════════════════════════════════════════════════
   SAVE & CONTINUE (unified — guard + progress UI)
══════════════════════════════════════════════════════════════════════════ */
/* ── Save button state helpers (from savepatch) ── */
function _getOrCreateSaveToast() {
    let el = document.getElementById('dsnSaveToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'dsnSaveToast';
        el.className = 'dsn-save-toast';
        const saveBtn = document.querySelector('.dsn-save-continue-btn');
        if (saveBtn && saveBtn.parentNode) saveBtn.parentNode.insertBefore(el, saveBtn);
        else document.body.appendChild(el);
    }
    return el;
}
let _saveToastTimer = null;
function _showSaveToast(type, msg) {
    clearTimeout(_saveToastTimer);
    const el = _getOrCreateSaveToast();
    el.className = 'dsn-save-toast toast-' + type + ' visible';
    const icon = type === 'saving' ? 'fa-spinner fa-spin' : type === 'done' ? 'fa-circle-check' : 'fa-circle-xmark';
    el.innerHTML = `<i class="fa-solid ${icon}"></i> ${msg}`;
    if (type !== 'saving') {
        _saveToastTimer = setTimeout(() => { el.classList.remove('visible'); }, type === 'done' ? 3000 : 4500);
    }
}
function _setSaveBtnState(state) {
    const btn = document.querySelector('.dsn-save-continue-btn');
    if (!btn) return;
    btn.classList.remove('saving', 'save-done', 'save-error');
    switch (state) {
        case 'saving':
            btn.classList.add('saving');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; break;
        case 'done':
            btn.classList.add('save-done');
            btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Saved!';
            setTimeout(() => _resetSaveBtn(btn), 2200); break;
        case 'error':
            btn.classList.add('save-error');
            btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Save Failed';
            setTimeout(() => _resetSaveBtn(btn), 3000); break;
        default:
            _resetSaveBtn(btn);
    }
}
function _resetSaveBtn(btn) {
    if (!btn) btn = document.querySelector('.dsn-save-continue-btn');
    if (!btn) return;
    btn.classList.remove('saving', 'save-done', 'save-error');
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save &amp; Continue';
}

/* ── Lock-icon tooltip on locked nav buttons ── */
let _lockTooltip = null, _lockTooltipTimer = null;
function _showLockTooltip(btn) {
    clearTimeout(_lockTooltipTimer);
    if (!_lockTooltip) {
        _lockTooltip = document.createElement('div');
        _lockTooltip.className = 'dsn-lock-tooltip';
        document.body.appendChild(_lockTooltip);
    }
    _lockTooltip.textContent = '🔒 Save current page first to unlock';
    _lockTooltip.classList.add('visible');
    const rect = btn.getBoundingClientRect();
    _lockTooltip.style.left = (rect.left + rect.width / 2 - _lockTooltip.offsetWidth / 2) + 'px';
    _lockTooltip.style.top  = (rect.top - _lockTooltip.offsetHeight - 10) + 'px';
    _lockTooltipTimer = setTimeout(() => { _lockTooltip?.classList.remove('visible'); }, 2200);
}
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.dsn-btn.dsn-locked');
    if (btn) { e.preventDefault(); e.stopPropagation(); _showLockTooltip(btn); }
}, true);

/* ── The unified saveAndContinueDocFlow ── */
async function saveAndContinueDocFlow() {
    /* Guard 1: builder locked */
    if (_builderLocked) {
        showToast('This calendar is locked. Request edit approval first.', 'fa-lock'); return;
    }
    /* Guard 2: school days eligibility — read page from DOM to avoid mutation timing issues */
    if (_isEligibilityBlocking()) {
        const total = _getTotalSchoolDays();
        if (typeof openCalPicker === 'function') openCalPicker();
        setTimeout(() => showCalPickerEligibilityBanner(total), 180);
        const msg = total === 0
            ? 'No school days marked yet — open the Calendar Picker to get started.'
            : total < 200
                ? `Only ${total} of the required 200 school days are marked. Adjust in the Calendar Picker.`
                : `${total} school days marked — the maximum is 220. Mark more holidays.`;
        showToast(msg, 'fa-triangle-exclamation');
        return; // hard stop
    }

    const pageLabels = {
        'pg-cover':'Cover Page','pg-transmittal':'Transmittal Letter','pg-loi-cover':'LOI Cover',
        'pg-loi':'Letter of Intent','pg-cal-cover':'Calendar Cover',
        'pg-summary':'Summary','pg-checklist':'Checklist','pg-monthly':'Monthly Detail',
    };
    const beforePage = _getActiveDomPage();
    _setSaveBtnState('saving');
    _showSaveToast('saving', 'Saving your progress...');

    /* Advance to next page in the flow */
    let nextPage = null;
    if (docFlowCurrentIndex < DOC_FLOW_PAGES.length - 1) nextPage = DOC_FLOW_PAGES[docFlowCurrentIndex + 1];
    if (nextPage) setTrackedActivePage(nextPage);

    const saved = await calSaveCalendar();
    if (!saved) {
        setTrackedActivePage(DOC_FLOW_PAGES[docFlowCurrentIndex]);
        _setSaveBtnState('error');
        _showSaveToast('error', 'Save failed. Please check your connection and try again.');
        return;
    }

    if (nextPage) { unlockNextDocFlowPage(); _switchPageBase(nextPage); syncDocFlowNavLocks(); }
    if (currentBuilderStep < 4) advanceBuilderStep();

    const afterPage = _getActiveDomPage();
    const movedForward = beforePage && afterPage && beforePage !== afterPage;
    _setSaveBtnState('done');
    if (movedForward) {
        _showSaveToast('done', `<strong>${pageLabels[beforePage] || 'Current page'}</strong> saved ✓ — moved to <strong>${pageLabels[afterPage] || 'next page'}</strong>`);
    } else {
        _showSaveToast('done', `<strong>${pageLabels[beforePage] || 'Current page'}</strong> saved successfully ✓`);
    }
    syncDocFlowNavLocks();
}

/* ══════════════════════════════════════════════════════════════════════════
   FINAL SUBMISSION (from enhanced, + eligibility guard inline)
   ─────────────────────────────────────────────────────────────────────────
   Issue 3 note: An earlier version of this guard existed as a monkey-patch
   in school-portal-calendar-savepatch.js (the "Patch showFinalSubmitDialog"
   block). That wrapper was removed during the merge into this single file
   because the guard is now implemented inline below.

   The guard checks two conditions before allowing the submission dialog:
     1. Total school days must be between 200 and 220 (DepEd requirement).
     2. (Implicit) The calendar picker must have been used — grand === 0
        means no days were ever marked.

   DO NOT remove or comment out the guard without also updating the
   showCalPickerEligibilityBanner() call and the submit button state in
   confirmFinalSubmit(). If the 200–220 range changes by DepEd order,
   update the constants here AND in computeGrandTotal() / the health panel.
══════════════════════════════════════════════════════════════════════════ */
function showFinalSubmitDialog() {
    const grand = computeGrandTotal();
    /* Eligibility guard */
    if (grand < 200 || grand > 220) {
        openCalPicker();
        setTimeout(() => showCalPickerEligibilityBanner(grand), 180);
        const msg = grand === 0
            ? 'Please mark school days in the Calendar Picker first.'
            : grand < 200
                ? `Only ${grand} days marked — minimum is 200. Adjust in Calendar Picker.`
                : `${grand} days marked — maximum is 220. Mark more holidays.`;
        showToast(msg, 'fa-triangle-exclamation');
        return;
    }
    const isValid = true;
    const report  = getMonthHealthReport();
    const issues  = report.filter(r => r.status !== 'ok');
    let overlay = document.getElementById('calSubmitOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'calSubmitOverlay';
        overlay.className = 'cal-modal-overlay';
        overlay.onclick = (e) => { if (e.target === overlay) closeFinalSubmitDialog(); };
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div class="cal-submit-modal">
            <div class="csm-head">
                <i class="fa-solid fa-paper-plane csm-icon"></i>
                <h3>Final Submission</h3>
                <button class="csm-close" onclick="closeFinalSubmitDialog()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="csm-body">
                <div class="csm-stat-row">
                    <div class="csm-stat csm-stat-ok"><div class="csm-stat-num">${grand}</div><div class="csm-stat-label">Total School Days</div></div>
                    <div class="csm-stat csm-stat-ok"><div class="csm-stat-num">200</div><div class="csm-stat-label">Minimum Required</div></div>
                    <div class="csm-stat csm-stat-ok"><div class="csm-stat-num">220</div><div class="csm-stat-label">Maximum Allowed</div></div>
                </div>
                ${issues.length > 0 ? `<div class="csm-issues"><div class="csm-issues-title"><i class="fa-solid fa-triangle-exclamation"></i> Month Warnings</div>
                    ${issues.map(r => `<div class="csm-issue-row"><span>${r.name}</span><span class="csm-issue-days">${r.sd} days</span><span class="csm-issue-msg">${r.status === 'low' ? 'Too few' : 'Many days'}</span></div>`).join('')}
                </div>` : ''}
                <div class="csm-confirm-msg"><i class="fa-solid fa-circle-check"></i>
                    Your calendar meets the 200–220 day requirement. Once submitted, you will <strong>not be able to edit</strong> it unless an administrator approves your edit request.
                </div>
                <div class="csm-confirm-check"><label><input type="checkbox" id="csmAgreeCheck">
                    I understand that submitting is final and edits require admin approval.</label></div>
            </div>
            <div class="csm-footer">
                <button class="csm-btn csm-btn-secondary" onclick="closeFinalSubmitDialog()">Cancel</button>
                <button class="csm-btn csm-btn-primary" onclick="confirmFinalSubmit()">
                    <i class="fa-solid fa-paper-plane"></i> Submit for Final Approval
                </button>
            </div>
        </div>`;
    overlay.style.display = 'flex';
}
function closeFinalSubmitDialog() {
    const overlay = document.getElementById('calSubmitOverlay');
    if (overlay) overlay.style.display = 'none';
}
async function confirmFinalSubmit() {
    const agreed = document.getElementById('csmAgreeCheck')?.checked;
    if (!agreed) { showToast('Please check the confirmation box first.', 'fa-triangle-exclamation'); return; }
    const btn = document.querySelector('.csm-btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…'; }
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ document_id: currentCalendarDocumentId, title: buildCalendarDocumentTitle(), status: 'submitted', payload: buildCalendarSavePayload() })
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Submission failed.');
        currentCalendarDocumentId = json.data?.document_id ?? currentCalendarDocumentId;
        closeFinalSubmitDialog();
        hideReturnedBanner();
        document.getElementById('calEditApprovedBanner')?.remove();
        showToast('Calendar submitted for final approval!', 'fa-circle-check');
        currentBuilderStep = 5; renderBuilderStepper();
        lockBuilderForSubmitted();
        await loadSavedCalendarDocs();

        /* ── Notify admin side of calendar submission ── */
        try {
            await fetch(`${API_BASE}/notifications.php`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'create',
                    notification_type: 'calendar',
                    document_id: currentCalendarDocumentId,
                    submission_title: buildCalendarDocumentTitle(),
                    school_name: localStorage.getItem('edu_school_name') || '',
                })
            });
        } catch (_) { /* non-critical — submit already succeeded */ }

        /* ── Redirect to read-only submitted view ── */
        const _viewDocId = currentCalendarDocumentId;
        if (_viewDocId) {
            setTimeout(() => {
                window.location.href = `school-portal-calendar-submitted.html?document_id=${encodeURIComponent(_viewDocId)}`;
            }, 1200);
        }
    } catch (err) {
        showToast('Submission failed: ' + (err.message || 'Unknown error'), 'fa-circle-xmark');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for Final Approval'; }
    }
}


/* ══════════════════════════════════════════════════════════════════════════
   BUILDER LOCK / UNLOCK (from enhanced)
══════════════════════════════════════════════════════════════════════════ */
function lockBuilderForSubmitted() {
    _builderLocked = true;
    let banner = document.getElementById('calLockedBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'calLockedBanner';
        banner.className = 'cal-locked-banner';
        const topBar = document.querySelector('.top-bar');
        if (topBar) topBar.insertAdjacentElement('afterend', banner);
    }
    banner.innerHTML = `
        <i class="fa-solid fa-lock"></i>
        This calendar has been <strong>submitted for final approval</strong> and is now read-only.
        To request edits, contact your administrator.
        <button class="clb-req-btn" onclick="requestEditApproval()">
            <i class="fa-solid fa-pen-to-square"></i> Request Edit Approval
        </button>`;
    banner.style.display = 'flex';
    document.querySelectorAll('#formPanel input, #formPanel select, #formPanel textarea').forEach(el => {
        el.disabled = true; el.style.opacity = '0.6'; el.style.cursor = 'not-allowed';
    });
    const saveBtn = document.getElementById('calBtnSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.5'; }
}
function unlockBuilder() {
    _builderLocked = false;
    const banner = document.getElementById('calLockedBanner');
    if (banner) banner.style.display = 'none';
    document.querySelectorAll('#formPanel input, #formPanel select, #formPanel textarea').forEach(el => {
        el.disabled = false; el.style.opacity = ''; el.style.cursor = '';
    });
    const saveBtn = document.getElementById('calBtnSave');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
}
/* Locks the "School / Grade / Department" (level) field so it can't be
   changed once a calendar document has been committed to a level — either
   a brand-new document (the level was just picked via the "which level?"
   selector before Create was clicked) or an existing saved document
   (changing the level after the fact would desync it from the title,
   the one-submission-per-level guard, and the SDO's records). Must be
   called AFTER unlockBuilder(), since unlockBuilder() re-enables every
   #formPanel field including this one. */
function lockDeptField() {
    const deptSelect = document.getElementById('f_dept');
    if (!deptSelect) return;
    deptSelect.disabled = true;
    deptSelect.style.opacity = '0.6';
    deptSelect.style.cursor = 'not-allowed';
    deptSelect.title = 'The level can\'t be changed after a calendar document has been created for it.';
}
function _showEditApprovedBanner() {
    hideReturnedBanner();
    const existing = document.getElementById('calEditApprovedBanner');
    if (existing) { existing.style.display = 'flex'; return; }
    const banner = document.createElement('div');
    banner.id = 'calEditApprovedBanner';
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;background:#f0fdf4;border-bottom:2px solid #86efac;padding:10px 18px;font-size:12.5px;font-weight:600;color:#14532d;flex-wrap:wrap;font-family:var(--font,sans-serif);position:relative;z-index:9;';
    banner.innerHTML = `
        <i class="fa-solid fa-unlock" style="font-size:16px;color:#16a34a;flex-shrink:0;"></i>
        <div style="flex:1;min-width:180px;line-height:1.5;">
            Your edit request has been <strong>approved by the SDO</strong>.
            <span style="display:block;font-weight:400;font-size:11.5px;color:#166534;margin-top:2px;">
                You can now make your corrections and re-submit when ready.
            </span>
        </div>
        <button class="crb-btn crb-btn-submit" onclick="showFinalSubmitDialog()">
            <i class="fa-solid fa-paper-plane"></i> Submit
        </button>`;
    const topBar = document.querySelector('.top-bar');
    if (topBar) topBar.insertAdjacentElement('afterend', banner);
}

/* ══════════════════════════════════════════════════════════════════════════
   RETURNED-FOR-CORRECTION BANNER (from returnpatch)
══════════════════════════════════════════════════════════════════════════ */
function _isReturnedStatus(status) {
    if (!status) return false;
    const s = String(status).toLowerCase().replace(/[\s-]/g, '_');
    return s === 'returned_for_correction' || s === 'rejected' || s === 'returned';
}
function showReturnedBanner(adminRemarks) {
    const lockedBanner = document.getElementById('calLockedBanner');
    if (lockedBanner) lockedBanner.style.display = 'none';
    let banner = document.getElementById('calReturnedBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'calReturnedBanner';
        banner.className = 'cal-returned-banner';
        const topBar = document.querySelector('.top-bar');
        if (topBar) topBar.insertAdjacentElement('afterend', banner);
    }
    const remarksHtml = adminRemarks
        ? `<div class="crb-remarks-box">
               <div class="crb-remarks-label"><i class="fa-solid fa-comment-dots"></i> Admin Remarks:</div>
               <div class="crb-remarks-text">${escHtml(adminRemarks)}</div>
           </div>`
        : '';
    banner.innerHTML = `
        <i class="fa-solid fa-rotate-left crb-icon"></i>
        <div class="crb-text">
            This calendar has been <strong>returned for correction</strong>.
            <span>Please review the admin's feedback, make the necessary corrections, and re-submit.</span>
            ${remarksHtml}
        </div>
        <div class="crb-actions">
            <button class="crb-btn crb-btn-submit" onclick="showFinalSubmitDialog()">
                <i class="fa-solid fa-paper-plane"></i> Submit
            </button>
        </div>`;
    banner.style.display = 'flex';
    _builderLocked = false;
    document.querySelectorAll('#formPanel input, #formPanel select, #formPanel textarea').forEach(el => {
        el.disabled = false; el.style.opacity = ''; el.style.cursor = '';
    });
    const saveBtn = document.getElementById('calBtnSave');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
}
function hideReturnedBanner() {
    const banner = document.getElementById('calReturnedBanner');
    if (banner) banner.style.display = 'none';
}

/* ══════════════════════════════════════════════════════════════════════════
   EDIT REQUEST (from editrequest.js — real API call)
══════════════════════════════════════════════════════════════════════════ */
function requestEditApproval() {
    if (!currentCalendarDocumentId) {
        showToast('No submitted document found.', 'fa-triangle-exclamation'); return;
    }
    let overlay = document.getElementById('calEditRequestOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'calEditRequestOverlay';
        overlay.className = 'cal-modal-overlay';
        overlay.onclick = (e) => { if (e.target === overlay) closeEditRequestDialog(); };
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div class="cal-submit-modal">
            <div class="csm-head">
                <i class="fa-solid fa-pen-to-square csm-icon"></i>
                <h3>Request Edit Approval</h3>
                <button class="csm-close" onclick="closeEditRequestDialog()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="csm-body">
                <div class="csm-confirm-msg">
                    <i class="fa-solid fa-circle-info"></i>
                    Your calendar is currently locked. Submitting this request will notify the SDO administrator to review and approve your request to make edits.
                </div>
                <div style="margin-top:12px;">
                    <label style="font-size:13px;font-weight:600;color:#374151;display:block;margin-bottom:6px;">
                        Reason for edit <span style="font-weight:400;color:#9ca3af;">(optional)</span>
                    </label>
                    <textarea id="editRequestReason" rows="3" placeholder="Briefly explain why you need to edit this calendar…"
                        style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;resize:vertical;outline:none;"
                        onfocus="this.style.borderColor='#2456a4'" onblur="this.style.borderColor='#e2e8f0'"></textarea>
                </div>
            </div>
            <div class="csm-footer">
                <button class="csm-btn csm-btn-secondary" onclick="closeEditRequestDialog()">Cancel</button>
                <button class="csm-btn csm-btn-primary" id="editRequestSubmitBtn" onclick="confirmEditRequest()">
                    <i class="fa-solid fa-paper-plane"></i> Submit Request
                </button>
            </div>
        </div>`;
    overlay.style.display = 'flex';
    setTimeout(() => document.getElementById('editRequestReason')?.focus(), 50);
}
function closeEditRequestDialog() {
    const overlay = document.getElementById('calEditRequestOverlay');
    if (overlay) overlay.style.display = 'none';
}
async function confirmEditRequest() {
    const reason = (document.getElementById('editRequestReason')?.value || '').trim();
    const submitBtn = document.getElementById('editRequestSubmitBtn');
    const originalHTML = submitBtn ? submitBtn.innerHTML : null;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Sending…'; }
    const triggerBtn = document.querySelector('[onclick="requestEditApproval()"]');
    try {
        const response = await fetch(CALENDAR_API, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'request_edit', calendar_document_id: currentCalendarDocumentId, reason }),
        });
        const data = await response.json();
        closeEditRequestDialog();
        if (data.success) {
            showToast(data.message || 'Edit request submitted! You will be notified once approved by the SDO.', 'fa-check-circle');
            if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.innerHTML = '<i class="fa fa-clock me-1"></i> Request Pending'; triggerBtn.classList.add('dsn-locked'); }
        } else {
            showToast(data.message || 'Request failed. Please try again.', 'fa-triangle-exclamation');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalHTML; }
        }
    } catch (err) {
        console.error('[confirmEditRequest]', err);
        closeEditRequestDialog();
        showToast('Network error. Please check your connection.', 'fa-triangle-exclamation');
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT
══════════════════════════════════════════════════════════════════════════ */
function exportCalendarJSON() {
    const data = buildCalendarSavePayload();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (buildCalendarDocumentTitle() || 'school-calendar') + '.json';
    a.click(); URL.revokeObjectURL(url);
}

/* ─── Export PDF (html2canvas → multi-page PDF via jsPDF) ─────────────────
   Captures every .doc-page > .paper element as a high-res canvas image,
   then writes each onto its own A4/Letter PDF page using jsPDF.
   Falls back to window.print() if html2canvas or jsPDF are not loaded.    */
async function exportCalendarPDF() {
    if (typeof closeTopBarMenu === 'function') closeTopBarMenu();
    if (typeof ensureExportSourceBadges === 'function') ensureExportSourceBadges();

    /* ── resolve jsPDF (loaded lazily so it doesn't bloat the main page) ── */
    if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        await new Promise((res, rej) => { script.onload = res; script.onerror = rej; document.head.appendChild(script); });
    }
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;

    if (typeof html2canvas === 'undefined' || typeof JsPDF === 'undefined') {
        // Graceful fallback
        window.print();
        return;
    }

    const allPapers = Array.from(document.querySelectorAll('.doc-page .paper'));
    if (!allPapers.length) { window.print(); return; }

    /* Every .doc-page that isn't the currently-active one is display:none,
       which makes html2canvas capture it as a 0×0 canvas — that's what was
       feeding NaN/Infinity into jsPDF.addImage() and throwing "Invalid
       argument passed to jsPDF.scale". Temporarily force every page
       visible for the capture, then restore afterwards (always, even on
       error, via try/finally). */
    const pagesToRestore = Array.from(document.querySelectorAll('.doc-page'));
    const prevDisplay = pagesToRestore.map(p => p.style.display);
    pagesToRestore.forEach(p => p.style.setProperty('display', 'block', 'important'));

    /* Skip "empty" papers (letterhead only, no real content) the same way
       the print-based export does, so blank pages don't end up in the PDF. */
    const papers = allPapers.filter(paper => {
        const clone = paper.cloneNode(true);
        const lh = clone.querySelector('.lh');
        if (lh) lh.remove();
        return !!(clone.textContent || '').replace(/\s+/g, '');
    });

    try {
        const pdf   = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
        const PW    = 215.9;   // letter width  mm
        const PH    = 279.4;   // letter height mm
        const SCALE = 2;       // retina-quality capture

        let pagesAdded = 0;
        for (let i = 0; i < papers.length; i++) {
            const paper = papers[i];

            /* Temporarily unhide in case the page was collapsed */
            const origVis = paper.style.visibility;
            paper.style.visibility = 'visible';

            const canvas = await html2canvas(paper, {
                scale      : SCALE,
                useCORS    : true,
                allowTaint : true,
                backgroundColor: '#ffffff',
                logging    : false,
            });

            paper.style.visibility = origVis;

            /* Guard: a 0×0 canvas (page hidden/unrendered/no layout yet)
               would otherwise produce NaN/Infinity dimensions below and
               crash jsPDF — skip it instead of adding a broken page. */
            if (!canvas.width || !canvas.height) continue;

            const imgData  = canvas.toDataURL('image/jpeg', 0.92);
            const imgW     = canvas.width  / SCALE;   // logical px
            const imgH     = canvas.height / SCALE;

            /* Scale to fit page width, preserving aspect ratio */
            const ratio    = PW / imgW;
            const drawW    = PW;
            const drawH    = imgH * ratio;

            if (pagesAdded > 0) pdf.addPage('letter', 'portrait');
            pdf.addImage(imgData, 'JPEG', 0, 0, drawW, Math.min(drawH, PH));
            pagesAdded++;
        }

        const filename = (buildCalendarDocumentTitle && buildCalendarDocumentTitle()) || 'school-calendar';
        pdf.save(filename + '.pdf');
    } finally {
        pagesToRestore.forEach((p, i) => { p.style.display = prevDisplay[i]; });
    }
}

/* ─── Export Word (.docx via docx UMD already loaded in submitted view) ───
   Builds a structured .docx that mirrors every section of the calendar:
   Cover → Transmittal → LOI Cover → LOI → Calendar Cover →
   Calendar Summary → Checklist → Monthly Grid pages.
   Uses the live DOM text (already hydrated by hydrateCalendarFromPayload).  */
async function exportCalendarWord() {
    /* Require the docx UMD bundle (loaded via <script> in submitted view) */
    if (typeof docx === 'undefined') {
        alert('Word export library not loaded. Please refresh and try again.');
        return;
    }

    const {
        Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        ImageRun, AlignmentType, BorderStyle, WidthType, ShadingType,
        PageBreak, LevelFormat, VerticalAlign, Header,
    } = docx;

    /* ══════════════════════════════════════════════════════════════════
       HELPERS
    ══════════════════════════════════════════════════════════════════ */
    const gt  = id => ((document.getElementById(id) || {}).textContent || '').trim();

    /* Like gt(), but for elements whose value was set via innerHTML with a
       <br> separating two phrases (e.g. "Elementary<br>School Calendar").
       Plain .textContent collapses <br> to nothing, jamming the words
       together ("ElementarySchool Calendar") — this keeps them apart. */
    const gtBR = id => {
        const el = document.getElementById(id);
        if (!el) return '';
        return (el.innerHTML || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    /* Convert a dataURL (base64 PNG/JPEG) → Uint8Array */
    function dataUrlToUint8Array(dataUrl) {
        const b64 = dataUrl.split(',')[1];
        if (!b64) return null;
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    /* Detect image type from dataURL */
    function imgType(dataUrl) {
        if (dataUrl.startsWith('data:image/png'))  return 'png';
        if (dataUrl.startsWith('data:image/gif'))  return 'gif';
        if (dataUrl.startsWith('data:image/bmp'))  return 'bmp';
        return 'jpg';
    }

    /* Re-usable border set */
    const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '374151' };
    const ALL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };
    const NO_BORDERS  = {
        top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    };

    /* FONTS */
    const SANS  = 'Plus Jakarta Sans';
    const SERIF = 'EB Garamond';

    /* COLOURS (hex, no #) */
    const NAVY  = '0A1F3D';
    const BLUE  = '1A3A6B';
    const MID   = '2456A4';
    const RED   = 'DC2626';
    const GRAY  = '374151';
    const LGRAY = '64748B';
    const WHITE = 'FFFFFF';

    /* Page metrics (US Letter, 0.7" margins, DXA) */
    const PAGE_W    = 12240;
    const PAGE_H    = 15840;
    const MARGIN    = 1008;   // 0.7"
    const CONTENT_W = PAGE_W - MARGIN * 2;   // 10224

    /* ── Paragraph helpers ── */
    function blankLine(pts = 6) {
        return new Paragraph({ spacing: { before: 0, after: 0, line: pts * 20 }, children: [] });
    }

    function rule(color = MID, pts = 6) {
        return new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: pts, color, space: 1 } },
            spacing: { before: 0, after: 80 },
            children: [],
        });
    }

    function para(runs, opts = {}) {
        return new Paragraph({
            alignment : opts.align  || AlignmentType.LEFT,
            spacing   : { before: opts.before ?? 0, after: opts.after ?? 80,
                          line: opts.line, lineRule: opts.line ? 'auto' : undefined },
            indent    : opts.indent ? { left: opts.indent } : undefined,
            children  : Array.isArray(runs) ? runs : [runs],
        });
    }

    function run(text, opts = {}) {
        return new TextRun({
            text     : String(text ?? ''),
            font     : opts.font  || SERIF,
            size     : opts.size  || 22,
            bold     : !!opts.bold,
            italics  : !!opts.italic,
            color    : opts.color || GRAY,
            underline: opts.underline ? { type: 'single' } : undefined,
        });
    }

    /* Simple single-run paragraph shortcut */
    function p(text, opts = {}) {
        return para(run(text, opts), opts);
    }

    function pageBreak() {
        return new Paragraph({ children: [new PageBreak()] });
    }

    /* Signatory block */
    function sigBlock(name, title, extra) {
        const rows = [blankLine(14)];
        if (name)  rows.push(p(name,  { bold: true, underline: true }));
        if (title) rows.push(p(title));
        if (extra) rows.push(p(extra));
        return rows;
    }

    /* ══════════════════════════════════════════════════════════════════
       LOGO — fetch from live <img> element (already base64)
    ══════════════════════════════════════════════════════════════════ */
    let logoImageRun = null;
    const logoImg = document.querySelector('#lhLogo1, #lhLogo2, #lhLogo3, #lhLogo4, #lhLogo5, #lhLogo6, #lhLogo8');
    const logoSrc = (logoImg && logoImg.src && !logoImg.src.endsWith('/') && logoImg.style.display !== 'none')
                    ? logoImg.src : (logoDataUrl || '');
    if (logoSrc && logoSrc.startsWith('data:')) {
        const imgData = dataUrlToUint8Array(logoSrc);
        if (imgData) {
            logoImageRun = new ImageRun({
                data: imgData,
                type: imgType(logoSrc),
                transformation: { width: 56, height: 56 },
            });
        }
    }

    /* ══════════════════════════════════════════════════════════════════
       LETTERHEAD — logo left, school info centred, blue underline
    ══════════════════════════════════════════════════════════════════ */
    function letterhead(pageNum) {
        const sfx    = pageNum > 1 ? String(pageNum) : '';
        const school = gt(`pv_school${sfx}`);
        const dept   = gt(`pv_dept${sfx}`);
        const meta   = gt(`pv_meta${sfx}`);

        /* Two-column table: logo | text */
        const logoCell = new TableCell({
            borders: NO_BORDERS,
            width: { size: 900, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 0, bottom: 0, left: 0, right: 160 },
            children: logoImageRun
                ? [new Paragraph({ children: [logoImageRun] })]
                : [new Paragraph({ children: [] })],
        });

        const textCell = new TableCell({
            borders: NO_BORDERS,
            width: { size: CONTENT_W - 900, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            children: [
                para(run(school, { font: SANS, size: 26, bold: true, color: NAVY }),
                     { align: AlignmentType.CENTER, after: 20 }),
                para(run(dept,   { font: SANS, size: 20, color: BLUE }),
                     { align: AlignmentType.CENTER, after: 20 }),
                para(run(meta,   { font: SANS, size: 18, color: LGRAY }),
                     { align: AlignmentType.CENTER, after: 0 }),
            ],
        });

        const lhTable = new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: [900, CONTENT_W - 900],
            rows: [new TableRow({ children: [logoCell, textCell] })],
            borders: {
                top:          { style: BorderStyle.NONE },
                bottom:       { style: BorderStyle.NONE },
                left:         { style: BorderStyle.NONE },
                right:        { style: BorderStyle.NONE },
                insideH:      { style: BorderStyle.NONE },
                insideV:      { style: BorderStyle.NONE },
            },
        });

        return [lhTable, rule(MID, 8)];
    }

    /* ══════════════════════════════════════════════════════════════════
       DOCUMENT HEADER — same letterhead table used on every page
       Placed in the Word header so it repeats automatically.
       The page top margin is enlarged (MARGIN + 1440) to give it room.
    ══════════════════════════════════════════════════════════════════ */
    function letterheadHeader() {
        const school = gt('pv_school') || gt('pv_school2') || '';
        const dept   = gt('pv_dept')   || gt('pv_dept2')   || '';
        const meta   = gt('pv_meta')   || gt('pv_meta2')   || '';

        const logoCell = new TableCell({
            borders: NO_BORDERS,
            width: { size: 900, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 0, bottom: 0, left: 0, right: 160 },
            children: logoImageRun
                ? [new Paragraph({ children: [logoImageRun] })]
                : [new Paragraph({ children: [] })],
        });

        const textCell = new TableCell({
            borders: NO_BORDERS,
            width: { size: CONTENT_W - 900, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            children: [
                para(run(school, { font: SANS, size: 26, bold: true, color: NAVY }),
                     { align: AlignmentType.CENTER, after: 12 }),
                para(run(dept,   { font: SANS, size: 20, color: BLUE }),
                     { align: AlignmentType.CENTER, after: 12 }),
                para(run(meta,   { font: SANS, size: 18, color: LGRAY }),
                     { align: AlignmentType.CENTER, after: 0 }),
            ],
        });

        const lhTable = new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: [900, CONTENT_W - 900],
            rows: [new TableRow({ children: [logoCell, textCell] })],
            borders: {
                top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
                insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE },
            },
        });

        return [lhTable, new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: MID, space: 1 } },
            spacing: { before: 0, after: 40 },
            children: [],
        })];
    }

    /* ══════════════════════════════════════════════════════════════════
       PAGE 1 — COVER
       Mirrors the live preview's .cover-body (flex, justify-content:center):
       the title block is true vertically centred within the space left on
       the page below the repeating letterhead header — done by wrapping it
       in a single borderless table cell with verticalAlign CENTER and a
       row height that spans the remaining usable page height, instead of
       a fixed blankLine() spacer (which only "estimates" the centre and
       drifts off whenever the header's actual rendered height differs).
    ══════════════════════════════════════════════════════════════════ */
    const TABLE_NO_BORDERS = {
        top:     { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
        left:    { style: BorderStyle.NONE }, right:  { style: BorderStyle.NONE },
        insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE },
    };

    /* Usable page height below the (enlarged) top margin + header, above
       the bottom margin. Kept a little under the theoretical max so it
       never spills onto a second page even if the header wraps to 3 lines. */
    const COVER_CELL_HEIGHT = PAGE_H - (MARGIN + 720) - MARGIN - 1100; // ≈ 10844 dxa

    /* Reusable: wraps arbitrary paragraph(s) in a full-height, vertically
       centred table cell — used by every "cover" page (Page 1, LOI Cover,
       Calendar Cover) so they all centre the same way as the live preview. */
    function centerCoverPage(paragraphs) {
        return [
            new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                borders: TABLE_NO_BORDERS,
                rows: [new TableRow({
                    height: { value: COVER_CELL_HEIGHT, rule: 'atLeast' },
                    children: [new TableCell({
                        borders: TABLE_NO_BORDERS,
                        width: { size: CONTENT_W, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.CENTER,
                        children: paragraphs,
                    })],
                })],
            }),
            pageBreak(),
        ];
    }

    const coverSection = centerCoverPage([
        para(run(gtBR('pv_cover_dept') || 'SCHOOL CALENDAR', {
            font: SERIF, size: 92, bold: true, color: NAVY,
        }), { align: AlignmentType.CENTER, after: 160 }),
        para(run(gt('pv_cover_sy') || 'S.Y. 2026–2027', {
            font: SERIF, size: 52, italic: true, color: GRAY,
        }), { align: AlignmentType.CENTER }),
    ]);

    /* ══════════════════════════════════════════════════════════════════
       PAGE 2 — TRANSMITTAL
    ══════════════════════════════════════════════════════════════════ */
    const attachedEl   = document.getElementById('pv_attached_list');
    const attachedItems = attachedEl
        ? Array.from(attachedEl.querySelectorAll('li')).map(li => li.textContent.trim())
        : [];
    const openDate  = gt('pv_trans_opening');
    const closeDate = gt('pv_trans_closing');
    const totalDays = gt('pv_trans_total_days');
    const sy        = gt('pv_sy_ltr') || '';

    const transmittalSection = [
        blankLine(20),
        p(gt('pv_rd_name'),    { bold: true }),
        p(gt('pv_rd_pos')),
        p(gt('pv_rd_office')),
        blankLine(8),
        para([
            run('Thru:  ', { bold: true }),
            run(gt('pv_sds_name'), { bold: true }),
        ]),
        p(gt('pv_sds_pos')),
        p(gt('pv_sds_office')),
        p(gt('pv_sds_city')),
        blankLine(8),
        p('Dear Sir/Ma\'am,'),
        blankLine(4),
        p('Greetings in Christ!'),
        blankLine(4),
        p(`We are pleased to submit to your good office the documents listed below for the School Year ${sy} for your review and consideration.`),
        blankLine(4),
        p('The following documents are attached:'),
        ...attachedItems.map(item => new Paragraph({
            numbering: { reference: 'bullets', level: 0 },
            children: [run(item)],
        })),
        blankLine(4),
        p(`We will commence the school year ${sy} on ${openDate}, and conclude on ${closeDate}. Our primary mode of instruction will be full face-to-face learning. This calendar ensures a total of ${totalDays} days in full compliance with DepEd policies. Thank you so much and God bless!`),
        blankLine(4),
        p('Sincerely,'),
        ...sigBlock(gt('pv_principal'), gt('pv_principal_title'), gt('pv_principal_contact')),
        pageBreak(),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAGE 3 — LOI COVER
    ══════════════════════════════════════════════════════════════════ */
    const loiCoverSection = centerCoverPage([
        para(run('Letter of Intent', { font: SERIF, size: 92, bold: true, color: NAVY }),
             { align: AlignmentType.CENTER }),
    ]);

    /* ══════════════════════════════════════════════════════════════════
       PAGE 4 — LOI
    ══════════════════════════════════════════════════════════════════ */
    const loiSection = [
        blankLine(20),
        p(gt('pv_loi_to_name')  || gt('pv_rd_name2')   || gt('pv_rd_name'),    { bold: true }),
        p(gt('pv_loi_to_pos')   || gt('pv_rd_pos2')    || gt('pv_rd_pos')),
        p(gt('pv_loi_to_org1')  || gt('pv_rd_office2') || gt('pv_rd_office')),
        p(gt('pv_loi_to_org2')),
        p(gt('pv_loi_to_org3')),
        p(gt('pv_loi_to_org4')),
        blankLine(8),
        para([run('Thru:  ', { bold: true }),
              run(gt('pv_loi_thru_name') || gt('pv_sds_name2') || gt('pv_sds_name'), { bold: true })]),
        p(gt('pv_loi_thru_pos')  || gt('pv_sds_pos2')    || gt('pv_sds_pos')),
        p(gt('pv_loi_thru_org1') || gt('pv_sds_office2') || gt('pv_sds_office')),
        p(gt('pv_loi_thru_org2') || gt('pv_sds_city2')   || gt('pv_sds_city')),
        blankLine(8),
        p('Dear Sir/Ma\'am,'),
        blankLine(4),
        p('Greetings of peace!'),
        blankLine(4),
        p(gt('pv_loi_p1')),
        blankLine(4),
        p(gt('pv_loi_p2')),
        blankLine(4),
        p(gt('pv_loi_closing')),
        blankLine(4),
        p('Truly yours,'),
        ...sigBlock(gt('pv_principal2'), gt('pv_principal_title2'), gt('pv_principal_contact2')),
        pageBreak(),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAGE 5 — CALENDAR COVER
    ══════════════════════════════════════════════════════════════════ */
    const calCoverSection = centerCoverPage([
        para(run(gtBR('pv_cal_cover_title') || 'SCHOOL CALENDAR', {
            font: SERIF, size: 92, bold: true, color: NAVY,
        }), { align: AlignmentType.CENTER, after: 160 }),
        para(run(gt('pv_cal_cover_sy') || 'S.Y. 2026–2027', {
            font: SERIF, size: 52, italic: true, color: GRAY,
        }), { align: AlignmentType.CENTER }),
    ]);

    /* ══════════════════════════════════════════════════════════════════
       PAGE 6 — CALENDAR SUMMARY
    ══════════════════════════════════════════════════════════════════ */
    const sumRows = Array.from(document.querySelectorAll('#pv_sum_simple tr'));
    const COL1 = Math.round(CONTENT_W * 0.6);
    const COL2 = CONTENT_W - COL1;

    const summaryTableRows = [
        new TableRow({
            tableHeader: true,
            children: [
                new TableCell({
                    borders: ALL_BORDERS, width: { size: COL1, type: WidthType.DXA },
                    shading: { fill: NAVY, type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [para(run('MONTH', { font: SANS, bold: true, size: 20, color: WHITE }),
                                   { align: AlignmentType.LEFT })],
                }),
                new TableCell({
                    borders: ALL_BORDERS, width: { size: COL2, type: WidthType.DXA },
                    shading: { fill: NAVY, type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [para(run('SCHOOL DAYS', { font: SANS, bold: true, size: 20, color: WHITE }),
                                   { align: AlignmentType.CENTER })],
                }),
            ],
        }),
        ...sumRows.map((tr, i) => {
            const tds  = tr.querySelectorAll('td');
            const fill = i % 2 === 0 ? 'F3F4F6' : WHITE;
            return new TableRow({
                children: [
                    new TableCell({
                        borders: ALL_BORDERS, width: { size: COL1, type: WidthType.DXA },
                        shading: { fill, type: ShadingType.CLEAR },
                        margins: { top: 60, bottom: 60, left: 120, right: 120 },
                        children: [para(run((tds[0] || {}).textContent || '', { font: SERIF, size: 22 }))],
                    }),
                    new TableCell({
                        borders: ALL_BORDERS, width: { size: COL2, type: WidthType.DXA },
                        shading: { fill, type: ShadingType.CLEAR },
                        margins: { top: 60, bottom: 60, left: 120, right: 120 },
                        children: [para(run((tds[1] || {}).textContent || '', { font: SERIF, size: 22 }),
                                       { align: AlignmentType.CENTER })],
                    }),
                ],
            });
        }),
    ];

    /* ── School Days per Quarter/Semester table — mirrors #pv_sum_term,
       which buildSummaryTables() populates with term-hdr / sub-total /
       total-row rows. Previously this table was never read, so the
       Quarter/Semester breakdown silently disappeared from the .docx
       export even though it renders fine in the live preview.        */
    const termRowsEls = Array.from(document.querySelectorAll('#pv_sum_term_page tr'));
    const termTableRows = [
        new TableRow({
            tableHeader: true,
            children: [
                new TableCell({
                    borders: ALL_BORDERS, width: { size: COL1, type: WidthType.DXA },
                    shading: { fill: NAVY, type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [para(run('MONTH', { font: SANS, bold: true, size: 20, color: WHITE }),
                                   { align: AlignmentType.LEFT })],
                }),
                new TableCell({
                    borders: ALL_BORDERS, width: { size: COL2, type: WidthType.DXA },
                    shading: { fill: NAVY, type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [para(run('SCHOOL DAYS', { font: SANS, bold: true, size: 20, color: WHITE }),
                                   { align: AlignmentType.CENTER })],
                }),
            ],
        }),
        ...termRowsEls.map((tr, i) => {
            const tds = tr.querySelectorAll('td');
            const isTermHdr  = tr.classList.contains('term-hdr');
            const isSubTotal = tr.classList.contains('sub-total');
            const isTotal    = tr.classList.contains('total-row');

            /* Term/Quarter/Semester header rows span both columns, e.g. "QUARTER 1" */
            if (isTermHdr) {
                return new TableRow({
                    children: [
                        new TableCell({
                            borders: ALL_BORDERS, width: { size: CONTENT_W, type: WidthType.DXA },
                            columnSpan: 2,
                            shading: { fill: 'E8EDF4', type: ShadingType.CLEAR },
                            margins: { top: 60, bottom: 60, left: 120, right: 120 },
                            children: [para(run((tds[0] || {}).textContent || '',
                                               { font: SANS, bold: true, size: 17, color: NAVY }),
                                           { align: AlignmentType.CENTER })],
                        }),
                    ],
                });
            }

            const fill = isTotal ? NAVY : isSubTotal ? 'F0F4F8' : (i % 2 === 0 ? 'F3F4F6' : WHITE);
            const textColor = isTotal ? WHITE : GRAY;
            const fontFace = (isTotal || isSubTotal) ? SANS : SERIF;
            const fontSize = isTotal ? 20 : isSubTotal ? 19 : 22;

            return new TableRow({
                children: [
                    new TableCell({
                        borders: ALL_BORDERS, width: { size: COL1, type: WidthType.DXA },
                        shading: { fill, type: ShadingType.CLEAR },
                        margins: { top: 60, bottom: 60, left: 120, right: 120 },
                        children: [para(run((tds[0] || {}).textContent || '',
                                           { font: fontFace, bold: isTotal || isSubTotal, size: fontSize, color: textColor }),
                                       { align: (isTotal || isSubTotal) ? AlignmentType.CENTER : AlignmentType.LEFT })],
                    }),
                    new TableCell({
                        borders: ALL_BORDERS, width: { size: COL2, type: WidthType.DXA },
                        shading: { fill, type: ShadingType.CLEAR },
                        margins: { top: 60, bottom: 60, left: 120, right: 120 },
                        children: [para(run((tds[1] || {}).textContent || '',
                                           { font: fontFace, bold: isTotal || isSubTotal, size: fontSize, color: textColor }),
                                       { align: AlignmentType.CENTER })],
                    }),
                ],
            });
        }),
    ];

    const summarySection = [
        blankLine(12),
        para(run(gtBR('pv_sum_heading') || 'SCHOOL CALENDAR SUMMARY', {
            font: SANS, bold: true, size: 24, color: NAVY,
        }), { align: AlignmentType.CENTER, after: 160 }),
        new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: [COL1, COL2],
            rows: summaryTableRows,
        }),
        blankLine(10),
        p('Prepared By:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_sum_principal'), gt('pv_sum_principal_title')),
        blankLine(6),
        p('Recommending Approval:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_recommending'), gt('pv_rec_pos'), gt('pv_rec_org')),
        blankLine(6),
        p('Approved:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_approved'), gt('pv_app_pos'), gt('pv_app_org')),
        pageBreak(),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAGE 7 — SCHOOL DAYS PER QUARTER/SEMESTER (own page, mirrors the
       standalone pg-summary-term page in the live builder)
    ══════════════════════════════════════════════════════════════════ */
    const termPageSection = [
        blankLine(12),
        para(run(gtBR('pv_sum_heading') || 'SCHOOL CALENDAR SUMMARY', {
            font: SANS, bold: true, size: 24, color: NAVY,
        }), { align: AlignmentType.CENTER, after: 160 }),
        new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: [COL1, COL2],
            rows: termTableRows,
        }),
        blankLine(10),
        p('Prepared By:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_sum_principal7') || gt('pv_sum_principal'), gt('pv_sum_principal_title7') || gt('pv_sum_principal_title')),
        blankLine(6),
        p('Recommending Approval:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_recommending7') || gt('pv_recommending'), gt('pv_rec_pos7') || gt('pv_rec_pos'), gt('pv_rec_org7') || gt('pv_rec_org')),
        blankLine(6),
        p('Approved:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_approved7') || gt('pv_approved'), gt('pv_app_pos7') || gt('pv_app_pos'), gt('pv_app_org7') || gt('pv_app_org')),
        pageBreak(),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAGE 7 — CHECKLIST
    ══════════════════════════════════════════════════════════════════ */
    const CHK_COLS = [720, Math.round((CONTENT_W - 720) * 0.65), Math.round((CONTENT_W - 720) * 0.35)];
    const chkRows  = getChecklistDisplayItems().map((item, idx) => {
        const remarkText = getChecklistRemarkText(item);
        return new TableRow({
            children: [
                new TableCell({
                    borders: ALL_BORDERS, width: { size: CHK_COLS[0], type: WidthType.DXA },
                    margins: { top: 60, bottom: 60, left: 80, right: 80 },
                    children: [para(run(`${idx + 1}.`, { font: SERIF, size: 22 }))],
                }),
                new TableCell({
                    borders: ALL_BORDERS, width: { size: CHK_COLS[1], type: WidthType.DXA },
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    children: [para(run(item.label || '', { font: SERIF, size: 22 }))],
                }),
                new TableCell({
                    borders: ALL_BORDERS, width: { size: CHK_COLS[2], type: WidthType.DXA },
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    children: [para(run(remarkText, { font: SERIF, size: 22 }))],
                }),
            ],
        });
    });

    const checklistSection = [
        blankLine(12),
        para(run('CHECKLIST FOR SUBMISSION OF CALENDAR ACTIVITIES', {
            font: SANS, bold: true, size: 22, color: NAVY,
        }), { align: AlignmentType.CENTER, after: 160 }),
        para([run('Name of School: ', { font: SANS, bold: true, size: 22 }),
              run(gt('pv_chk_school'), { font: SANS, size: 22 })]),
        para([run('Location/Address: ', { font: SANS, bold: true, size: 22 }),
              run(gt('pv_chk_address'), { font: SANS, size: 22 })]),
        para([run('School ID: ', { font: SANS, bold: true, size: 22 }),
              run(gt('pv_chk_school_id'), { font: SANS, size: 22 })]),
        para([run('Proposed: ', { font: SANS, bold: true, size: 22 }),
              run(gt('pv_chk_proposed'), { font: SANS, size: 22 })]),
        blankLine(12),
        new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: CHK_COLS,
            rows: [
                new TableRow({
                    tableHeader: true,
                    children: ['No.', 'Requirements', 'Remarks'].map((h, i) =>
                        new TableCell({
                            borders: ALL_BORDERS, width: { size: CHK_COLS[i], type: WidthType.DXA },
                            shading: { fill: NAVY, type: ShadingType.CLEAR },
                            margins: { top: 80, bottom: 80, left: 80, right: 80 },
                            children: [para(run(h, { font: SANS, bold: true, size: 20, color: WHITE }))],
                        })
                    ),
                }),
                ...chkRows,
            ],
        }),
        blankLine(12),
        p('Checked by:', { bold: true, font: SANS }),
        ...sigBlock(gt('pv_chk_checked_by'), ''),
        pageBreak(),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAGES 8-9 — MONTHLY CALENDAR
       Layout: 2-column table per month (left = activity list, right = mini-cal)
       SVG markers are reproduced as Unicode equivalents:
         holiday  → ⊠  (boxed X)  red
         activity → □  (square)   dark gray
         exam     → △  (triangle) amber
         start    → ★  circle navy bg
         end      → ■  circle red bg (shown as END label in text)
    ══════════════════════════════════════════════════════════════════ */

    /* Marker legend in text for the mini-cal column */
    function markerSymbol(markType) {
        if (markType === 'holiday')  return { text: '⊠', color: RED };
        if (markType === 'activity') return { text: '□', color: GRAY };
        if (markType === 'exam')     return { text: '△', color: '854D0E' };
        return { text: '●', color: LGRAY };
    }

    /* Strip '#' and uppercase a hex color string (docx wants bare hex). */
    function hexNoHash(hex) {
        return ((hex || '#64748B') + '').replace('#', '').toUpperCase() || '64748B';
    }

    /* Blend a hex color toward white to make a pastel row background,
       mirroring how the built-in categories (holiday/activity/exam) each
       get a light tinted row behind their navy/red/amber text. */
    function tintHex(hex, amt = 0.88) {
        const h = hexNoHash(hex);
        const r = parseInt(h.substr(0, 2), 16) || 0;
        const g = parseInt(h.substr(2, 2), 16) || 0;
        const b = parseInt(h.substr(4, 2), 16) || 0;
        const mix = c => Math.round(c + (255 - c) * amt);
        return [mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function buildMonthBlock(y, m) {
        const MONTH_NAMES_LOCAL = ['January','February','March','April','May','June',
                                    'July','August','September','October','November','December'];
        const DAY_SHORT_LOCAL = ['Su','Mo','Tu','We','Th','Fr','Sa'];

        const mName     = MONTH_NAMES_LOCAL[m];
        const totalDays = daysInMonth(y, m);
        const firstDow  = new Date(y, m, 1).getDay();
        const sd        = schoolDaysInMonth(y, m);

        /* ── opening / closing detection ── */
        const openingRaw = (document.getElementById('f_opening') || {}).value || '';
        const closingRaw = (document.getElementById('f_closing') || {}).value || '';
        let openY=null,openM=null,openD=null,closeY=null,closeM=null,closeD=null;
        if (openingRaw) { const d=new Date(openingRaw+'T00:00'); openY=d.getFullYear(); openM=d.getMonth(); openD=d.getDate(); }
        if (closingRaw) { const d=new Date(closingRaw+'T00:00'); closeY=d.getFullYear(); closeM=d.getMonth(); closeD=d.getDate(); }
        const isOpenMo  = openY===y && openM===m;
        const isCloseMo = closeY===y && closeM===m;

        /* ════════════════════════════════════════════
           RIGHT: mini-cal table  (42% of content width)
           Mirrors the web view exactly:
           • Navy header row with day abbreviations
           • Sun/Sat in soft red
           • Holidays: red text + strikethrough symbol
           • Activities: box symbol + light blue bg
           • Exams: triangle symbol + light amber bg
           • Start/End of classes: navy/red filled cell
           • Class-days footer spanning all 7 cols
        ════════════════════════════════════════════ */
        const CAL_W = Math.round(CONTENT_W * 0.44);
        const cellW = Math.floor(CAL_W / 7);
        const colWs = Array(7).fill(cellW);

        /* Day-header row — matches preview: no fill bar, small colored caps
           text directly on white (sun/sat red, weekdays slate-gray). */
        const headerRow = new TableRow({
            cantSplit: true,
            children: DAY_SHORT_LOCAL.map((d, i) => new TableCell({
                borders: {
                    top:    { style: BorderStyle.NONE },
                    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                    left:   { style: BorderStyle.NONE },
                    right:  { style: BorderStyle.NONE },
                },
                width: { size: colWs[i], type: WidthType.DXA },
                shading: { fill: WHITE, type: ShadingType.CLEAR },
                margins: { top: 30, bottom: 30, left: 10, right: 10 },
                children: [para(run(d.toUpperCase(), {
                    font: SANS, bold: true, size: 13,
                    color: (i===0||i===6) ? 'DC2626' : '64748B',
                }), { align: AlignmentType.CENTER })],
            })),
        });

        /* Day rows */
        const dayRows = [];
        let cells = [];
        let cellCount = 0;

        const NO_CELL_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
        const THIN_BORDERS = { top: NO_CELL_BORDER, bottom: NO_CELL_BORDER, left: NO_CELL_BORDER, right: NO_CELL_BORDER };

        for (let i = 0; i < firstDow; i++) {
            cells.push(new TableCell({
                borders: THIN_BORDERS,
                width: { size: colWs[cellCount%7], type: WidthType.DXA },
                shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
                margins: { top: 36, bottom: 36, left: 10, right: 10 },
                children: [para(run('', { size: 16 }), { align: AlignmentType.CENTER })],
            }));
            cellCount++;
        }

        for (let d = 1; d <= totalDays; d++) {
            if (cellCount > 0 && cellCount % 7 === 0) {
                dayRows.push(new TableRow({ cantSplit: true, children: cells }));
                cells = [];
            }
            const dow    = new Date(y, m, d).getDay();
            const isWknd = dow === 0 || dow === 6;
            const k      = mkKey(y, m, d);
            const mark   = marks[k] || savedMarks[k];
            const isStart = isOpenMo  && d === openD;
            const isEnd   = isCloseMo && d === closeD;

            let fill   = WHITE;
            let txtClr = isWknd ? 'DC2626' : '374151';
            let dayTxt = String(d);
            let prefix = '';
            let strike = false;

            if (isStart && isEnd)        { fill = 'D97706'; txtClr = WHITE; }
            else if (isStart)            { fill = '0A1F3D'; txtClr = WHITE; }
            else if (isEnd)              { fill = '991B1B'; txtClr = WHITE; }
            else if (mark === 'holiday') { fill = 'FEE2E2'; txtClr = 'DC2626'; prefix = '⊠ '; strike = false; }
            else if (mark === 'activity'){ fill = 'EFF6FF'; txtClr = '1D4ED8'; prefix = '□ '; }
            else if (mark === 'exam')    { fill = 'FEF9C3'; txtClr = '854D0E'; prefix = '△ '; }
            else if (mark && legends[mark]) {
                /* Custom user-created legend category — fill the day box
                   with a light tint of the chosen color (mirrors the
                   pastel treatment used for holiday/activity/exam) and
                   color the day number/symbol with the full color. */
                const customLeg   = legends[mark];
                const customColor = hexNoHash(customLeg.color);
                fill   = tintHex(customColor, 0.8);
                txtClr = customColor;
                prefix = (customLeg.symbol || '●') + ' ';
            }
            else if (isWknd)             { fill = 'FFF7F7'; }

            const dayRun = new TextRun({
                text: prefix + dayTxt,
                font: SANS,
                size: 14,
                color: txtClr,
                bold: isStart || isEnd,
                strike: (mark === 'holiday'),
            });

            cells.push(new TableCell({
                borders: THIN_BORDERS,
                width: { size: colWs[cellCount%7], type: WidthType.DXA },
                shading: { fill, type: ShadingType.CLEAR },
                margins: { top: 36, bottom: 36, left: 10, right: 10 },
                children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [dayRun] })],
            }));
            cellCount++;
        }

        /* trailing blank cells */
        const rem = 7 - (cellCount % 7);
        if (rem < 7) {
            for (let i = 0; i < rem; i++) {
                cells.push(new TableCell({
                    borders: THIN_BORDERS,
                    width: { size: colWs[cellCount%7], type: WidthType.DXA },
                    shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
                    margins: { top: 36, bottom: 36, left: 10, right: 10 },
                    children: [para(run('', { size: 16 }), { align: AlignmentType.CENTER })],
                }));
                cellCount++;
            }
        }
        if (cells.length) dayRows.push(new TableRow({ cantSplit: true, children: cells }));

        /* Class days footer */
        dayRows.push(new TableRow({
            cantSplit: true,
            children: [new TableCell({
                borders: {
                    top:    { style: BorderStyle.SINGLE,  size: 4,  color: 'CBD5E1' },
                    bottom: { style: BorderStyle.SINGLE,  size: 4,  color: 'CBD5E1' },
                    left:   { style: BorderStyle.SINGLE,  size: 4,  color: 'CBD5E1' },
                    right:  { style: BorderStyle.SINGLE,  size: 4,  color: 'CBD5E1' },
                },
                columnSpan: 7,
                shading: { fill: 'F1F5F9', type: ShadingType.CLEAR },
                margins: { top: 40, bottom: 40, left: 80, right: 80 },
                children: [para(run(`Class days: ${sd}`, { font: SANS, bold: true, size: 16, color: '0A1F3D' }),
                               { align: AlignmentType.RIGHT })],
            })],
        }));

        const miniCalTable = new Table({
            width: { size: CAL_W, type: WidthType.DXA },
            columnWidths: colWs,
            rows: [headerRow, ...dayRows],
            borders: {
                top:     { style: BorderStyle.NONE },
                bottom:  { style: BorderStyle.NONE },
                left:    { style: BorderStyle.NONE },
                right:   { style: BorderStyle.NONE },
                insideH: { style: BorderStyle.NONE },
                insideV: { style: BorderStyle.NONE },
            },
        });

        /* ════════════════════════════════════════════
           LEFT: activity list  (58% of content width)
           Navy month-name header, then one row per
           date-range entry with day number + symbol + label.
           Mirrors the web view left panel exactly.
        ════════════════════════════════════════════ */
        const ACT_W = CONTENT_W - CAL_W;

        /* Collect & group entries */
        const monthMarks = Object.entries(marks).filter(([k]) => {
            const [ky,km] = k.split('-').map(Number); return ky===y && km===m;
        }).sort((a,b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));

        const monthNoteOnly = Object.entries(savedRemarks).filter(([k]) => {
            const [ky,km] = k.split('-').map(Number); return ky===y && km===m && !savedMarks[k];
        }).map(([k]) => [k, '__note_only__']);

        let combined = [...monthMarks, ...monthNoteOnly];
        const sameStartEnd = openY===closeY && openM===closeM && openD===closeD && openD!==null;
        if (sameStartEnd && isOpenMo && openD) {
            combined.push([mkKey(openY,openM,openD),'__start_end__']);
        } else {
            if (isOpenMo  && openD)  combined.push([mkKey(openY,openM,openD), '__start__']);
            if (isCloseMo && closeD) combined.push([mkKey(closeY,closeM,closeD), '__end__']);
        }
        combined.sort((a,b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));

        const grouped = [];
        combined.forEach(([k,type]) => {
            const day  = parseInt(k.split('-')[2], 10);
            const rmk  = savedRemarks[k] || '';
            const last = grouped[grouped.length-1];
            const canMerge = !!last && last.type===type && last.remark===rmk && day===last.endDay+1 && type!=='__start__';
            if (canMerge) { last.endDay = day; return; }
            grouped.push({ type, remark: rmk, startDay: day, endDay: day });
        });

        /* Activity table rows */
        const ACT_BORDER = { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' };
        const ACT_BORDERS = { top: ACT_BORDER, bottom: ACT_BORDER, left: ACT_BORDER, right: ACT_BORDER };

        const actRows = [
            /* Navy month-name header */
            new TableRow({
                cantSplit: true,
                children: [new TableCell({
                    borders: {
                        top:    { style: BorderStyle.SINGLE, size: 6, color: '0A1F3D' },
                        bottom: { style: BorderStyle.SINGLE, size: 6, color: '0A1F3D' },
                        left:   { style: BorderStyle.SINGLE, size: 6, color: '0A1F3D' },
                        right:  { style: BorderStyle.SINGLE, size: 6, color: '0A1F3D' },
                    },
                    shading: { fill: '0A1F3D', type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [para(run(mName.toUpperCase(), { font: SANS, bold: true, size: 20, color: WHITE }),
                                   { align: AlignmentType.CENTER })],
                })],
            }),
        ];

        if (grouped.length === 0) {
            actRows.push(new TableRow({
                cantSplit: true,
                children: [new TableCell({
                    borders: ACT_BORDERS,
                    margins: { top: 60, bottom: 60, left: 120, right: 80 },
                    children: [para(run('— No activities marked', { font: SERIF, size: 18, color: '94A3B8', italic: true }))],
                })],
            }));
        } else {
            grouped.forEach((entry, idx) => {
                const dayLabel = entry.startDay === entry.endDay
                    ? String(entry.startDay)
                    : `${entry.startDay}–${entry.endDay}`;

                let symTxt, symColor, labelTxt, labelColor, rowFill;

                if (entry.type === '__start_end__') {
                    symTxt = '★'; symColor = 'D97706';
                    labelTxt = 'Start and End of Classes'; labelColor = 'D97706';
                    rowFill = 'FFFBEB';
                } else if (entry.type === '__start__') {
                    symTxt = '★'; symColor = '0A1F3D';
                    labelTxt = 'Start of Classes'; labelColor = '0A1F3D';
                    rowFill = 'EFF6FF';
                } else if (entry.type === '__end__') {
                    symTxt = '■'; symColor = '991B1B';
                    labelTxt = 'End of Classes'; labelColor = '991B1B';
                    rowFill = 'FEE2E2';
                } else if (entry.type === '__note_only__') {
                    symTxt = '✎'; symColor = '64748B';
                    labelTxt = entry.remark ? entry.remark : 'Note';
                    labelColor = '374151'; rowFill = 'F8FAFC';
                } else {
                    const leg = legends[entry.type] || { label: entry.type, color: '#64748B', symbol: '●' };
                    labelTxt = entry.remark || leg.label;
                    if (entry.type === 'holiday')  { const sym = markerSymbol('holiday');  symTxt = sym.text; symColor = sym.color; labelColor = 'DC2626'; rowFill = 'FEF2F2'; }
                    else if (entry.type === 'activity') { const sym = markerSymbol('activity'); symTxt = sym.text; symColor = sym.color; labelColor = '1D4ED8'; rowFill = 'F0F7FF'; }
                    else if (entry.type === 'exam')     { const sym = markerSymbol('exam');     symTxt = sym.text; symColor = sym.color; labelColor = '854D0E'; rowFill = 'FFFBEB'; }
                    else {
                        /* Custom user-created category — use the actual color
                           they picked in the legend color swatch, not a
                           generic gray dot. */
                        const customColor = hexNoHash(leg.color);
                        symTxt = leg.symbol || '●';
                        symColor = customColor;
                        labelColor = customColor;
                        rowFill = tintHex(customColor, 0.9);
                    }
                }

                actRows.push(new TableRow({
                    cantSplit: true,
                    children: [new TableCell({
                        borders: ACT_BORDERS,
                        shading: { fill: rowFill, type: ShadingType.CLEAR },
                        margins: { top: 60, bottom: 60, left: 120, right: 80 },
                        children: [new Paragraph({
                            spacing: { before: 0, after: 0 },
                            children: [
                                new TextRun({ text: dayLabel, font: SANS, bold: true, size: 20, color: '0A1F3D' }),
                                new TextRun({ text: '   ' + symTxt + '  ', font: SANS, bold: true, size: 18, color: symColor }),
                                new TextRun({ text: labelTxt, font: SERIF, size: 20, color: labelColor }),
                            ],
                        })],
                    })],
                }));
            });
        }

        const actTable = new Table({
            width: { size: ACT_W, type: WidthType.DXA },
            columnWidths: [ACT_W],
            rows: actRows,
            borders: {
                top:     { style: BorderStyle.NONE },
                bottom:  { style: BorderStyle.NONE },
                left:    { style: BorderStyle.NONE },
                right:   { style: BorderStyle.NONE },
                insideH: { style: BorderStyle.NONE },
                insideV: { style: BorderStyle.NONE },
            },
        });

        /* ── Outer wrapper: [activity list | mini-cal] ── */
        return [
            new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: [ACT_W, CAL_W],
                borders: {
                    top:     { style: BorderStyle.SINGLE, size: 8, color: '0A1F3D' },
                    bottom:  { style: BorderStyle.SINGLE, size: 8, color: '0A1F3D' },
                    left:    { style: BorderStyle.SINGLE, size: 8, color: '0A1F3D' },
                    right:   { style: BorderStyle.SINGLE, size: 8, color: '0A1F3D' },
                    insideH: { style: BorderStyle.NONE },
                    insideV: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1' },
                },
                rows: [new TableRow({
                    children: [
                        new TableCell({
                            borders: NO_BORDERS,
                            width: { size: ACT_W, type: WidthType.DXA },
                            verticalAlign: VerticalAlign.TOP,
                            children: [actTable],
                        }),
                        new TableCell({
                            borders: NO_BORDERS,
                            width: { size: CAL_W, type: WidthType.DXA },
                            verticalAlign: VerticalAlign.TOP,
                            margins: { top: 0, bottom: 0, left: 80, right: 0 },
                            children: [
                                para(run(mName, { font: SANS, bold: true, size: 20, color: NAVY }),
                                     { align: AlignmentType.CENTER, after: 60 }),
                                miniCalTable,
                            ],
                        }),
                    ],
                })],
            }),
            blankLine(4),
        ];
    }

    /* Legend box appended after month grid 2 */
    function legendSection() {
        const LGND_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' };
        const items = [
            { symbol: '⊠', color: RED,      label: 'Declared Holidays' },
            { symbol: '□', color: '1D4ED8', label: 'School activities' },
            { symbol: '△', color: '854D0E', label: 'Quarter examination' },
            { symbol: '★', color: NAVY,     label: 'Start of Classes' },
            { symbol: '■', color: '991B1B', label: 'End of Classes' },
        ];
        /* Append any custom categories the user created in the Calendar
           Picker — using their real chosen color and symbol, not a
           generic placeholder, so the Word export legend always matches
           what was configured (and matches the day-box colors above). */
        Object.entries(legends).forEach(([key, leg]) => {
            if (DEFAULT_LEGENDS[key]) return; // holiday/activity/exam already covered above
            items.push({ symbol: leg.symbol || '●', color: hexNoHash(leg.color), label: leg.label || key });
        });
        const COLS_PER_ROW = 5;
        const legendRows = [];
        for (let i = 0; i < items.length; i += COLS_PER_ROW) {
            legendRows.push(items.slice(i, i + COLS_PER_ROW));
        }
        return [
            blankLine(8),
            new Table({
                width: { size: CONTENT_W, type: WidthType.DXA },
                columnWidths: [CONTENT_W],
                borders: {
                    top:     LGND_BORDER, bottom: LGND_BORDER,
                    left:    LGND_BORDER, right:  LGND_BORDER,
                    insideH: { style: BorderStyle.NONE },
                    insideV: { style: BorderStyle.NONE },
                },
                rows: [new TableRow({
                    children: [new TableCell({
                        shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
                        margins: { top: 100, bottom: 100, left: 160, right: 160 },
                        children: [
                            para(run('Legend:', { font: SANS, bold: true, size: 22, color: NAVY }), { after: 80 }),
                            new Table({
                                width: { size: CONTENT_W - 320, type: WidthType.DXA },
                                columnWidths: Array(COLS_PER_ROW).fill(Math.floor((CONTENT_W - 320) / COLS_PER_ROW)),
                                borders: {
                                    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                                    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
                                    insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE },
                                },
                                rows: legendRows.map(rowItems => new TableRow({
                                    children: Array.from({ length: COLS_PER_ROW }, (_, ci) => rowItems[ci]).map(it => new TableCell({
                                        borders: {
                                            top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                                            left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
                                        },
                                        margins: { top: 30, bottom: 30, left: 40, right: 40 },
                                        children: [new Paragraph({
                                            spacing: { before: 0, after: 0 },
                                            children: it ? [
                                                new TextRun({ text: it.symbol + '  ', font: SANS, bold: true, size: 22, color: it.color }),
                                                new TextRun({ text: it.label, font: SERIF, size: 20, color: GRAY }),
                                            ] : [],
                                        })],
                                    })),
                                })),
                            }),
                        ],
                    })],
                })],
            }),
        ];
    }

    /* ── Assemble monthly pages ── */
    function buildMonthlySection(heading, months, appendLegend) {
        const isFirstHalf = months === ACAD_MONTHS.slice(0, 6);
        const rows = [
            blankLine(2),
            para(run(heading, { font: SANS, bold: true, size: 24, color: NAVY }),
                 { align: AlignmentType.CENTER, after: 80 }),
        ];
        months.forEach(({ y, m }) => {
            const block = buildMonthBlock(y, m);
            if (Array.isArray(block)) rows.push(...block);
            else rows.push(block);
        });
        if (appendLegend) rows.push(...legendSection());
        return rows;
    }

    const heading1 = gt('pv_monthly_heading_1') || 'SCHOOL CALENDAR';
    const heading2 = gt('pv_monthly_heading_2') || 'SCHOOL CALENDAR';

    const monthly1 = buildMonthlySection(heading1, ACAD_MONTHS.slice(0, 6), false);
    const monthly2 = buildMonthlySection(heading2, ACAD_MONTHS.slice(6),    true);
    monthly2.unshift(pageBreak());

    /* ══════════════════════════════════════════════════════════════════
       ASSEMBLE & DOWNLOAD
    ══════════════════════════════════════════════════════════════════ */
    const allChildren = [
        ...coverSection,
        ...transmittalSection,
        ...loiCoverSection,
        ...loiSection,
        ...calCoverSection,
        ...summarySection,
        ...termPageSection,
        ...checklistSection,
        ...monthly1,
        ...monthly2,
    ];

    const wordDoc = new Document({
        numbering: {
            config: [{
                reference: 'bullets',
                levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022',
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
            }],
        },
        sections: [{
            properties: {
                page: {
                    size:   { width: PAGE_W, height: PAGE_H },
                    margin: { top: MARGIN + 720, right: MARGIN, bottom: MARGIN, left: MARGIN,
                              header: 360 },
                },
            },
            headers: {
                default: new Header({ children: letterheadHeader() }),
            },
            children: allChildren,
        }],
    });

    const blob = await Packer.toBlob(wordDoc);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (buildCalendarDocumentTitle && buildCalendarDocumentTitle() || 'school-calendar') + '.docx';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}


/* ══════════════════════════════════════════════════════════════════════════
   SAVE / BUILD PAYLOAD
══════════════════════════════════════════════════════════════════════════ */
function buildCalendarDocumentTitle() {
    const school = v('f_school') || 'School';
    const sy1 = v('f_sy1') || '20__', sy2 = v('f_sy2') || '20__';
    const dept  = v('f_dept') || 'Elementary School';
    // Include dept level so JHS, SHS, and Elem calendars for the same school
    // year get distinct titles and never collide as duplicates in the DB.
    return `School Calendar - ${school} - ${dept} (${sy1}-${sy2})`;
}
function buildCalendarSavePayload() {
    const formIds = [
        'f_school','f_dept','f_sid','f_gov','f_sy1','f_sy2','f_opening','f_closing','f_period_override',
        'f_rcvby','f_rcvctrl',
        'f_chk_school','f_chk_address','f_chk_school_id','f_chk_proposed','f_chk_checked_by',
        'f_rd_name','f_rd_pos','f_rd_office','f_sds_name','f_sds_pos','f_sds_office',
        'f_sds_city','f_attached','f_loi_date','f_loi_salutation','f_loi_greeting',
        'f_loi_to_name','f_loi_to_pos','f_loi_to_org1','f_loi_to_org2','f_loi_to_org3',
        'f_loi_to_org4','f_loi_thru_name','f_loi_thru_pos','f_loi_thru_org1','f_loi_thru_org2',
        'f_loi_p1','f_loi_p2','f_loi_closing','f_loi_complclose',
        'f_principal','f_principal_title','f_principal_contact','f_recommending','f_rec_pos','f_rec_org',
        'f_approved','f_app_pos','f_app_org','f_app_org2','f_app_org3','f_app_org4'
    ];
    const formData = {};
    formIds.forEach(id => { const el = document.getElementById(id); if (el) formData[id] = el.value; });
    const thruValues = getTransmittalThruValues();
    formData.f_loi_thru_name = formData.f_loi_thru_name || thruValues.name;
    formData.f_loi_thru_pos = formData.f_loi_thru_pos || thruValues.pos;
    formData.f_loi_thru_org1 = formData.f_loi_thru_org1 || thruValues.org1;
    formData.f_loi_thru_org2 = formData.f_loi_thru_org2 || thruValues.org2;
    const storedLogo = localStorage.getItem('edu_school_logo') || '';
    // totalDays is computed client-side (legend/weekend rules live in JS) and
    // stored as a lightweight summary column server-side, so the saved-docs
    // list can show it on every card without re-deriving it per row.
    return { form: formData, marks, savedMarks, remarks, savedRemarks, legends, logoDataUrl: logoDataUrl || storedLogo, active_tab: currentActivePage, totalDays: computeGrandTotal() };
}
/* ── Autosave status tracking (UX Issue B) ───────────────────────────────
   Tracks whether the form has unsaved changes ("dirty") and the timestamp
   of the last successful save. Call _markFormDirty() on any user edit to
   show "● Unsaved changes". Call _updateSaveStatus(updatedAt) after a
   successful save to show "Last saved X min ago".                          */
let _lastSavedAt = null;
let _formIsDirty = false;
let _saveStatusTimer = null;

function _markFormDirty() {
    if (_formIsDirty) return;
    _formIsDirty = true;
    _renderSaveStatus();
}
function _updateSaveStatus(serverUpdatedAt) {
    _formIsDirty = false;
    _lastSavedAt = serverUpdatedAt ? new Date(serverUpdatedAt) : new Date();
    _renderSaveStatus();
    clearInterval(_saveStatusTimer);
    _saveStatusTimer = setInterval(_renderSaveStatus, 60000); // refresh "X min ago" every minute
}
function _renderSaveStatus() {
    const el = document.getElementById('calSaveStatusLabel');
    if (!el) return;
    if (_formIsDirty) {
        el.className = 'cal-save-status status-dirty';
        el.innerHTML = '<span class="css-dot">●</span> Unsaved changes';
        return;
    }
    if (!_lastSavedAt) {
        el.className = 'cal-save-status status-saved';
        el.innerHTML = '<span class="css-dot">●</span> Draft';
        return;
    }
    const diffMs  = Date.now() - _lastSavedAt.getTime();
    const diffMin = Math.round(diffMs / 60000);
    const label   = diffMin < 1 ? 'just now' : diffMin === 1 ? '1 min ago' : `${diffMin} min ago`;
    el.className = 'cal-save-status status-saved';
    el.innerHTML = `<span class="css-dot">●</span> Last saved ${label}`;
}

async function calSaveCalendar() {
    if (_builderLocked) { showToast('This calendar is locked. Request edit approval first.', 'fa-lock'); return false; }
    const schoolName = v('f_school') || (localStorage.getItem('edu_school_name') || '').trim();
    if (!schoolName) { calShowToast('Please enter the School / Institution Name.', 'error'); return false; }
    const schoolField = document.getElementById('f_school');
    if (schoolField && !schoolField.value.trim()) schoolField.value = schoolName;
    const saveBtn = document.getElementById('calBtnSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ document_id: currentCalendarDocumentId, title: buildCalendarDocumentTitle(), status: 'draft', payload: buildCalendarSavePayload() }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || 'Save failed.');
        const hadNoDocId = !currentCalendarDocumentId;
        currentCalendarDocumentId = json.data?.document_id ?? currentCalendarDocumentId;
        _updateSaveStatus(json.data?.updated_at || null); // UX Issue B
        // First save of a brand-new draft — the checklist's upload controls
        // were disabled ("save first") until a document id existed, so
        // refresh them now that one does.
        if (hadNoDocId && currentCalendarDocumentId) renderChecklistFormFields();
        calShowToast('School calendar saved successfully!', 'success');
        if (saveBtn) { saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!'; }
        setTimeout(() => {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Calendar'; }
        }, 2000);
        return true;
    } catch (err) {
        calShowToast('Save failed: ' + (err.message || 'Unknown error'), 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Calendar'; }
        return false;
    }
}
let calToastTimer = null;
function calShowToast(msg, type) {
    let toast = document.getElementById('calToastNotification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'calToastNotification';
        toast.className = 'cal-toast';
        document.body.appendChild(toast);
    }
    clearTimeout(calToastTimer);
    toast.className = 'cal-toast ' + (type || '');
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-xmark' : 'fa-circle-info'}"></i> ${escHtml(msg)}`;
    requestAnimationFrame(() => { toast.classList.add('show'); });
    calToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3500);
}

/* ══════════════════════════════════════════════════════════════════════════
   HYDRATE FROM SAVED DOCUMENT
══════════════════════════════════════════════════════════════════════════ */
/* ── Levels Offered: derive the list of department levels a school actually
   offers (from its own registration data, edu_grade / school.grade) so the
   calendar only lets a user pick among levels the school really has —
   instead of a generic fixed list — and so multiple calendars (one per
   level, e.g. JHS *and* SHS) can be created from real data. ───────────── */
const LEVEL_LABEL_ORDER = ['Kindergarten', 'Preschool', 'Elementary School', 'Junior High School', 'Senior High School', 'College', 'SPED'];
/* Maps a registration level code to one or more labels. Most codes map
   1:1, but some schools' registration only has a single, ambiguous
   "Pre-Elementary" checkbox (code 'pre') that doesn't distinguish
   Kindergarten from Preschool. Rather than guess and silently lock a
   school into the wrong one, an ambiguous code surfaces BOTH labels so
   the user can pick whichever matches what they actually run. */
const LEVEL_CODE_TO_LABELS = {
    'kinder': ['Kindergarten'], 'kindergarten': ['Kindergarten'], 'kg': ['Kindergarten'], 'k': ['Kindergarten'],
    'preschool': ['Preschool'], 'pre-school': ['Preschool'], 'prek': ['Preschool'], 'pre-k': ['Preschool'], 'nursery': ['Preschool'],
    'pre': ['Kindergarten', 'Preschool'],
    'elem': ['Elementary School'], 'elementary': ['Elementary School'], 'elementary school': ['Elementary School'], 'elementary department': ['Elementary School'],
    'jhs': ['Junior High School'], 'junior': ['Junior High School'], 'junior high': ['Junior High School'], 'junior high school': ['Junior High School'],
    'shs': ['Senior High School'], 'senior': ['Senior High School'], 'senior high': ['Senior High School'], 'senior high school': ['Senior High School'],
    'college': ['College'],
    'sped': ['SPED'],
};
function _levelCodeToLabels(code) {
    const key = String(code || '').trim().toLowerCase();
    if (!key) return [];
    return LEVEL_CODE_TO_LABELS[key] || [String(code).trim()];
}
/* Returns the school's offered levels as an array of normalized, deduped
   labels (e.g. ['Junior High School', 'Senior High School']), derived from
   the raw edu_grade value. Handles a JSON array from registration
   checkboxes (e.g. '["jhs","shs"]'), a single code ('jhs'), or an already
   human-readable label. Returns [] when nothing usable is stored, so
   callers can fall back to the generic list rather than break the UI. */
function getOfferedLevelLabels(rawGrade) {
    const raw = String(rawGrade || '').trim();
    if (!raw) return [];
    let codes = null;
    if (raw.startsWith('[')) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) codes = parsed;
        } catch (_) { /* not JSON — fall through to single-value handling */ }
    }
    if (!codes) codes = [raw];
    const labels = [...new Set(codes.flatMap(_levelCodeToLabels).filter(Boolean))];
    const ordered = LEVEL_LABEL_ORDER.filter(l => labels.includes(l));
    const extras = labels.filter(l => !LEVEL_LABEL_ORDER.includes(l));
    return ordered.concat(extras);
}
/* Picks ONE default label out of (possibly several) offered levels — used
   only to pre-select the dropdown on first load. The user can still freely
   switch to any other offered level afterward (including the other half
   of an ambiguous 'pre' code), so this default is a convenience, not a
   restriction. */
function normalizeDeptValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Elementary School';
    const labels = getOfferedLevelLabels(raw);
    return labels[0] || raw;
}
/* Rebuilds the #f_dept (School Info) dropdown so it only lists the levels
   this school is actually registered to offer. If the school's data can't
   be parsed into specific levels, the original generic list is left
   untouched so the form still works for schools without this data yet. */
function populateDeptOptionsFromOfferings() {
    const deptSelect = document.getElementById('f_dept');
    if (!deptSelect) return;
    const offered = getOfferedLevelLabels(localStorage.getItem('edu_grade') || '');
    if (!offered.length) return;
    const previousValue = deptSelect.value;
    deptSelect.innerHTML = '';
    offered.forEach(label => {
        const opt = document.createElement('option');
        opt.value = label; opt.textContent = label;
        deptSelect.appendChild(opt);
    });
    const otherOpt = document.createElement('option');
    otherOpt.value = 'Other'; otherOpt.textContent = 'Other';
    deptSelect.appendChild(otherOpt);
    if (offered.includes(previousValue)) deptSelect.value = previousValue;
}
/* Shows/hides and populates the "which level?" selector next to the
   Create New Calendar button on the saved-docs view. Only shown when the
   school offers more than one level — that's what lets a user create a
   separate calendar per level (e.g. JHS and SHS) instead of always
   defaulting to a single one. */
function populateNewCalLevelSelector() {
    const levelSelect = document.getElementById('newCalLevelSelect');
    if (!levelSelect) return;
    const offered = getOfferedLevelLabels(localStorage.getItem('edu_grade') || '');
    if (offered.length <= 1) {
        levelSelect.style.display = 'none';
        levelSelect.innerHTML = '';
        syncCreateNewButtonState();
        return;
    }
    const previousValue = levelSelect.value;
    levelSelect.innerHTML = '';
    offered.forEach(label => {
        const opt = document.createElement('option');
        opt.value = label; opt.textContent = label;
        levelSelect.appendChild(opt);
    });
    levelSelect.style.display = '';
    levelSelect.value = offered.includes(previousValue) ? previousValue : offered[0];
    syncCreateNewButtonState();
}
/* Entry point for the "Create New Calendar Document" button. When the
   school offers multiple levels, syncs the chosen level into the builder's
   School Info dept field first, so the per-level active-submission guard
   in openCalendarBuilder() checks the level the user actually picked. */
function handleCreateNewCalendarClick() {
    const levelSelect = document.getElementById('newCalLevelSelect');
    if (levelSelect && levelSelect.style.display !== 'none' && levelSelect.value) {
        applyDeptSelection(levelSelect.value);
    }
    openCalendarBuilder();
}
function applyDeptSelection(value) {
    const deptSelect = document.getElementById('f_dept');
    if (!deptSelect) return;
    const target = normalizeDeptValue(value);
    const hasOption = Array.from(deptSelect.options).some(opt => opt.value === target);
    if (!hasOption) {
        const custom = document.createElement('option');
        custom.value = target; custom.textContent = target;
        deptSelect.appendChild(custom);
    }
    deptSelect.value = target;
}
function hydrateCalendarFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const form = payload.form && typeof payload.form === 'object' ? payload.form : {};
    const officeOnlyFieldIds = new Set(
        Object.entries(SIG_CAL_FIELDS)
            .filter(([role]) => OFFICE_ONLY_ROLES.includes(role))
            .flatMap(([, fieldMap]) => Object.values(fieldMap))
    );
    Object.entries(form).forEach(([id, value]) => {
        if (officeOnlyFieldIds.has(id)) return;
        const el = document.getElementById(id);
        if (el) el.value = value ?? '';
    });
    if (typeof _applyDefaultSignatories === 'function') _applyDefaultSignatories();
    applyDeptSelection(form.f_dept);
    const replaceObject = (target, source) => {
        Object.keys(target).forEach(k => delete target[k]);
        if (source && typeof source === 'object') Object.entries(source).forEach(([k, v]) => { target[k] = v; });
    };
    replaceObject(marks, payload.marks);
    replaceObject(savedMarks, payload.savedMarks);
    replaceObject(remarks, payload.remarks);
    replaceObject(savedRemarks, payload.savedRemarks);
    Object.keys(legends).forEach(k => delete legends[k]);
    if (payload.legends && typeof payload.legends === 'object') {
        Object.entries(payload.legends).forEach(([k, v]) => { legends[k] = v; });
    } else {
        Object.entries(DEFAULT_LEGENDS).forEach(([k, v]) => { legends[k] = { ...v }; });
    }
    normalizeLegendSettings();
    /* School-wide legends (defaults + this school's custom categories) now
       live in the DB rather than being hard-coded. Once fetched, they take
       priority over whatever was baked into this specific saved document
       — but any legend key used in THIS document's marks that no longer
       exists server-side (e.g. a since-deleted custom category) is kept
       from the payload as a fallback so old marks don't silently lose
       their color/symbol. */
    loadCalendarLegends().then(() => {
        normalizeLegendSettings();
        buildCpModes(); buildCpGrid(); liveUpdate();
    });
    const payloadLogo = typeof payload.logoDataUrl === 'string' ? payload.logoDataUrl.trim() : '';
    if (payloadLogo) {
        logoDataUrl = payloadLogo;
        try { localStorage.setItem('edu_school_logo', payloadLogo); } catch (_) {}
    } else if (!logoDataUrl) {
        const savedLogo = localStorage.getItem('edu_school_logo') || '';
        if (savedLogo) { logoDataUrl = savedLogo; }
    }
    applyCalendarLogo(logoDataUrl);
    buildCpModes(); buildCpGrid(); liveUpdate();
    Promise.all([loadCalendarChecklistItems(), loadSupportingUploads(true)]).then(() => { renderChecklistFormFields(); liveUpdate(); });
    if (payload.active_tab) _switchPageBase(payload.active_tab);
}

/* ══════════════════════════════════════════════════════════════════════════
   SAVED DOCS VIEW
══════════════════════════════════════════════════════════════════════════ */
function setBuilderModeUi(isBuilderOpen) {
    const pageHeader = document.querySelector('.page-header');
    if (pageHeader) pageHeader.style.display = isBuilderOpen ? 'none' : '';
    // UX Issue D: surface Export PDF as a visible top-bar button when the builder is open
    const exportBtn = document.getElementById('calBtnExportPdf');
    if (exportBtn) exportBtn.style.display = isBuilderOpen ? '' : 'none';
}
/* ── Helper: statuses that mean a doc is actively in-flight (not editable / replaceable) ── */
const ACTIVE_SUBMISSION_STATUSES = ['submitted','pending','pending-review','review','endorsed','approved','for-endorsement'];

/* Levels that are considered equivalent for the one-submission-per-level rule.
   If a school has a Kindergarten submission under review, Preschool is also
   blocked (and vice versa) because they represent the same school level. */
const LEVEL_EQUIVALENCE_GROUPS = [
    ['kindergarten', 'preschool', 'pre-school', 'kinder', 'nursery', 'pre-elementary'],
    ['elementary school', 'elementary'],
    ['junior high school', 'junior high', 'jhs'],
    ['senior high school', 'senior high', 'shs'],
];

/* Returns the equivalence group for a given level label, or a single-item
   array with just the label itself if no group matches. */
function _getLevelGroup(label) {
    const lower = String(label || '').toLowerCase().trim();
    const group = LEVEL_EQUIVALENCE_GROUPS.find(g => g.includes(lower));
    return group || [lower];
}

/* Returns the first active (under-review) calendar doc, optionally filtered
   by dept level so that a school with both JHS and SHS can build calendars
   for each independently — one level being under review does not block the
   other. Pass deptLabel (e.g. 'Senior High School') to scope the check.    */
function getActiveSubmissionDoc(deptLabel = null) {
    return allCalendarDocs.find(d => {
        if (String(d.edit_request_status || '').toLowerCase() === 'approved') return false;
        const s = String(d.workflow_status || d.status || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
        if (!ACTIVE_SUBMISSION_STATUSES.includes(s)) return false;
        // Match by department column first (reliable), fall back to title substring
        // only when department is not stored (older documents saved before the
        // summary columns were added).
        if (deptLabel) {
            const targetGroup = _getLevelGroup(deptLabel);
            const storedDept  = String(d.department || '').toLowerCase().trim();
            if (storedDept) {
                // Block if the stored dept is in the same equivalence group
                if (!targetGroup.includes(storedDept)) return false;
            } else {
                // Fallback: check title substring for pre-summary-column docs
                const titleLower = String(d.title || '').toLowerCase();
                if (!targetGroup.some(alias => titleLower.includes(alias))) return false;
            }
        }
        return true;
    }) || null;
}

/* Returns the dept/level a new calendar would be created for. Prefers the
   "which level?" selector on the saved-docs view (so the active-submission
   guard checks the level the user is about to create, before the builder
   even opens); falls back to the builder's own School Info field. */
function _currentDeptLabel() {
    const levelSelect = document.getElementById('newCalLevelSelect');
    if (levelSelect && levelSelect.style.display !== 'none' && levelSelect.value) {
        return levelSelect.value.trim();
    }
    return (document.getElementById('f_dept')?.value || '').trim();
}

async function openCalendarBuilder(documentId = null) {
    setBuilderModeUi(true);
    document.getElementById('savedDocsView').style.display = 'none';
    document.getElementById('builderShell').style.display = 'flex';

    if (!builderInitialized) {
        liveUpdate(); buildCpModes(); _switchPageBase('pg-cover');
        builderInitialized = true;
    }

    if (!documentId) {
        /* ── GUARD: block new creation if an active submission for the SAME
           department level already exists. A school with JHS AND SHS can
           build both calendars independently — each level is checked separately. */
        const currentDept = _currentDeptLabel();
        const activeDoc = getActiveSubmissionDoc(currentDept || null);
        if (activeDoc) {
            /* Snap back to saved-docs view immediately */
            setBuilderModeUi(false);
            document.getElementById('builderShell').style.display = 'none';
            document.getElementById('savedDocsView').style.display = 'block';

            /* Show a blocking modal explaining why */
            _showActiveSubmissionBlockModal(activeDoc, currentDept);
            return;
        }

        currentCalendarDocumentId = null;
        resetDocFlowNavigation();
        _switchPageBase('pg-cover');
        unlockBuilder();
        lockDeptField();
        hideReturnedBanner();
        loadSupportingUploads().then(renderChecklistFormFields);
        /* Re-paint the cover page / preview now that f_dept may have just been
           changed by applyDeptSelection() above. liveUpdate() is what actually
           renders the dept/level text — without this call here, if the builder
           was already initialized earlier in the session (e.g. the user
           previously opened/viewed another saved document), the preview keeps
           showing the OLD level even though the f_dept field itself is correct. */
        liveUpdate();
        setTimeout(() => {
            renderBuilderStepper(); renderMonthHealthPanel(); injectSubmitFinalButton();
            // UX Issue A: Only auto-open the help tour if the user is already at Step 3
            // (Mark Dates) or later — never interrupt Step 1 (School Info) or Step 2 (Letters).
            if (currentBuilderStep >= 3 && !localStorage.getItem('edu_cal_tour_seen')) setTimeout(openHelp, 600);
        }, 200);
        return;
    }

    try {
        const res = await fetch(`${CALENDAR_API}?document_id=${encodeURIComponent(documentId)}&include_payload=1`, { credentials: 'include' });
        const payload = await res.json();
        if (!payload.success) throw new Error(payload.message || 'Failed to load document.');
        const documentData = payload.data?.document || {};
        const hydratePayload = (documentData.payload && typeof documentData.payload === 'object')
            ? { ...documentData.payload } : {};
        if (!hydratePayload.active_tab && documentData.active_tab) hydratePayload.active_tab = documentData.active_tab;
        currentCalendarDocumentId = documentData.id || null;
        hydrateCalendarFromPayload(hydratePayload);
        /* Restore doc-flow position */
        restoreDocFlowFromActiveTab(hydratePayload.active_tab || 'pg-cover');
    } catch (err) {
        showToast(err.message || 'Could not load saved document.', 'fa-triangle-exclamation');
    }

    setTimeout(() => {
        renderBuilderStepper(); renderMonthHealthPanel(); injectSubmitFinalButton();

        /* Apply correct lock / banner state */
        const doc = allCalendarDocs.find(d => Number(d.id) === Number(documentId));
        const effectiveStatus = String(doc?.workflow_status || doc?.status || '').toLowerCase().replace(/\s+/g, '_');
        const editApproved = String(doc?.edit_request_status || '').toLowerCase() === 'approved';
        if (editApproved) {
            /* SDO approved an edit request — unlock the builder and show the edit banner */
            unlockBuilder(); lockDeptField(); hideReturnedBanner();
            _showEditApprovedBanner();
            const finalBtn = document.getElementById('calBtnFinalSubmit');
            if (finalBtn) finalBtn.style.display = '';
        } else if (_isReturnedStatus(effectiveStatus)) {
            unlockBuilder(); lockDeptField(); showReturnedBanner(doc?.admin_remarks || '');
            const finalBtn = document.getElementById('calBtnFinalSubmit');
            if (finalBtn) finalBtn.style.display = 'none';
        } else if (['submitted','pending','pending_review','review','endorsed','for_endorsement','approved','released_to_school'].includes(effectiveStatus)) {
            lockBuilderForSubmitted(); hideReturnedBanner();
        } else {
            unlockBuilder(); lockDeptField(); hideReturnedBanner();
            const finalBtn = document.getElementById('calBtnFinalSubmit');
            if (finalBtn) finalBtn.style.display = '';
        }

        // UX Issue A: Only auto-open the help tour if the user is at Step 3 or later.
        if (currentBuilderStep >= 3 && !localStorage.getItem('edu_cal_tour_seen')) setTimeout(openHelp, 600);
    }, 250);
}
function backToSavedDocs() {
    setBuilderModeUi(false);
    document.getElementById('builderShell').style.display = 'none';
    document.getElementById('savedDocsView').style.display = 'block';
    loadSavedCalendarDocs();
}

/* ── Modal shown when user tries to create a new doc while one is in-flight ── */
function _showActiveSubmissionBlockModal(activeDoc, deptLabel = null) {
    const existing = document.getElementById('activeSubmissionBlockOverlay');
    if (existing) existing.remove();

    const statusLabel = {
        'submitted': 'Submitted — awaiting review',
        'pending': 'Pending Review',
        'pending-review': 'Pending Review',
        'review': 'Under SDO Evaluation',
        'endorsed': 'Endorsed',
        'approved': 'Approved by SDO',
        'for-endorsement': 'For Endorsement',
    }[String(activeDoc.workflow_status || activeDoc.status || '').toLowerCase().trim().replace(/[\s_]+/g,'-')] || 'In Progress';

    const docTitle = escHtml(activeDoc.title || 'Untitled Calendar');
    const overlay = document.createElement('div');
    overlay.id = 'activeSubmissionBlockOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
        <div style="background:#fff;border-radius:14px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden;">
            <div style="background:#1e3a5f;padding:20px 24px;display:flex;align-items:center;gap:12px;">
                <div style="width:38px;height:38px;background:rgba(255,255,255,0.15);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <i class="fa-solid fa-lock" style="color:#fff;font-size:16px;"></i>
                </div>
                <div>
                    <h3 style="margin:0;color:#fff;font-size:15px;font-weight:700;">Cannot Create New Calendar</h3>
                    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:12px;margin-top:2px;">You already have an active submission under review.</p>
                </div>
            </div>
            <div style="padding:20px 24px;">
                <div style="background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
                    <div style="font-size:11px;font-weight:600;color:#0369a1;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;">Currently Active Submission</div>
                    <div style="font-size:13px;font-weight:600;color:#0c4a6e;">${docTitle}</div>
                    <div style="margin-top:5px;display:flex;align-items:center;gap:6px;">
                        <span style="display:inline-flex;align-items:center;gap:5px;background:#fef9c3;border:1px solid #fde047;color:#854d0e;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;">
                            <i class="fa-solid fa-clock" style="font-size:9px;"></i> ${escHtml(statusLabel)}
                        </span>
                    </div>
                </div>
                <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 6px;">
                    Only <strong>one calendar submission per department level per school year</strong> is allowed at a time.
                    ${deptLabel ? `You already have a <strong>${escHtml(deptLabel)}</strong> calendar pending SDO review.` : 'You already have a calendar pending SDO review for this level.'}
                    If your school has multiple levels (e.g. JHS <em>and</em> SHS), you can create a separate calendar for each — just select the other department from the School Info page first.
                </p>
                <p style="font-size:12.5px;color:#6b7280;line-height:1.55;margin:0;">
                    To revise this submission, wait for it to be <strong>returned for revision</strong> by the SDO administrator, or contact your SDO to have it rejected first.
                </p>
            </div>
            <div style="padding:14px 24px 20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #f1f5f9;">
                <button onclick="document.getElementById('activeSubmissionBlockOverlay').remove()"
                    style="padding:9px 20px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#374151;font-size:13px;font-weight:600;cursor:pointer;">
                    Close
                </button>
                <button onclick="document.getElementById('activeSubmissionBlockOverlay').remove(); openCalendarBuilder(${Number(activeDoc.id)})"
                    style="padding:9px 20px;border-radius:8px;border:none;background:#1e3a5f;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">
                    <i class="fa-solid fa-eye"></i> View My Submission
                </button>
            </div>
        </div>`;
    /* Close on backdrop click */
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

/* ── Sync the Create New button state based on active submissions ── */
function syncCreateNewButtonState() {
    const btn = document.getElementById('btnCreateNewCalendar');
    if (!btn) return;
    // Scope the check to the currently selected dept so the button stays
    // enabled when only a different level (e.g. JHS) is under review.
    const currentDept = _currentDeptLabel();
    const activeDoc = getActiveSubmissionDoc(currentDept || null);
    if (activeDoc) {
        btn.disabled = true;
        const levelHint = currentDept ? ` for ${currentDept}` : '';
        btn.title = `You already have a calendar${levelHint} pending review. Wait for SDO to return or approve it before creating another for the same level.`;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
    } else {
        btn.disabled = false;
        btn.title = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
    }
}
async function loadSavedCalendarDocs() {
    const content = document.getElementById('savedDocsContent');
    if (!content) return;
    content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading your saved documents...</p></div>`;
    try {
        const res = await fetch(CALENDAR_API, { credentials: 'include' });
        const payload = await res.json();
        if (!payload.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(payload.message || 'Failed to load saved documents.');
        }
        allCalendarDocs = Array.isArray(payload.data?.documents) ? payload.data.documents : [];
        /* Merge workflow statuses from submissions API */
        try {
            const subRes = await fetch(`${API_BASE}/school-portal-submissions.php?type=calendar&limit=100`, { credentials: 'include' });
            const subJson = await subRes.json();
            const calendarSubs = Array.isArray(subJson?.data?.submissions) ? subJson.data.submissions : [];
            if (calendarSubs.length && allCalendarDocs.length) {
                calendarSubs.sort((a, b) => new Date(b.updated_at||b.submitted_at||0) - new Date(a.updated_at||a.submitted_at||0));
                // Match strictly by calendar_document_id. The previous title/school-year
                // fuzzy matching was removed because every calendar shares the same title
                // template ("School Calendar - <School Name>"), so a brand-new draft could
                // accidentally match an unrelated old submission row (e.g. from a different
                // department) and incorrectly inherit its workflow status — showing a fresh
                // draft as "Pending Review"/"Submitted" in the UI.
                allCalendarDocs.forEach((doc) => {
                    const best = calendarSubs.find(s => String(s.calendar_document_id) === String(doc.id));
                    if (!best) return;
                    doc.workflow_status = best.status;
                    doc.workflow_updated_at = best.updated_at || best.submitted_at || null;
                    doc.admin_remarks = best.remarks || '';
                });
            }
        } catch { /* Keep rendering even if workflow lookup fails */ }
        allCalendarDocs.forEach(doc => { doc.logo_preview = logoDataUrl || ''; });
        renderSavedCalendarDocs();
    } catch (err) {
        content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${escHtml(err.message||'Could not load saved documents.')}</p></div>`;
    }
}
function handleSavedDocsSearch(value) {
    savedDocsSearchTerm = (value || '').toLowerCase().trim();
    renderSavedCalendarDocs();
}
function filterSavedDocs(status) {
    savedDocsStatusFilter = status;
    document.querySelectorAll('#savedDocsView .filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`f-${status}`)?.classList.add('active');
    renderSavedCalendarDocs();
}
function statusCategory(rawStatus, editApproved) {
    if (editApproved) return 'returned';
    switch (rawStatus) {
        case 'draft':                   return 'draft';
        case 'submitted':
        case 'pending-review':
        case 'pending':                 return 'pending';
        case 'review':
        case 'endorsed':
        case 'for-endorsement':         return 'review';
        case 'approved':
        case 'released-to-school':      return 'approved';
        case 'returned':
        case 'returned-for-correction':
        case 'rejected':                return 'returned';
        default:                        return 'draft';
    }
}
function renderSavedCalendarDocs() {
    const content = document.getElementById('savedDocsContent');
    if (!content) return;
    const getEffectiveStatus = (doc) => String(doc.workflow_status || doc.status || 'draft').toLowerCase().trim().replace(/[\s_]+/g,'-');
    const statusMeta = (status) => {
        switch (status) {
            case 'approved':                return { css:'sdc-status-approved',              label:'<i class="fa-solid fa-circle-check"></i> Approved' };
            case 'review':                  return { css:'sdc-status-review',                label:'<i class="fa-solid fa-hourglass-half"></i> Under Review' };
            case 'endorsed':                return { css:'sdc-status-endorsed',              label:'<i class="fa-solid fa-share"></i> Endorsed' };
            case 'rejected':                return { css:'sdc-status-rejected',              label:'<i class="fa-solid fa-circle-xmark"></i> Needs Revision' };
            case 'returned-for-correction':
            case 'returned':                return { css:'sdc-status-returned',              label:'<i class="fa-solid fa-rotate-left"></i> Returned for Correction' };
            case 'for-endorsement':         return { css:'sdc-status-for-endorsement',       label:'<i class="fa-solid fa-paper-plane"></i> For Endorsement' };
            case 'released-to-school':      return { css:'sdc-status-released-to-school',    label:'<i class="fa-solid fa-box-open"></i> Released to School' };
            case 'pending-review':
            case 'pending':                 return { css:'sdc-status-pending',               label:'<i class="fa-solid fa-clock"></i> Pending Review' };
            case 'submitted':               return { css:'sdc-status-submitted',             label:'<i class="fa-solid fa-lock"></i> Submitted' };
            default:                        return { css:'sdc-status-draft',                 label:'<i class="fa-solid fa-pen"></i> Draft' };
        }
    };
    /* ── Always sync the Create New button disabled state ── */
    syncCreateNewButtonState();

    /* ── Inject or remove the active-submission warning banner ──
       Previously rendered one full-paragraph banner per active submission
       (could be 3+ for JHS/SHS/school-wide), costing ~15 lines of vertical
       space before any documents were visible. Now a single compact banner
       lists every active level as a chip, with the explanation written once. */
    document.querySelectorAll('#activeSubmissionBanner').forEach(el => el.remove());
    const activeDocs = allCalendarDocs.filter(d => {
        if (String(d.edit_request_status || '').toLowerCase() === 'approved') return false;
        const s = String(d.workflow_status || d.status || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
        return ACTIVE_SUBMISSION_STATUSES.includes(s);
    });
    if (activeDocs.length) {
        const statusLabelOf = (doc) => ({
            'submitted': 'Submitted — awaiting review',
            'pending': 'Pending Review',
            'pending-review': 'Pending Review',
            'review': 'Under SDO Evaluation',
            'endorsed': 'Endorsed',
            'approved': 'Approved by SDO',
            'for-endorsement': 'For Endorsement',
        }[String(doc.workflow_status || doc.status || '').toLowerCase().trim().replace(/[\s_]+/g,'-')] || 'In Progress');
        const chips = activeDocs.map(doc => {
            const level = doc.department || deptFromTitleFallback(doc.title) || 'School-wide';
            return `<span class="sdc-active-chip"><i class="fa-solid fa-clock"></i> ${escHtml(level)} — ${escHtml(statusLabelOf(doc))}</span>`;
        }).join('');
        const banner = document.createElement('div');
        banner.id = 'activeSubmissionBanner';
        banner.className = 'sdc-active-banner';
        banner.innerHTML = `
            <div class="sdc-active-banner-head">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <strong>${activeDocs.length} Active Submission${activeDocs.length > 1 ? 's' : ''} In Progress</strong>
            </div>
            <div class="sdc-active-banner-list">${chips}</div>
            <p class="sdc-active-banner-note">
                Only one calendar submission per department level per school year is allowed at a time, so you cannot create another calendar for a level shown above while it is under review.
                Schools with multiple levels (e.g. JHS <em>and</em> SHS) can still create calendars for the other levels.
            </p>`;
        content.parentElement.insertBefore(banner, content);
    }

    if (!allCalendarDocs.length) {
        content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-folder-open"></i><p>No saved school calendar documents yet.</p></div>`; return;
    }
    let docs = allCalendarDocs;
    if (savedDocsStatusFilter !== 'all') {
        docs = docs.filter(sub => {
            const editApproved = String(sub.edit_request_status || '').toLowerCase() === 'approved';
            return statusCategory(getEffectiveStatus(sub), editApproved) === savedDocsStatusFilter;
        });
    }
    if (savedDocsSearchTerm) {
        docs = docs.filter(sub => {
            const title    = String(sub.title||'').toLowerCase();
            const status   = getEffectiveStatus(sub);
            const dateText = formatDate(sub.updated_at||sub.created_at).toLowerCase();
            return title.includes(savedDocsSearchTerm) || status.includes(savedDocsSearchTerm) || dateText.includes(savedDocsSearchTerm);
        });
    }
    if (!docs.length) {
        content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No documents match your search.</p></div>`; return;
    }
    content.innerHTML = `<div class="saved-docs-list">${docs.map((sub) => {
        const rawTitle   = sub.title || 'Untitled School Calendar';
        const title      = escHtml(rawTitle);
        const rawStatus  = getEffectiveStatus(sub);
        const dateText   = escHtml(formatDate(sub.updated_at || sub.created_at));
        const docId      = Number(sub.id) || 0;
        const isCurrentDoc = currentCalendarDocumentId && Number(currentCalendarDocumentId) === docId;
        const editApproved = String(sub.edit_request_status || '').toLowerCase() === 'approved';
        const isDraft    = rawStatus === 'draft';
        const RETURNED_STATUSES = ['returned-for-correction','rejected','returned'];
        const isReturned = RETURNED_STATUSES.includes(rawStatus) || editApproved;
        const isSubmitted = !isDraft && !isReturned;
        const logo = sub.logo_preview || '';
        const logoHtml = logo
            ? `<img class="sdc-logo" src="${escHtml(logo)}" alt="School logo">`
            : `<div class="sdc-logo-placeholder"><i class="fa-solid fa-school"></i></div>`;
        const meta = editApproved
            ? { css:'sdc-status-returned', label:'<i class="fa-solid fa-unlock"></i> Edit Approved' }
            : statusMeta(rawStatus);

        /* ── Department / school year / opening / closing dates ──
           Prefer the lightweight backend summary columns; fall back to the
           live builder fields when this card is the document currently
           open in the (hidden) builder DOM, so a freshly-edited doc
           reflects unsaved changes immediately — mirrors the existing
           cachedDays/computeGrandTotal() fallback pattern below. */
        const department = sub.department || (isCurrentDoc ? v('f_dept') : '') || '';
        const schoolYear  = sub.school_year || (isCurrentDoc ? (() => {
            const sy1 = v('f_sy1'), sy2 = v('f_sy2');
            return (sy1 && sy2) ? `${sy1}-${sy2}` : '';
        })() : '');
        const openingRaw = sub.opening_date || (isCurrentDoc ? v('f_opening') : '') || '';
        const closingRaw = sub.closing_date || (isCurrentDoc ? v('f_closing') : '') || '';

        /* ── Shorten the title ── department and school year now have
           their own badges below, so strip them back out of the generated
           "School Calendar - {school} - {dept} (sy1-sy2)" string instead
           of letting the title's ellipsis cut them off mid-word. */
        let shortTitleRaw = rawTitle;
        if (department && schoolYear) {
            const suffix = ` - ${department} (${schoolYear})`;
            if (shortTitleRaw.endsWith(suffix)) shortTitleRaw = shortTitleRaw.slice(0, -suffix.length);
        } else if (schoolYear) {
            const suffix = ` (${schoolYear})`;
            if (shortTitleRaw.endsWith(suffix)) shortTitleRaw = shortTitleRaw.slice(0, -suffix.length);
        }
        const shortTitle = escHtml(shortTitleRaw);

        const cachedDays = typeof sub.total_days === 'number' ? sub.total_days : null;
        const grandTotal = cachedDays !== null ? cachedDays : (isCurrentDoc ? computeGrandTotal() : null);
        const daysKnown  = grandTotal !== null;
        const daysValid  = daysKnown && grandTotal >= 200 && grandTotal <= 220;
        const canSubmit  = isDraft && daysValid;
        let submitTitle, submitStyle, submitOnclick;
        if (isReturned) {
            submitTitle = 'Open builder, correct, and re-submit'; submitStyle = '';
            submitOnclick = `onclick="openCalendarBuilder(${docId}).then(()=>setTimeout(()=>showFinalSubmitDialog(),400))"`;
        } else if (!isDraft) {
            submitTitle = { pending:'Submitted and awaiting review', review:'Under SDO evaluation', endorsed:'Endorsed', approved:'Approved by SDO', rejected:'Returned for revision', submitted:'Already submitted' }[rawStatus] || 'Already submitted';
            submitStyle = 'opacity:0.5;cursor:not-allowed;background:#f1f5f9;color:#9ca3af;border:1px solid #e2e8f0;';
            submitOnclick = '';
        } else if (!daysKnown) {
            submitTitle = 'Open the builder to compute school days first';
            submitStyle = 'opacity:0.55;cursor:not-allowed;background:#f1f5f9;color:#9ca3af;border:1px solid #e2e8f0;';
            submitOnclick = '';
        } else if (!daysValid) {
            const msg = grandTotal < 200 ? `Only ${grandTotal} days — minimum is 200` : `${grandTotal} days — maximum is 220`;
            submitTitle = msg;
            submitStyle = 'opacity:0.55;cursor:not-allowed;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;';
            submitOnclick = `onclick="showToast('${msg}. Open the builder and adjust your calendar.','fa-triangle-exclamation')"`;
        } else {
            submitTitle  = `${grandTotal} days — ready to submit`;
            submitStyle  = 'background:#15803d;color:#fff;border:none;cursor:pointer;';
            submitOnclick = `onclick="openCalendarBuilder(${docId}).then(()=>showFinalSubmitDialog())"`;
        }
        let daysPill = '';
        if (daysKnown && isDraft) {
            daysPill = daysValid
                ? `<div class="sdc-days-pill sdc-days-ok"><i class="fa-solid fa-circle-check"></i> ${grandTotal} days — ready to submit</div>`
                : `<div class="sdc-days-pill sdc-days-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${grandTotal} days — needs 200–220 to submit</div>`;
        }
        const adminRemarks = (isReturned && sub.admin_remarks) ? escHtml(sub.admin_remarks) : '';
        const remarksHtml = adminRemarks
            ? `<div class="sdc-remarks-box">
                <i class="fa-solid fa-comment-dots"></i>
                <div><strong>Admin Remarks:</strong> ${adminRemarks}</div>
            </div>`
            : '';
        // Status is shown once, in the header badge — the progress line now
        // only carries the workflow timestamp (and admin remarks, if any).
        const progressLine = (!isDraft && sub.workflow_updated_at)
            ? `<div class="sdc-progress-line" style="padding:0 14px 8px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
                <span style="font-size:10.5px;color:#9ca3af;"><i class="fa-solid fa-clock" style="margin-right:3px;"></i>Workflow updated ${escHtml(formatDate(sub.workflow_updated_at))}</span>
            </div>${remarksHtml}`
            : remarksHtml;

        /* ── Department + school-year badges ── */
        const deptMeta = department ? deptBadgeMeta(department) : null;
        const badgesRow = (deptMeta || schoolYear)
            ? `<div class="sdc-badges-row">
                ${deptMeta ? `<span class="sdc-dept-badge ${deptMeta.css}"><i class="fa-solid fa-layer-group"></i> ${escHtml(department)}</span>` : ''}
                ${schoolYear ? `<span class="sdc-sy-badge"><i class="fa-solid fa-calendar"></i> S.Y. ${escHtml(schoolYear)}</span>` : ''}
            </div>`
            : '';

        /* ── Compact opens / closes / total-days stats row ──
           Shown on every card up front, so a school doesn't have to open
           the builder just to see when a calendar starts, ends, or how
           many school days it covers. */
        const openingDisplay = fmtPlainDate(openingRaw) || '—';
        const closingDisplay = fmtPlainDate(closingRaw) || '—';
        const daysDisplay    = daysKnown ? String(grandTotal) : '—';
        const daysStatClass  = daysKnown ? (daysValid ? 'sdc-stat-ok' : 'sdc-stat-warn') : '';
        const statsRow = `<div class="sdc-stats-row">
            <div class="sdc-stat"><i class="fa-solid fa-door-open"></i><div class="sdc-stat-text"><span class="sdc-stat-label">Opens</span><span class="sdc-stat-value">${escHtml(openingDisplay)}</span></div></div>
            <div class="sdc-stat"><i class="fa-solid fa-door-closed"></i><div class="sdc-stat-text"><span class="sdc-stat-label">Closes</span><span class="sdc-stat-value">${escHtml(closingDisplay)}</span></div></div>
            <div class="sdc-stat ${daysStatClass}"><i class="fa-solid fa-calendar-day"></i><div class="sdc-stat-text"><span class="sdc-stat-label">School Days</span><span class="sdc-stat-value">${escHtml(daysDisplay)}</span></div></div>
        </div>`;

        return `<div class="saved-doc-card sdc-enhanced">
            <div class="sdc-header">
                ${logoHtml}
                <div class="sdc-title-block">
                    <div class="sdc-title" title="${title}">${shortTitle}</div>
                    <span class="sdc-status-badge ${meta.css}">${meta.label}</span>
                </div>
                ${!isSubmitted ? `<button class="sdc-dots-btn sdc-trash-btn" onclick="deleteCalendarDocument(${docId})" title="Delete">
                    <i class="fa-solid fa-trash-can"></i>
                </button>` : ''}
            </div>
            ${badgesRow}
            ${statsRow}
            <div class="sdc-meta"><i class="fa-solid fa-clock"></i> Last updated: ${dateText}</div>
            ${progressLine}
            <div class="sdc-actions">
                <button class="tba-btn sdc-open-btn" onclick="${isSubmitted ? `window.location.href='school-portal-calendar-submitted.html?document_id=${docId}'` : `openCalendarBuilder(${docId})`}">
                    <i class="fa-solid ${isReturned ? 'fa-pen' : isSubmitted ? 'fa-eye' : 'fa-pen'}"></i>
                    ${isReturned ? 'Open & Edit' : isSubmitted ? 'View' : 'Open Builder'}
                </button>
                <button class="tba-btn ${isReturned ? 'sdc-resubmit-btn' : 'sdc-submit-btn'}" style="${submitStyle}" title="${submitTitle}" ${submitOnclick} ${(canSubmit || isReturned) ? '' : 'disabled'}>
                    <i class="fa-solid fa-paper-plane"></i> ${isReturned ? 'Submit' : 'Final Submit'}
                </button>
            </div>
            ${daysPill}
        </div>`;
    }).join('')}</div>`;
}
function toggleSdcMenu(docId, event) {
    event.stopPropagation();
    const menu = document.getElementById('sdcMenu_' + docId);
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    document.querySelectorAll('.sdc-dots-menu.open').forEach(m => m.classList.remove('open'));
    if (!isOpen) {
        menu.classList.add('open');
        setTimeout(() => {
            document.addEventListener('click', function handler() { menu.classList.remove('open'); document.removeEventListener('click', handler); }, { once: true });
        }, 10);
    }
}
function closeSdcMenu(docId) { document.getElementById('sdcMenu_' + docId)?.classList.remove('open'); }
async function exportSavedDocumentById(docId) {
    try {
        const res = await fetch(`${CALENDAR_API}?document_id=${docId}&include_payload=1`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        const payload = json.data?.document?.payload || {};
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (json.data?.document?.title || 'school-calendar') + '.json';
        a.click(); URL.revokeObjectURL(url);
    } catch (err) { showToast('Export failed: ' + err.message, 'fa-circle-xmark'); }
}
async function deleteCalendarDocument(documentId) {
    const docId = Number(documentId) || 0;
    if (!docId) { showToast('Invalid document selected.', 'fa-triangle-exclamation'); return; }
    if (!confirm('Delete this saved calendar document? This action cannot be undone.')) return;
    try {
        const res = await fetch(`${CALENDAR_API}?document_id=${encodeURIComponent(docId)}`, { method:'DELETE', credentials:'include' });
        const payload = await res.json();
        if (!payload.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(payload.message || 'Failed to delete document.');
        }
        if (currentCalendarDocumentId === docId) currentCalendarDocumentId = null;
        showToast('Calendar document deleted.', 'fa-trash-can');
        await loadSavedCalendarDocs();
    } catch (err) { showToast(err.message || 'Could not delete document.', 'fa-triangle-exclamation'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   HELP / TOUR (from enhanced)
══════════════════════════════════════════════════════════════════════════ */
const TOUR_STEPS = [
    { title:'Welcome to the Calendar Builder!', body:'This tool helps you create and submit your official school calendar for DepEd. Let\'s walk you through the main features.', anchor:null, icon:'fa-graduation-cap' },
    { title:'Step 1 — School Information', body:'Start by filling in your school name, ID, and government recognition number. You can also upload your school logo.', anchor:'#f_school', icon:'fa-school' },
    { title:'Step 2 — Letters', body:'Complete the Transmittal Letter and Letter of Intent tabs with official addresses, signatories, and body text.', anchor:null, icon:'fa-envelope' },
    { title:'Step 3 — Calendar Picker', body:'Click "Calendar Picker" to mark holidays (✕), school activities (□), and exams (△). You can apply marks to a date range.', anchor:null, icon:'fa-calendar-plus' },
    { title:'Step 4 — Check Your Totals', body:'Go to the Summary tab to see the monthly school-day counts. The total must be between 200 and 220 days.', anchor:null, icon:'fa-table-list' },
    { title:'Step 5 — Save & Submit', body:'Click Save to keep a draft at any time. When ready, click "Submit for Final Approval". Once submitted the calendar is locked.', anchor:'#calBtnSave', icon:'fa-paper-plane' },
    { title:'Export Anytime', body:'Use the Export button to download a PDF (via print), a Word document, or a JSON backup of your calendar data.', anchor:null, icon:'fa-download' },
];
let tourStep = 0;
function openHelp() { tourStep = 0; renderTourOverlay(); }
function renderTourOverlay() {
    let overlay = document.getElementById('calTourOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'calTourOverlay'; overlay.className = 'cal-tour-overlay';
        overlay.onclick = (e) => { if (e.target === overlay) closeTour(); };
        document.body.appendChild(overlay);
    }
    const step  = TOUR_STEPS[tourStep];
    const total = TOUR_STEPS.length;
    const isLast = tourStep === total - 1;
    overlay.innerHTML = `
        <div class="cal-tour-modal">
            <div class="ctm-close" onclick="closeTour()"><i class="fa-solid fa-xmark"></i></div>
            <div class="ctm-icon-wrap"><i class="fa-solid ${step.icon} ctm-icon"></i></div>
            <div class="ctm-step-pills">${TOUR_STEPS.map((_,i)=>`<span class="ctm-pip ${i===tourStep?'ctm-pip-active':i<tourStep?'ctm-pip-done':''}"></span>`).join('')}</div>
            <h3 class="ctm-title">${step.title}</h3>
            <p class="ctm-body">${step.body}</p>
            <div class="ctm-footer">
                <button class="ctm-btn ctm-btn-ghost" ${tourStep===0?'onclick="closeTour()"':'onclick="tourPrev()"'}>${tourStep===0?'Skip Tour':'<i class="fa-solid fa-arrow-left"></i> Back'}</button>
                <span class="ctm-counter">${tourStep+1} / ${total}</span>
                <button class="ctm-btn ctm-btn-primary" onclick="${isLast?'closeTour()':'tourNext()'}">${isLast?'<i class="fa-solid fa-check"></i> Got it!':'Next <i class="fa-solid fa-arrow-right"></i>'}</button>
            </div>
        </div>`;
    overlay.style.display = 'flex';
}
function tourNext() { if (tourStep < TOUR_STEPS.length - 1) { tourStep++; renderTourOverlay(); } else closeTour(); }
function tourPrev() { if (tourStep > 0) { tourStep--; renderTourOverlay(); } }
function closeTour() { const overlay = document.getElementById('calTourOverlay'); if (overlay) overlay.style.display = 'none'; localStorage.setItem('edu_cal_tour_seen','1'); }

function injectSubmitFinalButton() {
    const topBarActions = document.querySelector('.top-bar-actions');
    if (!topBarActions || document.getElementById('calBtnFinalSubmit')) return;
    const btn = document.createElement('button');
    btn.id = 'calBtnFinalSubmit'; btn.className = 'tba-btn tba-submit-btn';
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Final Submit';
    btn.onclick = showFinalSubmitDialog;
    topBarActions.appendChild(btn);
}

/* ══════════════════════════════════════════════════════════════════════════
   SIDEBAR / PROFILE INIT
══════════════════════════════════════════════════════════════════════════ */
function initSidebarProfile() {
    const fullName       = localStorage.getItem('edu_full_name')       || 'Portal User';
    const role           = localStorage.getItem('edu_role')            || 'teacher';
    const profilePicture = localStorage.getItem('edu_profile_picture') || '';
    const schoolName     = localStorage.getItem('edu_school_name')     || '—';
    const schoolIdNo     = localStorage.getItem('edu_school_id_no')    || '';
    const schoolLevel    = localStorage.getItem('edu_grade')           || '';
    const district       = localStorage.getItem('edu_district_name')   || '—';
    const schoolAddress  = localStorage.getItem('edu_school_address')  || '';
    const sidebarLine    = schoolAddress || district;
    const elemPrincipal  = localStorage.getItem('edu_elem_principal')  || '';
    const elemContact    = localStorage.getItem('edu_elem_contact')    || '';
    const jhsPrincipal   = localStorage.getItem('edu_jhs_principal')   || '';
    const jhsContact     = localStorage.getItem('edu_jhs_contact')     || '';
    const shsPrincipal   = localStorage.getItem('edu_shs_principal')   || '';
    const shsContact     = localStorage.getItem('edu_shs_contact')     || '';
    const nameEl     = document.getElementById('sidebarName');
    const roleEl     = document.getElementById('sidebarRole');
    const schoolEl   = document.querySelector('.school-pill-name');
    const districtEl = document.querySelector('.school-pill-dist');
    setPortalAvatars(profilePicture, fullName);
    if (nameEl)     nameEl.textContent     = fullName;
    if (roleEl)     roleEl.textContent     = role;
    if (schoolEl)   schoolEl.textContent   = schoolName;
    if (districtEl) districtEl.textContent = sidebarLine;
    const schoolInput = document.getElementById('f_school');
    if (schoolInput && !schoolInput.value.trim() && schoolName !== '—') schoolInput.value = schoolName;
    const chkSchoolInput = document.getElementById('f_chk_school');
    if (chkSchoolInput && !chkSchoolInput.value.trim() && schoolName !== '—') chkSchoolInput.value = schoolName;
    const schoolIdInput = document.getElementById('f_sid');
    if (schoolIdInput && !schoolIdInput.value.trim() && schoolIdNo) schoolIdInput.value = schoolIdNo;
    const chkSchoolIdInput = document.getElementById('f_chk_school_id');
    if (chkSchoolIdInput && !chkSchoolIdInput.value.trim() && schoolIdNo) chkSchoolIdInput.value = schoolIdNo;
    const chkAddressInput = document.getElementById('f_chk_address');
    if (chkAddressInput && !chkAddressInput.value.trim() && schoolAddress) chkAddressInput.value = schoolAddress;

    const level = schoolLevel.toLowerCase();
    let principalName = '';
    let principalContact = '';
    if (/grade\s*(7|8|9|10)/.test(level) || level.includes('junior') || level.includes('jhs')) {
        principalName = jhsPrincipal || '';
        principalContact = jhsContact || '';
    } else if (/grade\s*(11|12)/.test(level) || level.includes('senior') || level.includes('shs')) {
        principalName = shsPrincipal || '';
        principalContact = shsContact || '';
    } else {
        principalName = elemPrincipal || '';
        principalContact = elemContact || '';
    }
    if (!principalName) principalName = elemPrincipal || jhsPrincipal || shsPrincipal || '';
    if (!principalContact) principalContact = elemContact || jhsContact || shsContact || '';

    const principalInput = document.getElementById('f_principal');
    if (principalInput && !principalInput.value.trim() && principalName) principalInput.value = principalName;
    const principalContactInput = document.getElementById('f_principal_contact');
    if (principalContactInput && !principalContactInput.value.trim() && principalContact) principalContactInput.value = principalContact;
    // Restrict the dept dropdown + "which level?" picker to the levels this
    // school actually offers (its own registration data) instead of a
    // generic fixed list, so a user can create one calendar per level.
    populateDeptOptionsFromOfferings();
    populateNewCalLevelSelector();
    // Don't stomp on a level that's already locked in for a document the
    // user has created/opened — this function runs twice (once on page
    // load, once again after loadDashboard()'s fetch resolves), and an
    // unconditional overwrite here was the root cause of the level
    // silently reverting to the default after being correctly selected.
    const deptSelectEl = document.getElementById('f_dept');
    if (!deptSelectEl || !deptSelectEl.disabled) {
        applyDeptSelection(schoolLevel);
    }
    if (!logoDataUrl) {
        const savedLogo = localStorage.getItem('edu_school_logo') || '';
        if (savedLogo) { logoDataUrl = savedLogo; applyCalendarLogo(logoDataUrl); }
    }
    // Set school-year defaults dynamically so the form never needs manual
    // updates each school year. Philippine SY starts in June, so:
    //   Jun–Dec → the new SY just began (currentYear to currentYear+1)
    //   Jan–May → the running SY started last June (currentYear-1 to currentYear)
    const sy1Input = document.getElementById('f_sy1');
    const sy2Input = document.getElementById('f_sy2');
    if (sy1Input && !sy1Input.value.trim()) {
        const now      = new Date();
        const syStart  = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
        sy1Input.value = String(syStart);
        if (sy2Input && !sy2Input.value.trim()) sy2Input.value = String(syStart + 1);
    }
    liveUpdate();
}
async function loadDashboard() {
    /* ── Issue 2: Auth identity must come from the PHP session, not localStorage.
       We call /api/me.php (lightweight session read) for identity, and the
       dashboard endpoint only for its actual dashboard data. Sensitive fields
       (edu_user_id, edu_email, edu_role, edu_school_id, etc.) are NOT written
       to localStorage — they live in httpOnly session cookies on the server.
       Only true UI preferences (school display name, logo, grade level, principal
       names, profile picture) are cached in localStorage for sidebar rendering.  */
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) { if (res.status === 401) window.location.href = 'school-portal.html'; return; }
        const d = data.data;
        if (d.user?.account_type === 'sdo_personnel') { window.location.href = 'school-portal.html'; return; }
        const depedId = d.school?.deped_id || d.school?.school_id_no || '';
        const addressParts = [d.school?.street_address, d.school?.barangay, d.school?.city].filter(Boolean);
        const schoolAddress = addressParts.join(', ');
        // Only non-sensitive UI display values go to localStorage (Issue 2)
        localStorage.setItem('edu_full_name',         d.user.full_name);
        localStorage.setItem('edu_school_approved', d.user.school_approved ? '1' : '0');
        localStorage.setItem('edu_role',              d.user.role || 'teacher');
        localStorage.setItem('edu_profile_picture',   d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',       d.school?.name     || '');
        localStorage.setItem('edu_district_name',     d.school?.district || '');
        localStorage.setItem('edu_school_logo',       d.school?.school_logo || '');
        localStorage.setItem('edu_school_id_no',      depedId);
        localStorage.setItem('edu_grade',             d.school?.grade || '');
        localStorage.setItem('edu_school_address',    schoolAddress);
        localStorage.setItem('edu_elem_principal',    d.school?.elem_principal || '');
        localStorage.setItem('edu_elem_contact',      d.school?.elem_contact || '');
        localStorage.setItem('edu_jhs_principal',     d.school?.jhs_principal || '');
        localStorage.setItem('edu_jhs_contact',       d.school?.jhs_contact || '');
        localStorage.setItem('edu_shs_principal',     d.school?.shs_principal || '');
        localStorage.setItem('edu_shs_contact',       d.school?.shs_contact || '');
        // NOTE: edu_user_id, edu_email, edu_school_id, edu_private_school_id,
        //       edu_account_type, edu_district_id, edu_school_id_no, edu_school_type
        //       are intentionally NOT stored in localStorage — they are sensitive
        //       identity fields that must be read from the PHP session only.
        //       Any code that needs them should call GET /api/me.php.
        initSidebarProfile();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();
        const badge = document.getElementById('pendingBadge');
        if (badge) { const pending = d.stats?.pending ?? 0; badge.textContent = pending; badge.style.display = pending > 0 ? 'inline' : 'none'; }
    } catch (err) { console.error('loadDashboard error:', err); }
}

/* ══════════════════════════════════════════════════════════════════════════
   STYLES — Issue 5: All component CSS has been moved to school-portal-calendar.css.
   The runtime style injection IIFE that previously lived here has been removed.
   If you need to add new component styles, add them directly to the CSS file.
══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   FINAL SUBMIT VISIBILITY
   Hide the Final Submit button/menu-item until all doc-flow pages are saved.
   Previously lived as an inline <script> block in the HTML; moved here so
   it is always loaded after school-portal-calendar.js and never races with
   the DOMContentLoaded handler (Fix #4).
══════════════════════════════════════════════════════════════════════════ */
function _isAllPagesUnlocked() {
    const lastRequiredIndex = Array.isArray(DOC_FLOW_PAGES)
        ? DOC_FLOW_PAGES.indexOf('pg-monthly')
        : -1;
    return lastRequiredIndex >= 0
        && typeof docFlowUnlockedIndex !== 'undefined'
        && docFlowUnlockedIndex >= lastRequiredIndex;
}

function syncFinalSubmitVisibility() {
    const allUnlocked = _isAllPagesUnlocked();
    const dropItem = document.querySelector('.tba-drop-item-submit');
    if (dropItem) dropItem.style.display = allUnlocked ? '' : 'none';
    const finalBtn = document.getElementById('calBtnFinalSubmit');
    if (finalBtn) finalBtn.style.display = allUnlocked ? '' : 'none';
}

/* Hook into syncDocFlowNavLocks so visibility re-syncs on every nav change */
(function () {
    const _orig = window.syncDocFlowNavLocks;
    window.syncDocFlowNavLocks = function () {
        if (typeof _orig === 'function') _orig();
        syncFinalSubmitVisibility();
    };
})();

/* ══════════════════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    setBuilderModeUi(false);
    initSidebarProfile();
    loadSavedCalendarDocs();
    loadDashboard();
    /* Load saved signatories early so the transmittal/LOI preview can
       populate from the database immediately, even before the user opens
       the signatory picker. */
    setTimeout(() => {
        const sdsFieldMap = [
            ['f_sds_name', 'full_name'],
            ['f_sds_pos', 'position_title'],
            ['f_sds_office', 'office'],
            ['f_sds_city', 'city'],
        ];
        const rows = _signatories?.sds || [];
        const sds = rows.find(s => String(s.is_default) === '1') || rows[0] || null;
        if (sds) {
            sdsFieldMap.forEach(([id, key]) => {
                const el = document.getElementById(id);
                if (el) el.value = sds[key] || '';
            });
            if (typeof liveUpdate === 'function') liveUpdate();
        }
    }, 300);
    loadSignatories().finally(() => {
        if (typeof liveUpdate === 'function') liveUpdate();
    });
    /* School-wide legends (defaults + this school's custom categories)
       come from the DB now — fetch early so the preview/legend box and
       Word export are correct even before the user opens the picker. */
    loadCalendarLegends().then(() => { normalizeLegendSettings(); buildMonthlyGrid(); });

    /* ── Sync Final Submit visibility on load ── */
    if (typeof syncFinalSubmitVisibility === 'function') {
        syncFinalSubmitVisibility();
        setTimeout(syncFinalSubmitVisibility, 500);
    }

    /* ── Auto-open Calendar Picker eligibility guard ──
       Only fires when re-opening an already-saved document whose school-day
       count is outside the 200–220 range. New (unsaved) documents are
       excluded — the user hasn't even filled in school info yet, so popping
       the picker open immediately would be disruptive. */
    setTimeout(() => {
        const builderShell = document.getElementById('builderShell');
        if (!builderShell || builderShell.style.display === 'none') return;
        // Only prompt if this is a saved (existing) document, not a brand-new one.
        if (!currentCalendarDocumentId) return;
        const total = typeof computeGrandTotal === 'function' ? computeGrandTotal() : 0;
        if (total >= 200 && total <= 220) return;
        openCalPicker();
        setTimeout(() => { if (typeof showCalPickerEligibilityBanner === 'function') showCalPickerEligibilityBanner(total); }, 200);
    }, 800);
});

/* ══════════════════════════════════════════════════════════════════════════
   SIGNATORY PICKER — Calendar Builder
   Loads saved signatory rows from school_signatories via GET ?action=get_signatories.
   Schools can pick a saved record to auto-fill a block, or type manually and
   save the current values back with "Save as Signatory".
══════════════════════════════════════════════════════════════════════════ */

let _signatories = {};         // grouped: { role: [rows] }
let _sigsLoaded  = false;
let _sigPickerOpenRole = null; // which role's picker is currently shown

/** Role → field-id mapping for the calendar builder */
const SIG_CAL_FIELDS = {
    rd: {
        full_name:      'f_rd_name',
        position_title: 'f_rd_pos',
        office:         'f_rd_office',
    },
    sds: {
        full_name:      'f_sds_name',
        position_title: 'f_sds_pos',
        office:         'f_sds_office',
        city:           'f_sds_city',
    },
    principal: {
        full_name:      'f_principal',
        position_title: 'f_principal_title',
        contact:        'f_principal_contact',
    },
    recommending: {
        full_name:  'f_recommending',
        position_title: 'f_rec_pos',
        office:     'f_rec_org',
    },
    final_approver: {
        full_name:      'f_approved',
        position_title: 'f_app_pos',
        office:         'f_app_org',
    },
    chk_checked_by: {
        full_name: 'f_chk_checked_by',
    },
};

/**
 * Roles managed exclusively by the SDO/SMME office (mirrors the server-side
 * OFFICE_ONLY_SIGNATORY_ROLES list). Schools can pick from saved office
 * signatories for these roles but cannot type a custom value, save a new
 * one, or delete one — that's only possible from Settings by SDO/SMME staff.
 */
const OFFICE_ONLY_ROLES = ['rd', 'sds', 'recommending', 'final_approver', 'chk_checked_by'];

/* ══════════════════════════════════════════════════════════════════════════
   CALENDAR LEGENDS — school-wide, DB-backed
   Defaults (Holiday/Activity/Exam) are global (private_school_id IS NULL)
   and locked — only an SDO-side admin tool can edit those. Custom legends
   are scoped to the caller's school and shared across every calendar
   document that school builds (not per-document), and can be added,
   edited, or deleted by that school's own portal users.
══════════════════════════════════════════════════════════════════════════ */
let _legendsLoaded = false;
let _legendIdByKey = {}; // key -> DB row id, needed for edit/delete calls

function _applyServerLegendEntry(key, entry, isDefault) {
    legends[key] = {
        label: entry.label,
        color: entry.color,
        symbol: entry.symbol,
        includeInSchoolDays: !!entry.includeInSchoolDays,
    };
    if (isDefault) DEFAULT_LEGENDS[key] = { ...legends[key] };
    _legendIdByKey[key] = entry.id;
}

async function loadCalendarChecklistItems(force = false) {
    if (_checklistItemsLoaded && !force) return;
    try {
        const res  = await fetch(`${API_BASE}/school-portal-calendar.php?action=get_supporting_documents`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) return;
        CALENDAR_CHECKLIST_ITEMS = (json.data && json.data.items) || [];
        _checklistItemsLoaded = true;
        renderChecklistFormFields();
        liveUpdate();
    } catch (e) {
        console.warn('Could not load calendar checklist items:', e);
    }
}

/* Loads which of the configurable checklist items already have a file
   uploaded for the CURRENTLY OPEN document. Re-fetches whenever the open
   document id changes (new doc, switching documents, etc.); clears the
   local cache entirely when there's no open document (currentCalendarDocumentId
   is null), e.g. right after starting a brand new calendar. */
async function loadSupportingUploads(force = false) {
    if (!currentCalendarDocumentId) {
        Object.keys(chkUploads).forEach(k => delete chkUploads[k]);
        _uploadsLoadedForDocId = null;
        return;
    }
    if (_uploadsLoadedForDocId === currentCalendarDocumentId && !force) return;
    try {
        const res = await fetch(`${API_BASE}/school-portal-calendar.php?action=get_supporting_uploads&calendar_document_id=${encodeURIComponent(currentCalendarDocumentId)}`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) return;
        Object.keys(chkUploads).forEach(k => delete chkUploads[k]);
        ((json.data && json.data.items) || []).forEach(row => { chkUploads[row.slug] = row; });
        _uploadsLoadedForDocId = currentCalendarDocumentId;
    } catch (e) {
        console.warn('Could not load supporting document uploads:', e);
    }
}

const CHK_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const CHK_UPLOAD_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'];

function _formatFileSize(bytes) {
    const n = Number(bytes);
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function _formatUploadDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
}

/* Uploads the actual supporting document for a configurable (non-hardcoded)
   checklist item. If the current draft hasn't been saved yet — so there's
   no document id to attach the file to — it saves first, then uploads. */
async function uploadSupportingDocument(slug, file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!CHK_UPLOAD_ALLOWED_EXT.includes(ext)) {
        showToast('Unsupported file type. Allowed: PDF, JPG, PNG, DOC, DOCX.', 'fa-triangle-exclamation');
        return;
    }
    if (file.size > CHK_UPLOAD_MAX_BYTES) {
        showToast('File is too large. Maximum size is 10MB.', 'fa-triangle-exclamation');
        return;
    }

    if (!currentCalendarDocumentId) {
        const saved = await calSaveCalendar();
        if (!saved || !currentCalendarDocumentId) {
            showToast('Could not save your progress. Please try Save again before uploading.', 'fa-triangle-exclamation');
            return;
        }
    }

    const formData = new FormData();
    formData.append('action', 'upload_supporting_document');
    formData.append('calendar_document_id', currentCalendarDocumentId);
    formData.append('slug', slug);
    formData.append('file', file);

    try {
        const res  = await fetch(CALENDAR_API, { method: 'POST', credentials: 'include', body: formData });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Upload failed.');
        chkUploads[slug] = {
            slug,
            original_filename: json.data.original_filename,
            file_size: json.data.file_size,
            uploaded_at: json.data.uploaded_at,
        };
        _uploadsLoadedForDocId = currentCalendarDocumentId;
        renderChecklistFormFields();
        liveUpdate();
        showToast('Document uploaded.', 'fa-file-circle-check');
    } catch (e) {
        showToast('Could not upload document: ' + e.message, 'fa-triangle-exclamation');
    }
}

async function removeSupportingUpload(slug) {
    if (!currentCalendarDocumentId || !chkUploads[slug]) return;
    if (!confirm('Remove this uploaded document?')) return;
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_supporting_upload', calendar_document_id: currentCalendarDocumentId, slug }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Could not remove file.');
        delete chkUploads[slug];
        renderChecklistFormFields();
        liveUpdate();
        showToast('Document removed.', 'fa-trash');
    } catch (e) {
        showToast('Could not remove document: ' + e.message, 'fa-triangle-exclamation');
    }
}

function downloadSupportingUpload(slug) {
    if (!currentCalendarDocumentId) return;
    const url = `${API_BASE}/school-portal-calendar.php?action=download_supporting_upload&calendar_document_id=${encodeURIComponent(currentCalendarDocumentId)}&slug=${encodeURIComponent(slug)}`;
    window.open(url, '_blank');
}

/* Builds the "Checklist Items" panel (left form). The two builder-generated
   requirements (CHK_HARDCODED_ITEMS) show a locked, non-editable remark.
   Everything else is admin-configured and shows a real upload control —
   the remark for those is derived entirely from chkUploads, not typed in
   by the school. */
function renderChecklistFormFields() {
    const container = document.getElementById('chkItemsFields');
    if (!container) return;

    const items = getChecklistDisplayItems();
    container.innerHTML = items.map((item, idx) => {
        const n = idx + 1;

        if (item.remark) {
            return `
                <div class="fg"><label>Requirement ${n}</label>
                    <textarea readonly tabindex="-1" style="background:#f9fafb;color:#374151;">${_escHtmlSig(item.label)}</textarea>
                </div>
                <div class="fg"><label>Remark ${n}</label><input class="chk-remark-locked"
                        value="${_escAttr(item.remark)}" readonly tabindex="-1" />
                    <span class="chk-remark-lock-note"><i class="fa-solid fa-lock"></i> Auto-fulfilled — generated by this builder</span>
                </div>`;
        }

        const upload = chkUploads[item.slug];
        const hint = item.hint
            ? `<div class="fg-hint" style="color:#6b7280;font-size:10px;margin:2px 0 6px;">${_escHtmlSig(item.hint)}</div>`
            : '';

        let uploadWidget;
        if (!currentCalendarDocumentId) {
            uploadWidget = `<div class="fg" style="color:#9ca3af;font-size:11px;">
                    <i class="fa-solid fa-circle-info"></i> Save your progress first to enable uploading this document.
                </div>`;
        } else if (upload) {
            uploadWidget = `
                <div class="chk-upload-status">
                    <i class="fa-solid fa-file-circle-check" style="color:#16a34a;"></i>
                    <span class="chk-upload-filename">${_escHtmlSig(upload.original_filename)}</span>
                    <span class="chk-upload-meta">${_formatFileSize(upload.file_size)} · ${_formatUploadDate(upload.uploaded_at)}</span>
                </div>
                <input type="file" id="chkFile_${item.slug}" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    onchange="uploadSupportingDocument('${item.slug}', this.files[0])" />
                <button type="button" class="chk-upload-btn" onclick="document.getElementById('chkFile_${item.slug}').click()"><i class="fa-solid fa-rotate"></i> Replace</button>
                <button type="button" class="chk-upload-btn" onclick="downloadSupportingUpload('${item.slug}')"><i class="fa-solid fa-download"></i> View</button>
                <button type="button" class="chk-upload-btn chk-upload-btn-danger" onclick="removeSupportingUpload('${item.slug}')"><i class="fa-solid fa-trash"></i> Remove</button>
            `;
        } else {
            uploadWidget = `
                <input type="file" id="chkFile_${item.slug}" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    onchange="uploadSupportingDocument('${item.slug}', this.files[0])" />
                <button type="button" class="chk-upload-btn" onclick="document.getElementById('chkFile_${item.slug}').click()"><i class="fa-solid fa-upload"></i> Upload file</button>
                <span class="chk-upload-meta" style="margin-left:6px;color:#9ca3af;">No file uploaded yet · PDF, JPG, PNG, DOC — max 10MB</span>
            `;
        }

        return `
            <div class="fg"><label>Requirement ${n}</label>
                <textarea readonly tabindex="-1" style="background:#f9fafb;color:#374151;">${_escHtmlSig(item.label)}</textarea>
            </div>
            ${hint}
            <div class="fg"><label>Submission ${n}</label>${uploadWidget}</div>
        `;
    }).join('');
}


async function loadCalendarLegends(force = false) {
    if (_legendsLoaded && !force) return;
    try {
        const res  = await fetch(`${API_BASE}/school-portal-calendar.php?action=get_legends`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) return;
        const data = json.data || {};
        (data.defaults || []).forEach(entry => _applyServerLegendEntry(entry.key, entry, true));
        (data.custom   || []).forEach(entry => _applyServerLegendEntry(entry.key, entry, false));
        _legendsLoaded = true;
        normalizeLegendSettings();
        renderCustomLegendItems();
    } catch (e) {
        console.warn('Could not load calendar legends:', e);
    }
}

/* Persist a new/edited CUSTOM legend to the school's account (server
   rejects anything matching a default/locked row, so this can never be
   used to touch Holiday/Activity/Exam). */
async function saveCalendarLegendToServer(key, leg) {
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'save_legend',
                id: _legendIdByKey[key] || null,
                key, label: leg.label, color: leg.color, symbol: leg.symbol,
                includeInSchoolDays: leg.includeInSchoolDays !== false,
            }),
        });
        const json = await res.json();
        if (json.success && json.data?.id) _legendIdByKey[key] = json.data.id;
        return json.success;
    } catch (e) {
        console.warn('Could not save legend to server:', e);
        return false;
    }
}

async function deleteCalendarLegendFromServer(key) {
    const id = _legendIdByKey[key];
    if (!id) return true; // never persisted server-side (e.g. offline-created) — just drop locally
    try {
        const res = await fetch(CALENDAR_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_legend', id }),
        });
        const json = await res.json();
        return !!json.success;
    } catch (e) {
        console.warn('Could not delete legend from server:', e);
        return false;
    }
}

async function loadSignatories(force = false) {
    if (_sigsLoaded && !force) return;
    try {
        const res  = await fetch(`${API_BASE}/school-portal-calendar.php?action=get_signatories`, { credentials: 'include' });
        const json = await res.json();
        if (json.success) {
            _signatories = json.data?.grouped || {};
            _sigsLoaded  = true;
            // Auto-apply defaults when first loaded (only fill empty fields)
            _applyDefaultSignatories();
            // Explicitly re-sync the visible preview fields from whatever we just loaded.
            const sdsRows = _signatories.sds || [];
            const sds = sdsRows.find(s => String(s.is_default) === '1') || sdsRows[0] || null;
            if (sds) {
                ['f_sds_name','f_sds_pos','f_sds_office','f_sds_city'].forEach(id => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const val = id === 'f_sds_name' ? sds.full_name : id === 'f_sds_pos' ? sds.position_title : id === 'f_sds_office' ? sds.office : sds.city;
                    if (el.value.trim() === '' || el.readOnly) {
                        el.value = val || '';
                    }
                });
                if (typeof liveUpdate === 'function') liveUpdate();
            }
        }
    } catch (e) {
        console.warn('Could not load signatories:', e);
    }
}

function _applyDefaultSignatories() {
    Object.entries(SIG_CAL_FIELDS).forEach(([role, fieldMap]) => {
        const rows = _signatories[role] || [];
        const defaults = rows.filter(s => String(s.is_default) === '1');
        const source = defaults[0] || rows[0] || null;
        const isOfficeOnly = OFFICE_ONLY_ROLES.includes(role);
        if (!source) {
            // No saved signatory exists for this role yet. Office-only fields
            // should stay blank rather than showing stale placeholder text.
            if (isOfficeOnly) {
                Object.values(fieldMap).forEach(inputId => {
                    const el = document.getElementById(inputId);
                    if (el) el.value = '';
                });
            }
            return;
        }
        Object.entries(fieldMap).forEach(([key, inputId]) => {
            const el = document.getElementById(inputId);
            if (!el) return;
            // Office-only fields are no longer user-editable, so always keep
            // them in sync with the office-managed record. School-editable
            // fields only get auto-filled the first time (when still blank),
            // so we never clobber something the school already typed.
            if (isOfficeOnly || !el.value.trim()) {
                el.value = (source[key] !== undefined && source[key] !== null) ? source[key] : '';
            }
        });
    });
    if (typeof liveUpdate === 'function') liveUpdate();
}

function openSignatoryPicker(role, label) {
    // Toggle: clicking Load again closes the picker
    const bar = document.getElementById('sig-picker-' + role);
    if (!bar) return;
    if (_sigPickerOpenRole === role && bar.style.display !== 'none') {
        bar.style.display = 'none';
        _sigPickerOpenRole = null;
        return;
    }
    // Close any other open picker
    if (_sigPickerOpenRole) {
        const old = document.getElementById('sig-picker-' + _sigPickerOpenRole);
        if (old) old.style.display = 'none';
    }
    _sigPickerOpenRole = role;
    bar.style.display  = 'flex';
    _renderSignatoryPicker(role, label, bar);

    // Lazy-load from server if not yet loaded
    if (!_sigsLoaded) {
        loadSignatories().then(() => _renderSignatoryPicker(role, label, bar));
    }
}

function _renderSignatoryPicker(role, label, bar) {
    const rows = _signatories[role] || [];
    const isOfficeOnly = OFFICE_ONLY_ROLES.includes(role);
    const itemsHtml = rows.length
        ? rows.map(s => {
            const defBadge = String(s.is_default) === '1'
                ? `<span class="sig-picker-default-badge">Default</span>` : '';
            const isOffice = s.scope === 'office' || (s.private_school_id === null || s.private_school_id === undefined);
            const scopeBadge = `<span class="sig-picker-scope-badge ${isOffice ? 'is-office' : 'is-school'}">${isOffice ? 'Office-managed' : 'School'}</span>`;
            const sub = [s.position_title, s.office, s.city].filter(Boolean).join(' · ');
            // Office rows (or any row under an office-only role) can never be
            // deleted from here — that's Settings-only, by SDO/SMME staff.
            const canDelete = !isOffice && !isOfficeOnly;
            return `
                <div class="sig-picker-option${String(s.is_default) === '1' ? ' is-default' : ''}">
                    <div class="sig-picker-option-info">
                        <div class="sig-picker-name">${_escHtmlSig(s.full_name)} ${defBadge} ${scopeBadge}</div>
                        ${sub ? `<div class="sig-picker-sub">${_escHtmlSig(sub)}</div>` : ''}
                    </div>
                    <div class="sig-picker-actions">
                        <button class="sig-picker-use-btn" onclick="_applySignatory('${_escAttr(role)}',${Number(s.id)})">
                            <i class="fa-solid fa-check"></i> Use
                        </button>
                        ${canDelete ? `
                        <button class="sig-picker-del-btn" onclick="_deleteSignatory(${Number(s.id)},'${_escAttr(role)}','${_escAttr(label)}')" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>` : ''}
                    </div>
                </div>`;
        }).join('')
        : `<div class="sig-picker-empty"><i class="fa-solid fa-circle-info"></i> No saved signatories yet for <strong>${_escHtmlSig(label)}</strong>.${isOfficeOnly ? ' Ask your division office to add one in Settings.' : '<br>Fill in the fields below and click <em>Save as Signatory</em>.'}</div>`;

    bar.innerHTML = `
        <div class="sig-picker-label"><i class="fa-solid fa-address-book"></i> Saved ${_escHtmlSig(label)} Signatories</div>
        <div class="sig-picker-list">${itemsHtml}</div>`;
}

function _applySignatory(role, id) {
    const rows = _signatories[role] || [];
    const sig  = rows.find(s => Number(s.id) === Number(id));
    if (!sig) return;
    const fieldMap = SIG_CAL_FIELDS[role] || {};
    Object.entries(fieldMap).forEach(([key, inputId]) => {
        const el = document.getElementById(inputId);
        if (el && sig[key] !== undefined) el.value = sig[key] || '';
    });
    if (typeof liveUpdate === 'function') liveUpdate();
    // Close picker
    const bar = document.getElementById('sig-picker-' + role);
    if (bar) bar.style.display = 'none';
    _sigPickerOpenRole = null;
}

async function _deleteSignatory(id, role, label) {
    if (OFFICE_ONLY_ROLES.includes(role)) {
        alert(`${label} signatories are managed by the SDO/SMME office and can't be deleted here.`);
        return;
    }
    if (!confirm(`Delete this ${label} signatory? This cannot be undone.`)) return;
    try {
        const res  = await fetch(`${API_BASE}/school-portal-calendar.php`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_signatory', id }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Delete failed.');
        // Remove from local cache
        if (_signatories[role]) _signatories[role] = _signatories[role].filter(s => Number(s.id) !== Number(id));
        const bar = document.getElementById('sig-picker-' + role);
        if (bar) _renderSignatoryPicker(role, label, bar);
    } catch (e) { alert('Could not delete signatory: ' + e.message); }
}

/**
 * Opens a small modal to confirm and optionally rename before saving
 * the current field values as a new signatory record.
 */
function saveCurrentSignatory(role, label) {
    if (OFFICE_ONLY_ROLES.includes(role)) {
        alert(`${label} signatories are managed by the SDO/SMME office. Contact your division office to update it.`);
        return;
    }
    const fieldMap = SIG_CAL_FIELDS[role] || {};
    const current  = {};
    Object.entries(fieldMap).forEach(([key, inputId]) => {
        const el = document.getElementById(inputId);
        current[key] = el ? el.value.trim() : '';
    });
    if (!current.full_name) {
        alert('Please fill in the name field first.');
        return;
    }
    _openSigSaveModal({ role, label, values: current, apiBase: `${API_BASE}/school-portal-calendar.php` });
}

function _openSigSaveModal({ role, label, values, apiBase, fieldMap: _fm, onSaved }) {
    const existing = (_signatories[role] || []);
    const dupeCheck = existing.find(s => s.full_name.trim().toLowerCase() === (values.full_name || '').toLowerCase());

    const overlay = document.createElement('div');
    overlay.className = 'sig-modal-overlay';
    overlay.id = 'sigModalOverlay';
    overlay.innerHTML = `
        <div class="sig-modal" role="dialog" aria-modal="true">
            <div class="sig-modal-title"><i class="fa-solid fa-floppy-disk"></i> Save ${_escHtmlSig(label)} Signatory</div>
            ${dupeCheck ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:7px;padding:8px 11px;font-size:12px;color:#713f12;margin-bottom:10px;">
                <i class="fa-solid fa-triangle-exclamation"></i> A signatory with this name already exists. Saving will create a duplicate — consider using <em>Load</em> instead, or edit the name below.
            </div>` : ''}
            <div class="fg"><label>Full Name & Credentials</label>
                <input id="sigModalName" value="${_escAttr(values.full_name || '')}" placeholder="e.g. JUAN D. SANTOS, CESO V" />
            </div>
            <div class="fg"><label>Position / Title</label>
                <input id="sigModalPos" value="${_escAttr(values.position_title || '')}" placeholder="e.g. Regional Director" />
            </div>
            <div class="fg"><label>Office</label>
                <input id="sigModalOfc" value="${_escAttr(values.office || '')}" placeholder="e.g. Office of the Regional Director" />
            </div>
            <div class="fg"><label>City / Location <span style="color:#94a3b8">(optional)</span></label>
                <input id="sigModalCity" value="${_escAttr(values.city || '')}" />
            </div>
            <div class="fg"><label>Contact <span style="color:#94a3b8">(optional)</span></label>
                <input id="sigModalContact" value="${_escAttr(values.contact || '')}" />
            </div>
            <label class="sig-modal-check">
                <input type="checkbox" id="sigModalDefault" ${!existing.length ? 'checked' : ''} />
                Set as default for <strong>${_escHtmlSig(label)}</strong> (auto-fills on next document)
            </label>
            <div class="sig-modal-btns">
                <button class="sig-modal-cancel" onclick="document.getElementById('sigModalOverlay')?.remove()">Cancel</button>
                <button class="sig-modal-save" onclick="_submitSigModal('${_escAttr(role)}','${_escAttr(label)}','${_escAttr(apiBase)}')">
                    <i class="fa-solid fa-floppy-disk"></i> Save
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('sigModalName')?.focus();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function _submitSigModal(role, label, apiBase) {
    const name    = document.getElementById('sigModalName')?.value.trim()    || '';
    const pos     = document.getElementById('sigModalPos')?.value.trim()     || '';
    const ofc     = document.getElementById('sigModalOfc')?.value.trim()     || '';
    const city    = document.getElementById('sigModalCity')?.value.trim()    || '';
    const contact = document.getElementById('sigModalContact')?.value.trim() || '';
    const isDef   = document.getElementById('sigModalDefault')?.checked ? 1 : 0;

    if (!name) { alert('Full name is required.'); return; }

    const saveBtn = document.querySelector('.sig-modal-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
        const res  = await fetch(apiBase, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save_signatory', role, full_name: name, position_title: pos, office: ofc, city, contact, is_default: isDef }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Save failed.');

        // Update local cache
        const newRow = { id: json.data?.id, role, full_name: name, position_title: pos, office: ofc, city, contact, is_default: isDef };
        if (isDef && _signatories[role]) _signatories[role].forEach(s => s.is_default = 0);
        if (!_signatories[role]) _signatories[role] = [];
        _signatories[role].push(newRow);

        document.getElementById('sigModalOverlay')?.remove();

        // Refresh open picker if any
        if (_sigPickerOpenRole === role) {
            const bar = document.getElementById('sig-picker-' + role);
            if (bar) _renderSignatoryPicker(role, label, bar);
        }
    } catch (e) {
        alert('Could not save signatory: ' + e.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save'; }
    }
}

function _escHtmlSig(v) {
    return String(v || '').replace(/[&<>'"]/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
function _escAttr(v) {
    return String(v || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Kick off signatory load once dashboard data arrives (non-blocking)
document.addEventListener('DOMContentLoaded', () => {
    // Defer until after auth so the session cookie is available
    setTimeout(() => loadSignatories(), 600);
    setTimeout(() => loadCalendarChecklistItems(), 600);
});
