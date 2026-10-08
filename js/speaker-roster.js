// Guard against config.js not having loaded/executed yet (slow network, blocked
// request, etc.) — without this, a missing CONFIG throws a ReferenceError here
// and silently kills the rest of this script, leaving the page blank.
// NOTE: config.js declares `const CONFIG = {...}` — a top-level const/let does
// NOT become a `window` property, so this must reference the bare identifier,
// not `window.CONFIG`.
const API_URL = (typeof CONFIG !== 'undefined') ? CONFIG.API_URL : undefined;
if (!API_URL) {
    console.error('[SpeakerRoster] CONFIG.API_URL is missing — config.js may have failed to load.');
}

let allSpeakers = [];
let filteredSpeakers = [];
let currentView = 'card';
let sortDescending = true;
let expandedMenus = { analytics: false };

// ── NEW: Workshops-first state ─────────────────────────────────────────────────
let allWorkshops = [];
let allRecords = [];
let allContainerPrograms = []; // workshops that have linked program_imports
let currentWorkshop = null;  // null = show grid, { id, title, ... } = show speakers

// ── Workshops grid pagination state ─────────────────────────────────────────
let wgCurrentPage = 1;
const WG_PAGE_SIZE = 12; // cards per page, not counting the pinned "All Programs" card

// ── Speakers list pagination state ──────────────────────────────────────────
let spCurrentPage = 1;
const SP_PAGE_SIZE_CARD  = 12; // cards per page (card view)
const SP_PAGE_SIZE_TABLE = 20; // rows per page (table view)
const SP_FETCH_CONCURRENCY = 4; // parallel requests when building the "All" view (kept low for shared-hosting DB limits)

function spPageSize() {
    return currentView === 'card' ? SP_PAGE_SIZE_CARD : SP_PAGE_SIZE_TABLE;
}

// Runs asyncFn over items with at most `limit` in flight; results keep input order.
// A failed item yields null instead of rejecting the whole batch.
async function mapWithConcurrency(items, limit, asyncFn) {
    const results = new Array(items.length).fill(null);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            try { results[i] = await asyncFn(items[i], i); }
            catch (e) { console.warn('[SpeakerRoster] request failed:', items[i], e); }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// Criteria are now a dynamic [{label, score}] array — no fixed keys or fallback labels needed.

const AVATAR_COLORS = [
    'avatar-color-0', 'avatar-color-1', 'avatar-color-2',
    'avatar-color-3', 'avatar-color-4', 'avatar-color-5'
];

// ── Rating Configuration Constants ─────────────────────────────────────────────
const MAX_RATING = 4;  // Maximum rating scale value (display only — actual scale loaded from DB)

// ── Dynamic rating scales (loaded from DB via rating_scales.php) ───────────────
let _ratingScales = {
    category: [],
    speaker: [],
    overall: []
};

async function loadRatingScales() {
    try {
        const res = await fetch(`${API_URL}/rating_scales.php`, { credentials: 'include' });
        const json = await res.json();
        if (json.success && json.scales) {
            const grouped = { category: [], speaker: [], overall: [] };
            json.scales.forEach(function (row) {
                if (row.is_active && grouped[row.scale_type]) {
                    grouped[row.scale_type].push({
                        min_score: parseFloat(row.min_score),
                        max_score: parseFloat(row.max_score),
                        level_of_agreement: row.level_of_agreement,
                        descriptive_equivalent: row.descriptive_equivalent,
                        display_order: row.display_order
                    });
                }
            });
            _ratingScales = grouped;
        }
    } catch (e) {
        console.warn('[SpeakerRoster] Could not load rating scales:', e);
    }
}

/**
 * Look up a descriptive label for a score using the DB-loaded rating scales.
 * Falls back to hardcoded thresholds if scales are not yet loaded.
 */
function _getLabel(score, type) {
    if (!score || score === 0) return 'No Data';
    const scales = _ratingScales[type] || [];
    for (const s of scales) {
        if (score >= s.min_score && score <= s.max_score) {
            return s.descriptive_equivalent;
        }
    }
    // Fallback to speaker-context hardcoded thresholds
    if (score >= 3.5) return 'Excellent';
    if (score >= 2.5) return 'Very Good';
    if (score >= 1.5) return 'Good';
    return 'Poor';
}
const TOP_PERFORMER_COUNT = 3;  // Number of speakers to show rank badge
const TITLE_MAX_LENGTH = 30;    // Max characters before truncating titles
const DEFAULT_DESIGNATION = 'Resource Person';  // Default speaker designation
const RECORD_SUFFIX = ' (Record)';  // Suffix for imported record titles
const DATE_LOCALE = 'en-US';    // Locale for date formatting
const DATE_OPTIONS = { month: 'short', day: 'numeric', year: 'numeric' };

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Imported evaluation criteria labels sometimes carry a leading
// "RESOURCE SPEAKER (Name, -Position -Unit) ." prefix copied straight from
// the Excel question header — strip it so only the actual criterion text
// ("Knowledgeable of the topic and well organized", etc.) is shown.
function cleanCriterionLabel(label) {
    if (!label) return '';
    return String(label)
        .replace(/^\s*RESOURCE\s+SPEAKER\s*\([^)]*\)\s*\.?\s*/i, '')
        .trim();
}

// =========== INIT ===========
// ─── Bootstrap ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async function () {
    await loadRatingScales();
    await checkAuthentication();
});

async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res = await fetch(`${API_URL}/main-settings.php`, {
            credentials: 'include'
        });

        if (res.status === 401) {
            clearSessionAndRedirect();
            return false;
        }

        if (!res.ok) {
            // Transient server error (5xx) rather than a genuine auth failure —
            // don't kick the user to the login screen for this.
            throw new Error(`main-settings.php returned ${res.status}`);
        }

        const json = await res.json();
        if (!json.success || !json.data?.id) {
            clearSessionAndRedirect();
            return false;
        }

        if (json.data.id) {
            localStorage.setItem('user_id', String(json.data.id));
        }
        if (json.data.full_name) {
            fullName = json.data.full_name;
            localStorage.setItem('full_name', json.data.full_name);
        }
        if (json.data.email) {
            email = json.data.email;
            localStorage.setItem('email', json.data.email);
        }
        if (json.data.role) {
            localStorage.setItem('role', json.data.role);
        }
        if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
        if (Array.isArray(json.data.permissions)) {
            localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('speakers')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);

        // Block school portal users from accessing SDO dashboard
        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }

        if (json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    alt="Profile">`;
            }
        } else {
            loadProfilePicture();
        }

        loadWorkshopsGrid();
        return true;
    } catch (e) {
        console.warn('Session validation network error:', e);

        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('speakers')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadProfilePicture();
        loadWorkshopsGrid();
        return true;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.href = 'login.html';
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    document.getElementById('sidebarAvatar').textContent = initial;
    document.getElementById('sidebarUserName').textContent = fullName || 'User';
    document.getElementById('sidebarUserEmail').textContent = email || '';
}

async function loadProfilePicture() {
    try {
        const res = await fetch(API_URL + '/main-settings.php', {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            avatar.innerHTML = `<img src="${json.data.profile_picture}" 
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" 
                alt="Profile">`;
        }
    } catch (e) { }
}


// ═══════════════════════════════════════════════════════════════════════════════
// WORKSHOPS GRID (the new landing view)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadWorkshopsGrid() {
    showView('workshops');
    wgCurrentPage = 1;
    const grid = document.getElementById('workshopsGrid');
    grid.innerHTML = `<div class="wg-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading programs…</div>`;

    try {
        // Fetch all workshops, standalone records, and container programs in parallel
        const [wsRes, recListRes, containerRes] = await Promise.all([
            fetch(`${API_URL}/workshops.php`, { credentials: 'include' }),
            fetch(`${API_URL}/records_api.php`, { credentials: 'include' }),
            fetch(`${API_URL}/programs.php?type=container`, { credentials: 'include' })
        ]);
        const wsData = await wsRes.json();
        const recData = await recListRes.json();
        const containerData = containerRes.ok ? await containerRes.json() : { success: false };

        allWorkshops = (wsData.success ? wsData.data : []) || [];
        allRecords = (recData.success ? recData.records : []) || [];

        // programs.php?type=container now returns ONLY container-type workshops,
        // so no need to cross-filter against liveWsIds.
        if (containerData.success && Array.isArray(containerData.data)) {
            allContainerPrograms = containerData.data;
        } else {
            allContainerPrograms = [];
        }

        if (!allWorkshops.length && !allRecords.length && !allContainerPrograms.length) {
            grid.innerHTML = `<div class="wg-empty"><i class="fa-solid fa-folder-open"></i><p>No programs found. Create a workshop or import data first.</p></div>`;
            document.getElementById('loadingOverlay').style.display = 'none';
            return;
        }

        // Render grid with "All Workshops" as first card
        renderWorkshopsGrid();

        // ── Background: fetch speaker counts for all programs and update cards ──
        fetchAndApplySpeakerCounts();

    } catch (err) {
        grid.innerHTML = `<div class="wg-empty" style="color:#dc2626;"><i class="fa-solid fa-circle-exclamation"></i><p>${escapeHtml(err.message)}</p></div>`;
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
    }
}

// ── Background fetch: check speaker counts and update cards with "No Speaker" badge ──
//
// NOTE: this used to fire one fetch() PER workshop/container/record in parallel
// via Promise.allSettled — with 70-100+ programs that's 70-100+ simultaneous
// DB connections, which blows past shared-hosting MySQL's max_connections and
// makes every single request in the burst fail ("Database connection error").
// Replaced with a single request to a bulk endpoint that returns all counts
// in one round trip (see api/speaker_counts.php).
async function fetchAndApplySpeakerCounts() {
    try {
        const res = await fetch(`${API_URL}/speaker_counts.php`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success || !json.data) return;

        const { workshops = {}, containers = {}, records = {} } = json.data;

        allWorkshops.forEach(w => {
            if ((workshops[String(w.id)] || 0) === 0) applyNoSpeakerBadge(String(w.id));
        });
        allContainerPrograms.forEach(p => {
            if ((containers[String(p.id)] || 0) === 0) applyNoSpeakerBadge(`container_${p.id}`);
        });
        allRecords.forEach(r => {
            if ((records[String(r.id)] || 0) === 0) applyNoSpeakerBadge(`rec_${r.id}`);
        });
    } catch (e) {
        // Non-fatal — cards just won't show the "No Speaker Assigned" badge.
        console.warn('[SpeakerRoster] Could not load speaker counts:', e);
    }
}

// Apply the "No Speaker Assigned" visual to a card already in the DOM
function applyNoSpeakerBadge(key) {
    // Find the card by its explicit data-key attribute (set in workshopCard/recordCard/
    // containerProgramCard) rather than string-matching the onclick handler — matching
    // onclick text is fragile (e.g. id "1" could match inside id "21").
    const targetCard = document.querySelector(`#workshopsGrid .wg-card[data-key="${CSS.escape(key)}"]`);

    if (!targetCard) return;

    // Add disabled styling
    targetCard.classList.add('wg-card--no-speaker');
    targetCard.removeAttribute('onclick');

    // Replace footer content
    const footer = targetCard.querySelector('.wg-card-footer');
    if (footer) {
        footer.innerHTML = `<span class="wg-no-speaker-badge"><i class="fa-solid fa-user-slash"></i> No Speaker Assigned</span>`;
    }
}

function renderWorkshopsGrid() {
    const grid = document.getElementById('workshopsGrid');
    const q = (document.getElementById('wgSearch')?.value || '').toLowerCase();

    // Compute total count for "All" card
    const totalWorkshops = allWorkshops.length + allRecords.length + allContainerPrograms.length;

    // "All Programs" card
    const allCard = `
        <div class="wg-card wg-card--all" onclick="selectWorkshop('all')">
            <div class="wg-card-top">
                <span class="wg-status wg-status--all"><i class="fa-solid fa-globe"></i> All Programs</span>
                <span class="wg-days">${totalWorkshops} program${totalWorkshops !== 1 ? 's' : ''}</span>
            </div>
            <div class="wg-card-memo">AGGREGATED VIEW</div>
            <div class="wg-card-title">View All Speakers</div>
            <div class="wg-card-meta">
                <span><i class="fa-solid fa-users"></i> All resource persons across programs</span>
            </div>
            <div class="wg-card-footer">
                <span class="wg-card-participants"><i class="fa-solid fa-person-chalkboard"></i> Combined roster</span>
                <span class="wg-card-arrow"><i class="fa-solid fa-arrow-right"></i> View All</span>
            </div>
        </div>`;

    // Filter workshops
    const filteredWs = allWorkshops.filter(w =>
        !q || w.title.toLowerCase().includes(q) ||
        (w.division_memo || '').toLowerCase().includes(q) ||
        (w.venue || '').toLowerCase().includes(q)
    );

    // Filter container programs
    const filteredContainers = allContainerPrograms.filter(p =>
        !q || p.title.toLowerCase().includes(q) ||
        (p.division_memo || '').toLowerCase().includes(q)
    );

    // Filter standalone records
    const filteredRec = allRecords.filter(r =>
        !q || r.title.toLowerCase().includes(q)
    );

    if (!filteredWs.length && !filteredRec.length && !filteredContainers.length && q) {
        grid.innerHTML = allCard + `<div class="wg-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No programs match "<strong>${escapeHtml(q)}</strong>".</p></div>`;
        renderWgPagination(0, 1);
        return;
    }

    // Combine into one list so pagination is applied consistently across
    // workshops, container programs, and standalone records — the pinned
    // "All Programs" card above is not part of this and always shows.
    const combined = [
        ...filteredWs.map(w => ({ type: 'workshop', data: w })),
        ...filteredContainers.map(p => ({ type: 'container', data: p })),
        ...filteredRec.map(r => ({ type: 'record', data: r })),
    ];

    const totalItems = combined.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / WG_PAGE_SIZE));
    if (wgCurrentPage > totalPages) wgCurrentPage = totalPages;
    if (wgCurrentPage < 1) wgCurrentPage = 1;

    const startIdx = (wgCurrentPage - 1) * WG_PAGE_SIZE;
    const pageItems = combined.slice(startIdx, startIdx + WG_PAGE_SIZE);

    const pageCards = pageItems.map(item => {
        if (item.type === 'workshop') return workshopCard(item.data);
        if (item.type === 'container') return containerProgramCard(item.data);
        return recordCard(item.data);
    }).join('');

    grid.innerHTML = allCard + pageCards;

    renderWgPagination(totalItems, totalPages);
}

// ── Pagination controls for the workshops grid ──────────────────────────────
function renderWgPagination(totalItems, totalPages) {
    const container = document.getElementById('wgPagination');
    if (!container) return;

    if (totalItems === 0) {
        container.innerHTML = '';
        return;
    }

    const start = (wgCurrentPage - 1) * WG_PAGE_SIZE + 1;
    const end = Math.min(wgCurrentPage * WG_PAGE_SIZE, totalItems);

    if (totalPages <= 1) {
        container.innerHTML = `<div class="wg-pagination-info">Showing all ${totalItems} program${totalItems !== 1 ? 's' : ''}</div>`;
        return;
    }

    const pageBtns = wgPageList(wgCurrentPage, totalPages).map(p => {
        if (p === '…') return `<span class="wg-page-ellipsis">…</span>`;
        return `<button class="wg-page-btn${p === wgCurrentPage ? ' active' : ''}" onclick="goToWgPage(${p})" ${p === wgCurrentPage ? 'aria-current="page"' : ''}>${p}</button>`;
    }).join('');

    container.innerHTML = `
        <div class="wg-pagination-info">Showing ${start}–${end} of ${totalItems} program${totalItems !== 1 ? 's' : ''}</div>
        <div class="wg-pagination-controls">
            <button class="wg-page-nav" onclick="goToWgPage(${wgCurrentPage - 1})" ${wgCurrentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            ${pageBtns}
            <button class="wg-page-nav" onclick="goToWgPage(${wgCurrentPage + 1})" ${wgCurrentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        </div>`;
}

// Compact page-number list with ellipses, e.g. [1, '…', 4, 5, 6, '…', 12]
function wgPageList(current, total) {
    const delta = 1;
    const middle = [];
    for (let i = Math.max(2, current - delta); i <= Math.min(total - 1, current + delta); i++) {
        middle.push(i);
    }

    const result = [1];
    if (middle.length && middle[0] > 2) result.push('…');
    result.push(...middle);
    if (middle.length && middle[middle.length - 1] < total - 1) result.push('…');
    if (total > 1) result.push(total);
    return result;
}

function goToWgPage(page) {
    if (page < 1 || page === wgCurrentPage) return;
    wgCurrentPage = page;
    renderWorkshopsGrid(); // clamps against the current filtered count internally
    document.getElementById('workshopsGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function workshopCard(w) {
    const statusCls = { completed: 'wg-status--completed', ongoing: 'wg-status--ongoing', upcoming: 'wg-status--upcoming', cancelled: 'wg-status--cancelled' }[w.status] || '';
    const statusLbl = { completed: '✓ Completed', ongoing: '● Ongoing', upcoming: '○ Upcoming', cancelled: '✕ Cancelled' }[w.status] || w.status;

    const start = w.start_date ? new Date(w.start_date).toLocaleDateString(DATE_LOCALE, DATE_OPTIONS) : '—';
    const end = w.end_date ? new Date(w.end_date).toLocaleDateString(DATE_LOCALE, DATE_OPTIONS) : '—';
    const dates = w.start_date === w.end_date ? start : `${start} – ${end}`;

    // Disable card if speaker_count is explicitly 0
    const hasSpeakers = w.speaker_count === undefined || w.speaker_count === null || w.speaker_count > 0;
    const disabledClass = !hasSpeakers ? ' wg-card--no-speaker' : '';
    const onclickAttr = hasSpeakers ? `onclick="selectWorkshop(${w.id})"` : '';

    const speakerFooter = hasSpeakers
        ? `<span class="wg-card-participants"><i class="fa-solid fa-person-chalkboard"></i> Resource Speakers</span>
           <span class="wg-card-arrow"><i class="fa-solid fa-arrow-right"></i> View</span>`
        : `<span class="wg-no-speaker-badge"><i class="fa-solid fa-user-slash"></i> No Speaker Assigned</span>`;

    return `<div class="wg-card${disabledClass}" data-key="${w.id}" ${onclickAttr}>
        <div class="wg-card-top">
            <span class="wg-status ${statusCls}">${statusLbl}</span>
            <span class="wg-days">${w.total_days || (w.days?.length || 1)} day${(w.total_days || w.days?.length || 1) > 1 ? 's' : ''}</span>
        </div>
        <div class="wg-card-memo">${escapeHtml(w.division_memo || '—')}</div>
        <div class="wg-card-title">${escapeHtml(w.title)}</div>
        <div class="wg-card-meta">
            <span><i class="fa-solid fa-calendar-days"></i> ${dates}</span>
            ${w.venue ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(w.venue)}</span>` : ''}
        </div>
        <div class="wg-card-footer">
            ${speakerFooter}
        </div>
    </div>`;
}

function recordCard(r) {
    const hasSpeakers = r.speaker_count === undefined || r.speaker_count === null || r.speaker_count > 0;
    const disabledClass = !hasSpeakers ? ' wg-card--no-speaker' : '';
    const onclickAttr = hasSpeakers ? `onclick="selectWorkshop('rec_${r.id}')"` : '';

    const speakerFooter = hasSpeakers
        ? `<span class="wg-card-participants"><i class="fa-solid fa-person-chalkboard"></i> Resource Speakers</span>
           <span class="wg-card-arrow"><i class="fa-solid fa-arrow-right"></i> View</span>`
        : `<span class="wg-no-speaker-badge"><i class="fa-solid fa-user-slash"></i> No Speaker Assigned</span>`;

    return `<div class="wg-card${disabledClass}" data-key="rec_${r.id}" ${onclickAttr}>
        <div class="wg-card-top">
            <span class="wg-status wg-status--completed">📋 Record</span>
            <span class="wg-days">Imported</span>
        </div>
        <div class="wg-card-memo">SAVED RECORD</div>
        <div class="wg-card-title">${escapeHtml(r.title)}</div>
        <div class="wg-card-meta">
            <span><i class="fa-solid fa-file-import"></i> Imported evaluation data</span>
        </div>
        <div class="wg-card-footer">
            ${speakerFooter}
        </div>
    </div>`;
}

function containerProgramCard(p) {
    const importCount = p.import_count || p.total_days || '';
    const dayLabel = importCount ? `${importCount} day import${importCount !== 1 ? 's' : ''}` : 'Multi-day';

    const hasSpeakers = p.speaker_count === undefined || p.speaker_count === null || p.speaker_count > 0;
    const disabledClass = !hasSpeakers ? ' wg-card--no-speaker' : '';
    const onclickAttr = hasSpeakers ? `onclick="selectWorkshop('container_${p.id}')"` : '';

    const speakerFooter = hasSpeakers
        ? `<span class="wg-card-participants"><i class="fa-solid fa-person-chalkboard"></i> Resource Speakers</span>
           <span class="wg-card-arrow"><i class="fa-solid fa-arrow-right"></i> View</span>`
        : `<span class="wg-no-speaker-badge"><i class="fa-solid fa-user-slash"></i> No Speaker Assigned</span>`;

    return `<div class="wg-card${disabledClass}" data-key="container_${p.id}" ${onclickAttr}>
        <div class="wg-card-top">
            <span class="wg-status wg-status--completed">📂 Container</span>
            <span class="wg-days">${escapeHtml(dayLabel)}</span>
        </div>
        <div class="wg-card-memo">${escapeHtml(p.division_memo || 'CONTAINER PROGRAM')}</div>
        <div class="wg-card-title">${escapeHtml(p.title)}</div>
        <div class="wg-card-meta">
            <span><i class="fa-solid fa-layer-group"></i> Multi-day imported program</span>
            ${p.venue ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(p.venue)}</span>` : ''}
        </div>
        <div class="wg-card-footer">
            ${speakerFooter}
        </div>
    </div>`;
}

function filterWorkshopsGrid() {
    wgCurrentPage = 1; // new search results — always start back at page 1
    renderWorkshopsGrid();
}

async function selectWorkshop(id) {
    if (id === 'all') {
        currentWorkshop = { id: 'all', title: 'All Speakers', division_memo: 'AGGREGATED VIEW', status: 'all' };
    } else if (String(id).startsWith('container_')) {
        const containerId = parseInt(String(id).replace('container_', ''));
        const prog = allContainerPrograms.find(p => p.id === containerId);
        currentWorkshop = prog
            ? { id: id, title: prog.title, division_memo: prog.division_memo || 'CONTAINER PROGRAM',
                status: 'completed', isContainer: true, workshopId: containerId }
            : null;
    } else if (String(id).startsWith('rec_')) {
        const recId = parseInt(String(id).replace('rec_', ''));
        const rec = allRecords.find(r => r.id === recId);
        currentWorkshop = rec ? { id: id, title: rec.title, division_memo: 'SAVED RECORD', status: 'completed', isRecord: true } : null;
    } else {
        currentWorkshop = allWorkshops.find(w => w.id === parseInt(id));
    }

    if (!currentWorkshop) return;

    showView('speakers');
    renderWorkshopHeader();
    document.getElementById('loadingOverlay').style.display = 'flex';

    await loadSpeakers();
}

function renderWorkshopHeader() {
    const w = currentWorkshop;
    const isAll = w.id === 'all';

    const start = w.start_date ? new Date(w.start_date).toLocaleDateString(DATE_LOCALE, DATE_OPTIONS) : '';
    const end = w.end_date ? new Date(w.end_date).toLocaleDateString(DATE_LOCALE, DATE_OPTIONS) : '';
    const dates = isAll ? 'All programs combined' : ((w.start_date === w.end_date || !w.end_date) ? start : `${start} – ${end}`) + (w.venue ? ` · ${w.venue}` : '');

    const statusCls = {
        completed: 'ws-pill--completed', ongoing: 'ws-pill--ongoing',
        upcoming: 'ws-pill--upcoming', cancelled: 'ws-pill--cancelled',
        all: 'ws-pill--all', container: 'ws-pill--completed'
    }[w.status] || '';

    document.getElementById('wsTitle').textContent = w.title;
    document.getElementById('wsMemo').textContent = w.division_memo || '';
    document.getElementById('wsDates').textContent = dates;
    document.getElementById('wsStatus').className = `ws-pill ${statusCls}`;
    document.getElementById('wsStatus').textContent = isAll
        ? 'All Programs'
        : w.isContainer
            ? 'Container Program'
            : (w.status?.charAt(0).toUpperCase() + w.status?.slice(1) || 'Unknown');
}

function goBackToWorkshops() {
    currentWorkshop = null;
    allSpeakers = [];
    filteredSpeakers = [];
    loadWorkshopsGrid();
}

// ── View switcher ──────────────────────────────────────────────────────────────
function showView(view) {
    document.getElementById('viewWorkshops').style.display = view === 'workshops' ? '' : 'none';
    document.getElementById('viewSpeakers').style.display = view === 'speakers' ? '' : 'none';
}

// =========== DATA LOADING ===========
async function loadSpeakers() {
    try {
        const speakerMap = {}; // keyed by speaker id
        const isAll = currentWorkshop?.id === 'all';
        const isRecord = currentWorkshop?.isRecord;
        const isContainer = currentWorkshop?.isContainer;
        const workshopId = isRecord
            ? parseInt(String(currentWorkshop.id).replace('rec_', ''))
            : isContainer
                ? currentWorkshop.workshopId
                : currentWorkshop?.id;

        // ── Container program path: uses speaker_roster.php?workshop_id=X&container=1 ──
        if (isContainer) {
            const cRes = await fetch(
                `${API_URL}/speaker_roster.php?workshop_id=${workshopId}&container=1`,
                { credentials: 'include' }
            );
            const cData = await cRes.json();
            if (cData.success && cData.data?.speakers?.length) {
                cData.data.speakers.forEach(sp => {
                    const key = sp.id || `container_${workshopId}_${sp.number}`;
                    speakerMap[key] = {
                        id: key,
                        speaker_id: sp.speaker_id,
                        sa_entries: sp.sa_entries || [],
                        name: sp.name || `RP ${sp.number}`,
                        designation: sp.designation || '',
                        organization: sp.organization || '',
                        contact: sp.contact || '',
                        topic: sp.topic || '',
                        number: sp.number,
                        rating: sp.rating || 0,
                        rating_count: sp.rating_count || 0,
                        criteria: sp.criteria || [],
                        appearances: sp.appearances || [],
                        workshop_id: workshopId
                    };
                });
            }
        }

        // Also gather speakers from saved records
        if (isAll || isRecord) {
            const recordsToProcess = isAll ? allRecords : allRecords.filter(r => parseInt(r.id) === workshopId);

            // Fetch records in parallel (bounded) instead of one-by-one — this is
            // the biggest chunk of the "All Speakers" load time.
            const recPrograms = await mapWithConcurrency(recordsToProcess, SP_FETCH_CONCURRENCY, async rec => {
                const rRes = await fetch(`${API_URL}/records_api.php?id=${rec.id}`, { credentials: 'include' });
                const rJson = await rRes.json();
                return rJson.success ? rJson.program : null;
            });

            for (let ri = 0; ri < recordsToProcess.length; ri++) {
                const rec = recordsToProcess[ri];
                const program = recPrograms[ri];
                if (!program) continue;
                try {

                    (program.days || []).forEach((day, dayIdx) => {
                        // day.day is "Day 1", "Day 2" etc — extract the number and strip prefix
                        const rawDay = String(day.day || '');
                        const dayNum = parseInt(rawDay.replace(/^Day\s*/i, '')) || (dayIdx + 1);
                        // Strip "Day N" prefix — if nothing remains, leave empty (don't fall back to rawDay)
                        const dayTitle = rawDay.replace(/^Day\s*\d+\s*[-–—]?\s*/i, '').trim();
                        const dayRespondents = day.respondents || 0;

                        (day.speakers || []).forEach(sp => {
                            const key = `rec_${rec.id}_${sp.slot_number || sp.speaker_name}`;
                            const spRating = parseFloat(sp.overall_avg) || 0;

                            // Build criteria as a dynamic [{label, score}] array — no positional key mapping
                            const criteriaArr = (sp.criteria && sp.criteria.length)
                                ? sp.criteria.map(c => ({
                                    label: c.label || c.criterion_label || '',
                                    score: parseFloat(c.average_score ?? c.score) || 0
                                }))
                                : [];

                            if (!speakerMap[key]) {
                                speakerMap[key] = {
                                    id: key,
                                    speaker_id: null,
                                    name: sp.speaker_name || `RP ${sp.slot_number}`,
                                    designation: '',
                                    organization: '',
                                    contact: '',
                                    topic: '',
                                    number: sp.slot_number || 0,
                                    rating: spRating,
                                    rating_count: dayRespondents,
                                    criteria: criteriaArr,
                                    appearances: [],
                                    workshop_id: 'rec_' + rec.id
                                };
                            } else {
                                // Speaker appears on multiple days — weighted average
                                const existing = speakerMap[key];
                                if (spRating > 0) {
                                    const totalCount = existing.rating_count + dayRespondents;
                                    existing.rating = totalCount > 0
                                        ? (existing.rating * existing.rating_count + spRating * dayRespondents) / totalCount
                                        : spRating;
                                    existing.rating_count = totalCount;
                                }
                                // Merge criteria: append entries not already present (matched by label)
                                const existingLabels = existing.criteria.map(c => c.label);
                                criteriaArr.forEach(c => {
                                    if (!existingLabels.includes(c.label)) existing.criteria.push(c);
                                });
                            }

                            speakerMap[key].appearances.push({
                                workshop_title: rec.title + RECORD_SUFFIX,
                                day_number: dayNum,
                                day_title: dayTitle,
                                topic: '',
                                rating: spRating,
                                rating_count: dayRespondents,
                                criteria: criteriaArr.length > 0 ? criteriaArr : null,
                                feedback: program.feedback || null
                            });
                        });
                    });
                } catch (e) { console.warn('[SpeakerRoster] Failed to load record:', rec.id, e); }
            }
        }

        // Also gather speakers from container programs (all-view only)
        if (isAll && allContainerPrograms.length > 0) {
            const containerResults = await mapWithConcurrency(allContainerPrograms, SP_FETCH_CONCURRENCY, async prog => {
                const cRes = await fetch(
                    `${API_URL}/speaker_roster.php?workshop_id=${prog.id}&container=1`,
                    { credentials: 'include' }
                );
                return await cRes.json();
            });

            for (let ci = 0; ci < allContainerPrograms.length; ci++) {
                const prog = allContainerPrograms[ci];
                const cData = containerResults[ci];
                if (!cData || !cData.success || !cData.data?.speakers?.length) continue;
                try {

                    cData.data.speakers.forEach(sp => {
                        const key = `container_${prog.id}_slot_${sp.number}`;
                        const spRating = sp.rating || 0;
                        // criteria from speaker_roster.php is already a [{label, score}] array
                        const criteriaArr = Array.isArray(sp.criteria) ? sp.criteria : [];

                        if (!speakerMap[key]) {
                            speakerMap[key] = {
                                id: key,
                                speaker_id: null,
                                sa_entries: sp.sa_entries || [],
                                name: sp.name || `RP ${sp.number}`,
                                designation: sp.designation || '',
                                organization: sp.organization || '',
                                contact: sp.contact || '',
                                topic: sp.topic || '',
                                number: sp.number,
                                rating: spRating,
                                rating_count: sp.rating_count || 0,
                                criteria: criteriaArr,
                                appearances: sp.appearances || [],
                                workshop_id: 'container_' + prog.id
                            };
                        } else {
                            const existing = speakerMap[key];
                            if (spRating > 0) {
                                const totalCount = existing.rating_count + (sp.rating_count || 0);
                                existing.rating = totalCount > 0
                                    ? (existing.rating * existing.rating_count + spRating * (sp.rating_count || 0)) / totalCount
                                    : spRating;
                                existing.rating_count = totalCount;
                            }
                            // Merge criteria: append entries not already present (matched by label)
                            const existingLabels = existing.criteria.map(c => c.label);
                            criteriaArr.forEach(c => {
                                if (!existingLabels.includes(c.label)) existing.criteria.push(c);
                            });
                            existing.appearances.push(...(sp.appearances || []));
                        }
                    });
                } catch (e) { console.warn('[SpeakerRoster] Failed to load container:', prog.id, e); }
            }
        }

        allSpeakers = Object.values(speakerMap);

        if (allSpeakers.length === 0 && currentWorkshop?.id !== 'all') {
            // Show a clear "no speakers" empty state in the speakers view
            const grid = document.getElementById('speakersGrid');
            const emptyState = document.getElementById('emptyState');
            if (grid) grid.innerHTML = '';
            if (emptyState) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = `
                    <div class="empty-icon">🎤</div>
                    <h2>No Speakers Assigned</h2>
                    <p>This program doesn't have any resource speakers assigned yet.<br>
                    Speakers can be added through the program's evaluation setup.</p>`;
            }
            computeStats();
            filteredSpeakers = [];
            document.getElementById('loadingOverlay').style.display = 'none';
            return;
        }

        computeStats();
        filteredSpeakers = [...allSpeakers];
        sortSpeakers();
        spCurrentPage = 1;
        render();

    } catch (err) {
        allSpeakers = [];
        computeStats();
        filteredSpeakers = [...allSpeakers];
        render();
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
        // Auto-open speaker profile if ?speaker= is in the URL
        autoOpenSpeakerFromURL();
    }
}

/**
 * Check URL for ?speaker=Name and auto-open that speaker's modal
 */
function autoOpenSpeakerFromURL() {
    const params = new URLSearchParams(window.location.search);
    const speakerName = params.get('speaker');
    if (!speakerName) return;
    const needle = speakerName.toLowerCase().trim();
    // Try exact match first, then partial
    let match = allSpeakers.find(s => s.name.toLowerCase().trim() === needle);
    if (!match) match = allSpeakers.find(s => s.name.toLowerCase().trim().includes(needle) || needle.includes(s.name.toLowerCase().trim()));
    if (match) {
        openModal(match.id);
    } else {
        console.warn('[SpeakerRoster] No speaker found matching:', speakerName);
    }
}

// =========== STATS ===========
function computeStats() {
    const total = allSpeakers.length;
    const rated = allSpeakers.filter(s => s.rating > 0);
    const avgRating = rated.length ? (rated.reduce((a, s) => a + s.rating, 0) / rated.length) : 0;
    const top = [...allSpeakers].sort((a, b) => b.rating - a.rating)[0];
    const totalRatings = allSpeakers.reduce((a, s) => a + (s.rating_count || 0), 0);

    const scaleMax = _ratingScales.speaker.length
        ? Math.max(..._ratingScales.speaker.map(s => s.max_score))
        : MAX_RATING;

    document.getElementById('statTotal').textContent = total;
    document.getElementById('statAvgRating').textContent = rated.length ? avgRating.toFixed(2) : '—';
    document.getElementById('statTopName').textContent = top ? (top.name.split(' ').slice(0, 2).join(' ')) : '—';
    document.getElementById('statTopRating').textContent = top && top.rating > 0 ? `Rating: ${top.rating.toFixed(2)} / ${scaleMax.toFixed(2)}` : 'No ratings yet';
    document.getElementById('statTotalRatings').textContent = totalRatings;

    // Update stat-sub text based on context
    const subEl = document.getElementById('statTotalSub');
    if (subEl) {
        subEl.textContent = currentWorkshop?.id === 'all' ? 'across all programs' : 'in this program';
    }
}

// =========== RATING HELPERS ===========
/**
 * Maps a dynamic descriptive label from _ratingScales to a CSS class name.
 * Works for any label returned by the DB (e.g. "Very Satisfactory", "Excellent").
 */
function _labelToCssClass(label) {
    if (!label || label === 'No Data') return 'no-data';
    const l = label.toLowerCase();
    // Handle both "Excellent"/"Very Good"/"Good"/"Poor" (speaker scale)
    // and "Very Satisfactory"/"Satisfactory"/"Unsatisfactory"/"Very Unsatisfactory" (category scale)
    if (l.includes('very sat') || l === 'excellent') return 'excellent';
    if (l.includes('satisfactory') || l.includes('very good')) return 'very-good';
    if (l.includes('good') || l.includes('unsatisfactory')) return 'good';
    return 'poor';
}

function getRatingClass(rating) {
    if (!rating || rating === 0) return 'no-data';
    return _labelToCssClass(_getLabel(rating, 'speaker'));
}
function getRatingLabel(rating) {
    if (!rating || rating === 0) return 'No Data';
    return _getLabel(rating, 'speaker');
}
function getFillClass(rating) {
    const cls = getRatingClass(rating);
    return cls === 'no-data' ? 'fill-default' : `fill-${cls}`;
}
function getBarColor(val) {
    if (!val) return '#e5e7eb';
    const cls = _labelToCssClass(_getLabel(val, 'speaker'));
    if (cls === 'excellent')  return '#22c55e';
    if (cls === 'very-good')  return '#3b82f6';
    if (cls === 'good')       return '#f59e0b';
    return '#ef4444';
}
function criteriaPercent(val) {
    if (!val) return 0;
    // Use the highest max_score in the speaker scale, fall back to MAX_RATING constant
    const scaleMax = _ratingScales.speaker.length
        ? Math.max(..._ratingScales.speaker.map(s => s.max_score))
        : MAX_RATING;
    return (val / scaleMax) * 100;
}

function renderStars(rating) {
    if (!rating) return '<div class="stars">—</div>';
    const scaleMax = _ratingScales.speaker.length
        ? Math.max(..._ratingScales.speaker.map(s => s.max_score))
        : MAX_RATING;
    let html = '<div class="stars">';
    for (let i = 1; i <= scaleMax; i++) {
        if (rating >= i) html += '<span class="star filled">★</span>';
        else if (rating >= i - 0.5) html += '<span class="star half">★</span>';
        else html += '<span class="star empty">★</span>';
    }
    html += '</div>';
    return html;
}

function getInitials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// =========== RENDER ===========
function render() {
    if (currentView === 'card') renderCards();
    else renderTable();
    renderSpPagination();
}

// Returns the slice of filteredSpeakers for the current page and its offset
// into the full list (so rank badges / row numbers stay global, not per-page).
function getSpPage() {
    const size = spPageSize();
    const totalPages = Math.max(1, Math.ceil(filteredSpeakers.length / size));
    if (spCurrentPage > totalPages) spCurrentPage = totalPages;
    if (spCurrentPage < 1) spCurrentPage = 1;
    const offset = (spCurrentPage - 1) * size;
    return { items: filteredSpeakers.slice(offset, offset + size), offset, totalPages, size };
}

function renderSpPagination() {
    const container = document.getElementById('speakersPagination');
    if (!container) return;

    const totalItems = filteredSpeakers.length;
    if (totalItems === 0) { container.innerHTML = ''; return; }

    const { offset, totalPages, size } = getSpPage();
    const start = offset + 1;
    const end = Math.min(offset + size, totalItems);
    const noun = totalItems !== 1 ? 'speakers' : 'speaker';

    if (totalPages <= 1) {
        container.innerHTML = `<div class="wg-pagination-info">Showing all ${totalItems} ${noun}</div>`;
        return;
    }

    const pageBtns = wgPageList(spCurrentPage, totalPages).map(p => {
        if (p === '…') return `<span class="wg-page-ellipsis">…</span>`;
        return `<button class="wg-page-btn${p === spCurrentPage ? ' active' : ''}" onclick="goToSpPage(${p})" ${p === spCurrentPage ? 'aria-current="page"' : ''}>${p}</button>`;
    }).join('');

    container.innerHTML = `
        <div class="wg-pagination-info">Showing ${start}–${end} of ${totalItems} ${noun}</div>
        <div class="wg-pagination-controls">
            <button class="wg-page-nav" onclick="goToSpPage(${spCurrentPage - 1})" ${spCurrentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            ${pageBtns}
            <button class="wg-page-nav" onclick="goToSpPage(${spCurrentPage + 1})" ${spCurrentPage >= getSpPage().totalPages ? 'disabled' : ''} aria-label="Next page">
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        </div>`;
}

function goToSpPage(page) {
    if (page < 1 || page === spCurrentPage) return;
    spCurrentPage = page;
    render();
    document.getElementById('searchInput')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCards() {
    const grid = document.getElementById('speakersGrid');
    const empty = document.getElementById('emptyState');

    if (!filteredSpeakers.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    const { items: pageItems, offset } = getSpPage();

    grid.innerHTML = pageItems.map((sp, pageIdx) => {
        const idx = offset + pageIdx; // global position (rank badge, avatar colour)
        const rc = getRatingClass(sp.rating);
        const rl = getRatingLabel(sp.rating);
        const avatarClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];
        const ratingDisplay = sp.rating > 0 ? sp.rating.toFixed(2) : '—';

        // Determine active day for this card (null = show overall average)
        const activeDayIdx = sp._activeDayIdx ?? null;
        const activeAppearance = activeDayIdx !== null ? sp.appearances?.[activeDayIdx] : null;
        const displayCriteria = activeAppearance?.criteria || sp.criteria;
        const displayRating = activeAppearance ? (activeAppearance.rating || 0) : sp.rating;
        const displayRatingCount = activeAppearance ? (activeAppearance.rating_count || 0) : sp.rating_count;
        const displayRatingClass = getRatingClass(displayRating);
        const displayRatingLabel = getRatingLabel(displayRating);
        const displayRatingStr = displayRating > 0 ? displayRating.toFixed(2) : '—';

        const criteriaHtml = (displayCriteria && displayCriteria.length > 0) ? displayCriteria.map(c => {
            const val = c.score > 0 ? c.score : null;
            const pct = criteriaPercent(val);
            const color = getBarColor(val);
            return `
                        <div class="criteria-bar-row">
                            <div class="criteria-bar-label" title="${escapeHtml(cleanCriterionLabel(c.label))}">${escapeHtml(cleanCriterionLabel(c.label))}</div>
                            <div class="criteria-bar-track">
                                <div class="criteria-bar-fill" style="width:${pct}%;background:${color};"></div>
                            </div>
                            <div class="criteria-bar-val">${val != null ? val.toFixed(2) : '—'}</div>
                        </div>`;
        }).join('') : '<p style="font-size:12px;color:#9ca3af;">No criteria data available</p>';

        // Build day tags — clickable to show per-day scores
        const dayTagsHtml = (sp.appearances && sp.appearances.length)
            ? [
                // "All" pill when multiple days exist
                sp.appearances.length > 1
                    ? `<span class="day-tag ${activeDayIdx === null ? 'day-tag--active' : ''}"
                            onclick="event.stopPropagation();setSpeakerActiveDay('${sp.id}', null)"
                            title="Show overall average">
                            <i class="fa-solid fa-layer-group"></i> All
                       </span>`
                    : '',
                ...sp.appearances.map((a, aIdx) =>
                    `<span class="day-tag ${activeDayIdx === aIdx ? 'day-tag--active' : ''}"
                            onclick="event.stopPropagation();setSpeakerActiveDay('${sp.id}', ${aIdx})"
                            title="Day ${a.day_number}${a.day_title ? ' — ' + a.day_title : ''} — click to view this day's scores">
                        <i class="fa-solid fa-calendar-day"></i> Day ${a.day_number || '?'}
                    </span>`)
            ].join('')
            : '<span class="day-tag"><i class="fa-solid fa-calendar-day"></i> Day —</span>';

        return `
                <div class="speaker-card" onclick="openModal('${sp.id}')">
                    <div class="speaker-card-header">
                        <div class="speaker-avatar ${avatarClass}">
                            ${escapeHtml(getInitials(sp.name))}
                            ${idx < TOP_PERFORMER_COUNT && sp.rating > 0 ? `<div class="rank-badge">${idx + 1}</div>` : ''}
                        </div>
                        <div class="speaker-info">
                            <div class="speaker-name" title="${escapeHtml(sp.name)}">${escapeHtml(sp.name)}</div>
                            <div class="speaker-designation">${escapeHtml(sp.designation || DEFAULT_DESIGNATION)}</div>
                            <div class="speaker-org">${escapeHtml(sp.organization || '—')}</div>
                        </div>
                    </div>
                    <div class="speaker-card-body">
                        <div class="rating-display">
                            <div class="rating-big ${displayRatingClass}">${displayRatingStr}</div>
                            <div class="rating-meta">
                                <div class="rating-label-badge badge-${displayRatingClass}">${displayRatingLabel}</div>
                                <div class="rating-responses">${displayRatingCount} evaluation${displayRatingCount !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        ${renderStars(displayRating)}
                        <div class="criteria-bars">${criteriaHtml}</div>
                        ${sp.topic ? `
                        <div class="speaker-topic">
                            <div class="label">Session Topic</div>
                            <div class="value">${escapeHtml(sp.topic)}</div>
                        </div>` : ''}
                    </div>
                    <div class="speaker-card-footer">
                        <div class="speaker-day-tags">${dayTagsHtml}</div>
                        <button class="btn-details" onclick="event.stopPropagation();openModal('${sp.id}')">
                            View Profile
                        </button>
                    </div>
                </div>`;
    }).join('');
}

function renderTable() {
    const tbody = document.getElementById('speakersTableBody');
    const empty = document.getElementById('emptyStateTable');
    const container = document.querySelector('.table-container');

    if (!filteredSpeakers.length) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    const { items: pageItems, offset } = getSpPage();

    tbody.innerHTML = pageItems.map((sp, pageIdx) => {
        const idx = offset + pageIdx; // global row number
        const rc = getRatingClass(sp.rating);
        const rl = getRatingLabel(sp.rating);
        const avatarClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];
        const ratingDisplay = sp.rating > 0 ? sp.rating.toFixed(2) : '—';
        const _scaleMax = _ratingScales.speaker.length
            ? Math.max(..._ratingScales.speaker.map(s => s.max_score))
            : MAX_RATING;
        const pct = sp.rating > 0 ? (sp.rating / _scaleMax) * 100 : 0;
        const fillColor = getBarColor(sp.rating);
        const app = sp.appearances?.[0];

        return `
                <tr>
                    <td><strong>${idx + 1}</strong></td>
                    <td>
                        <div class="table-name-cell">
                            <div class="table-avatar ${avatarClass}">${escapeHtml(getInitials(sp.name))}</div>
                            <div class="table-name-info">
                                <div class="name">${escapeHtml(sp.name)}</div>
                                <div class="desig">${escapeHtml(sp.designation || '')}</div>
                            </div>
                        </div>
                    </td>
                    <td>${escapeHtml(sp.organization || '—')}</td>
                    <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(sp.topic || '')}">${escapeHtml(sp.topic || '—')}</td>
                    <td>
                        <div style="font-size:13px;">${escapeHtml(app?.workshop_title?.substring(0, TITLE_MAX_LENGTH) || '—')}${(app?.workshop_title?.length || 0) > TITLE_MAX_LENGTH ? '…' : ''}</div>
                        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                            ${(sp.appearances && sp.appearances.length
                ? sp.appearances.map(a => `<span class="day-tag" style="font-size:10px;padding:2px 6px;">Day ${a.day_number || '?'}</span>`).join('')
                : `<span class="day-tag" style="font-size:10px;padding:2px 6px;">Day —</span>`
            )}
                        </div>
                    </td>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <div class="inline-bar">
                                <div class="inline-bar-fill" style="width:${pct}%;background:${fillColor};"></div>
                            </div>
                            <span class="rating-label-badge badge-${rc}">${ratingDisplay}</span>
                        </div>
                    </td>
                    <td>${sp.rating_count || 0}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-icon btn-view" onclick="openModal('${sp.id}')" title="View Profile">
                                <i class="fa-solid fa-eye"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
    }).join('');
}

/**
 * Set the active day for a speaker card and re-render just that card.
 * dayIdx = null means show overall average across all days.
 */
function setSpeakerActiveDay(speakerId, dayIdx) {
    const sp = allSpeakers.find(s => String(s.id) === String(speakerId));
    if (!sp) return;
    sp._activeDayIdx = dayIdx;
    // Re-render so the card updates in place
    render();
}

function renderEmpty() {
    document.getElementById('emptyState').classList.remove('hidden');
}

// =========== MODAL ===========
function openModal(speakerId) {
    const sp = allSpeakers.find(s => String(s.id) === String(speakerId));
    if (!sp) return;

    const idx = allSpeakers.indexOf(sp);
    const avatarClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const rc = getRatingClass(sp.rating);
    const rl = getRatingLabel(sp.rating);

    // Avatar
    const avatar = document.getElementById('modalAvatar');
    avatar.className = `modal-avatar ${avatarClass}`;
    avatar.textContent = getInitials(sp.name);

    document.getElementById('modalName').textContent = sp.name;
    document.getElementById('modalMeta').innerHTML = `
                ${escapeHtml(sp.designation || DEFAULT_DESIGNATION)} &nbsp;·&nbsp;
                <span>${escapeHtml(sp.organization || '—')}</span>
            `;

    // Rating circle
    const circle = document.getElementById('modalRatingCircle');
    circle.className = `big-rating-circle ${rc}`;
    const ratingClass = rc === 'no-data' ? 'color:#9ca3af;' : '';
    document.getElementById('modalRatingNum').style.cssText = ratingClass;
    document.getElementById('modalRatingNum').textContent = sp.rating > 0 ? sp.rating.toFixed(2) : '—';

    // Criteria
    const criteriaEl = document.getElementById('modalCriteria');
    if (sp.criteria && sp.criteria.length > 0) {
        criteriaEl.innerHTML = sp.criteria.map(c => {
            const val = c.score > 0 ? c.score : null;
            const pct = criteriaPercent(val);
            const fillCls = getFillClass(val);
            return `
                    <div class="breakdown-item">
                        <div class="breakdown-label">${escapeHtml(cleanCriterionLabel(c.label))}</div>
                        <div class="breakdown-bar">
                            <div class="breakdown-fill ${fillCls}" style="width:${pct}%;"></div>
                        </div>
                        <div class="breakdown-val">${val != null ? val.toFixed(2) : '—'}</div>
                    </div>`;
        }).join('');
    } else {
        criteriaEl.innerHTML = `
                    <div style="font-size:13px;color:#9ca3af;padding:8px 0;">
                        <i class="fa-solid fa-circle-info" style="margin-right:6px;"></i>
                        No detailed criteria data available yet.
                    </div>`;
    }

    document.getElementById('modalOrg').textContent = sp.organization || '—';
    document.getElementById('modalContact').textContent = sp.contact || '—';
    document.getElementById('modalTopic').textContent = sp.topic || '—';

    // Appearances — grouped by program
    const appEl = document.getElementById('modalAppearances');
    if (sp.appearances && sp.appearances.length) {
        // Group appearances by workshop/program title
        const groups = {};
        sp.appearances.forEach(a => {
            const gKey = a.workshop_title || 'Workshop';
            if (!groups[gKey]) groups[gKey] = { title: gKey, days: [], feedback: null };
            groups[gKey].days.push(a);
            if (a.feedback && !groups[gKey].feedback) groups[gKey].feedback = a.feedback;
        });

        const FEEDBACK_LABELS = {
            expectations_met: { label: 'Expectations Met', icon: 'fa-circle-check', color: '#16a34a' },
            improvement_suggestions: { label: 'Improvement Suggestions', icon: 'fa-lightbulb', color: '#f59e0b' },
            significant_insights: { label: 'Significant Insights', icon: 'fa-star', color: '#6366f1' },
            further_training_interest: { label: 'Further Training Interest', icon: 'fa-graduation-cap', color: '#0891b2' }
        };

        appEl.innerHTML = Object.values(groups).map((g, gIdx) => {
            const hasFeedback = g.feedback && Object.values(g.feedback).some(arr => arr && arr.length > 0);
            const daysHtml = g.days.map(d => `
                <div class="appearance-day-row">
                    <span>Day ${d.day_number}${d.day_title && d.day_title !== String(d.day_number) ? ' — ' + escapeHtml(d.day_title) : ''}</span>
                    ${d.topic ? `<span class="appearance-topic"><i class="fa-solid fa-book-open" style="color:#1e3a8a;margin-right:4px;font-size:11px;"></i>${escapeHtml(d.topic)}</span>` : ''}
                </div>
            `).join('');

            const feedbackHtml = hasFeedback ? Object.entries(FEEDBACK_LABELS).map(([key, meta]) => {
                const items = (g.feedback[key] || []);
                if (!items.length) return '';
                return `
                    <div class="feedback-category">
                        <div class="feedback-category-header">
                            <i class="fa-solid ${meta.icon}" style="color:${meta.color};margin-right:6px;"></i>
                            ${meta.label}
                            <span class="feedback-count">${items.length}</span>
                        </div>
                        <div class="feedback-list">
                            ${items.map(txt => `
                                <div class="feedback-item">
                                    <i class="fa-solid fa-quote-left feedback-quote-icon"></i>
                                    <span>${escapeHtml(txt)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>`;
            }).join('') : '';

            return `
                <div class="appearance-group">
                    <div class="appearance-group-header">
                        <div>
                            <div class="appearance-workshop">${escapeHtml(g.title)}</div>
                            <div class="appearance-days-summary">${daysHtml}</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            ${hasFeedback ? `<button class="btn-view-feedback" onclick="toggleAppearanceFeedback(${gIdx})">
                                <i class="fa-solid fa-comments"></i> Feedback
                            </button>` : ''}
                            <span style="font-size:20px;">📅</span>
                        </div>
                    </div>
                    ${hasFeedback ? `
                    <div class="appearance-feedback-panel" id="appearanceFeedback_${gIdx}" style="display:none;">
                        <div class="appearance-feedback-inner">
                            ${feedbackHtml}
                        </div>
                    </div>` : ''}
                </div>`;
        }).join('');
    } else {
        appEl.innerHTML = '<p style="color:#9ca3af;font-size:13px;">No appearance history found.</p>';
    }

    document.getElementById('speakerModal').classList.add('active');
}

function closeModal() {
    document.getElementById('speakerModal').classList.remove('active');
}

function toggleAppearanceFeedback(gIdx) {
    const panel = document.getElementById('appearanceFeedback_' + gIdx);
    if (!panel) return;
    const btn = panel.closest('.appearance-group').querySelector('.btn-view-feedback');
    if (panel.style.display === 'none') {
        panel.style.display = '';
        if (btn) btn.classList.add('active');
    } else {
        panel.style.display = 'none';
        if (btn) btn.classList.remove('active');
    }
}

document.getElementById('speakerModal').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
});

// =========== FILTERS & SORT ===========
function filterSpeakers() {
    const search = document.getElementById('searchInput').value.toLowerCase();
    const ratingF = document.getElementById('ratingFilter').value;

    filteredSpeakers = allSpeakers.filter(sp => {
        const matchSearch = !search ||
            sp.name.toLowerCase().includes(search) ||
            (sp.designation || '').toLowerCase().includes(search) ||
            (sp.organization || '').toLowerCase().includes(search) ||
            (sp.topic || '').toLowerCase().includes(search);

        const rc = getRatingClass(sp.rating);
        const matchRating = ratingF === 'all' || rc === ratingF;

        return matchSearch && matchRating;
    });

    sortSpeakers();
    spCurrentPage = 1; // new result set — back to page 1
    render();
}

function sortSpeakers() {
    filteredSpeakers.sort((a, b) => {
        return sortDescending
            ? b.rating - a.rating
            : a.rating - b.rating;
    });
}

function toggleSort() {
    sortDescending = !sortDescending;
    const btn = document.getElementById('sortBtn');
    if (sortDescending) {
        btn.innerHTML = '<i class="fa-solid fa-arrow-down-wide-short"></i> Highest Rated';
        btn.classList.add('active');
    } else {
        btn.innerHTML = '<i class="fa-solid fa-arrow-up-wide-short"></i> Lowest Rated';
        btn.classList.remove('active');
    }
    sortSpeakers();
    spCurrentPage = 1;
    render();
}

// =========== VIEW TOGGLE ===========
function setView(view) {
    currentView = view;
    document.getElementById('cardView').classList.toggle('hidden', view !== 'card');
    document.getElementById('tableView').classList.toggle('hidden', view !== 'table');
    document.getElementById('cardViewBtn').classList.toggle('active', view === 'card');
    document.getElementById('tableViewBtn').classList.toggle('active', view === 'table');
    spCurrentPage = 1; // page sizes differ between views
    render();
}

// =========== NAV ===========
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

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

async function logout() {
    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (e) { }
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

// ─── Back-button / bfcache guard ─────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

// =========== SPEAKER EDIT ===========

let _editingSpeakerId = null;

/**
 * Open the edit panel and pre-fill form fields with the currently-open speaker's data.
 */
function toggleEditMode() {
    const panel = document.getElementById('editSpeakerPanel');
    const btn = document.getElementById('editSpeakerBtn');

    if (panel.style.display !== 'none') {
        cancelEditMode();
        return;
    }

    // Find the speaker that is currently open
    const nameEl = document.getElementById('modalName');
    const sp = allSpeakers.find(s => s.name === nameEl.textContent);
    if (!sp) return;

    _editingSpeakerId = sp.id;

    document.getElementById('editName').value         = sp.name || '';
    document.getElementById('editDesignation').value  = sp.designation || '';
    document.getElementById('editOrganization').value = sp.organization || '';
    document.getElementById('editContact').value      = sp.contact || '';
    document.getElementById('editTopic').value        = sp.topic || '';

    document.getElementById('editSaveStatus').textContent = '';
    panel.style.display = '';
    btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel';
}

function cancelEditMode() {
    document.getElementById('editSpeakerPanel').style.display = 'none';
    document.getElementById('editSpeakerBtn').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit';
    document.getElementById('editSaveStatus').textContent = '';
    _editingSpeakerId = null;
}

/**
 * Determine which API to call based on the speaker id pattern:
 *   - "rec_<N>_<slot>"           → PATCH records_api.php (updates speaker_averages.speaker_name only)
 *   - "slot_N" / container keys  → PATCH records_api.php via the container's program
 *
 * (The old "numeric speaker_id → resource_speakers.php" case was removed —
 * that table isn't used on this install, so sp.speaker_id is always null.)
 */
/**
 * Update the in-memory speaker object with freshly-saved field values.
 * Shared by all three save paths (record-based, live speaker, container)
 * so the "optimistic update" logic only lives in one place.
 */
function applyEditToLocalSpeaker(sp, { name, designation, organization, contact, topic }) {
    sp.name         = name;
    sp.designation  = designation;
    sp.organization = organization;
    sp.contact      = contact;
    sp.topic        = topic;
}

async function saveSpeakerEdit() {
    const sp = allSpeakers.find(s => String(s.id) === String(_editingSpeakerId));
    if (!sp) return;

    const newName         = document.getElementById('editName').value.trim();
    const newDesignation  = document.getElementById('editDesignation').value.trim();
    const newOrganization = document.getElementById('editOrganization').value.trim();
    const newContact      = document.getElementById('editContact').value.trim();
    const newTopic        = document.getElementById('editTopic').value.trim();

    if (!newName) {
        setEditStatus('error', 'Name cannot be empty.');
        return;
    }

    const saveBtn = document.getElementById('saveEditBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    setEditStatus('', '');

    try {
        const idStr = String(sp.id);

        // ── Case 1: Record-based speaker (rec_<recordId>_<slot>) ──────────────
        if (idStr.startsWith('rec_')) {
            const parts  = idStr.split('_');          // ['rec', '<recId>', '<slot...>']
            const recId  = parseInt(parts[1]);
            const slotNo = sp.number;

            // We need the speaker_averages.id for this slot.
            // records_api PATCH accepts { id: <program_id>, speakers: [{ id: <sa_id>, name }] }
            // We fetch the full record to get the speaker_averages id.
            const detailRes = await fetch(`${API_URL}/records_api.php?id=${recId}`, { credentials: 'include' });
            const detailJson = await detailRes.json();
            if (!detailJson.success) throw new Error(detailJson.message || 'Could not load record details.');

            // Find speaker_averages rows matching this slot across all days
            const saRows = [];
            (detailJson.program?.days || []).forEach(day => {
                (day.speakers || []).forEach(s => {
                    if ((s.slot_number || 0) === slotNo && s.id) {
                        saRows.push({ id: s.id, name: newName });
                    }
                });
            });

            if (!saRows.length) {
                // Fallback: patch by slot as best effort (server ignores missing ids)
                saRows.push({ id: 0, name: newName });
            }

            const patchRes = await fetch(`${API_URL}/records_api.php`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: recId, speakers: saRows })
            });
            const patchJson = await patchRes.json();
            if (!patchJson.success) throw new Error(patchJson.message || 'Save failed.');

            // Update in-memory speaker object
            applyEditToLocalSpeaker(sp, { name: newName, designation: newDesignation, organization: newOrganization, contact: newContact, topic: newTopic });

        // ── Case 2: Container speaker — use sa_entries to patch each backing program ─
        } else if (sp.sa_entries && sp.sa_entries.length > 0) {
            // Group sa_entries by program_id so we make one PATCH per program
            const byProgram = {};
            for (const entry of sp.sa_entries) {
                const pid = entry.program_id;
                if (!byProgram[pid]) byProgram[pid] = [];
                byProgram[pid].push({ id: entry.sa_id, name: newName });
            }

            for (const [progId, speakers] of Object.entries(byProgram)) {
                const patchRes = await fetch(`${API_URL}/records_api.php`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ id: parseInt(progId), speakers })
                });
                const patchJson = await patchRes.json();
                if (!patchJson.success) throw new Error(patchJson.message || 'Save failed.');
            }

            applyEditToLocalSpeaker(sp, { name: newName, designation: newDesignation, organization: newOrganization, contact: newContact, topic: newTopic });
        }

        // Refresh the modal display with updated data
        refreshModalDisplay(sp);
        render();
        setEditStatus('success', 'Saved successfully!');
        setTimeout(cancelEditMode, 1200);

    } catch (err) {
        setEditStatus('error', err.message || 'An error occurred.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
}

/**
 * Update the visible (read-only) parts of the modal header and detail fields
 * after a successful save so the user sees the new values immediately.
 */
function refreshModalDisplay(sp) {
    document.getElementById('modalName').textContent  = sp.name;
    document.getElementById('modalMeta').innerHTML    = `
        ${escapeHtml(sp.designation || DEFAULT_DESIGNATION)} &nbsp;·&nbsp;
        <span>${escapeHtml(sp.organization || '—')}</span>
    `;
    document.getElementById('modalOrg').textContent     = sp.organization || '—';
    document.getElementById('modalContact').textContent = sp.contact || '—';
    document.getElementById('modalTopic').textContent   = sp.topic || '—';

    // Also update the avatar initials
    const avatar = document.getElementById('modalAvatar');
    avatar.textContent = getInitials(sp.name);
}

function setEditStatus(type, msg) {
    const el = document.getElementById('editSaveStatus');
    if (!msg) { el.textContent = ''; el.style.color = ''; return; }
    const colors = { success: '#16a34a', error: '#dc2626', warn: '#d97706', '': '#6b7280' };
    el.style.color = colors[type] || '#6b7280';
    const icons = { success: '✓', error: '✗', warn: '⚠' };
    el.textContent = (icons[type] ? icons[type] + ' ' : '') + msg;
}