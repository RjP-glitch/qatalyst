const API_URL = CONFIG.API_URL;
let profilePicBase64 = null;
let expandedMenus = {};
let ocrHealthLoaded = false;
let schoolSignatories = [];
let privateSchoolsList = [];
let editingSchoolSignatoryId = null;

// ==================== AUTH ====================
// ─── Bootstrap ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async function () {
    await checkAuthentication();
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
        if (json.data.account_type) {
            localStorage.setItem('account_type', json.data.account_type);
        }
        if (Array.isArray(json.data.permissions)) {
            localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
        }

        if (typeof Permissions !== 'undefined') {
            // Hide admin-only tabs for users without 'settings' permission
            hideAdminTabsIfNoPermission();
            Permissions.applyNavPermissions();
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

        loadProfile();
        return true;
    } catch (e) {
        console.warn('Session validation network error:', e);

        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            hideAdminTabsIfNoPermission();
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadProfilePicture();
        loadProfile();
        return true;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

/**
 * Hide admin-only settings tabs for users without 'settings' permission
 * @param {boolean} force - If true, hide tabs regardless of client-side permission check
 */
function hideAdminTabsIfNoPermission(force = false) {
    if (force || (typeof Permissions !== 'undefined' && !Permissions.has('settings'))) {
        // Hide admin-only tabs
        const adminTabs = ['files', 'rating-scales', 'participant-roles', 'qame-categories', 'supporting-documents', 'permit-checklist'];
        adminTabs.forEach(tabName => {
            const tab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
            const panel = document.getElementById(`panel-${tabName}`);
            if (tab) tab.style.display = 'none';
            if (panel) panel.style.display = 'none';
        });
    }
}

function loadUserInfo(fullName, email, hasProfilePic = false) {
    if (!hasProfilePic) {
        const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
        const avatar = document.getElementById('sidebarAvatar');
        if (avatar) avatar.textContent = initial;
    }
    const userName = document.getElementById('sidebarUserName');
    const userEmail = document.getElementById('sidebarUserEmail');
    if (userName) userName.textContent = fullName || 'User';
    if (userEmail) userEmail.textContent = email || '';
}

// ← add this new function
async function loadProfilePicture() {
    try {
        const res = await fetch(API_URL + '/main-settings.php', {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (!avatar) return;
            avatar.innerHTML = `<img src="${json.data.profile_picture}" 
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" 
                alt="Profile">`;
        }
    } catch (e) {
        // silently fail — just keep the initial letter
    }
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
		auditlogs: 'audit-logs.html'
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

// ==================== TABS ====================
function toggleSettingsNavMobile() {
    const groups = document.getElementById('settingsNavGroups');
    const toggle = document.getElementById('settingsNavMobileToggle');
    if (!groups || !toggle) return;
    groups.classList.toggle('open');
    toggle.classList.toggle('open');
}

function switchTab(tabName) {
    // Prevent switching to admin-only tabs if user doesn't have settings permission
    const adminTabs = ['files', 'rating-scales', 'participant-roles', 'qame-categories', 'signatories', 'supporting-documents', 'permit-checklist'];
    if (adminTabs.includes(tabName) && typeof Permissions !== 'undefined' && !Permissions.has('settings')) {
        return;
    }
    
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    const activeTabBtn = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    activeTabBtn.classList.add('active');
    document.getElementById(`panel-${tabName}`).classList.add('active');

    // Update mobile dropdown label + icon, then collapse the dropdown
    const mobileLabel = document.getElementById('settingsNavCurrentLabel');
    if (mobileLabel) mobileLabel.textContent = activeTabBtn.textContent.trim();
    const mobileIcon = document.querySelector('#settingsNavMobileToggle .settings-nav-mobile-current i');
    const activeIcon = activeTabBtn.querySelector('i');
    if (mobileIcon && activeIcon) mobileIcon.className = activeIcon.className;
    const groups = document.getElementById('settingsNavGroups');
    const toggle = document.getElementById('settingsNavMobileToggle');
    if (groups) groups.classList.remove('open');
    if (toggle) toggle.classList.remove('open');

    if (tabName === 'sessions') loadSessions();
    if (tabName === 'security') ensureOcrHealthVisibility();
    if (tabName === 'files') loadFiles();
    if (tabName === 'rating-scales') loadRatingScales();
    if (tabName === 'user-roles') loadUserRoles();
    if (tabName === 'qame-categories') loadQameCategories();
    if (tabName === 'supporting-documents') loadSupportingDocs();
    if (tabName === 'permit-checklist') loadPermitChecklist();
    if (tabName === 'signatories') {
        loadSignatories();
        loadPrivateSchoolsForSignatories().then(() => {
            toggleSchoolSigScope();
            loadSchoolSignatories();
        });
    }
    if (tabName === 'contact-us') { loadContactInfo(); loadContactSubmissions(); }

    const currentHash = window.location.hash.replace('#', '');
    if (currentHash !== tabName) {
        history.replaceState(null, '', `#${tabName}`);
    }
}

function applyInitialTabFromHash() {
    const tabName = window.location.hash.replace('#', '').trim();
    if (!tabName) return;

    const tab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    const panel = document.getElementById(`panel-${tabName}`);
    if (tab && panel) {
        switchTab(tabName);
    }
}

// ==================== PROFILE ====================
async function loadProfile() {
    try {
        const res = await fetch(`${API_URL}/main-settings.php`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success) {
            const d = json.data;
            document.getElementById('fullName').value = d.full_name || '';
            document.getElementById('email').value = d.email || '';
            document.getElementById('createdAt').value = d.created_at || '';
            document.getElementById('userId').value = d.id || '';
            document.getElementById('toggle2FA').checked = !!d.two_factor;

            // Show 2FA status
            if (d.two_factor) {
                update2FAStatus(true);
            }

            // Profile picture
            if (d.profile_picture) {
                profilePicBase64 = d.profile_picture;
                renderProfilePic(d.profile_picture);
            } else {
                renderProfilePic(null, d.full_name);
            }
        }
    } catch (e) {
    } finally {
        document.getElementById('loadingOverlay').style.display = 'none';
    }
}

function renderProfilePic(base64, name) {
    const preview = document.getElementById('profilePicPreview');
    const sidebarAv = document.getElementById('sidebarAvatar');
    if (base64) {
        preview.innerHTML = `<img src="${base64}" alt="Profile">`;
        sidebarAv.innerHTML = `<img src="${base64}" alt="Profile">`;
        document.getElementById('btnRemovePic').style.display = '';
    } else {
        const initial = (name || 'U').charAt(0).toUpperCase();
        preview.textContent = initial;
        sidebarAv.textContent = initial;
        document.getElementById('btnRemovePic').style.display = 'none';
    }
}

function handlePicUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
        showToast('Image must be under 2 MB', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        profilePicBase64 = e.target.result;
        renderProfilePic(profilePicBase64);
        // Auto-save picture
        savePicture(profilePicBase64);
    };
    reader.readAsDataURL(file);
}

async function savePicture(base64) {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=profile`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ profile_picture: base64 })
        });
        const json = await res.json();
        if (json.success) showToast('Profile picture updated', 'success');
        else showToast(json.message, 'error');
    } catch (e) {
        showToast('Failed to upload picture', 'error');
    }
}

async function removeProfilePic() {
    profilePicBase64 = null;
    renderProfilePic(null, document.getElementById('fullName').value);
    await savePicture('');
}

async function saveProfile(e) {
    e.preventDefault();
    const btn = document.getElementById('btnSaveProfile');
    btn.disabled = true;
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=profile`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                full_name: document.getElementById('fullName').value.trim(),
                email: document.getElementById('email').value.trim()
            })
        });
        const json = await res.json();
        if (json.success) {
            // Update localStorage so other pages reflect changes
            localStorage.setItem('full_name', json.data.full_name);
            localStorage.setItem('email', json.data.email);
            loadUserInfo(json.data.full_name, json.data.email, !!json.data.profile_picture);
            showToast('Profile updated', 'success');
        } else {
            showToast(json.message, 'error');
        }
    } catch (e) {
        showToast('Failed to save profile', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ==================== PASSWORD ====================
function checkPasswordStrength() {
    const pw = document.getElementById('newPassword').value;
    const bar = document.getElementById('strengthBar');
    const label = document.getElementById('strengthLabel');
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    const levels = [
        { width: '0%', color: '#e2e8f0', text: '' },
        { width: '20%', color: '#ef4444', text: 'Very Weak' },
        { width: '40%', color: '#f97316', text: 'Weak' },
        { width: '60%', color: '#eab308', text: 'Fair' },
        { width: '80%', color: '#22c55e', text: 'Strong' },
        { width: '100%', color: '#059669', text: 'Very Strong' }
    ];
    const l = levels[score];
    bar.style.width = l.width;
    bar.style.background = l.color;
    label.textContent = l.text;
    label.style.color = l.color;
}

async function changePassword(e) {
    e.preventDefault();
    const newPw = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;
    if (newPw !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }
    const btn = document.getElementById('btnChangePassword');
    btn.disabled = true;
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                current_password: document.getElementById('currentPassword').value,
                new_password: newPw
            })
        });
        const json = await res.json();
        if (json.success) {
            showToast('Password changed successfully', 'success');
            document.getElementById('passwordForm').reset();
            document.getElementById('strengthBar').style.width = '0%';
            document.getElementById('strengthLabel').textContent = '';
        } else {
            showToast(json.message, 'error');
        }
    } catch (e) {
        showToast('Failed to change password', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ==================== 2FA ====================
let pending2FAState = false; // what the user wants to switch to

function prompt2FAPassword() {
    const enabled = document.getElementById('toggle2FA').checked;
    pending2FAState = enabled;

    // Update modal text
    document.getElementById('twofaModalTitle').textContent = enabled ? 'Enable 2FA' : 'Disable 2FA';
    document.getElementById('twofaModalDesc').textContent = enabled
        ? 'Enable email-based two-factor authentication'
        : 'Disable two-factor authentication';
    document.getElementById('twofaPassword').value = '';
    document.getElementById('twofaPassError').style.display = 'none';

    // Show modal
    const modal = document.getElementById('twofaModal');
    modal.classList.add('show');
    setTimeout(() => document.getElementById('twofaPassword').focus(), 100);
}

function close2FAModal() {
    const modal = document.getElementById('twofaModal');
    modal.classList.remove('show');
    // Revert toggle to previous state
    document.getElementById('toggle2FA').checked = !pending2FAState;
}

async function confirm2FAToggle() {
    const password = document.getElementById('twofaPassword').value;
    if (!password) {
        document.getElementById('twofaPassError').textContent = 'Password is required';
        document.getElementById('twofaPassError').style.display = 'block';
        return;
    }

    const btn = document.getElementById('btn2FAConfirm');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=2fa`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ enable: pending2FAState, password: password })
        });
        const json = await res.json();
        if (json.success) {
            document.getElementById('toggle2FA').checked = pending2FAState;
            // Close modal
            const modal = document.getElementById('twofaModal');
            modal.classList.remove('show');
            // Update status indicator
            update2FAStatus(pending2FAState);
            showToast(json.message, 'success');
        } else {
            document.getElementById('twofaPassError').textContent = json.message;
            document.getElementById('twofaPassError').style.display = 'block';
        }
    } catch (e) {
        document.getElementById('twofaPassError').textContent = 'Failed to update 2FA';
        document.getElementById('twofaPassError').style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm';
    }
}

function update2FAStatus(enabled) {
    const statusEl = document.getElementById('twofa-status');
    if (enabled) {
        statusEl.style.display = 'block';
        statusEl.style.background = '#f0fdf4';
        statusEl.style.color = '#166534';
        statusEl.style.border = '1px solid #bbf7d0';
        statusEl.innerHTML = '<i class="fa-solid fa-circle-check" style="margin-right:6px;"></i> 2FA is active — a verification code will be sent to your email on each login';
    } else {
        statusEl.style.display = 'block';
        statusEl.style.background = '#fef2f2';
        statusEl.style.color = '#991b1b';
        statusEl.style.border = '1px solid #fecaca';
        statusEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i> 2FA is disabled — your account uses password-only authentication';
        // Auto-hide after 5 seconds
        setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }
}

function ensureOcrHealthVisibility() {
    const card = document.getElementById('ocrHealthCard');
    if (!card) return;

    if (typeof Permissions !== 'undefined' && !Permissions.has('users')) {
        card.style.display = 'none';
        return;
    }

    card.style.display = '';
    if (!ocrHealthLoaded) {
        checkOcrHealth();
    }
}

function setOcrHealthLoading(isLoading) {
    const btn = document.getElementById('btnCheckOcrHealth');
    if (!btn) return;

    btn.disabled = isLoading;
    btn.innerHTML = isLoading
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Checking...'
        : '<i class="fa-solid fa-heart-pulse"></i> Run OCR Health Check';
}

function renderOcrHealthResult(payload, isError = false) {
    const resultEl = document.getElementById('ocrHealthResult');
    const timestampEl = document.getElementById('ocrHealthTimestamp');
    if (!resultEl || !timestampEl) return;

    const checkedAt = new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    timestampEl.textContent = `Last checked: ${checkedAt}`;

    if (isError) {
        resultEl.innerHTML = `
            <div class="ocr-health-summary ocr-health-summary-error">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>${escapeHtml(payload.message || 'Failed to run OCR health check')}</span>
            </div>
        `;
        return;
    }

    const tesseractCheck = payload?.checks?.tesseract || {};
    const ghostscriptCheck = payload?.checks?.ghostscript || {};
    const tesseractOk = !!(tesseractCheck.ok ?? tesseractCheck.success);
    const ghostscriptOk = !!(ghostscriptCheck.ok ?? ghostscriptCheck.success);
    const shellExecEnabled = !!payload?.shell_exec_enabled;
    const overallOk = shellExecEnabled && tesseractOk && ghostscriptOk;

    const summaryClass = overallOk ? 'ocr-health-summary-ok' : 'ocr-health-summary-error';
    const summaryIcon = overallOk ? 'fa-circle-check' : 'fa-triangle-exclamation';
    const summaryText = overallOk
        ? 'OCR runtime is healthy. Tesseract and Ghostscript are available.'
        : 'OCR runtime has issues. Review command outputs below.';

    const envConfig = payload?.configured_paths || payload?.config || {};
    const checks = payload?.checks || {};

    const sectionsHtml = ['tesseract', 'ghostscript'].map((toolKey) => {
        const tool = checks[toolKey] || {};
        const ok = !!(tool.ok ?? tool.success);
        const toolTitle = toolKey === 'tesseract' ? 'Tesseract' : 'Ghostscript';
        const output = (tool.output || tool.error || '').trim() || 'No output';

        return `
            <div class="ocr-tool-block">
                <div class="ocr-tool-head">
                    <span class="ocr-tool-title">${toolTitle}</span>
                    <span class="ocr-tool-badge ${ok ? 'ocr-tool-badge-ok' : 'ocr-tool-badge-error'}">
                        ${ok ? 'OK' : 'FAILED'}
                    </span>
                </div>
                <div class="ocr-tool-path">Configured path: ${escapeHtml(envConfig[toolKey] || '(default)')}</div>
                <pre class="ocr-tool-output">${escapeHtml(output)}</pre>
            </div>
        `;
    }).join('');

    resultEl.innerHTML = `
        <div class="ocr-health-summary ${summaryClass}">
            <i class="fa-solid ${summaryIcon}"></i>
            <span>${summaryText}</span>
        </div>
        <div class="ocr-shell-row">
            <span class="ocr-shell-label">shell_exec:</span>
            <span class="ocr-tool-badge ${shellExecEnabled ? 'ocr-tool-badge-ok' : 'ocr-tool-badge-error'}">
                ${shellExecEnabled ? 'ENABLED' : 'DISABLED'}
            </span>
        </div>
        <div class="ocr-tools-grid">
            ${sectionsHtml}
        </div>
    `;
}

async function checkOcrHealth() {
    const card = document.getElementById('ocrHealthCard');
    if (card && card.style.display === 'none') return;

    const resultEl = document.getElementById('ocrHealthResult');
    if (resultEl) {
        resultEl.innerHTML = '<div class="ocr-health-loading"><i class="fa-solid fa-spinner fa-spin"></i> Running OCR health checks...</div>';
    }

    setOcrHealthLoading(true);
    try {
        const res = await fetch(`${API_URL}/ocr-health.php`, {
            credentials: 'include'
        });

        const json = await res.json();
        if (!res.ok || !json.success) {
            renderOcrHealthResult({ message: json.message || 'OCR health check failed' }, true);
            if (res.status !== 403) {
                showToast(json.message || 'Failed to run OCR health check', 'error');
            }
            return;
        }

        ocrHealthLoaded = true;
        renderOcrHealthResult(json.data || {});
    } catch (e) {
        renderOcrHealthResult({ message: 'Network error while running OCR health check' }, true);
    } finally {
        setOcrHealthLoading(false);
    }
}

// ==================== SESSIONS ====================
async function loadSessions() {
    const tbody = document.getElementById('sessionsBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Loading…</td></tr>';
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=sessions`, {
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success && json.data.length) {
            tbody.innerHTML = json.data.map(s => {
                const ua = parseUA(s.user_agent || '');
                const isCurrent = parseInt(s.is_current);
                return `<tr>
                            <td><i class="fa-solid ${ua.icon} session-device-icon"></i> ${ua.label}</td>
                            <td>${s.ip_address || '—'}</td>
                            <td>${formatDate(s.created_at)}</td>
                            <td>${formatDate(s.expires_at)}</td>
                            <td>${isCurrent ? '<span class="session-current-badge">Current</span>' : 'Active'}</td>
                        </tr>`;
            }).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No active sessions</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;">Failed to load sessions</td></tr>';
    }
}

async function revokeOtherSessions() {
    if (!confirm('This will log you out of all other devices. Continue?')) return;
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=revoke`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ action: 'revoke' })  // ← add this line
        });
        const json = await res.json();
        if (json.success) {
            showToast(json.message, 'success');
            loadSessions();
        } else {
            showToast(json.message, 'error');
        }
    } catch (e) {
        showToast('Failed to revoke sessions', 'error');
    }
}

// ==================== HELPERS ====================
function parseUA(ua) {
    if (/mobile|android|iphone/i.test(ua)) return { icon: 'fa-mobile-screen', label: 'Mobile Browser' };
    if (/tablet|ipad/i.test(ua)) return { icon: 'fa-tablet-screen-button', label: 'Tablet Browser' };
    if (/chrome/i.test(ua)) return { icon: 'fa-desktop', label: 'Chrome Desktop' };
    if (/firefox/i.test(ua)) return { icon: 'fa-desktop', label: 'Firefox Desktop' };
    if (/safari/i.test(ua)) return { icon: 'fa-desktop', label: 'Safari Desktop' };
    if (/edge/i.test(ua)) return { icon: 'fa-desktop', label: 'Edge Desktop' };
    return { icon: 'fa-desktop', label: 'Desktop Browser' };
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `dashboard-toast ${type} show`;
    setTimeout(() => t.classList.remove('show'), 3500);
}

// ==================== FILE MANAGEMENT ====================
let selectedFiles = [];

function initFileUpload() {
    const uploadArea = document.getElementById('fileUploadArea');
    const fileInput = document.getElementById('fileInput');

    if (!uploadArea || !fileInput) return;

    // Click to upload
    uploadArea.addEventListener('click', (e) => {
        if (e.target.closest('input')) return;
        fileInput.click();
    });

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        addFiles(e.dataTransfer.files);
    });
}

function openFileUploadModal() {
    selectedFiles = [];
    document.getElementById('selectedFilesList').innerHTML = '';
    document.getElementById('fileInput').value = '';
    document.getElementById('fileItemNo').value = '';
    document.getElementById('fileHeadings').value = '';
    document.getElementById('fileUnit').value = '';
    document.getElementById('fileNatureOfEvent').value = '';
    document.getElementById('fileStatus').value = 'Pending';
    document.getElementById('fileQameReport').value = '';
    document.getElementById('fileComputationFiles').value = '';
    document.getElementById('uploadProgress').style.display = 'none';
    document.getElementById('fileUploadModal').classList.add('show');
}

function closeFileModal() {
    document.getElementById('fileUploadModal').classList.remove('show');
    selectedFiles = [];
    resetUploadModal(); // Restore form state for next use
}

function handleFileSelect(event) {
    addFiles(event.target.files);
}

function addFiles(fileList) {
    const maxSize = 10 * 1024 * 1024;
    for (const file of fileList) {
        if (file.size > maxSize) {
            showToast(`${file.name} exceeds 10 MB limit`, 'error');
            continue;
        }
        if (!selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            selectedFiles.push(file);
        }
    }
    renderSelectedFiles();
}

function removeSelectedFile(index) {
    selectedFiles.splice(index, 1);
    renderSelectedFiles();
}

function renderSelectedFiles() {
    const el = document.getElementById('selectedFilesList');
    if (!selectedFiles.length) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = selectedFiles.map((f, i) => `
        <div class="selected-file-item">
            <i class="fa-solid ${getFileIcon(f.name)}"></i>
            <span>${escapeHtml(f.name)}</span>
            <span class="file-size">(${formatFileSize(f.size)})</span>
            <button type="button" class="btn-remove-file" onclick="removeSelectedFile(${i})">&times;</button>
        </div>
    `).join('');
}

async function uploadFileWithMetadata() {
    if (!selectedFiles.length) {
        showToast('Please select at least one file', 'error');
        return;
    }

    const progressContainer = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressText = document.getElementById('uploadProgressText');
    const btn = document.getElementById('btnUploadFile');

    btn.disabled = true;
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Uploading...';

    try {
        const formData = new FormData();
        selectedFiles.forEach(f => formData.append('files[]', f));
        formData.append('item_no', document.getElementById('fileItemNo').value);
        formData.append('headings', document.getElementById('fileHeadings').value);
        formData.append('unit', document.getElementById('fileUnit').value);
        formData.append('nature_of_event', document.getElementById('fileNatureOfEvent').value);
        formData.append('status', document.getElementById('fileStatus').value);
        formData.append('qame_report', document.getElementById('fileQameReport').value);
        formData.append('computation_files', document.getElementById('fileComputationFiles').value);

        const res = await fetch(`${API_URL}/main-settings.php?action=upload`, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        progressFill.style.width = '100%';
        const json = await res.json();

        if (json.success) {
            progressText.textContent = 'Upload complete!';
            setTimeout(() => {
                closeFileModal();
                showToast(`${json.data.files_count} file(s) uploaded successfully`, 'success');
                loadFiles();
            }, 500);
        } else {
            showToast(json.message || 'Upload failed', 'error');
            progressContainer.style.display = 'none';
        }
    } catch (e) {
        showToast('Failed to upload files', 'error');
        progressContainer.style.display = 'none';
    } finally {
        btn.disabled = false;
    }
}

let allFilesData = [];

async function loadFiles() {
    // Skip if user doesn't have settings permission
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;
    
    const tbody = document.getElementById('filesBody');
    tbody.innerHTML = '<tr><td colspan="12" class="loading-cell">Loading records...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=files`, {
            credentials: 'include'
        });
        
        // Handle 403 - hide admin tabs and switch to profile
        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }
        
        const json = await res.json();

        allFilesData = json.success ? json.data : [];
        renderFilesTable(allFilesData);
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="12" class="loading-cell" style="color:#ef4444;">Failed to load records</td></tr>';
    }
}

function filterFiles() {
    const query = document.getElementById('filesSearchInput').value.toLowerCase().trim();
    const clearBtn = document.getElementById('btnClearFilesSearch');
    clearBtn.style.display = query ? 'flex' : 'none';
    
    if (!query) {
        renderFilesTable(allFilesData);
        return;
    }
    
    const filtered = allFilesData.filter(record => {
        // Search across multiple fields
        const searchFields = [
            record.item_no,
            record.location,
            record.headings,
            record.unit,
            record.nature_of_event,
            record.status,
            record.qame_report,
            record.computation_files,
            // Search in file names
            ...(record.files || []).map(f => f.file_name)
        ];
        return searchFields.some(field => 
            field && field.toLowerCase().includes(query)
        );
    });
    
    renderFilesTable(filtered);
}

function clearFilesSearch() {
    document.getElementById('filesSearchInput').value = '';
    document.getElementById('btnClearFilesSearch').style.display = 'none';
    renderFilesTable(allFilesData);
}

function renderFilesTable(data) {
    const tbody = document.getElementById('filesBody');
    
    if (data && data.length) {
        tbody.innerHTML = data.map(record => {
                const statusClass = getStatusClass(record.status);
                const files = record.files || [];
                const filesHtml = files.map((f, i) => {
                    const icon = getFileIcon(f.file_name);
                    return `<div class="file-item">
                        <i class="fa-solid ${icon}"></i>
                        <span class="file-name">${escapeHtml(f.file_name)}</span>
                        <span class="file-size">(${formatFileSize(f.file_size)})</span>
                        <button class="btn-file-mini" onclick="downloadFile(${record.id}, ${i}, '${escapeHtml(f.file_name)}')" title="Download">
                            <i class="fa-solid fa-download"></i>
                        </button>
                        <button class="btn-file-mini btn-delete-mini" onclick="deleteFileFromRecord(${record.id}, ${i}, '${escapeHtml(f.file_name)}')" title="Remove">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>`;
                }).join('');
                
                const totalSize = files.reduce((sum, f) => sum + (f.file_size || 0), 0);
                
                return `<tr>
                    <td>${escapeHtml(record.item_no || '—')}</td>
                    <td class="files-cell">
                        <div class="files-list">${filesHtml || '<em>No files</em>'}</div>
                        <button class="btn-add-files" onclick="openAddFilesModal(${record.id})" title="Add more files">
                            <i class="fa-solid fa-plus"></i> Add
                        </button>
                    </td>
                    <td>${escapeHtml(record.location || '—')}</td>
                    <td>${escapeHtml(record.headings || '—')}</td>
                    <td>${escapeHtml(record.unit || '—')}</td>
                    <td>${escapeHtml(record.nature_of_event || '—')}</td>
                    <td><span class="status-badge ${statusClass}">${escapeHtml(record.status || 'Pending')}</span></td>
                    <td>${escapeHtml(record.qame_report || '—')}</td>
                    <td>${escapeHtml(record.computation_files || '—')}</td>
                    <td>${formatFileSize(totalSize)}</td>
                    <td>${formatDate(record.uploaded_at)}</td>
                    <td>
                        <div class="file-actions">
                            <button class="btn-file-action btn-edit" onclick="editFile(${record.id})" title="Edit">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button class="btn-file-action btn-delete-file" onclick="deleteRecord(${record.id})" title="Delete Record">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join('');
    } else {
        const searchQuery = document.getElementById('filesSearchInput')?.value || '';
        const message = searchQuery ? 'No matching files found' : 'No records yet';
        tbody.innerHTML = `<tr><td colspan="12" class="empty-files">
            <i class="fa-solid fa-folder-open"></i>
            <p>${message}</p>
        </td></tr>`;
    }
}

function getStatusClass(status) {
    const classes = {
        'Pending': 'status-pending',
        'In Progress': 'status-in-progress',
        'Completed': 'status-completed',
        'Approved': 'status-approved',
        'Rejected': 'status-rejected'
    };
    return classes[status] || 'status-pending';
}

let currentEditFile = null;
let currentAddFilesRecordId = null;

async function editFile(recordId) {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=get-file&id=${recordId}`, {
            credentials: 'include'
        });
        const json = await res.json();
        
        if (json.success) {
            currentEditFile = json.data;
            document.getElementById('editFileId').value = recordId;
            document.getElementById('editFileItemNo').value = json.data.item_no || '';
            document.getElementById('editFileHeadings').value = json.data.headings || '';
            document.getElementById('editFileUnit').value = json.data.unit || '';
            document.getElementById('editFileNatureOfEvent').value = json.data.nature_of_event || '';
            document.getElementById('editFileStatus').value = json.data.status || 'Pending';
            document.getElementById('editFileQameReport').value = json.data.qame_report || '';
            document.getElementById('editFileComputationFiles').value = json.data.computation_files || '';
            document.getElementById('editFileModal').classList.add('show');
        } else {
            showToast(json.message || 'Failed to load record details', 'error');
        }
    } catch (e) {
        showToast('Failed to load record details', 'error');
    }
}

function closeEditFileModal() {
    document.getElementById('editFileModal').classList.remove('show');
    currentEditFile = null;
}

async function saveFileMetadata() {
    const recordId = document.getElementById('editFileId').value;
    
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=update-file`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                file_id: parseInt(recordId),
                item_no: document.getElementById('editFileItemNo').value,
                headings: document.getElementById('editFileHeadings').value,
                unit: document.getElementById('editFileUnit').value,
                nature_of_event: document.getElementById('editFileNatureOfEvent').value,
                status: document.getElementById('editFileStatus').value,
                qame_report: document.getElementById('editFileQameReport').value,
                computation_files: document.getElementById('editFileComputationFiles').value
            })
        });
        const json = await res.json();
        
        if (json.success) {
            closeEditFileModal();
            showToast('Record updated', 'success');
            loadFiles();
        } else {
            showToast(json.message || 'Failed to update record', 'error');
        }
    } catch (e) {
        showToast('Failed to update record', 'error');
    }
}

function openAddFilesModal(recordId) {
    currentAddFilesRecordId = recordId;
    selectedFiles = [];
    document.getElementById('selectedFilesList').innerHTML = '';
    document.getElementById('fileInput').value = '';
    // Hide metadata fields for add-files mode
    document.querySelectorAll('#fileUploadModal .form-row').forEach(el => el.style.display = 'none');
    document.getElementById('fileUploadModal').querySelector('.modal-title').textContent = 'Add Files to Record';
    document.getElementById('btnUploadFile').onclick = addFilesToRecord;
    document.getElementById('uploadProgress').style.display = 'none';
    document.getElementById('fileUploadModal').classList.add('show');
}

async function addFilesToRecord() {
    if (!selectedFiles.length) {
        showToast('Please select at least one file', 'error');
        return;
    }

    const progressContainer = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressText = document.getElementById('uploadProgressText');
    const btn = document.getElementById('btnUploadFile');

    btn.disabled = true;
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Adding files...';

    try {
        const formData = new FormData();
        formData.append('record_id', currentAddFilesRecordId);
        selectedFiles.forEach(f => formData.append('files[]', f));

        const res = await fetch(`${API_URL}/main-settings.php?action=add-files`, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        progressFill.style.width = '100%';
        const json = await res.json();

        if (json.success) {
            progressText.textContent = 'Files added!';
            setTimeout(() => {
                closeFileModal();
                resetUploadModal();
                showToast(`${json.data.added} file(s) added`, 'success');
                loadFiles();
            }, 500);
        } else {
            showToast(json.message || 'Failed to add files', 'error');
            progressContainer.style.display = 'none';
        }
    } catch (e) {
        showToast('Failed to add files', 'error');
        progressContainer.style.display = 'none';
    } finally {
        btn.disabled = false;
    }
}

function resetUploadModal() {
    currentAddFilesRecordId = null;
    document.querySelectorAll('#fileUploadModal .form-row').forEach(el => el.style.display = '');
    document.getElementById('fileUploadModal').querySelector('.modal-title').textContent = 'Upload Files';
    document.getElementById('btnUploadFile').onclick = uploadFileWithMetadata;
}

async function downloadFile(recordId, fileIndex, fileName) {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=download&id=${recordId}&file_index=${fileIndex}`, {
            credentials: 'include'
        });

        if (!res.ok) {
            const json = await res.json();
            showToast(json.message || 'Download failed', 'error');
            return;
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
    } catch (e) {
        showToast('Failed to download file', 'error');
    }
}

async function deleteFileFromRecord(recordId, fileIndex, fileName) {
    if (!confirm(`Remove "${fileName}" from this record?`)) return;

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-file`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ record_id: recordId, file_index: fileIndex })
        });
        const json = await res.json();
        if (json.success) {
            showToast('File removed', 'success');
            loadFiles();
        } else {
            showToast(json.message, 'error');
        }
    } catch (e) {
        showToast('Failed to remove file', 'error');
    }
}

async function deleteRecord(recordId) {
    if (!confirm('Delete this entire record and all its files? This cannot be undone.')) return;

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-file`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ record_id: recordId })
        });
        const json = await res.json();
        if (json.success) {
            showToast('Record deleted', 'success');
            loadFiles();
        } else {
            showToast(json.message, 'error');
        }
    } catch (e) {
        showToast('Failed to delete record', 'error');
    }
}

function getFileIcon(fileName) {
    if (!fileName) return 'fa-file';
    const ext = fileName.split('.').pop().toLowerCase();
    const icons = {
        pdf: 'fa-file-pdf',
        doc: 'fa-file-word', docx: 'fa-file-word',
        xls: 'fa-file-excel', xlsx: 'fa-file-excel',
        ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
        jpg: 'fa-file-image', jpeg: 'fa-file-image', png: 'fa-file-image', gif: 'fa-file-image', webp: 'fa-file-image',
        zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
        mp3: 'fa-file-audio', wav: 'fa-file-audio',
        mp4: 'fa-file-video', avi: 'fa-file-video', mov: 'fa-file-video',
        txt: 'fa-file-lines',
        csv: 'fa-file-csv',
        html: 'fa-file-code', css: 'fa-file-code', js: 'fa-file-code', json: 'fa-file-code'
    };
    return icons[ext] || 'fa-file';
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Initialize file upload when DOM loads
window.addEventListener('DOMContentLoaded', initFileUpload);
window.addEventListener('DOMContentLoaded', ensureOcrHealthVisibility);
window.addEventListener('DOMContentLoaded', applyInitialTabFromHash);

// ==================== LOGOUT ====================
async function logout() {
    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });
    } catch (e) {
    } finally {
        ['user_id', 'email', 'full_name', 'role', 'permissions'].forEach(k => localStorage.removeItem(k));
        window.location.href = 'login.html';
    }
}

// ==================== RATING SCALES ====================
let ratingScalesData = { category: [], speaker: [], overall: [] };
let currentScaleType = 'category';
let editingScaleId = null;

function selectScaleType(type) {
    currentScaleType = type;
    document.querySelectorAll('.scale-type-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.scale-type-btn[data-type="${type}"]`).classList.add('active');
    renderRatingScalesTable();
}

async function loadRatingScales() {
    // Skip if user doesn't have settings permission
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;
    
    const tbody = document.getElementById('ratingScalesBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Loading...</td></tr>';
    
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=rating-scales`, {
            credentials: 'include'
        });
        
        // Handle 403 - hide admin tabs and switch to profile
        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }
        
        const json = await res.json();
        
        if (json.success) {
            ratingScalesData = json.data;
            renderRatingScalesTable();
        } else {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;">Failed to load</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;">Error loading scales</td></tr>';
    }
}

function renderRatingScalesTable() {
    const tbody = document.getElementById('ratingScalesBody');
    const scales = ratingScalesData[currentScaleType] || [];
    
    if (!scales.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No scales defined</td></tr>';
        return;
    }
    
    tbody.innerHTML = scales.map(s => `
        <tr>
            <td><span class="scale-level-badge">${escapeHtml(s.level)}</span></td>
            <td>${escapeHtml(s.description)}</td>
            <td>${s.min_value}</td>
            <td>${s.max_value}</td>
            <td>
                <div class="action-btns">
                    <button class="btn-action btn-edit" onclick="editRatingScale(${s.id})" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete" onclick="deleteRatingScale(${s.id}, '${escapeHtml(s.level)}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openAddScaleModal() {
    editingScaleId = null;
    document.getElementById('ratingScaleModalTitle').textContent = 'Add Rating Scale';
    document.getElementById('ratingScaleId').value = '';
    document.getElementById('ratingScaleType').value = currentScaleType;
    document.getElementById('ratingScaleLevel').value = '';
    document.getElementById('ratingScaleDescription').value = '';
    document.getElementById('ratingScaleMin').value = '';
    document.getElementById('ratingScaleMax').value = '';
    document.getElementById('ratingScaleModal').classList.add('show');
}

function editRatingScale(id) {
    const scale = ratingScalesData[currentScaleType].find(s => s.id == id);
    if (!scale) return;
    
    editingScaleId = id;
    document.getElementById('ratingScaleModalTitle').textContent = 'Edit Rating Scale';
    document.getElementById('ratingScaleId').value = scale.id;
    document.getElementById('ratingScaleType').value = scale.type;
    document.getElementById('ratingScaleLevel').value = scale.level;
    document.getElementById('ratingScaleDescription').value = scale.description;
    document.getElementById('ratingScaleMin').value = scale.min_value;
    document.getElementById('ratingScaleMax').value = scale.max_value;
    document.getElementById('ratingScaleModal').classList.add('show');
}

function closeRatingScaleModal() {
    document.getElementById('ratingScaleModal').classList.remove('show');
    editingScaleId = null;
}

async function saveRatingScale() {
    const id = document.getElementById('ratingScaleId').value;
    const type = document.getElementById('ratingScaleType').value || currentScaleType;
    const level = document.getElementById('ratingScaleLevel').value.trim();
    const description = document.getElementById('ratingScaleDescription').value.trim();
    const minValue = parseFloat(document.getElementById('ratingScaleMin').value);
    const maxValue = parseFloat(document.getElementById('ratingScaleMax').value);
    
    if (!level || !description) {
        showToast('Level and description are required', 'error');
        return;
    }
    if (isNaN(minValue) || isNaN(maxValue)) {
        showToast('Valid min and max values are required', 'error');
        return;
    }
    if (minValue > maxValue) {
        showToast('Min value cannot be greater than max value', 'error');
        return;
    }
    
    const btn = document.getElementById('btnSaveRatingScale');
    btn.disabled = true;
    
    try {
        const action = editingScaleId ? 'update-rating-scale' : 'add-rating-scale';
        const body = editingScaleId 
            ? { id: editingScaleId, level, description, min_value: minValue, max_value: maxValue }
            : { type, level, description, min_value: minValue, max_value: maxValue };
        
        const res = await fetch(`${API_URL}/main-settings.php?action=${action}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        const json = await res.json();
        
        if (json.success) {
            showToast(json.message, 'success');
            closeRatingScaleModal();
            loadRatingScales();
        } else {
            showToast(json.message || 'Failed to save', 'error');
        }
    } catch (e) {
        showToast('Failed to save rating scale', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function deleteRatingScale(id, level) {
    if (!confirm(`Delete rating scale "${level}"? This cannot be undone.`)) return;
    
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-rating-scale`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ id })
        });
        const json = await res.json();
        
        if (json.success) {
            showToast('Rating scale deleted', 'success');
            loadRatingScales();
        } else {
            showToast(json.message || 'Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Failed to delete rating scale', 'error');
    }
}

// ==================== SUPPORTING DOCUMENTS ====================
let supportingDocsData = [];
let currentDocTypeFilter = 'all';
let editingSupportingDocId = null;

const DOC_TYPE_LABELS = {
    all: 'Tuition Fee',
    tuition_increase: 'Tuition — Increase',
    tuition_no_increase: 'Tuition — No Increase',
    school_calendar: 'School Calendar'
};

function selectDocTypeFilter(type) {
    currentDocTypeFilter = type;
    document.querySelectorAll('#panel-supporting-documents .scale-type-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`#panel-supporting-documents .scale-type-btn[data-doctype="${type}"]`).classList.add('active');
    renderSupportingDocsTable();
}

async function loadSupportingDocs() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;

    const tbody = document.getElementById('supportingDocsBody');
    tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Loading...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=supporting-documents`, {
            credentials: 'include'
        });

        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }

        const json = await res.json();

        if (json.success) {
            supportingDocsData = json.data || [];
            renderSupportingDocsTable();
        } else {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#ef4444;">Failed to load</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#ef4444;">Error loading supporting documents</td></tr>';
    }
}

function renderSupportingDocsTable() {
    const tbody = document.getElementById('supportingDocsBody');
    // 'all' now represents "Tuition Fee" (both increase & no-increase modes, plus
    // docs shared across them) — it must exclude School Calendar docs, which are
    // their own separate doc_type and have their own filter button.
    const rows = currentDocTypeFilter === 'all'
        ? supportingDocsData.filter(d => d.doc_type !== 'school_calendar')
        : supportingDocsData.filter(d => d.doc_type === currentDocTypeFilter);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">No supporting documents defined</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(d => `
        <tr>
            <td>${escapeHtml(String(d.display_order))}</td>
            <td><span class="scale-level-badge">${escapeHtml(DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}</span></td>
            <td>${escapeHtml(d.label)}</td>
            <td style="font-family:monospace;font-size:12px;color:#64748b;">${escapeHtml(d.slug)}</td>
            <td style="font-size:12px;color:#64748b;">${escapeHtml(d.hint || '—')}</td>
            <td style="text-align:center;"><i class="fa-solid ${escapeHtml(d.icon || 'fa-file')}"></i></td>
            <td>
                <label class="toggle-switch toggle-switch-sm" title="${d.is_active ? 'Active' : 'Inactive'}">
                    <input type="checkbox" ${d.is_active ? 'checked' : ''} onchange="toggleSupportingDocActive(${d.id}, this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </td>
            <td>
                <div class="action-btns">
                    <button class="btn-action btn-edit" onclick="editSupportingDoc(${d.id})" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete" onclick="deleteSupportingDoc(${d.id}, '${escapeHtml(d.label).replace(/'/g, "\\'")}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openAddSupportingDocModal() {
    editingSupportingDocId = null;
    document.getElementById('supportingDocModalTitle').textContent = 'Add Supporting Document';
    document.getElementById('supportingDocId').value = '';
    document.getElementById('supportingDocType').value = currentDocTypeFilter !== 'all' ? currentDocTypeFilter : 'all';
    document.getElementById('supportingDocLabel').value = '';
    document.getElementById('supportingDocSlug').value = '';
    document.getElementById('supportingDocHint').value = '';
    document.getElementById('supportingDocIcon').value = 'fa-file';
    document.getElementById('supportingDocOrder').value = '0';
    document.getElementById('supportingDocActive').checked = true;
    document.getElementById('supportingDocModal').classList.add('show');
}

function editSupportingDoc(id) {
    const doc = supportingDocsData.find(d => parseInt(d.id) === parseInt(id));
    if (!doc) return;

    editingSupportingDocId = id;
    document.getElementById('supportingDocModalTitle').textContent = `Edit: ${doc.label}`;
    document.getElementById('supportingDocId').value = doc.id;
    document.getElementById('supportingDocType').value = doc.doc_type;
    document.getElementById('supportingDocLabel').value = doc.label;
    document.getElementById('supportingDocSlug').value = doc.slug;
    document.getElementById('supportingDocHint').value = doc.hint || '';
    document.getElementById('supportingDocIcon').value = doc.icon || 'fa-file';
    document.getElementById('supportingDocOrder').value = doc.display_order || 0;
    document.getElementById('supportingDocActive').checked = !!parseInt(doc.is_active);
    document.getElementById('supportingDocModal').classList.add('show');
}

function closeSupportingDocModal() {
    document.getElementById('supportingDocModal').classList.remove('show');
    editingSupportingDocId = null;
}

function slugifyDocSlug(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

async function saveSupportingDoc() {
    const id = document.getElementById('supportingDocId').value;
    const docType = document.getElementById('supportingDocType').value;
    const label = document.getElementById('supportingDocLabel').value.trim();
    let slug = document.getElementById('supportingDocSlug').value.trim();
    const hint = document.getElementById('supportingDocHint').value.trim();
    const icon = document.getElementById('supportingDocIcon').value;
    const displayOrder = parseInt(document.getElementById('supportingDocOrder').value) || 0;
    const isActive = document.getElementById('supportingDocActive').checked;

    if (!label) {
        showToast('Label is required', 'error');
        return;
    }
    slug = slugifyDocSlug(slug || label);
    if (!slug) {
        showToast('A valid slug is required', 'error');
        return;
    }

    const btn = document.getElementById('btnSaveSupportingDoc');
    btn.disabled = true;

    try {
        const action = editingSupportingDocId ? 'update-supporting-document' : 'add-supporting-document';
        const body = {
            doc_type: docType,
            slug,
            label,
            hint,
            icon,
            display_order: displayOrder,
            is_active: isActive ? 1 : 0
        };
        if (editingSupportingDocId) body.id = editingSupportingDocId;

        const res = await fetch(`${API_URL}/main-settings.php?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        const json = await res.json();

        if (json.success) {
            showToast(json.message, 'success');
            closeSupportingDocModal();
            loadSupportingDocs();
        } else {
            showToast(json.message || 'Failed to save', 'error');
        }
    } catch (e) {
        showToast('Failed to save supporting document', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function toggleSupportingDocActive(id, checked) {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=toggle-supporting-document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id, is_active: checked ? 1 : 0 })
        });
        const json = await res.json();

        if (json.success) {
            const doc = supportingDocsData.find(d => parseInt(d.id) === parseInt(id));
            if (doc) doc.is_active = checked ? 1 : 0;
            showToast(checked ? 'Marked active' : 'Marked inactive', 'success');
        } else {
            showToast(json.message || 'Failed to update status', 'error');
            loadSupportingDocs();
        }
    } catch (e) {
        showToast('Failed to update status', 'error');
        loadSupportingDocs();
    }
}

async function deleteSupportingDoc(id, label) {
    if (!confirm(`Delete supporting document "${label}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-supporting-document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id })
        });
        const json = await res.json();

        if (json.success) {
            showToast('Supporting document deleted', 'success');
            loadSupportingDocs();
        } else {
            showToast(json.message || 'Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Failed to delete supporting document', 'error');
    }
}

// ==================== PERMIT CHECKLIST ====================
let permitChecklistData = [];
let currentPermitSectionFilter = 'all';
let editingPermitItemId = null;
let permitItemKeyManuallyEdited = false;

const PERMIT_APP_TYPE_LABELS = {
    new_school: 'New School',
    recognition: 'Recognition',
    new_course: 'New Course'
};

function selectPermitSectionFilter(section) {
    currentPermitSectionFilter = section;
    document.querySelectorAll('#permitSectionFilter .scale-type-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`#permitSectionFilter .scale-type-btn[data-section="${cssEscape(section)}"]`);
    if (btn) btn.classList.add('active');
    renderPermitChecklistTable();
}

function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}

function renderPermitSectionFilterButtons() {
    const wrap = document.getElementById('permitSectionFilter');
    const sections = [];
    const seen = new Set();
    permitChecklistData
        .slice()
        .sort((a, b) => a.section_order - b.section_order)
        .forEach(item => {
            if (!seen.has(item.section_name)) {
                seen.add(item.section_name);
                sections.push(item.section_name);
            }
        });

    const buttons = ['<button class="scale-type-btn" data-section="all" onclick="selectPermitSectionFilter(\'all\')"><i class="fa-solid fa-layer-group"></i> All Sections</button>']
        .concat(sections.map(name => `
            <button class="scale-type-btn" data-section="${escapeHtml(name)}" onclick="selectPermitSectionFilter('${escapeHtml(name).replace(/'/g, "\\'")}')">
                ${escapeHtml(name)}
            </button>
        `));

    wrap.innerHTML = buttons.join('');

    const activeExists = sections.includes(currentPermitSectionFilter);
    if (currentPermitSectionFilter !== 'all' && !activeExists) {
        currentPermitSectionFilter = 'all';
    }
    const activeBtn = document.querySelector(`#permitSectionFilter .scale-type-btn[data-section="${cssEscape(currentPermitSectionFilter)}"]`);
    if (activeBtn) activeBtn.classList.add('active');
}

async function loadPermitChecklist() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;

    const tbody = document.getElementById('permitChecklistBody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">Loading...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=permit-checklist`, {
            credentials: 'include'
        });

        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }

        const json = await res.json();

        if (json.success) {
            permitChecklistData = json.data || [];
            renderPermitSectionFilterButtons();
            renderPermitChecklistTable();
        } else {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Failed to load</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Error loading checklist items</td></tr>';
    }
}

function renderPermitChecklistTable() {
    const tbody = document.getElementById('permitChecklistBody');
    const rows = currentPermitSectionFilter === 'all'
        ? permitChecklistData
        : permitChecklistData.filter(d => d.section_name === currentPermitSectionFilter);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">No checklist items defined</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(d => {
        const scope = d.always_required
            ? 'For All Applicants'
            : String(d.app_types || '').split(',').filter(Boolean).map(t => PERMIT_APP_TYPE_LABELS[t.trim()] || t.trim()).join(', ') || '—';

        return `
        <tr>
            <td>${escapeHtml(String(d.item_order))}</td>
            <td>${escapeHtml(d.section_name)}</td>
            <td><span class="scale-level-badge">${escapeHtml(scope)}</span></td>
            <td>${escapeHtml(d.label)}</td>
            <td style="font-family:monospace;font-size:12px;color:#64748b;">${escapeHtml(d.item_key)}</td>
            <td>
                <label class="toggle-switch toggle-switch-sm" title="${d.is_active ? 'Active' : 'Inactive'}">
                    <input type="checkbox" ${d.is_active ? 'checked' : ''} onchange="togglePermitChecklistActive(${d.id}, this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </td>
            <td>
                <div class="action-btns">
                    <button class="btn-action btn-edit" onclick="editPermitChecklistItem(${d.id})" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete" onclick="deletePermitChecklistItem(${d.id}, '${escapeHtml(d.label).replace(/'/g, "\\'")}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

function getExistingPermitSectionNames() {
    const seen = new Set();
    permitChecklistData.forEach(d => seen.add(d.section_name));
    return Array.from(seen);
}

// Distinct sections with a representative order value, sorted the same way
// they'll actually render on the applicant checklist.
function getPermitSectionsSummary() {
    const map = new Map();
    permitChecklistData.forEach(d => {
        const cur = map.get(d.section_name);
        if (cur === undefined || d.section_order < cur) map.set(d.section_name, d.section_order);
    });
    return Array.from(map.entries())
        .map(([name, order]) => ({ name, order }))
        .sort((a, b) => a.order - b.order);
}

function getPermitItemsInSection(sectionName, excludeId) {
    const excl = excludeId ? parseInt(excludeId) : -1;
    return permitChecklistData
        .filter(d => d.section_name === sectionName && parseInt(d.id) !== excl)
        .sort((a, b) => a.item_order - b.item_order || a.id - b.id);
}

function onPermitSectionNameInput() {
    const notice = document.getElementById('permitSectionNameNotice');
    const typed = document.getElementById('permitSectionName').value.trim();

    if (!typed) {
        notice.style.display = 'none';
        refreshPermitOrderPickers();
        return;
    }

    const existing = getExistingPermitSectionNames();
    const exactMatch = existing.includes(typed);

    if (exactMatch) {
        notice.style.display = 'none';
    } else {
        // Case/whitespace-insensitive match against an existing section suggests
        // a likely typo, since section grouping is an exact string match — this
        // person probably meant the existing section, not a new one.
        const looseMatch = existing.find(name => name.trim().toLowerCase() === typed.toLowerCase());

        if (looseMatch) {
            notice.style.display = 'block';
            notice.style.color = '#b45309';
            notice.innerHTML = `⚠️ This doesn't exactly match the existing section "<strong>${escapeHtml(looseMatch)}</strong>" — ` +
                `saving as typed will create a separate, duplicate-looking section instead of adding to it. ` +
                `Did you mean to pick that one from the dropdown?`;
        } else {
            notice.style.display = 'block';
            notice.style.color = '#64748b';
            notice.innerHTML = `ℹ️ "<strong>${escapeHtml(typed)}</strong>" doesn't match any existing section — ` +
                `saving will create it as a brand-new section on the applicant checklist.`;
        }
    }

    refreshPermitOrderPickers();
}

// no-op hook wired to the pickers' onchange — resolution happens at save
// time by reading the select's current value, so nothing needs to happen
// live here, but the handler is kept so the markup has somewhere to point.
function onPermitOrderPickerChange() {}

function populatePermitSectionPositionSelect() {
    const sections = getPermitSectionsSummary();
    const select = document.getElementById('permitSectionPositionSelect');
    let html = '<option value="start">At the very beginning</option>';
    sections.forEach((s, idx) => {
        html += `<option value="after:${idx}">After section: "${escapeHtml(s.name)}"</option>`;
    });
    select.innerHTML = html;
    select.value = sections.length ? `after:${sections.length - 1}` : 'start';
}

function populatePermitItemPositionSelect(sectionName, excludeId, isNewSection) {
    const select = document.getElementById('permitItemPositionSelect');
    const note = document.getElementById('permitItemPositionNote');

    if (!sectionName) {
        select.style.display = 'none';
        note.style.display = 'block';
        note.textContent = 'Enter a section name above first.';
        return;
    }

    if (isNewSection) {
        select.style.display = 'none';
        note.style.display = 'block';
        note.textContent = 'This will be the first requirement in the new section.';
        return;
    }

    const items = getPermitItemsInSection(sectionName, excludeId);

    if (!items.length) {
        select.style.display = 'none';
        note.style.display = 'block';
        note.textContent = 'This will be the first requirement in this section.';
        return;
    }

    select.style.display = '';
    note.style.display = 'none';

    let html = '<option value="start">At the very beginning</option>';
    items.forEach((it, idx) => {
        const shortLabel = it.label.length > 60 ? it.label.slice(0, 57) + '…' : it.label;
        const isLast = idx === items.length - 1;
        html += `<option value="after:${idx}">${isLast ? 'At the end — after' : 'After'}: "${escapeHtml(shortLabel)}"</option>`;
    });
    select.innerHTML = html;

    // Default selection: for a new item, the end of the list. For an item
    // being edited, wherever it already sits, so an untouched save doesn't
    // silently reshuffle anything.
    if (editingPermitItemId) {
        const fullList = permitChecklistData
            .filter(d => d.section_name === sectionName)
            .sort((a, b) => a.item_order - b.item_order || a.id - b.id);
        const myIndex = fullList.findIndex(d => parseInt(d.id) === parseInt(editingPermitItemId));
        if (myIndex <= 0) {
            select.value = 'start';
        } else {
            const predId = fullList[myIndex - 1].id;
            const predIdx = items.findIndex(it => parseInt(it.id) === parseInt(predId));
            select.value = predIdx >= 0 ? `after:${predIdx}` : `after:${items.length - 1}`;
        }
    } else {
        select.value = `after:${items.length - 1}`;
    }
}

function refreshPermitOrderPickers() {
    const typed = document.getElementById('permitSectionName').value.trim();
    const sectionRow = document.getElementById('permitSectionPositionRow');

    if (!typed) {
        sectionRow.style.display = 'none';
        populatePermitItemPositionSelect('', editingPermitItemId, false);
        return;
    }

    const sections = getPermitSectionsSummary();
    const exact = sections.find(s => s.name === typed);

    if (exact) {
        sectionRow.style.display = 'none';
        populatePermitItemPositionSelect(typed, editingPermitItemId, false);
    } else {
        sectionRow.style.display = '';
        populatePermitSectionPositionSelect();
        populatePermitItemPositionSelect(typed, editingPermitItemId, true);
    }
}

async function pushPermitItemFieldUpdate(item, fieldOverrides) {
    const appTypesArr = String(item.app_types || '').split(',').map(t => t.trim()).filter(Boolean);
    const body = Object.assign({
        id: item.id,
        section_name: item.section_name,
        label: item.label,
        always_required: parseInt(item.always_required) ? 1 : 0,
        app_types: appTypesArr,
        is_active: parseInt(item.is_active) ? 1 : 0,
        section_order: item.section_order,
        item_order: item.item_order,
    }, fieldOverrides);

    const res = await fetch(`${API_URL}/main-settings.php?action=update-permit-checklist-item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
        // Keep the local cache in sync so any further shift calculations in
        // this same save pass see the up-to-date order values.
        Object.assign(item, fieldOverrides);
    }
    return json;
}

// Resolves the friendly "where should this new section appear" choice into
// an actual section_order integer, shifting any existing sections (and every
// item within them) out of the way first. Returns the order to use for the
// item currently being saved. No-op (just returns the existing order) when
// the section name matches one that already exists.
async function resolveSectionOrderAndShiftSiblings(typedSectionName) {
    const sections = getPermitSectionsSummary();
    const exact = sections.find(s => s.name === typedSectionName);
    if (exact) return exact.order;

    const select = document.getElementById('permitSectionPositionSelect');
    const value = select.value;
    const orderedNames = sections.map(s => s.name);

    let insertIdx = 0;
    if (value.startsWith('after:')) {
        insertIdx = parseInt(value.split(':')[1]) + 1;
    }

    const newNamesList = orderedNames.slice(0, insertIdx).concat([typedSectionName]).concat(orderedNames.slice(insertIdx));
    const nameToNewOrder = {};
    newNamesList.forEach((name, i) => { nameToNewOrder[name] = i + 1; });

    for (const s of sections) {
        const newOrder = nameToNewOrder[s.name];
        if (newOrder !== s.order) {
            const itemsOfSection = permitChecklistData.filter(d => d.section_name === s.name);
            for (const it of itemsOfSection) {
                await pushPermitItemFieldUpdate(it, { section_order: newOrder });
            }
        }
    }

    return nameToNewOrder[typedSectionName];
}

// Same idea as above, but for where the item lands within its section.
async function resolveItemOrderAndShiftSiblings(sectionName, excludeId) {
    const items = getPermitItemsInSection(sectionName, excludeId);
    const select = document.getElementById('permitItemPositionSelect');
    const value = items.length && select.style.display !== 'none' ? select.value : 'start';

    let insertIdx = 0;
    if (items.length && value.startsWith('after:')) {
        insertIdx = parseInt(value.split(':')[1]) + 1;
    }

    const selfKey = excludeId ? `self:${excludeId}` : 'self:new';
    const idsOrdered = items.map(i => `id:${i.id}`);
    const newList = idsOrdered.slice(0, insertIdx).concat([selfKey]).concat(idsOrdered.slice(insertIdx));

    const keyToNewOrder = {};
    newList.forEach((key, i) => { keyToNewOrder[key] = i + 1; });

    for (const it of items) {
        const key = `id:${it.id}`;
        const newOrder = keyToNewOrder[key];
        if (newOrder !== it.item_order) {
            await pushPermitItemFieldUpdate(it, { item_order: newOrder });
        }
    }

    return keyToNewOrder[selfKey];
}

function togglePermitAppTypesVisibility() {
    const always = document.getElementById('permitAlwaysRequired').checked;
    document.getElementById('permitAppTypesRow').style.display = always ? 'none' : '';
}

function onPermitItemKeyManualEdit() {
    permitItemKeyManuallyEdited = true;
}

function onPermitItemLabelInput() {
    // Only auto-fill for new items, and stop as soon as the admin has
    // touched the key field themselves — never stomp on a manual edit.
    if (editingPermitItemId || permitItemKeyManuallyEdited) return;
    const label = document.getElementById('permitItemLabel').value;
    // Permit labels tend to be full sentences ("Board Resolution — certified
    // by the Corporate Secretary"), unlike short doc labels, so trim to the
    // first few words for a sane default key rather than the whole sentence.
    const firstWords = label.split(/[\s—-]+/).filter(Boolean).slice(0, 5).join(' ');
    document.getElementById('permitItemKey').value = slugifyDocSlug(firstWords).slice(0, 60);
}

function openAddPermitChecklistModal() {
    editingPermitItemId = null;
    permitItemKeyManuallyEdited = false;
    document.getElementById('permitChecklistModalTitle').textContent = 'Add Checklist Item';
    document.getElementById('permitItemId').value = '';
    document.getElementById('permitSectionName').value = currentPermitSectionFilter !== 'all' ? currentPermitSectionFilter : '';
    document.getElementById('permitSectionOrder').value = '0';
    document.getElementById('permitItemOrder').value = '0';
    document.getElementById('permitItemKey').value = '';
    document.getElementById('permitItemKey').disabled = false;
    document.getElementById('permitItemLabel').value = '';
    document.getElementById('permitAlwaysRequired').checked = true;
    document.querySelectorAll('.permit-app-type').forEach(cb => cb.checked = false);
    document.getElementById('permitItemActive').checked = true;
    togglePermitAppTypesVisibility();
    onPermitSectionNameInput();
    document.getElementById('permitChecklistModal').classList.add('show');
}

function editPermitChecklistItem(id) {
    const item = permitChecklistData.find(d => parseInt(d.id) === parseInt(id));
    if (!item) return;

    editingPermitItemId = id;
    document.getElementById('permitChecklistModalTitle').textContent = `Edit: ${item.label}`;
    document.getElementById('permitItemId').value = item.id;
    document.getElementById('permitSectionName').value = item.section_name;
    document.getElementById('permitSectionOrder').value = item.section_order || 0;
    document.getElementById('permitItemOrder').value = item.item_order || 0;
    document.getElementById('permitItemKey').value = item.item_key;
    document.getElementById('permitItemKey').disabled = true;
    document.getElementById('permitItemLabel').value = item.label;
    document.getElementById('permitAlwaysRequired').checked = !!parseInt(item.always_required);
    const activeTypes = String(item.app_types || '').split(',').map(t => t.trim()).filter(Boolean);
    document.querySelectorAll('.permit-app-type').forEach(cb => {
        cb.checked = activeTypes.includes(cb.value);
    });
    document.getElementById('permitItemActive').checked = !!parseInt(item.is_active);
    togglePermitAppTypesVisibility();
    onPermitSectionNameInput();
    document.getElementById('permitChecklistModal').classList.add('show');
}

function closePermitChecklistModal() {
    document.getElementById('permitChecklistModal').classList.remove('show');
    editingPermitItemId = null;
}

async function savePermitChecklistItem() {
    const sectionName = document.getElementById('permitSectionName').value.trim();
    const itemKey = document.getElementById('permitItemKey').value.trim().toLowerCase();
    const label = document.getElementById('permitItemLabel').value.trim();
    const alwaysRequired = document.getElementById('permitAlwaysRequired').checked;
    const appTypes = Array.from(document.querySelectorAll('.permit-app-type:checked')).map(cb => cb.value);
    const isActive = document.getElementById('permitItemActive').checked;

    if (!sectionName) {
        showToast('Section name is required', 'error');
        return;
    }
    if (!label) {
        showToast('Label is required', 'error');
        return;
    }
    if (!editingPermitItemId && (!itemKey || !/^[a-z0-9_]+$/.test(itemKey))) {
        showToast('Item key is required and may only contain lowercase letters, numbers, and underscores', 'error');
        return;
    }
    if (!alwaysRequired && appTypes.length === 0) {
        showToast('Select at least one application type, or mark this item "For All Applicants"', 'error');
        return;
    }

    const btn = document.getElementById('btnSavePermitChecklistItem');
    btn.disabled = true;

    try {
        // Turn the plain-language "where should this appear" choices into
        // real order numbers, shifting any existing rows out of the way
        // first so nothing collides.
        const excludeId = editingPermitItemId ? parseInt(editingPermitItemId) : null;
        const sectionOrder = await resolveSectionOrderAndShiftSiblings(sectionName);
        const itemOrder = await resolveItemOrderAndShiftSiblings(sectionName, excludeId);

        const action = editingPermitItemId ? 'update-permit-checklist-item' : 'add-permit-checklist-item';
        const body = {
            section_name: sectionName,
            section_order: sectionOrder,
            item_order: itemOrder,
            label,
            always_required: alwaysRequired ? 1 : 0,
            app_types: appTypes,
            is_active: isActive ? 1 : 0
        };
        if (editingPermitItemId) {
            body.id = editingPermitItemId;
        } else {
            body.item_key = itemKey;
        }

        const res = await fetch(`${API_URL}/main-settings.php?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        const json = await res.json();

        if (json.success) {
            showToast(json.message, 'success');
            closePermitChecklistModal();
            loadPermitChecklist();
        } else {
            showToast(json.message || 'Failed to save', 'error');
            loadPermitChecklist(); // re-sync in case sibling shifts already went through
        }
    } catch (e) {
        showToast('Failed to save checklist item', 'error');
        loadPermitChecklist();
    } finally {
        btn.disabled = false;
    }
}

async function togglePermitChecklistActive(id, checked) {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=toggle-permit-checklist-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id, is_active: checked ? 1 : 0 })
        });
        const json = await res.json();

        if (json.success) {
            const item = permitChecklistData.find(d => parseInt(d.id) === parseInt(id));
            if (item) item.is_active = checked ? 1 : 0;
            showToast(checked ? 'Marked active' : 'Marked inactive', 'success');
        } else {
            showToast(json.message || 'Failed to update status', 'error');
            loadPermitChecklist();
        }
    } catch (e) {
        showToast('Failed to update status', 'error');
        loadPermitChecklist();
    }
}

async function deletePermitChecklistItem(id, label) {
    if (!confirm(`Delete checklist item "${label}"? This cannot be undone. Consider toggling Status off instead if applications may already reference this item.`)) return;

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-permit-checklist-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id })
        });
        const json = await res.json();

        if (json.success) {
            showToast('Checklist item deleted', 'success');
            loadPermitChecklist();
        } else {
            showToast(json.message || 'Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Failed to delete checklist item', 'error');
    }
}

// ==================== USER ROLES ====================
const ALL_USER_PERMISSIONS = ['dashboard', 'certificates', 'programs', 'speakers', 'checklist', 'school_submissions', 'directory', 'users', 'audit_logs', 'settings'];

let userRolesData = [];
let editingUserRoleId = null;

async function loadUserRoles() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;

    const tbody = document.getElementById('userRolesBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Loading...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=user-roles`, {
            credentials: 'include'
        });

        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }

        const json = await res.json();

        if (json.success) {
            userRolesData = json.data;
            renderUserRolesTable();
        } else {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;">Failed to load</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;">Error loading roles</td></tr>';
    }
}

function renderUserRolesTable() {
    const tbody = document.getElementById('userRolesBody');

    if (!userRolesData.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No roles defined. Add your first role!</td></tr>';
        return;
    }

    tbody.innerHTML = userRolesData.map(r => {
        const perms = Array.isArray(r.default_permissions) ? r.default_permissions : [];
        const permBadges = perms.map(p =>
            `<span class="cap-badge active">${escapeHtml(p)}</span>`
        ).join('');

        return `
        <tr>
            <td><span class="scale-level-badge">${escapeHtml(r.role_name)}</span></td>
            <td>${escapeHtml(r.description || '-')}</td>
            <td>
                <div class="capability-badges">
                    ${permBadges || '<span style="color:#94a3b8;font-size:12px;">None</span>'}
                </div>
            </td>
            <td>${r.user_count || 0}</td>
            <td>
                <div class="action-btns">
                    <button class="btn-action btn-edit" onclick="editUserRole(${r.id})" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete" onclick="deleteUserRole(${r.id}, '${escapeHtml(r.role_name)}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
        `;
    }).join('');
}

function openAddUserRoleModal() {
    editingUserRoleId = null;
    document.getElementById('userRoleModalTitle').textContent = 'Add User Role';
    document.getElementById('userRoleId').value = '';
    document.getElementById('userRoleName').value = '';
    document.getElementById('userRoleDescription').value = '';
    ALL_USER_PERMISSIONS.forEach(p => {
        document.getElementById(`urp_${p}`).checked = p === 'dashboard';
    });
    document.getElementById('userRoleModal').classList.add('show');
}

function editUserRole(id) {
    const role = userRolesData.find(r => r.id == id);
    if (!role) return;

    editingUserRoleId = id;
    document.getElementById('userRoleModalTitle').textContent = 'Edit User Role';
    document.getElementById('userRoleId').value = role.id;
    document.getElementById('userRoleName').value = role.role_name;
    document.getElementById('userRoleDescription').value = role.description || '';
    const perms = Array.isArray(role.default_permissions) ? role.default_permissions : [];
    ALL_USER_PERMISSIONS.forEach(p => {
        document.getElementById(`urp_${p}`).checked = perms.includes(p);
    });
    document.getElementById('userRoleModal').classList.add('show');
}

function closeUserRoleModal() {
    document.getElementById('userRoleModal').classList.remove('show');
    editingUserRoleId = null;
}

async function saveUserRole() {
    const id = document.getElementById('userRoleId').value;
    const roleName = document.getElementById('userRoleName').value.trim();
    const description = document.getElementById('userRoleDescription').value.trim();
    const defaultPermissions = ALL_USER_PERMISSIONS.filter(p =>
        document.getElementById(`urp_${p}`).checked
    );

    if (!roleName) {
        showToast('Role name is required', 'error');
        return;
    }

    const btn = document.getElementById('btnSaveUserRole');
    btn.disabled = true;

    try {
        const action = id ? 'update-user-role' : 'add-user-role';
        const payload = { role_name: roleName, description, default_permissions: defaultPermissions };
        if (id) payload.id = parseInt(id);

        const res = await fetch(`${API_URL}/main-settings.php?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const json = await res.json();

        if (json.success) {
            showToast(json.message, 'success');
            closeUserRoleModal();
            loadUserRoles();
        } else {
            showToast(json.message || 'Failed to save', 'error');
        }
    } catch (e) {
        showToast('Failed to save user role', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function deleteUserRole(id, roleName) {
    if (!confirm(`Delete role "${roleName}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-user-role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id })
        });
        const json = await res.json();

        if (json.success) {
            showToast('User role deleted', 'success');
            loadUserRoles();
        } else {
            showToast(json.message || 'Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Failed to delete user role', 'error');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// QAME SUPER CATEGORIES
// ══════════════════════════════════════════════════════════════════════════

let qameCategories = [];
let availableSubCategories = [];

async function loadQameCategories() {
    // Skip if user doesn't have settings permission
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;
    
    const grid = document.getElementById('qameCategoriesGrid');
    grid.innerHTML = '<div class="loading-cell">Loading QAME categories...</div>';
    
    try {
        const res = await fetch(`${API_URL}/qame_categories.php`, {
            credentials: 'include'
        });
        
        // Handle 403 - hide admin tabs and switch to profile
        if (res.status === 403) {
            hideAdminTabsIfNoPermission(true);
            switchTab('profile');
            return;
        }
        
        const json = await res.json();
        
        if (json.success) {
            qameCategories = json.data || [];
            availableSubCategories = json.available_categories || [];
            renderQameCategories();
        } else {
            grid.innerHTML = `<div class="error-cell">${json.message || 'Failed to load'}</div>`;
        }
    } catch (e) {
        grid.innerHTML = '<div class="error-cell">Failed to load QAME categories. Please run the migration SQL first.</div>';
    }
}

function renderQameCategories() {
    const grid = document.getElementById('qameCategoriesGrid');
    
    if (qameCategories.length === 0) {
        grid.innerHTML = `<div class="no-data-cell">
            <i class="fa-solid fa-layer-group" style="font-size:48px;color:#cbd5e1;margin-bottom:16px;"></i>
            <p>No QAME super categories yet</p>
            <p style="font-size:13px;color:#94a3b8;">Click "Add Super Category" to create Q, A, M, E groupings.</p>
        </div>`;
        return;
    }
    
    grid.innerHTML = qameCategories.map(cat => {
        const mappedHtml = cat.mapped_categories && cat.mapped_categories.length > 0
            ? cat.mapped_categories.map(sub => `
                <div class="qame-sub-item">
                    <span>${escapeHtml(sub.name)}</span>
                    <button class="btn-remove-sub" onclick="removeSubCategoryMapping(${cat.id}, ${sub.id})" title="Remove">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            `).join('')
            : '<div class="qame-no-subs">No sub-categories mapped</div>';
        
        return `
            <div class="qame-super-card">
                <div class="qame-super-header">
                    <div class="qame-super-icon" style="background:${cat.color || '#3b82f6'}">
                        <i class="fa-solid ${cat.icon || 'fa-star'}"></i>
                    </div>
                    <div class="qame-super-info">
                        <div class="qame-super-code">${escapeHtml(cat.code)}</div>
                        <div class="qame-super-name">${escapeHtml(cat.name)}</div>
                    </div>
                    <div class="qame-super-actions">
                        <button class="btn-action btn-edit" onclick="openEditQameCategory(${cat.id})" title="Edit">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="btn-action btn-delete" onclick="deleteQameCategory(${cat.id}, '${escapeHtml(cat.code)}')" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="qame-super-body">
                    <div class="qame-sub-label">Mapped Sub-Categories</div>
                    <div class="qame-sub-list">
                        ${mappedHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function openAddQameCategoryModal() {
    document.getElementById('qameCategoryId').value = '';
    document.getElementById('qameCategoryCode').value = '';
    document.getElementById('qameCategoryName').value = '';
    document.getElementById('qameCategoryDescription').value = '';
    document.getElementById('qameCategoryIcon').value = 'fa-star';
    document.getElementById('qameCategoryColor').value = '#3b82f6';
    document.getElementById('qameCategoryOrder').value = '0';
    document.getElementById('qameCategoryModalTitle').textContent = 'Add QAME Super Category';
    
    renderSubcategoriesChecklist([]);
    document.getElementById('qameCategoryModal').classList.add('show');
}

function openEditQameCategory(id) {
    const cat = qameCategories.find(c => parseInt(c.id) === parseInt(id));
    if (!cat) {
        return;
    }
    
    document.getElementById('qameCategoryId').value = cat.id;
    document.getElementById('qameCategoryCode').value = cat.code;
    document.getElementById('qameCategoryName').value = cat.name;
    document.getElementById('qameCategoryDescription').value = cat.description || '';
    document.getElementById('qameCategoryIcon').value = cat.icon || 'fa-star';
    document.getElementById('qameCategoryColor').value = cat.color || '#3b82f6';
    document.getElementById('qameCategoryOrder').value = cat.display_order || 0;
    document.getElementById('qameCategoryModalTitle').textContent = `Edit Super Category: ${cat.code}`;
    
    const selectedIds = (cat.mapped_categories || []).map(m => parseInt(m.id));
    renderSubcategoriesChecklist(selectedIds);
    document.getElementById('qameCategoryModal').classList.add('show');
}

function closeQameCategoryModal() {
    document.getElementById('qameCategoryModal').classList.remove('show');
}

function renderSubcategoriesChecklist(selectedIds = []) {
    const container = document.getElementById('subcategoriesChecklist');
    
    if (availableSubCategories.length === 0) {
        container.innerHTML = '<div class="no-data-cell" style="padding:20px;text-align:center;color:#94a3b8;">No evaluation categories found</div>';
        return;
    }
    
    container.innerHTML = availableSubCategories.map(sub => `
        <label class="subcategory-checkbox">
            <input type="checkbox" name="subcat" value="${sub.id}" ${selectedIds.includes(parseInt(sub.id)) ? 'checked' : ''}>
            <span class="sub-name">${escapeHtml(sub.name)}</span>
        </label>
    `).join('');
}

async function saveQameCategory() {
    const id = document.getElementById('qameCategoryId').value;
    const code = document.getElementById('qameCategoryCode').value.trim().toUpperCase();
    const name = document.getElementById('qameCategoryName').value.trim();
    const description = document.getElementById('qameCategoryDescription').value.trim();
    const icon = document.getElementById('qameCategoryIcon').value;
    const color = document.getElementById('qameCategoryColor').value;
    const displayOrder = parseInt(document.getElementById('qameCategoryOrder').value) || 0;
    
    if (!code || !name) {
        showToast('Code and Name are required', 'error');
        return;
    }
    
    // Get selected sub-categories
    const checkboxes = document.querySelectorAll('#subcategoriesChecklist input[name="subcat"]:checked');
    const categoryIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    const method = id ? 'PUT' : 'POST';
    const body = {
        code,
        name,
        description,
        icon,
        color,
        display_order: displayOrder,
        category_ids: categoryIds
    };
    if (id) body.id = parseInt(id);
    
    try {
        const res = await fetch(`${API_URL}/qame_categories.php`, {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        const json = await res.json();
        
        if (json.success) {
            showToast(id ? 'Super category updated' : 'Super category created', 'success');
            closeQameCategoryModal();
            loadQameCategories();
        } else {
            showToast(json.message || 'Failed to save', 'error');
        }
    } catch (e) {
        showToast('Failed to save super category', 'error');
    }
}

async function deleteQameCategory(id, code) {
    if (!confirm(`Delete super category "${code}"? This will remove all its sub-category mappings.`)) return;
    
    try {
        const res = await fetch(`${API_URL}/qame_categories.php?id=${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const json = await res.json();
        
        if (json.success) {
            showToast('Super category deleted', 'success');
            loadQameCategories();
        } else {
            showToast(json.message || 'Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Failed to delete super category', 'error');
    }
}

async function removeSubCategoryMapping(superId, categoryId) {
    try {
        const res = await fetch(`${API_URL}/qame_categories.php?action=unmap&super_id=${superId}&category_id=${categoryId}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const json = await res.json();
        
        if (json.success) {
            showToast('Sub-category removed', 'success');
            loadQameCategories();
        } else {
            showToast(json.message || 'Failed to remove', 'error');
        }
    } catch (e) {
        showToast('Failed to remove sub-category', 'error');
    }
}

// ==================== SIGNATORIES ====================
async function loadSignatories() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;

    const fields = ['sig_org_country','sig_org_department','sig_org_division','sig_org_section',
                    'sig_prepared_name','sig_prepared_title',
                    'sig_checked_name','sig_checked_title',
                    'sig_noted1_name','sig_noted1_title',
                    'sig_noted2_name','sig_noted2_title',
                    'sig_noted3_name','sig_noted3_title'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.disabled = true; el.placeholder = 'Loading...'; }
    });

    try {
        const res = await fetch(`${API_URL}/programs.php?signatories`, { credentials: 'include' });

        if (res.status === 403) { switchTab('profile'); return; }

        const json = await res.json();
        if (!json.success || !json.data) {
            showToast('Failed to load signatory settings', 'error');
            return;
        }

        const d = json.data;
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };

        set('sig_org_country',    d.org.country);
        set('sig_org_department', d.org.department);
        set('sig_org_division',   d.org.division);
        set('sig_org_section',    d.org.section);
        set('sig_prepared_name',  d.preparedBy.name);
        set('sig_prepared_title', d.preparedBy.title);
        set('sig_checked_name',   d.checkedBy.name);
        set('sig_checked_title',  d.checkedBy.title);
        set('sig_noted1_name',    d.noted[0] ? d.noted[0].name  : '');
        set('sig_noted1_title',   d.noted[0] ? d.noted[0].title : '');
        set('sig_noted2_name',    d.noted[1] ? d.noted[1].name  : '');
        set('sig_noted2_title',   d.noted[1] ? d.noted[1].title : '');
        set('sig_noted3_name',    d.noted[2] ? d.noted[2].name  : '');
        set('sig_noted3_title',   d.noted[2] ? d.noted[2].title : '');

    } catch (e) {
        showToast('Error loading signatory settings', 'error');
    } finally {
        const placeholders = {
            sig_org_country:    'e.g., Republic of the Philippines',
            sig_org_department: 'e.g., Department of Education',
            sig_org_division:   'e.g., Schools Division of Pampanga',
            sig_org_section:    'e.g., Schools Governance and Operations Division (SGOD)',
            sig_prepared_name:  'Full name in ALL CAPS',
            sig_prepared_title: 'e.g., EPS II-SMME',
            sig_checked_name:   'Full name in ALL CAPS',
            sig_checked_title:  'e.g., SEPS-SMME',
            sig_noted1_name:    'Full name in ALL CAPS',
            sig_noted1_title:   'e.g., Chief Education Supervisor-SGOD',
            sig_noted2_name:    'Full name in ALL CAPS',
            sig_noted2_title:   'e.g., Assistant Schools Division Superintendent',
            sig_noted3_name:    'Full name in ALL CAPS',
            sig_noted3_title:   'e.g., Schools Division Superintendent',
        };
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = false;
                el.placeholder = placeholders[id] || '';
            }
        });
    }
}

// Roles that only make sense as office-managed (shared across every school),
// mirrored from the calendar/tuition builders' OFFICE_ONLY_ROLES lists.
const OFFICE_ONLY_SIG_ROLES = ['rd', 'sds', 'recommending', 'final_approver', 'chk_checked_by', 'validated_by', 'noted_by'];

function toggleSchoolSigScope(userInitiated) {
    // If the user manually switches scope while mid-edit, that edit no longer
    // applies (it belongs to the previous scope/school) — cancel it so Save
    // creates a new signatory instead of silently overwriting the old one.
    if (userInitiated && editingSchoolSignatoryId !== null) {
        cancelEditSchoolSignatory({ skipReload: true });
    }
    const scope = document.getElementById('schoolSigScope')?.value || 'school';
    const schoolRow = document.getElementById('schoolSigSchoolRow');
    const schoolSelect = document.getElementById('schoolSigSchool');
    if (schoolRow) schoolRow.style.display = scope === 'school' ? '' : 'none';
    if (schoolSelect) schoolSelect.disabled = scope !== 'school';
    if (scope === 'office') {
        const schoolField = document.getElementById('schoolSigSchool');
        if (schoolField) schoolField.value = '';
    }

    // School-owned scope can't offer roles that are reserved for the shared
    // office-managed signatories (RD, SDS, Recommending, Final Approver,
    // Checklist Checked By, Validated By, Noted By) — those must only ever
    // exist as office rows.
    const roleSelect = document.getElementById('schoolSigRole');
    if (roleSelect) {
        let switchedAway = false;
        Array.from(roleSelect.options).forEach(opt => {
            const isOfficeOnly = OFFICE_ONLY_SIG_ROLES.includes(opt.value);
            const hide = scope === 'school' && isOfficeOnly;
            opt.hidden = hide;
            opt.disabled = hide;
            if (hide && opt.selected) switchedAway = true;
        });
        if (switchedAway) {
            const firstAvailable = Array.from(roleSelect.options).find(o => !o.disabled);
            if (firstAvailable) roleSelect.value = firstAvailable.value;
        }
    }
}

async function loadPrivateSchoolsForSignatories() {
    const select = document.getElementById('schoolSigSchool');
    if (!select) return;
    try {
        const res = await fetch(`${API_URL}/get-private-schools.php`, { credentials: 'include' });
        const json = await res.json();
        privateSchoolsList = json.success && Array.isArray(json.data) ? json.data : [];
        const current = select.value;
        select.innerHTML = '<option value="">Select a private school</option>' + privateSchoolsList.map(s => {
            const address = s.address ? ` - ${s.address}` : '';
            return `<option value="${s.id}">${escapeHtml(s.name)}${escapeHtml(address)}</option>`;
        }).join('');
        if (current) select.value = current;
    } catch (e) {
        privateSchoolsList = [];
    }
}

function _schoolSigRoleLabel(role) {
    return ({
        principal: 'Principal',
        reviewed_by: 'Processed and Evaluated By',
        validated_by: 'Validated By',
        noted_by: 'Noted By',
        rd: 'Regional Director',
        sds: 'Schools Division Superintendent (Thru)',
        recommending: 'Recommending Approval',
        final_approver: 'Final Approver',
        chk_checked_by: 'Checklist – Checked By'
    })[role] || role;
}

function _schoolSigBuilderLabel(builderType) {
    return ({
        calendar: 'School Calendar',
        tuition:  'Tuition Fee',
        shared:   'Both (Shared)'
    })[builderType] || (builderType || '—');
}

async function loadSchoolSignatories() {
    if (typeof Permissions !== 'undefined' && !Permissions.has('settings')) return;
    const scope = document.getElementById('schoolSigScope')?.value || 'school';
    const schoolId = document.getElementById('schoolSigSchool')?.value || '';
    const tbody = document.getElementById('schoolSignatoriesBody');
    if (!tbody) return;

    if (scope === 'school' && !schoolId) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">Select a private school to load signatories.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">Loading signatories...</td></tr>';
    try {
        const params = new URLSearchParams();
        params.set('action', 'school-signatories');
        params.set('scope_type', scope);
        if (scope === 'school') params.set('private_school_id', schoolId);
        const res = await fetch(`${API_URL}/main-settings.php?${params.toString()}`, { credentials: 'include' });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Failed to load');
        schoolSignatories = json.data?.signatories || [];

        if (!schoolSignatories.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">No signatories found.</td></tr>';
            return;
        }

        tbody.innerHTML = schoolSignatories.map(row => `
            <tr id="schoolSigRow_${Number(row.id)}" class="${Number(row.id) === Number(editingSchoolSignatoryId) ? 'is-editing-row' : ''}">
                <td><span class="nav-badge" style="display:inline-flex;">${row.private_school_id ? 'School' : 'Office'}</span></td>
                <td><span class="nav-badge" style="display:inline-flex;">${escapeHtml(_schoolSigBuilderLabel(row.builder_type))}</span></td>
                <td>${escapeHtml(_schoolSigRoleLabel(row.role))}${String(row.is_default) === '1' ? ' <span class="nav-badge" style="display:inline-flex;background:#eff6ff;color:#1d4ed8;">Default</span>' : ''}</td>
                <td>${escapeHtml(row.full_name || '')}</td>
                <td>${escapeHtml(row.position_title || '')}</td>
                <td>${escapeHtml([row.office, row.city].filter(Boolean).join(' · '))}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-action btn-edit${Number(row.id) === Number(editingSchoolSignatoryId) ? ' is-active' : ''}" onclick="editSchoolSignatory(${Number(row.id)})" title="Edit"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn-action btn-delete" onclick="deleteSchoolSignatory(${Number(row.id)})" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Failed to load school signatories.</td></tr>';
    }
}

function editSchoolSignatory(id) {
    const row = schoolSignatories.find(s => Number(s.id) === Number(id));
    if (!row) return;
    editingSchoolSignatoryId = Number(id);
    document.getElementById('schoolSigScope').value = row.private_school_id ? 'school' : 'office';
    toggleSchoolSigScope();
    if (row.private_school_id) document.getElementById('schoolSigSchool').value = String(row.private_school_id);
    document.getElementById('schoolSigRole').value = row.role || 'principal';
    document.getElementById('schoolSigFullName').value = row.full_name || '';
    document.getElementById('schoolSigPosition').value = row.position_title || '';
    document.getElementById('schoolSigOffice').value = row.office || '';
    document.getElementById('schoolSigCity').value = row.city || '';
    document.getElementById('schoolSigContact').value = row.contact || '';
    document.getElementById('schoolSigDefault').checked = String(row.is_default) === '1';

    const saveBtn = document.getElementById('btnSaveSchoolSig');
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update School Signatory';
    const cancelBtn = document.getElementById('btnCancelSchoolSig');
    if (cancelBtn) cancelBtn.style.display = '';
    const banner = document.getElementById('schoolSigEditingBanner');
    const bannerName = document.getElementById('schoolSigEditingName');
    if (banner) banner.style.display = 'flex';
    if (bannerName) bannerName.textContent = row.full_name ? `"${row.full_name}"` : 'this signatory';

    // Reflect the active row in the table and scroll the form into view so
    // it's obvious what's being edited (and that it can be cancelled).
    document.querySelectorAll('#schoolSignatoriesBody tr').forEach(tr => tr.classList.remove('is-editing-row'));
    document.querySelectorAll('#schoolSignatoriesBody .btn-action.btn-edit').forEach(btn => btn.classList.remove('is-active'));
    const activeRow = document.getElementById(`schoolSigRow_${Number(id)}`);
    if (activeRow) {
        activeRow.classList.add('is-editing-row');
        activeRow.querySelector('.btn-action.btn-edit')?.classList.add('is-active');
    }
    banner?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetSchoolSigForm() {
    editingSchoolSignatoryId = null;
    ['schoolSigFullName', 'schoolSigPosition', 'schoolSigOffice', 'schoolSigCity', 'schoolSigContact'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const roleEl = document.getElementById('schoolSigRole');
    if (roleEl) roleEl.selectedIndex = 0;
    const defaultEl = document.getElementById('schoolSigDefault');
    if (defaultEl) defaultEl.checked = false;

    const saveBtn = document.getElementById('btnSaveSchoolSig');
    if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save School Signatory';
    const cancelBtn = document.getElementById('btnCancelSchoolSig');
    if (cancelBtn) cancelBtn.style.display = 'none';
    const banner = document.getElementById('schoolSigEditingBanner');
    if (banner) banner.style.display = 'none';

    document.querySelectorAll('#schoolSignatoriesBody tr').forEach(tr => tr.classList.remove('is-editing-row'));
    document.querySelectorAll('#schoolSignatoriesBody .btn-action.btn-edit').forEach(btn => btn.classList.remove('is-active'));
}

function cancelEditSchoolSignatory(opts) {
    const wasEditing = editingSchoolSignatoryId !== null;
    resetSchoolSigForm();
    if (wasEditing && !(opts && opts.skipReload)) {
        showToast('Edit cancelled', 'info');
    }
}

async function saveSchoolSignatory() {
    const scope = document.getElementById('schoolSigScope')?.value || 'school';
    const schoolId = document.getElementById('schoolSigSchool')?.value || '';
    const payload = {
        action: 'school-signatories',
        scope_type: scope,
        id: editingSchoolSignatoryId || null,
        private_school_id: scope === 'school' ? Number(schoolId || 0) : null,
        role: document.getElementById('schoolSigRole')?.value || '',
        full_name: document.getElementById('schoolSigFullName')?.value.trim() || '',
        position_title: document.getElementById('schoolSigPosition')?.value.trim() || '',
        office: document.getElementById('schoolSigOffice')?.value.trim() || '',
        city: document.getElementById('schoolSigCity')?.value.trim() || '',
        contact: document.getElementById('schoolSigContact')?.value.trim() || '',
        is_default: document.getElementById('schoolSigDefault')?.checked ? 1 : 0,
    };
    if (scope === 'school' && !payload.private_school_id) {
        showToast('Select a private school first.', 'error');
        return;
    }
    if (!payload.role || !payload.full_name) {
        showToast('Role and full name are required.', 'error');
        return;
    }

    const btn = document.getElementById('btnSaveSchoolSig');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=school-signatories`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Failed to save');
        showToast(editingSchoolSignatoryId ? 'School signatory updated' : 'School signatory saved', 'success');
        resetSchoolSigForm();
        loadSchoolSignatories();
    } catch (e) {
        showToast(e.message || 'Error saving school signatory', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function deleteSchoolSignatory(id) {
    const row = schoolSignatories.find(s => Number(s.id) === Number(id));
    if (!row) return;
    if (!confirm(`Delete ${row.full_name}?`)) return;
    const scope = row.private_school_id ? 'school' : 'office';
    const params = new URLSearchParams({ action: 'school-signatories', id: String(id) });
    params.set('scope_type', scope);
    if (scope === 'school') params.set('private_school_id', String(row.private_school_id));

    try {
        const res = await fetch(`${API_URL}/main-settings.php?${params.toString()}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Failed to delete');
        showToast('School signatory deleted', 'success');
        if (Number(editingSchoolSignatoryId) === Number(id)) resetSchoolSigForm();
        loadSchoolSignatories();
    } catch (e) {
        showToast(e.message || 'Error deleting school signatory', 'error');
    }
}

async function saveSignatories() {
    const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

    const payload = {
        org: {
            country:    get('sig_org_country'),
            department: get('sig_org_department'),
            division:   get('sig_org_division'),
            section:    get('sig_org_section'),
            unit:       '',
        },
        preparedBy: {
            name:  get('sig_prepared_name'),
            title: get('sig_prepared_title'),
        },
        checkedBy: {
            name:  get('sig_checked_name'),
            title: get('sig_checked_title'),
        },
        noted: [
            { name: get('sig_noted1_name'), title: get('sig_noted1_title') },
            { name: get('sig_noted2_name'), title: get('sig_noted2_title') },
            { name: get('sig_noted3_name'), title: get('sig_noted3_title') },
        ].filter(n => n.name !== ''),
    };

    if (!payload.preparedBy.name || !payload.checkedBy.name) {
        showToast('Prepared By and Checked By names are required', 'error');
        return;
    }

    const btn = document.getElementById('btnSaveSignatories');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const res = await fetch(`${API_URL}/programs.php?signatories`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const json = await res.json();

        if (json.success) {
            showToast('Signatory settings saved', 'success');
        } else {
            showToast(json.message || 'Failed to save', 'error');
        }
    } catch (e) {
        showToast('Error saving signatory settings', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
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
// escapeHtml is defined above in the FILE MANAGEMENT section

// ==================== CONTACT US ====================

async function loadContactInfo() {
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=contact-info`, { credentials: 'include' });
        if (!res.ok) return;
        const json = await res.json();
        if (json.success && json.data) {
            const d = json.data;
            if (d.address !== undefined) document.getElementById('ci_address').value = d.address || '';
            if (d.email !== undefined) document.getElementById('ci_email').value = d.email || '';
            if (d.phone !== undefined) document.getElementById('ci_phone').value = d.phone || '';
            if (d.hours !== undefined) document.getElementById('ci_hours').value = d.hours || '';
        }
    } catch (e) {
        console.warn('Could not load contact info:', e);
    }
}

async function saveContactInfo(event) {
    event.preventDefault();
    const btn = document.getElementById('btnSaveContactInfo');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    try {
        const payload = {
            address: document.getElementById('ci_address').value.trim(),
            email:   document.getElementById('ci_email').value.trim(),
            phone:   document.getElementById('ci_phone').value.trim(),
            hours:   document.getElementById('ci_hours').value.trim()
        };
        const res = await fetch(`${API_URL}/main-settings.php?action=contact-info`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            showToast('Contact info saved successfully', 'success');
        } else {
            showToast(json.message || 'Failed to save contact info', 'error');
        }
    } catch (e) {
        showToast('Network error saving contact info', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Contact Info';
    }
}

async function loadContactSubmissions() {
    const tbody = document.getElementById('contactSubmissionsBody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">Loading...</td></tr>';
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=contact-submissions`, { credentials: 'include' });
        if (!res.ok) throw new Error('Server error');
        const json = await res.json();
        if (!json.success || !Array.isArray(json.data) || json.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">No submissions yet.</td></tr>';
            return;
        }
        tbody.innerHTML = json.data.map(row => `
            <tr>
                <td>${escapeHtml(row.name || '')}</td>
                <td><a href="mailto:${escapeHtml(row.email || '')}">${escapeHtml(row.email || '')}</a></td>
                <td>${escapeHtml(row.school || '—')}</td>
                <td>${escapeHtml(row.concern || '—')}</td>
                <td style="max-width:220px;white-space:normal;word-break:break-word">${escapeHtml(row.message || '')}</td>
                <td>${escapeHtml(row.created_at || '')}</td>
                <td>
                    <button class="btn-icon-action btn-icon-delete" title="Delete" onclick="deleteContactSubmission(${row.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">Error loading submissions.</td></tr>';
    }
}

async function deleteContactSubmission(id) {
    if (!confirm('Delete this message submission?')) return;
    try {
        const res = await fetch(`${API_URL}/main-settings.php?action=delete-contact-submission&id=${id}`, {
            method: 'POST',
            credentials: 'include'
        });
        const json = await res.json();
        if (json.success) {
            showToast('Submission deleted', 'success');
            loadContactSubmissions();
        } else {
            showToast(json.message || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}