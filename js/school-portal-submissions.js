const API_BASE    = CONFIG.API_URL;
const userId      = localStorage.getItem('edu_user_id');
const userEmail   = localStorage.getItem('edu_email');
const fullName    = localStorage.getItem('edu_full_name');
const role        = localStorage.getItem('edu_role')         || 'teacher';
const accountType = localStorage.getItem('edu_account_type') || 'portal_user';

let allSubs           = [];
let currentFilter     = 'all';
let currentSearchTerm = '';

// ── Avatar ─────────────────────────────────────────────────────────────────────
function setPortalAvatars(profilePicture, fullNameValue) {
    const fallback = getInitials(fullNameValue);
    ['sidebarAvatar', 'profileAvatar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = profilePicture ? `<img src="${profilePicture}" alt="Profile photo">` : '';
        if (!profilePicture) el.textContent = fallback;
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getInitials(name) {
    return (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

// ── Tabs / page header sync ────────────────────────────────────────────────────
const TAB_META = {
    submissions: { title: '<i class="fa-solid fa-folder-open"></i> My Submissions',    subtitle: 'Track the status of your submitted documents' },
    tracker:     { title: '<i class="fa-solid fa-chart-gantt"></i> Document Tracker',  subtitle: 'Monitor document progress in real time' },
};

function showTab(tabName) {
    const key      = String(tabName || '').toLowerCase().trim();
    const targetId = `tab-${key}`;
    const target   = document.getElementById(targetId);
    if (!target) return;

    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    target.classList.add('active');

    const titleEl    = document.getElementById('pageTitle');
    const subtitleEl = document.getElementById('pageSubtitle');
    const meta       = TAB_META[key] || TAB_META.submissions;
    if (titleEl)    titleEl.innerHTML  = meta.title;
    if (subtitleEl) subtitleEl.textContent = meta.subtitle;

    const isMobile = window.matchMedia('(max-width: 800px)').matches;
    if (isMobile) closeSidebar();
}

function initDefaultTab() {
    const defaultTab = document.body?.dataset?.defaultTab || 'submissions';
    showTab(defaultTab);
}

// ── Document type config ───────────────────────────────────────────────────────
const DOC_TYPE_CONFIG = {
    tuition:    { label: 'Tuition Fee Increase',    icon: 'fa-money-bill-trend-up', cssClass: 'tuition'    },
    no_tuition: { label: 'No Tuition Fee Increase', icon: 'fa-money-bill',          cssClass: 'no-tuition' },
    calendar:   { label: 'School Calendar',          icon: 'fa-calendar-alt',        cssClass: 'calendar'   },
    permit:     { label: 'School Permit',            icon: 'fa-file-shield',         cssClass: 'permit'     },
};

function getTypeBadge(type) {
    const cfg = DOC_TYPE_CONFIG[type];
    return cfg
        ? `<span class="type-tag ${cfg.cssClass}"><i class="fa-solid ${cfg.icon}"></i> ${cfg.label}</span>`
        : `<span class="type-tag">${type || 'Unknown'}</span>`;
}

function normalizeSubmissionStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    if (value === 'pending review') return 'pending';
    if (value === 'under review')   return 'review';
    return value;
}

function getStatusBadge(status) {
    const s = normalizeSubmissionStatus(status);
    const map = {
        pending:  '<span class="status-badge badge-pending">Pending</span>',
        approved: '<span class="status-badge badge-approved">Approved</span>',
        rejected: '<span class="status-badge badge-rejected">Rejected</span>',
        endorsed: '<span class="status-badge badge-endorsed">Endorsed</span>',
        review:   '<span class="status-badge badge-review">Under Review</span>',
    };
    return map[s] || `<span class="status-badge badge-pending">${s}</span>`;
}

function getIndTrack(count) {
    if (!count) return '<span style="color:#9ca3af;font-size:11px;">None</span>';
    return [1, 2, 3].map(n => {
        const cls = n < count ? 'done' : n === count ? 'current' : '';
        return `<div class="ind-dot ${cls}">${n}</div>`;
    }).join('');
}

/**
 * Render a single submissions table row.
 *
 * Edit button behaviour per type:
 *  - calendar   → redirect to school-portal-calendar.html (always shown)
 *  - tuition / no_tuition → hidden (show —)
 *  - permit     → normal edit modal (only when canEdit)
 *  - everything else → hidden
 *
 * Delete button behaviour:
 *  - calendar   → locked (managed via Calendar Builder)
 *  - everything else → normal delete
 */
function renderSubRow(sub) {
    const status = String(sub.status || '').toLowerCase().trim();

    const isCalendar = sub.type === 'calendar';
    const isTuition  = sub.type === 'tuition' || sub.type === 'no_tuition';
    const isPermit   = sub.type === 'permit';

    // ── Status groups ────────────────────────────────────────────────────────
    const isReturned = status === 'returned for correction';
    const isApproved = status === 'approved';
    const isLocked   = isApproved;

    // Edit: pending, review, returned for correction
    const canEdit   = status === 'pending' || status === 'review' || isReturned;
    // Delete: ONLY pending or review — returned/approved all lock it
    const canDelete = (status === 'pending' || status === 'review') && !isCalendar && !isTuition;

    const titleArg = JSON.stringify(sub.title || sub.file_name || 'Untitled')
        .replace(/"/g, '&quot;');

    // ── Edit button ──────────────────────────────────────────────────────────
    let editBtn;
    if (isLocked) {
        // Approved / endorsed — no editing allowed for any type
        editBtn = '<span style="color:#d1d5db;font-size:11px;">—</span>';
    } else if (isCalendar && canEdit) {
        // Calendar: pending/review/returned → redirect to Calendar Builder
        editBtn = `<button class="btn btn-outline" style="padding:4px 10px;font-size:11px;"
            onclick="window.location.href='school-portal-calendar.html'"
            title="Manage in School Calendar">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>`;
    } else if (isTuition && canEdit) {
        // Tuition Fee Increase / No Tuition Increase: pending/review/returned → redirect to Tuition Fee tool
        editBtn = `<button class="btn btn-outline" style="padding:4px 10px;font-size:11px;"
            onclick="window.location.href='school-portal-tuition.html'"
            title="Manage in School Tuition Fee">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>`;
    } else if (isPermit && canEdit) {
        // Permit: pending/review/returned → redirect to School Permit tool
        editBtn = `<button class="btn btn-outline" style="padding:4px 10px;font-size:11px;"
            onclick="window.location.href='school-portal-permit.html'"
            title="Manage in School Permit">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>`;
    } else {
        // Everything else (non-editable status) → dash
        editBtn = '<span style="color:#d1d5db;font-size:11px;">—</span>';
    }

    // ── Delete button ────────────────────────────────────────────────────────
    let deleteBtn;
    if (canDelete) {
        deleteBtn = `<button class="btn" style="padding:4px 10px;font-size:11px;background:#fee2e2;color:#dc2626;border:none;"
            onclick="openDeleteModal(${sub.id}, ${titleArg})"
            title="Delete submission">
            <i class="fa-solid fa-trash"></i>
        </button>`;
    } else {
        const lockTitle = isCalendar  ? 'Calendar submissions are managed from the Calendar Builder page.'
            : isTuition  ? 'Tuition fee submissions are managed from the Tuition Fee Builder page.'
            : isApproved ? 'Cannot delete an approved submission.'
            : 'This submission has already been reviewed and cannot be deleted.';
        deleteBtn = `<button class="btn" disabled
            style="padding:4px 10px;font-size:11px;background:#f3f4f6;color:#9ca3af;border:none;cursor:not-allowed;"
            title="${lockTitle}">
            <i class="fa-solid fa-lock"></i>
        </button>`;
    }

    // ── Download button ──────────────────────────────────────────────────────
    let downloadBtn = '';
    if (isPermit && sub.file_path) {
        downloadBtn = `<a class="btn btn-outline" style="padding:4px 10px;font-size:11px;text-decoration:none;"
            href="${encodeURI(sub.file_path)}"
            target="_blank" rel="noopener"
            title="Download file">
            <i class="fa-solid fa-download"></i>
        </a>`;
    } else if (isPermit) {
        downloadBtn = `<button class="btn btn-outline" disabled
            style="padding:4px 10px;font-size:11px;opacity:0.4;cursor:not-allowed;"
            title="No file available">
            <i class="fa-solid fa-download"></i>
        </button>`;
    }

    return `<tr>
        <td><div class="sub-title-cell">${sub.title || sub.file_name || 'Untitled'}</div></td>
        <td>${getTypeBadge(sub.type)}</td>
        <td><span class="sub-date">${formatDate(sub.submitted_at)}</span></td>
        <td><div class="ind-track">${getIndTrack(sub.indorsement_count)}</div></td>
        <td>${getStatusBadge(sub.status)}</td>
        <td style="font-size:12px;color:#6b7280;max-width:180px;">${sub.remarks || '—'}</td>
        <td>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                ${editBtn}
                ${deleteBtn}
                ${downloadBtn}
            </div>
        </td>
    </tr>`;
}

// ── Populate sidebar from localStorage ────────────────────────────────────────
function initUI() {
    const _fullName     = localStorage.getItem('edu_full_name')      || fullName  || '—';
    const _userEmail    = localStorage.getItem('edu_email')           || userEmail || '—';
    const _role         = localStorage.getItem('edu_role')            || role      || '—';
    const _schoolName   = (localStorage.getItem('edu_school_name')   || '').trim() || '—';
    const _schoolAddress = (localStorage.getItem('edu_school_address') || '').trim();
    const _districtName = (localStorage.getItem('edu_district_name') || '').trim() || '—';
    const _sidebarLine   = _schoolAddress || _districtName;
    const _photo        = localStorage.getItem('edu_profile_picture') || '';

    setPortalAvatars(_photo, _fullName);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('sidebarName',       _fullName || _userEmail);
    set('sidebarRole',       _role);
    set('sidebarSchoolName', _schoolName);
    set('sidebarDistrict',   _sidebarLine);
}

// ── API: Dashboard (user + school + stats) ─────────────────────────────────────
async function loadDashboard() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message);
        }

        const d = data.data;

        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }

        const prevSchoolName   = (localStorage.getItem('edu_school_name')   || '').trim();
        const prevDistrictName = (localStorage.getItem('edu_district_name') || '').trim();
        const prevSchoolAddress = (localStorage.getItem('edu_school_address') || '').trim();
        const prevGrade        = (localStorage.getItem('edu_grade')         || '').trim();
        const prevSchoolIdNo   = (localStorage.getItem('edu_school_id_no')  || '').trim();

        const nextSchoolName   = String(d.school?.name         || '').trim() || prevSchoolName;
        const nextDistrictName = String(d.school?.district     || '').trim() || prevDistrictName;
        const nextSchoolAddress = buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city) || prevSchoolAddress;
        const nextGrade        = String(d.school?.grade        || '').trim() || prevGrade;
        const nextSchoolIdNo   = String(d.school?.school_id_no || '').trim() || prevSchoolIdNo;

        localStorage.setItem('edu_user_id',         d.user.id);
        localStorage.setItem('edu_email',           d.user.email);
        localStorage.setItem('edu_full_name',       d.user.full_name);
        localStorage.setItem('edu_role',            d.user.role            || 'teacher');
        localStorage.setItem('edu_account_type',    d.user.account_type    || 'portal_user');
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',     nextSchoolName);
        localStorage.setItem('edu_district_name',   nextDistrictName);
        localStorage.setItem('edu_school_address',  nextSchoolAddress);
        localStorage.setItem('edu_grade',           nextGrade);
        localStorage.setItem('edu_school_id_no',    nextSchoolIdNo);

        initUI();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();

        const stats = d.stats || {};
        const set   = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? 0; };

        const badge = document.getElementById('pendingBadge');
        if (badge) {
            badge.textContent   = stats.pending ?? 0;
            badge.style.display = (stats.pending ?? 0) > 0 ? 'inline' : 'none';
        }

    } catch (err) {
        console.error('loadDashboard error:', err);
    }
}

// ── API: Submissions list ──────────────────────────────────────────────────────
async function loadSubmissions() {
    setSubmissionsLoading(true);
    try {
        const res  = await fetch(`${API_BASE}/school-portal-submissions.php`, { method: 'GET', credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message);
        }

        allSubs = Array.isArray(data.data.submissions) ? data.data.submissions : [];
        renderAllSubmissions();

    } catch (err) {
        console.error('loadSubmissions error:', err);
        const tbody = document.getElementById('allSubmissionsBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not load submissions. Please refresh.</p>
        </div></td></tr>`;
    } finally {
        setSubmissionsLoading(false);
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function setSubmissionsLoading(on) {
    const tbody = document.getElementById('allSubmissionsBody');
    if (!tbody || !on) return;
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <i class="fa-solid fa-spinner fa-spin"></i><p>Loading submissions...</p>
    </div></td></tr>`;
}

// ── Render submissions table ───────────────────────────────────────────────────
function renderAllSubmissions() {
    const tbody = document.getElementById('allSubmissionsBody');
    if (!tbody) return;

    let subs = currentFilter === 'all'
        ? allSubs
        : allSubs.filter(s => s.type === currentFilter);

    if (currentSearchTerm) {
        subs = subs.filter(s => [
            s.title, s.file_name, s.type, s.type_label,
            s.status, s.remarks, formatDate(s.submitted_at),
        ].join(' ').toLowerCase().includes(currentSearchTerm));
    }

    if (!subs.length) {
        const msg = currentSearchTerm
            ? 'No submissions match your search.'
            : currentFilter === 'all'
                ? 'No submissions found.'
                : `No ${DOC_TYPE_CONFIG[currentFilter]?.label ?? currentFilter} submissions found.`;
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
            <i class="fa-solid fa-folder-open"></i><p>${msg}</p>
        </div></td></tr>`;
        return;
    }

    tbody.innerHTML = subs.map(s => renderSubRow(s)).join('');
}

// ── Filter & search ────────────────────────────────────────────────────────────
function filterSubs(type) {
    currentFilter = type;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`f-${type}`);
    if (btn) btn.classList.add('active');
    renderAllSubmissions();
}

function handleSubSearch(value) {
    currentSearchTerm = (value || '').toLowerCase().trim();
    renderAllSubmissions();
}

// ── Delete ─────────────────────────────────────────────────────────────────────
let deletingSubId = null;

function openDeleteModal(id, title) {
    deletingSubId = id;
    const el = document.getElementById('deleteSubTitle');
    if (el) el.textContent = title;
    document.getElementById('deleteModalOverlay').classList.add('open');
}

function closeDeleteModal(event) {
    if (event && event.target.id !== 'deleteModalOverlay') return;
    document.getElementById('deleteModalOverlay').classList.remove('open');
    deletingSubId = null;
}

async function confirmDelete() {
    if (!deletingSubId) return;
    try {
        const res  = await fetch(`${API_BASE}/school-portal-submissions.php?action=delete`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: deletingSubId }),
        });
        const data = await res.json();
        if (!data.success) { alert(data.message || 'Delete failed.'); return; }
        document.getElementById('deleteModalOverlay').classList.remove('open');
        deletingSubId = null;
        await loadSubmissions();
        await loadDashboard();
    } catch {
        alert('Connection error. Please try again.');
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const del = document.getElementById('deleteModalOverlay');
    if (del && del.classList.contains('open')) { closeDeleteModal(); }
});

// ── Logout ──────────────────────────────────────────────────────────────────────
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    [
        'edu_user_id','edu_email','edu_full_name','edu_role','edu_school_approved','edu_account_type',
        'edu_school_name','edu_district_id','edu_school_id','edu_grade',
        'edu_school_id_no','edu_district_name','edu_school_address','edu_profile_picture',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

// ── Mobile sidebar ──────────────────────────────────────────────────────────────
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ── DOM patches ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initDefaultTab();
});

// ── Init ────────────────────────────────────────────────────────────────────────
initUI();
Promise.all([loadDashboard(), loadSubmissions()]);

// ── Session guard ───────────────────────────────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.href = 'school-portal.html'; })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.href = 'school-portal.html'; })
            .catch(() => {});
    }
});
