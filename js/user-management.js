const API_URL = typeof CONFIG !== 'undefined'
    ? CONFIG.API_URL
    : (function () {
        try {
            return new URL('api', window.location.href).toString().replace(/\/$/, '');
        } catch (_) {
            return window.location.origin + '/api';
        }
    })();
let allUsers = [];
const userManagementParams = new URLSearchParams(window.location.search);
let notificationUserId = Math.max(0, parseInt(userManagementParams.get('user_id'), 10) || 0);
let approvalReviewUserId = 0;
let currentTab = userManagementParams.get('tab') === 'portal' || notificationUserId ? 'portal' : 'sdo';
let currentPage = 1;
const perPage = 10;
let expandedMenus = {};
let currentRolePermissions = [];

// ==================== LOAD ROLES DYNAMICALLY ====================
let availableRoles = [];
let rolePresetsFromDB = {};

async function loadRoles() {
    try {
        const res = await fetch(`${API_URL}/user_management.php?action=get_roles`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
            availableRoles = json.data.map(r => r.role_name);
            // Build presets map from DB default_permissions
            rolePresetsFromDB = {};
            json.data.forEach(r => {
                rolePresetsFromDB[r.role_name] = Array.isArray(r.default_permissions)
                    ? r.default_permissions
                    : [];
            });
        } else {
            availableRoles = ['admin', 'facilitator', 'evaluator', 'viewer'];
        }
    } catch (e) {
        availableRoles = ['admin', 'facilitator', 'evaluator', 'viewer'];
    }
    populateRoleDropdowns();
}

function populateRoleDropdowns() {
    // Role filter dropdown
    const roleFilter = document.getElementById('roleFilter');
    if (roleFilter) {
        const current = roleFilter.value;
        roleFilter.innerHTML = `<option value="all">All Roles</option>` +
            availableRoles.map(r =>
                `<option value="${r}" ${current === r ? 'selected' : ''}>${capitalize(r)}</option>`
            ).join('');
    }

    // Role select in Add/Edit modal
    // SECURITY: Non-admin users cannot assign the 'admin' role (backend also enforces this)
    const currentUserRole = localStorage.getItem('role') || 'viewer';
    const uRole = document.getElementById('uRole');
    if (uRole) {
        const current = uRole.value;
        const rolesForModal = currentUserRole === 'admin'
            ? availableRoles
            : availableRoles.filter(r => r !== 'admin');
        uRole.innerHTML = `<option value="">Select a role</option>` +
            rolesForModal.map(r =>
                `<option value="${r}" ${current === r ? 'selected' : ''}>${capitalize(r)}</option>`
            ).join('');
    }
}

// All available permissions
const ALL_PERMISSIONS = [
    { key: 'dashboard', label: 'View Dashboard' },
    { key: 'certificates', label: 'Certificates' },
    { key: 'programs', label: 'Manage Programs' },
    { key: 'speakers', label: 'Speaker Roster' },
    { key: 'checklist', label: 'Checklist' },
    { key: 'school_submissions', label: 'School Submissions' },
    { key: 'directory', label: 'Directory' },
    { key: 'users', label: 'User Management' },
    { key: 'audit_logs', label: 'Audit Logs' },
    { key: 'settings', label: 'System Settings' }
];

// Role presets
const ROLE_PRESETS = {
    admin: ALL_PERMISSIONS.map(p => p.key),
    facilitator: ['dashboard', 'certificates', 'programs', 'speakers', 'checklist'],
    evaluator: ['dashboard', 'checklist'],
    viewer: ['dashboard']
};

function resolveRolePermissions(role) {
    if (!role) return [];
    if (role === 'admin') return ALL_PERMISSIONS.map(p => p.key);

    const preset = rolePresetsFromDB[role] ?? ROLE_PRESETS[role] ?? [];
    return Array.isArray(preset) ? preset : [];
}

// ==================== INIT ====================
window.addEventListener('DOMContentLoaded', async () => {
    await checkAuthentication();
    renderPermissionsGrid();
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
            if (!Permissions.check('users')) return false;
            Permissions.applyNavPermissions();
        }

        // Block school portal users from accessing SDO dashboard
        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }

        const hasPic = !!json.data.profile_picture;
        loadUserInfo(fullName, email, hasPic);

        if (hasPic) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    alt="Profile">`;
            }
        } else {
            loadProfilePicture();
        }

        loadUsers();
        return true;
    } catch (e) {
        console.warn('Session validation network error:', e);

        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('users')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadProfilePicture();
        loadUsers();
        return true;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.href = 'login.html';
}

function loadUserInfo(fullName, email, hasProfilePic = false) {
    if (!hasProfilePic) {
        const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
        document.getElementById('sidebarAvatar').textContent = initial;
    }
    document.getElementById('sidebarUserName').textContent = fullName || 'User';
    document.getElementById('sidebarUserEmail').textContent = email || '';
}

async function loadProfilePicture() {
    try {
        const res = await fetch(CONFIG.API_URL + '/main-settings.php', {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            avatar.innerHTML = `<img src="${json.data.profile_picture}" 
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" 
                alt="Profile">`;
        }
    } catch (e) { /* silently fail */ }
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


function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ─── Sidebar ──────────────────────────────────────────────────────────
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

// ==================== LOAD USERS ====================
async function loadUsers(type = currentTab) {
    currentTab = type;
    // Highlight active tab
    document.querySelectorAll('.user-tab-btn').forEach(b => b.classList.remove('active'));
    const activeTab = document.getElementById(`tab-${type}`);
    if (activeTab) activeTab.classList.add('active');

    // Hide Add User button for school portal tab — portal users self-register
    const addBtn = document.querySelector('.btn-add-user');
    if (addBtn) addBtn.style.display = type === 'portal' ? 'none' : '';

    try {
        const res = await fetch(`${API_URL}/user_management.php?type=${type}`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success) {
            allUsers = json.data;
            updateStats();
            await loadRoles();
            if (type === 'portal' && notificationUserId) {
                const target = allUsers.find(user => Number(user.id) === notificationUserId);
                notificationUserId = 0;
                if (target) {
                    approvalReviewUserId = Number(target.id);
                    document.getElementById('searchInput').value = target.email;
                }
                else showToast('The school account is no longer available.', 'error');
            }
            filterUsers();
        } else {
            showToast(json.message || 'Failed to load users', 'error');
        }
    } catch (e) {
        showToast('Failed to load users', 'error');
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
    }
}

function updateStats() {
    document.getElementById('statTotal').textContent = allUsers.length;
    document.getElementById('statActive').textContent = allUsers.filter(u => u.status === 'active').length;
    document.getElementById('statInactive').textContent = allUsers.filter(u => u.status === 'inactive').length;
    const adminEl = document.getElementById('statAdmins');
    if (adminEl) {
        if (currentTab === 'portal') {
            adminEl.closest('.stat-card').style.display = 'none';
        } else {
            adminEl.closest('.stat-card').style.display = '';
            adminEl.textContent = allUsers.filter(u => u.role === 'admin').length;
        }
    }
}

// ==================== FILTER & RENDER ====================
function filterUsers() {
    const search = document.getElementById('searchInput').value.toLowerCase();
    if (approvalReviewUserId) {
        const target = allUsers.find(user => Number(user.id) === approvalReviewUserId);
        if (currentTab !== 'portal' || !target || search !== target.email.toLowerCase()) approvalReviewUserId = 0;
    }
    const role = document.getElementById('roleFilter').value;
    const status = document.getElementById('statusFilter').value;

    let filtered = allUsers.filter(u => {
        const matchSearch = approvalReviewUserId ? Number(u.id) === approvalReviewUserId
            : !search || u.full_name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search);
        const matchRole = role === 'all' || u.role === role;
        const matchStatus = status === 'all' || u.status === status;
        return matchSearch && matchRole && matchStatus;
    });

    currentPage = 1;
    renderTable(filtered);
}

function renderTable(users) {
    const tbody = document.getElementById('usersBody');
    const totalPages = Math.ceil(users.length / perPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * perPage;
    const pageUsers = users.slice(start, start + perPage);

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6">
                    <div class="empty-state">
                        <i class="fa-solid fa-users-slash"></i>
                        <h3>No users found</h3>
                        <p>Try adjusting your filters or add a new user</p>
                    </div></td></tr>`;
        document.getElementById('pagination').innerHTML = '';
        return;
    }

    tbody.innerHTML = pageUsers.map(u => {
        const initial = u.full_name ? u.full_name.charAt(0).toUpperCase() : '?';
        const avatarContent = u.profile_picture
            ? `<img src="${u.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${escHtml(u.full_name)}">`
            : initial;
        const roleBadge = `badge-${u.role || 'viewer'}`;
        const statusClass = u.status === 'active' ? 'status-active' : 'status-inactive';
        const toggleIcon = u.status === 'active' ? 'fa-toggle-on' : 'fa-toggle-off';
        const toggleClass = u.status === 'active' ? 'deactivate' : '';
        const toggleTitle = u.status === 'active' ? 'Deactivate' : 'Activate';

        const isPortal = currentTab === 'portal';
        const actions = isPortal
            ? `<div class="action-btns" style="justify-content:flex-end;">
                    <button class="act-btn edit" title="${u.school_approved ? 'Revoke school access' : 'Approve school access'}" aria-label="${u.school_approved ? 'Revoke school access' : 'Approve school access'}" onclick="setSchoolApproval(${u.id}, ${!u.school_approved})"><i class="fa-solid ${u.school_approved ? 'fa-user-lock' : 'fa-user-check'}"></i></button>
                    <button class="act-btn toggle ${toggleClass}" title="${toggleTitle}" onclick="toggleUserStatus(${u.id})"><i class="fa-solid ${toggleIcon}"></i></button>
                    <button class="act-btn delete" title="Delete" onclick="openDeleteModal(${u.id},'${escAttr(u.full_name)}')"><i class="fa-solid fa-trash-can"></i></button>
               </div>`
            : `<div class="action-btns" style="justify-content:flex-end;">
                    <button class="act-btn edit" title="Edit" onclick="editUser(${u.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="act-btn reset" title="Reset Password" onclick="openResetModal(${u.id},'${escAttr(u.full_name)}')"><i class="fa-solid fa-key"></i></button>
                    <button class="act-btn toggle ${toggleClass}" title="${toggleTitle}" onclick="toggleUserStatus(${u.id})"><i class="fa-solid ${toggleIcon}"></i></button>
                    <button class="act-btn delete" title="Delete" onclick="openDeleteModal(${u.id},'${escAttr(u.full_name)}')"><i class="fa-solid fa-trash-can"></i></button>
               </div>`;

        return `<tr>
                    <td>
                        <div class="user-cell" onclick="viewUserDetails(${u.id})" title="View details">
                            <div class="user-cell-avatar">${avatarContent}</div>
                            <div class="user-cell-info">
                                <div class="name">${escHtml(u.full_name)}</div>
                                <div class="email">${escHtml(u.email)}</div>
                                ${isPortal ? `<div class="email">${escHtml(u.school_name || 'No active school linked')} · ${escHtml(u.school_type || '')}${u.district_name ? ' · ' + escHtml(u.district_name) : ''}</div>` : ''}
                            </div>
                        </div>
                    </td>
                    <td><span class="badge ${roleBadge}">${isPortal ? 'School User' : capitalize(u.role || 'viewer')}</span></td>
                    <td><span class="status-badge ${statusClass}"><span class="status-dot"></span> ${capitalize(u.status)}</span>${isPortal ? `<div class="email">${u.school_approved ? 'School access approved' : 'Awaiting SDO approval'}</div>` : ''}</td>
                    <td>${formatDate(u.created_at)}</td>
                    <td>${u.last_login ? formatDate(u.last_login) : '<span style="color:#94a3b8">Never</span>'}</td>
                    <td>${actions}</td>
                </tr>`;
    }).join('');

    // Pagination
    renderPagination(users.length, totalPages);
}

function renderPagination(total, totalPages) {
    const pag = document.getElementById('pagination');
    if (totalPages <= 1) { pag.innerHTML = `<span>Showing ${total} user${total !== 1 ? 's' : ''}</span><div></div>`; return; }

    const start = (currentPage - 1) * perPage + 1;
    const end = Math.min(currentPage * perPage, total);

    let buttons = '';
    buttons += `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>&laquo;</button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - currentPage) > 1) {
            if (i === 3 || i === totalPages - 2) buttons += `<span style="padding:0 6px;color:#94a3b8;">…</span>`;
            continue;
        }
        buttons += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
    }
    buttons += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>&raquo;</button>`;

    pag.innerHTML = `<span>Showing ${start}–${end} of ${total}</span><div class="pagination-buttons">${buttons}</div>`;
}

async function setSchoolApproval(id, approved) {
    const user = allUsers.find(u => Number(u.id) === Number(id));
    if (!user) return;
    if (approved && (!user.email_verified || !user.school_name || user.status !== 'active')) {
        showToast('Approval requires a verified, active account linked to an active school.', 'error');
        return;
    }
    const affiliation = `${user.school_name || 'No school'} (${user.school_type || 'unknown type'})${user.district_name ? ', ' + user.district_name : ''}`;
    if (!confirm(`${approved ? 'Approve' : 'Revoke'} school access for ${user.full_name}?\nSchool: ${affiliation}\n${approved ? 'Confirm that SDO has verified this school affiliation. Approval allows this user to manage the school records and submissions.' : 'This user will keep access to their personal profile.'}`)) return;
    try {
        const res = await fetch(`${API_URL}/user_management.php?action=approve_school&id=${encodeURIComponent(id)}`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Could not update school approval.');
        showToast(data.message, 'success');
        await loadUsers('portal');
        if (typeof NotificationSystem !== 'undefined') await NotificationSystem.fetchNotifications();
    } catch (err) {
        showToast(err.message || 'Could not update school approval.', 'error');
    }
}

function goPage(p) {
    currentPage = p;
    filterUsers();
}

// ==================== PERMISSIONS GRID ====================
function renderPermissionsGrid() {
    const grid = document.getElementById('permissionsGrid');
    if (!grid) return;

    const list = Array.isArray(currentRolePermissions) ? currentRolePermissions : [];
    if (!list.length) {
        grid.innerHTML = '<div class="perm-empty">Select a role to view permissions.</div>';
        return;
    }

    const items = ALL_PERMISSIONS.filter(p => list.includes(p.key));
    grid.innerHTML = items.map(p =>
        `<div class="perm-item"><i class="fa-solid fa-check perm-icon"></i><span>${p.label}</span></div>`
    ).join('');
}

function applyRolePreset() {
    const role = document.getElementById('uRole').value;
    // Use DB-loaded presets first, fall back to hardcoded ROLE_PRESETS
    currentRolePermissions = resolveRolePermissions(role);
    renderPermissionsGrid();
}

function getSelectedPermissions() {
    const role = document.getElementById('uRole').value;
    return resolveRolePermissions(role);
}

function setPermissions(perms) {
    currentRolePermissions = Array.isArray(perms) ? perms : [];
    renderPermissionsGrid();
}

// ==================== ADD / EDIT MODAL ====================
function openModal(uid) {
    document.getElementById('userForm').reset();
    document.getElementById('editUserId').value = '';
    document.getElementById('modalTitle').textContent = 'Add New User';
    document.getElementById('btnSave').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save User';
    document.getElementById('passwordRow').style.display = '';
    document.getElementById('uPassword').required = true;
    document.getElementById('uConfirm').required = true;
    setPermissions([]);
    hideEmailStatus();
    document.getElementById('userModal').classList.add('active');
}

function closeModal() {
    document.getElementById('userModal').classList.remove('active');
    hideEmailStatus();
}

// ==================== VIEW DETAILS MODAL ====================
let detailsUserId = null;

function viewUserDetails(id) {
    const user = allUsers.find(u => u.id === id || u.id === String(id));
    if (!user) return;
    detailsUserId = user.id;

    const initial = user.full_name ? user.full_name.charAt(0).toUpperCase() : '?';
    document.getElementById('detailsAvatar').innerHTML = user.profile_picture
        ? `<img src="${user.profile_picture}" alt="${escHtml(user.full_name)}">`
        : initial;

    document.getElementById('detailsName').textContent = user.full_name || '—';
    document.getElementById('detailsEmail').textContent = user.email || '—';

    document.getElementById('detailsRole').innerHTML =
        `<span class="badge badge-${user.role || 'viewer'}">${capitalize(user.role || 'viewer')}</span>`;
    document.getElementById('detailsStatus').innerHTML =
        `<span class="status-badge ${user.status === 'active' ? 'status-active' : 'status-inactive'}"><span class="status-dot"></span> ${capitalize(user.status)}</span>`;
    document.getElementById('detailsVerified').textContent = user.email_verified ? 'Yes' : 'No';
    document.getElementById('detailsAccountType').textContent = user.account_type ? capitalize(user.account_type) : 'SDO Personnel';
    document.getElementById('detailsCreated').textContent = formatDate(user.created_at);
    document.getElementById('detailsLastLogin').textContent = user.last_login ? formatDate(user.last_login) : 'Never';

    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const permsEl = document.getElementById('detailsPerms');
    if (perms.length === 0) {
        permsEl.innerHTML = '<span class="details-perms-empty">No permissions assigned.</span>';
    } else {
        permsEl.innerHTML = perms.map(key => {
            const p = ALL_PERMISSIONS.find(ap => ap.key === key);
            return `<span class="details-perm-badge">${escHtml(p ? p.label : key)}</span>`;
        }).join('');
    }

    // Hide edit shortcut for the school portal tab (those rows use a different action set)
    document.getElementById('detailsEditBtn').style.display = currentTab === 'portal' ? 'none' : '';

    document.getElementById('detailsModal').classList.add('active');
}

function closeDetailsModal() {
    document.getElementById('detailsModal').classList.remove('active');
    detailsUserId = null;
}

function editFromDetails() {
    const id = detailsUserId;
    closeDetailsModal();
    if (id !== null) editUser(id);
}

function editUser(id) {
    const user = allUsers.find(u => u.id === id || u.id === String(id));
    if (!user) return;
    document.getElementById('userForm').reset();
    document.getElementById('editUserId').value = user.id;
    document.getElementById('modalTitle').textContent = 'Edit User';
    document.getElementById('btnSave').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update User';
    document.getElementById('uFullName').value = user.full_name || '';
    document.getElementById('uEmail').value = user.email || '';
    document.getElementById('uRole').value = user.role || 'viewer';
    document.getElementById('uStatus').value = user.status || 'active';
    // Hide password fields when editing
    document.getElementById('passwordRow').style.display = 'none';
    document.getElementById('uPassword').required = false;
    document.getElementById('uConfirm').required = false;
    applyRolePreset();
    hideEmailStatus();
    document.getElementById('userModal').classList.add('active');
}

// ── Email send status indicator ─────────────────────────────────────────────
// Injected dynamically next to the Save button so it works regardless of the
// modal's exact markup — no HTML changes required.
function getOrCreateEmailStatusEl() {
    let el = document.getElementById('emailSendStatus');
    if (el) return el;

    const btn = document.getElementById('btnSave');
    if (!btn) return null;

    el = document.createElement('div');
    el.id = 'emailSendStatus';
    el.className = 'email-send-status';
    el.innerHTML = `<span class="es-icon"></span><span class="es-text"></span>`;

    // Place it right after the button group so it sits below Save/Cancel.
    const btnGroup = btn.closest('.button-group') || btn.parentElement;
    btnGroup.insertAdjacentElement('afterend', el);
    return el;
}

function setEmailStatus(state, text) {
    const el = getOrCreateEmailStatusEl();
    if (!el) return;

    el.classList.remove('sending', 'success', 'error', 'visible');
    void el.offsetWidth; // restart transition
    el.classList.add(state, 'visible');

    const icon = el.querySelector('.es-icon');
    const label = el.querySelector('.es-text');
    label.textContent = text;

    if (state === 'sending') {
        icon.innerHTML = '<span class="es-spinner"></span>';
    } else if (state === 'success') {
        icon.textContent = '✅';
    } else if (state === 'error') {
        icon.textContent = '⚠️';
    }
}

function hideEmailStatus() {
    const el = document.getElementById('emailSendStatus');
    if (el) el.classList.remove('visible');
}

async function saveUser(e) {
    if (e) e.preventDefault();
    const editId = document.getElementById('editUserId').value;
    const isEdit = !!editId;

    const fullName = document.getElementById('uFullName').value.trim();
    const email = document.getElementById('uEmail').value.trim();
    const role = document.getElementById('uRole').value;

    if (!role) {
        showToast('Please select a role before saving.', 'error');
        document.getElementById('uRole').focus();
        return;
    }
    const status = document.getElementById('uStatus').value;
    const perms = getSelectedPermissions();

    if (!fullName || !email || !role) {
        showToast('Please fill all required fields', 'error');
        return;
    }

    const payload = { full_name: fullName, email, role, status, permissions: perms };

    if (!isEdit) {
        const pw = document.getElementById('uPassword').value;
        const confirm = document.getElementById('uConfirm').value;
        if (!pw || pw.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
        if (pw !== confirm) { showToast('Passwords do not match', 'error'); return; }
        payload.password = pw;
    }

    const btn = document.getElementById('btnSave');
    btn.disabled = true;

    if (!isEdit) {
        setEmailStatus('sending', 'Sending account credentials by email…');
    } else {
        hideEmailStatus();
    }

    try {
        const url = isEdit
            ? `${API_URL}/user_management.php?action=update&id=${editId}`
            : `${API_URL}/user_management.php?action=create`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            if (!isEdit) {
                const emailSent = json.data && json.data.email_sent;
                if (emailSent) {
                    setEmailStatus('success', 'Credentials email sent to ' + email);
                } else {
                    setEmailStatus('error', 'Account created, but the credentials email failed to send');
                }
                showToast(emailSent ? 'User created — credentials emailed' : 'User created, but email failed to send', emailSent ? 'success' : 'error');
                setTimeout(() => {
                    hideEmailStatus();
                    closeModal();
                    loadUsers();
                }, 1600);
            } else {
                showToast('User updated', 'success');
                closeModal();
                loadUsers();
            }
        } else {
            if (!isEdit) setEmailStatus('error', json.message || 'Failed to create user');
            showToast(json.message || 'Failed to save user', 'error');
        }
    } catch (e) {
        if (!isEdit) setEmailStatus('error', 'Network error — could not reach the server');
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ==================== RESET PASSWORD ====================
function openResetModal(id, name) {
    document.getElementById('resetUserId').value = id;
    document.getElementById('resetUserName').textContent = name;
    document.getElementById('resetNewPw').value = '';
    document.getElementById('resetConfirmPw').value = '';
    document.getElementById('resetModal').classList.add('active');
}
function closeResetModal() { document.getElementById('resetModal').classList.remove('active'); }

async function submitResetPassword() {
    const id = document.getElementById('resetUserId').value;
    const pw = document.getElementById('resetNewPw').value;
    const confirm = document.getElementById('resetConfirmPw').value;
    if (!pw || pw.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
    if (pw !== confirm) { showToast('Passwords do not match', 'error'); return; }

    try {
        const res = await fetch(`${API_URL}/user_management.php?action=reset_password&id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ new_password: pw })
        });
        const json = await res.json();
        if (json.success) {
            showToast('Password reset successfully', 'success');
            closeResetModal();
        } else {
            showToast(json.message || 'Reset failed', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ==================== TOGGLE STATUS ====================
async function toggleUserStatus(id) {
    const user = allUsers.find(u => u.id === id || u.id === String(id));
    if (!user) return;
    const newStatus = user.status === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'activate' : 'deactivate';
    if (!confirm(`${capitalize(action)} user "${user.full_name}"?`)) return;

    try {
        const res = await fetch(`${API_URL}/user_management.php?action=toggle_status&id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ status: newStatus })
        });
        const json = await res.json();
        if (json.success) {
            showToast(`User ${action}d`, 'success');
            loadUsers();
        } else {
            showToast(json.message || 'Failed', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ==================== DELETE ====================
function openDeleteModal(id, name) {
    document.getElementById('deleteUserId').value = id;
    document.getElementById('deleteUserName').textContent = name;
    document.getElementById('deleteModal').classList.add('active');
}
function closeDeleteModal() { document.getElementById('deleteModal').classList.remove('active'); }

async function confirmDeleteUser() {
    const id = document.getElementById('deleteUserId').value;
    try {
        const res = await fetch(`${API_URL}/user_management.php?action=delete&id=${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({})
        });
        const json = await res.json();
        if (json.success) {
            showToast('User deleted', 'success');
            closeDeleteModal();
            await loadUsers();
            if (typeof NotificationSystem !== 'undefined') await NotificationSystem.fetchNotifications();
        } else {
            showToast(json.message || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ==================== HELPERS ====================
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function formatDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return d; }
}
function showToast(msg, type) {
    const t = document.getElementById('toast');
    const icon = type === 'error'
        ? '<i class="fa-solid fa-circle-exclamation"></i>'
        : type === 'success'
            ? '<i class="fa-solid fa-circle-check"></i>'
            : '';
    t.innerHTML = `${icon}<span>${msg}</span>`;
    t.className = `dashboard-toast ${type} show`;
    setTimeout(() => t.classList.remove('show'), 4000);
}

// ==================== LOGOUT ====================
async function logout() {
    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (e) { }
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
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
});
