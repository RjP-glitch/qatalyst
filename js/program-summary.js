// program-summary.js
// Standalone Summary Report page script
// Extracted and adapted from programs.js

const API_URL = CONFIG.API_URL;
let expandedMenus = {};

// ─── STATE ─────────────────────────────────────────────────────────────────
const SummaryState = {
    allPrograms: [],
    summaryReportSnapshot: null,
    _programListSections: [],
};

// ─── INIT ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    checkAuthentication();
    document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);
});

async function checkAuthentication() {
    try {
        const res = await fetch(`${API_URL}/main-settings.php`, {
            credentials: 'include'
        });

        if (!res.ok) {
            clearLocalStorage();
            window.location.href = 'login.html';
            return;
        }

        const json = await res.json();
        if (!json.success || !json.data?.id) {
            clearLocalStorage();
            window.location.href = 'login.html';
            return;
        }

        const userData = json.data;
        loadUserInfo(userData.full_name, userData.email);

        if (userData.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }
        if (userData.account_type) localStorage.setItem('account_type', userData.account_type);

        if (userData.profile_picture) {
            document.getElementById('sidebarAvatar').innerHTML =
                `<img src="${userData.profile_picture}"
                      style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                      alt="Profile">`;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('programs')) return;
            Permissions.applyNavPermissions();
        }

        await loadProgramsForSummary();
        renderSummaryReport('all');

        // Attach quarter filter listener
        const quarterSelect = document.getElementById('summaryQuarterFilter');
        if (quarterSelect) {
            quarterSelect.addEventListener('change', e => {
                renderSummaryReport(e.target.value);
            });
        }

    } catch (err) {
        console.error('Auth verification failed:', err);

        const cachedUserId = localStorage.getItem('user_id');
        if (!cachedUserId) {
            clearLocalStorage();
            window.location.href = 'login.html';
            return;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('programs')) return;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(localStorage.getItem('full_name'), localStorage.getItem('email'));
        loadProfilePicture();

        await loadProgramsForSummary();
        renderSummaryReport('all');

        const quarterSelect = document.getElementById('summaryQuarterFilter');
        if (quarterSelect) {
            quarterSelect.addEventListener('change', e => {
                renderSummaryReport(e.target.value);
            });
        }
    }
}

function clearLocalStorage() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    document.getElementById('sidebarAvatar').textContent = initial;
    document.getElementById('sidebarUserName').textContent = fullName || 'User';
    document.getElementById('sidebarUserEmail').textContent = email || '';
}

async function loadProfilePicture() {
    try {
        const res = await fetch(`${API_URL}/main-settings.php`, { credentials: 'include' });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            document.getElementById('sidebarAvatar').innerHTML =
                `<img src="${json.data.profile_picture}"
              style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
              alt="Profile">`;
        }
    } catch (_) { /* keep initial letter */ }
}

// ─── LOAD PROGRAMS ─────────────────────────────────────────────────────────
async function loadProgramsForSummary() {
    try {
        const res = await fetch(`${API_URL}/programs.php`, { credentials: 'include' });
        const result = await res.json();
        if (result.success) {
            SummaryState.allPrograms = result.data || [];
        }
    } catch (e) {
        console.error('Failed to load programs:', e);
        SummaryState.allPrograms = [];
    }
}

// Sets a submenu's max-height to its actual content height (when expanded)
// or 0 (when collapsed), using an inline !important style so it always wins
// over the CSS fallback (.submenu.expanded { max-height: 300px }), which is
// too small once nested submenus are open.
function setSubmenuHeight(submenu) {
    if (!submenu) return;
    if (submenu.classList.contains('expanded')) {
        submenu.style.setProperty('max-height', submenu.scrollHeight + 'px', 'important');
    } else {
        submenu.style.setProperty('max-height', '0px', 'important');
    }
}

// Walks up through any ancestor .submenu elements and, if they're expanded,
// recalculates their height so a nested submenu opening/closing doesn't get
// clipped by a parent submenu's own fixed max-height.
function updateAncestorSubmenuHeights(el) {
    let parent = el.parentElement;
    while (parent) {
        if (parent.classList && parent.classList.contains('submenu')) {
            setSubmenuHeight(parent);
        }
        parent = parent.parentElement;
    }
}

function toggleSubmenu(menuName) {
    expandedMenus[menuName] = !expandedMenus[menuName];
    const submenu = document.getElementById(`${menuName}-submenu`);
    const arrow = document.getElementById(`${menuName}-arrow`);
    if (expandedMenus[menuName]) {
        submenu.classList.add('expanded');
        arrow.classList.add('rotate');
        arrow.parentElement.classList.add('expanded');
    } else {
        submenu.classList.remove('expanded');
        arrow.classList.remove('rotate');
        arrow.parentElement.classList.remove('expanded');
    }

    setSubmenuHeight(submenu);
    updateAncestorSubmenuHeights(submenu);

    // The call above measures ancestor submenus' scrollHeight synchronously,
    // in the same tick that this submenu's own max-height transition just
    // started. At that instant the transition hasn't progressed yet, so any
    // ancestor's scrollHeight is measured *before* this submenu has actually
    // grown/shrunk - meaning the ancestor can get locked to a height that's
    // too small (clipping later items) or briefly wrong. Once this submenu's
    // own max-height transition finishes, re-measure the ancestors again so
    // they end up sized to the real, final content height.
    submenu.addEventListener('transitionend', function onDone(e) {
        if (e.propertyName === 'max-height') {
            updateAncestorSubmenuHeights(submenu);
            submenu.removeEventListener('transitionend', onDone);
        }
    });
}

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

function navigate(sectionName) {
    const routes = {
        dashboard:             'dashboard.html',
        programs:              'qatame.html',
        qatame:                'qatame.html',
        qms:                   'qms.html',
        sbm:                   'sbm.html',
        sgc:                   'sgc.html',
        sdopir:                'sdopir.html',
        spir:                  'spir.html',
        importfile:            'import-excell.html',
        speakers:              'speaker-roster.html',
        certificates:          'certificate.html',
        certificatesplitter:   'certificates-splitter.html',
        checklist:             'checklist.html',
        documentssubmittedall: 'documents-submitted-all.html',
        settings:              'main-settings.html',
        users:                 'user-management.html',
        directory:             'directory.html',
        auditlogs:             'audit-logs.html',
        announcements:          'announcements.html'
    };
    if (routes[sectionName]) {
        closeMobileSidebar();
        window.location.href = routes[sectionName];
    }
}

/** Returns the page key the user came from, read from ?from= query param.
 *  Falls back to 'qatame' for backward compatibility. */
function _getFromPage() {
    const params = new URLSearchParams(window.location.search);
    return params.get('from') || 'qatame';
}

/** Navigates back to whichever program page opened this summary. */
function navigateBack() {
    navigate(_getFromPage());
}

// ─── LOGOUT ────────────────────────────────────────────────────────────────
async function logout() {
    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (_) { }
    finally {
        clearLocalStorage();
        window.location.replace('login.html');
    }
}

// ─── BACK-BUTTON / BFCACHE GUARD ───────────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

let _lastVisibilityCheck = 0;
const VISIBILITY_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - _lastVisibilityCheck < VISIBILITY_CHECK_INTERVAL) return;
        _lastVisibilityCheck = now;
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

// ─── HELPERS ───────────────────────────────────────────────────────────────
function escapeHtml(t) {
    if (!t) return '';
    const el = document.createElement('div');
    el.textContent = t;
    return el.innerHTML;
}

function showToast(type, message) {
    const toast = document.getElementById('toastNotif');
    const iconEl = document.getElementById('toastIcon');
    const textEl = document.getElementById('toastText');

    const config = {
        success: { bg: '#16a34a', icon: 'fa-circle-check' },
        error:   { bg: '#dc2626', icon: 'fa-circle-xmark' },
        warning: { bg: '#d97706', icon: 'fa-triangle-exclamation' },
        info:    { bg: '#2563eb', icon: 'fa-circle-info' },
    };
    const cfg = config[type] || config.info;

    toast.style.background = cfg.bg;
    iconEl.className = `fas ${cfg.icon}`;
    textEl.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    toast.style.pointerEvents = 'auto';

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(12px)';
        toast.style.pointerEvents = 'none';
    }, 4000);
}

// ─── SUMMARY REPORT CORE LOGIC ─────────────────────────────────────────────
const QUARTER_OPTIONS = [
    { value: 'all', label: '1st-4th Quarter (Overall)' },
    { value: '1',   label: '1st Quarter' },
    { value: '2',   label: '2nd Quarter' },
    { value: '3',   label: '3rd Quarter' },
    { value: '4',   label: '4th Quarter' },
];

const MONTH_MAP = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11,
};

const QUARTER_RANGE_LABELS = {
    '1': 'JAN - MARCH',
    '2': 'APRIL - JUNE',
    '3': 'JULY - SEPTEMBER',
    '4': 'OCTOBER - DECEMBER',
};

const QUARTER_ORDINAL = {
    '1': '1ST',
    '2': '2ND',
    '3': '3RD',
    '4': '4TH',
};

function toNumber(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function parseProgramDate(program) {
    const candidates = [program?.start_date, program?.inclusive_dates, program?.end_date];
    for (const raw of candidates) {
        if (!raw) continue;
        const txt = String(raw).trim();
        if (!txt) continue;

        const direct = new Date(txt);
        if (!Number.isNaN(direct.getTime())) return direct;

        const lower = txt.toLowerCase();
        const monthMatch = lower.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
        const yearMatch  = lower.match(/\b(20\d{2})\b/);
        if (!monthMatch) continue;
        const monthIdx = MONTH_MAP[monthMatch[1]];
        if (!Number.isFinite(monthIdx)) continue;
        const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
        return new Date(year, monthIdx, 1);
    }
    return null;
}

function getQuarterKey(program) {
    const d = parseProgramDate(program);
    if (!d) return 'unknown';
    return String(Math.floor(d.getMonth() / 3) + 1);
}

function getQuarterYear(programs, quarterKey) {
    const years = programs
        .filter(p => getQuarterKey(p) === quarterKey)
        .map(p => parseProgramDate(p)?.getFullYear())
        .filter(y => Number.isFinite(y));
    if (!years.length) return new Date().getFullYear();
    const counts = {};
    years.forEach(y => { counts[y] = (counts[y] || 0) + 1; });
    return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], 10);
}

function getQuarterReportLine(programs, quarterKey) {
    if (!QUARTER_ORDINAL[quarterKey]) return 'UNDATED PROGRAMS';
    const year = getQuarterYear(programs, quarterKey);
    return `${QUARTER_ORDINAL[quarterKey]} QUARTER (${QUARTER_RANGE_LABELS[quarterKey]}, ${year})`;
}

function getIssuanceOrReportNo(p) {
    const seq  = String(p?.sequence_number || '').trim();
    const memo = String(p?.division_memo   || '').trim();
    if (seq && memo && seq !== memo) return `${seq} / ${memo}`;
    return seq || memo || '—';
}

function sortProgramsByDateThenTitle(list) {
    return [...list].sort((a, b) => {
        const ad = parseProgramDate(a);
        const bd = parseProgramDate(b);
        const at = ad ? ad.getTime() : Number.MAX_SAFE_INTEGER;
        const bt = bd ? bd.getTime() : Number.MAX_SAFE_INTEGER;
        if (at !== bt) return at - bt;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
}

function formatDisplayDate(p) {
    const incl = String(p?.inclusive_dates || '').trim();
    if (incl) return incl;
    const raw = p?.start_date || p?.end_date;
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).trim() || '—';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function mapProgramRow(p) {
    return {
        issuance:      getIssuanceOrReportNo(p),
        eventName:     String(p?.title           || '').trim() || 'Untitled Program',
        date:          formatDisplayDate(p),
        venue:         String(p?.venue           || p?.training_venue || '').trim() || '—',
        unit:          String(p?.unit            || '').trim() || '—',
        natureOfEvent: String(p?.nature_of_event || '').trim() || '—',
    };
}

// ─── RENDER SUMMARY REPORT ─────────────────────────────────────────────────
function renderSummaryReport(selectedQuarter) {
    const content = document.getElementById('summaryReportContent');
    const filterInfo = document.getElementById('summaryFilterInfo');
    if (!content) return;

    const programs = Array.isArray(SummaryState.allPrograms) ? SummaryState.allPrograms : [];

    if (!programs.length) {
        content.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
                <i class="fa-solid fa-inbox" style="font-size:40px;margin-bottom:12px;display:block;"></i>
                <p style="font-size:15px;">No program data available yet.</p>
            </div>`;
        return;
    }

    const quarter = selectedQuarter || 'all';

    // ── Compute counts ──────────────────────────────────────────────────────
    const quarterCounts = {
        '1st Quarter': 0,
        '2nd Quarter': 0,
        '3rd Quarter': 0,
        '4th Quarter': 0,
        'No Date':     0,
    };

    programs.forEach(p => {
        const q = getQuarterKey(p);
        if      (q === '1') quarterCounts['1st Quarter'] += 1;
        else if (q === '2') quarterCounts['2nd Quarter'] += 1;
        else if (q === '3') quarterCounts['3rd Quarter'] += 1;
        else if (q === '4') quarterCounts['4th Quarter'] += 1;
        else                quarterCounts['No Date']     += 1;
    });

    const filteredPrograms = quarter === 'all'
        ? [...programs]
        : programs.filter(p => getQuarterKey(p) === quarter);

    const filteredProgramsSorted = sortProgramsByDateThenTitle(filteredPrograms);

    const groupedByQuarter = {
        '1': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '1')),
        '2': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '2')),
        '3': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '3')),
        '4': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '4')),
    };

    const sourceCounts = { System: 0, 'MS Forms': 0 };
    const statusCounts = { Ongoing: 0, Upcoming: 0, Completed: 0, Cancelled: 0, Other: 0 };
    const unitCounts   = {};
    const natureOfEventCounts = {};

    filteredPrograms.forEach(p => {
        // Programs imported via Excel file are treated as originating from MS Forms;
        // all other programs were entered directly through the System.
        const isExcel = String(p.source || '').toLowerCase() === 'excel';
        sourceCounts[isExcel ? 'MS Forms' : 'System'] += 1;

        const status = String(p.status || '').toLowerCase();
        if      (status === 'ongoing')   statusCounts.Ongoing   += 1;
        else if (status === 'upcoming')  statusCounts.Upcoming  += 1;
        else if (status === 'completed') statusCounts.Completed += 1;
        else if (status === 'cancelled') statusCounts.Cancelled += 1;
        else                             statusCounts.Other     += 1;

        const unit = String(p.unit || 'Unspecified').trim() || 'Unspecified';
        unitCounts[unit] = (unitCounts[unit] || 0) + 1;

        const nature = String(p.nature_of_event || 'Unspecified').trim() || 'Unspecified';
        natureOfEventCounts[nature] = (natureOfEventCounts[nature] || 0) + 1;
    });

    const quarterLabel = (QUARTER_OPTIONS.find(o => o.value === quarter)?.label) || '1st-4th Quarter (Overall)';
    const reportQuarterLine = quarter === 'all'
        ? '1ST-4TH QUARTER (OVERALL SUMMARY)'
        : getQuarterReportLine(programs, quarter);

    const quarterReportLinesByQuarter = {
        '1': getQuarterReportLine(programs, '1'),
        '2': getQuarterReportLine(programs, '2'),
        '3': getQuarterReportLine(programs, '3'),
        '4': getQuarterReportLine(programs, '4'),
    };

    // Save snapshot for Word export
    SummaryState.summaryReportSnapshot = {
        quarter,
        quarterLabel,
        reportTitle:    'QATAME EVALUATION REPORTS',
        reportQuarterLine,
        totalPrograms:  filteredPrograms.length,
        quarterCounts:  { ...quarterCounts },
        sourceCounts:   { ...sourceCounts },
        statusCounts:   { ...statusCounts },
        unitCounts:     { ...unitCounts },
        natureOfEventCounts: { ...natureOfEventCounts },
        programRows:    filteredProgramsSorted.map(mapProgramRow),
        groupedProgramRowsByQuarter: {
            '1': groupedByQuarter['1'].map(mapProgramRow),
            '2': groupedByQuarter['2'].map(mapProgramRow),
            '3': groupedByQuarter['3'].map(mapProgramRow),
            '4': groupedByQuarter['4'].map(mapProgramRow),
        },
        quarterReportLinesByQuarter,
    };

    // Update filter info text
    if (filterInfo) {
        filterInfo.textContent = `Showing: ${quarterLabel} — ${filteredPrograms.length} program${filteredPrograms.length === 1 ? '' : 's'}`;
    }

    // ── Build HTML ──────────────────────────────────────────────────────────
    const buildBreakdownRows = countsObj => {
        const rows = Object.entries(countsObj)
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]);
        if (!rows.length) return `<tr><td colspan="2" class="breakdown-empty">No data</td></tr>`;
        return rows.map(([label, count]) => `
            <tr>
                <td>${escapeHtml(label)}</td>
                <td>${count}</td>
            </tr>`).join('');
    };

    const buildProgramListRows = (rows, searchVal = '') => {
        const q = searchVal.trim().toLowerCase();
        const filtered = q
            ? rows.filter(r =>
                r.eventName.toLowerCase().includes(q) ||
                r.issuance.toLowerCase().includes(q)  ||
                r.date.toLowerCase().includes(q)       ||
                r.venue.toLowerCase().includes(q)      ||
                r.unit.toLowerCase().includes(q)       ||
                r.natureOfEvent.toLowerCase().includes(q)
            )
            : rows;

        if (!filtered.length) {
            const colspan = 7;
            return `<tr class="no-programs-row"><td colspan="${colspan}">${q ? 'No results match your search.' : 'No programs/workshops for this period.'}</td></tr>`;
        }
        return filtered.map((r, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td>${escapeHtml(r.issuance)}</td>
                <td>${escapeHtml(r.eventName)}</td>
                <td>${escapeHtml(r.date)}</td>
                <td>${escapeHtml(r.venue)}</td>
                <td>${escapeHtml(r.unit)}</td>
                <td>${escapeHtml(r.natureOfEvent)}</td>
            </tr>`).join('');
    };

    const buildProgramListSection = (title, rows, sectionId) => `
        <div class="quarter-section" id="${sectionId}">
            <div class="quarter-section-header">
                <i class="fa-solid fa-calendar-week"></i>
                ${escapeHtml(title)}
            </div>
            <table class="program-list-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Issuance / Report No.</th>
                        <th>Name of Event / Activity</th>
                        <th>Inclusive Dates</th>
                        <th>Venue</th>
                        <th>Functional Division</th>
                        <th>Nature of Event</th>
                    </tr>
                </thead>
                <tbody>${buildProgramListRows(rows)}</tbody>
            </table>
        </div>`;

    let programListsHTML = '';
    let allProgramRowsForSearch = [];

    if (quarter === 'all') {
        ['1', '2', '3', '4'].forEach(q => {
            const rows = groupedByQuarter[q].map(mapProgramRow);
            allProgramRowsForSearch.push({ id: `qs-${q}`, rows });
            programListsHTML += buildProgramListSection(
                quarterReportLinesByQuarter[q], rows, `qs-${q}`
            );
        });
    } else {
        const rows = filteredProgramsSorted.map(mapProgramRow);
        allProgramRowsForSearch.push({ id: `qs-single`, rows });
        programListsHTML = buildProgramListSection(
            reportQuarterLine, rows, `qs-single`
        );
    }

    // Store rows reference for search re-render
    SummaryState._programListSections = allProgramRowsForSearch;

    // ── Derive KPI sub-labels ────────────────────────────────────────────────
    const completedCount = statusCounts.Completed || 0;
    const ongoingCount   = statusCounts.Ongoing   || 0;
    const topUnitEntry   = Object.entries(unitCounts).sort((a, b) => b[1] - a[1])[0];
    const topUnit        = topUnitEntry ? topUnitEntry[0] : '—';
    const topUnitCount   = topUnitEntry ? topUnitEntry[1] : 0;
    const topNatureEntry = Object.entries(natureOfEventCounts).sort((a, b) => b[1] - a[1])[0];
    const topNature      = topNatureEntry ? topNatureEntry[0] : '—';
    const topNatureCount = topNatureEntry ? topNatureEntry[1] : 0;
    const totalPct       = filteredPrograms.length > 0
        ? Math.round((completedCount / filteredPrograms.length) * 100)
        : 0;

    content.innerHTML = `
        <!-- KPI Cards -->
        <div class="kpi-row">
            <div class="kpi-card">
                <div class="kpi-label">Total programs</div>
                <div class="kpi-value">${filteredPrograms.length}</div>
                <div class="kpi-sub">${quarterLabel}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Completed</div>
                <div class="kpi-value">${completedCount}</div>
                <div class="kpi-sub">${totalPct}% completion rate</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Ongoing</div>
                <div class="kpi-value">${ongoingCount}</div>
                <div class="kpi-sub">Across all divisions</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Top division</div>
                <div class="kpi-value">${escapeHtml(topUnit)}</div>
                <div class="kpi-sub">${topUnitCount} program${topUnitCount !== 1 ? 's' : ''} (${filteredPrograms.length > 0 ? Math.round((topUnitCount / filteredPrograms.length) * 100) : 0}%)</div>
            </div>
        </div>

        <!-- Charts Grid -->
        <div class="charts-grid">
            <div class="chart-card">
                <div class="chart-card-title"><i class="fa-solid fa-calendar"></i> Programs by quarter</div>
                <canvas id="chartQuarter" height="110"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-card-title"><i class="fa-solid fa-tags"></i> Nature of event</div>
                <canvas id="chartNature" height="110"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-card-title"><i class="fa-solid fa-building"></i> By functional division</div>
                <canvas id="chartDivision" height="110"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-card-title"><i class="fa-solid fa-circle-dot"></i> Status breakdown</div>
                <canvas id="chartStatus" height="110"></canvas>
            </div>
        </div>

        <!-- Search Bar -->
        <div class="program-search-bar">
            <span class="program-search-icon"><i class="fa-solid fa-search"></i></span>
            <input
                type="text"
                id="programListSearch"
                placeholder="Search by title, DM no., date, venue, unit, nature of event…"
                oninput="filterProgramListBySearch(this.value)"
                autocomplete="off"
            >
            <button class="program-search-clear" id="programSearchClear" onclick="clearProgramSearch()" style="display:none;" title="Clear search">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Program Lists by Quarter -->
        ${programListsHTML}
    `;

    // Render charts after DOM is updated
    renderCharts({ quarterCounts, natureOfEventCounts, unitCounts, statusCounts });
}

// ─── RENDER CHARTS ─────────────────────────────────────────────────────────
let _chartInstances = {};

function renderCharts({ quarterCounts, natureOfEventCounts, unitCounts, statusCounts }) {
    if (typeof Chart === 'undefined') return;

    Object.values(_chartInstances).forEach(c => { try { c.destroy(); } catch (_) {} });
    _chartInstances = {};

    const NAVY  = '#1a3a6b';
    const BLUE  = '#2456a4';
    const LBLUE = '#4a90d9';
    const TEAL  = '#0f6e56';
    const AMBER = '#ba7517';
    const CORAL = '#d85a30';
    const GRAY  = '#9ca3af';
    const TEXT  = '#374151';
    const GRID  = 'rgba(0,0,0,0.06)';

    Chart.defaults.font.family = "'Plus Jakarta Sans', 'Segoe UI', sans-serif";
    Chart.defaults.font.size   = 12;
    Chart.defaults.color       = TEXT;

    // Quarter bar chart
    const qCanvas = document.getElementById('chartQuarter');
    if (qCanvas) {
        _chartInstances.quarter = new Chart(qCanvas, {
            type: 'bar',
            data: {
                labels: ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)', 'No date'],
                datasets: [{
                    label: 'Programs',
                    data: [
                        quarterCounts['1st Quarter'] || 0,
                        quarterCounts['2nd Quarter'] || 0,
                        quarterCounts['3rd Quarter'] || 0,
                        quarterCounts['4th Quarter'] || 0,
                        quarterCounts['No Date']     || 0,
                    ],
                    backgroundColor: [BLUE, NAVY, LBLUE, BLUE, GRAY],
                    borderRadius: 6,
                    borderSkipped: false,
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} program${ctx.parsed.y !== 1 ? 's' : ''}` } }
                },
                scales: {
                    x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 11 } } },
                    y: { grid: { color: GRID }, border: { display: false }, ticks: { stepSize: 5, precision: 0 } }
                }
            }
        });
    }

    // Nature of event donut
    const nCanvas = document.getElementById('chartNature');
    if (nCanvas) {
        const nEntries = Object.entries(natureOfEventCounts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const palette  = [NAVY, TEAL, AMBER, CORAL, LBLUE, BLUE, GRAY];
        _chartInstances.nature = new Chart(nCanvas, {
            type: 'doughnut',
            data: {
                labels: nEntries.map(([k]) => k),
                datasets: [{
                    data: nEntries.map(([, v]) => v),
                    backgroundColor: nEntries.map((_, i) => palette[i % palette.length]),
                    borderWidth: 0,
                    hoverOffset: 8,
                }]
            },
            options: {
                responsive: true,
                cutout: '62%',
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 8, padding: 8, font: { size: 10 } } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}` } }
                }
            }
        });
    }

    // Division horizontal bar
    const dCanvas = document.getElementById('chartDivision');
    if (dCanvas) {
        const dEntries  = Object.entries(unitCounts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const divPalette = [NAVY, BLUE, LBLUE, TEAL, AMBER, CORAL, GRAY];
        _chartInstances.division = new Chart(dCanvas, {
            type: 'bar',
            data: {
                labels: dEntries.map(([k]) => k),
                datasets: [{
                    label: 'Programs',
                    data: dEntries.map(([, v]) => v),
                    backgroundColor: dEntries.map((_, i) => divPalette[i % divPalette.length]),
                    borderRadius: 5,
                    borderSkipped: false,
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x} program${ctx.parsed.x !== 1 ? 's' : ''}` } }
                },
                scales: {
                    x: { grid: { color: GRID }, border: { display: false }, ticks: { precision: 0 } },
                    y: { grid: { display: false }, border: { display: false } }
                }
            }
        });
    }

    // Status donut
    const sCanvas = document.getElementById('chartStatus');
    if (sCanvas) {
        const sEntries = Object.entries(statusCounts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const statusColors = { Completed: TEAL, Ongoing: AMBER, Upcoming: BLUE, Cancelled: CORAL, Other: GRAY };
        _chartInstances.status = new Chart(sCanvas, {
            type: 'doughnut',
            data: {
                labels: sEntries.map(([k]) => k),
                datasets: [{
                    data: sEntries.map(([, v]) => v),
                    backgroundColor: sEntries.map(([k]) => statusColors[k] || GRAY),
                    borderWidth: 0,
                    hoverOffset: 8,
                }]
            },
            options: {
                responsive: true,
                cutout: '62%',
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 8, padding: 8, font: { size: 10 } } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}` } }
                }
            }
        });
    }
}

// ─── SEARCH FILTER FOR PROGRAM LIST ────────────────────────────────────────
function filterProgramListBySearch(value) {
    const q = value.trim().toLowerCase();
    const clearBtn = document.getElementById('programSearchClear');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

    const sections = SummaryState._programListSections || [];
    sections.forEach(({ id, rows }) => {
        const section = document.getElementById(id);
        if (!section) return;
        const tbody = section.querySelector('tbody');
        if (!tbody) return;

        const filtered = q
            ? rows.filter(r =>
                r.eventName.toLowerCase().includes(q)    ||
                r.issuance.toLowerCase().includes(q)     ||
                r.date.toLowerCase().includes(q)          ||
                r.venue.toLowerCase().includes(q)         ||
                r.unit.toLowerCase().includes(q)          ||
                r.natureOfEvent.toLowerCase().includes(q)
            )
            : rows;

        if (!filtered.length) {
            tbody.innerHTML = `<tr class="no-programs-row"><td colspan="7">${q ? 'No results match your search.' : 'No programs/workshops for this period.'}</td></tr>`;
        } else {
            tbody.innerHTML = filtered.map((r, idx) => `
                <tr>
                    <td>${idx + 1}</td>
                    <td>${escapeHtml(r.issuance)}</td>
                    <td>${escapeHtml(r.eventName)}</td>
                    <td>${escapeHtml(r.date)}</td>
                    <td>${escapeHtml(r.venue)}</td>
                    <td>${escapeHtml(r.unit)}</td>
                    <td>${escapeHtml(r.natureOfEvent)}</td>
                </tr>`).join('');
        }
    });
}

function clearProgramSearch() {
    const input = document.getElementById('programListSearch');
    if (input) { input.value = ''; input.focus(); }
    filterProgramListBySearch('');
}

// ─── EXPORT TO WORD ────────────────────────────────────────────────────────
async function exportSummaryReportToWord() {
    if (typeof docx === 'undefined') {
        showToast('error', 'Word export library is not loaded.');
        return;
    }

    const snapshot = SummaryState.summaryReportSnapshot;
    if (!snapshot) {
        showToast('error', 'Report not loaded yet. Please wait.');
        return;
    }

    const exportBtn = document.getElementById('exportWordBtn');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Exporting...</span>';
    }

    try {
        const {
            Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            WidthType, AlignmentType, BorderStyle, ShadingType, HeadingLevel,
            PageBreak, UnderlineType,
        } = docx;

        const now = new Date();
        const dateText = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        // ── Colour palette (matches app branding) ──────────────────────────
        const C = {
            navy:       '1A3A6B',   // dark navy — header bg, accent
            navyMid:    '2456A4',   // mid blue — table header bg
            navyLight:  'EBF2FA',   // very light blue — alt rows, section headers
            gold:       'F5D800',   // yellow accent stripe
            white:      'FFFFFF',
            textDark:   '1E293B',   // near-black body text
            textMid:    '374151',   // medium grey body
            textMuted:  '6B7280',   // muted grey
            border:     'BFDBFE',   // light blue border
            borderGrey: 'E5E7EB',   // light grey border
        };

        // ── Border presets ─────────────────────────────────────────────────
        const bNone  = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
        const bLight = { style: BorderStyle.SINGLE, size: 2, color: C.borderGrey };
        const bBlue  = { style: BorderStyle.SINGLE, size: 4, color: C.border };
        const bNavy  = { style: BorderStyle.SINGLE, size: 6, color: C.navyMid };
        const allNone  = { top: bNone, bottom: bNone, left: bNone, right: bNone };
        const allLight = { top: bLight, bottom: bLight, left: bLight, right: bLight };
        const allBlue  = { top: bBlue,  bottom: bBlue,  left: bBlue,  right: bBlue  };

        // ── Spacing helper ─────────────────────────────────────────────────
        const sp = (before = 0, after = 0) => ({ before, after });

        // ── Empty spacer paragraph ─────────────────────────────────────────
        const spacer = (pts = 80) => new Paragraph({
            spacing: sp(pts, 0),
            children: [new TextRun({ text: '' })],
        });

        // ── Section heading paragraph ──────────────────────────────────────
        const sectionHeading = (text) => new Paragraph({
            spacing: sp(200, 80),
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.navyMid } },
            children: [
                new TextRun({
                    text: text.toUpperCase(),
                    bold: true,
                    size: 22,
                    color: C.navy,
                    font: 'Calibri',
                }),
            ],
        });

        // ── Quarter sub-heading ────────────────────────────────────────────
        const quarterHeading = (text) => new Paragraph({
            spacing: sp(180, 60),
            shading: { type: ShadingType.SOLID, color: C.navyLight },
            indent: { left: 80, right: 80 },
            children: [
                new TextRun({
                    text: '  ' + text,
                    bold: true,
                    size: 20,
                    color: C.navy,
                    font: 'Calibri',
                }),
            ],
        });

        // ── Program list table ─────────────────────────────────────────────
        const programListTable = rows => {
            const hdrCell = (text, widthPct) => new TableCell({
                width: { size: widthPct, type: WidthType.PERCENTAGE },
                borders: allNone,
                shading: { type: ShadingType.SOLID, color: C.navyMid },
                margins: { top: 80, bottom: 80, left: 100, right: 60 },
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({
                        text: String(text),
                        bold: true,
                        size: 18,
                        color: C.white,
                        font: 'Calibri',
                    })],
                })],
            });

            const dataCell = (text, widthPct, center = false, shade = false) => new TableCell({
                width: { size: widthPct, type: WidthType.PERCENTAGE },
                borders: { top: bLight, bottom: bLight, left: bNone, right: bNone },
                shading: shade ? { type: ShadingType.SOLID, color: C.navyLight } : undefined,
                margins: { top: 60, bottom: 60, left: 100, right: 60 },
                children: [new Paragraph({
                    alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
                    children: [new TextRun({
                        text: String(text || '—'),
                        size: 18,
                        color: C.textDark,
                        font: 'Calibri',
                    })],
                })],
            });

            const headerRow = new TableRow({
                tableHeader: true,
                children: [
                    hdrCell('#',                        4),
                    hdrCell('Issuance / Report No.',    15),
                    hdrCell('Name of Event / Activity', 31),
                    hdrCell('Inclusive Dates',          14),
                    hdrCell('Venue',                    16),
                    hdrCell('Unit',                     10),
                    hdrCell('Nature of Event',          10),
                ],
            });

            const dataRows = rows.length
                ? rows.map((r, idx) => {
                    const shade = idx % 2 === 1;
                    return new TableRow({
                        children: [
                            dataCell(String(idx + 1), 4,  true,  shade),
                            dataCell(r.issuance,      15, false, shade),
                            dataCell(r.eventName,     31, false, shade),
                            dataCell(r.date,          14, false, shade),
                            dataCell(r.venue,         16, false, shade),
                            dataCell(r.unit,          10, true,  shade),
                            dataCell(r.natureOfEvent, 10, true,  shade),
                        ],
                    });
                })
                : [new TableRow({
                    children: [new TableCell({
                        columnSpan: 7,
                        borders: allLight,
                        margins: { top: 100, bottom: 100, left: 100, right: 100 },
                        children: [new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [new TextRun({
                                text: 'No programs / workshops for this period.',
                                size: 18, color: C.textMuted, italics: true, font: 'Calibri',
                            })],
                        })],
                    })],
                })];

            return new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [headerRow, ...dataRows],
            });
        };

        // ── Summary stats table (2-col breakdown) ─────────────────────────
        const statsRow = (label, value, isHeader = false, shade = false) => new TableRow({
            children: [
                new TableCell({
                    width: { size: 75, type: WidthType.PERCENTAGE },
                    borders: allNone,
                    shading: isHeader
                        ? { type: ShadingType.SOLID, color: C.navy }
                        : shade
                            ? { type: ShadingType.SOLID, color: C.navyLight }
                            : undefined,
                    margins: { top: 60, bottom: 60, left: 120, right: 60 },
                    children: [new Paragraph({
                        children: [new TextRun({
                            text: String(label),
                            bold: isHeader,
                            size: isHeader ? 20 : 18,
                            color: isHeader ? C.white : C.textDark,
                            font: 'Calibri',
                        })],
                    })],
                }),
                new TableCell({
                    width: { size: 25, type: WidthType.PERCENTAGE },
                    borders: allNone,
                    shading: isHeader
                        ? { type: ShadingType.SOLID, color: C.navy }
                        : shade
                            ? { type: ShadingType.SOLID, color: C.navyLight }
                            : undefined,
                    margins: { top: 60, bottom: 60, left: 60, right: 120 },
                    children: [new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [new TextRun({
                            text: String(value),
                            bold: isHeader,
                            size: isHeader ? 20 : 18,
                            color: isHeader ? C.white : C.navyMid,
                            font: 'Calibri',
                        })],
                    })],
                }),
            ],
        });

        const statsTable = (title, countsObj) => {
            const rows = Object.entries(countsObj)
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1]);
            const dataRows = rows.length
                ? rows.map(([label, count], i) => statsRow(label, count, false, i % 2 === 1))
                : [statsRow('No data', '—', false, false)];
            return new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [statsRow(title, 'Count', true), ...dataRows],
            });
        };

        // ── Document children ──────────────────────────────────────────────
        const children = [];

        // ── Title block ────────────────────────────────────────────────────
        // Navy top-bar paragraph (simulated with shading)
        children.push(
            new Paragraph({
                spacing: sp(0, 0),
                shading: { type: ShadingType.SOLID, color: C.navy },
                children: [new TextRun({ text: ' ', size: 8 })],
            }),
            // Gold accent stripe
            new Paragraph({
                spacing: sp(0, 0),
                shading: { type: ShadingType.SOLID, color: C.gold },
                children: [new TextRun({ text: ' ', size: 14 })],
            }),
            spacer(120),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: sp(0, 60),
                children: [new TextRun({
                    text: snapshot.reportTitle || 'QATAME EVALUATION REPORTS',
                    bold: true,
                    size: 36,
                    color: C.navy,
                    font: 'Calibri',
                })],
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: sp(0, 40),
                children: [new TextRun({
                    text: snapshot.reportQuarterLine || snapshot.quarterLabel || '',
                    bold: true,
                    size: 24,
                    color: C.navyMid,
                    font: 'Calibri',
                })],
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: sp(0, 160),
                children: [new TextRun({
                    text: `Generated: ${dateText}`,
                    size: 18,
                    color: C.textMuted,
                    italics: true,
                    font: 'Calibri',
                })],
            }),
            // Gold divider line
            new Paragraph({
                spacing: sp(0, 200),
                border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.gold } },
                children: [new TextRun({ text: '' })],
            }),
        );

        // ── Total programs summary ─────────────────────────────────────────
        children.push(
            sectionHeading('Summary'),
            spacer(60),
            new Table({
                width: { size: 40, type: WidthType.PERCENTAGE },
                rows: [
                    statsRow('Total Programs', snapshot.totalPrograms, true),
                ],
            }),
            spacer(160),
        );

        // ── Program lists by quarter ───────────────────────────────────────
        children.push(sectionHeading('Programs / Workshops'), spacer(60));

        if (snapshot.quarter === 'all') {
            ['1', '2', '3', '4'].forEach(q => {
                const rows = snapshot.groupedProgramRowsByQuarter?.[q] || [];
                children.push(
                    quarterHeading(snapshot.quarterReportLinesByQuarter?.[q] || `${q} Quarter`),
                    spacer(40),
                    programListTable(rows),
                    spacer(160),
                );
            });
        } else {
            children.push(
                programListTable(snapshot.programRows || []),
                spacer(160),
            );
        }

        // ── Breakdown stats ────────────────────────────────────────────────
        children.push(
            sectionHeading('Statistical Breakdown'),
            spacer(60),
        );

        const breakdowns = [
            ['By Quarter (All Programs)', snapshot.quarterCounts],
            ['By Source',                snapshot.sourceCounts],
            ['By Status',                snapshot.statusCounts],
            ['By Functional Division',   snapshot.unitCounts],
            ['By Nature of Event',       snapshot.natureOfEventCounts],
        ];
        breakdowns.forEach(([title, counts], i) => {
            children.push(
                statsTable(title, counts),
                spacer(i < breakdowns.length - 1 ? 120 : 0),
            );
        });

        // ── Build document ─────────────────────────────────────────────────
        const doc = new Document({
            styles: {
                default: {
                    document: {
                        run: { font: 'Calibri', size: 20, color: C.textDark },
                    },
                },
            },
            sections: [{
                properties: {
                    page: {
                        size:   { width: 11906, height: 16838 },
                        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 360, footer: 360 },
                    },
                },
                children,
            }],
        });

        const blob = await Packer.toBlob(doc);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `QATAME_Activity_Summary_${(snapshot.reportQuarterLine || snapshot.quarterLabel || 'report').replace(/[^a-z0-9]/gi, '_')}_${now.toISOString().slice(0, 10)}.docx`;
        a.click();
        URL.revokeObjectURL(url);

        showToast('success', 'Summary report exported to Word');
    } catch (e) {
        console.error('exportSummaryReportToWord:', e);
        showToast('error', 'Failed to export summary report');
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '<i class="fa-solid fa-file-word"></i><span>Export Word</span>';
        }
    }
}