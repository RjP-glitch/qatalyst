const API_URL = CONFIG.API_URL;

let currentPage = 1;
const perPage = 50;
let totalRows = 0;
let hasAccess = false;

window.addEventListener('DOMContentLoaded', async () => {
    await checkAuthentication();
    bindEvents();
    if (hasAccess) {
        loadSubmissions(1);
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

        if ((json.data.role || '').toLowerCase() !== 'admin') {
            showAccessDenied();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            await Permissions.loadRolePermissions();
            Permissions.applyNavPermissions();
            if (Permissions.autoCheckPagePermission) {
                if (!Permissions.autoCheckPagePermission()) return false;
            }
        }

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

    const content = document.getElementById('calendarSubmissionsContent');
    if (!content) return;

    content.innerHTML = `
        <div class="empty-state">
            <i class="fa-solid fa-shield-halved"></i>
            <h3>Access denied</h3>
            <p>Only admin accounts can view this page.</p>
        </div>
    `;
}

function bindEvents() {
    document.getElementById('applyFiltersBtn')?.addEventListener('click', () => loadSubmissions(1));
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetFilters);
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadSubmissions(1);
    });
}

function getFilters() {
    return {
        search: document.getElementById('searchInput')?.value.trim() || '',
        type: document.getElementById('typeFilter')?.value.trim() || '',
        status: document.getElementById('statusFilter')?.value.trim() || ''
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

async function loadSubmissions(page = currentPage) {
    if (!hasAccess) return;

    currentPage = page;
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    try {
        const query = buildQuery(page);
        const res = await fetch(`${API_URL}/admin-calendar-submissions.php?${query}`, {
            credentials: 'include'
        });
        const json = await res.json();

        if (!json.success) {
            showToast(json.message || 'Failed to load submissions', 'error');
            renderEmpty();
            return;
        }

        totalRows = json.pagination?.total || 0;
        renderTable(json.data || []);
        renderPagination();
    } catch (e) {
        showToast('Failed to load submissions', 'error');
        renderEmpty();
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

function renderTable(rows) {
    const tbody = document.getElementById('submissionsBody');
    if (!tbody) return;

    if (!rows.length) {
        renderEmpty();
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const statusClass = (row.status || 'pending').toLowerCase();
        const statusLabel = row.status || 'pending';
        const submitted = formatDate(row.submitted_at);
        const reviewedAt = formatDateTime(row.reviewed_at);
        const reviewedBy = row.reviewed_by_name || '-';
        const schoolLabel = row.school_name || (row.school_id ? `School #${row.school_id}` : '-');
        const fileLink = buildFileLink(row.file_path, row.file_name);
        const typeLabel = formatTypeLabel(row.type);
        const typeClass = getTypeClass(row.type);

        return `
            <tr>
                <td class="mono">${row.id}</td>
                <td>${escapeHtml(schoolLabel)}</td>
                <td><span class="type-pill ${typeClass}">${escapeHtml(typeLabel)}</span></td>
                <td>${escapeHtml(row.title || row.file_name || '—')}</td>
                <td>${fileLink}</td>
                <td>${submitted}</td>
                <td><span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span></td>
                <td>${escapeHtml(reviewedBy)}</td>
                <td>${reviewedAt}</td>
                <td>
                    <div class="status-update-row">
                        <select class="status-select" id="status-${row.id}">
                            ${buildStatusOptions(statusClass)}
                        </select>
                        <button class="status-update-btn" onclick="updateStatus(${row.id})">Update</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function buildStatusOptions(current) {
    const options = [
        { value: 'pending', label: 'pending' },
        { value: 'review', label: 'review' },
        { value: 'endorsed', label: 'endorsed' },
        { value: 'approved', label: 'approved' },
        { value: 'rejected', label: 'rejected' }
    ];

    return options.map(opt => {
        const selected = opt.value === current ? 'selected' : '';
        return `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
    }).join('');
}

function renderEmpty() {
    const tbody = document.getElementById('submissionsBody');
    if (!tbody) return;
    tbody.innerHTML = `
        <tr>
            <td colspan="10">
                <div class="empty-state">
                    <i class="fa-solid fa-inbox"></i>
                    <h3>No submissions found</h3>
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
        pagination.innerHTML = `<span>Showing ${totalRows} submission${totalRows !== 1 ? 's' : ''}</span><div></div>`;
        return;
    }

    const buttons = [];
    const prevDisabled = currentPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

    buttons.push(`<button class="page-btn" ${prevDisabled} onclick="loadSubmissions(${currentPage - 1})">Prev</button>`);

    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, currentPage + 2);
    for (let i = start; i <= end; i++) {
        const active = i === currentPage ? 'active' : '';
        buttons.push(`<button class="page-btn ${active}" onclick="loadSubmissions(${i})">${i}</button>`);
    }

    buttons.push(`<button class="page-btn" ${nextDisabled} onclick="loadSubmissions(${currentPage + 1})">Next</button>`);

    pagination.innerHTML = `
        <span>Page ${currentPage} of ${totalPages} · ${totalRows} total</span>
        <div class="pagination-buttons">${buttons.join('')}</div>
    `;
}

function resetFilters() {
    const search = document.getElementById('searchInput');
    const type = document.getElementById('typeFilter');
    const status = document.getElementById('statusFilter');
    if (search) search.value = '';
    if (type) type.value = '';
    if (status) status.value = '';
    loadSubmissions(1);
}

function formatTypeLabel(value) {
    const map = {
        calendar: 'Calendar',
        tuition: 'Tuition',
        indorsement: 'Indorsement'
    };
    return map[value] || (value ? String(value) : 'Unknown');
}

function getTypeClass(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'calendar' || normalized === 'tuition' || normalized === 'indorsement') {
        return normalized;
    }
    return 'unknown';
}

async function updateStatus(submissionId) {
    const select = document.getElementById(`status-${submissionId}`);
    if (!select) return;
    const nextStatus = select.value;

    const button = select.parentElement?.querySelector('.status-update-btn');
    if (button) button.disabled = true;

    try {
        const res = await fetch(`${API_URL}/school-submission-status.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ submission_id: submissionId, status: nextStatus })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.message || 'Failed to update status');
        }

        showToast('Status updated.', 'success');
        loadSubmissions(currentPage);
    } catch (e) {
        showToast(e.message || 'Failed to update status', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

function buildFileLink(filePath, fileName) {
    if (!filePath) return '—';
    const rawPath = String(filePath || '');
    const calendarPrefix = 'school_calendar_documents:';
    if (rawPath.startsWith(calendarPrefix)) {
        const docId = Number.parseInt(rawPath.slice(calendarPrefix.length), 10);
        if (Number.isFinite(docId) && docId > 0) {
            const label = fileName ? escapeHtml(fileName) : 'calendar_builder.json';
            const href = `${API_URL}/admin-calendar-document.php?document_id=${docId}&download=1`;
            return `<a class="file-link" href="${escapeAttr(href)}" target="_blank" rel="noopener">${label}</a>`;
        }
    }

    const label = fileName ? escapeHtml(fileName) : 'View file';
    const href = escapeAttr(rawPath);
    return `<a class="file-link" href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-PH', {
        month: 'short',
        day: '2-digit',
        year: 'numeric'
    });
}

function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-PH', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>\"]/g, s => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
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

function navigate(sectionName) {
    const routes = {
        dashboard: 'dashboard.html',
        programs: 'programs.html',
        importfile: 'import-excell.html',
        speakers: 'speaker-roster.html',
        certificates: 'certificate.html',
        certificatesplitter: 'certificates-splitter.html',
        checklist: 'checklist.html',
        'calendar-submissions': 'checklist-calendar-submissions.html',
        settings: 'main-settings.html',
        auditlogs: 'audit-logs.html',
        users: 'user-management.html',
        directory: 'directory.html'
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

function toggleSubmenu(menuName) {
    const submenu = document.getElementById(`${menuName}-submenu`);
    const arrow = document.getElementById(`${menuName}-arrow`);
    if (!submenu || !arrow) return;

    submenu.classList.toggle('expanded');
    arrow.classList.toggle('rotate');
    arrow.parentElement.classList.toggle('expanded');
}

function logout() {
    fetch(`${API_URL}/logout.php`, { method: 'POST', credentials: 'include' })
        .finally(() => {
            clearSessionAndRedirect();
        });
}
