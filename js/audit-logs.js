const API_URL = CONFIG.API_URL;

let currentPage = 1;
const perPage = 50;
let totalRows = 0;
let hasAccess = false;
let expandedMenus = {};

window.addEventListener('DOMContentLoaded', async () => {
    await checkAuthentication();
    bindEvents();
    if (hasAccess) {
        loadLogs(1);
    }
});

async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res = await fetch(`${API_URL}/main-settings.php`, {
            credentials: 'include'
        });

        if (!res.ok) {
            clearSessionAndRedirect();
            return false;
        }

        const json = await res.json();
        if (!json.success || !json.data?.id) {
            clearSessionAndRedirect();
            return false;
        }

        if (json.data.id) localStorage.setItem('user_id', String(json.data.id));
        if (json.data.full_name) {
            fullName = json.data.full_name;
            localStorage.setItem('full_name', json.data.full_name);
        }
        if (json.data.email) {
            email = json.data.email;
            localStorage.setItem('email', json.data.email);
        }
        if (json.data.role) localStorage.setItem('role', json.data.role);
        if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
        if (Array.isArray(json.data.permissions)) {
            localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
        }

        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            await Permissions.loadRolePermissions();
            if (!Permissions.has('audit_logs')) {
                showAccessDenied();
                return false;
            }
            Permissions.applyNavPermissions();
        } else {
            showAccessDenied();
            return false;
        }

        await loadSchools();
        const health = await fetch(`${API_URL}/audit_logs.php?list=health`, { credentials: 'include' }).then(response => response.json()).catch(() => ({ success: false }));
        const notice = document.getElementById('auditIntegrityNotice');
        if (notice) notice.textContent = health.success ? (health.data.history_protected ? 'History protection is active.' : 'History protection needs database setup. Existing history can still be reviewed.') : 'History protection status is unavailable.';
        loadUserInfo(fullName, email, json.data.profile_picture);
        hasAccess = true;
        return true;
    } catch (e) {
        console.warn('Session validation error:', e);
        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }
        showAccessDenied();
        return false;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type']
        .forEach(k => localStorage.removeItem(k));
    window.location.href = 'login.html';
}

function loadUserInfo(fullName, email, profilePicture) {
    const avatar = document.getElementById('sidebarAvatar');
    if (avatar) {
        if (profilePicture) {
            avatar.innerHTML = `<img src="${profilePicture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        } else {
            avatar.textContent = (fullName ? fullName.charAt(0).toUpperCase() : 'U');
        }
    }
    const nameEl = document.getElementById('sidebarUserName');
    const emailEl = document.getElementById('sidebarUserEmail');
    if (nameEl) nameEl.textContent = fullName || 'User';
    if (emailEl) emailEl.textContent = email || '';
}

function showAccessDenied() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';

    const content = document.getElementById('auditContent');
    if (!content) return;

    content.innerHTML = `
        <div class="audit-empty">
            <i class="fa-solid fa-shield-halved" style="font-size:32px;color:#94a3b8;margin-bottom:10px;"></i>
            <h3 style="margin-bottom:6px;color:#0f172a;">Access denied</h3>
            <p>You do not have permission to view audit logs.</p>
        </div>
    `;
}

function bindEvents() {
    document.getElementById('applyFiltersBtn')?.addEventListener('click', () => loadLogs(1));
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetFilters);
    document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);

    document.querySelectorAll('.chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyQuickRange(btn.dataset.range);
        });
    });
}

function applyQuickRange(range) {
    const fromEl = document.getElementById('fromDate');
    const toEl = document.getElementById('toDate');
    if (!fromEl || !toEl) return;

    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();

    if (range === 'clear') {
        fromEl.value = '';
        toEl.value = '';
    } else if (range === 'today') {
        fromEl.value = fmt(today);
        toEl.value = fmt(today);
    } else {
        const days = parseInt(range, 10);
        const past = new Date(today);
        past.setDate(past.getDate() - (days - 1));
        fromEl.value = fmt(past);
        toEl.value = fmt(today);
    }
    loadLogs(1);
}

function getFilters() {
    const rawSchool = document.getElementById('schoolFilter')?.value.trim() || '';
    // schoolFilter option values are encoded as "type:id" (e.g. "private:3")
    // to disambiguate public_schools.id vs private_schools.id collisions.
    let schoolId = '';
    let schoolType = '';
    if (rawSchool) {
        const sepIndex = rawSchool.indexOf(':');
        if (sepIndex !== -1) {
            schoolType = rawSchool.slice(0, sepIndex);
            schoolId = rawSchool.slice(sepIndex + 1);
        } else {
            schoolId = rawSchool; // fallback for unexpected format
        }
    }

    return {
        search: document.getElementById('searchInput')?.value.trim() || '',
        role: document.getElementById('roleFilter')?.value.trim() || '',
        account_type: document.getElementById('accountTypeFilter')?.value || '',
        school_id: schoolId,
        school_type: schoolType,
        action: document.getElementById('actionFilter')?.value.trim() || '',
        module: document.getElementById('moduleFilter')?.value.trim() || '',
        status: document.getElementById('statusFilter')?.value.trim() || '',
        from: document.getElementById('fromDate')?.value || '',
        to: document.getElementById('toDate')?.value || ''
    };
}

function buildQuery(page = currentPage) {
    const filters = getFilters();
    const params = new URLSearchParams();

    Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
    });

    params.append('page', String(page));
    params.append('limit', String(perPage));

    return params.toString();
}

async function loadLogs(page = currentPage) {
    if (!hasAccess) return;

    currentPage = page;
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    try {
        const query = buildQuery(page);
        const res = await fetch(`${API_URL}/audit_logs.php?${query}`, {
            credentials: 'include'
        });
        const json = await res.json();

        if (!json.success) {
            showToast(json.message || 'Failed to load logs', 'error');
            renderEmpty();
            return;
        }

        totalRows = json.pagination?.total || 0;
        renderTable(json.data || []);
        renderPagination();
    } catch (e) {
        showToast('Failed to load logs', 'error');
        renderEmpty();
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

const STATUS_ICONS = {
    success: 'fa-circle-check',
    failed: 'fa-circle-xmark',
    pending: 'fa-clock',
    review: 'fa-magnifying-glass',
    approved: 'fa-check-double',
    rejected: 'fa-ban'
};

function renderTable(rows) {
    const tbody = document.getElementById('auditBody');
    if (!tbody) return;

    if (!rows.length) {
        renderEmpty();
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const statusClass = (row.status || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const statusIcon = STATUS_ICONS[statusClass] || 'fa-circle';
        const rawIp = String(row.ip_address || '-');
        const displayIp = formatIp(rawIp);
        const loopback = isLoopbackIp(displayIp);
        const displayIpHtml = loopback
            ? `${escapeHtml(displayIp)} <span class="ip-badge">Localhost</span>`
            : `${escapeHtml(displayIp)}`;
        const schoolLabel = row.school_name
            ? row.school_name
            : (row.school_id ? `School #${row.school_id}` : '-');
        const description = row.description || '-';

        return `
            <tr class="audit-row" id="row-${row.id}" onclick="toggleDetail(${row.id})">
                <td>
                    <div class="ts-relative" title="${escapeAttr(formatDate(row.created_at))}">${escapeHtml(formatRelative(row.created_at))}</div>
                </td>
                <td>
                    <div class="user-cell">
                        <span class="mono">#${row.user_id ?? '-'}</span>
                        <span>${escapeHtml(row.actor_name || 'Historical user')}</span>
                        <span>${row.account_type === 'portal_user' ? 'School portal' : row.account_type === 'sdo_personnel' ? 'SDO' : 'Historical account'}</span>
                        <span class="role-badge">${escapeHtml(row.role || '-')}</span>
                    </div>
                </td>
                <td class="audit-school" title="${escapeAttr(schoolLabel)}">${escapeHtml(schoolLabel)}</td>
                <td class="event-cell">
                    <span class="action-chip">${escapeHtml(row.action || '-')}</span>
                    <div class="event-module">${escapeHtml(row.module || '-')}</div>
                </td>
                <td><span class="status-pill ${statusClass}"><i class="fa-solid ${statusIcon}"></i> ${escapeHtml(row.status || '-')}</span></td>
                <td class="mono" title="Raw: ${escapeAttr(rawIp)}">${displayIpHtml}</td>
                <td class="audit-desc" title="${escapeAttr(description)}">${escapeHtml(description)}</td>
                <td class="expand-cell"><i class="fa-solid fa-chevron-down expand-icon" id="chevron-${row.id}"></i></td>
            </tr>
            <tr class="detail-row" id="detail-${row.id}" style="display:none;">
                <td colspan="8">
                    <div class="detail-panel">
                        <div class="detail-item">
                            <span class="detail-label">Log ID</span>
                            <span class="detail-value mono">${row.id}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Full timestamp</span>
                            <span class="detail-value">${escapeHtml(formatDate(row.created_at))}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">IP address (raw)</span>
                            <span class="detail-value mono">${escapeHtml(rawIp)}</span>
                        </div>
                        <div class="detail-item detail-desc-full">
                            <span class="detail-label">Description</span>
                            <span class="detail-value">${escapeHtml(description)}</span>
                        </div>
                        <div class="detail-item detail-desc-full">
                            <span class="detail-label">Request reference</span>
                            <span class="detail-value mono">${escapeHtml(row.request_id || 'Not recorded in older logs')}</span>
                        </div>
                        <div class="detail-item audit-change-detail">
                            <span class="detail-label">Record changes</span>
                            <div class="detail-value">${renderAuditChanges(row.details) || 'No field changes recorded for this entry.'}</div>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function toggleDetail(id) {
    const detailRow = document.getElementById(`detail-${id}`);
    const mainRow = document.getElementById(`row-${id}`);
    const chevron = document.getElementById(`chevron-${id}`);
    if (!detailRow) return;

    const isOpen = detailRow.style.display !== 'none';
    detailRow.style.display = isOpen ? 'none' : 'table-row';
    chevron?.classList.toggle('rotate', !isOpen);
    mainRow?.classList.toggle('open', !isOpen);
}

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function formatRelative(value) {
    if (!value) return '-';
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;

    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 45) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return formatDate(value);
}

function formatIp(value) {
    const ip = String(value || '').trim();
    if (!ip || ip === '-') return '-';
    if (ip === '::1') return '127.0.0.1';
    if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
    return ip;
}

function isLoopbackIp(ip) {
    return ip === '127.0.0.1' || ip === '::1';
}

function renderEmpty() {
    const tbody = document.getElementById('auditBody');
    if (!tbody) return;
    tbody.innerHTML = `
        <tr>
            <td colspan="8">
                <div class="empty-state">
                    <i class="fa-solid fa-inbox"></i>
                    <h3>No logs found</h3>
                    <p>Try adjusting your filters.</p>
                </div>
            </td>
        </tr>
    `;
}

function renderPagination() {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;

    const totalPages = Math.ceil(totalRows / perPage) || 1;
    if (totalPages <= 1) {
        pagination.innerHTML = `<span>Showing ${totalRows} log${totalRows !== 1 ? 's' : ''}</span><div></div>`;
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

    pagination.innerHTML = `<span>Showing ${start}-${end} of ${totalRows}</span><div class="pagination-buttons">${buttons}</div>`;
}

function goPage(page) {
    const totalPages = Math.ceil(totalRows / perPage) || 1;
    if (page < 1 || page > totalPages) return;
    loadLogs(page);
}

function resetFilters() {
    const ids = ['searchInput', 'roleFilter', 'accountTypeFilter', 'schoolFilter', 'actionFilter', 'moduleFilter', 'statusFilter', 'fromDate', 'toDate'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'SELECT') {
            el.value = '';
        } else {
            el.value = '';
        }
    });
    document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
    loadLogs(1);
}

function exportCsv() {
    const query = buildQuery(1);
    window.location.href = `${API_URL}/audit_logs.php?export=csv&${query}`;
}

async function loadSchools() {
    const select = document.getElementById('schoolFilter');
    if (!select) return;

    select.innerHTML = '<option value="">All schools</option>';

    try {
        const res = await fetch(`${API_URL}/audit_logs.php?list=schools`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (!json.success || !Array.isArray(json.data)) {
            return;
        }

        const options = json.data.map(school => {
            const id = String(school.id ?? '').trim();
            const name = String(school.name ?? '').trim();
            const type = school.type === 'private' ? 'private' : 'public';
            if (!id || !name) return '';
            const label = type === 'private' ? `${name} (Private)` : name;
            // Encode type alongside id since public_schools.id and private_schools.id
            // are separate sequences and can collide (e.g. both having id=3).
            return `<option value="${escapeAttr(type)}:${escapeAttr(id)}">${escapeHtml(label)}</option>`;
        }).join('');

        select.insertAdjacentHTML('beforeend', options);
    } catch (e) {
        console.warn('Failed to load schools', e);
    }
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[s]);
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
}

function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `dashboard-toast ${type}`;
    toast.style.display = 'block';
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 2500);
}

// ==================== NAVIGATION ====================
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

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

function logout() {
    fetch(`${API_URL}/logout.php`, { method: 'POST', credentials: 'include' })
        .finally(() => {
            clearSessionAndRedirect();
        });
}
