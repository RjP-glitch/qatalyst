const API_BASE = CONFIG.API_URL;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function formatDate(d) {
    if (!d) return '';
    return new Date(d.replace(' ', 'T')).toLocaleDateString('en-PH', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function parseDbDate(d) {
    if (!d) return null;
    const parsed = new Date(d.replace(' ', 'T'));
    return isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeTime(d) {
    const date = parseDbDate(d);
    if (!date) return '';
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    const diffWeek = Math.round(diffDay / 7);
    if (diffWeek < 5) return `${diffWeek}w ago`;
    return '';
}

function isRecentlyPosted(createdAt) {
    const date = parseDbDate(createdAt);
    if (!date) return false;
    return (Date.now() - date.getTime()) < (48 * 60 * 60 * 1000);
}

function formatExpiryNote(expiresAt) {
    const date = parseDbDate(expiresAt);
    if (!date) return '';
    if (date.getTime() < Date.now()) return '';
    return `Active until ${formatDate(expiresAt)}`;
}

const BODY_TRUNCATE_LENGTH = 320;

function buildStatsBarHtml(items) {
    const total = items.length;
    const pinnedCount = items.filter(a => a.is_pinned).length;
    const mostRecent = items.reduce((latest, a) => {
        const d = parseDbDate(a.created_at);
        return (d && (!latest || d > latest)) ? d : latest;
    }, null);

    return `
        <div class="ann-stat">
            <span class="ann-stat-num">${total}</span>
            <span class="ann-stat-label">${total === 1 ? 'Announcement' : 'Announcements'}</span>
        </div>
        <div class="ann-stat">
            <span class="ann-stat-num">${pinnedCount}</span>
            <span class="ann-stat-label">Pinned</span>
        </div>
        ${mostRecent ? `<div class="ann-stat-updated">Last updated ${formatDate(mostRecent.toISOString())}</div>` : ''}
    `;
}

function buildCardHtml(a) {
    const bodyEscaped = escapeHtml(a.body);
    const needsTruncate = (a.body || '').length > BODY_TRUNCATE_LENGTH;
    const cardId = `ann-body-${a.id}`;
    const expiryNote = formatExpiryNote(a.expires_at);
    const relative = formatRelativeTime(a.created_at);

    return `
        <div class="ann-card ${a.is_pinned ? 'pinned' : ''}">
            <div class="ann-card-header">
                <div class="ann-card-title">
                    ${a.is_pinned ? '<i class="fa-solid fa-thumbtack"></i>' : ''}
                    ${escapeHtml(a.title)}
                    ${isRecentlyPosted(a.created_at) ? '<span class="ann-new-badge">NEW</span>' : ''}
                </div>
                <div class="ann-card-date-block">
                    <div class="ann-card-date">${formatDate(a.created_at)}</div>
                    ${relative ? `<div class="ann-card-relative">${relative}</div>` : ''}
                </div>
            </div>
            <div class="ann-card-body ${needsTruncate ? 'truncated' : ''}" id="${cardId}">${bodyEscaped}</div>
            ${needsTruncate ? `<button type="button" class="ann-read-more" onclick="toggleAnnBody('${cardId}', this)">Show more</button>` : ''}
            ${expiryNote ? `<div class="ann-card-expiry"><i class="fa-regular fa-clock"></i>${escapeHtml(expiryNote)}</div>` : ''}
        </div>
    `;
}

function toggleAnnBody(cardId, btn) {
    const body = document.getElementById(cardId);
    if (!body) return;
    const isTruncated = body.classList.toggle('truncated');
    btn.textContent = isTruncated ? 'Show more' : 'Show less';
}

function renderAnnouncements(items) {
    const list = document.getElementById('announcementsList');
    const statsBar = document.getElementById('annStatsBar');

    if (!items || items.length === 0) {
        statsBar.style.display = 'none';
        list.innerHTML = `
            <div class="ann-empty-state">
                <div class="ann-empty-icon"><i class="fa-solid fa-bullhorn"></i></div>
                <h3>All quiet for now</h3>
                <p>The Schools Division Office hasn't posted any announcements yet. Check back later for updates and notices.</p>
            </div>`;
        return;
    }

    statsBar.style.display = 'flex';
    statsBar.innerHTML = buildStatsBarHtml(items);

    const pinned = items.filter(a => a.is_pinned);
    const rest = items.filter(a => !a.is_pinned);

    let html = '';
    if (pinned.length > 0 && rest.length > 0) {
        html += `<div class="ann-section-label pinned"><span>Pinned</span></div>`;
        html += pinned.map(buildCardHtml).join('');
        html += `<div class="ann-section-label"><span>Recent</span></div>`;
        html += rest.map(buildCardHtml).join('');
    } else {
        // All pinned or all unpinned — a single list reads cleaner without a
        // redundant section label repeating what every card already shows.
        html += items.map(buildCardHtml).join('');
    }

    list.innerHTML = html;
}

async function loadAnnouncements() {
    try {
        const res = await fetch(`${API_BASE}/school-portal-announcements.php`, { credentials: 'include' });
        const json = await res.json();

        if (!json.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(json.message || 'Failed to load');
        }

        renderAnnouncements(json.data || []);
    } catch (e) {
        console.error(e);
        document.getElementById('announcementsList').innerHTML = `
            <div class="ann-empty-state ann-empty-error">
                <div class="ann-empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <h3>Couldn't load announcements</h3>
                <p>Something went wrong on our end. Please refresh the page to try again.</p>
            </div>`;
    } finally {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

// ── Sidebar mobile toggle (mirrors school-portal-dashboard.js) ──────────────
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
}

// ── Avatar helpers (mirrors school-portal-dashboard.js) ─────────────────────
function getInitials(name) {
    return (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

function setSidebarAvatar(profilePicture, fullNameValue) {
    const avatar = document.getElementById('sidebarAvatar');
    if (!avatar) return;
    if (profilePicture) {
        avatar.innerHTML = `<img src="${profilePicture}" alt="Profile photo">`;
        return;
    }
    avatar.textContent = getInitials(fullNameValue);
}

async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch (_) {}
    [
        'edu_user_id', 'edu_email', 'edu_full_name', 'edu_role', 'edu_school_approved','edu_account_type',
        'edu_profile_picture', 'edu_school_name', 'edu_district_id', 'edu_school_id',
        'edu_grade', 'edu_school_id_no', 'edu_district_name', 'edu_school_type',
        'edu_school_address',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

// ── School address helper (mirrors school-portal-dashboard.js) ──────────────
function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

// ── Sidebar rendering (reads current localStorage state) ────────────────────
function renderSidebarInfo() {
    const fullName = localStorage.getItem('edu_full_name');
    const role = localStorage.getItem('edu_role') || '';
    const schoolName = localStorage.getItem('edu_school_name') || '—';
    const schoolAddress = localStorage.getItem('edu_school_address') || '';
    const districtName = localStorage.getItem('edu_district_name') || '—';
    // Prefer the school's street address over the district name; only fall
    // back to district (or the '—' placeholder) if no address is on file.
    const sidebarLine = schoolAddress || districtName;
    const profilePicture = localStorage.getItem('edu_profile_picture') || '';
    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('sidebarName', fullName || localStorage.getItem('edu_email') || 'User');
    el('sidebarRole', role);
    el('sidebarSchoolName', schoolName);
    el('sidebarDistrict', sidebarLine);
    setSidebarAvatar(profilePicture, fullName);
}

// ── Fetch live school/user info instead of trusting stale localStorage ──────
// Mirrors what school-portal-dashboard.js's loadDashboard() does: same
// endpoint, same localStorage keys, just without the stats/submissions
// portion this page doesn't need. localStorage is only used as the
// first-paint cache while this request is in flight, and as an offline
// fallback if it fails.
async function refreshSidebarFromServer() {
    try {
        const res = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) return; // loadAnnouncements() handles 401 redirects

        const d = json.data || {};
        const s = d.school || {};

        if (d.user) {
            localStorage.setItem('edu_school_approved', d.user.school_approved ? '1' : '0');
            localStorage.setItem('edu_full_name', d.user.full_name || '');
            localStorage.setItem('edu_email', d.user.email || '');
            localStorage.setItem('edu_role', d.user.role || 'teacher');
            localStorage.setItem('edu_profile_picture', d.user.profile_picture || '');
            localStorage.setItem('edu_school_type', d.user.school_type || '');
        }
        localStorage.setItem('edu_school_name', s.name || '');
        localStorage.setItem('edu_district_name', s.district || '');
        localStorage.setItem('edu_school_address', buildSchoolAddress(s.street_address, s.barangay, s.city));
        localStorage.setItem('edu_grade', s.grade || '');
        localStorage.setItem('edu_school_id_no', s.school_id_no || '');

        renderSidebarInfo();
        if (typeof applyPortalNav === 'function') applyPortalNav();
    } catch (e) {
        // Network hiccup or endpoint unavailable — keep showing whatever
        // localStorage already had rendered; don't block the page on this.
        console.error('Sidebar refresh failed, falling back to cached info:', e);
    }
}

// Paint immediately from whatever's cached, then refresh from the server.
renderSidebarInfo();
refreshSidebarFromServer();

loadAnnouncements();
