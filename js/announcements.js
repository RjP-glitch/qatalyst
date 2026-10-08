const API_URL = CONFIG.API_URL;

let allAnnouncements = [];
let editingId = null;
let canManage = false;

/**
 * Hide/disable management-only controls (New button, filters that only
 * matter for drafts, etc.) for users who can view but not manage.
 * Row-level controls (pin/status/edit/delete) are handled in renderTable().
 */
function applyManageUiVisibility() {
    const newBtn = document.querySelector('.ann-toolbar .btn-primary');
    if (newBtn) newBtn.style.display = canManage ? '' : 'none';

    const statusFilter = document.getElementById('statusFilter');
    if (statusFilter && !canManage) {
        // Non-managers only ever see published items, so the status filter
        // (draft/archived) is meaningless — hide it instead of confusing them.
        statusFilter.style.display = 'none';
    }
}

// ─── Bootstrap ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async function () {
    await checkAuthentication();
    document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);
});

// ─── Auth + permission gate (mirrors dashboard.js's checkAuthentication) ──
async function checkAuthentication() {
    try {
        const res = await fetch(`${API_URL}/main-settings.php`, { credentials: 'include' });
        if (!res.ok) { window.location.replace('login.html'); return; }

        const json = await res.json();
        if (!json.success) { window.location.replace('login.html'); return; }

        if (json.data) {
            if (json.data.full_name) localStorage.setItem('full_name', json.data.full_name);
            if (json.data.email) localStorage.setItem('email', json.data.email);
            if (json.data.role) localStorage.setItem('role', json.data.role);
            if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
            if (Array.isArray(json.data.permissions)) {
                localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
            }
            if (json.data.full_name) {
                setText('sidebarUserName', json.data.full_name);
                setText('sidebarUserEmail', json.data.email || '');
                setText('sidebarAvatar', getInitial(json.data.full_name));
            }
            setSidebarAvatar(json.data);
        }

        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }
    } catch (e) {
        console.warn('Session validation error:', e);
        window.location.replace('login.html');
        return;
    }

    if (typeof Permissions !== 'undefined') {
        await Permissions.loadRolePermissions();
        Permissions.applyNavPermissions();
    }

    canManage = (typeof Permissions !== 'undefined') && Permissions.has('announcements');
    applyManageUiVisibility();

    loadAnnouncements();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function getInitial(name) {
    if (!name) return 'U';
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : 'U';
}

/**
 * Renders the sidebar avatar photo, matching dashboard.js's behavior:
 * uses json.data.profile_picture if present, otherwise leaves the
 * text initial (set separately) in place.
 */
function setSidebarAvatar(data) {
    if (!data?.profile_picture) return;
    const avatar = document.getElementById('sidebarAvatar');
    if (avatar) {
        avatar.innerHTML = `<img src="${data.profile_picture}"
            style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
            alt="Profile">`;
    }
}

// ─── Load + render ─────────────────────────────────────────────────────
async function loadAnnouncements() {
    try {
        const res = await fetch(`${API_URL}/announcements.php`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Failed to load');
        allAnnouncements = json.data || [];
        renderTable();
    } catch (e) {
        document.getElementById('annTableBody').innerHTML = `
            <tr><td colspan="7"><div class="empty-state">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <p>Could not load announcements. Please refresh.</p>
            </div></td></tr>`;
        console.error(e);
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
    }
}

function renderTable() {
    const search = (document.getElementById('searchInput').value || '').toLowerCase();
    const statusFilter = document.getElementById('statusFilter').value;
    const audienceFilter = document.getElementById('audienceFilter').value;

    let rows = allAnnouncements.filter(a => {
        if (statusFilter && a.status !== statusFilter) return false;
        if (audienceFilter && a.audience !== audienceFilter) return false;
        if (search && !a.title.toLowerCase().includes(search) && !a.body.toLowerCase().includes(search)) return false;
        return true;
    });

    const tbody = document.getElementById('annTableBody');
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
            <i class="fa-solid fa-bullhorn"></i><p>No announcements found.</p>
        </div></td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(a => `
        <tr>
            <td>
                ${canManage
                    ? `<i class="fa-solid fa-thumbtack ann-pin-icon ${a.is_pinned ? '' : 'inactive'}"
                         title="${a.is_pinned ? 'Unpin' : 'Pin to top'}"
                         onclick="togglePin(${a.id}, ${!a.is_pinned})"></i>`
                    : (a.is_pinned ? '<i class="fa-solid fa-thumbtack ann-pin-icon"></i>' : '')
                }
            </td>
            <td>
                <div class="ann-title-cell">
                    <h4>${escapeHtml(a.title)}</h4>
                    <p>${escapeHtml(a.body)}</p>
                </div>
            </td>
            <td><span class="audience-tag ${a.audience}">${audienceLabel(a.audience)}</span></td>
            <td>
                ${canManage
                    ? `<select class="status-badge status-${a.status}" style="border:none;cursor:pointer;"
                              onchange="changeStatus(${a.id}, this.value)">
                        <option value="draft" ${a.status === 'draft' ? 'selected' : ''}>DRAFT</option>
                        <option value="published" ${a.status === 'published' ? 'selected' : ''}>PUBLISHED</option>
                        <option value="archived" ${a.status === 'archived' ? 'selected' : ''}>ARCHIVED</option>
                       </select>`
                    : `<span class="status-badge status-${a.status || 'published'}">${(a.status || 'published').toUpperCase()}</span>`
                }
            </td>
            <td class="ann-schedule-cell">
                ${a.starts_at ? `From: ${formatDateTime(a.starts_at)}<br>` : ''}
                ${a.expires_at ? `Until: ${formatDateTime(a.expires_at)}` : (a.starts_at ? '' : 'No schedule')}
            </td>
            <td>${escapeHtml(a.created_by_name || '—')}</td>
            <td>
                ${canManage ? `
                <div class="action-buttons">
                    <button class="btn-icon btn-edit" title="Edit" onclick="openEditModal(${a.id})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-icon btn-delete" title="Delete" onclick="deleteAnnouncement(${a.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>` : ''}
            </td>
        </tr>
    `).join('');
}

function audienceLabel(a) {
    return { all: 'All', sdo_only: 'SDO Only', school_only: 'School Only' }[a] || a;
}

function formatDateTime(dt) {
    if (!dt) return '';
    return new Date(dt.replace(' ', 'T')).toLocaleString('en-PH', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

// ─── Modal ───────────────────────────────────────────────────────────
function openCreateModal() {
    editingId = null;
    document.getElementById('annModalTitle').textContent = 'New Announcement';
    document.getElementById('annId').value = '';
    document.getElementById('annTitle').value = '';
    document.getElementById('annBody').value = '';
    document.getElementById('annAudience').value = 'all';
    document.getElementById('annStatus').value = 'draft';
    document.getElementById('annStartsAt').value = '';
    document.getElementById('annExpiresAt').value = '';
    document.getElementById('annPinned').checked = false;
    document.getElementById('annModal').classList.add('active');
}

function openEditModal(id) {
    const a = allAnnouncements.find(x => x.id === id);
    if (!a) return;
    editingId = id;
    document.getElementById('annModalTitle').textContent = 'Edit Announcement';
    document.getElementById('annId').value = a.id;
    document.getElementById('annTitle').value = a.title;
    document.getElementById('annBody').value = a.body;
    document.getElementById('annAudience').value = a.audience;
    document.getElementById('annStatus').value = a.status;
    document.getElementById('annStartsAt').value = toLocalInputValue(a.starts_at);
    document.getElementById('annExpiresAt').value = toLocalInputValue(a.expires_at);
    document.getElementById('annPinned').checked = !!a.is_pinned;
    document.getElementById('annModal').classList.add('active');
}

function toLocalInputValue(dt) {
    if (!dt) return '';
    const d = new Date(dt.replace(' ', 'T'));
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeAnnModal() {
    document.getElementById('annModal').classList.remove('active');
}

async function submitAnnouncement() {
    const title = document.getElementById('annTitle').value.trim();
    const body = document.getElementById('annBody').value.trim();
    if (!title || !body) {
        alert('Title and message are required.');
        return;
    }

    const payload = {
        title,
        body,
        audience: document.getElementById('annAudience').value,
        status: document.getElementById('annStatus').value,
        is_pinned: document.getElementById('annPinned').checked,
        starts_at: document.getElementById('annStartsAt').value || null,
        expires_at: document.getElementById('annExpiresAt').value || null,
    };

    const btn = document.getElementById('annSubmitBtn');
    btn.disabled = true;

    try {
        let res;
        if (editingId) {
            payload.id = editingId;
            res = await fetch(`${API_URL}/announcements.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
        } else {
            res = await fetch(`${API_URL}/announcements.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
        }
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Save failed');

        closeAnnModal();
        await loadAnnouncements();
    } catch (e) {
        alert(e.message || 'Something went wrong. Please try again.');
    } finally {
        btn.disabled = false;
    }
}

async function changeStatus(id, status) {
    try {
        const res = await fetch(`${API_URL}/announcements.php?action=status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id, status }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        await loadAnnouncements();
    } catch (e) {
        alert('Could not update status.');
        await loadAnnouncements();
    }
}

async function togglePin(id, pinned) {
    try {
        const res = await fetch(`${API_URL}/announcements.php?action=pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id, is_pinned: pinned }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        await loadAnnouncements();
    } catch (e) {
        alert('Could not update pin status.');
    }
}

async function deleteAnnouncement(id) {
    if (!confirm('Delete this announcement? This cannot be undone.')) return;
    try {
        const res = await fetch(`${API_URL}/announcements.php?id=${id}`, {
            method: 'DELETE',
            credentials: 'include',
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        await loadAnnouncements();
    } catch (e) {
        alert('Could not delete announcement.');
    }
}

// ─── Sidebar (mirrors dashboard.js) ────────────────────────────────────
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
        checklist: 'checklist.html',
        documentssubmittedall: 'documents-submitted-all.html',
        settings: 'main-settings.html',
        users: 'user-management.html',
        directory: 'directory.html',
        auditlogs: 'audit-logs.html',
        announcements: 'announcements.html',
    };
    if (routes[sectionName]) {
        closeMobileSidebar();
        window.location.href = routes[sectionName];
    }
}

function toggleSubmenu(name) {
    const sub = document.getElementById(name + '-submenu');
    const arrow = document.getElementById(name + '-arrow');
    if (!sub) return;
    const expanded = sub.classList.toggle('expanded');
    if (arrow) arrow.classList.toggle('rotate', expanded);
    sub.style.setProperty('max-height', expanded ? sub.scrollHeight + 'px' : '0px', 'important');
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
        await fetch(`${API_URL}/logout.php`, { method: 'POST', credentials: 'include' });
    } catch (_) {}
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type']
        .forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}
