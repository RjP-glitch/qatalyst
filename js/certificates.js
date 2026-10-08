// ═══════════════════════════════════════════════════════════════════════════════
// certificates.js — Workshops-first grid, then participants on click
// ═══════════════════════════════════════════════════════════════════════════════

const API = CONFIG.API_URL + '/certificates_api.php';

// ── Auth fetch helper ─────────────────────────────────────────────────────────────
function authFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        credentials: 'include'
    });
}

// Legacy helper for backward compatibility - just passes through headers
function authHeaders(extra = {}) {
    return extra;
}

// Ensures session cookie is always sent — replaces all bare fetch() calls
function apiFetch(url, options = {}) {
    return fetch(url, { ...options, credentials: 'include' });
}

// ── State ──────────────────────────────────────────────────────────────────────
let expandedMenus = {};
let allParticipants = [];
let emailStatusMap = {};
let emailSentAtMap = {};  // participant id → sent timestamp string
let allFiles = [];
let participantRoles = [];
let currentWorkshop = null;   // { id, title, ... }
let allWorkshops = [];

// ── Workshops grid pagination state ─────────────────────────────────────────
let wgCurrentPage = 1;
const WG_PAGE_SIZE = 12; // cards per page
let pendingFiles = [];      // files staged in the upload modal
let selectedFileId = null;
let selectedBulkFileId = null; // fallback cert file for bulk send
let selectedFileIds = new Set(); // for multi-delete

// ── Navigation ──────────────────────────────────────────────────────────────────
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
		certificates: 'certificate.html#generator',
		// Splitter is now the same page — switch to the splitter tab instead of navigating
		certificatesplitter: null,
		checklist: 'checklist.html',
		documentssubmittedall: 'documents-submitted-all.html',
		settings: 'main-settings.html',
		users: 'user-management.html',
		directory: 'directory.html',
		auditlogs: 'audit-logs.html',
		announcements: 'announcements.html'
	};
	if (sectionName === 'certificatesplitter') {
		closeMobileSidebar();
		// If switchPageTab exists (merged page), call it directly; otherwise navigate to splitter hash
		if (typeof switchPageTab === 'function') {
			switchPageTab('splitter');
		} else {
			window.location.href = 'certificate.html#splitter';
		}
		return;
	}
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

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    if (!(await checkAuthentication())) return;
    loadWorkshopsGrid();
});


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res = await authFetch(`${CONFIG.API_URL}/main-settings.php`);
        if (!res.ok) {
            clearSessionAndRedirect();
            return false;
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
            if (!Permissions.check('certificates')) return false;
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
                avatar.innerHTML = `<img src="${json.data.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
            }
        } else {
            loadProfilePicture();
        }

        return true;
    } catch (e) {
        console.warn('Session validation network error:', e);

        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('certificates')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadProfilePicture();
        return true;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
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

async function loadProfilePicture() {
    try {
        const res = await authFetch(`${CONFIG.API_URL}/main-settings.php`);
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            document.getElementById('sidebarAvatar').innerHTML =
                `<img src="${json.data.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        }
    } catch (e) { }
}

async function logout() {
    try {
        await authFetch(`${CONFIG.API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { }
    clearSessionAndRedirect();
}


// ═══════════════════════════════════════════════════════════════════════════════
// WORKSHOPS GRID  (the new landing view)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadWorkshopsGrid() {
    showView('workshops');
    wgCurrentPage = 1;
    const grid = document.getElementById('workshopsGrid');
    grid.innerHTML = `<div class="wg-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading programs…</div>`;

    try {
        const res = await authFetch(`${API}?action=get_workshops`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');

        allWorkshops = data.data || [];

        if (!allWorkshops.length) {
            grid.innerHTML = `<div class="wg-empty"><i class="fa-solid fa-calendar-xmark"></i><p>No programs found.</p></div>`;
            renderWgPagination(0, 1);
            return;
        }

        renderWorkshopsGridPage();

    } catch (err) {
        grid.innerHTML = `<div class="wg-empty" style="color:#dc2626;"><i class="fa-solid fa-circle-exclamation"></i><p>${esc(err.message)}</p></div>`;
        renderWgPagination(0, 1);
    }
}

// Filters allWorkshops against the #wgSearch box, paginates the result, and
// renders both the current page of cards and the pagination controls below.
// Called on initial load, on search input, and when navigating pages.
function renderWorkshopsGridPage() {
    const grid = document.getElementById('workshopsGrid');
    const q = (document.getElementById('wgSearch')?.value || '').toLowerCase();

    const filtered = !q ? allWorkshops : allWorkshops.filter(w =>
        w.title.toLowerCase().includes(q) ||
        (w.division_memo || '').toLowerCase().includes(q) ||
        (w.venue || '').toLowerCase().includes(q)
    );

    if (!filtered.length) {
        grid.innerHTML = q
            ? `<div class="wg-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No programs match "<strong>${esc(q)}</strong>".</p></div>`
            : `<div class="wg-empty"><i class="fa-solid fa-calendar-xmark"></i><p>No programs found.</p></div>`;
        renderWgPagination(0, 1);
        return;
    }

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / WG_PAGE_SIZE));
    if (wgCurrentPage > totalPages) wgCurrentPage = totalPages;
    if (wgCurrentPage < 1) wgCurrentPage = 1;

    const startIdx = (wgCurrentPage - 1) * WG_PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + WG_PAGE_SIZE);

    grid.innerHTML = pageItems.map(w => workshopCard(w)).join('');
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
    renderWorkshopsGridPage(); // clamps against the current filtered count internally
    document.getElementById('workshopsGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function workshopCard(w) {
    const statusCls = { completed: 'wg-status--completed', ongoing: 'wg-status--ongoing', upcoming: 'wg-status--upcoming', cancelled: 'wg-status--cancelled' }[w.status] || '';
    const statusLbl = { completed: '✓ Completed', ongoing: '● Ongoing', upcoming: '○ Upcoming', cancelled: '✕ Cancelled' }[w.status] || w.status;

    const start = w.start_date ? new Date(w.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const end = w.end_date ? new Date(w.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const dates = w.start_date === w.end_date ? start : `${start} – ${end}`;

    // Build per-day participant breakdown
    const dayCounts = w.day_counts || [];
    let participantLine = '';
    if (dayCounts.length > 1) {
        // Multi-day: show each day on its own chip
        const chips = dayCounts.map(d => {
            const label = d.day_label
                ? esc(d.day_label)                          // orphan: uses day_sheet text
                : `Day ${d.day_number}`;                    // real workshop: uses day_number
            return `<span class="wg-day-chip"><strong>${label}:</strong> ${d.count}</span>`;
        }).join('');
        participantLine = `<div class="wg-day-counts">${chips}</div>`;
    } else {
        // Single-day or no breakdown: show total only
        const total = dayCounts.length === 1 ? dayCounts[0].count : (w.total_participants || '—');
        participantLine = `<span class="wg-card-participants"><i class="fa-solid fa-users"></i> ${total} participants</span>`;
    }

    return `<div class="wg-card" onclick="selectWorkshop('${w.id}')">
        <div class="wg-card-top">
            <span class="wg-status ${statusCls}">${statusLbl}</span>
            <span class="wg-days">${w.total_days} day${w.total_days > 1 ? 's' : ''}</span>
        </div>
        <div class="wg-card-memo">${esc(w.division_memo || '—')}</div>
        <div class="wg-card-title">${esc(w.title)}</div>
        <div class="wg-card-meta">
            <span><i class="fa-solid fa-calendar-days"></i> ${dates}</span>
            ${w.venue ? `<span><i class="fa-solid fa-location-dot"></i> ${esc(w.venue)}</span>` : ''}
        </div>
        <div class="wg-card-footer">
            ${participantLine}
            <span class="wg-card-arrow"><i class="fa-solid fa-arrow-right"></i> View</span>
        </div>
    </div>`;
}

async function selectWorkshop(id) {
    currentWorkshop = allWorkshops.find(w => w.id == id);
    if (!currentWorkshop) return;

    showView('participants');
    renderWorkshopHeader();
    setStats('—', '—', '—', '—');

    await Promise.all([
        loadParticipants(),
        loadFiles(),
        loadEmailStatus()
    ]);
    updateStats();
}

function renderWorkshopHeader() {
    const w = currentWorkshop;
    const start = w.start_date ? new Date(w.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const end = w.end_date ? new Date(w.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const dates = (w.start_date === w.end_date || !w.end_date) ? start : `${start} – ${end}`;
    const statusCls = { completed: 'ws-pill--completed', ongoing: 'ws-pill--ongoing', upcoming: 'ws-pill--upcoming', cancelled: 'ws-pill--cancelled' }[w.status] || '';

    document.getElementById('wsTitle').textContent = w.title;
    document.getElementById('wsMemo').textContent = w.division_memo || '';
    document.getElementById('wsDates').textContent = dates + (w.venue ? ` · ${w.venue}` : '');
    const statusEl = document.getElementById('wsStatus');
    statusEl.classList.remove('ws-pill--completed', 'ws-pill--ongoing', 'ws-pill--upcoming', 'ws-pill--cancelled');
    if (statusCls) statusEl.classList.add(statusCls);
    statusEl.textContent = w.status.charAt(0).toUpperCase() + w.status.slice(1);
}

function goBackToWorkshops() {
    currentWorkshop = null;
    allParticipants = [];
    emailStatusMap = {};
    emailSentAtMap = {};
    allFiles = [];
    loadWorkshopsGrid();
}

// ── View switcher ──────────────────────────────────────────────────────────────
function showView(view) {
    document.getElementById('viewWorkshops').style.display = view === 'workshops' ? '' : 'none';
    document.getElementById('viewParticipants').style.display = view === 'participants' ? '' : 'none';
}


// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANTS
// ═══════════════════════════════════════════════════════════════════════════════
async function loadParticipants() {
    if (!currentWorkshop) return;
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:#9ca3af;"><i class="fa-solid fa-spinner fa-spin"></i> Loading participants…</td></tr>`;
    document.getElementById('emptyState').style.display = 'none';

    try {
        const res = await apiFetch(`${API}?action=get_participants&workshop_id=${currentWorkshop.id}`, {
            headers: authHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');

        allParticipants = data.data || [];
        renderTable();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:#dc2626;">${esc(err.message)}</td></tr>`;
    }
}

async function loadEmailStatus() {
    if (!currentWorkshop) return;
    try {
        const res = await apiFetch(`${API}?action=get_email_status&workshop_id=${currentWorkshop.id}`, {
            headers: authHeaders()
        });
        const data = await res.json();
        if (data.success) {
            // Normalise: API now returns { id: { status, email_sent_at } }
            // Keep backward compat — emailStatusMap[id] = 'sent'|'pending'
            // Store timestamps separately for tooltip display
            const raw = data.data || {};
            emailStatusMap = {};
            emailSentAtMap = {};
            Object.entries(raw).forEach(([id, val]) => {
                if (typeof val === 'object') {
                    emailStatusMap[id] = val.status;
                    if (val.email_sent_at) emailSentAtMap[id] = val.email_sent_at;
                } else {
                    emailStatusMap[id] = val; // legacy string format
                }
            });
            renderTable();
        }
    } catch (e) { }
}

function updateStats() {
    const total = allParticipants.length;
    const sent = Object.values(emailStatusMap).filter(v => v === 'sent').length;
    // Only count participants with an email address AND a known name as pending
    const pending = allParticipants.filter(p => p.email && p.full_name && p.full_name.trim().toLowerCase() !== 'unknown' && (emailStatusMap[p.id] || 'pending') === 'pending').length;

    // Build a Set of valid file IDs from allFiles for defensive cert validation
    const validFileIds = new Set(allFiles.map(f => String(f.id)));

    // Ready = has a cert linked to a file that still exists AND email not sent yet AND has an email address AND known name
    const ready = allParticipants.filter(p =>
        p.cert_file_id && validFileIds.has(String(p.cert_file_id)) &&
        (emailStatusMap[p.id] || 'pending') === 'pending' && p.email &&
        p.full_name && p.full_name.trim().toLowerCase() !== 'unknown'
    ).length;

    // Missing = no cert linked, or cert points to a deleted file
    const missing = allParticipants.filter(p =>
        !p.cert_file_id || !validFileIds.has(String(p.cert_file_id))
    ).length;

    setStats(total, sent, pending, allFiles.length, ready, missing);
}

function setStats(total, sent, pending, files, ready, missing) {
    document.getElementById('statTotal').textContent = total;
    document.getElementById('statSent').textContent = sent;
    document.getElementById('statPending').textContent = pending;
    document.getElementById('statFiles').textContent = files;

    if (document.getElementById('statReady')) {
        document.getElementById('statReady').textContent = ready ?? '—';
        const readySub = document.getElementById('statReadySub');
        if (readySub) {
            readySub.textContent = ready > 0
                ? `${ready} with cert & email`
                : 'None ready yet';
        }
    }

    if (document.getElementById('statMissing')) {
        document.getElementById('statMissing').textContent = missing ?? '—';
        const missingSub = document.getElementById('statMissingSub');
        if (missingSub) {
            missingSub.textContent = missing === 0
                ? 'All certs linked ✓'
                : `${missing} need certificate`;
        }
    }
}

function renderTable() {
    const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const gender = document.getElementById('genderFilter')?.value || '';
    const status = document.getElementById('statusFilter')?.value || '';

    const filtered = allParticipants.filter(p => {
        const emailSt = emailStatusMap[p.id] || 'pending';
        const matchQ = !q || p.full_name.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q) || (p.designation || '').toLowerCase().includes(q);
        const matchG = !gender || p.sex === gender;
        const matchS = !status || emailSt === status;
        return matchQ && matchG && matchS;
    });

    const tbody = document.getElementById('tableBody');
    const empty = document.getElementById('emptyState');

    if (!filtered.length) {
        tbody.innerHTML = '';
        empty.style.display = '';
        document.getElementById('emptyStateMsg').textContent = allParticipants.length
            ? 'No participants match your filters.'
            : 'No participants yet. Click "Add Recipient" to add someone.';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = filtered.map((p, i) => {
        const emailSt = emailStatusMap[p.id] || 'pending';
        const isSent = emailSt === 'sent';
        const sentAt = emailSentAtMap[p.id]
            ? new Date(emailSentAtMap[p.id]).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
            : null;
        const sentBadge = isSent
            ? `<span class="badge badge-green" title="${sentAt ? 'Sent on ' + sentAt : 'Sent'}"><i class="fa-solid fa-check"></i> Sent${sentAt ? `<span style="font-size:10px;opacity:.75;margin-left:4px;">${sentAt}</span>` : ''}</span>`
            : `<span class="badge badge-gray">Pending</span>`;
        const emailDisplay = p.email
            ? `<a href="mailto:${esc(p.email)}" style="color:#1e40af;text-decoration:none;">${esc(p.email)}</a>`
            : `<span style="color:#9ca3af;font-size:11px;">—</span>`;

        const sexRaw = (p.sex || '').trim();
        const sexDisplay = sexRaw === 'Other' ? 'Prefer not to say' : (sexRaw || '—');
        const sexBadgeClass = sexRaw === 'Female'
            ? 'badge-purple'
            : (sexRaw === 'Male' ? 'badge-blue' : 'badge-gray');

        const certBadge = p.cert_file_id
            ? `<span class="badge badge-orange" title="Certificate saved — will auto-attach on bulk send"><i class="fa-solid fa-file-pdf"></i> Cert</span>`
            : `<span class="badge badge-gray" title="No certificate linked yet"><i class="fa-solid fa-file-pdf"></i> —</span>`;

        // Disable sending if email is missing OR name is unknown/blank
        const isUnknownName = !p.full_name || p.full_name.trim().toLowerCase() === 'unknown';
        const canSend = p.email && !isUnknownName;

        // Show Resend button for already-sent participants (e.g. full inbox / bounce reported)
        const resendTitle = sentAt
            ? `Resend Certificate — last sent ${sentAt}`
            : 'Resend Certificate (inbox full or bounced)';
        const sendDisabledTitle = isUnknownName
            ? 'Cannot send — recipient name is unknown'
            : 'Cannot send — no email address';
        const sendBtn = isSent
            ? `<button class="action-btn resend" title="${canSend ? resendTitle : sendDisabledTitle}" onclick="${canSend ? `openResendEmail(${p.id})` : ''}" ${!canSend ? 'disabled' : ''}>
                    <i class="fa-solid fa-rotate-right"></i>
               </button>`
            : `<button class="action-btn send" title="${canSend ? 'Send Certificate' : sendDisabledTitle}" onclick="${canSend ? `openSendEmail(${p.id})` : ''}" ${!canSend ? 'disabled' : ''}>
                    <i class="fa-solid fa-envelope"></i>
               </button>`;

        return `<tr>
            <td style="color:#9ca3af;font-size:12px;">${i + 1}</td>
            <td><strong style="font-size:13px;">${esc(p.full_name)}</strong></td>
            <td>${emailDisplay}</td>
            <td><span class="badge ${sexBadgeClass}">${esc(sexDisplay)}</span></td>
            <td style="font-size:12px;color:#6b7280;">${esc(p.participant_type || '—')}</td>
            <td style="font-size:13px;">${esc(p.designation || '—')}</td>
            <td style="font-size:12px;color:#6b7280;">${esc(p.school_office || '—')}</td>
            <td>${certBadge}</td>
            <td>${sentBadge}</td>
            <td>
                <div class="action-btns" style="justify-content:center;">
                    ${sendBtn}
                    <button class="action-btn" title="Edit" onclick="openEditModal(${p.id})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="action-btn del" title="Delete" onclick="deleteParticipant(${p.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function filterTable() { renderTable(); }


// ═══════════════════════════════════════════════════════════════════════════════
// ROLES
// ═══════════════════════════════════════════════════════════════════════════════
async function loadRoles() {
    try {
        const res = await apiFetch(`${API}?action=get_participant_roles`, {
            headers: authHeaders()
        });
        const data = await res.json();
        if (data.success) {
            participantRoles = data.data || [];
            const sel = document.getElementById('newType');
            sel.innerHTML = '<option value="">— Select Type —</option>'
                + participantRoles.map(r => `<option value="${esc(r.role_name)}">${esc(r.role_name)}</option>`).join('');
        }
    } catch (e) { }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ADD / EDIT RECIPIENT
// ═══════════════════════════════════════════════════════════════════════════════
function openAddModal() {
    if (!currentWorkshop) { showToast('Select a program first', 'warning'); return; }
    document.getElementById('modalTitle').textContent = 'Add Recipient';
    document.getElementById('editId').value = '';
    ['newName', 'newPos', 'newEmail', 'newSchool'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('newGender').value = 'Female';
    openModal('addModal');
}

function openEditModal(id) {
    const p = allParticipants.find(x => x.id === id);
    if (!p) return;
    document.getElementById('modalTitle').textContent = 'Edit Recipient';
    document.getElementById('editId').value = p.id;
    document.getElementById('newName').value = p.full_name;
    document.getElementById('newPos').value = p.designation || '';
    document.getElementById('newEmail').value = p.email || '';
    document.getElementById('newSchool').value = p.school_office || '';
    document.getElementById('newGender').value = p.sex || 'Other';
    openModal('addModal');
}

async function saveRecipient() {
    const id = document.getElementById('editId').value;
    const name = document.getElementById('newName').value.trim();
    const pos = document.getElementById('newPos').value.trim();
    if (!name || !pos) { showToast('Name and designation are required', 'warning'); return; }

    const body = {
        workshop_id: currentWorkshop.id,
        full_name: name,
        sex: document.getElementById('newGender').value,
        designation: pos,
        email: document.getElementById('newEmail').value.trim(),
        school_office: document.getElementById('newSchool').value.trim(),
    };

    try {
        const action = id ? 'update_participant' : 'add_participant';
        if (id) body.id = parseInt(id);
        const res = await apiFetch(`${API}?action=${action}`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        showToast(data.message || 'Saved!', 'success');
        closeModal('addModal');
        await loadParticipants();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteParticipant(id) {
    const p = allParticipants.find(x => x.id === id);
    if (!confirm(`Delete ${p?.full_name || 'this participant'}? This cannot be undone.`)) return;
    try {
        const res = await apiFetch(`${API}?action=delete_participant`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        showToast('Participant removed', 'success');
        await loadParticipants();
    } catch (err) { showToast(err.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// CSV IMPORT
// ═══════════════════════════════════════════════════════════════════════════════
function importCSV(e) {
    const file = e.target.files[0];
    if (!file || !currentWorkshop) return;
    const reader = new FileReader();
    reader.onload = async ev => {
        const lines = ev.target.result.split('\n').filter(l => l.trim());
        const rows = lines.map(line => {
            const [full_name, designation, sex, email, participant_type, school_office] = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
            return { full_name, designation, sex, email, participant_type, school_office };
        }).filter(r => r.full_name && r.designation);

        if (!rows.length) { showToast('No valid rows found in CSV', 'warning'); return; }

        try {
            const res = await apiFetch(`${API}?action=import_csv`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ workshop_id: currentWorkshop.id, rows })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed');
            showToast(`Imported ${data.added} participant(s)`, 'success');
            closeModal('addModal');
            await loadParticipants();
        } catch (err) { showToast(err.message, 'error'); }
    };
    reader.readAsText(file);
    e.target.value = '';
}


// ═══════════════════════════════════════════════════════════════════════════════
// SEND EMAIL — SINGLE
// ═══════════════════════════════════════════════════════════════════════════════
function openSendEmail(id) {
    const p = allParticipants.find(x => parseInt(x.id) === parseInt(id));
    if (!p) return;

    document.getElementById('se-recipientName').value = p.full_name;
    document.getElementById('se-email').value = p.email || '';
    document.getElementById('se-subject').value = 'Your Certificate of Participation';
    document.getElementById('se-body').value =
        `Dear ${p.full_name},

Congratulations! Please find attached your Certificate of Participation.

Thank you for your active participation and dedication.

Best regards,
SDO SMME Baliwag`;

    document.getElementById('se-file-id').value = '';
    document.getElementById('se-file-display').innerHTML =
        `<span class="file-selection-none"><i class="fa-solid fa-paperclip"></i> No file attached</span>`;

    // Auto-attach the participant's linked certificate if one exists
    if (p.cert_file_id) {
        const certFile = allFiles.find(f => f.id === p.cert_file_id);
        if (certFile) {
            document.getElementById('se-file-id').value = certFile.id;
            document.getElementById('se-file-display').innerHTML =
                `<div class="file-selection-chosen">
                    <span style="font-size:18px;">📎</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(certFile.file_name)}</div>
                        <div style="font-size:11px;color:#16a34a;margin-top:2px;"><i class="fa-solid fa-check"></i> Auto-attached from splitter</div>
                    </div>
                    <button onclick="clearFileSelection()" style="border:none;background:#fee2e2;color:#dc2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:700;">Remove</button>
                </div>`;
        } else {
            // cert_file_id is stale (file was deleted or re-uploaded) — try matching by name
            autoAttachByName(p);
        }
    } else {
        // No cert_file_id — try matching by name as a best-effort fallback
        autoAttachByName(p);
    }

    document.getElementById('sendEmailModal').dataset.participantId = parseInt(id);

    // Reset to compose tab
    document.querySelectorAll('#sendEmailModal .tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('#sendEmailModal .tab-pane').forEach((p, i) => p.classList.toggle('active', i === 0));

    openModal('sendEmailModal');
}

// ── Name-based cert auto-attach fallback ──────────────────────────────────────
// Called when cert_file_id is null or points to a deleted/stale file.
// Tries to find a matching cert in allFiles by comparing normalised names.
function autoAttachByName(p) {
    if (!allFiles.length) return;
    const normName = p.full_name.toUpperCase()
        .replace(/[^A-Z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const nameParts = normName.split(' ').filter(Boolean);
    if (nameParts.length < 2) return;

    const matched = allFiles.find(f => {
        if (f.file_type !== 'cert') return false;
        const normFile = f.file_name.replace(/\.pdf$/i, '').toUpperCase()
            .replace(/[^A-Z\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const fileParts = normFile.split(' ').filter(Boolean);
        const [shorter, longer] = nameParts.length <= fileParts.length
            ? [nameParts, fileParts] : [fileParts, nameParts];
        return shorter.every(tok =>
            longer.some(lt => lt.startsWith(tok) || tok.startsWith(lt))
        );
    });

    if (!matched) return;
    document.getElementById('se-file-id').value = matched.id;
    document.getElementById('se-file-display').innerHTML =
        `<div class="file-selection-chosen">
            <span style="font-size:18px;">📎</span>
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(matched.file_name)}</div>
                <div style="font-size:11px;color:#d97706;margin-top:2px;"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-matched by name</div>
            </div>
            <button onclick="clearFileSelection()" style="border:none;background:#fee2e2;color:#dc2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:700;">Remove</button>
        </div>`;
}

// Opens the send modal pre-filled for a participant whose email was already sent
// (use case: full inbox, bounce, or participant reports not receiving)
function openResendEmail(id) {
    openSendEmail(id); // reuse the same modal setup

    // Override the modal title and note to make it clear this is a resend
    const titleEl = document.querySelector('#sendEmailModal .modal-title');
    if (titleEl) {
        titleEl.innerHTML = '<i class="fa-solid fa-rotate-right" style="color:#d97706;"></i> Resend Certificate'
            + '<span style="font-size:11px;font-weight:400;color:#9ca3af;margin-left:8px;">'
            + '— this participant was already marked as sent</span>';
    }

    // Flag the modal so sendSingleEmail knows to force-reset the sent status
    document.getElementById('sendEmailModal').dataset.forceResend = '1';
}

async function sendSingleEmail() {
    const id = parseInt(document.getElementById('sendEmailModal').dataset.participantId);
    const email = document.getElementById('se-email').value.trim();
    const subject = document.getElementById('se-subject').value.trim();
    const message = document.getElementById('se-body').value.trim();
    const fileId = parseInt(document.getElementById('se-file-id').value) || 0;

    if (!email) { showToast('Email address is required', 'warning'); return; }
    if (!subject) { showToast('Subject is required', 'warning'); return; }

    const isResend = document.getElementById('sendEmailModal').dataset.forceResend === '1';
    document.getElementById('sendEmailModal').dataset.forceResend = '';

    closeModal('sendEmailModal');   // ← close first so progress shows on top
    showProgress(isResend ? 'Resending Certificate…' : 'Sending Certificate…');

    try {
        const res = await apiFetch(`${API}?action=send_certificate_email`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ participant_id: id, subject, message, file_id: fileId, force_resend: isResend })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || data.message || 'Failed');
        hideProgress();
        showToast(isResend ? `✓ Resent to ${data.email}` : `✓ Email sent to ${data.email}`, 'success');
        emailStatusMap[id] = 'sent';
        renderTable();
        updateStats();
    } catch (err) {
        hideProgress();
        openModal('sendEmailModal');   // ← reopen modal if it failed so user can retry
        showToast(err.message, 'error');
    }
}

function buildPreview() {
    const name = document.getElementById('se-recipientName').value;
    const email = document.getElementById('se-email').value;
    const subject = document.getElementById('se-subject').value;
    const body = document.getElementById('se-body').value.replace(/\n/g, '<br>');
    document.getElementById('se-preview').innerHTML =
        `<strong>To:</strong> ${esc(name)} &lt;${esc(email)}&gt;<br>
         <strong>Subject:</strong> ${esc(subject)}<hr style="margin:10px 0;border-color:#e2e8f0;">
         ${body}`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// BULK SEND
// ═══════════════════════════════════════════════════════════════════════════════
function openBulkSend() {
    if (!currentWorkshop) { showToast('Select a program first', 'warning'); return; }
    const withEmail = allParticipants.filter(p => p.email && p.full_name && p.full_name.trim().toLowerCase() !== 'unknown' && (emailStatusMap[p.id] || 'pending') === 'pending');
    const withCert = withEmail.filter(p => p.cert_file_id);
    const noCert = withEmail.filter(p => !p.cert_file_id);

    document.getElementById('bulk-count-label').textContent =
        `${withEmail.length} pending recipient(s) with email`;

    // Show cert coverage warning
    const warnEl = document.getElementById('bulk-cert-warning');
    if (warnEl) {
        if (noCert.length > 0) {
            warnEl.style.display = '';
            warnEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> `
                + `<strong>${noCert.length}</strong> recipient(s) have no linked certificate — `
                + `run the <strong>Certificate Splitter</strong> first, or pick a fallback file below.`;
        } else {
            warnEl.style.display = '';
            warnEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#16a34a"></i> `
                + `All ${withCert.length} recipient(s) have individual certificates ready.`;
        }
    }

    // Reset fallback file picker
    selectedBulkFileId = null;
    const bulkFileDisplay = document.getElementById('bulk-file-display');
    if (bulkFileDisplay) bulkFileDisplay.innerHTML =
        `<span style="color:#9ca3af;font-size:12px;"><i class="fa-solid fa-paperclip"></i> No fallback file — each person gets their own cert</span>`;

    document.getElementById('bulkLog').innerHTML =
        `<div class="log-line log-info">Ready to send to ${withEmail.length} recipient(s). Click "Send to All" to begin.</div>`;
    openModal('bulkSendModal');
}

async function executeBulkSend() {
    if (!currentWorkshop) return;
    const subject = document.getElementById('bulk-subject').value.trim();
    const message = document.getElementById('bulk-body').value.trim();
    const log = document.getElementById('bulkLog');

    // Guard: check cert coverage before allowing send
    const withEmail = allParticipants.filter(p => p.email && p.full_name && p.full_name.trim().toLowerCase() !== 'unknown' && (emailStatusMap[p.id] || 'pending') === 'pending');
    const noCert = withEmail.filter(p => !p.cert_file_id);

    if (noCert.length > 0 && !selectedBulkFileId) {
        const names = noCert.slice(0, 5).map(p => `• ${p.full_name}`).join('\n');
        const more = noCert.length > 5 ? `\n  …and ${noCert.length - 5} more` : '';

        if (noCert.length === withEmail.length) {
            // ALL recipients have no cert — hard block
            alert(
                `🚫 Cannot send — no certificates are linked to any recipient.\n\n` +
                `${noCert.length} recipient(s) have no certificate:\n${names}${more}\n\n` +
                `Please run the Certificate Splitter first, or choose a Fallback Certificate file before sending.`
            );
            return;
        }

        // PARTIAL — some have certs, some don't — confirm before proceeding
        // Note: recipients without a cert will be SKIPPED entirely (not sent to without attachment)
        const withCert = withEmail.length - noCert.length;
        const proceed = confirm(
            `⚠️ ${noCert.length} of ${withEmail.length} recipient(s) have no certificate linked:\n\n${names}${more}\n\n` +
            `No fallback file is selected.\n` +
            `These ${noCert.length} recipient(s) will be SKIPPED — they will NOT receive any email.\n\n` +
            `Only the ${withCert} recipient(s) with a linked certificate will be sent to.\n\n` +
            `Do you want to proceed?`
        );
        if (!proceed) return;
    }

    log.innerHTML = '<div class="log-line log-info">⏳ Starting bulk send…</div>';

    showProgress('Sending Certificates…');

    try {
        const res = await apiFetch(`${API}?action=bulk_send_certificate_email`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ workshop_id: currentWorkshop.id, subject, message, file_id: selectedBulkFileId || 0 })
        });
        const data = await res.json();

        hideProgress();

        if (!data.success) throw new Error(data.error || 'Failed');

        let logHtml = '';
        (data.results || []).forEach(r => {
            if (r.status === 'sent') {
                emailStatusMap[r.id] = 'sent';
                const attachNote = r.attached
                    ? `<span style="color:#16a34a;font-size:11px;margin-left:6px;"><i class="fa-solid fa-paperclip"></i> cert attached</span>`
                    : `<span style="color:#f59e0b;font-size:11px;margin-left:6px;"><i class="fa-solid fa-triangle-exclamation"></i> sent WITHOUT certificate</span>`;
                logHtml += `<div class="log-line log-ok">✓ ${esc(r.name)} &lt;${esc(r.email)}&gt;${attachNote}</div>`;
            } else if (r.status === 'skipped') {
                const reasonLabel = r.reason === 'no_certificate' ? 'no certificate linked'
                    : r.reason === 'invalid_email' ? 'invalid email'
                    : (r.reason || 'skipped');
                logHtml += `<div class="log-line log-warn">⚠ ${esc(r.name)} — skipped (${reasonLabel})</div>`;
            } else {
                logHtml += `<div class="log-line log-err">✗ ${esc(r.name)} — failed</div>`;
            }
        });
        logHtml += `<div class="log-line log-info" style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:8px;">
            Done: ${data.sent} sent, ${data.failed || 0} failed, ${data.skipped || 0} skipped</div>`;

        log.innerHTML = logHtml;
        renderTable();
        updateStats();
        showToast(`✓ Sent: ${data.sent}, Failed: ${data.failed || 0}, Skipped: ${data.skipped || 0}`, 'success');

    } catch (err) {
        hideProgress();
        log.innerHTML += `<div class="log-line log-err">Error: ${esc(err.message)}</div>`;
        showToast(err.message, 'error');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// FILES
// ═══════════════════════════════════════════════════════════════════════════════
async function loadFiles() {
    if (!currentWorkshop) return;
    try {
        const res = await apiFetch(`${API}?action=get_files&workshop_id=${currentWorkshop.id}`, {
            headers: authHeaders()
        });
        const data = await res.json();
        if (data.success) {
            allFiles = data.data || [];
            selectedFileIds.clear();
            renderFilesTable();
            updateStats();
            const badge = document.getElementById('filesCountBadge');
            if (badge) {
                badge.textContent = allFiles.length;
                badge.style.display = allFiles.length ? 'inline-flex' : 'none';
            }
        }
    } catch (e) { }
}

function renderFilesTable() {
    const q = (document.getElementById('fileSearchInput')?.value || '').toLowerCase();
    const ftype = document.getElementById('fileTypeFilter')?.value || '';
    const files = allFiles.filter(f =>
        (!q || f.file_name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q)) &&
        (!ftype || f.file_type === ftype)
    );
    const tbody = document.getElementById('filesTableBody');
    const empty = document.getElementById('filesEmptyState');
    if (!files.length) {
        tbody.innerHTML = '';
        empty.style.display = '';
        updateBulkDeleteBar();
        return;
    }
    empty.style.display = 'none';
    tbody.innerHTML = files.map((f, i) => {
        const ext = f.file_name.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? '📄' : ext === 'xlsx' || ext === 'xls' ? '📊' : ext === 'docx' ? '📝' : '📁';
        const typeLabel = { cert: 'Certificate', qame: 'QAME Report', eval: 'Eval Report', other: 'Other' }[f.file_type] || f.file_type;
        const typeCls = { cert: 'badge-orange', qame: 'badge-green', eval: 'badge-blue', other: 'badge-gray' }[f.file_type] || 'badge-gray';
        const uploaded = new Date(f.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const checked = selectedFileIds.has(f.id) ? 'checked' : '';
        return `<tr>
            <td style="text-align:center;">
                <input type="checkbox" class="file-checkbox" data-id="${f.id}" ${checked}
                    onchange="toggleFileSelection(${f.id}, this.checked)"
                    style="width:16px;height:16px;cursor:pointer;accent-color:#1e3a8a;">
            </td>
            <td style="color:#9ca3af;font-size:12px;">${i + 1}</td>
            <td><span style="font-size:16px;margin-right:6px;">${icon}</span><strong style="font-size:13px;">${esc(f.file_name)}</strong></td>
            <td><span class="badge ${typeCls}">${typeLabel}</span></td>
            <td style="font-size:12px;">${esc(f.day_session || '—')}</td>
            <td style="font-size:12px;color:#6b7280;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.description || '—')}</td>
            <td style="font-size:12px;color:#9ca3af;">${esc(f.file_size || '—')}</td>
            <td style="font-size:12px;color:#9ca3af;">${uploaded}</td>
            <td style="text-align:center;">
                <div class="action-btns" style="justify-content:center;">
                    <a class="action-btn" title="Download" href="#" onclick="downloadFile(${f.id}, '${esc(f.file_name).replace(/'/g, "\\'")}'); return false;">
                        <i class="fa-solid fa-download"></i>
                    </a>
                    <button class="action-btn del" title="Delete" onclick="deleteFile(${f.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
    updateBulkDeleteBar();
}

function toggleFileSelection(id, checked) {
    if (checked) selectedFileIds.add(id);
    else selectedFileIds.delete(id);
    updateSelectAllCheckbox();
    updateBulkDeleteBar();
}

function toggleSelectAllFiles(checked) {
    const q = (document.getElementById('fileSearchInput')?.value || '').toLowerCase();
    const ftype = document.getElementById('fileTypeFilter')?.value || '';
    const visibleFiles = allFiles.filter(f =>
        (!q || f.file_name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q)) &&
        (!ftype || f.file_type === ftype)
    );
    visibleFiles.forEach(f => {
        if (checked) selectedFileIds.add(f.id);
        else selectedFileIds.delete(f.id);
    });
    document.querySelectorAll('.file-checkbox').forEach(cb => cb.checked = checked);
    updateBulkDeleteBar();
}

function updateSelectAllCheckbox() {
    const cbs = document.querySelectorAll('.file-checkbox');
    const selectAllCb = document.getElementById('selectAllFilesCheckbox');
    if (!selectAllCb || !cbs.length) return;
    const allChecked = [...cbs].every(cb => cb.checked);
    const someChecked = [...cbs].some(cb => cb.checked);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = someChecked && !allChecked;
}

function updateBulkDeleteBar() {
    const bar = document.getElementById('bulkDeleteBar');
    if (!bar) return;
    const count = selectedFileIds.size;
    if (count > 0) {
        bar.style.display = 'flex';
        const label = bar.querySelector('#bulkDeleteCount');
        if (label) label.textContent = `${count} file${count > 1 ? 's' : ''} selected`;
    } else {
        bar.style.display = 'none';
    }
}

async function deleteSelectedFiles() {
    const ids = [...selectedFileIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected file${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
        for (const id of ids) {
            const res = await apiFetch(`${API}?action=delete_file`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed');
        }
        selectedFileIds.clear();
        showToast(`${ids.length} file${ids.length > 1 ? 's' : ''} deleted`, 'success');
        await loadFiles();
    } catch (err) { showToast(err.message, 'error'); }
}

function filterFiles() { renderFilesTable(); }

async function deleteFile(id) {
    if (!confirm('Delete this file? This cannot be undone.')) return;
    try {
        const res = await apiFetch(`${API}?action=delete_file`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        showToast('File deleted', 'success');
        await loadFiles();
    } catch (err) { showToast(err.message, 'error'); }
}

// ── Upload ─────────────────────────────────────────────────────────────────────
function handleDragOver(e) { e.preventDefault(); document.getElementById('uploadZone').classList.add('drag-over'); }
function handleDragLeave(e) { document.getElementById('uploadZone').classList.remove('drag-over'); }
function handleDrop(e) {
    e.preventDefault();
    document.getElementById('uploadZone').classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addPendingFiles(files);
}
function handleFileSelect(e) {
    addPendingFiles(Array.from(e.target.files));
    e.target.value = '';
}
function addPendingFiles(files) {
    pendingFiles = [...pendingFiles, ...files];
    renderPendingFiles();
}
function renderPendingFiles() {
    const preview = document.getElementById('selectedFilesPreview');
    if (!pendingFiles.length) { preview.innerHTML = ''; return; }
    preview.innerHTML = pendingFiles.map((f, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f1f5f9;border-radius:6px;margin-top:6px;font-size:12px;">
            <i class="fa-solid fa-file" style="color:#1e40af;"></i>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</span>
            <span style="color:#9ca3af;">${formatSize(f.size)}</span>
            <button onclick="removePendingFile(${i})" style="border:none;background:none;color:#dc2626;cursor:pointer;padding:2px 4px;font-size:13px;">✕</button>
        </div>`
    ).join('');
}
function removePendingFile(i) { pendingFiles.splice(i, 1); renderPendingFiles(); }
function formatSize(bytes) {
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}

async function confirmUpload() {
    if (!currentWorkshop) { showToast('Select a program first', 'warning'); return; }
    if (!pendingFiles.length) { showToast('Please select a file first', 'warning'); return; }

    const btn = document.getElementById('uploadBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…';

    const type = document.getElementById('uf-type').value;
    const day = document.getElementById('uf-day').value;
    const desc = document.getElementById('uf-desc').value.trim();

    try {
        for (const file of pendingFiles) {
            const fd = new FormData();
            fd.append('workshop_id', currentWorkshop.id);
            fd.append('file_type', type);
            fd.append('day_session', day);
            fd.append('description', desc);
            fd.append('file', file);
            const res = await apiFetch(`${API}?action=upload_file`, {
                method: 'POST',
                headers: authHeaders(),
                body: fd
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Upload failed');
        }
        showToast(`✓ ${pendingFiles.length} file(s) uploaded`, 'success');
        pendingFiles = [];
        renderPendingFiles();
        closeModal('uploadFileModal');
        closeModal('filesModal');      // ← close both
        await loadFiles();
        openModal('filesModal');       // ← reopen files modal on top
    } catch (err) { showToast(err.message, 'error'); }
    finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload';
    }
}


// ── File Picker (for email attachment) ────────────────────────────────────────
function openFilePicker() {
    if (!allFiles.length) { showToast('No files uploaded for this program yet.', 'warning'); return; }
    renderFilePickerList(allFiles);
    openModal('filePickerModal');
}

function renderFilePickerList(files) {
    const list = document.getElementById('filePickerList');
    if (!files.length) {
        list.innerHTML = `<div class="empty-state" style="padding:32px 0;"><div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div><p>No matching files.</p></div>`;
        return;
    }
    list.innerHTML = files.map(f => {
        const ext = f.file_name.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? '📄' : ext === 'xlsx' || ext === 'xls' ? '📊' : ext === 'docx' ? '📝' : '📁';
        const typeLabel = { cert: 'Certificate', qame: 'QAME', eval: 'Eval Report', other: 'Other' }[f.file_type] || f.file_type;
        const isSelected = String(selectedFileId) === String(f.id);
        return `<div class="file-picker-item ${isSelected ? 'selected' : ''}" onclick="pickFile(${f.id}, '${esc(f.file_name).replace(/'/g, "\\'")}')">
            <div class="file-picker-item-icon">${icon}</div>
            <div class="file-picker-item-info">
                <div class="file-picker-item-name">${esc(f.file_name)}</div>
                <div class="file-picker-item-meta">
                    <span class="badge badge-gray" style="font-size:10px;">${typeLabel}</span>
                    <span style="font-size:11px;color:#9ca3af;">${esc(f.day_session || '')}</span>
                    <span style="font-size:11px;color:#9ca3af;">${esc(f.file_size || '')}</span>
                </div>
            </div>
            <div class="file-picker-item-check">
                ${isSelected ? '<i class="fa-solid fa-circle-check" style="color:#16a34a;font-size:18px;"></i>' : '<i class="fa-regular fa-circle" style="color:#d1d5db;font-size:18px;"></i>'}
            </div>
        </div>`;
    }).join('');
}

function pickFile(id, name) {
    const isBulk = document.getElementById('filePickerModal').dataset.bulkMode === '1';
    document.getElementById('filePickerModal').dataset.bulkMode = '';
    if (isBulk) {
        selectedBulkFileId = id;
        const display = document.getElementById('bulk-file-display');
        if (display) display.innerHTML =
            `<div style="display:flex;align-items:center;gap:8px;">
                <i class="fa-solid fa-file-pdf" style="color:#dc2626;"></i>
                <span style="font-size:13px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</span>
                <button onclick="clearBulkFileSelection()" style="border:none;background:#fee2e2;color:#dc2626;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11px;font-weight:700;">Remove</button>
            </div>`;
        closeModal('filePickerModal');
        showToast('Fallback file set for bulk send', 'success');
        return;
    }
    selectedFileId = id;
    document.getElementById('se-file-id').value = id;
    document.getElementById('se-file-display').innerHTML =
        `<div class="file-selection-chosen">
            <span style="font-size:18px;">📎</span>
            <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div></div>
            <button onclick="clearFileSelection()" style="border:none;background:#fee2e2;color:#dc2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:700;">Remove</button>
        </div>`;
    closeModal('filePickerModal');
    showToast('File attached', 'success');
}

function clearBulkFileSelection() {
    selectedBulkFileId = null;
    const display = document.getElementById('bulk-file-display');
    if (display) display.innerHTML =
        `<span style="color:#9ca3af;font-size:12px;"><i class="fa-solid fa-paperclip"></i> No fallback file — each person gets their own cert</span>`;
}

function clearFileSelection() {
    selectedFileId = null;
    document.getElementById('se-file-id').value = '';
    document.getElementById('se-file-display').innerHTML =
        `<span class="file-selection-none"><i class="fa-solid fa-paperclip"></i> No file attached</span>`;
    closeModal('filePickerModal');
}

function openBulkFilePicker() {
    if (!allFiles.length) { showToast('No files uploaded for this program yet.', 'warning'); return; }
    renderFilePickerList(allFiles);
    document.getElementById('filePickerModal').dataset.bulkMode = '1';
    openModal('filePickerModal');
}

function filterFilePicker() {
    const q = document.getElementById('filePickerSearch').value.toLowerCase();
    renderFilePickerList(allFiles.filter(f =>
        f.file_name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q)
    ));
}


// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD FILE (authenticated — sends session cookie)
// ═══════════════════════════════════════════════════════════════════════════════
async function downloadFile(id, name) {
    try {
        const res = await apiFetch(`${API}?action=download_file&id=${id}`);
        if (!res.ok) { showToast('Download failed', 'error'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name || 'download';
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        showToast('Download error: ' + e.message, 'error');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT CSV
// ═══════════════════════════════════════════════════════════════════════════════
function exportCSV() {
    if (!allParticipants.length) { showToast('No participants to export', 'warning'); return; }
    let csv = 'Name,Email,Sex,Type,Designation,School/Office,Email Status\n';
    allParticipants.forEach(p => {
        csv += `"${p.full_name}","${p.email || ''}","${p.sex}","${p.participant_type || ''}","${p.designation || ''}","${p.school_office || ''}","${emailStatusMap[p.id] || 'pending'}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `recipients_${currentWorkshop?.id || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}


// ═══════════════════════════════════════════════════════════════════════════════
// MODALS / TABS / PROGRESS
// ═══════════════════════════════════════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('show');
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
});

function switchTab(tabId, btn, modalId) {
    const modal = document.getElementById(modalId);
    modal.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    modal.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

function showProgress(title) {
    document.getElementById('progressTitle').textContent = title || 'Processing…';
    document.getElementById('progressFill').style.width = '60%';
    document.getElementById('progressText').textContent = 'Please wait…';
    document.getElementById('progressOverlay').classList.add('show');
}
function hideProgress() {
    document.getElementById('progressFill').style.width = '100%';
    setTimeout(() => document.getElementById('progressOverlay').classList.remove('show'), 400);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════════
let _toastT;
function showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `dashboard-toast show ${type}`;
    clearTimeout(_toastT);
    _toastT = setTimeout(() => t.classList.remove('show'), 3200);
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
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
});// ── PDF.js worker ───────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const { PDFDocument } = PDFLib;

// ── State ───────────────────────────────────────────────
let splitFile = null;
let outputFiles = [];
let blobUrls = [];         // FIX #2 & #3: Track blob URLs for cleanup
let isSplitting = false;   // FIX #11: Cancellation flag
let cancelRequested = false;
let selectedWorkshop = null;  // Currently selected workshop object
let workshopParticipants = []; // Participants loaded for the selected workshop
let linkedRecordsCache = [];   // Records from records_api linked to selected workshop
let allRecords = [];           // All evaluation_programs from records_api (loaded on boot)

// ── Bootstrap ───────────────────────────────────────────
// In the merged page, certificates.js handles authentication.
// The splitter only needs to: load programs data + wire up drag-and-drop.
window.addEventListener('DOMContentLoaded', async function () {
    // Fetch programs (replaces the old workshops.php + records_api.php pair)
    loadWorkshopsAndRecords();

    // Drag & drop on the PDF drop zone
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
        dropZone.addEventListener('dragover', e => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) setFile(file);
        });
    }

    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', e => {
            if (e.target.files[0]) setFile(e.target.files[0]);
        });
    }
});


// ── Workshop Modal ───────────────────────────────────────
// Uses programs.php as the single source of truth — same pattern as programs.js.
// programs.php returns:
//   - workshops (program_type = 'standalone' | 'container', source_type = 'workshop')
//   - standalone Excel imports (source_type = 'excel', no workshop row)
// No separate call to records_api.php needed; day-level breakdowns come via
// day_imports (container) or day_sheet counts embedded in the response.
let workshopsCache = [];   // entries with source_type = 'workshop'
let standaloneCache = [];  // entries with source_type = 'excel' (standalone imports)
let wsActiveFilter = 'all';
let wsLoadFailed = false;

async function loadWorkshopsAndRecords() {
    wsLoadFailed = false;
    try {
        const res = await fetch(`${CONFIG.API_URL}/programs.php`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed to load programs');

        const all = data.data || [];

        // Split into real workshops vs standalone Excel imports
        workshopsCache  = all.filter(p => p.source_type === 'workshop' || (!p.source_type && p.id && !p.eval_program_id));
        standaloneCache = all.filter(p => p.source_type === 'excel'    && !workshopsCache.includes(p));

        // Normalise: programs.php uses `participant_count` field name inconsistently —
        // ensure both participant_count and total_participants are available.
        workshopsCache.forEach(w => {
            if (!w.participant_count && w.total_participants) {
                w.participant_count = w.total_participants;
            }
        });

        // Keep allRecords populated for any legacy references (e.g. loadLinkedRecords)
        allRecords = standaloneCache;

    } catch (e) {
        workshopsCache  = [];
        standaloneCache = [];
        allRecords      = [];
        wsLoadFailed    = true;
        console.warn('Could not load programs:', e);
    }
}

// Alias so retryLoadWorkshops still works
async function loadWorkshops() {
    return loadWorkshopsAndRecords();
}

function openWorkshopModal() {
    const overlay = document.getElementById('wsModalOverlay');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Reset search & filter
    const input = document.getElementById('wsSearchInput');
    if (input) { input.value = ''; }
    document.getElementById('wsSearchClear').style.display = 'none';
    setWsFilter('all', false);

    // If load previously failed, retry before rendering
    if (wsLoadFailed) {
        document.getElementById('wsModalList').innerHTML = `
            <div class="ws-loading">
                <div class="ws-loading-spinner"></div>
                <span>Loading workshops…</span>
            </div>`;
        document.getElementById('wsResultsInfo').textContent = '';
        loadWorkshops().then(() => renderWsList());
    } else {
        renderWsList();
    }

    // Focus search after animation
    setTimeout(() => input && input.focus(), 250);
}

function closeWorkshopModal() {
    const overlay = document.getElementById('wsModalOverlay');
    overlay.classList.remove('open');
    document.body.style.overflow = '';
}

function onWsOverlayClick(e) {
    if (e.target === document.getElementById('wsModalOverlay')) {
        closeWorkshopModal();
    }
}

// Keyboard: Escape closes
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeWorkshopModal();
});

function setWsFilter(filter, rerender = true) {
    wsActiveFilter = filter;
    document.querySelectorAll('.ws-filter-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    if (rerender) renderWsList();
}

function clearWsSearch() {
    const input = document.getElementById('wsSearchInput');
    input.value = '';
    document.getElementById('wsSearchClear').style.display = 'none';
    renderWsList();
    input.focus();
}

function filterWorkshops() {
    const val = document.getElementById('wsSearchInput').value;
    document.getElementById('wsSearchClear').style.display = val ? 'flex' : 'none';
    renderWsList();
}

function renderWsList() {
    const list = document.getElementById('wsModalList');
    const infoEl = document.getElementById('wsResultsInfo');
    const query = (document.getElementById('wsSearchInput').value || '').toLowerCase().trim();

    if (wsLoadFailed) {
        list.innerHTML = `
            <div class="ws-error">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Could not load workshops.</span>
                <button class="ws-retry-btn" onclick="retryLoadWorkshops()">
                    <i class="fa-solid fa-rotate-right"></i> Retry
                </button>
            </div>`;
        infoEl.textContent = '';
        return;
    }

    if (!workshopsCache.length && !standaloneCache.length) {
        list.innerHTML = `
            <div class="ws-empty">
                <i class="fa-solid fa-calendar-xmark"></i>
                <strong>No programs yet</strong>
                <span>Create a workshop or import an Excel file first.</span>
            </div>`;
        infoEl.textContent = '';
        return;
    }

    // ── Workshops — filtered by status tab + search ───────────────────────────
    let filteredWs = wsActiveFilter === 'all'
        ? [...workshopsCache]
        : workshopsCache.filter(w => (w.status || 'upcoming') === wsActiveFilter);

    if (query) {
        filteredWs = filteredWs.filter(w =>
            (w.title || '').toLowerCase().includes(query) ||
            (w.venue || '').toLowerCase().includes(query) ||
            (w.division_memo || '').toLowerCase().includes(query) ||
            (w.proponents || '').toLowerCase().includes(query)
        );
    }

    // ── Standalone Excel imports — only shown on "All" tab ────────────────────
    let filteredStandalone = wsActiveFilter === 'all' ? [...standaloneCache] : [];

    if (query && filteredStandalone.length) {
        filteredStandalone = filteredStandalone.filter(r =>
            (r.title || '').toLowerCase().includes(query) ||
            (r.source_filename || '').toLowerCase().includes(query)
        );
    }

    const totalFound = filteredWs.length + filteredStandalone.length;
    infoEl.textContent = totalFound
        ? `${totalFound} program${totalFound !== 1 ? 's' : ''} found`
        : '';

    if (!totalFound) {
        list.innerHTML = `
            <div class="ws-empty">
                <i class="fa-solid fa-calendar-xmark"></i>
                <strong>No programs found</strong>
                <span>${query ? 'Try a different search term.' : 'No programs match the selected filter.'}</span>
            </div>`;
        return;
    }

    // ── Render workshops grouped by status ────────────────────────────────────
    const order = ['ongoing', 'upcoming', 'completed', 'cancelled'];
    const statusLabels = {
        ongoing:   '● Ongoing',
        upcoming:  '◎ Upcoming',
        completed: '✓ Completed',
        cancelled: '✕ Cancelled',
    };
    const groups = {};
    order.forEach(s => { groups[s] = []; });
    filteredWs.forEach(w => {
        const s = w.status || 'upcoming';
        if (groups[s]) groups[s].push(w);
        else groups.upcoming.push(w);
    });

    const activeStatuses = order.filter(s => groups[s].length > 0);
    const showGroups = activeStatuses.length > 1 || filteredStandalone.length > 0;

    let html = '';

    for (const status of order) {
        const items = groups[status];
        if (!items.length) continue;

        if (showGroups) {
            html += `
                <div class="ws-group-header">
                    <span>${statusLabels[status]}</span>
                    <div class="ws-group-header-line"></div>
                    <span>${items.length}</span>
                </div>`;
        }

        items.forEach(w => {
            const isSelected = selectedWorkshop && selectedWorkshop.id === w.id;
            const dateRange = formatDateRange(w.start_date, w.end_date);
            const memo = w.division_memo || '';
            const regCount  = parseInt(w.participant_count || w.total_participants) || 0;
            let participantLabel = regCount > 0 ? `${regCount} participants` : '';

            // Container programs show per-day import counts
            const dayImports = w.day_imports || [];
            const recLabel = dayImports.length > 0
                ? `${dayImports.length} import${dayImports.length !== 1 ? 's' : ''}`
                : '';

            html += `
                <div class="ws-card ${isSelected ? 'selected' : ''}" onclick="splitterSelectWorkshop(${w.id})">
                    <div class="ws-card-dot ${status}"></div>
                    <div class="ws-card-body">
                        <div class="ws-card-title">${escapeHtml(w.title)}</div>
                        <div class="ws-card-meta">
                            ${dateRange ? `<span class="ws-card-meta-item"><i class="fa-solid fa-calendar"></i>${escapeHtml(dateRange)}</span>` : ''}
                            ${w.venue ? `<span class="ws-card-meta-item"><i class="fa-solid fa-location-dot"></i>${escapeHtml(w.venue)}</span>` : ''}
                            ${memo ? `<span class="ws-card-meta-item"><i class="fa-solid fa-file-lines"></i>${escapeHtml(memo)}</span>` : ''}
                            ${participantLabel ? `<span class="ws-card-meta-item"><i class="fa-solid fa-users"></i>${escapeHtml(participantLabel)}</span>` : ''}
                            ${recLabel
                                ? `<span class="ws-card-meta-item ws-card-meta-item--records"><i class="fa-solid fa-file-import"></i>${escapeHtml(recLabel)}</span>`
                                : (w.program_type === 'container'
                                    ? `<span class="ws-card-meta-item ws-card-meta-item--no-records"><i class="fa-solid fa-triangle-exclamation"></i>No imports yet</span>`
                                    : '')}
                        </div>
                    </div>
                    <div class="ws-card-right">
                        <span class="workshop-status-badge ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
                        <div class="ws-card-check"><i class="fa-solid fa-check"></i></div>
                    </div>
                </div>`;
        });
    }

    // ── Render standalone Excel imports ───────────────────────────────────────
    if (filteredStandalone.length) {
        html += `
            <div class="ws-group-header">
                <span>📋 Standalone Imports</span>
                <div class="ws-group-header-line"></div>
                <span>${filteredStandalone.length}</span>
            </div>`;

        filteredStandalone.forEach(r => {
            const isSelected = selectedWorkshop && selectedWorkshop._recordId === r.id;
            const respCount  = r.responses_count || r.total_responses;
            const respLabel  = respCount ? `${respCount} respondent${respCount !== 1 ? 's' : ''}` : '';
            const avg        = r.overall_average ? ` · avg ${r.overall_average}` : '';

            html += `
                <div class="ws-card ws-card--record ${isSelected ? 'selected' : ''}" onclick="selectRecord(${r.id})">
                    <div class="ws-card-dot completed"></div>
                    <div class="ws-card-body">
                        <div class="ws-card-title">${escapeHtml(r.title)}</div>
                        <div class="ws-card-meta">
                            <span class="ws-card-meta-item"><i class="fa-solid fa-file-import"></i>Excel import</span>
                            ${respLabel ? `<span class="ws-card-meta-item ws-card-meta-item--records"><i class="fa-solid fa-users"></i>${escapeHtml(respLabel)}${escapeHtml(avg)}</span>` : ''}
                            ${r.source_filename ? `<span class="ws-card-meta-item"><i class="fa-solid fa-file-excel"></i>${escapeHtml(r.source_filename)}</span>` : ''}
                        </div>
                    </div>
                    <div class="ws-card-right">
                        <span class="workshop-status-badge completed">Record</span>
                        <div class="ws-card-check"><i class="fa-solid fa-check"></i></div>
                    </div>
                </div>`;
        });
    }

    list.innerHTML = html;
}

function splitterSelectWorkshop(id) {
    selectedWorkshop = workshopsCache.find(w => w.id === id) || null;
    if (!selectedWorkshop) return;

    // Update trigger button
    const titleEl = document.getElementById('workshopTriggerSelected');
    const subEl = document.getElementById('workshopTriggerSub');
    const phEl = document.getElementById('workshopTriggerPlaceholder');
    const badgeEl = document.getElementById('workshopTriggerBadge');
    const clearBtn = document.getElementById('workshopClearBtn');

    phEl.style.display = 'none';
    titleEl.style.display = '';
    titleEl.textContent = selectedWorkshop.title;

    const parts = [];
    const dr = formatDateRange(selectedWorkshop.start_date, selectedWorkshop.end_date);
    if (dr) parts.push(dr);
    if (selectedWorkshop.venue) parts.push(selectedWorkshop.venue);
    const regCount = parseInt(selectedWorkshop.participant_count) || 0;
    if (regCount > 0) parts.push(`${regCount} registered`);
    subEl.style.display = parts.length ? '' : 'none';
    subEl.textContent = parts.join(' · ');

    badgeEl.style.display = '';
    badgeEl.textContent = (selectedWorkshop.status || 'upcoming').charAt(0).toUpperCase() +
        (selectedWorkshop.status || 'upcoming').slice(1);
    badgeEl.className = `workshop-status-badge ${selectedWorkshop.status || 'upcoming'}`;

    clearBtn.style.display = '';

    closeWorkshopModal();
    showToast(`✅ Workshop selected: "${selectedWorkshop.title.substring(0, 40)}${selectedWorkshop.title.length > 40 ? '…' : ''}"`, 'success');

    // Load participants and linked import records for this workshop
    splitterLoadParticipants(selectedWorkshop.id);
    loadLinkedRecords(selectedWorkshop.id);
}

// Selects a standalone Excel import (no workshop row) — loads respondents as participants.
// programs.php uses responses_count for standalone entries; fall back to total_responses.
function selectRecord(recordId) {
    // Look up in standaloneCache first; fall back to allRecords for legacy compatibility
    const rec = standaloneCache.find(r => r.id === recordId)
             || allRecords.find(r => r.id === recordId);
    if (!rec) return;

    const totalRespondents = parseInt(rec.responses_count || rec.total_responses || 0);

    // Store as a pseudo-workshop so the rest of the UI works unchanged
    selectedWorkshop = {
        id: null,
        _recordId: recordId,
        title: rec.title,
        status: rec.status || 'completed',
        start_date: rec.start_date || null,
        end_date: rec.end_date || null,
        venue: rec.venue || null,
        participant_count: totalRespondents,
        _isRecord: true,
    };

    // Update trigger button
    const titleEl  = document.getElementById('workshopTriggerSelected');
    const subEl    = document.getElementById('workshopTriggerSub');
    const phEl     = document.getElementById('workshopTriggerPlaceholder');
    const badgeEl  = document.getElementById('workshopTriggerBadge');
    const clearBtn = document.getElementById('workshopClearBtn');

    phEl.style.display = 'none';
    titleEl.style.display = '';
    titleEl.textContent = rec.title;

    const parts = [];
    if (totalRespondents > 0) parts.push(`${totalRespondents} respondents`);
    if (rec.overall_average)  parts.push(`avg ${rec.overall_average}`);
    subEl.style.display = parts.length ? '' : 'none';
    subEl.textContent = parts.join(' · ');

    badgeEl.style.display = '';
    badgeEl.textContent = 'Record';
    badgeEl.className = 'workshop-status-badge completed';

    clearBtn.style.display = '';

    closeWorkshopModal();
    showToast(`✅ Record selected: "${rec.title.substring(0, 40)}${rec.title.length > 40 ? '…' : ''}"`, 'success');

    // Load respondents via records_api (participants panel)
    loadParticipantsFromRecord(recordId);

    // Show this record as the linked import in the strip
    linkedRecordsCache = [rec];
    renderLinkedRecords([rec]);
}

function clearWorkshop() {
    selectedWorkshop = null;
    workshopParticipants = [];
    linkedRecordsCache = [];
    document.getElementById('workshopTriggerSelected').style.display = 'none';
    document.getElementById('workshopTriggerSub').style.display = 'none';
    document.getElementById('workshopTriggerPlaceholder').style.display = '';
    document.getElementById('workshopTriggerBadge').style.display = 'none';
    document.getElementById('workshopClearBtn').style.display = 'none';
    document.getElementById('participantsPanel').style.display = 'none';
    // Reset linked records strip
    const lrl = document.getElementById('linkedRecordsList');
    if (lrl) lrl.innerHTML = '<span class="linked-records-loading"><i class="fa-solid fa-spinner fa-spin"></i></span>';
}

// ── Workshop Participants ────────────────────────────────
async function splitterLoadParticipants(workshopId) {
    workshopParticipants = [];
    const panel = document.getElementById('participantsPanel');
    const list = document.getElementById('participantsList');
    const badge = document.getElementById('participantCountBadge');
    const footer = document.getElementById('participantsPanelFooter');
    const legend = document.getElementById('participantsMatchLegend');

    // Show panel in loading state
    panel.style.display = '';
    footer.style.display = 'none';
    legend.style.display = 'none';
    document.getElementById('participantsSearch').value = '';
    list.innerHTML = `
        <div class="participants-loading">
            <div class="participants-spinner"></div>
            <span>Loading participants…</span>
        </div>`;
    badge.textContent = '…';

    try {
        const res = await fetch(
            `${API}?action=get_participants&workshop_id=${encodeURIComponent(workshopId)}`,
            { credentials: 'include' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // API returns { success: true, data: [...] }
        if (!json.success) throw new Error(json.error || json.message || 'Request failed');
        const participants = Array.isArray(json.data) ? json.data : [];
        workshopParticipants = participants;

        // Sync the live count back into the cached workshop object and badge
        badge.textContent = participants.length;
        if (selectedWorkshop) {
            selectedWorkshop.participant_count = participants.length;
            // Also update the cached entry so the modal card reflects the real count
            const cached = workshopsCache.find(w => w.id === selectedWorkshop.id);
            if (cached) cached.participant_count = participants.length;
            // Refresh the trigger subtitle with the accurate count
            const regCount = participants.length;
            const subEl = document.getElementById('workshopTriggerSub');
            if (subEl) {
                const dr = formatDateRange(selectedWorkshop.start_date, selectedWorkshop.end_date);
                const parts = [];
                if (dr) parts.push(dr);
                if (selectedWorkshop.venue) parts.push(selectedWorkshop.venue);
                if (regCount > 0) parts.push(`${regCount} registered`);
                subEl.style.display = parts.length ? '' : 'none';
                subEl.textContent = parts.join(' · ');
            }
        }
        renderParticipants(participants);

    } catch (e) {
        badge.textContent = '!';
        list.innerHTML = `
            <div class="participants-error">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Could not load participants: ${escapeHtml(e.message)}</span>
            </div>`;
    }
}

// ── Participants from a standalone record (respondents via programs.php) ─────
// programs.php?id= returns the full program object including respondents array
// when action=monitoring is requested. We use the same endpoint as programs.js.
async function loadParticipantsFromRecord(recordId) {
    workshopParticipants = [];
    const panel  = document.getElementById('participantsPanel');
    const list   = document.getElementById('participantsList');
    const badge  = document.getElementById('participantCountBadge');
    const footer = document.getElementById('participantsPanelFooter');
    const legend = document.getElementById('participantsMatchLegend');

    panel.style.display = '';
    footer.style.display = 'none';
    legend.style.display = 'none';
    document.getElementById('participantsSearch').value = '';
    list.innerHTML = `
        <div class="participants-loading">
            <div class="participants-spinner"></div>
            <span>Loading respondents…</span>
        </div>`;
    badge.textContent = '…';

    try {
        const res = await fetch(
            `${CONFIG.API_URL}/records_api.php?id=${encodeURIComponent(recordId)}&monitoring=1`,
            { credentials: 'include' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Request failed');

        // Map respondents → same shape as workshop_participants rows
        const respondents = json.program?.respondents || [];

        // Deduplicate by email for multi-day programs.
        const PLACEHOLDER_EMAILS = new Set(['anonymous', 'n/a', 'none', 'na', '-', '']);
        const seenEmails = new Set();
        const participants = [];
        for (const r of respondents) {
            const email = (r.email || '').toLowerCase().trim();
            const isRealEmail = email && !PLACEHOLDER_EMAILS.has(email);
            if (isRealEmail) {
                if (seenEmails.has(email)) continue;
                seenEmails.add(email);
            }
            participants.push({
                id:             r.id || null,
                _respondentId:  r.id || null,
                full_name:      r.respondent_name,
                sex:            r.sex || '',
                designation:    r.designation || '',
                school_office:  r.school_office || '',
                email:          r.email || '',
            });
        }

        workshopParticipants = participants;
        badge.textContent = participants.length;
        renderParticipants(participants);

    } catch (e) {
        badge.textContent = '!';
        list.innerHTML = `
            <div class="participants-error">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Could not load respondents: ${escapeHtml(e.message)}</span>
            </div>`;
    }
}


function loadLinkedRecords(workshopId) {
    linkedRecordsCache = [];
    const listEl = document.getElementById('linkedRecordsList');
    if (!listEl) return;

    // programs.php embeds day_imports on container workshops.
    // For linked imports strip, we use the cached workshop's day_imports array.
    // standaloneCache entries linked to this workshop are those that share
    // the same eval_program_id (programs.php returns eval_program_id on workshop rows).
    const ws = workshopsCache.find(w => w.id === workshopId);
    const dayImports = (ws && ws.day_imports) ? ws.day_imports : [];

    // Build display records from day_imports (container) or empty for standalone workshops
    const linked = dayImports.map(imp => ({
        title:           imp.label || 'Import',
        total_responses: imp.responses || imp.count || 0,
        overall_average: null,
        source_filename: null,
    }));

    linkedRecordsCache = linked;
    renderLinkedRecords(linked);
}

function renderLinkedRecords(records) {
    const listEl = document.getElementById('linkedRecordsList');
    if (!listEl) return;

    if (!records.length) {
        listEl.innerHTML = `
            <span class="linked-records-none">
                <i class="fa-solid fa-circle-exclamation"></i>
                No imports linked yet — save an Excel import for this workshop first
            </span>`;
        return;
    }

    listEl.innerHTML = records.map(r => {
        const title = r.title || r.source_filename || 'Untitled';
        const short = title.length > 45 ? title.substring(0, 45) + '…' : title;
        const respCount = r.total_responses
            ? `${r.total_responses} respondent${r.total_responses !== 1 ? 's' : ''}`
            : '';
        const avg = r.overall_average ? ` · avg ${r.overall_average}` : '';
        return `
            <div class="linked-record-chip" title="${escapeHtml(title)}">
                <i class="fa-solid fa-table"></i>
                <span class="linked-record-chip-name">${escapeHtml(short)}</span>
                ${respCount ? `<span class="linked-record-chip-count">${escapeHtml(respCount)}${escapeHtml(avg)}</span>` : ''}
            </div>`;
    }).join('');
}


function renderParticipants(participants, query = '') {
    const list = document.getElementById('participantsList');

    if (!participants.length) {
        list.innerHTML = `
            <div class="participants-empty">
                <i class="fa-solid fa-users-slash"></i>
                <strong>No participants found</strong>
                <span>No Excel import has been linked to this workshop yet.<br>
                Go to <strong>Programs / Workshops → Import File</strong>, select this workshop when saving, then come back.</span>
            </div>`;
        return;
    }

    const splittingDone = outputFiles.length > 0;
    const detectedNames = splittingDone
        ? outputFiles.map(f => normaliseName(f.name.replace(/\.pdf$/i, '')))
        : [];

    list.innerHTML = participants.map(p => {
        const name = p.full_name || '';
        const sex = (p.sex || '').toLowerCase();
        const sub = [p.designation, p.school_office].filter(Boolean).join(' · ');
        const initials = name.split(/\s+/).filter(Boolean)
            .map(w => w[0]).slice(0, 2).join('').toUpperCase();

        const avatarClass = sex === 'male' ? 'male' : sex === 'female' ? 'female' : '';

        // Match check: was this person's certificate detected?
        let matchClass = '', matchIcon = '';
        if (splittingDone) {
            const norm = normaliseName(name);
            const isMatch = detectedNames.some(d => namesMatch(d, norm));
            matchClass = isMatch ? 'matched' : 'unmatched';
            matchIcon = isMatch
                ? `<div class="participant-match-icon show ok"><i class="fa-solid fa-check"></i></div>`
                : `<div class="participant-match-icon show miss"><i class="fa-solid fa-question"></i></div>`;
        }

        // Search hide
        const hidden = query && !name.toLowerCase().includes(query.toLowerCase())
            && !sub.toLowerCase().includes(query.toLowerCase())
            ? 'hidden' : '';

        return `
            <div class="participant-row ${matchClass} ${hidden}" data-name="${escapeHtml(name)}">
                <div class="participant-avatar ${avatarClass}">${escapeHtml(initials)}</div>
                <div class="participant-info">
                    <div class="participant-name">${escapeHtml(name)}</div>
                    ${sub ? `<div class="participant-sub">${escapeHtml(sub)}</div>` : ''}
                </div>
                ${matchIcon}
            </div>`;
    }).join('');
}

function filterParticipants() {
    const query = document.getElementById('participantsSearch').value;
    renderParticipants(workshopParticipants, query);
}

// Called after splitting completes — marks each participant row as matched/unmatched
function matchParticipantsToOutput() {
    if (!workshopParticipants.length) return;

    const legend = document.getElementById('participantsMatchLegend');
    const footer = document.getElementById('participantsPanelFooter');
    const summaryEl = document.getElementById('participantsMatchSummary');

    const detectedNames = outputFiles.map(f => normaliseName(f.name.replace(/\.pdf$/i, '')));

    let matched = 0;
    workshopParticipants.forEach(p => {
        const norm = normaliseName(p.full_name || '');
        if (detectedNames.some(d => namesMatch(d, norm))) matched++;
    });

    const total = workshopParticipants.length;
    const unmatched = total - matched;

    legend.style.display = 'flex';
    footer.style.display = 'flex';
    summaryEl.innerHTML = `
        <i class="fa-solid fa-circle-info"></i>
        <strong>${matched}</strong> of <strong>${total}</strong> registered participants matched to a split certificate
        ${unmatched > 0 ? `— <strong>${unmatched}</strong> may be missing or named differently in the PDF` : '— all accounted for ✓'}`;

    // Re-render with match indicators
    const query = document.getElementById('participantsSearch').value;
    renderParticipants(workshopParticipants, query);
}

// ── Name normalisation helpers ───────────────────────────
function normaliseName(str) {
    return (str || '')
        .toUpperCase()
        // Transliterate accented/special chars to ASCII equivalents before stripping
        .replace(/[Ñ]/g, 'N')
        .replace(/[ÁÀÂÄ]/g, 'A')
        .replace(/[ÉÈÊË]/g, 'E')
        .replace(/[ÍÌÎÏ]/g, 'I')
        .replace(/[ÓÒÔÖ]/g, 'O')
        .replace(/[ÚÙÛÜ]/g, 'U')
        .replace(/[^A-Z\s]/g, ' ') // strip remaining punctuation/dots
        .replace(/\s+/g, ' ')
        .trim();
}

function namesMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // Tokenise and check if all tokens of the shorter name appear in the longer one
    const ta = a.split(' ').filter(Boolean);
    const tb = b.split(' ').filter(Boolean);
    const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

    // Require at least 2 tokens and all shorter tokens to be found in longer
    if (shorter.length < 2) return false;
    return shorter.every(tok => longer.some(lt => lt.startsWith(tok) || tok.startsWith(lt)));
}

async function retryLoadWorkshops() {
    wsLoadFailed = false;
    document.getElementById('wsModalList').innerHTML = `
        <div class="ws-loading">
            <div class="ws-loading-spinner"></div>
            <span>Loading workshops…</span>
        </div>`;
    await loadWorkshops();
    renderWsList();
}

function formatDateRange(start, end) {
    if (!start) return '';
    try {
        const s = new Date(start + 'T00:00:00');
        const e = end ? new Date(end + 'T00:00:00') : null;
        const opts = { month: 'short', day: 'numeric', year: 'numeric' };
        if (!e || start === end) return s.toLocaleDateString('en-US', opts);
        return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', opts)}`;
    } catch { return ''; }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


// ── File size helper ─────────────────────────────────────
function fmt(size) {
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(2) + ' MB';
}

// FIX #9: Max file size warning (50 MB)
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function setFile(file) {
    if (!file || file.type !== 'application/pdf') {
        showToast('Please upload a valid PDF file.', 'error');
        return;
    }

    // FIX #9: Warn user about very large files
    if (file.size > MAX_FILE_SIZE_BYTES) {
        showToast(`⚠️ File is ${fmt(file.size)}. Large files may be slow or cause memory issues.`, 'info');
    }

    splitFile = file;
    document.getElementById('fileInfoName').textContent = file.name;
    document.getElementById('fileInfoSize').textContent = fmt(file.size);
    document.getElementById('fileInfoBar').classList.add('visible');
    document.getElementById('splitBtn').disabled = false;
    hideError();
    clearResults();
}

function clearFile() {
    // FIX #11: Cancel any in-progress split
    if (isSplitting) cancelRequested = true;

    splitFile = null;
    outputFiles = [];
    document.getElementById('fileInfoBar').classList.remove('visible');
    document.getElementById('fileInput').value = '';
    document.getElementById('splitBtn').disabled = true;
    document.getElementById('zipBtn').disabled = true;
    clearResults();
    hideError();
    resetStats();
}

// ── Split Logic ──────────────────────────────────────────
async function doSplit() {
    if (!splitFile || isSplitting) return;

    clearResults();
    hideError();
    splitterShowProgress(0, 'Loading PDF\u2026', '');
    document.getElementById('splitBtn').disabled = true;
    document.getElementById('zipBtn').disabled = true;

    isSplitting = true;
    cancelRequested = false;

    // Warn if PDF page count doesn't match participant count
    if (workshopParticipants.length > 0) {
        const checkBytes = new Uint8Array(await splitFile.arrayBuffer());
        const checkSrc = await PDFDocument.load(checkBytes.slice());
        const pageCount = checkSrc.getPageCount();
        if (pageCount !== workshopParticipants.length) {
            const proceed = confirm(
                `\u26a0\ufe0f Page count mismatch!\n\n` +
                `PDF has ${pageCount} page(s) but ${workshopParticipants.length} participant(s) are registered.\n\n` +
                `The fallback assignment (page N \u2192 participant N) may not be accurate.\n\nContinue anyway?`
            );
            if (!proceed) {
                isSplitting = false;
                document.getElementById('splitBtn').disabled = false;
                splitterHideProgress();
                return;
            }
        }
    }

    let allDebug = [];
    outputFiles = [];
    let outputMeta = []; // tracks participant linkage per file
    let namedCount = 0;

    try {
        const masterBytes = new Uint8Array(await splitFile.arrayBuffer());
        const src = await PDFDocument.load(masterBytes.slice());
        const total = src.getPageCount();
        document.getElementById('statPages').textContent = total;

        for (let i = 0; i < total; i++) {
            if (cancelRequested) {
                showToast('\u26a0\ufe0f Split cancelled.', 'info');
                splitterHideProgress();
                break;
            }

            const pct = Math.round((i / total) * 88);
            splitterShowProgress(pct, `Processing certificate ${i + 1} of ${total}`, `Page ${i + 1} / ${total}`);

            const { name: detectedName, debugLines } = await extractCertificateName(masterBytes.slice(), i);

            allDebug.push(`\n--- Page ${i + 1} ---`);
            allDebug.push(...debugLines);

            // ── Name resolution ──────────────────────────────────────────────
            // Priority 1: name extracted from the PDF itself
            // Priority 2: participant at the same index (page N -> participant N)
            let resolvedName = detectedName;
            let matchedParticipant = null;

            if (resolvedName && workshopParticipants.length > 0) {
                // PDF had a name — try to find the matching participant for DB linkage
                const norm = normaliseName(resolvedName);
                matchedParticipant = workshopParticipants.find(p =>
                    namesMatch(normaliseName(p.full_name || ''), norm)
                ) || null;
                if (matchedParticipant) {
                    allDebug.push(`  \ud83d\udd17 LINKED to participant: "${matchedParticipant.full_name}"`);
                }
            } else if (!resolvedName && workshopParticipants.length > i) {
                // PDF had no extractable name — fall back to participant by position
                const p = workshopParticipants[i];
                resolvedName = sanitizeFilename(normaliseName(p.full_name || ''));
                matchedParticipant = p;
                allDebug.push(`  \ud83d\udd04 FALLBACK to participant[${i}]: "${p.full_name}"`);
            }

            if (resolvedName) namedCount++;

            const doc = await PDFDocument.create();
            const [pg] = await doc.copyPages(src, [i]);
            doc.addPage(pg);
            const out = await doc.save();

            const filename = (resolvedName || `certificate_${i + 1}`) + '.pdf';
            outputFiles.push({ bytes: out, name: filename });

            // For Record-type selections, participants are respondents — never
            // put their id in participant_id (that targets workshop_participants table).
            const isRecord = !!(selectedWorkshop?._isRecord);
            outputMeta.push({
                file_name:      filename,
                participant_id: isRecord ? 0 : (matchedParticipant?.id || 0),
                respondent_id:  isRecord ? (matchedParticipant?._respondentId || matchedParticipant?.id || 0)
                                         : (matchedParticipant?._respondentId || 0),
            });
        }

        if (!cancelRequested) {
            // Save certificates to DB if a workshop/record is selected
            if (selectedWorkshop) {
                splitterShowProgress(93, 'Saving to database\u2026', '');
                await saveSplitResultsToDB(outputFiles, outputMeta);
            }

            splitterShowProgress(100, 'Done!', `${total} certificates processed`);
            setTimeout(() => splitterHideProgress(), 800);

            document.getElementById('statSplit').textContent = outputFiles.length;
            document.getElementById('statNamed').textContent = namedCount;
            showResults(outputFiles);
            document.getElementById('zipBtn').disabled = false;
            document.getElementById('debugPanel').style.display = '';
            document.getElementById('debugOutput').textContent = allDebug.join('\n');

            matchParticipantsToOutput();

            const workshopLabel = selectedWorkshop
                ? ` for "${selectedWorkshop.title.substring(0, 40)}${selectedWorkshop.title.length > 40 ? '\u2026' : ''}"`
                : '';
            showToast(`\u2705 ${total} certificates split and saved${workshopLabel}!`, 'success');
        }

    } catch (e) {
        splitterHideProgress();
        showError(e.message);
        showToast('Error processing PDF.', 'error');
    } finally {
        isSplitting = false;
        cancelRequested = false;
        document.getElementById('splitBtn').disabled = false;
    }
}

// ── Save split results to DB ──────────────────────────────────────────────────
async function saveSplitResultsToDB(files, meta) {
    if (!selectedWorkshop) return;

    const workshopId = selectedWorkshop._isRecord ? 0 : (selectedWorkshop.id || 0);
    const programId  = selectedWorkshop._isRecord ? (selectedWorkshop._recordId || 0) : 0;

    // FIX: also pass the Certificates-page workshop ID (currentWorkshop) so the
    // PHP fallback name-matcher can search the right workshop_participants table
    // even when the splitter was opened for a different program/record ID.
    const certPageWorkshopId = (typeof currentWorkshop !== 'undefined' && currentWorkshop)
        ? (currentWorkshop.id || 0)
        : 0;

    let savedCount = 0;

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const m = meta[i] || {};

        // Encode this single certificate
        let b64 = '';
        try {
            const bytes = f.bytes;
            let binary = '';
            for (let j = 0; j < bytes.length; j++) {
                binary += String.fromCharCode(bytes[j]);
            }
            b64 = btoa(binary);
        } catch (err) {
            console.warn('base64 encode failed for', f.name, err);
            continue;
        }

        if (!b64) continue;

        try {
            const res = await fetch(
                `${CONFIG.API_URL}/certificates_api.php?action=save_split_results`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        workshop_id:           workshopId,
                        program_id:            programId,
                        // FIX: hint so PHP resolves the correct participant table
                        cert_page_workshop_id: certPageWorkshopId,
                        results: [{
                            file_name:      f.name,
                            participant_id: m.participant_id || 0,
                            respondent_id:  m.respondent_id  || 0,
                            data:           b64,
                        }],
                    }),
                }
            );
            const json = await res.json();
            if (json.success) {
                savedCount += (json.saved || 0) + (json.linked || 0);
            } else {
                console.warn(`save_split_results failed for ${f.name}:`, json.message);
            }
        } catch (err) {
            console.warn(`save_split_results network error for ${f.name}:`, err);
        }
    }

    if (savedCount > 0) {
        showToast(`💾 ${savedCount} certificate(s) saved and linked to participants`, 'success');
    } else {
        showToast('⚠️ Certificates split but could not save to database', 'info');
    }

    // FIX: Refresh the Certificates page participant list and stats so cert_file_id
    // values are up-to-date immediately — without this the "Missing Certificate"
    // counter and Bulk Send warning stay stale until the user manually reloads.
    if (typeof currentWorkshop !== 'undefined' && currentWorkshop) {
        try {
            await Promise.all([loadParticipants(), loadFiles()]);
            updateStats();
        } catch (e) {
            console.warn('Post-split refresh failed:', e);
        }
    }
}

// ── Name Extraction (context-first approach) ─────────────
const BLACKLIST = [
    "CERTIFICATE", "DEPARTMENT", "DIVISION", "PHILIPPINES", "QUALITY", "COMPETENCE",
    "MEMORANDUM", "OFFICE", "BUREAU", "REGION", "NATIONAL", "REPUBLIC", "GOVERNMENT",
    "AUTHORITY", "COMPLETION", "PARTICIPATION", "APPRECIATION", "RECOGNITION", "TRAINING",
    "SEMINAR", "WORKSHOP", "PRESENTED", "AWARDED", "MANAGEMENT", "ADMINISTRATION",
    "SERVICE", "EDUCATION", "TECHNOLOGY", "INFORMATION", "SYSTEM", "CENTER", "INSTITUTE",
    "THIS IS TO CERTIFY", "CERTIFY", "HEREBY", "AWARDED TO", "GIVEN TO", "PRESENTED TO",
    "EXCELLENCE", "ACHIEVEMENT", "DIRECTOR", "SUPERINTENDENT", "SCHOOLS", "DIVISION",
    "DEPED", "REPUBLIC", "DATE", "SIGNED",
    "ASSISTANT", "TEACHER", "PRINCIPAL", "OFFICER", "SPECIALIST", "COORDINATOR",
    "SUPERVISOR", "CLERK", "AIDE", "ENGINEER", "TECHNICIAN", "CASHIER", "BOOKKEEPER",
    "ACCOUNTANT", "AUDITOR", "ANALYST", "ASSOCIATE", "ADMINISTRATOR", "REGISTRAR",
    "LIBRARIAN", "COUNSELOR", "NURSE", "DOCTOR", "PROFESSOR", "INSTRUCTOR",
    "EXECUTIVE", "SECRETARY", "MANAGER", "HEAD", "CHIEF", "DEPUTY", "SENIOR", "JUNIOR"
];

function isBlacklisted(line) {
    const up = line.toUpperCase();
    return BLACKLIST.some(bl => up.includes(bl));
}

function looksLikeName(str) {
    if (!str || str.length < 4 || str.length > 80) return false;
    if (isBlacklisted(str)) return false;
    const words = str.trim().split(/\s+/);
    if (words.length < 2 || words.length > 6) return false;

    // FIX #10: Improved regex to support:
    //   - Suffixes like Jr., Sr., III, II, IV
    //   - Mixed-case names
    //   - Filipino characters (Ñ, accented vowels)
    const suffixes = /^(Jr|Sr|II|III|IV|V|Phd|Rn|Md)\.?$/i;
    return words.every(w =>
        /^[A-ZÑÁÉÍÓÚ][a-zA-ZÑñÁáÉéÍíÓóÚú0-9\-]*\.?$/.test(w) || suffixes.test(w)
    );
}

async function extractCertificateName(bytes, pageIndex) {
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const debugLines = [];

    const rawItems = content.items.map(x => ({
        str: x.str,
        y: x.transform ? Math.round(x.transform[5]) : 0,
        x: x.transform ? Math.round(x.transform[4]) : 0,
        height: x.height || 0,
    }));

    // Group by Y (±5px tolerance)
    const lineMap = new Map();
    for (const item of rawItems) {
        let foundY = null;
        for (const [ky] of lineMap) {
            if (Math.abs(ky - item.y) <= 5) { foundY = ky; break; }
        }
        const key = foundY !== null ? foundY : item.y;
        if (!lineMap.has(key)) lineMap.set(key, []);
        lineMap.get(key).push(item);
    }

    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
    const lines = sortedYs.map(y => {
        const items = lineMap.get(y).sort((a, b) => a.x - b.x);
        return {
            text: items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(),
            y,
            height: Math.max(...items.map(i => i.height))
        };
    }).filter(l => l.text.length > 0);

    lines.forEach(l => debugLines.push(`[y=${l.y} h=${l.height.toFixed(1)}] "${l.text}"`));

    // Strategy 1: Context-based — line after "presented to"
    const TRIGGERS = ["presented to", "this certificate is presented", "is presented to", "presented  to"];
    let contextName = null;

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.toLowerCase();
        if (TRIGGERS.some(p => t.includes(p))) {
            for (let j = i + 1; j < lines.length; j++) {
                const candidate = lines[j].text.trim();
                if (candidate.length > 0) {
                    if (!isBlacklisted(candidate)) {
                        contextName = candidate;
                        debugLines.push(`  🎯 CONTEXT MATCH: "${candidate}"`);
                    }
                    break;
                }
            }
            break;
        }
    }

    if (contextName) {
        debugLines.push(`  🏆 CHOSEN (context): "${contextName}"`);
        return { name: sanitizeFilename(contextName), debugLines };
    }

    // Strategy 2: Height-based scoring fallback
    debugLines.push(`  ⚠️ Falling back to height scoring`);
    let best = null, bestScore = -1;

    for (const line of lines) {
        const t = line.text.trim();
        if (!looksLikeName(t)) continue;

        let score = line.height * 2;
        if (/^[A-ZÑÁÉÍÓÚ][A-ZÑÁÉÍÓÚa-záéíóú\-]*\s+[A-ZÑÁÉÍÓÚ][A-ZÑÁÉÍÓÚa-záéíóú\-]*\.\s+[A-ZÑÁÉÍÓÚ]/.test(t)) score += 50;
        if (t.split(/\s+/).length === 3) score += 20;
        if (t.split(/\s+/).length === 2) score += 10;

        debugLines.push(`  ✅ CANDIDATE: "${t}" (score=${score.toFixed(1)})`);
        if (score > bestScore) { bestScore = score; best = t; }
    }

    debugLines.push(best ? `  🏆 CHOSEN (height): "${best}"` : `  ❌ No name detected.`);
    return { name: best ? sanitizeFilename(best) : null, debugLines };
}

function sanitizeFilename(name) {
    return name
        // Transliterate special chars to ASCII before sanitizing
        .replace(/[Ññ]/g, 'N')
        .replace(/[ÁáÀàÂâÄä]/g, 'A')
        .replace(/[ÉéÈèÊêËë]/g, 'E')
        .replace(/[ÍíÌìÎîÏï]/g, 'I')
        .replace(/[ÓóÒòÔôÖö]/g, 'O')
        .replace(/[ÚúÙùÛûÜü]/g, 'U')
        .replace(/[^a-zA-Z0-9 _\-\.]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .trim();
}

// ── ZIP Download ─────────────────────────────────────────
async function downloadZip() {
    if (!outputFiles.length) return;
    showToast('⏳ Creating ZIP…', 'info');
    const zip = new JSZip();
    outputFiles.forEach(f => zip.file(f.name, f.bytes));
    const blob = await zip.generateAsync({ type: 'blob' });

    // Name ZIP after workshop if one is selected
    let zipName = 'certificates.zip';
    if (selectedWorkshop && selectedWorkshop.title) {
        const safe = selectedWorkshop.title
            .replace(/[^a-zA-Z0-9 _\-]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .substring(0, 60)
            .replace(/_+$/g, '');
        zipName = `${safe}_certificates.zip`;
    }

    saveAs(blob, zipName);
    showToast('✅ ZIP downloaded!', 'success');
}

// ── UI Helpers ───────────────────────────────────────────
function splitterShowProgress(pct, label, msg) {
    document.getElementById('progressSection').classList.add('visible');
    document.getElementById('progressLabel').textContent = label;
    document.getElementById('progressPct').textContent = pct + '%';
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressMsg').textContent = msg;
}
function splitterHideProgress() { document.getElementById('progressSection').classList.remove('visible'); }

// FIX #2 & #3: Revoke old blob URLs before creating new ones to prevent memory leaks
function revokeBlobUrls() {
    blobUrls.forEach(url => URL.revokeObjectURL(url));
    blobUrls = [];
}

function showResults(outputs) {
    revokeBlobUrls(); // Clean up any previous blob URLs

    document.getElementById('resultsSection').classList.add('visible');
    document.getElementById('resultsDivider').style.display = '';
    document.getElementById('resultsCount').textContent = outputs.length;

    // Build match lookup for badge colouring
    const participantNorms = workshopParticipants.map(p => normaliseName(p.full_name || ''));

    document.getElementById('resultsList').innerHTML = outputs.map((out, i) => {
        const blob = new Blob([out.bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        blobUrls.push(url); // Track for later cleanup

        const fileNorm = normaliseName(out.name.replace(/\.pdf$/i, ''));
        const isMatched = workshopParticipants.length > 0
            && participantNorms.some(pn => namesMatch(pn, fileNorm));
        const matchBadge = workshopParticipants.length > 0
            ? (isMatched
                ? `<span class="result-match-badge matched" title="Name matched to a workshop participant"><i class="fa-solid fa-check"></i> Matched</span>`
                : `<span class="result-match-badge unmatched" title="No matching participant found"><i class="fa-solid fa-question"></i> Unmatched</span>`)
            : '';

        return `
                <div class="result-item${isMatched ? ' result-item--matched' : ''}">
                    <div class="result-num">${i + 1}</div>
                    <div class="result-name" title="${out.name}">
                        <i class="fa-solid fa-file-pdf" style="color:#dc2626;margin-right:6px;"></i>${out.name}
                    </div>
                    ${matchBadge}
                    <a class="result-download" href="${url}" download="${out.name}">
                        <i class="fa-solid fa-download"></i> Save
                    </a>
                </div>`;
    }).join('');

    // Remove any leftover "Save Matched" button from a previous session
    const existingBtn = document.getElementById('saveMatchedBtn');
    if (existingBtn) existingBtn.remove();
}

function clearResults() {
    revokeBlobUrls(); // FIX #3: Clean up blob URLs when clearing results
    document.getElementById('resultsSection').classList.remove('visible');
    document.getElementById('resultsDivider').style.display = 'none';
    document.getElementById('resultsList').innerHTML = '';
    document.getElementById('debugPanel').style.display = 'none';
    document.getElementById('debugOutput').textContent = '';
}

function showError(msg) {
    document.getElementById('errorMsg').textContent = msg;
    document.getElementById('errorBox').classList.add('visible');
}
function hideError() { document.getElementById('errorBox').classList.remove('visible'); }

function resetStats() {
    ['statPages', 'statSplit', 'statNamed'].forEach(id => {
        document.getElementById(id).textContent = '—';
    });
}
