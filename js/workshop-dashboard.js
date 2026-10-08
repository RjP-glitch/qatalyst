const API_URL = CONFIG.API_URL;

const PAGE_KEY = window.PAGE_KEY || 'qatame';

let workshopDays = [];
let currentDayIndex = 0;
let expandedMenus = {};
let isAllDaysView = false;
let currentWorkshopId = null;
let _lastSuperCategories = [];
let _lastDashboardData = {};

// ─── Speaker display settings (declared here so all functions can access it) ─
let _speakerDisplaySettings = {
    show_name: true,
    show_rating: true,
    show_rank: true,
    show_badge_label: true,
    highlight_top: true,
    show_response_count: true
};

// _programRecordId: set to the evaluation_programs.id for standalone imports,
// or to the workshops.id for container programs (used as record-mode marker).
let _programRecordId = null;
// _containerWorkshopId: set only when loaded via ?workshop_id=X&container=1
let _containerWorkshopId = null;

// ─── Rating scales cache (loaded from DB via rating_scales.php) ───────
let _ratingScales = {
    category: [],
    speaker: [],
    overall: []
};

async function loadRatingScales() {
    try {
        const res = await apiFetch(`${API_URL}/rating_scales.php`);
        const json = await res.json();
        if (json.success && json.scales) {
            // API returns a flat array; group by scale_type for internal use
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
        console.warn('Could not load rating scales:', e);
    }
}

function _getLabel(score, type) {
    if (!score || score === 0) return 'N/A';
    const scales = _ratingScales[type] || [];
    for (const s of scales) {
        if (score >= parseFloat(s.min_score) && score <= parseFloat(s.max_score)) {
            return s.descriptive_equivalent;
        }
    }
    return 'N/A';
}

// ─── Bootstrap ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function () {
    loadRatingScales();
    checkAuthentication();
    injectModalStyles();
});

// No live real-time polling — system only uses imported records.

// ─── Auth helpers ─────────────────────────────────────────────────────
// Note: Authentication is now via HttpOnly cookie (credentials: 'include')
// No Authorization header needed

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions']
        .forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

// ─── Centralized fetch wrapper: redirects on 401/403 (expired session) ─
async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401 || res.status === 403) {
        clearSessionAndRedirect();
        throw new Error('Session expired');
    }
    return res;
}

// ─── Authentication (validates token server-side) ─────────────────────
async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res = await apiFetch(`${API_URL}/main-settings.php`);
        if (!res.ok) {
            clearSessionAndRedirect();
            return;
        }
        const json = await res.json();

        if (!json.success || !json.data?.id) {
            clearSessionAndRedirect();
            return;
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

        // Block school portal users from accessing SDO dashboard
        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }

        if (json.data && json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    alt="Profile">`;
            }
        }

        if (typeof Permissions !== 'undefined') {
            // Wait for dynamic role presets to load from DB before checking
            await Permissions.loadRolePermissions();

            if (!Permissions.check('programs')) return;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadWorkshopsAndDashboard();
    } catch (e) {
        console.warn('Session validation error:', e);
        clearSessionAndRedirect();
    }
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    const avatar = document.getElementById('sidebarAvatar');
    if (avatar && !avatar.querySelector('img')) avatar.textContent = initial;
    const nameEl = document.getElementById('sidebarUserName');
    const emailEl = document.getElementById('sidebarUserEmail');
    if (nameEl) nameEl.textContent = fullName || 'User';
    if (emailEl) emailEl.textContent = email || '';
}

// ─── Format workshop occurrence date ─────────────────────────────────
/**
 * Extracts and formats the workshop occurrence date(s) from a workshop
 * object. Checks multiple common field names to be resilient across
 * DB schema variations. Returns a formatted string or null.
 *
 * Priority:
 *   1. date_from / date_to  → "June 10–14, 2025"  or  "June 10, 2025"
 *   2. start_date / end_date
 *   3. inclusive_dates      → used as-is (already a formatted string)
 *   4. event_date / schedule
 */
function formatWorkshopDate(workshop) {
    if (!workshop) return null;

    // ── Try structured date fields first ──────────────────────────
    const fromCandidates = ['date_from', 'start_date'];
    const toCandidates = ['date_to', 'end_date'];

    let rawFrom = null;
    let rawTo = null;

    for (const k of fromCandidates) {
        if (workshop[k]) { rawFrom = workshop[k]; break; }
    }
    for (const k of toCandidates) {
        if (workshop[k]) { rawTo = workshop[k]; break; }
    }

    const parseDate = (raw) => {
        if (!raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    };

    const fmtLong = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const fmtMonth = (d) => d.toLocaleDateString('en-US', { month: 'long' });

    const dFrom = parseDate(rawFrom);
    const dTo = parseDate(rawTo);

    if (dFrom && dTo && rawFrom !== rawTo) {
        // Same month & year → "June 10–14, 2025"
        if (dFrom.getFullYear() === dTo.getFullYear() && dFrom.getMonth() === dTo.getMonth()) {
            return `${fmtMonth(dFrom)} ${dFrom.getDate()}–${dTo.getDate()}, ${dFrom.getFullYear()}`;
        }
        // Different months → "May 30 – June 3, 2025"
        return `${fmtLong(dFrom)} – ${fmtLong(dTo)}`;
    }
    if (dFrom) return fmtLong(dFrom);

    // ── Fall back to inclusive_dates string (already human-readable) ─
    if (workshop.inclusive_dates) return workshop.inclusive_dates;

    // ── Last resort: other date fields ───────────────────────────
    for (const k of ['event_date', 'schedule']) {
        if (workshop[k]) {
            const d = parseDate(workshop[k]);
            return d ? fmtLong(d) : workshop[k];
        }
    }

    return null;
}

// ─── Bootstrap dashboard from URL params ─────────────────────────────
// Supports two modes:
//   ?program_id=X          → standalone excel import (evaluation_programs.id)
//   ?workshop_id=X&container=1 → container program aggregating all linked imports
async function loadWorkshopsAndDashboard() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    const titleDisplay = document.getElementById('workshopTitleText');

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const programId  = urlParams.get('program_id');
        const workshopId = urlParams.get('workshop_id');
        const isContainer = urlParams.get('container') === '1';
        const dayLabelParam = decodeURIComponent(urlParams.get('day_label') || '');

        // ── Standalone or container import: ?program_id=X ─────────────────────
        if (programId) {
            _programRecordId = parseInt(programId);
            try {
                await loadProgramRecord(_programRecordId, dayLabelParam || 'all');
            } catch (e) {
                console.error('Program record load failed:', e.message);
                if (titleDisplay) titleDisplay.textContent = 'Error loading record';
                showNoDashboardData();
            }
            return;
        }

        // ── BUG 1 FIX: Container program: ?workshop_id=X ──────────────────────
        if (workshopId) {
            _containerWorkshopId = parseInt(workshopId);
            try {
                await loadContainerDashboard(parseInt(workshopId), 'all');
            } catch (e) {
                console.error('Container dashboard load failed:', e.message);
                if (titleDisplay) titleDisplay.textContent = 'Error loading program';
                showNoDashboardData();
            }
            return;
        }

        // ── No recognised params ─────────────────────────────────────────────
        if (titleDisplay) titleDisplay.textContent = 'No program selected';
        showNoDashboardData();

    } catch (error) {
        console.error('loadWorkshopsAndDashboard error:', error);
        if (titleDisplay) titleDisplay.textContent = 'Error loading program';
        showNoDashboardData();
    } finally {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

// ─── Load a saved program record ──────────────────────────────────────
async function loadProgramRecord(programId, dayFilter = 'all') {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    // Load speaker display settings first
    await loadSpeakerDisplaySettings();

    try {
        let superCategories = [];
        try {
            const qameRes = await apiFetch(`${API_URL}/qame_categories.php`);
            const qameResult = await qameRes.json();
            if (qameResult.success) superCategories = qameResult.data || [];
        } catch (e) { /* ignore */ }
        _lastSuperCategories = superCategories;

        const res = await apiFetch(`${API_URL}/program_dashboard.php?program_id=${programId}&day=${encodeURIComponent(dayFilter)}`);
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Record not found');

        const data = result.data;
        _lastDashboardData = data;

        // Update the workshop title display
        const titleDisplay = document.getElementById('workshopTitleText');
        if (titleDisplay) titleDisplay.textContent = data.workshop.title;

        // Capture first-load flag BEFORE overwriting currentWorkshopId.
        // On first load the API controls isAllDaysView; after that changeDay() owns it.
        const _isFirstLoad = (currentWorkshopId !== 'record_' + programId);
        currentWorkshopId = 'record_' + programId;

        showRecordBanner(data);

        workshopDays = data.workshop_days || [];
        if (_isFirstLoad) {
            // First page load: let the API decide the view mode
            isAllDaysView = data.is_all_days;
        }
        // Subsequent loads (day navigation): keep isAllDaysView as set by changeDay()

        // API returns linked_workshop_id when this import belongs to a container.
        // Use it to fetch all sibling imports for complete day navigation.
        if (data.linked_workshop_id) {
            _containerWorkshopId = data.linked_workshop_id;
            try {
                const importsRes = await apiFetch(`${API_URL}/programs.php?program_imports=1&workshop_id=${data.linked_workshop_id}`);
                const importsJson = await importsRes.json();
                if (importsJson.success && Array.isArray(importsJson.data) && importsJson.data.length > 0) {
                    workshopDays = importsJson.data
                        .slice()
                        .sort((a, b) => {
                            const an = parseInt(String(a.day_label || '').match(/\d+/)?.[0] || 999);
                            const bn = parseInt(String(b.day_label || '').match(/\d+/)?.[0] || 999);
                            return an - bn;
                        })
                        .map(imp => ({ id: imp.program_id, title: imp.day_label, day_number: imp.day_number }));
                }
            } catch (_) { /* keep API-returned workshopDays as fallback */ }
        }

        if (!isAllDaysView) {
            // Match by program_id first (compare as numbers — URL param is a string), then fall back to title
            const programIdNum = parseInt(programId);
            currentDayIndex = workshopDays.findIndex(d => parseInt(d.id) === programIdNum);
            if (currentDayIndex === -1) {
                const curDay = data.current_day;
                currentDayIndex = workshopDays.findIndex(d => d.title === curDay?.title);
            }
            if (currentDayIndex === -1) currentDayIndex = 0;
        } else {
            currentDayIndex = 0;
        }

        const dayDisplay = document.getElementById('dayDisplay');
        if (dayDisplay) dayDisplay.textContent =
            isAllDaysView ? 'All Days' : (data.current_day?.title || workshopDays[currentDayIndex]?.title || 'Day 1');

        updateWorkshopInfoFromRecord(data);
        updateParticipantsChart(data.participants, data.workshop.expected_participants);
        updateSuperCategoriesFromRecord(data, superCategories);

        // Use the client-side isAllDaysView (not data.is_all_days) so that
        // speaker rendering matches the current navigation state.
        if (isAllDaysView && data.speakers_by_day && Object.keys(data.speakers_by_day).length > 0) {
            updateResourceSpeakersByDay(data.speakers_by_day, data.resource_speakers);
        } else {
            updateResourceSpeakers(data.resource_speakers);
        }

        const rcEl = document.getElementById('responseCount');
        if (rcEl) rcEl.textContent = data.response_count || 0;
        const resBadge = document.getElementById('responsesBadgeCount');
        if (resBadge) resBadge.textContent = data.response_count || 0;

        updateDayNavigation();

    } catch (e) {
        throw e;
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

// ─── Load a container program (aggregates all linked day imports) ─────
async function loadContainerDashboard(workshopId, dayFilter = 'all') {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    await loadSpeakerDisplaySettings();

    try {
        let superCategories = [];
        try {
            const qameRes = await apiFetch(`${API_URL}/qame_categories.php`);
            const qameResult = await qameRes.json();
            if (qameResult.success) superCategories = qameResult.data || [];
        } catch (e) { /* ignore */ }
        _lastSuperCategories = superCategories;

        const res = await apiFetch(
            `${API_URL}/program_dashboard.php?workshop_id=${workshopId}&day=${encodeURIComponent(dayFilter)}`
        );
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Container not found');

        const data = result.data;
        _lastDashboardData = data;

        const titleDisplay = document.getElementById('workshopTitleText');
        if (titleDisplay) titleDisplay.textContent = data.workshop.title;
        currentWorkshopId = 'record_' + workshopId;

        showRecordBanner(data);

        workshopDays = data.workshop_days || [];
        isAllDaysView = data.is_all_days;

        // Fetch all linked imports so navigation covers every day.
        // Always use program_id (not imp.id) as the navigation key.
        try {
            const importsRes = await apiFetch(`${API_URL}/programs.php?program_imports=1&workshop_id=${workshopId}`);
            const importsJson = await importsRes.json();
            if (importsJson.success && Array.isArray(importsJson.data) && importsJson.data.length > 0) {
                workshopDays = importsJson.data
                    .slice()
                    .sort((a, b) => {
                        const an = parseInt(String(a.day_label || '').match(/\d+/)?.[0] || 999);
                        const bn = parseInt(String(b.day_label || '').match(/\d+/)?.[0] || 999);
                        return an - bn;
                    })
                    .map(imp => ({ id: imp.program_id, title: imp.day_label, day_number: imp.day_number }));
            }
        } catch (_) { /* keep API-returned workshopDays as fallback */ }

        if (!isAllDaysView) {
            const curDay = data.current_day;
            currentDayIndex = workshopDays.findIndex(d => d.title === curDay?.title);
            if (currentDayIndex === -1) currentDayIndex = 0;
        } else {
            currentDayIndex = 0;
        }

        const dayDisplay = document.getElementById('dayDisplay');
        if (dayDisplay) dayDisplay.textContent =
            isAllDaysView ? 'All Days' : (data.current_day?.title || workshopDays[currentDayIndex]?.title || 'Day 1');

        updateWorkshopInfoFromRecord(data);
        updateParticipantsChart(data.participants, data.workshop.expected_participants);
        updateSuperCategoriesFromRecord(data, superCategories);

        if (data.is_all_days && data.speakers_by_day && Object.keys(data.speakers_by_day).length > 0) {
            updateResourceSpeakersByDay(data.speakers_by_day, data.resource_speakers);
        } else {
            updateResourceSpeakers(data.resource_speakers);
        }

        const rcEl = document.getElementById('responseCount');
        if (rcEl) rcEl.textContent = data.response_count || 0;
        const resBadge = document.getElementById('responsesBadgeCount');
        if (resBadge) resBadge.textContent = data.response_count || 0;

        updateDayNavigation();

    } catch (e) {
        throw e;
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

function showRecordBanner(data) {
    const existing = document.getElementById('recordSourceBanner');
    if (existing) existing.remove();

    const w = data.workshop;
    const avg = parseFloat(data.overall_average || 0).toFixed(2);
    const result = data.overall_result || '';
    const resp = data.response_count || 0;
    const venue = w.venue ? ` · ${w.venue}` : '';
    const dayTag = isAllDaysView ? 'All Days' : (data.current_day?.title || '');

    // ── Show the actual workshop occurrence date ───────────────────
    const workshopDate = formatWorkshopDate(w);
    const dateTag = workshopDate ? ` · 📅 <strong>${escapeHtml(workshopDate)}</strong>` : '';

    const banner = document.createElement('div');
    banner.id = 'recordSourceBanner';
    banner.style.cssText = `
        background:linear-gradient(135deg,#1e40af,#3b82f6);
        color:#fff;padding:10px 20px;font-size:13px;
        display:flex;align-items:center;justify-content:space-between;
        gap:12px;border-radius:8px;margin:0 0 12px;flex-wrap:wrap;
    `;
    const responsesHtml = _speakerDisplaySettings.show_response_count
        ? `&nbsp;|&nbsp; Responses: <strong>${resp}</strong>`
        : '';
    banner.innerHTML = `
        <span>
            📋 <strong>Saved Record</strong>${dayTag ? ` · <strong>${escapeHtml(dayTag)}</strong>` : ''}${dateTag}&nbsp;·&nbsp;
            ${escapeHtml(w.division_memo || '')}${escapeHtml(venue)}
            &nbsp;|&nbsp; Avg: <strong>${avg}</strong>
            &nbsp;·&nbsp; <em>${escapeHtml(result)}</em>
            ${responsesHtml}
        </span>
        <button onclick="this.parentElement.remove()"
            style="background:rgba(255,255,255,0.2);border:none;color:#fff;
                   border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;">
            ✕ Dismiss
        </button>`;
    // BUG 11 FIX: .top-bar doesn't exist in the HTML; use .page-header or top of .main-content
    const pageHeader = document.querySelector('.page-header');
    const mainContent = document.querySelector('.main-content');
    if (pageHeader) {
        pageHeader.after(banner);
    } else if (mainContent) {
        mainContent.prepend(banner);
    }
}

function showToast(message, type = 'info') {
    let toast = document.getElementById('dashboardToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'dashboardToast';
        toast.className = 'dashboard-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `dashboard-toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── Update helpers ───────────────────────────────────────────────────
function updateWorkshopInfoFromRecord(data) {
    const w = data.workshop;
    const curDay = data.current_day || {};
    // Use client-side isAllDaysView + global workshopDays (populated by sibling
    // imports fetch) — data.workshop_days only contains days for this one program_id
    // (often just 'Day 1'), so it must not be used for the label in all-days mode.
    const dayLabel = isAllDaysView
        ? (workshopDays.length > 1 ? `All ${workshopDays.length} Days` : 'All Days')
        : (curDay.title || workshopDays[currentDayIndex]?.title || 'Day 1');

    // Format the actual workshop occurrence date from saved data
    const workshopDate = formatWorkshopDate(w);
    const dateLine = workshopDate
        ? `<p class="workshop-date-line"><i class="fa-regular fa-calendar"></i> ${escapeHtml(workshopDate)}</p>`
        : '';

    const venueLine = w.venue
        ? `<p class="workshop-venue-line"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(w.venue)}</p>`
        : '';

    const natureLine = w.nature_of_event
        ? `<p class="workshop-nature-line"><i class="fa-solid fa-tag"></i> ${escapeHtml(w.nature_of_event)}</p>`
        : '';

    const header = document.getElementById('workshopHeader');
    if (header) {
        header.innerHTML = `
            <h2>(${escapeHtml(dayLabel)}) ${escapeHtml(w.title.toUpperCase())}</h2>
            <h3>${escapeHtml(w.proponents || '')}</h3>
            <p>${escapeHtml(w.division_memo || '')}</p>
            ${dateLine}
            ${natureLine}
            ${venueLine}`;
        fitWorkshopTitleSize(header.querySelector('h2'));
    }
    const dd = document.getElementById('dayDisplay');
    if (dd) dd.textContent = dayLabel;

    updateHeaderOverallScoreFromRecord(data);
}

// ─── Long-title guard ──────────────────────────────────────────────────
// A very long workshop title (e.g. a full DM title) would otherwise wrap
// to 4-5 lines at the default 20px size, stretching the header card taller
// than the rest of the board — which then gets clipped by the fixed 4:3
// "cover" fit used by the projector/PNG/JPEG exporters. Scaling the font
// down as the character count grows keeps the header height compact and
// consistent whether the title is short or long, without touching layout.
function fitWorkshopTitleSize(h2El) {
    if (!h2El) return;
    const len = (h2El.textContent || '').length;
    let size = '';               // '' = fall back to the CSS default (20px)
    if (len > 220) size = '14px';
    else if (len > 180) size = '15px';
    else if (len > 140) size = '16px';
    else if (len > 100) size = '18px';
    h2El.style.fontSize = size;
}

function updateHeaderOverallScoreFromRecord(data) {
    const osbNumber = document.getElementById('osb-number');
    const osbText = document.getElementById('osb-text');
    if (!osbNumber || !osbText) return;
    const avg = parseFloat(data.overall_average) || 0;
    if (!avg) { osbNumber.textContent = '—'; osbText.textContent = 'N/A'; return; }
    osbNumber.textContent = avg.toFixed(2);
    osbText.textContent = getOverallLabel(avg);
}

function updateSuperCategoriesFromRecord(data, superCategories) {
    updateSuperCategories(data, superCategories);
}

// ─── Participants ─────────────────────────────────────────────────────
function updateParticipantsChart(participants, expectedParticipants = null) {
    participants = participants || {};
    const total = participants.total || 0;

    // Expected participants (may be null/0 when not configured)
    const expectedEl = document.getElementById('expectedParticipantsLabel');
    const expectedNum = expectedParticipants === null || expectedParticipants === undefined
        ? null
        : Number(expectedParticipants);
    const hasExpected = Number.isFinite(expectedNum) && expectedNum > 0;
    if (expectedEl) {
        expectedEl.style.display = hasExpected ? '' : 'none';
        if (hasExpected) expectedEl.textContent = `EXPECTED PARTICIPANTS-${expectedNum}`;
    }

    // If sex counts are missing (often coerced to 0 by the API when sex is NULL),
    // hide the pie chart UI to avoid showing a misleading 0/0/0 split.
    // Keep the placeholder chart when there are zero respondents.
    // If backend indicates sex was entirely NULL/uncollected, hide the chart.
    if (participants.sex_all_null === 1 || participants.sex_all_null === true) {
        const pieWrap = document.querySelector('.pie-chart-wrapper');
        const pieLabelsWrap = document.getElementById('pieLabels');
        const legendWrap = document.querySelector('.participants-card .chart-legend');
        if (pieWrap) pieWrap.style.display = 'none';
        if (pieLabelsWrap) pieLabelsWrap.style.display = 'none';
        if (legendWrap) legendWrap.style.display = 'none';

        const tl = document.getElementById('totalParticipantsLabel');
        if (tl) tl.textContent = `TOTAL PARTICIPANTS-${total}`;
        applyResponseCountVisibility();
        return;
    }

    const maleRaw = participants.male_count;
    const femaleRaw = participants.female_count;
    const otherRaw = participants.lgbtq_count;
    const hasProvidedCounts = [maleRaw, femaleRaw, otherRaw].some(v => v !== null && v !== undefined);
    const sexSum = (Number(maleRaw) || 0) + (Number(femaleRaw) || 0) + (Number(otherRaw) || 0);
    const hasSexData = (total === 0) || (hasProvidedCounts && sexSum > 0);

    const pieWrap = document.querySelector('.pie-chart-wrapper');
    const pieLabelsWrap = document.getElementById('pieLabels');
    const legendWrap = document.querySelector('.participants-card .chart-legend');

    if (pieWrap) pieWrap.style.display = hasSexData ? '' : 'none';
    if (pieLabelsWrap) pieLabelsWrap.style.display = hasSexData ? '' : 'none';
    if (legendWrap) legendWrap.style.display = hasSexData ? '' : 'none';

    const maleCount = maleRaw ?? 0;
    const femaleCount = femaleRaw ?? 0;
    const lgbtqCount = otherRaw ?? 0;

    const malePct = total > 0 ? Math.round((maleCount / total) * 100) : 0;
    const lgbtqPct = total > 0 ? Math.round((lgbtqCount / total) * 100) : 0;
    // ✅ Female gets whatever is left so percentages always sum to 100%
    const femalePct = Math.max(0, 100 - malePct - lgbtqPct);

    // Legend counts
    const mc = document.getElementById('maleCount');
    const fc = document.getElementById('femaleCount');
    const lc = document.getElementById('lgbtqCount');
    if (mc) mc.textContent = `MALE`;
    if (fc) fc.textContent = `Prefer not to say`;
    if (lc) lc.textContent = `FEMALE`;

    // Pie labels
    const mpl = document.getElementById('malePieLabel');
    const fpl = document.getElementById('femalePieLabel');
    const lpl = document.getElementById('lgbtqPieLabel');
    if (mpl) mpl.innerHTML = `MALE<br>${malePct}%`;
    if (fpl) fpl.innerHTML = `FEMALE<br>${femalePct}%`;
    if (lpl) lpl.innerHTML = `Prefer not to say<br>${lgbtqPct}%`;

    const pct = document.getElementById('pieChartText');
    if (pct) pct.innerHTML = `<p class="male-text">${malePct}%</p><p class="female-text">${femalePct}%</p>`;

    const tl = document.getElementById('totalParticipantsLabel');
    if (tl) tl.textContent = `TOTAL PARTICIPANTS-${total}`;
    applyResponseCountVisibility();

    const circumference = 2 * Math.PI * 40;
    const maleArc = (malePct / 100) * circumference;
    const femaleArc = (femalePct / 100) * circumference;
    const lgbtqArc = (lgbtqPct / 100) * circumference;

    const pie = document.getElementById('pieChart');
    if (!pie || !hasSexData) return;

    pie.innerHTML = total === 0
        ? `<circle cx="50" cy="50" r="40" fill="none" stroke="#c8d8e8" stroke-width="20"></circle>`
        : `<circle cx="50" cy="50" r="40" fill="none" stroke="#4caf50" stroke-width="20"
                stroke-dasharray="${maleArc} ${circumference}" stroke-dashoffset="0"></circle>
           <circle cx="50" cy="50" r="40" fill="none" stroke="#64b5f6" stroke-width="20"
                stroke-dasharray="${femaleArc} ${circumference}" stroke-dashoffset="-${maleArc}"></circle>
           ${lgbtqCount > 0 ? `<circle cx="50" cy="50" r="40" fill="none" stroke="#9ca3af" stroke-width="20"
                stroke-dasharray="${lgbtqArc} ${circumference}" stroke-dashoffset="-${maleArc + femaleArc}"></circle>` : ''}`;
}

// ─── Super Category click registry ───────────────────────────────────
const _indicatorRegistry = [];

function isSuppressedCategoryName(name) {
    const raw = String(name || '').trim();
    if (!raw) return true;

    // Normalize by removing non-alphanumerics so N/A, N-A, N A all become "na".
    const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    return compact === 'na' || compact === 'none' || compact === 'null' || compact === 'undefined';
}

function handleIndicatorClick(idx) {
    const entry = _indicatorRegistry[idx];
    if (!entry) return;

    // Always use record-mode category modal (only imported records supported)
    if (_lastDashboardData) {
        const cats = (_lastDashboardData.all_categories || []).filter(c => !isSuppressedCategoryName(c?.name));
        const cat = _findCategoryByName(entry.name, cats);
        if (cat) { openRecordCategoryModal(cat); return; }
    }
    // Fallback: show question breakdown from dashboard data
    openCategoryDetailModal(entry.name, entry.mappedIds);
}

// ─── Super Categories ─────────────────────────────────────────────────
function updateSuperCategories(data, superCategories = []) {
    const container = document.getElementById('superCategoriesContainer');
    if (!container) return;
    const allCategories = (data.all_categories || []).filter(c => !isSuppressedCategoryName(c?.name));
    const resourceSpeakers = data.resource_speakers || [];

    _indicatorRegistry.length = 0;

    let displayCats = [];
    let rowsHtml = '';

    if (superCategories.length > 0) {
        const mappedCategoryIds = new Set();

        superCategories
            .filter(superCat => !isSuppressedCategoryName(superCat?.name))
            .forEach(superCat => {
            const mappedIds = (superCat.mapped_categories || []).map(m => parseInt(m.id));
            mappedIds.forEach(id => mappedCategoryIds.add(id));
            const matchingCats = allCategories.filter(c => mappedIds.includes(parseInt(c.id)));
            const ratings = matchingCats.filter(c => c.avg_rating > 0).map(c => c.avg_rating);
            let score = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;

            const includesSpeakers =
                superCat.code.toUpperCase().includes('RSR') ||
                superCat.code.toUpperCase() === 'E' ||
                superCat.name.toLowerCase().includes('speaker') ||
                superCat.name.toLowerCase().includes('resource');

            if (includesSpeakers && resourceSpeakers.length > 0) {
                const spRatings = resourceSpeakers.filter(s => s.rating > 0).map(s => s.rating);
                const spAvg = spRatings.length > 0 ? spRatings.reduce((a, b) => a + b, 0) / spRatings.length : 0;
                if (score > 0 && spAvg > 0) score = (score + spAvg) / 2;
                else if (spAvg > 0) score = spAvg;
            }

            score = Math.round(score * 100) / 100;
            if (score <= 0) return;

            displayCats.push({ code: superCat.code, name: superCat.name, score });

            const scoreColorClass = getIndicatorScoreClass(score);
            const label = getRatingLabel(score);
            const registryIdx = _indicatorRegistry.length;
            _indicatorRegistry.push({ name: superCat.name, mappedIds });

            rowsHtml += `
                <div class="indicator-row" onclick="handleIndicatorClick(${registryIdx})" title="Click to view details">
                    <div class="indicator-label">${escapeHtml(superCat.name).toUpperCase()}</div>
                    <div class="indicator-score ${scoreColorClass}">
                        <div class="score-number">${score > 0 ? score.toFixed(2) : '—'}</div>
                        <div class="score-label">${label}</div>
                    </div>
                </div>`;
                });

        // Show categories that are not part of any configured super-category mapping.
        // This keeps newly added import categories visible on the dashboard.
        const unmappedCategories = allCategories.filter(c => !mappedCategoryIds.has(parseInt(c.id)));
        unmappedCategories.forEach(cat => {
            const score = parseFloat(cat.avg_rating) || 0;
            if (score <= 0) return;

            displayCats.push({ code: 'CAT', name: cat.name, score });

            const scoreColorClass = getIndicatorScoreClass(score);
            const label = getRatingLabel(score);
            const registryIdx = _indicatorRegistry.length;
            _indicatorRegistry.push({ name: cat.name, mappedIds: [parseInt(cat.id)] });

            rowsHtml += `
                <div class="indicator-row" onclick="handleIndicatorClick(${registryIdx})" title="Auto-detected category from imported responses">
                    <div class="indicator-label">${escapeHtml(String(cat.name || 'UNTITLED CATEGORY')).toUpperCase()}</div>
                    <div class="indicator-score ${scoreColorClass}">
                        <div class="score-number">${score > 0 ? score.toFixed(2) : '—'}</div>
                        <div class="score-label">${label}</div>
                    </div>
                </div>`;
        });
    } else {
        const fallbackCats = [
            { key: 'program_management', label: 'PROGRAM MANAGEMENT', code: 'PM' },
            { key: 'attainment_objectives', label: 'ATTAINMENT OF OBJECTIVES', code: 'AO' },
            { key: 'delivery_content', label: 'DELIVERY OF CONTENT', code: 'D' },
            { key: 'food_venue', label: 'FOOD AND VENUE', code: 'FV' },
        ];
        fallbackCats.forEach(item => {
            const score = (data[item.key] || {}).score || 0;
            if (score <= 0) return;

            displayCats.push({ code: item.code, name: item.label, score });
            const scoreColorClass = getIndicatorScoreClass(score);
            const label = getRatingLabel(score);
            rowsHtml += `
                <div class="indicator-row">
                    <div class="indicator-label">${item.label}</div>
                    <div class="indicator-score ${scoreColorClass}">
                        <div class="score-number">${score > 0 ? score.toFixed(2) : '—'}</div>
                        <div class="score-label">${label}</div>
                    </div>
                </div>`;
        });
    }

    container.innerHTML = rowsHtml;
    updateHeaderOverallScore(displayCats, data);
}

function getIndicatorScoreClass(score) {
    if (!score || score === 0) return 'gray-score';
    if (score >= 3.50) return '';
    if (score >= 2.50) return 'blue-score';
    if (score >= 1.50) return 'yellow-score';
    return 'red-score';
}

// BUG FIX: This used to always recompute the overall score client-side by
// averaging the super-category display scores (sum/length). That silently
// overwrote the correct value that updateHeaderOverallScoreFromRecord() had
// just set from data.overall_average — the average already computed and
// stored server-side at save time (see save.php: category_averages /
// evaluation_programs.overall_average, read back via program_dashboard.php).
// The client recompute uses different weighting/rounding than the stored
// figure, so the header score would change depending on call order alone.
// Fix: use the stored average from `data` directly; only fall back to a
// client-side recompute if the backend didn't provide one at all.
function updateHeaderOverallScore(displayCats, data = null) {
    const osbNumber = document.getElementById('osb-number');
    const osbText = document.getElementById('osb-text');
    if (!osbNumber || !osbText) return;

    const storedAvg = data ? parseFloat(data.overall_average) : NaN;
    if (!isNaN(storedAvg) && storedAvg > 0) {
        osbNumber.textContent = storedAvg.toFixed(2);
        osbText.textContent = getOverallLabel(storedAvg);
        return;
    }

    // Fallback only: no stored average available from the backend.
    displayCats = (displayCats || []).filter(c => c.score > 0);
    if (displayCats.length === 0) {
        osbNumber.textContent = '—';
        osbText.textContent = 'N/A';
        return;
    }

    const sum = displayCats.reduce((a, c) => a + c.score, 0);
    const overall = Math.round((sum / displayCats.length) * 100) / 100;
    osbNumber.textContent = overall.toFixed(2);
    osbText.textContent = getOverallLabel(overall);
}

function getOverallLabel(score) {
    return _getLabel(score, 'overall');
}

// ─── Standard PowerPoint Slide Fit ─────────────────────────────────────
/**
 * A standard PowerPoint slide is a fixed 4:3 rectangle (10in x 7.5in).
 * html2canvas only ever captures the board at whatever height its content
 * happens to be (scrollHeight), so the exported image was never actually
 * locked to that ratio — it just came out as a tall, oddly-proportioned
 * picture that then had to be squeezed/stretched to fit a slide.
 *
 * This helper takes a captured canvas and "letterboxes" it into a fixed
 * slideWidth x slideHeight canvas: the full content is scaled down
 * (never cropped, never stretched) to fit inside that rectangle, and
 * centered, with any leftover space filled using the dashboard's own
 * background color so the padding blends in seamlessly.
 */
function fitCanvasToSlide(sourceCanvas, slideWidth, slideHeight, bgColor, mode = 'contain') {
    const slideCanvas = document.createElement('canvas');
    slideCanvas.width = slideWidth;
    slideCanvas.height = slideHeight;

    const ctx = slideCanvas.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, slideWidth, slideHeight);

    if (mode === 'cover') {
        // "cover" fit — fills the slide edge-to-edge with NO horizontal cropping.
        // Scale is always based on WIDTH only (source width -> slide width), since
        // the dashboard is captured at the slide's target width already. Any
        // trimming/padding only ever happens vertically: if the content is taller
        // than the slide at this scale, the excess is cropped off the BOTTOM
        // (header/title/score badge at the top are always kept); if the content
        // is shorter, the leftover space at the bottom is left as background color
        // instead of zooming in and cropping the left/right edges.
        const scale = slideWidth / sourceCanvas.width;
        const scaledHeight = sourceCanvas.height * scale;
        const drawHeight = Math.min(scaledHeight, slideHeight);
        const srcHeight  = drawHeight / scale;

        ctx.drawImage(
            sourceCanvas,
            0, 0, sourceCanvas.width, srcHeight,
            0, 0, slideWidth, drawHeight
        );
    } else {
        // "contain" fit (default) — scale by whichever dimension is the tighter
        // constraint, never cropping, letterboxing any leftover space instead
        const scale = Math.min(
            slideWidth  / sourceCanvas.width,
            slideHeight / sourceCanvas.height
        );
        const drawWidth  = sourceCanvas.width  * scale;
        const drawHeight = sourceCanvas.height * scale;
        const offsetX = (slideWidth  - drawWidth)  / 2;
        const offsetY = (slideHeight - drawHeight) / 2;

        ctx.drawImage(
            sourceCanvas,
            0, 0, sourceCanvas.width, sourceCanvas.height,
            offsetX, offsetY, drawWidth, drawHeight
        );
    }

    return slideCanvas;
}

// ─── PNG Download ─────────────────────────────────────────────────────
/**
 * Captures the .dashboard-board element as a high-res PNG and
 * triggers a browser download. Uses html2canvas loaded from CDN.
 * Falls back gracefully if the library cannot be loaded.
 */
async function downloadDashboardAsPng() {
    const board = document.querySelector('.dashboard-board');
    if (!board) { alert('Dashboard board not found.'); return; }

    const btn = document.getElementById('downloadPngBtn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing...'; }

    try {
        // Load html2canvas on-demand (only once)
        if (!window.html2canvas) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('Could not load html2canvas'));
                document.head.appendChild(s);
            });
        }

        // Build a descriptive filename from the workshop title + date
        const w = _lastDashboardData?.workshop || {};
        const title = (w.title || 'Dashboard').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
        const dateStr = formatWorkshopDate(w);
        const datePart = dateStr
            ? '_' + dateStr.replace(/[^a-zA-Z0-9]/g, '_').replace(/__+/g, '_')
            : '_' + new Date().toISOString().slice(0, 10);
        const filename = `${title}${datePart}.png`;

        // ── Use a fixed capture width wide enough for the full header ────────
        const CAPTURE_WIDTH = 1200;

        // Save original board styles
        const origBoardWidth    = board.style.width;
        const origBoardMinWidth = board.style.minWidth;
        const origBoardPosition = board.style.position;
        const origBoardLeft     = board.style.left;
        const origBoardTop      = board.style.top;
        const origBoardZIndex   = board.style.zIndex;

        // Also fix h2 to wrap properly at the wider width
        const header = board.querySelector('#workshopHeader');
        const h2 = header ? header.querySelector('h2') : null;
        const origH2White  = h2 ? h2.style.whiteSpace   : null;
        const origH2Wrap   = h2 ? h2.style.overflowWrap : null;
        const origH2Break  = h2 ? h2.style.wordBreak    : null;

        // Temporarily pin the board to a fixed wide width off-screen
        board.style.width    = CAPTURE_WIDTH + 'px';
        board.style.minWidth = CAPTURE_WIDTH + 'px';
        board.style.position = 'fixed';
        board.style.left     = '-9999px';
        board.style.top      = '0px';
        board.style.zIndex   = '-1';

        if (h2) {
            h2.style.whiteSpace   = 'normal';
            h2.style.overflowWrap = 'break-word';
            h2.style.wordBreak    = 'break-word';
        }
        fitWorkshopTitleSize(h2);

        // Wait for web fonts to finish loading/swapping (display=swap can still
        // be mid-swap here) before measuring layout, then two frames for reflow.
        // Skipping this lets scrollHeight get measured against one font's line
        // wraps while html2canvas paints with another's metrics, producing
        // squished/overlapping title text in the export.
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const captureH = board.scrollHeight;

        let canvas;
        try {
            canvas = await html2canvas(board, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#0f172a',
                logging: false,
                width: CAPTURE_WIDTH,
                height: captureH,
                windowWidth: CAPTURE_WIDTH,
                scrollX: 0,
                scrollY: 0,
            });
        } finally {
            // ── Always restore the board and h2 styles ───────────────────────
            board.style.width    = origBoardWidth;
            board.style.minWidth = origBoardMinWidth;
            board.style.position = origBoardPosition;
            board.style.left     = origBoardLeft;
            board.style.top      = origBoardTop;
            board.style.zIndex   = origBoardZIndex;
            if (h2) {
                h2.style.whiteSpace   = origH2White  ?? '';
                h2.style.overflowWrap = origH2Wrap   ?? '';
                h2.style.wordBreak    = origH2Break  ?? '';
                fitWorkshopTitleSize(h2);
            }
        }

        // Trigger download
        const link = document.createElement('a');
        link.download = filename;
        link.href = canvas.toDataURL('image/png');
        link.click();

        showToast('Dashboard saved as PNG!', 'success');
    } catch (err) {
        console.error('PNG export error:', err);
        alert('Could not export PNG: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
}

// ─── Projector Size Download ──────────────────────────────────────────
/**
 * Exports the dashboard board as a PNG sized for a standard office
 * projector (1280px wide, WXGA-class resolution) instead of the full
 * retina-quality PNG/JPEG. No 2x scale multiplier is applied, so the
 * resulting file is much smaller and closer to what a projector can
 * actually display — the regular PNG/JPEG options above stay untouched
 * for printing or sharing where higher resolution is worth the size.
 *
 * The capture width was bumped up from 1024 to 1280: at 1024px a long
 * workshop title (e.g. a full DM title) wraps onto several extra lines,
 * inflating the header card's height so much that the fixed 4:3 "cover"
 * fit below has to crop content off the bottom to keep the slide ratio.
 * The wider capture gives the title more room per line, so the header
 * stays close to its normal height regardless of how long the title is.
 */
async function downloadDashboardForProjector() {
    const board = document.querySelector('.dashboard-board');
    if (!board) { alert('Dashboard board not found.'); return; }

    const btn = document.getElementById('downloadProjectorBtn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing...'; }

    try {
        // Load html2canvas on-demand (only once)
        if (!window.html2canvas) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('Could not load html2canvas'));
                document.head.appendChild(s);
            });
        }

        // Build a descriptive filename from the workshop title + date
        const w = _lastDashboardData?.workshop || {};
        const title = (w.title || 'Dashboard').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
        const dateStr = formatWorkshopDate(w);
        const datePart = dateStr
            ? '_' + dateStr.replace(/[^a-zA-Z0-9]/g, '_').replace(/__+/g, '_')
            : '_' + new Date().toISOString().slice(0, 10);
        const filename = `${title}${datePart}_Projector.png`;

        // ── Standard office-projector width (WXGA-class, no retina scaling) ──
        const CAPTURE_WIDTH = 1280;

        // Save original board styles
        const origBoardWidth    = board.style.width;
        const origBoardMinWidth = board.style.minWidth;
        const origBoardPosition = board.style.position;
        const origBoardLeft     = board.style.left;
        const origBoardTop      = board.style.top;
        const origBoardZIndex   = board.style.zIndex;

        // Also fix h2 to wrap properly at the narrower width
        const header = board.querySelector('#workshopHeader');
        const h2 = header ? header.querySelector('h2') : null;
        const origH2White  = h2 ? h2.style.whiteSpace   : null;
        const origH2Wrap   = h2 ? h2.style.overflowWrap : null;
        const origH2Break  = h2 ? h2.style.wordBreak    : null;

        // Temporarily pin the board to a fixed projector-friendly width off-screen
        board.style.width    = CAPTURE_WIDTH + 'px';
        board.style.minWidth = CAPTURE_WIDTH + 'px';
        board.style.position = 'fixed';
        board.style.left     = '-9999px';
        board.style.top      = '0px';
        board.style.zIndex   = '-1';

        if (h2) {
            h2.style.whiteSpace   = 'normal';
            h2.style.overflowWrap = 'break-word';
            h2.style.wordBreak    = 'break-word';
        }

        // Re-run the long-title font fit now that the header has reflowed at
        // the wider capture width — keeps the header compact for captures too.
        fitWorkshopTitleSize(h2);

        // Wait for web fonts to finish loading/swapping (display=swap can still
        // be mid-swap here) before measuring layout, then two frames for reflow.
        // Skipping this lets scrollHeight get measured against one font's line
        // wraps while html2canvas paints with another's metrics, producing
        // squished/overlapping title text in the export.
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const captureH = board.scrollHeight;

        let canvas;
        try {
            canvas = await html2canvas(board, {
                scale: 1,
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#0f172a',
                logging: false,
                width: CAPTURE_WIDTH,
                height: captureH,
                windowWidth: CAPTURE_WIDTH,
                scrollX: 0,
                scrollY: 0,
            });
        } finally {
            // ── Always restore the board and h2 styles ───────────────────────
            board.style.width    = origBoardWidth;
            board.style.minWidth = origBoardMinWidth;
            board.style.position = origBoardPosition;
            board.style.left     = origBoardLeft;
            board.style.top      = origBoardTop;
            board.style.zIndex   = origBoardZIndex;
            if (h2) {
                h2.style.whiteSpace   = origH2White  ?? '';
                h2.style.overflowWrap = origH2Wrap   ?? '';
                h2.style.wordBreak    = origH2Break  ?? '';
                fitWorkshopTitleSize(h2); // restore on-screen sizing too
            }
        }

        // ── Lock the output to a standard 4:3 PowerPoint slide (10in x 7.5in @ 1280x960,
        //    WXGA-class). BUG FIX: was using 'cover', which crops off whatever content
        //    doesn't fit inside the 4:3 box (usually the Resource Speakers row at the
        //    bottom). 'contain' scales the WHOLE board down to fit inside the slide and
        //    pads any leftover space with the background color instead — nothing is
        //    ever cropped, no matter how tall the board's content is. ──────────────────
        const slideCanvas = fitCanvasToSlide(canvas, 1280, 960, '#0f172a', 'contain');

        // Trigger download
        const link = document.createElement('a');
        link.download = filename;
        link.href = slideCanvas.toDataURL('image/png');
        link.click();

        showToast('Dashboard saved for projector!', 'success');
    } catch (err) {
        console.error('Projector export error:', err);
        alert('Could not export projector image: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
}

// ─── JPEG Download ────────────────────────────────────────────────────
/**
 * Captures the .dashboard-board element as a high-res JPEG and
 * triggers a browser download. Uses html2canvas loaded from CDN.
 * Falls back gracefully if the library cannot be loaded.
 */
async function downloadDashboardAsJpeg() {
    const board = document.querySelector('.dashboard-board');
    if (!board) { alert('Dashboard board not found.'); return; }

    const btn = document.getElementById('downloadJpegBtn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing...'; }

    try {
        // Load html2canvas on-demand (only once)
        if (!window.html2canvas) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('Could not load html2canvas'));
                document.head.appendChild(s);
            });
        }

        // Build a descriptive filename from the workshop title + date
        const w = _lastDashboardData?.workshop || {};
        const title = (w.title || 'Dashboard').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
        const dateStr = formatWorkshopDate(w);
        const datePart = dateStr
            ? '_' + dateStr.replace(/[^a-zA-Z0-9]/g, '_').replace(/__+/g, '_')
            : '_' + new Date().toISOString().slice(0, 10);
        const filename = `${title}${datePart}.jpg`;

        // BUG 13 FIX: apply same off-screen wide-capture logic as PNG export
        const CAPTURE_WIDTH = 1200;

        const origBoardWidth    = board.style.width;
        const origBoardMinWidth = board.style.minWidth;
        const origBoardPosition = board.style.position;
        const origBoardLeft     = board.style.left;
        const origBoardTop      = board.style.top;
        const origBoardZIndex   = board.style.zIndex;

        const header = board.querySelector('#workshopHeader');
        const h2 = header ? header.querySelector('h2') : null;
        const origH2White  = h2 ? h2.style.whiteSpace   : null;
        const origH2Wrap   = h2 ? h2.style.overflowWrap : null;
        const origH2Break  = h2 ? h2.style.wordBreak    : null;

        board.style.width    = CAPTURE_WIDTH + 'px';
        board.style.minWidth = CAPTURE_WIDTH + 'px';
        board.style.position = 'fixed';
        board.style.left     = '-9999px';
        board.style.top      = '0px';
        board.style.zIndex   = '-1';

        if (h2) {
            h2.style.whiteSpace   = 'normal';
            h2.style.overflowWrap = 'break-word';
            h2.style.wordBreak    = 'break-word';
        }
        fitWorkshopTitleSize(h2);

        // Wait for web fonts to finish loading/swapping (display=swap can still
        // be mid-swap here) before measuring layout, then two frames for reflow.
        // Skipping this lets scrollHeight get measured against one font's line
        // wraps while html2canvas paints with another's metrics, producing
        // squished/overlapping title text in the export.
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const captureH = board.scrollHeight;

        let canvas;
        try {
            canvas = await html2canvas(board, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#0f172a',
                logging: false,
                width: CAPTURE_WIDTH,
                height: captureH,
                windowWidth: CAPTURE_WIDTH,
                scrollX: 0,
                scrollY: 0,
            });
        } finally {
            board.style.width    = origBoardWidth;
            board.style.minWidth = origBoardMinWidth;
            board.style.position = origBoardPosition;
            board.style.left     = origBoardLeft;
            board.style.top      = origBoardTop;
            board.style.zIndex   = origBoardZIndex;
            if (h2) {
                h2.style.whiteSpace   = origH2White  ?? '';
                h2.style.overflowWrap = origH2Wrap   ?? '';
                h2.style.wordBreak    = origH2Break  ?? '';
                fitWorkshopTitleSize(h2);
            }
        }

        // ── Lock the output to a standard 4:3 PowerPoint slide (1600x1200 — same ratio
        //    as a 10in x 7.5in slide, higher-res than the projector export) instead of a
        //    tall image sized to the content's natural scrollHeight. BUG FIX: was using
        //    'cover', which crops off whatever content doesn't fit inside the 4:3 box
        //    (usually the Resource Speakers row at the bottom). 'contain' scales the
        //    WHOLE board down to fit and pads leftover space with the background color
        //    instead — nothing is ever cropped. ──────────────────────────────────────
        const slideCanvas = fitCanvasToSlide(canvas, 1600, 1200, '#0f172a', 'contain');

        // Trigger download (quality 0.92 = high quality with good compression)
        const link = document.createElement('a');
        link.download = filename;
        link.href = slideCanvas.toDataURL('image/jpeg', 0.92);
        link.click();

        showToast('Dashboard saved as JPEG!', 'success');
    } catch (err) {
        console.error('JPEG export error:', err);
        alert('Could not export JPEG: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
}

// ─── Category Detail Modal ────────────────────────────────────────────
async function openCategoryDetailModal(superCatName, mappedCategoryIds) {
    if (!currentWorkshopId && !_programRecordId) return;

    const allCategories = (_lastDashboardData.all_categories || []).filter(c => !isSuppressedCategoryName(c?.name));
    const matchingCats = allCategories.filter(c => mappedCategoryIds.includes(parseInt(c.id)));
    const ratedMap = new Map();
    const seenTexts = new Map();

    matchingCats.forEach(cat => {
        (cat.questions || []).forEach(q => {
            const id = parseInt(q.id);
            const key = (q.text || '').trim().toLowerCase();
            if (seenTexts.has(key)) {
                const existingId = seenTexts.get(key);
                const existing = ratedMap.get(existingId);
                if ((q.answer_count || 0) > (existing.answer_count || 0)) {
                    ratedMap.delete(existingId);
                    ratedMap.set(id, { id, text: q.text, avg_rating: q.avg_rating || 0, answer_count: q.answer_count || 0, label: q.label || 'N/A', category: cat.name });
                    seenTexts.set(key, id);
                }
                return;
            }
            seenTexts.set(key, id);
            ratedMap.set(id, { id, text: q.text, avg_rating: q.avg_rating || 0, answer_count: q.answer_count || 0, label: q.label || 'N/A', category: cat.name });
        });
    });

    const questionsWithRatings = Array.from(ratedMap.values()).sort((a, b) => b.avg_rating - a.avg_rating);
    const rated = questionsWithRatings.filter(q => q.avg_rating > 0);
    const maxScore = rated.length > 0 ? rated[0].avg_rating : 0;
    const minScore = rated.length > 0 ? rated[rated.length - 1].avg_rating : 0;
    const lowest = (minScore < maxScore) ? [...rated].sort((a, b) => a.avg_rating - b.avg_rating).filter(q => q.avg_rating === minScore).slice(0, 3) : [];
    const highest = rated.filter(q => q.avg_rating === maxScore).slice(0, 3);

    const catAvgRatings = matchingCats.filter(c => c.avg_rating > 0).map(c => c.avg_rating);
    const catOverall = catAvgRatings.length > 0
        ? (catAvgRatings.reduce((a, b) => a + b, 0) / catAvgRatings.length).toFixed(2)
        : '—';

    const modalHtml = `
        <div class="qres-modal-overlay" id="catDetailModal" onclick="closeCatDetailModal(event)">
            <div class="qres-modal-box" style="max-width:680px;" onclick="event.stopPropagation()">
                <div class="qres-modal-header">
                    <div>
                        <div class="qres-modal-title"><i class="fa-solid fa-chart-bar"></i> ${escapeHtml(superCatName)}</div>
                        <div class="qres-modal-sub">Category Detail &amp; Question Analysis</div>
                    </div>
                    <button class="qres-modal-close" onclick="document.getElementById('catDetailModal').remove()">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="qres-modal-body">
                    <div class="cat-modal-overall">
                        <span class="cat-modal-overall-label">Category Average</span>
                        <span class="cat-modal-overall-score ${getBadgeClass(parseFloat(catOverall))}">${catOverall}</span>
                        <span class="cat-modal-overall-text">${getRatingLabel(parseFloat(catOverall) || 0)}</span>
                    </div>
                    ${questionsWithRatings.length === 0 ? `
                        <div class="no-data-inline" style="padding:24px 0;">
                            <i class="fa-solid fa-circle-info" style="font-size:28px;opacity:0.3;"></i>
                            <p>No question data available yet.</p>
                        </div>` : `
                        <div class="cat-modal-section-title"><i class="fa-solid fa-list-check"></i> All Questions</div>
                        <div class="cat-questions-table">
                            ${questionsWithRatings.map((q, i) => {
        const pct = q.avg_rating > 0 ? Math.round((q.avg_rating / 4) * 100) : 0;
        const isLowest = lowest.includes(q);
        const isHighest = i === 0 && q.avg_rating > 0;
        return `
                                <div class="cat-question-row ${isLowest ? 'q-lowest' : ''} ${isHighest ? 'q-highest' : ''}">
                                    <div class="q-rank-badge">${i + 1}</div>
                                    <div class="q-content">
                                        <div class="q-text">${escapeHtml(q.text)}</div>
                                        <div class="q-sub">${escapeHtml(q.category)} • ${q.answer_count} respondents</div>
                                        <div class="q-bar-wrap"><div class="q-bar-fill" style="width:${pct}%;background:${getBarColor(q.avg_rating)};"></div></div>
                                    </div>
                                    <div class="q-score-col">
                                        ${isLowest ? '<div class="q-flag q-flag-low"><i class="fa-solid fa-triangle-exclamation"></i></div>' : ''}
                                        ${isHighest ? '<div class="q-flag q-flag-high"><i class="fa-solid fa-star"></i></div>' : ''}
                                        <div class="q-score-val">${q.avg_rating > 0 ? q.avg_rating.toFixed(2) : '—'}</div>
                                        <div class="q-score-lbl" style="color:${getBarColor(q.avg_rating)};">${q.label}</div>
                                    </div>
                                </div>`;
    }).join('')}
                        </div>
                        ${lowest.length > 0 ? `<div class="cat-modal-insight-box insight-low">
                            <div class="insight-title"><i class="fa-solid fa-triangle-exclamation"></i> Areas for Improvement</div>
                            <ul class="insight-list">${lowest.map(q => `<li><span class="insight-score">${q.avg_rating.toFixed(2)}</span> ${escapeHtml(q.text)}</li>`).join('')}</ul>
                        </div>` : ''}
                        ${highest.length > 0 ? `<div class="cat-modal-insight-box insight-high">
                            <div class="insight-title"><i class="fa-solid fa-star"></i> Strengths (Highest Scores)</div>
                            <ul class="insight-list">${highest.map(q => `<li><span class="insight-score">${q.avg_rating.toFixed(2)}</span> ${escapeHtml(q.text)}</li>`).join('')}</ul>
                        </div>` : ''}
                    `}
                </div>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    requestAnimationFrame(() => document.getElementById('catDetailModal').classList.add('visible'));
}

function closeCatDetailModal(event) {
    const modal = document.getElementById('catDetailModal');
    if (modal && event.target === modal) modal.remove();
}

function getBarColor(score) {
    if (score >= 3.5) return '#22c55e';
    if (score >= 2.5) return '#3b82f6';
    if (score >= 1.5) return '#f59e0b';
    if (score > 0) return '#ef4444';
    return '#d1d5db';
}

// ─── Participants Modal ───────────────────────────────────────────────
function openParticipantsModal() {
    const participants = _lastDashboardData.participants || {};
    const total = participants.total || 0;
    const male = participants.male_count || 0;
    const female = participants.female_count || 0;
    // BUG 10 FIX: read lgbtq_count directly from the API data (same source as the pie chart)
    const others = participants.lgbtq_count ?? 0;
    const malePct = total > 0 ? ((male / total) * 100).toFixed(1) : 0;
    const femalePct = total > 0 ? ((female / total) * 100).toFixed(1) : 0;
    const othersPct = total > 0 ? ((others / total) * 100).toFixed(1) : 0;
    const expected = _lastDashboardData.workshop?.expected_participants || null;
    const responseRate = expected && expected > 0 ? ((total / expected) * 100).toFixed(1) : null;

    const rows = [
        { label: 'Male', count: male, pct: malePct, color: '#60A5FA', icon: 'fa-mars' },
        { label: 'Female', count: female, pct: femalePct, color: '#F87171', icon: 'fa-venus' },
        { label: 'Prefer not to say', count: others, pct: othersPct, color: '#9ca3af', icon: 'fa-minus-circle' },
    ];

    const rowsHtml = rows.map(r => `
        <div class="participant-row">
            <div class="participant-icon" style="background:${r.color}20;color:${r.color};"><i class="fa-solid ${r.icon}"></i></div>
            <div class="participant-info">
                <div class="participant-label">${r.label}</div>
                <div class="participant-bar-wrap"><div class="participant-bar-fill" style="width:${r.pct}%;background:${r.color};"></div></div>
            </div>
            <div class="participant-stats">
                <div class="participant-count">${r.count}</div>
                <div class="participant-pct">${r.pct}%</div>
            </div>
        </div>`).join('');

    document.body.insertAdjacentHTML('beforeend', `
        <div class="qres-modal-overlay" id="participantsModal" onclick="closeParticipantsModal(event)">
            <div class="qres-modal-box" style="max-width:480px;" onclick="event.stopPropagation()">
                <div class="qres-modal-header">
                    <div>
                        <div class="qres-modal-title"><i class="fa-solid fa-users"></i> Respondent Breakdown</div>
                        <div class="qres-modal-sub">Gender distribution of evaluation respondents</div>
                    </div>
                    <button class="qres-modal-close" onclick="document.getElementById('participantsModal').remove()">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="qres-modal-body">
                    <div class="participants-total-banner">
                        <span class="ptb-number">${total}</span>
                        <span class="ptb-label">Total Respondents</span>
                        ${responseRate ? `<span class="ptb-rate">${responseRate}% response rate</span>` : ''}
                    </div>
                    <div class="participants-rows">${rowsHtml}</div>
                    ${expected ? `<div class="participants-expected-note">
                        <i class="fa-solid fa-circle-info"></i>
                        Expected participants: <strong>${expected}</strong>
                        ${total < expected ? ` &bull; <span style="color:#f59e0b;">${expected - total} yet to respond</span>` : ''}
                    </div>` : ''}
                </div>
            </div>
        </div>`);
    requestAnimationFrame(() => document.getElementById('participantsModal').classList.add('visible'));
}

function closeParticipantsModal(event) {
    const modal = document.getElementById('participantsModal');
    if (modal && event.target === modal) modal.remove();
}

// ─── Resource Speakers ────────────────────────────────────────────────
// Store speakers data globally for modal access
let _cachedSpeakers = [];
let _cachedSpeakersByDay = {};

function setSpeakersSectionVisible(isVisible) {
    const section = document.querySelector('.speakers-row');
    if (!section) return;
    section.style.display = isVisible ? '' : 'none';
}

function updateResourceSpeakers(speakers) {
    const grid = document.getElementById('speakersGrid');
    if (!grid) return;
    _cachedSpeakers = speakers || [];
    if (!speakers || speakers.length === 0) {
        setSpeakersSectionVisible(false);
        grid.innerHTML = '';
        return;
    }
    setSpeakersSectionVisible(true);
    grid.innerHTML = [...speakers].sort((a, b) => a.number - b.number).map((speaker, i) => {
        const ratingText = speaker.rating > 0 ? speaker.rating.toFixed(2) : 'N/A';
        const showName = _speakerDisplaySettings.show_name && speaker.name;
        const nameLine = showName ? `<span class="speaker-name">${escapeHtml(speaker.name)}</span>` : '';
        const hasCriteria = speaker.criteria && speaker.criteria.length > 0;
        const clickAttr = hasCriteria ? `onclick="openSpeakerDetailModal(${speaker.number}, null)" style="cursor:pointer"` : '';
        const clickHint = hasCriteria ? ' title="Click to view details"' : '';
        const isTop = _speakerDisplaySettings.highlight_top && speaker.is_top;
        const labelHtml = _speakerDisplaySettings.show_badge_label ? `<div class="speaker-label">RP ${speaker.number}</div>` : '';
        const scoreHtml = _speakerDisplaySettings.show_rating ? `<div class="speaker-score">${ratingText}</div>` : '';
        return `<div class="speaker-item ${isTop ? 'top-speaker' : ''}" ${clickAttr}${clickHint}>
            <div class="speaker-badge color-${i % 6}">
                ${labelHtml}
                ${scoreHtml}
            </div>${nameLine}</div>`;
    }).join('');
}

function updateResourceSpeakersByDay(speakersByDay) {
    const grid = document.getElementById('speakersGrid');
    if (!grid) return;
    _cachedSpeakersByDay = speakersByDay || {};
    if (!speakersByDay || Object.keys(speakersByDay).length === 0) {
        setSpeakersSectionVisible(false);
        grid.innerHTML = '';
        return;
    }

    const totalSpeakers = Object.values(speakersByDay)
        .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);

    if (totalSpeakers === 0) {
        setSpeakersSectionVisible(false);
        grid.innerHTML = '';
        return;
    }

    setSpeakersSectionVisible(true);

    let html = '<div class="speakers-by-day-container">';
    Object.keys(speakersByDay).sort((a, b) => parseInt(a) - parseInt(b)).forEach(dayNum => {
        html += `<div class="day-speakers-section">
            <div class="day-speakers-header">Day ${dayNum}</div>
            <div class="day-speakers-grid">`;
        speakersByDay[dayNum].forEach((speaker, i) => {
            const ratingText = speaker.rating > 0 ? speaker.rating.toFixed(2) : 'N/A';
            const showName = _speakerDisplaySettings.show_name && speaker.name;
            const nameLine = showName ? `<span class="speaker-name">${escapeHtml(speaker.name)}</span>` : '';
            const hasCriteria = speaker.criteria && speaker.criteria.length > 0;
            const clickAttr = hasCriteria ? `onclick="openSpeakerDetailModal(${speaker.number}, '${dayNum}')" style="cursor:pointer"` : '';
            const clickHint = hasCriteria ? ' title="Click to view details"' : '';
            const isTop = _speakerDisplaySettings.highlight_top && speaker.is_top;
            const labelHtml = _speakerDisplaySettings.show_badge_label ? `<div class="speaker-label">RP ${speaker.number}</div>` : '';
            const scoreHtml = _speakerDisplaySettings.show_rating ? `<div class="speaker-score">${ratingText}</div>` : '';
            html += `<div class="speaker-item ${isTop ? 'top-speaker' : ''}" ${clickAttr}${clickHint}>
                <div class="speaker-badge color-${i % 6}">
                    ${labelHtml}
                    ${scoreHtml}
                </div>${nameLine}</div>`;
        });
        html += '</div></div>';
    });
    grid.innerHTML = html + '</div>';
}

// ─── Speaker Detail Modal ─────────────────────────────────────────────
function openSpeakerDetailModal(speakerNumber, dayNum) {
    // Find the speaker data
    let speaker = null;
    if (dayNum !== null && _cachedSpeakersByDay[dayNum]) {
        speaker = _cachedSpeakersByDay[dayNum].find(s => s.number === speakerNumber);
    } else if (_cachedSpeakers.length > 0) {
        speaker = _cachedSpeakers.find(s => s.number === speakerNumber);
    }

    if (!speaker || !speaker.criteria || speaker.criteria.length === 0) {
        return;
    }

    const criteria = speaker.criteria;
    const scores = criteria.map(c => c.score).filter(s => s > 0);
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;

    // Identify strengths (highest) and weaknesses (lowest)
    const strengths = criteria.filter(c => c.score === maxScore && c.score > 0);
    const weaknesses = criteria.filter(c => c.score === minScore && c.score > 0 && c.score < maxScore);

    const speakerName = speaker.name || `Resource Person ${speakerNumber}`;
    const overallRating = speaker.rating || 0;
    const label = _getLabel(overallRating, 'speaker');

    // Build criteria rows
    const criteriaHtml = criteria.map((c, idx) => {
        const isTop = c.score === maxScore && c.score > 0;
        const isLow = c.score === minScore && c.score > 0 && c.score < maxScore;
        const color = isTop ? '#22c55e' : isLow ? '#f59e0b' : '#3b82f6';
        const pct = maxScore > 0 ? (c.score / 4) * 100 : 0;
        const flag = isTop ? '<span class="q-flag q-flag-high">⭐</span>' : isLow ? '<span class="q-flag q-flag-low">⚠️</span>' : '';
        return `
            <div class="cat-question-row ${isTop ? 'q-highest' : ''} ${isLow ? 'q-lowest' : ''}">
                <div class="q-rank-badge">${idx + 1}</div>
                <div class="q-content">
                    <div class="q-text">${escapeHtml(c.label)}</div>
                    <div class="q-bar-wrap">
                        <div class="q-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
                    </div>
                </div>
                <div class="q-score-col">
                    <div class="q-score-val" style="color:${color}">${c.score.toFixed(2)}</div>
                </div>
                ${flag}
            </div>`;
    }).join('');

    // Build insights
    let insightsHtml = '';
    if (strengths.length > 0) {
        insightsHtml += `
            <div class="cat-modal-insight-box insight-high">
                <div class="insight-title"><i class="fa-solid fa-star"></i> Strengths</div>
                <ul class="insight-list">
                    ${strengths.map(s => `<li><span class="insight-score">${s.score.toFixed(2)}</span> ${escapeHtml(s.label)}</li>`).join('')}
                </ul>
            </div>`;
    }
    if (weaknesses.length > 0) {
        insightsHtml += `
            <div class="cat-modal-insight-box insight-low">
                <div class="insight-title"><i class="fa-solid fa-triangle-exclamation"></i> Areas for Improvement</div>
                <ul class="insight-list">
                    ${weaknesses.map(w => `<li><span class="insight-score">${w.score.toFixed(2)}</span> ${escapeHtml(w.label)}</li>`).join('')}
                </ul>
            </div>`;
    }

    const modalHtml = `
        <div class="qres-modal-overlay" id="speakerDetailModal" onclick="closeSpeakerDetailModal(event)">
            <div class="qres-modal-box" style="max-width:620px;" onclick="event.stopPropagation()">
                <div class="qres-modal-header">
                    <div>
                        <div class="qres-modal-title"><i class="fa-solid fa-user-tie"></i> ${escapeHtml(speakerName)}</div>
                        <div class="qres-modal-sub">Resource Person ${speakerNumber}${dayNum ? ' · Day ' + dayNum : ''} — Criteria Breakdown</div>
                    </div>
                    <button class="qres-modal-close" onclick="document.getElementById('speakerDetailModal').remove()">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="qres-modal-body">
                    <div class="cat-modal-overall">
                        <span class="cat-modal-overall-label">Overall Rating</span>
                        <span class="cat-modal-overall-score">${overallRating.toFixed(2)}</span>
                        <span class="cat-modal-overall-text" style="color:${overallRating >= 3.50 ? '#22c55e' : overallRating >= 2.50 ? '#3b82f6' : '#f59e0b'}">${label}</span>
                    </div>
                    <div class="cat-modal-section-title"><i class="fa-solid fa-list-check"></i> Criteria Scores</div>
                    <div class="cat-questions-table">${criteriaHtml}</div>
                    ${insightsHtml}
                </div>
            </div>
        </div>`;

    // Remove existing modal if any
    const existing = document.getElementById('speakerDetailModal');
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    setTimeout(() => document.getElementById('speakerDetailModal')?.classList.add('visible'), 10);
}

function closeSpeakerDetailModal(event) {
    const modal = document.getElementById('speakerDetailModal');
    if (modal && event.target === modal) modal.remove();
}

// ─── Utility ──────────────────────────────────────────────────────────
function getRatingLabel(score) {
    return _getLabel(score, 'category');
}

function getBadgeClass(score) {
    if (!score || score === 0) return 'gray';
    if (score >= 3.50) return '';
    if (score >= 2.50) return 'blue';
    if (score >= 1.50) return 'yellow';
    return 'orange';
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNoDashboardData(message = null) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
    const header = document.getElementById('workshopHeader');
    if (header) {
        if (message) {
            header.innerHTML = `<h2>${message}</h2>`;
        } else {
            header.innerHTML = `
                <h2 style="color:#94a3b8;font-size:18px;font-weight:500;">
                    <i class="fa-solid fa-hand-pointer" style="margin-right:8px;"></i>
                    Select a workshop from the dropdown above to view its dashboard.
                </h2>`;
        }
    }
}

// ─── Day navigation ───────────────────────────────────────────────────
function changeDay(direction) {
    if (workshopDays.length <= 1) return;

    function loadDay(dayEntry) {
        if (_containerWorkshopId && dayEntry?.id) {
            // Each day entry id = program_id of that import — load it directly.
            // Pass the day label (not 'all') so the API returns single-day data.
            _programRecordId = dayEntry.id;
            loadProgramRecord(dayEntry.id, dayEntry.title || 'day');
        } else {
            loadProgramRecord(_programRecordId, dayEntry?.title || 'day');
        }
    }

    if (isAllDaysView) {
        // From All Days, next → Day 1
        if (direction === 1 && workshopDays.length > 0) {
            isAllDaysView = false;
            currentDayIndex = 0;
            loadDay(workshopDays[0]);
        }
        return;
    }

    if (direction === -1 && currentDayIndex === 0) {
        // From Day 1, prev → All Days
        isAllDaysView = true;
        if (_containerWorkshopId) {
            loadContainerDashboard(_containerWorkshopId, 'all');
        } else {
            loadProgramRecord(_programRecordId, 'all');
        }
        return;
    }

    const ni = currentDayIndex + direction;
    if (ni >= 0 && ni < workshopDays.length) {
        currentDayIndex = ni;
        loadDay(workshopDays[ni]);
    }
}

function updateDayNavigation() {
    const prev = document.getElementById('prevDayBtn');
    const next = document.getElementById('nextDayBtn');
    if (workshopDays.length <= 1) {
        if (prev) prev.disabled = true;
        if (next) next.disabled = true;
        return;
    }
    if (isAllDaysView) {
        // All Days: can go forward to Day 1, cannot go back further
        if (prev) prev.disabled = true;
        if (next) next.disabled = false;
        return;
    }
    // Specific day: prev goes back (to All Days when at index 0), next goes forward
    if (prev) prev.disabled = false;
    if (next) next.disabled = currentDayIndex >= workshopDays.length - 1;
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

function toggleSubmenu(name) {
    expandedMenus[name] = !expandedMenus[name];
    const sub = document.getElementById(name + '-submenu');
    const arrow = document.getElementById(name + '-arrow');
    if (sub) sub.classList.toggle('expanded', expandedMenus[name]);
    if (arrow) {
        arrow.classList.toggle('rotate', expandedMenus[name]);
        arrow.parentElement?.classList.toggle('expanded', expandedMenus[name]);
    }
    if (!sub) return;

    setSubmenuHeight(sub);
    updateAncestorSubmenuHeights(sub);

    // The call above measures ancestor submenus' scrollHeight synchronously,
    // in the same tick that this submenu's own max-height transition just
    // started. At that instant the transition hasn't progressed yet, so any
    // ancestor's scrollHeight is measured *before* this submenu has actually
    // grown/shrunk - meaning the ancestor can get locked to a height that's
    // too small (clipping later items) or briefly wrong. Once this submenu's
    // own max-height transition finishes, re-measure the ancestors again so
    // they end up sized to the real, final content height.
    sub.addEventListener('transitionend', function onDone(e) {
        if (e.propertyName === 'max-height') {
            updateAncestorSubmenuHeights(sub);
            sub.removeEventListener('transitionend', onDone);
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
		importfile: `import-excell.html?page=${encodeURIComponent(PAGE_KEY || 'qatame')}`,
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
    } catch (e) { /* ignore */ } finally {
        ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
        window.location.href = 'login.html';
    }
}

// ─── Inject modal + date-line styles ─────────────────────────────────
function injectModalStyles() {
    const style = document.createElement('style');
    style.textContent = `
        /* ── Workshop date line in header card ── */
        .workshop-date-line {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            margin-top: 6px;
            font-size: 12px;
            font-weight: 600;
            color: rgba(255,255,255,0.75);
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 20px;
            padding: 3px 10px;
            letter-spacing: 0.02em;
        }
        .workshop-date-line i { opacity: 0.8; }

        /* ── Download PNG button ── */
        .btn-download-png {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 7px 14px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            background: linear-gradient(135deg, #0ea5e9, #6366f1);
            color: #fff;
            transition: opacity .15s, transform .1s;
            white-space: nowrap;
        }
        .btn-download-png:hover   { opacity: .88; }
        .btn-download-png:active  { transform: scale(.97); }
        .btn-download-png:disabled{ opacity: .55; cursor: not-allowed; }

        /* ── Download JPEG button ── */
        .btn-download-jpeg {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 7px 14px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            background: linear-gradient(135deg, #f59e0b, #ef4444);
            color: #fff;
            transition: opacity .15s, transform .1s;
            white-space: nowrap;
        }
        .btn-download-jpeg:hover   { opacity: .88; }
        .btn-download-jpeg:active  { transform: scale(.97); }
        .btn-download-jpeg:disabled{ opacity: .55; cursor: not-allowed; }

        /* ── Modal styles (unchanged) ── */
        .qres-modal-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .2s ease}
        .qres-modal-overlay.visible{opacity:1}
        .qres-modal-box{background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.25);width:100%;max-height:85vh;overflow-y:auto;transform:translateY(16px);transition:transform .25s ease}
        .qres-modal-overlay.visible .qres-modal-box{transform:translateY(0)}
        .qres-modal-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 24px 16px;border-bottom:1px solid #f1f5f9;position:sticky;top:0;background:#fff;z-index:2;border-radius:16px 16px 0 0}
        .qres-modal-title{font-size:16px;font-weight:700;color:#1e293b}
        .qres-modal-sub{font-size:12px;color:#94a3b8;margin-top:2px}
        .qres-modal-close{background:#f1f5f9;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#64748b;display:flex;align-items:center;justify-content:center}
        .qres-modal-close:hover{background:#e2e8f0;color:#1e293b}
        .qres-modal-body{padding:20px 24px 24px}
        .cat-modal-overall{display:flex;align-items:center;gap:12px;background:#f8fafc;border-radius:10px;padding:12px 16px;margin-bottom:20px}
        .cat-modal-overall-label{font-size:12px;color:#64748b;font-weight:600;flex:1}
        .cat-modal-overall-score{font-size:20px;font-weight:800;color:#1e293b}
        .cat-modal-overall-text{font-size:11px;font-weight:600;color:#64748b}
        .cat-modal-section-title{font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;display:flex;align-items:center;gap:6px}
        .cat-questions-table{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
        .cat-question-row{display:flex;align-items:center;gap:10px;background:#f8fafc;border-radius:10px;padding:10px 12px;border:1px solid #e2e8f0;transition:background .15s}
        .cat-question-row:hover{background:#f1f5f9}
        .cat-question-row.q-lowest{border-left:3px solid #f59e0b}
        .cat-question-row.q-highest{border-left:3px solid #22c55e}
        .q-rank-badge{min-width:24px;height:24px;border-radius:50%;background:#e2e8f0;color:#64748b;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
        .q-content{flex:1;min-width:0}
        .q-text{font-size:13px;color:#1e293b;font-weight:500;line-height:1.4}
        .q-sub{font-size:11px;color:#94a3b8;margin-top:3px}
        .q-bar-wrap{height:4px;background:#e2e8f0;border-radius:2px;margin-top:6px;overflow:hidden}
        .q-bar-fill{height:100%;border-radius:2px;transition:width .5s ease}
        .q-score-col{text-align:right;min-width:80px;display:flex;flex-direction:column;align-items:flex-end;gap:2px}
        .q-score-val{font-size:16px;font-weight:800;color:#1e293b;line-height:1}
        .q-score-lbl{font-size:9px;font-weight:600;text-transform:uppercase;margin-top:2px}
        .q-flag{font-size:12px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%}
        .q-flag-low{color:#f59e0b;background:#fef3c7}
        .q-flag-high{color:#22c55e;background:#dcfce7}
        .cat-modal-insight-box{border-radius:10px;padding:12px 14px;margin-top:10px}
        .insight-low{background:#fef9ec;border:1px solid #fde68a}
        .insight-high{background:#f0fdf4;border:1px solid #bbf7d0}
        .insight-title{font-size:12px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px}
        .insight-low .insight-title{color:#92400e}
        .insight-high .insight-title{color:#166534}
        .insight-list{margin:0;padding:0 0 0 4px;list-style:none}
        .insight-list li{font-size:12px;color:#374151;padding:4px 0;border-bottom:1px solid rgba(0,0,0,.05);display:flex;gap:8px;align-items:flex-start}
        .insight-list li:last-child{border-bottom:none}
        .insight-score{font-weight:800;font-size:13px;min-width:36px;opacity:.7}
        .participants-total-banner{text-align:center;padding:20px;background:linear-gradient(135deg,#1a3a6b,#2456a4);border-radius:12px;margin-bottom:20px;color:#fff}
        .ptb-number{display:block;font-size:48px;font-weight:800;line-height:1}
        .ptb-label{display:block;font-size:13px;opacity:.85;margin-top:4px}
        .ptb-rate{display:inline-block;margin-top:8px;background:rgba(255,255,255,.2);padding:2px 10px;border-radius:20px;font-size:12px}
        .participants-rows{display:flex;flex-direction:column;gap:12px}
        .participant-row{display:flex;align-items:center;gap:12px;background:#f8fafc;border-radius:10px;padding:12px}
        .participant-icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
        .participant-info{flex:1}
        .participant-label{font-size:13px;font-weight:600;color:#1e293b;margin-bottom:6px}
        .participant-bar-wrap{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}
        .participant-bar-fill{height:100%;border-radius:3px;transition:width .6s ease}
        .participant-stats{text-align:right}
        .participant-count{font-size:20px;font-weight:800;color:#1e293b}
        .participant-pct{font-size:11px;color:#94a3b8}
        .participants-expected-note{font-size:12px;color:#64748b;text-align:center;margin-top:14px;padding:10px;background:#f8fafc;border-radius:8px}
    `;
    document.head.appendChild(style);
}

// ─── Record-mode modal helpers ────────────────────────────────────────
function _normCatName(s) {
    return (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function _findCategoryByName(name, categories) {
    if (!name || !categories || !categories.length) return null;
    categories = categories.filter(c => !isSuppressedCategoryName(c?.name));
    if (!categories.length) return null;
    const needle = _normCatName(name);
    let found = categories.find(c => _normCatName(c.name) === needle);
    if (found) return found;
    found = categories.find(c => { const h = _normCatName(c.name); return h.includes(needle) || needle.includes(h); });
    if (found) return found;
    const needleWords = needle.split(' ').filter(Boolean);
    let bestScore = 0, bestCat = null;
    for (const c of categories) {
        const hw = _normCatName(c.name).split(' ').filter(Boolean);
        const inter = needleWords.filter(w => hw.includes(w)).length;
        const union = new Set([...needleWords, ...hw]).size;
        const score = union > 0 ? inter / union : 0;
        if (score > bestScore) { bestScore = score; bestCat = c; }
    }
    return bestScore >= 0.35 ? bestCat : null;
}

function openRecordCategoryModal(category) {
    if (!category) return;
    const questions = category.questions || [];
    const avg = parseFloat(category.avg_rating) || 0;
    const label = _getLabel(avg, 'category');

    let modal = document.getElementById('categoryDetailModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'categoryDetailModal';
        modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:#fff;border-radius:16px;padding:32px;max-width:700px;width:95%;max-height:85vh;overflow-y:auto;position:relative;">
                <button id="categoryDetailModalClose" style="position:absolute;top:16px;right:16px;background:#f3f4f6;border:none;border-radius:50%;width:36px;height:36px;font-size:18px;cursor:pointer;">&times;</button>
                <div id="categoryDetailModalBody"></div>
            </div>`;
        document.body.appendChild(modal);
    }
    // BUG 6 FIX: use onclick= so these overwrite on each reuse rather than stacking
    const closeBtn = document.getElementById('categoryDetailModalClose');
    if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

    const maxQ = questions.length ? Math.max(...questions.map(q => q.avg_rating || 0)) : 0;
    const minQ = questions.length ? Math.min(...questions.map(q => q.avg_rating || 0)) : 0;

    document.getElementById('categoryDetailModalBody').innerHTML = `
        <h2 style="margin:0 0 4px;font-size:20px;color:#1f2937;">${escapeHtml(category.name)}</h2>
        <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">Category Detail &amp; Question Analysis</p>
        <div style="background:#f9fafb;border-radius:12px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
            <span style="color:#6b7280;font-size:14px;">Category Average</span>
            <div><span style="font-size:26px;font-weight:700;color:#1f2937;">${avg.toFixed(2)}</span>
            <span style="font-size:13px;color:#10b981;font-weight:600;margin-left:8px;">${label}</span></div>
        </div>
        ${questions.map((q, i) => {
        const qAvg = parseFloat(q.avg_rating) || 0;
        const isTop = qAvg === maxQ && qAvg > 0;
        const isLow = qAvg === minQ && questions.length > 1;
        const color = isTop ? '#10b981' : isLow ? '#f59e0b' : '#3b82f6';
        const pct = maxQ > 0 ? (qAvg / 4) * 100 : 0;
        return `<div style="border:1px solid ${isTop ? '#10b981' : isLow ? '#f59e0b' : '#e5e7eb'};border-left:4px solid ${color};border-radius:12px;padding:14px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;gap:12px;">
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:500;color:#1f2937;">${isTop ? '⭐' : isLow ? '⚠️' : ''} ${escapeHtml(q.text)}</div>
                        <div style="font-size:11px;color:#6b7280;margin:4px 0;">${escapeHtml(category.name)} · ${q.answer_count || 0} respondents</div>
                        <div style="height:5px;background:#e5e7eb;border-radius:99px;overflow:hidden;">
                            <div style="width:${pct.toFixed(1)}%;height:5px;background:${color};border-radius:99px;"></div>
                        </div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div style="font-size:22px;font-weight:700;color:${color};">${qAvg.toFixed(2)}</div>
                    </div>
                </div>
            </div>`;
    }).join('')}`;

    modal.style.display = 'flex';
}

// MutationObserver interceptor removed — click routing is now handled
// entirely inside handleIndicatorClick(), which checks _programRecordId
// and calls openRecordCategoryModal() or openCategoryDetailModal()
// as appropriate. Having both active caused a double-modal bug.

// ─── Speaker Display Settings ─────────────────────────────────────────

// Get the actual numeric workshop ID (returns null for program records)
function getActualWorkshopId() {
    if (currentWorkshopId && typeof currentWorkshopId === 'number') {
        return currentWorkshopId;
    }
    if (currentWorkshopId && typeof currentWorkshopId === 'string' && !currentWorkshopId.startsWith('record_')) {
        return parseInt(currentWorkshopId);
    }
    return null; // Program record mode - use global settings
}

// Applies the "Show Response Count" setting to every element it governs:
// the header Responses pill, the speaker-row Responses badge, and the
// Total/Expected Participants labels on the Participants card.
function applyResponseCountVisibility() {
    const show = _speakerDisplaySettings.show_response_count;

    const resBadgeEl = document.querySelector('.responses-badge');
    if (resBadgeEl) resBadgeEl.style.display = show ? '' : 'none';

    const responsePillEl = document.getElementById('responsePill');
    if (responsePillEl) responsePillEl.style.display = show ? '' : 'none';

    const totalEl = document.getElementById('totalParticipantsLabel');
    if (totalEl) totalEl.style.display = show ? '' : 'none';

    // BUG FIX: this previously only ever hid expectedParticipantsLabel (`!show`
    // branch) and relied on updateParticipantsChart() to show it again — but
    // that function only runs on initial dashboard load, not when this setting
    // is toggled in the modal. So turning the toggle off then back on left the
    // label stuck hidden until a full page reload. Now both directions are
    // handled here: when turning it on, re-derive "is there really an expected
    // count to show" from the label's own text (the same check
    // updateParticipantsChart() uses) instead of depending on that other
    // function having run since.
    const expectedEl = document.getElementById('expectedParticipantsLabel');
    if (expectedEl) {
        if (!show) {
            expectedEl.style.display = 'none';
        } else {
            const m = expectedEl.textContent.match(/EXPECTED PARTICIPANTS-(\d+)/);
            const expectedNum = m ? parseInt(m[1], 10) : 0;
            expectedEl.style.display = (expectedNum > 0) ? '' : 'none';
        }
    }
}

async function loadSpeakerDisplaySettings() {
    try {
        const workshopId = getActualWorkshopId();
        console.log('Loading speaker settings for workshopId:', workshopId);

        // If workshopId is null, API returns global defaults
        // Add cache-busting to ensure fresh data
        const cacheBust = Date.now();
        const url = workshopId
            ? `${API_URL}/speaker_display_settings.php?workshop_id=${workshopId}&_=${cacheBust}`
            : `${API_URL}/speaker_display_settings.php?_=${cacheBust}`;

        const res = await apiFetch(url, { cache: 'no-store' });

        if (res.ok) {
            const json = await res.json();
            console.log('Loaded settings response:', json);

            if (json.success && json.data?.effective) {
                _speakerDisplaySettings = {
                    show_name: json.data.effective.show_name == 1,
                    show_rating: json.data.effective.show_rating == 1,
                    show_rank: json.data.effective.show_rank == 1,
                    show_badge_label: json.data.effective.show_badge_label == 1,
                    highlight_top: json.data.effective.highlight_top == 1,
                    show_response_count: json.data.effective.show_response_count == 1
                };
                console.log('Applied settings:', _speakerDisplaySettings);

                // Apply responses badge + total/expected participants visibility on initial load
                applyResponseCountVisibility();
            }
        }
    } catch (e) {
        console.warn('Failed to load speaker display settings:', e);
    }
}

async function openSpeakerSettingsModal() {
    // First load current settings - await to ensure data is loaded
    await loadSpeakerDisplaySettings();
    const existingModal = document.getElementById('speakerSettingsModal');
    if (existingModal) existingModal.remove();

    const workshopId = getActualWorkshopId();
    const isGlobalMode = !workshopId;
    const scopeNote = isGlobalMode
        ? '<div class="speaker-settings-scope-note"><i class="fa-solid fa-globe"></i> Changes will apply to all dashboards (global settings)</div>'
        : '<div class="speaker-settings-scope-note"><i class="fa-solid fa-bookmark"></i> Changes will apply to this workshop only</div>';

    const modalHtml = `
            <div class="speaker-settings-modal-overlay" id="speakerSettingsModal" onclick="closeSpeakerSettingsModal(event)">
                <div class="speaker-settings-modal" onclick="event.stopPropagation()">
                    <div class="speaker-settings-header">
                        <h3><i class="fa-solid fa-sliders"></i> Speaker Display Settings</h3>
                        <button class="speaker-settings-close" onclick="closeSpeakerSettingsModal()">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="speaker-settings-body">
                        ${scopeNote}
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Show Speaker Names</div>
                                <div class="speaker-setting-desc">Display the name below each speaker badge</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_show_name" ${_speakerDisplaySettings.show_name ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Show Ratings</div>
                                <div class="speaker-setting-desc">Display the numerical rating score</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_show_rating" ${_speakerDisplaySettings.show_rating ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Show Rank</div>
                                <div class="speaker-setting-desc">Display the rank position of each speaker</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_show_rank" ${_speakerDisplaySettings.show_rank ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Show Badge Label</div>
                                <div class="speaker-setting-desc">Display "RP 1", "RP 2" labels on badges</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_show_badge_label" ${_speakerDisplaySettings.show_badge_label ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Highlight Top Speaker</div>
                                <div class="speaker-setting-desc">Add visual highlight to the highest-rated speaker</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_highlight_top" ${_speakerDisplaySettings.highlight_top ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="speaker-setting-row">
                            <div>
                                <div class="speaker-setting-label">Show Response Count</div>
                                <div class="speaker-setting-desc">Display response counts and total/expected <br>participants — hide when the count is too low</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting_show_response_count" ${_speakerDisplaySettings.show_response_count ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="speaker-settings-footer">
                        <button class="speaker-settings-btn-cancel" onclick="closeSpeakerSettingsModal()">Cancel</button>
                        <button class="speaker-settings-btn-save" onclick="saveSpeakerSettings()">
                            <i class="fa-solid fa-check"></i> Save Settings
                        </button>
                    </div>
                </div>
            </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    setTimeout(() => document.getElementById('speakerSettingsModal')?.classList.add('visible'), 10);
}

function closeSpeakerSettingsModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('speakerSettingsModal');
    if (modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    }
}

async function saveSpeakerSettings() {
    const workshopId = getActualWorkshopId();
    // workshopId can be null for program records - saves to global settings

    const settings = {
        workshop_id: workshopId, // null will update global defaults
        show_name: document.getElementById('setting_show_name')?.checked ? 1 : 0,
        show_rating: document.getElementById('setting_show_rating')?.checked ? 1 : 0,
        show_rank: document.getElementById('setting_show_rank')?.checked ? 1 : 0,
        show_badge_label: document.getElementById('setting_show_badge_label')?.checked ? 1 : 0,
        highlight_top: document.getElementById('setting_highlight_top')?.checked ? 1 : 0,
        show_response_count: document.getElementById('setting_show_response_count')?.checked ? 1 : 0
    };

    console.log('Saving speaker settings:', settings);

    try {
        const saveBtn = document.querySelector('.speaker-settings-btn-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }

        const res = await apiFetch(`${API_URL}/speaker_display_settings.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        const json = await res.json();
        console.log('Save response:', json);

        if (json.success) {
            // Update local settings from saved data
            const saved = json.data || settings;
            _speakerDisplaySettings = {
                show_name: saved.show_name == 1,
                show_rating: saved.show_rating == 1,
                show_rank: saved.show_rank == 1,
                show_badge_label: saved.show_badge_label == 1,
                highlight_top: saved.highlight_top == 1,
                show_response_count: saved.show_response_count == 1
            };
            console.log('Updated local settings:', _speakerDisplaySettings);

            // Apply responses badge + total/expected participants visibility
            applyResponseCountVisibility();

            // Re-render speakers with new settings
            if (Object.keys(_cachedSpeakersByDay).length > 0) {
                updateResourceSpeakersByDay(_cachedSpeakersByDay);
            } else if (_cachedSpeakers.length > 0) {
                updateResourceSpeakers(_cachedSpeakers);
            }

            closeSpeakerSettingsModal();
        } else {
            alert(json.message || 'Failed to save settings');
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Settings';
            }
        }
    } catch (e) {
        console.error('Error saving speaker settings:', e);
        alert('Failed to save settings. Please try again.');
        const saveBtn = document.querySelector('.speaker-settings-btn-save');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Settings';
        }
    }
}

// ─── Back-button / bfcache guard ─────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});