const API_BASE    = CONFIG.API_URL;
const userId      = localStorage.getItem('edu_user_id');
const userEmail   = localStorage.getItem('edu_email');
const fullName    = localStorage.getItem('edu_full_name');
const role        = localStorage.getItem('edu_role')         || 'teacher';
const accountType = localStorage.getItem('edu_account_type') || 'portal_user';

// ── Human-readable labels for category_key values ─────────────────────────────
const TRACKER_CATEGORIES = {
    school_calendar:      { label: 'School Calendar',                icon: 'fa-calendar-alt',        color: 'purple' },
    tuition_increase:     { label: 'Tuition Fee Increase',           icon: 'fa-money-bill-trend-up',  color: 'blue'   },
    no_increase:          { label: 'No Tuition Fee Increase',        icon: 'fa-money-bill',           color: 'teal'   },
    renewal_permit:       { label: 'Renewal of Permit',              icon: 'fa-file-shield',          color: 'amber'  },
    app_govt_recognition: { label: 'Application / Govt Recognition', icon: 'fa-landmark',             color: 'rose'   },
    special_order:        { label: 'Special Order',                  icon: 'fa-scroll',               color: 'indigo' },
    special_order_level:  { label: 'Special Order — Level',          icon: 'fa-layer-group',          color: 'indigo' },
    special_programs:     { label: 'Special Programs',               icon: 'fa-star',                 color: 'amber'  },
};

const TRACKER_STEP_ORDER = ['Endorsed to RO', 'Approved', 'Released'];

const TRACKER_STEP_ICONS = {
    'Endorsed to RO': 'fa-paper-plane',
    'Approved':       'fa-circle-check',
    'Released':       'fa-flag-checkered',
};

let trackerData    = null;
let trackerYearId  = null;
let trackerLoading = false;

// ── Avatar ────────────────────────────────────────────────────────────────────
function setPortalAvatars(profilePicture, fullNameValue) {
    const fallback = getInitials(fullNameValue);
    ['sidebarAvatar', 'profileAvatar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = profilePicture ? `<img src="${profilePicture}" alt="Profile photo">` : '';
        if (!profilePicture) el.textContent = fallback;
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getInitials(name) {
    return (name || '?').split(' ').map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

// ── Populate sidebar / profile from localStorage ──────────────────────────────
function initUI() {
    const _fullName     = localStorage.getItem('edu_full_name')      || fullName    || '—';
    const _userEmail    = localStorage.getItem('edu_email')           || userEmail   || '—';
    const _role         = localStorage.getItem('edu_role')            || role        || '—';
    const _schoolName   = localStorage.getItem('edu_school_name')     || '—';
    const _schoolAddress = localStorage.getItem('edu_school_address') || '';
    const _districtName = localStorage.getItem('edu_district_name')   || '—';
    const _sidebarLine   = _schoolAddress || _districtName;
    const _photo        = localStorage.getItem('edu_profile_picture') || '';

    setPortalAvatars(_photo, _fullName);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('sidebarName',       _fullName || _userEmail);
    set('sidebarRole',       _role);
    set('sidebarSchoolName', _schoolName);
    set('sidebarDistrict',   _sidebarLine);
    set('profileName',       _fullName);
    set('profileRoleBadge',  _role);
    set('profileEmail',      _userEmail);
    set('pFullName',         _fullName);
    set('pEmail',            _userEmail);
    set('pRole',             _role);
    set('pSchool',           _schoolName);
    set('pDistrict',         _districtName);
}

// ── Dashboard API ─────────────────────────────────────────────────────────────
async function loadDashboard() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            return;
        }

        const d = data.data;

        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }

        localStorage.setItem('edu_user_id',         d.user.id);
        localStorage.setItem('edu_email',           d.user.email);
        localStorage.setItem('edu_full_name',       d.user.full_name);
        localStorage.setItem('edu_role',            d.user.role            || 'teacher');
        localStorage.setItem('edu_account_type',    d.user.account_type    || 'portal_user');
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',     d.school?.name         || '');
        localStorage.setItem('edu_district_name',   d.school?.district     || '');
        localStorage.setItem('edu_school_address',  buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city));
        localStorage.setItem('edu_grade',           d.school?.grade        || '');
        localStorage.setItem('edu_school_id_no',    d.school?.school_id_no || '');
        localStorage.setItem('edu_school_type', d.user.school_type || '');

        initUI();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();

        const stats = d.stats || {};
        const badge = document.getElementById('pendingBadge');
        if (badge) {
            badge.textContent   = stats.pending ?? 0;
            badge.style.display = (stats.pending ?? 0) > 0 ? 'inline' : 'none';
        }

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
        set('pStatTotal',    stats.total);
        set('pStatApproved', stats.approved);
        const s = d.school || {};
        set('pType',       s.type         || '—');
        set('pDepedId',    s.deped_id     || '—');
        set('pGrade',      s.grade        || localStorage.getItem('edu_grade')        || '—');
        set('pSchoolIdNo', s.school_id_no || localStorage.getItem('edu_school_id_no') || '—');

    } catch (err) {
        console.error('loadDashboard error:', err);
    }
}

// ── Tracker API ───────────────────────────────────────────────────────────────
async function loadTracker(yearId = null) {
    if (trackerLoading) return;
    trackerLoading = true;
    trackerSetLoading(true);

    try {
        const url = yearId
            ? `${API_BASE}/school-portal-tracker.php?year_id=${yearId}`
            : `${API_BASE}/school-portal-tracker.php`;

        const res  = await fetch(url, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            trackerShowError(data.message || 'Could not load tracker.');
            return;
        }

        trackerData   = data.data;
        trackerYearId = data.data.year_id;
        renderTracker(data.data);

    } catch (err) {
        console.error('loadTracker error:', err);
        trackerShowError('Could not load tracker. Please refresh.');
    } finally {
        trackerLoading = false;
        trackerSetLoading(false);
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function trackerSetLoading(on) {
    const el = document.getElementById('trackerContent');
    if (!el || !on) return;
    el.innerHTML = `<div class="tracker-loading">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>Loading document tracker…</span>
    </div>`;
}

function trackerShowError(msg) {
    const el = document.getElementById('trackerContent');
    if (!el) return;
    el.innerHTML = `<div class="tracker-error">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>${msg}</span>
    </div>`;
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

function trackerChangeYear() {
    const sel = document.getElementById('trackerYearSelect');
    if (!sel) return;
    loadTracker(parseInt(sel.value));
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderTracker(d) {
    const el = document.getElementById('trackerContent');
    if (!el) return;

    const checklist = d.checklist || [];

    const sel = document.getElementById('trackerYearSelect');
    if (sel) {
        sel.innerHTML = (d.years || []).map(y =>
            `<option value="${y.id}" ${y.id == d.year_id ? 'selected' : ''}>${y.label || y.school_year}</option>`
        ).join('');
    }

    if (!checklist.length) {
        el.innerHTML = `<div class="tracker-empty">
            <i class="fa-solid fa-folder-open"></i>
            <p>No tracking data found for your school in this school year.<br>
            <span style="font-size:12px;color:#9ca3af;">
                The SDO office manages this tracker. Contact them if you believe this is an error.
            </span></p>
        </div>`;
        return;
    }

    const grouped = {};
    checklist.forEach(row => {
        if (!grouped[row.category_key]) grouped[row.category_key] = {};
        const rowKey = row.row_label || '_';
        if (!grouped[row.category_key][rowKey]) grouped[row.category_key][rowKey] = {};
        grouped[row.category_key][rowKey][row.step_label] = row;
    });

    const total   = checklist.length;
    const checked = checklist.filter(r => r.is_checked).length;
    const pct     = total > 0 ? Math.round((checked / total) * 100) : 0;

    let html = `
        <div class="tracker-summary-bar">
            <div class="tracker-summary-left">
                <span class="tracker-summary-label">Overall Progress</span>
                <span class="tracker-summary-fraction">${checked} / ${total} steps completed</span>
            </div>
            <div class="tracker-summary-right">
                <span class="tracker-pct-badge ${pct === 100 ? 'complete' : pct > 0 ? 'partial' : 'none'}">${pct}%</span>
            </div>
        </div>
        <div class="tracker-progress-track">
            <div class="tracker-progress-fill" style="width:${pct}%"></div>
        </div>`;

    Object.entries(grouped).forEach(([catKey, rowGroups]) => {
        const cfg = TRACKER_CATEGORIES[catKey] || { label: catKey, icon: 'fa-file', color: 'gray' };

        const catRows  = Object.values(rowGroups).flatMap(steps => Object.values(steps));
        const catDone  = catRows.filter(r => r.is_checked).length;
        const catTotal = catRows.length;
        const catPct   = catTotal > 0 ? Math.round((catDone / catTotal) * 100) : 0;
        const allDone  = catDone === catTotal && catTotal > 0;

        html += `
        <div class="tracker-category">
            <div class="tracker-cat-header">
                <div class="tracker-cat-icon tracker-icon-${cfg.color}">
                    <i class="fa-solid ${cfg.icon}"></i>
                </div>
                <div class="tracker-cat-title">
                    <h4>${cfg.label}</h4>
                    <span class="tracker-cat-sub">${catDone} / ${catTotal} steps</span>
                </div>
                <div class="tracker-cat-badge ${allDone ? 'badge-complete' : catDone > 0 ? 'badge-partial' : 'badge-none'}">
                    ${allDone ? '<i class="fa-solid fa-circle-check"></i> Complete' : catPct + '%'}
                </div>
            </div>
            <div class="tracker-cat-body">`;

        Object.entries(rowGroups).forEach(([rowLabel, steps]) => {
            const showRowLabel = rowLabel !== '_' && rowLabel.trim() !== '';
            if (showRowLabel) html += `<div class="tracker-row-label">${rowLabel}</div>`;

            html += `<div class="tracker-steps">`;

            const orderedSteps = [
                ...TRACKER_STEP_ORDER.filter(s => steps[s]),
                ...Object.keys(steps).filter(s => !TRACKER_STEP_ORDER.includes(s)),
            ];

            orderedSteps.forEach((stepLabel, idx) => {
                const row     = steps[stepLabel];
                const isDone  = row?.is_checked;
                const icon    = TRACKER_STEP_ICONS[stepLabel] || 'fa-circle-dot';
                const dateStr = row?.checked_at
                    ? new Date(row.checked_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
                    : null;

                html += `
                    <div class="tracker-step ${isDone ? 'step-done' : 'step-pending'}">
                        <div class="tracker-step-icon">
                            <i class="fa-solid ${isDone ? icon : 'fa-circle'}"></i>
                        </div>
                        <div class="tracker-step-text">
                            <span class="tracker-step-label">${stepLabel}</span>
                            ${dateStr ? `<span class="tracker-step-date">${dateStr}</span>` : ''}
                        </div>
                    </div>
                    ${idx < orderedSteps.length - 1 ? '<div class="tracker-step-connector"></div>' : ''}`;
            });

            html += `</div>`;
        });

        html += `</div></div>`;
    });

    el.innerHTML = html;
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    [
        'edu_user_id','edu_email','edu_full_name','edu_role','edu_school_approved','edu_account_type',
        'edu_school_name','edu_district_id','edu_school_id','edu_grade',
        'edu_school_id_no','edu_district_name','edu_school_address','edu_profile_picture', 'edu_school_type'
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ── Session guard ─────────────────────────────────────────────────────────────
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

// ── Init ──────────────────────────────────────────────────────────────────────
initUI();
if (typeof initPortalPermissions === 'function') initPortalPermissions();
Promise.all([loadDashboard(), loadTracker()]);
