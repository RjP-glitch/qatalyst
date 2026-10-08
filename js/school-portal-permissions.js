/**
 * School Portal Permission System
 * Include this file in all school portal pages after config.js
 *
 * Usage:
 *   - Call initPortalPermissions() at page load (auto-applies nav + element hiding)
 *   - Call hasPortalAccess('tracker') to check a specific feature
 *   - Call applyPortalNav() to manually re-apply nav hiding after dynamic render
 *
 * School types:
 *   'public'  → Dashboard, Audit Logs, Profile, My Submissions (locked)
 *   'private' → Full access to all portal features
 */

// ── Feature access map per school type ───────────────────────────────────────
// Keys match data-portal-nav attributes on nav buttons in HTML.
const PORTAL_NAV_ACCESS = {
    'dashboard':     { public: true,  private: true  },
    'submissions':   { public: true,  private: true  },   // public = locked/soon
    'tracker':       { public: false, private: true  },
    'calendar':      { public: false, private: true  },
    'tuition':       { public: false, private: true  },
    'permit':        { public: true,  private: true  },
    'audit':         { public: true,  private: true  },
    'profile':       { public: true,  private: true  },
    // Viewable by all authenticated portal users regardless of school type.
    // The sidebar link itself is injected by config.js (guarded on
    // .school-pill-sidebar), not by applyPortalNav() below — this entry
    // exists so hasPortalAccess('announcements') resolves correctly if
    // anything else checks it (e.g. data-portal-feature elements).
    'announcements': { public: true,  private: true  },
};

// Features that are visible to public schools but locked (not yet built)
const PORTAL_LOCKED_FOR_PUBLIC = ['submissions'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPortalSchoolType() {
    return (localStorage.getItem('edu_school_type') || '').toLowerCase();
}

function isPublicSchool() {
    return getPortalSchoolType().includes('public');
}

function isPrivateSchool() {
    const t = getPortalSchoolType();
    return t.includes('private') || t.includes('suc');
}

/**
 * Check if the current user has access to a portal feature.
 * @param {string} feature - Key from PORTAL_NAV_ACCESS (e.g. 'tracker')
 * @returns {boolean}
 */
function hasPortalAccess(feature) {
    if (!['dashboard', 'profile', 'audit', 'announcements'].includes(feature)
        && localStorage.getItem('edu_school_approved') !== '1') return false;
    const rule = PORTAL_NAV_ACCESS[feature];
    if (!rule) return true; // unknown feature — allow by default

    if (isPublicSchool())  return rule.public;
    if (isPrivateSchool()) return rule.private;
    return true; // fallback: allow if school type unknown
}

/**
 * Check if a feature is accessible but locked (shown as "Coming Soon")
 * @param {string} feature
 * @returns {boolean}
 */
function isPortalFeatureLocked(feature) {
    return isPublicSchool() && PORTAL_LOCKED_FOR_PUBLIC.includes(feature);
}

// ── Nav application ───────────────────────────────────────────────────────────
/**
 * Apply portal nav visibility rules based on school type.
 * Buttons need data-portal-nav="featureKey" attribute.
 * Call this after sidebar HTML is rendered.
 */
function applyPortalNav() {
    document.querySelectorAll('[data-portal-nav]').forEach(btn => {
        const feature = btn.getAttribute('data-portal-nav');
        const hasAccess = hasPortalAccess(feature);
        const isLocked  = isPortalFeatureLocked(feature);

        if (!hasAccess) {
            // Completely hide from public school users
            btn.style.display = 'none';
            return;
        }
        btn.style.display = '';

        if (isLocked) {
            // Show but disabled with a "Soon" badge
            btn.style.opacity        = '0.5';
            btn.style.pointerEvents  = 'none';
            btn.style.cursor         = 'not-allowed';

            // Remove existing onclick to be safe
            btn.removeAttribute('onclick');

            // Add "Soon" badge if not already added
            if (!btn.querySelector('.portal-soon-badge')) {
                const badge = document.createElement('span');
                badge.className = 'portal-soon-badge nav-badge';
                badge.style.cssText = 'background:#f59e0b;color:#fff;font-size:9px;padding:2px 6px;border-radius:20px;margin-left:auto;flex-shrink:0;';
                badge.textContent = 'Soon';
                btn.appendChild(badge);
            }
        }
    });
    let notice = document.getElementById('schoolApprovalNotice');
    const main = document.querySelector('.main-content');
    if (!notice && main) {
        notice = document.createElement('p');
        notice.id = 'schoolApprovalNotice';
        notice.setAttribute('role', 'status');
        notice.style.cssText = 'padding:12px 16px;margin:12px 0;border-radius:8px;background:#fff3cd;color:#664d03;';
        main.prepend(notice);
    }
    if (notice) {
        notice.hidden = localStorage.getItem('edu_school_approved') === '1';
        notice.textContent = 'School access is awaiting SDO approval. You can manage your personal profile while waiting. Contact SDO to confirm your school affiliation.';
    }
}

/**
 * Hide elements with data-portal-feature="featureKey" if user lacks access.
 */
function applyPortalElementPermissions() {
    document.querySelectorAll('[data-portal-feature]').forEach(el => {
        const feature = el.getAttribute('data-portal-feature');
        el.style.display = hasPortalAccess(feature) ? '' : 'none';
    });
}

// ── Page guard ────────────────────────────────────────────────────────────────
// Maps portal page filenames to their required feature key
const PORTAL_PAGE_FEATURES = {
    'school-portal-dashboard.html':    'dashboard',
    'school-portal-submissions.html':  'submissions',
    'school-portal-tracker.html':      'tracker',
    'school-portal-calendar.html':     'calendar',
    'school-portal-tuition.html':      'tuition',
    'school-portal-permit.html':       'permit',
    'school-portal-calendar-submitted.html': 'calendar',
    'school-portal-tuition-submitted.html': 'tuition',
    'school-portal-audit.html':        'audit',
    'school-portal-profile.html':      'profile',
    // school-portal-announcements.html intentionally NOT gated here — it's
    // viewable by all authenticated portal users (public and private
    // schools alike); the 'announcements' entry in PORTAL_NAV_ACCESS only
    // controls whether the injected sidebar link shows up.
};

/**
 * Guard the current page — redirect to dashboard if user lacks access.
 * @param {string} redirectUrl
 * @returns {boolean} true if access granted
 */
function checkPortalPageAccess(redirectUrl = 'school-portal-dashboard.html') {
    const currentPage = window.location.pathname.split('/').pop();
    const feature = PORTAL_PAGE_FEATURES[currentPage];

    if (!feature) return true; // page not in map — allow

    if (!hasPortalAccess(feature)) {
        console.warn(`[PortalPermissions] Access denied to '${currentPage}' (feature: '${feature}')`);
        _showPortalAccessDenied();
        setTimeout(() => window.location.href = redirectUrl, 1500);
        return false;
    }

    // If locked (coming soon), redirect quietly
    if (isPortalFeatureLocked(feature)) {
        window.location.href = redirectUrl;
        return false;
    }

    return true;
}

function _showPortalAccessDenied() {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position:fixed; bottom:20px; right:20px;
        background:#dc2626; color:#fff;
        padding:12px 20px; border-radius:10px;
        font-size:13px; font-family:inherit;
        z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,.2);
    `;
    toast.textContent = 'Access denied. Redirecting…';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
/**
 * Initialize the portal permission system.
 * Call once at page load — after edu_school_type is in localStorage.
 *
 * @param {object} options
 * @param {boolean} options.guardPage    - Check and redirect if page is restricted (default: true)
 * @param {boolean} options.applyNav     - Hide/lock nav items (default: true)
 * @param {boolean} options.applyElements - Hide data-portal-feature elements (default: true)
 */
function initPortalPermissions({
    guardPage    = true,
    applyNav     = true,
    applyElements = true,
} = {}) {
    // Redirect unauthenticated users
    if (!localStorage.getItem('edu_user_id')) {
        window.location.href = 'school-portal.html';
        return false;
    }

    if (guardPage && !checkPortalPageAccess()) return false;
    if (applyNav)      applyPortalNav();
    if (applyElements) applyPortalElementPermissions();
    ['sidebarRole', 'profileRoleBadge', 'pRole'].forEach(id => {
        const label = document.getElementById(id);
        if (label) label.textContent = 'School User';
    });

    return true;
}

// ── Public API ────────────────────────────────────────────────────────────────
window.PortalPermissions = {
    hasAccess:       hasPortalAccess,
    isLocked:        isPortalFeatureLocked,
    isPublic:        isPublicSchool,
    isPrivate:       isPrivateSchool,
    getSchoolType:   getPortalSchoolType,
    applyNav:        applyPortalNav,
    applyElements:   applyPortalElementPermissions,
    checkPage:       checkPortalPageAccess,
    init:            initPortalPermissions,
};
