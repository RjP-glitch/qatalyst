const API_BASE = CONFIG.API_URL;
const userId = localStorage.getItem('edu_user_id');
const userEmail = localStorage.getItem('edu_email');
const fullName = localStorage.getItem('edu_full_name');
const role = localStorage.getItem('edu_role') || 'teacher';
const accountType = localStorage.getItem('edu_account_type') || 'portal_user';

let allSubs = [];
let currentFilter = 'all';

function setTextIfExists(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
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

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function getTypeBadge(type) {
    const map = {
        tuition: '<span class="type-tag tuition"><i class="fa-solid fa-money-bill-wave"></i> Tuition Fee</span>',
        calendar: '<span class="type-tag calendar"><i class="fa-solid fa-calendar-alt"></i> School Calendar</span>',
        indorsement: '<span class="type-tag indorsement"><i class="fa-solid fa-envelope-open-text"></i> Indorsement</span>',
    };
    return map[type] || `<span class="type-tag indorsement">${type}</span>`;
}

function getStatusBadge(status) {
    const map = {
        pending: '<span class="status-badge badge-pending">Pending</span>',
        approved: '<span class="status-badge badge-approved">Approved</span>',
        rejected: '<span class="status-badge badge-rejected">Rejected</span>',
        endorsed: '<span class="status-badge badge-endorsed">Endorsed</span>',
        review: '<span class="status-badge badge-review">Under Review</span>',
    };
    return map[status] || `<span class="status-badge badge-pending">${status}</span>`;
}

function getIndTrack(count) {
    if (!count) return '<span style="color:#9ca3af;font-size:11px;">None</span>';
    return [1, 2, 3].map(n => {
        const cls = n < count ? 'done' : (n === count ? 'current' : '');
        return `<div class="ind-dot ${cls}">${n}</div>`;
    }).join('');
}

function renderSubRow(sub, extended = false) {
    return `<tr>
        <td><div class="sub-title-cell">${sub.title || sub.file_name || 'Untitled'}</div></td>
        <td>${getTypeBadge(sub.type)}</td>
        <td><span class="sub-date">${formatDate(sub.submitted_at)}</span></td>
        <td><div class="ind-track">${getIndTrack(sub.indorsement_count)}</div></td>
        <td>${getStatusBadge(sub.status)}</td>
        ${extended ? `<td style="font-size:12px;color:#6b7280;max-width:180px;">${sub.remarks || '—'}</td>` : ''}
    </tr>`;
}

// ── Date/Greeting ─────────────────────────────────────────────────────────────
function initDateTime() {
    const now = new Date();
    const hour = now.getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const first = (fullName || '').split(' ')[0] || 'there';
    document.getElementById('welcomeGreeting').textContent = `${greet}, ${first}!`;
    document.getElementById('welcomeSub').textContent =
        'Submit and track your school documents — tuition fees and school calendars.';
    document.getElementById('dateBig').textContent = now.getDate();
    document.getElementById('dateMonth').textContent = now.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
    document.getElementById('dateDay').textContent = now.toLocaleDateString('en-PH', { weekday: 'long' });
}

// ── Populate sidebar/profile from localStorage ────────────────────────────────
function initUI() {
    const _fullName     = fullName;
    const _userEmail    = userEmail;
    const _role         = role;
    const _schoolName   = localStorage.getItem('edu_school_name')   || '—';
    const _schoolAddress = localStorage.getItem('edu_school_address') || '';
    const _districtName = localStorage.getItem('edu_district_name') || '—';
    const _sidebarLine   = _schoolAddress || _districtName;

    const savedProfilePhoto = localStorage.getItem('edu_profile_picture') || '';
    setSidebarAvatar(savedProfilePhoto, _fullName);
    setTextIfExists('sidebarName', _fullName || _userEmail);
    setTextIfExists('sidebarRole', _role);
    setTextIfExists('profileName', _fullName || '—');
    setTextIfExists('profileRoleBadge', _role);
    setTextIfExists('profileEmail', _userEmail || '—');
    setTextIfExists('pFullName', _fullName || '—');
    setTextIfExists('pEmail', _userEmail || '—');
    setTextIfExists('pRole', _role);
    setTextIfExists('sidebarSchoolName', _schoolName);
    setTextIfExists('sidebarDistrict', _sidebarLine);
    setTextIfExists('pSchool', _schoolName);
    setTextIfExists('pDistrict', _districtName);
}

// ── Load dashboard data ───────────────────────────────────────────────────────
async function loadDashboard() {
    try {
        const res = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message);
        }

        const d = data.data;
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');

        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }

        // ── Save to localStorage ──────────────────────────────────────────────
        localStorage.setItem('edu_user_id',         d.user.id);
        localStorage.setItem('edu_email',           d.user.email);
        localStorage.setItem('edu_full_name',       d.user.full_name);
        localStorage.setItem('edu_role',            d.user.role            || 'teacher');
        localStorage.setItem('edu_account_type',    d.user.account_type    || 'portal_user');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',     d.school?.name         || '');
        localStorage.setItem('edu_district_name',   d.school?.district     || '');
        localStorage.setItem('edu_school_address',  buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city));
        localStorage.setItem('edu_grade',           d.school?.grade        || '');
        localStorage.setItem('edu_school_id_no',    d.school?.school_id_no || '');
        localStorage.setItem('edu_school_type',     d.user.school_type     || ''); // ← required for portal permissions

        // ── Apply UI + permissions now that school_type is saved ──────────────
        initUI();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();

        // Stats
        setTextIfExists('statTotal',     d.stats?.total    ?? 0);
        setTextIfExists('statApproved',  d.stats?.approved ?? 0);
        setTextIfExists('statPending',   d.stats?.pending  ?? 0);
        setTextIfExists('statEndorsed',  d.stats?.endorsed ?? 0);
        setTextIfExists('pStatTotal',    d.stats?.total    ?? 0);
        setTextIfExists('pStatApproved', d.stats?.approved ?? 0);

        if (d.stats?.pending > 0) {
            const b = document.getElementById('pendingBadge');
            if (b) { b.textContent = d.stats.pending; b.style.display = 'inline'; }
        }

        const s = d.school || {};
        const schoolName    = s.name     || localStorage.getItem('edu_school_name')   || userEmail;
        const districtName  = s.district || localStorage.getItem('edu_district_name') || '—';
        const schoolAddress = buildSchoolAddress(s.street_address, s.barangay, s.city) || localStorage.getItem('edu_school_address') || '';
        const sidebarLine    = schoolAddress || districtName;

        setTextIfExists('sidebarSchoolName', schoolName);
        setTextIfExists('sidebarDistrict',   sidebarLine);
        setTextIfExists('pSchool',           schoolName);
        setTextIfExists('pDistrict',         districtName);
        setTextIfExists('pType',             s.type         || '—');
        setTextIfExists('pDepedId',          s.deped_id     || '—');
        setTextIfExists('pGrade',            s.grade        || localStorage.getItem('edu_grade')        || '—');
        setTextIfExists('pSchoolIdNo',       s.school_id_no || localStorage.getItem('edu_school_id_no') || '—');

        // ── Fetch submissions separately ──────────────────────────────────────
        try {
            const subRes  = await fetch(`${API_BASE}/school-portal-submissions.php`, { credentials: 'include' });
            const subData = await subRes.json();
            allSubs = (subData.success && Array.isArray(subData.data?.submissions))
                ? subData.data.submissions
                : [];
        } catch {
            allSubs = [];
        }

        const tbody = document.getElementById('recentSubmissionsBody');
        if (tbody) {
            const recent = allSubs.slice(0, 5);
            tbody.innerHTML = recent.length
                ? recent.map(s => renderSubRow(s, false)).join('')
                : `<tr><td colspan="5"><div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>${d.user.school_approved ? 'No submissions yet.' : 'Submissions become available after SDO approves your school access.'}</p></div></td></tr>`;
        }

        if (document.getElementById('allSubmissionsBody')) {
            renderAllSubmissions();
        }

    } catch (err) {
        console.error(err);
        const tbody = document.getElementById('recentSubmissionsBody');
        if (tbody) {
            tbody.innerHTML =
                `<tr><td colspan="5"><div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not load data. Please refresh.</p></div></td></tr>`;
        }
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
    }
}

function renderAllSubmissions() {
    const tbody = document.getElementById('allSubmissionsBody');
    if (!tbody) return;
    const subs = currentFilter === 'all' ? allSubs : allSubs.filter(sub => sub.type === currentFilter);
    tbody.innerHTML = subs.length
        ? subs.map(s => renderSubRow(s, true)).join('')
        : `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No ${currentFilter === 'all' ? '' : currentFilter + ' '}submissions found.</p></div></td></tr>`;
}

function filterSubs(type) {
    currentFilter = type;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.getElementById(`f-${type}`);
    if (activeBtn) activeBtn.classList.add('active');
    renderAllSubmissions();
}

// ── File upload ───────────────────────────────────────────────────────────────
async function handleUpload(input, type) {
    if (!input.files?.[0]) return;
    const file = input.files[0];

    if (file.size > 10 * 1024 * 1024) {
        showUploadMsg('error', 'File is too large. Maximum size is 10MB.');
        input.value = ''; return;
    }

    showUploadMsg('info', `<i class="fa-solid fa-spinner fa-spin"></i> Uploading "${file.name}"...`);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('type', type);

    try {
        const res = await fetch(`${API_BASE}/school-portal-upload.php`, {
            method: 'POST', credentials: 'include', body: fd
        });
        const data = await res.json();
        if (data.success) {
            showUploadMsg('success', `<i class="fa-solid fa-check-circle"></i> "${file.name}" submitted successfully! Track it in My Submissions.`);
            input.value = '';
            await loadDashboard();
        } else {
            showUploadMsg('error', data.message || 'Upload failed. Please try again.');
        }
    } catch {
        showUploadMsg('error', 'Connection error. Please check your internet and try again.');
    }
}

function showUploadMsg(type, html) {
    const el = document.getElementById('uploadMsg');
    el.className = type; el.innerHTML = html; el.style.display = 'block';
    if (type === 'success') setTimeout(() => el.style.display = 'none', 5000);
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    [
        'edu_user_id', 'edu_email', 'edu_full_name', 'edu_role', 'edu_school_approved','edu_account_type',
        'edu_profile_picture', 'edu_school_name', 'edu_district_id', 'edu_school_id',
        'edu_grade', 'edu_school_id_no', 'edu_district_name', 'edu_school_type',
        'edu_school_address',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
}

// ── Upload modal ──────────────────────────────────────────────────────────────
function openUploadModal() {
    const overlay = document.getElementById('uploadModalOverlay');
    const msgEl = document.getElementById('uploadMsg');
    if (!overlay) return;
    if (msgEl) msgEl.style.display = 'none';
    overlay.classList.add('open');
}

function closeUploadModal(event) {
    if (event && event.target && event.target.id !== 'uploadModalOverlay') return;
    const overlay = document.getElementById('uploadModalOverlay');
    if (overlay) overlay.classList.remove('open');
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const overlay = document.getElementById('uploadModalOverlay');
    if (overlay && overlay.classList.contains('open')) closeUploadModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────
initDateTime();
initUI();
loadDashboard();

// ── Back-button / tab-restore session guard ───────────────────────────────────
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
