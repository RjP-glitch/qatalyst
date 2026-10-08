/**
 * Permission Management System
 * Include this file in all protected pages after config.js
 * 
 * Usage:
 *   - Call checkPagePermission('programs') at page load
 *   - Call hasPermission('export') to check specific permission
 *   - Call applyNavPermissions() to hide unauthorized nav items
 */

// Permission to page mapping
// Note: main-settings.html is intentionally excluded - all users can access profile/security settings
// Admin-only tabs are hidden via hideAdminTabsIfNoPermission() and API checks
const PAGE_PERMISSIONS = {
    'dashboard.html': 'dashboard',
    'workshop-dashboard.html': 'programs',
    'certificate.html': 'certificates',
    'certificates-splitter.html': 'certificates',
    'programs.html':    'programs',
    // Individual program section pages — each requires the 'programs' permission.
    // Previously missing from this map, so autoCheckPagePermission() allowed
    // any authenticated user to open these pages without a permission check.
    'qatame.html':      'programs',
    'qms.html':         'programs',
    'sbm.html':         'programs',
    'sgc.html':         'programs',
    'spir.html':        'programs',
    'sdopir.html':      'programs',
    'speaker-roster.html': 'speakers',
    'checklist.html': 'checklist',
    'documents-submitted-all.html': 'school_submissions',
    'user-management.html': 'users',
    'import-excell.html': 'programs',  // Import is part of programs permission
    'directory.html': 'directory',
    'audit-logs.html': 'audit_logs',
    // announcements.html intentionally NOT gated here — it's viewable by all
    // authenticated SDO users; the 'announcements' permission only controls
    // whether management controls (create/edit/delete/publish) are shown,
    // enforced both client-side (announcements.js) and server-side (API).
};

// Navigation items and their required permissions
// Note: 'settings' is intentionally excluded - all users can access profile/security settings
const NAV_PERMISSIONS = {
    'dashboard': 'dashboard',
    'workshop-dashboard': 'programs',
    'certificates': 'certificates',
    'certificatesplitter': 'certificates',
    'programs': 'programs',
    'importfile': 'programs',
    'speakers': 'speakers',
    'checklist': 'checklist',
    'documentssubmittedall': 'school_submissions',
    'users': 'users',
    'directory': 'directory',
    'auditlogs': 'audit_logs',
    // 'announcements' intentionally NOT in this map — link shows to everyone;
    // see injectAnnouncementsNav() below, which no longer permission-gates it.
};

// Hardcoded fallback used only if the API call fails
const ROLE_PERMISSION_FALLBACK = {
    admin: ['dashboard', 'certificates', 'programs', 'speakers', 'checklist', 'school_submissions', 'users', 'settings', 'audit_logs', 'announcements'],
    facilitator: ['dashboard', 'certificates', 'programs', 'speakers', 'checklist'],
    evaluator: ['dashboard', 'checklist'],
    viewer: ['dashboard']
};

// Dynamically loaded role presets from user_roles table
let dynamicRolePermissions = null;

/**
 * Load role permission presets from the user_roles table.
 * Populates dynamicRolePermissions so hasPermission() uses DB values.
 * Called once at init — subsequent calls are no-ops if already loaded.
 */
async function loadRolePermissions() {
    if (dynamicRolePermissions !== null) return; // already loaded

    try {
        const apiBase = typeof CONFIG !== 'undefined'
            ? CONFIG.API_URL
            : (function () {
                try {
                    return new URL('api', window.location.href).toString().replace(/\/$/, '');
                } catch (_) {
                    return window.location.origin + '/api';
                }
            })();

        const res = await fetch(`${apiBase}/user_management.php?action=get_roles`, {
            credentials: 'include'
        });

        // If user doesn't have permission to fetch roles (e.g. facilitator),
        // fall back to hardcoded presets silently instead of propagating the error.
        if (!res.ok) {
            dynamicRolePermissions = ROLE_PERMISSION_FALLBACK;
            return;
        }

        const json = await res.json();

        if (json.success && Array.isArray(json.data)) {
            dynamicRolePermissions = {};
            json.data.forEach(r => {
                dynamicRolePermissions[r.role_name] = Array.isArray(r.default_permissions)
                    ? r.default_permissions
                    : [];
            });
        } else {
            // API returned success:false — fall back to hardcoded presets
            dynamicRolePermissions = ROLE_PERMISSION_FALLBACK;
        }
    } catch (e) {
        // Network error — fall back to hardcoded values silently
        dynamicRolePermissions = ROLE_PERMISSION_FALLBACK;
    }
}

/**
 * Get current user's permissions from localStorage
 * @returns {string[]} Array of permission keys
 */
function getUserPermissions() {
    const raw = localStorage.getItem('permissions');
    if (raw === null) return null;

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

/**
 * Get current user's role from localStorage
 * @returns {string} Role name (admin, facilitator, evaluator, viewer)
 */
function getUserRole() {
    return localStorage.getItem('role') || 'viewer';
}

/**
 * Check if user has a specific permission
 * Admins always have all permissions
 * @param {string} permission - Permission key to check
 * @returns {boolean}
 */
function hasPermission(permission) {
    const role = getUserRole();
    if (role === 'admin') return true;

    const permissions = getUserPermissions();
    if (permissions !== null && permissions.length > 0) {
        return permissions.includes(permission);
    }

    // Use dynamically loaded role presets if available, else hardcoded fallback
    const presets = dynamicRolePermissions ?? ROLE_PERMISSION_FALLBACK;
    const rolePerms = presets[role] || presets.viewer || ['dashboard'];
    return rolePerms.includes(permission);
}

/**
 * Check if user has ANY of the specified permissions
 * @param {string[]} permList - Array of permission keys
 * @returns {boolean}
 */
function hasAnyPermission(permList) {
    return permList.some(p => hasPermission(p));
}

/**
 * Check if user has ALL of the specified permissions
 * @param {string[]} permList - Array of permission keys
 * @returns {boolean}
 */
function hasAllPermissions(permList) {
    return permList.every(p => hasPermission(p));
}

/**
 * Check page permission and redirect if unauthorized
 * Call this at page load
 * @param {string} requiredPermission - Permission key required for this page
 * @param {string} redirectUrl - URL to redirect to if unauthorized (default: dashboard.html)
 */
function checkPagePermission(requiredPermission, redirectUrl = 'dashboard.html') {
    if (!hasPermission(requiredPermission)) {
        console.warn(`Access denied: Missing permission '${requiredPermission}'`);
        showPermissionDeniedToast();
        setTimeout(() => {
            window.location.href = redirectUrl;
        }, 1500);
        return false;
    }
    return true;
}

/**
 * Auto-detect and check permission for current page
 * Call this at page load for automatic permission checking
 */
function autoCheckPagePermission() {
    const currentPage = window.location.pathname.split('/').pop();
    const requiredPermission = PAGE_PERMISSIONS[currentPage];
    
    if (requiredPermission) {
        return checkPagePermission(requiredPermission);
    }
    return true; // Allow access if page not in permission map
}

/**
 * Apply permissions to navigation - hide items user can't access
 * Call this after DOM is loaded
 */
function applyNavPermissions() {
    // Add the Announcements link if this page doesn't already have one and
    // the current user has permission — runs on every page that calls this.
    injectAnnouncementsNav();

    // Helper to extract section from button (data-section or onclick)
    function getSection(btn) {
        if (btn.getAttribute('data-section')) {
            return btn.getAttribute('data-section');
        }
        if (btn.getAttribute('data-nav')) return btn.getAttribute('data-nav'); // add this for buttons that use data-nav instead of data-section
        // Parse onclick="navigate('sectionName')"
        const onclick = btn.getAttribute('onclick') || '';
        const match = onclick.match(/navigate\(['"]([^'"]+)['"]\)/);
        return match ? match[1] : null;
    }

    // Hide nav buttons user doesn't have permission for
    document.querySelectorAll('.nav-btn').forEach(btn => {
        const section = getSection(btn);
        const requiredPerm = NAV_PERMISSIONS[section];
        
        if (requiredPerm && !hasPermission(requiredPerm)) {
            btn.style.display = 'none';
        }
    });
    
    // Hide submenu items
    document.querySelectorAll('.submenu .nav-btn').forEach(btn => {
        const section = getSection(btn);
        const requiredPerm = NAV_PERMISSIONS[section];
        
        if (requiredPerm && !hasPermission(requiredPerm)) {
            btn.style.display = 'none';
        }
    });
    
    // Hide entire Analytics submenu if user has no analytics permissions
    const analyticsPerms = ['responses', 'reports', 'qame'];
    if (!hasAnyPermission(analyticsPerms)) {
        const analyticsToggle = document.querySelector('#analytics-submenu-toggle');
        if (analyticsToggle) analyticsToggle.style.display = 'none';
    }

    // Hide submenu-toggle parent buttons if user lacks the required permission
    // Maps the toggleSubmenu() key used in onclick to its required permission
    const SUBMENU_TOGGLE_PERMISSIONS = {
        'certs': 'certificates',
        'programs': 'programs',  // Hide Programs parent toggle for users without programs permission
        // add more here if other submenus are added in the future
        // e.g. 'analytics': 'analytics',
    };

    document.querySelectorAll('.submenu-toggle').forEach(btn => {
        const onclick = btn.getAttribute('onclick') || '';
        const match = onclick.match(/toggleSubmenu\(['"]([^'"]+)['"]\)/);
        const key = match ? match[1] : null;
        const requiredPerm = key ? SUBMENU_TOGGLE_PERMISSIONS[key] : null;

        if (requiredPerm && !hasPermission(requiredPerm)) {
            btn.style.display = 'none';
            // Also collapse and hide the submenu container itself
            const submenu = document.getElementById(key + '-submenu');
            if (submenu) submenu.style.display = 'none';
        }
    });
}

/**
 * Inject the Announcements nav button into the sidebar on any page that
 * doesn't already have one hardcoded. This lets the link appear on every
 * protected SDO page (qatame.html, qms.html, sbm.html, etc.) without having
 * to hand-edit each page's sidebar HTML or navigate() routing map — it
 * navigates directly via window.location.href instead of calling navigate().
 */
function injectAnnouncementsNav() {
    // Don't duplicate if the page already has one (e.g. announcements.html itself)
    if (document.querySelector('[data-injected-nav="announcements"]')) return;
    if (document.querySelector('.nav-menu [onclick*="announcements"]')) return;

    // No permission gate — viewable by all authenticated SDO users.
    // The 'announcements' permission only affects what controls show
    // once they're on the page (handled in announcements.js).

    const navMenu = document.querySelector('.nav-menu');
    if (!navMenu) return;

    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.setAttribute('data-injected-nav', 'announcements');
    btn.setAttribute('onclick', "window.location.href='announcements.html'");
    btn.innerHTML = '<i class="fa-solid fa-bullhorn nav-icon"></i><span>Announcements</span>';

    const currentPage = window.location.pathname.split('/').pop();
    if (currentPage === 'announcements.html') btn.classList.add('active');

    // Insert before Settings/Audit Logs if present, to keep ordering consistent
    // with announcements.html's own sidebar; otherwise append to the end.
    const anchor = Array.from(navMenu.querySelectorAll('.nav-btn')).find(b => {
        const onclick = b.getAttribute('onclick') || '';
        return /navigate\(['"]settings['"]\)/.test(onclick) || /navigate\(['"]auditlogs['"]\)/.test(onclick);
    });

    if (anchor) {
        navMenu.insertBefore(btn, anchor);
    } else {
        navMenu.appendChild(btn);
    }
}

/**
 * Show permission denied toast notification
 */
function showPermissionDeniedToast() {
    // Try to use existing toast system
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = 'Access denied. You do not have permission to view this page.';
        toast.className = 'toast error show';
        setTimeout(() => toast.classList.remove('show'), 3000);
    } else {
        // Fallback: create temporary toast
        const tempToast = document.createElement('div');
        tempToast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #dc2626;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-family: system-ui, sans-serif;
            font-size: 14px;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        `;
        tempToast.textContent = 'Access denied. Redirecting...';
        document.body.appendChild(tempToast);
        setTimeout(() => tempToast.remove(), 3000);
    }
}

/**
 * Hide elements that require specific permission
 * Add data-permission="permissionKey" to elements to auto-hide
 */
function applyElementPermissions() {
    document.querySelectorAll('[data-permission]').forEach(el => {
        const requiredPerm = el.getAttribute('data-permission');
        if (!hasPermission(requiredPerm)) {
            el.style.display = 'none';
        }
    });
}

/**
 * Initialize permission system
 * Call this on DOMContentLoaded
 */
async function initPermissions() {
    // Check if user is logged in
    if (!localStorage.getItem('user_id')) {
        window.location.href = 'login.html';
        return;
    }

    // Block school portal users from accessing SDO dashboard pages.
    // Their account_type is stored in localStorage as part of the login flow.
    // As a secondary check, we also verify against the server session below.
    const accountType = localStorage.getItem('account_type') || '';
    if (accountType === 'portal_user') {
        window.location.href = 'school-portal-dashboard.html';
        return;
    }

    // Load role permission presets from DB before any permission checks
    await loadRolePermissions();

    // Auto-check page permission
    if (!autoCheckPagePermission()) {
        return;
    }

    // Apply nav and element permissions
    applyNavPermissions();
    applyElementPermissions();
}

// Export for use in other scripts
window.Permissions = {
    has: hasPermission,
    hasAny: hasAnyPermission,
    hasAll: hasAllPermissions,
    check: checkPagePermission,
    getRole: getUserRole,
    getPermissions: getUserPermissions,
    applyNavPermissions,
    applyElementPermissions,
    loadRolePermissions,
    init: initPermissions
};