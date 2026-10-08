const API_URL = CONFIG.API_URL;

let expandedMenus = {};
let ocrHealthPollTimer = null;
let isOcrPopoverPinned = false;

// ─── Bootstrap ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function () {
    checkAuthentication();
    document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);
    initOcrPopoverInteractions();
});

// ─── Helpers ─────────────────────────────────────────────────────────
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type']
        .forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

// ─── Auth ─────────────────────────────────────────────────────────────
// Validates the session via HttpOnly cookie (sent automatically with credentials: 'include').
async function checkAuthentication() {
    const userId = localStorage.getItem('user_id');
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');

    try {
        const res = await fetch(`${API_URL}/main-settings.php`, {
            credentials: 'include'
        });

        if (!res.ok) {
            clearSessionAndRedirect();
            return;
        }

        const json = await res.json();
        if (!json.success) {
            clearSessionAndRedirect();
            return;
        }

        // Rehydrate client-side session hints from the server session profile
        if (json.data) {
            if (json.data.id) localStorage.setItem('user_id', String(json.data.id));
            if (json.data.full_name) { fullName = json.data.full_name; localStorage.setItem('full_name', json.data.full_name); }
            if (json.data.email) { email = json.data.email; localStorage.setItem('email', json.data.email); }
            if (json.data.role) localStorage.setItem('role', json.data.role);
            if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
            if (Array.isArray(json.data.permissions)) {
                localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
            }
        }

        // Block school portal users from accessing the SDO dashboard
        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }

        // Use the server-confirmed profile picture if available
        if (json.data?.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    alt="Profile">`;
            }
        }

    } catch (e) {
        console.warn('Session validation network error:', e);
        if (!userId) {
            window.location.replace('login.html');
            return;
        }
    }

    // Load dynamic role permissions from user_roles table BEFORE any permission checks
    if (typeof Permissions !== 'undefined') {
        await Permissions.loadRolePermissions();
    }

    // Check if user has dashboard permission — if not, redirect to their first allowed page
    if (typeof Permissions !== 'undefined' && !Permissions.has('dashboard')) {
        const fallbackRoutes = [
            { perm: 'certificates', url: 'certificate.html' },
            { perm: 'programs',     url: 'programs.html' },
            { perm: 'speakers',     url: 'speaker-roster.html' },
            { perm: 'checklist',    url: 'checklist.html' },
            { perm: 'school_submissions', url: 'documents-submitted-all.html' },
            { perm: 'users',        url: 'user-management.html' },
            { perm: 'settings',     url: 'main-settings.html' },
        ];
        const target = fallbackRoutes.find(r => Permissions.has(r.perm));
        window.location.href = target ? target.url : 'login.html';
        return;
    }

    // Session is valid and user has dashboard access — proceed
    if (typeof Permissions !== 'undefined') {
        Permissions.applyNavPermissions();
    }

    loadUserInfo(fullName, email);
    renderWelcomeBanner(fullName);
    initOcrHealthStatus();
    loadDashboardData();
}

function setOcrHealthChipState(state, text, tooltip) {
    const chip = document.getElementById('ocrHealthChip');
    const chipText = document.getElementById('ocrHealthChipText');
    const detailStatus = document.getElementById('ocrHealthDetailStatus');
    const detailReason = document.getElementById('ocrHealthDetailReason');
    const detailCheckedAt = document.getElementById('ocrHealthDetailCheckedAt');
    if (!chip || !chipText) return;

    chip.classList.remove('state-ok', 'state-warning', 'state-error', 'state-muted', 'state-checking');
    chip.classList.add(state);
    chipText.textContent = text;
    chip.title = tooltip || text;

    if (detailStatus) {
        detailStatus.classList.remove('state-ok', 'state-warning', 'state-error', 'state-muted', 'state-checking');
        detailStatus.classList.add(state);
        detailStatus.textContent = text.replace('OCR: ', '');
    }
    if (detailReason) {
        detailReason.textContent = tooltip || text;
    }
    if (detailCheckedAt) {
        detailCheckedAt.textContent = new Date().toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
}

function setOcrPopoverPinned(pinned) {
    const wrap = document.getElementById('ocrHealthWrap');
    const chip = document.getElementById('ocrHealthChip');
    if (!wrap || !chip) return;

    isOcrPopoverPinned = pinned;
    wrap.classList.toggle('pinned', pinned);
    chip.setAttribute('aria-expanded', pinned ? 'true' : 'false');
}

function initOcrPopoverInteractions() {
    const wrap = document.getElementById('ocrHealthWrap');
    const chip = document.getElementById('ocrHealthChip');
    if (!wrap || !chip) return;

    chip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setOcrPopoverPinned(!isOcrPopoverPinned);
    });

    document.addEventListener('click', function (e) {
        if (!isOcrPopoverPinned) return;
        if (!wrap.contains(e.target)) {
            setOcrPopoverPinned(false);
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOcrPopoverPinned) {
            setOcrPopoverPinned(false);
        }
    });
}

async function refreshOcrHealthStatus() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('users')) {
        setOcrHealthChipState('state-muted', 'OCR: No Access', 'Requires users permission to run health checks');
        return;
    }

    setOcrHealthChipState('state-checking', 'OCR: Checking...', 'Checking OCR runtime health');

    try {
        const res = await fetch(`${API_URL}/ocr-health.php`, { credentials: 'include' });

        if (res.status === 403) {
            setOcrHealthChipState('state-muted', 'OCR: No Access', 'Your account cannot run OCR health checks');
            return;
        }

        const json = await res.json();
        if (!res.ok || !json.success) {
            setOcrHealthChipState('state-error', 'OCR: Error', json.message || 'OCR health check failed');
            return;
        }

        const data = json.data || {};
        const shellExecEnabled = !!data.shell_exec_enabled;
        const tesseractCheck = data?.checks?.tesseract || {};
        const ghostscriptCheck = data?.checks?.ghostscript || {};
        const tesseractOk = !!(tesseractCheck.ok ?? tesseractCheck.success);
        const ghostscriptOk = !!(ghostscriptCheck.ok ?? ghostscriptCheck.success);

        const issues = [];
        if (!shellExecEnabled) issues.push('shell_exec is disabled');
        if (!tesseractOk) issues.push('Tesseract unavailable');
        if (!ghostscriptOk) issues.push('Ghostscript unavailable');

        if (shellExecEnabled && tesseractOk && ghostscriptOk) {
            setOcrHealthChipState('state-ok', 'OCR: Healthy', 'Tesseract and Ghostscript are available');
        } else {
            setOcrHealthChipState('state-warning', 'OCR: Issues', issues.join('; ') || 'One or more OCR dependencies are unavailable');
        }
    } catch (e) {
        setOcrHealthChipState('state-error', 'OCR: Offline', 'Network error while checking OCR health');
    }
}

function initOcrHealthStatus() {
    refreshOcrHealthStatus();

    if (ocrHealthPollTimer) {
        clearInterval(ocrHealthPollTimer);
    }
    ocrHealthPollTimer = setInterval(refreshOcrHealthStatus, 120000);
}

function openSettingsSecurity(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    setOcrPopoverPinned(false);
    window.location.href = 'main-settings.html#security';
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    const avatar = document.getElementById('sidebarAvatar');
    if (avatar && !avatar.querySelector('img')) avatar.textContent = initial;
    setText('sidebarUserName', fullName || 'User');
    setText('sidebarUserEmail', email || '');
}

// ─── Welcome Banner ──────────────────────────────────────────────────
function renderWelcomeBanner(fullName) {
    const now = new Date();
    const hour = now.getHours();
    let greeting = 'Good morning';
    if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
    else if (hour >= 17) greeting = 'Good evening';

    setText('welcomeGreeting', `${greeting}, ${fullName || 'User'}!`);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    setText('dateBig', now.getDate());
    setText('dateMonth', `${monthNames[now.getMonth()]} ${now.getFullYear()}`);
    setText('dateDay', dayNames[now.getDay()]);
}

// ─── Load All Dashboard Data ─────────────────────────────────────────
async function loadDashboardData() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    try {
        const [workshopsRes, containerRes, recordsRes, importedRes, totalRes] = await Promise.all([
            fetch(`${API_URL}/workshops.php`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ success: false })),
            fetch(`${API_URL}/programs.php?type=container`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ success: false })),
            fetch(`${API_URL}/records_api.php`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ success: false })),
            fetch(`${API_URL}/imported_responses.php`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ success: false })),
            fetch(`${API_URL}/total_responses.php`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ success: false }))
        ]);

        const workshops = (workshopsRes.success && workshopsRes.data) ? workshopsRes.data : [];
        const containerPrograms = (containerRes.success && Array.isArray(containerRes.data)) ? containerRes.data : [];
        const records = Array.isArray(recordsRes)
            ? recordsRes
            : (recordsRes.records || recordsRes.data || []);
        const importedCount = importedRes.success ? (importedRes.total_responses || 0) : 0;
        const totalResponsesAll = totalRes.success ? (totalRes.total_responses || 0) : 0;

        // Merge for dashboard lists/counters (workshops.php intentionally excludes containers).
        const allPrograms = [...containerPrograms, ...workshops];

        renderSummaryCards(allPrograms, records, importedCount, totalResponsesAll);
        renderRecentWorkshops(allPrograms);
        renderActivityFeed(allPrograms, records);

    } catch (err) {
        console.error('Dashboard load error:', err);
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

// ─── Summary Cards ───────────────────────────────────────────────────
function renderSummaryCards(programs, records, importedCount = 0, totalResponsesAll = null) {
    const totalWorkshops = programs.length;
    const activeWorkshops = programs.filter(w => {
        const status = (w.status || '').toLowerCase();
        const endDate = w.end_date ? new Date(w.end_date) : null;
        if (status === 'ongoing') return true;
        if (!endDate) return false;
        return endDate >= new Date() && status !== 'completed' && status !== 'cancelled';
    }).length;

    const computedResponses = programs.reduce((sum, w) => sum + (parseInt(w.responses_count) || 0), 0);
    const totalResponses = (typeof totalResponsesAll === 'number' && !isNaN(totalResponsesAll))
        ? totalResponsesAll
        : computedResponses;
    const totalRecords = records.length;

    setText('cardWorkshops', totalWorkshops);
    setText('cardActive', activeWorkshops);
    setText('cardResponses', totalResponses.toLocaleString());
    setText('cardImported', importedCount.toLocaleString());
    setText('cardRecords', totalRecords);
}

// ─── Recent Workshops Table ──────────────────────────────────────────
function renderRecentWorkshops(workshops) {
    const tbody = document.getElementById('workshopsBody');
    if (!tbody) return;

    if (!workshops.length) {
        tbody.innerHTML = `<tr><td colspan="5">
            <div class="empty-state">
                <i class="fa-solid fa-calendar-xmark"></i>
                <p>No workshops found</p>
            </div>
        </td></tr>`;
        return;
    }

    const sorted = [...workshops]
        .sort((a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0))
        .slice(0, 8);

    tbody.innerHTML = sorted.map(w => {
        const status = (w.status || 'draft').toLowerCase();
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
        const startDate = w.start_date
            ? new Date(w.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';
        const responses = parseInt(w.responses_count) || 0;
        const titleEscaped = escapeHtml(w.title || 'Untitled');

        return `<tr>
            <td><span class="ws-title" title="${titleEscaped}">${titleEscaped}</span></td>
            <td><span class="ws-date">${startDate}</span></td>
            <td><span class="ws-status ${status}">${statusLabel}</span></td>
            <td class="ws-responses">${responses}</td>
            <td><a class="view-link" onclick="viewWorkshopDashboard(${w.id})">
                <i class="fa-solid fa-arrow-right"></i> View</a>
            </td>
        </tr>`;
    }).join('');
}

// ─── Activity Feed ───────────────────────────────────────────────────
function renderActivityFeed(workshops, records) {
    const list = document.getElementById('activityList');
    if (!list) return;

    const activities = [];

    workshops.forEach(w => {
        const responses = parseInt(w.responses_count) || 0;
        if (responses > 0) {
            activities.push({
                text: `<strong>${escapeHtml(w.title)}</strong> has <strong>${responses}</strong> evaluation response${responses !== 1 ? 's' : ''}`,
                date: w.start_date,
                color: 'blue'
            });
        }
        if ((w.status || '').toLowerCase() === 'ongoing') {
            activities.push({
                text: `<strong>${escapeHtml(w.title)}</strong> is currently <strong>active</strong>`,
                date: w.start_date,
                color: 'green'
            });
        }
    });

    records.slice(0, 5).forEach(r => {
        activities.push({
            text: `Record saved: <strong>${escapeHtml(r.title || 'Untitled')}</strong>`,
            date: r.created_at || r.inclusive_dates,
            color: 'amber'
        });
    });

    activities.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const top = activities.slice(0, 10);

    if (!top.length) {
        list.innerHTML = `<div class="empty-state">
            <i class="fa-solid fa-clock-rotate-left"></i>
            <p>No recent activity</p>
        </div>`;
        return;
    }

    list.innerHTML = top.map(a => {
        const timeAgo = a.date ? formatTimeAgo(new Date(a.date)) : '';
        return `<div class="activity-item">
            <div class="activity-dot ${a.color}"></div>
            <div>
                <div class="activity-text">${a.text}</div>
                ${timeAgo ? `<div class="activity-time">${timeAgo}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ─── Navigation & Actions ────────────────────────────────────────────
function viewWorkshopDashboard(workshopId) {
    window.location.href = `workshop-dashboard.html?workshop_id=${workshopId}`;
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

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ─── Logout ──────────────────────────────────────────────────────────
async function logout() {
    // Prevent double-clicks while the request is in flight
    const btn = document.getElementById('logoutBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Logging out…';
    }

    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (e) {
        // Network errors are intentionally ignored —
        // the cookie expiry on the server handles invalidation,
        // and we always clear local state below.
    } finally {
        clearSessionAndRedirect();
    }
}

// ─── Utilities ───────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimeAgo(date) {
    const now = new Date();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Back-button / bfcache guard ─────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});

        if (typeof Permissions !== 'undefined' && Permissions.has('dashboard')) {
            refreshOcrHealthStatus();
        }
    }
});