const API_BASE = CONFIG.API_URL;
const userEmail = localStorage.getItem('edu_email') || '';
const fullName = localStorage.getItem('edu_full_name') || '';
const role = localStorage.getItem('edu_role') || 'teacher';
let currentPage = 1;
let totalRows = 0;

function setTextIfExists(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function getInitials(name) {
    return (name || '?')
        .split(' ')
        .map((w) => w[0])
        .join('')
        .substring(0, 2)
        .toUpperCase();
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

function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

function initUI() {
    const _fullName = localStorage.getItem('edu_full_name') || fullName;
    const _userEmail = localStorage.getItem('edu_email') || userEmail;
    const _role = localStorage.getItem('edu_role') || role;
    const _schoolName = localStorage.getItem('edu_school_name') || '-';
    const _schoolAddress = localStorage.getItem('edu_school_address') || '';
    const _districtName = localStorage.getItem('edu_district_name') || '-';
    const _sidebarLine = _schoolAddress || _districtName;
    const savedProfilePhoto = localStorage.getItem('edu_profile_picture') || '';

    setSidebarAvatar(savedProfilePhoto, _fullName);
    setTextIfExists('sidebarName', _fullName || _userEmail);
    setTextIfExists('sidebarRole', _role);
    setTextIfExists('sidebarSchoolName', _schoolName);
    setTextIfExists('sidebarDistrict', _sidebarLine);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"]/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
    })[ch]);
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('en-PH', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatActionLabel(action) {
    if (!action) return '-';
    return String(action)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderAuditRows(rows) {
    const tbody = document.getElementById('portalAuditBody');
    if (!tbody) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="portal-audit-empty">
                        <i class="fa-solid fa-inbox"></i>
                        <p>No activity found.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = rows.map((row) => {
        const status = String(row.status || 'success').toLowerCase();
        const statusClass = status.replace(/[^a-z0-9_-]/g, '');
        const docType = row.document_type ? String(row.document_type) : '-';
        const fileName = row.file_name ? String(row.file_name) : '-';
        const desc = row.description ? String(row.description) : '-';
        const actionLabel = formatActionLabel(row.action);
        const moduleLabel = row.module || '-';
        return `
            <tr>
                <td class="portal-audit-meta">${escapeHtml(formatDate(row.created_at))}</td>
                <td class="portal-audit-cell" title="${escapeHtml(actionLabel)}">${escapeHtml(actionLabel)}</td>
                <td class="portal-audit-cell" title="${escapeHtml(moduleLabel)}">${escapeHtml(moduleLabel)}</td>
                <td><span class="portal-audit-status ${statusClass}">${escapeHtml(status)}</span></td>
                <td class="portal-audit-cell" title="${escapeHtml(docType)}">${escapeHtml(docType)}</td>
                <td class="portal-audit-cell" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</td>
                <td class="portal-audit-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</td>
            </tr>
        `;
    }).join('');
}

function getFilters() {
    return {
        search: document.getElementById('portalAuditSearch')?.value.trim() || '',
        action: document.getElementById('portalAuditAction')?.value.trim() || '',
        status: document.getElementById('portalAuditStatus')?.value.trim() || '',
        from: document.getElementById('portalAuditFrom')?.value || '',
        to: document.getElementById('portalAuditTo')?.value || '',
        limit: document.getElementById('portalAuditLimit')?.value || '50'
    };
}

function buildQuery(page = currentPage) {
    const filters = getFilters();
    const params = new URLSearchParams();

    Object.entries(filters).forEach(([key, value]) => {
        if (!value) return;
        if (key === 'limit') return;
        params.append(key, value);
    });

    params.append('page', String(page));
    params.append('limit', String(filters.limit || 50));
    return params.toString();
}

function renderPagination() {
    const pagination = document.getElementById('portalAuditPagination');
    if (!pagination) return;

    const infoEl = pagination.querySelector('.portal-audit-pagination-info');
    const buttonsEl = pagination.querySelector('.portal-audit-pagination-buttons');

    const filters = getFilters();
    const perPage = Number(filters.limit || 50);
    const totalPages = Math.ceil(totalRows / perPage) || 1;

    if (totalPages <= 1) {
        if (infoEl) {
            infoEl.textContent = `Showing ${totalRows} log${totalRows !== 1 ? 's' : ''}`;
        }
        if (buttonsEl) {
            buttonsEl.innerHTML = '';
        }
        return;
    }

    const start = (currentPage - 1) * perPage + 1;
    const end = Math.min(currentPage * perPage, totalRows);

    let buttons = '';
    buttons += `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>&laquo;</button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - currentPage) > 1) {
            if (i === 3 || i === totalPages - 2) buttons += `<span style="padding:0 6px;color:#94a3b8;">...</span>`;
            continue;
        }
        buttons += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
    }
    buttons += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>&raquo;</button>`;

    if (infoEl) {
        infoEl.textContent = `Showing ${start}-${end} of ${totalRows}`;
    }
    if (buttonsEl) {
        buttonsEl.innerHTML = buttons;
    }
}

function goPage(page) {
    const filters = getFilters();
    const perPage = Number(filters.limit || 50);
    const totalPages = Math.ceil(totalRows / perPage) || 1;
    if (page < 1 || page > totalPages) return;
    loadAuditLogs(page);
}

function resetFilters() {
    const ids = [
        'portalAuditSearch',
        'portalAuditAction',
        'portalAuditStatus',
        'portalAuditFrom',
        'portalAuditTo'
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = '';
    });
    const limitEl = document.getElementById('portalAuditLimit');
    if (limitEl) limitEl.value = '50';
    loadAuditLogs(1);
}

async function loadAuditLogs(page = 1) {
    const tbody = document.getElementById('portalAuditBody');
    if (!tbody) return;

    currentPage = page;

    tbody.innerHTML = `
        <tr>
            <td colspan="7">
                <div class="portal-audit-empty">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <p>Loading activity...</p>
                </div>
            </td>
        </tr>
    `;

    try {
        const query = buildQuery(page);
        const res = await fetch(`${API_BASE}/school-portal-activity.php?${query}`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (!json.success) {
            throw new Error(json.message || 'Failed to load activity.');
        }
        renderAuditRows(json.data || []);
        totalRows = json.pagination?.total || 0;
        renderPagination();
    } catch (err) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="portal-audit-empty">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <p>${escapeHtml(err.message || 'Could not load activity.')}</p>
                    </div>
                </td>
            </tr>
        `;
    }
}

async function loadSession() {
    const res = await fetch(`${API_BASE}/school-portal-dashboard.php?source=heartbeat`, {
        credentials: 'include'
    });

    if (res.status === 401) {
        window.location.href = 'school-portal.html';
        return null;
    }

    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Failed to load session.');

    const d = json.data || {};
    if (d.user?.account_type === 'sdo_personnel') {
        window.location.href = 'school-portal.html';
        return null;
    }

    if (d.user?.id) localStorage.setItem('edu_user_id', d.user.id);
    if (d.user?.email) localStorage.setItem('edu_email', d.user.email);
    if (d.user?.full_name) localStorage.setItem('edu_full_name', d.user.full_name);
    localStorage.setItem('edu_role', d.user?.role || 'teacher');
    localStorage.setItem('edu_account_type', d.user?.account_type || 'portal_user');
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');
    localStorage.setItem('edu_profile_picture', d.user?.profile_picture || '');
    localStorage.setItem('edu_school_name', d.school?.name || '');
    localStorage.setItem('edu_school_type', d.user.school_type || '');
    localStorage.setItem('edu_district_name', d.school?.district || '');
    localStorage.setItem('edu_school_address', buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city));
    localStorage.setItem('edu_grade', d.school?.grade || '');
    localStorage.setItem('edu_school_id_no', d.school?.school_id_no || '');

    initUI();
    if (typeof initPortalPermissions === 'function') initPortalPermissions();
    return d; // ← return full data instead of just true
}

async function handleLogout() {
    try {
        await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' });
    } catch (_) {}

    [
        'edu_user_id', 'edu_email', 'edu_full_name', 'edu_role', 'edu_school_approved','edu_account_type',
        'edu_school_name', 'edu_district_id', 'edu_school_id', 'edu_grade',
        'edu_school_id_no', 'edu_district_name', 'edu_school_address', 'edu_school_type'
    ].forEach((k) => localStorage.removeItem(k));

    window.location.replace('school-portal.html');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
}

// ── Pending badge (nav count) ─────────────────────────────────────────────────
async function loadPendingBadge() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            return;
        }

        const d = data.data;

        // Redirect guard
        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }

        // Seed sidebar from API response
        localStorage.setItem('edu_full_name',       d.user.full_name           || '');
        localStorage.setItem('edu_role',            d.user.role                || '');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture     || '');
        localStorage.setItem('edu_school_name',     d.school?.name             || '');
        localStorage.setItem('edu_district_name',   d.school?.district         || '');
        localStorage.setItem('edu_school_address',  buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city));
        initUI();

        // Pending badge
        const pending = d.stats?.pending ?? 0;
        const badge   = document.getElementById('pendingBadge');
        if (badge) {
            badge.textContent   = pending;
            badge.style.display = pending > 0 ? 'inline' : 'none';
        }

    } catch (err) {
        console.error('loadPendingBadge error:', err);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        initUI();
        const d = await loadSession();
        if (d) {
            // Apply pending badge from the session data we already have
            const badge = document.getElementById('pendingBadge');
            if (badge) {
                const count = Number(d.stats?.pending ?? 0);
                badge.textContent = count;
                badge.style.display = count > 0 ? 'inline' : 'none';
            }

            document.getElementById('portalAuditApply')?.addEventListener('click', () => loadAuditLogs(1));
            document.getElementById('portalAuditReset')?.addEventListener('click', resetFilters);
            document.getElementById('portalAuditLimit')?.addEventListener('change', () => loadAuditLogs(1));
            await loadAuditLogs(1);
        }
    } catch (err) {
        const tbody = document.getElementById('portalAuditBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7">
                        <div class="portal-audit-empty">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <p>${escapeHtml(err.message || 'Could not load activity.')}</p>
                        </div>
                    </td>
                </tr>
            `;
        }
    } finally {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
});
