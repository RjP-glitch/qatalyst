/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QATALYST - Global Configuration
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Change these values when deploying to a different server/domain.
 * All JS files reference this config for URLs and settings.
 */

function inferBaseUrl() {
    // Infer the base URL from the current page location.
    // This works for:
    // - Domain root deployments:   https://example.com/dashboard.html   -> https://example.com
    // - Subfolder deployments:     https://example.com/QRES-api/...     -> https://example.com/QRES-api
    // - Rare '/public_html' URLs:  https://example.com/public_html/...  -> https://example.com/public_html
    try {
        const base = new URL('.', window.location.href);
        const basePath = (base.pathname || '/').replace(/\/$/, '');
        return base.origin + (basePath === '/' ? '' : basePath);
    } catch (_) {
        return window.location.origin;
    }
}

const CONFIG = {
    // ─── Base URLs ─────────────────────────────────────────────────────────
    // Change 'http://localhost/qatalyst' to your production domain
    // Example: 'https://yourdomain.com/qatalyst' or 'https://yourdomain.com'
    BASE_URL: inferBaseUrl(),
    
    // API endpoint (usually BASE_URL + '/api')
    get API_URL() {
        return this.BASE_URL + '/api';
    },
    
    // Images folder
    get IMAGES_URL() {
        return this.BASE_URL + '/images';
    },
    
    // Uploads folder
    get UPLOADS_URL() {
        return this.BASE_URL + '/api/uploads';
    },

    // AI proxy endpoint (server-side key injection)
    get AI_PROXY_URL() {
        return this.API_URL + '/ai-proxy.php';
    },

    // Document text extraction endpoint (server-side OCR)
    get EXTRACT_URL() {
        return this.API_URL + '/extract.php';
    },

    // ─── App Settings ──────────────────────────────────────────────────────
    APP_NAME: 'Qatalyst',
    APP_VERSION: '1.0.0',
    
    // Session timeout in milliseconds (30 minutes default)
    SESSION_TIMEOUT: 30 * 60 * 1000,
    
    // ─── Feature Flags ─────────────────────────────────────────────────────
    DEBUG_MODE: true,  // Set to false in production
    
    // ─── Helper Methods ────────────────────────────────────────────────────
    // Get full API endpoint URL
    apiEndpoint(endpoint) {
        return this.API_URL + '/' + endpoint;
    },
    
    // Get full image URL
    imageUrl(path) {
        return this.IMAGES_URL + '/' + path;
    }
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);

/**
 * SDO Announcements banner — pops a dismissible strip above the page
 * content on every SDO page (config.js loads everywhere). Pulls from
 * announcements.php?scope=active, which is safe for any authenticated
 * SDO user to call (view-only; no 'announcements' permission required).
 * Dismissals are remembered per-announcement in localStorage so a banner
 * won't reappear once closed, but a newly created/edited one will.
 */
(function () {
    function dismissKey() {
        const uid = localStorage.getItem('user_id') || 'anon';
        return 'dismissed_announcement_ids_' + uid;
    }

    function getDismissed() {
        try {
            const raw = localStorage.getItem(dismissKey());
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
    }

    function dismiss(id) {
        const list = getDismissed();
        if (!list.includes(id)) list.push(id);
        try { localStorage.setItem(dismissKey(), JSON.stringify(list)); } catch (_) { /* ignore quota errors */ }
    }

    function injectStyles() {
        if (document.getElementById('ann-banner-styles')) return;
        const style = document.createElement('style');
        style.id = 'ann-banner-styles';
        style.textContent = `
            .ann-toast-stack {
                position:fixed; left:0; right:0; bottom:0; z-index:9999;
                display:flex; flex-direction:column-reverse; gap:8px;
                padding:12px 16px; pointer-events:none;
            }
            .ann-toast {
                pointer-events:auto;
                display:flex; align-items:center; gap:12px;
                background:linear-gradient(90deg,#12294f,#1a3a6b);
                border-left:4px solid #f5d800;
                border-radius:10px; padding:10px 14px;
                box-shadow:0 6px 24px rgba(0,0,0,0.25);
                font-family:'Plus Jakarta Sans', system-ui, sans-serif;
                max-width:720px; margin:0 auto; width:100%;
                animation: annToastIn 0.3s ease;
            }
            .ann-toast.pinned { border-left-color:#f59e0b; }
            .ann-toast-icon { color:#f5d800; font-size:16px; flex-shrink:0; }
            .ann-toast-marquee {
                flex:1; min-width:0; overflow:hidden; position:relative;
                white-space:nowrap; -webkit-mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);
                        mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);
            }
            .ann-toast-track {
                display:inline-block; padding-left:100%;
                animation: annMarquee 18s linear infinite;
            }
            .ann-toast:hover .ann-toast-track { animation-play-state:paused; }
            .ann-toast-track strong { color:#f5d800; margin-right:6px; }
            .ann-toast-track span { color:#e5edf9; font-size:13px; }
            .ann-toast-close {
                background:none; border:none; color:#9fb3d6; cursor:pointer;
                font-size:16px; line-height:1; padding:2px 4px; flex-shrink:0;
            }
            .ann-toast-close:hover { color:#ffffff; }
            .ann-toast-more {
                font-size:12px; color:#0f172a; text-decoration:none; font-weight:700;
                background:#f5d800; border-radius:8px; padding:4px 10px; flex-shrink:0;
                white-space:nowrap;
            }
            @keyframes annToastIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
            @keyframes annMarquee { from { transform:translateX(0); } to { transform:translateX(-100%); } }
            .ann-nav-badge {
                display:inline-flex; align-items:center; justify-content:center;
                min-width:18px; height:18px; padding:0 5px; margin-left:auto;
                background:linear-gradient(135deg,#ef4444,#dc2626);
                color:#fff; font-size:10px; font-weight:700; border-radius:9px;
                line-height:1;
            }
        `;
        document.head.appendChild(style);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function updateNavBadge(count) {
        const navBtns = document.querySelectorAll('.nav-menu [onclick*="announcements"]');
        navBtns.forEach(btn => {
            let badge = btn.querySelector('.ann-nav-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'ann-nav-badge';
                    btn.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : count;
                badge.style.display = 'inline-flex';
            } else if (badge) {
                badge.style.display = 'none';
            }
        });
    }

    async function initAnnouncementsBanner() {
        // Only on SDO pages, only for logged-in users, never on the portal side
        const isPortalPage = document.querySelector('.school-pill-sidebar');
        if (isPortalPage) return;
        if (!localStorage.getItem('user_id')) return;
        if (localStorage.getItem('account_type') === 'portal_user') return;

        let data;
        try {
            const res = await fetch(CONFIG.API_URL + '/announcements.php?scope=active', { credentials: 'include' });
            if (!res.ok) return; // not logged in yet, or transient error — fail silently
            const json = await res.json();
            if (!json.success) return;
            data = json.data || [];
        } catch (_) {
            return;
        }

        const dismissed = getDismissed();
        const visible = data.filter(a => !dismissed.includes(a.id));

        injectStyles();
        updateNavBadge(visible.length);

        if (visible.length === 0) return;

        const MAX_SHOWN = 3;
        const shown = visible.slice(0, MAX_SHOWN);
        const extra = visible.length - shown.length;

        const stack = document.createElement('div');
        stack.className = 'ann-toast-stack';
        stack.id = 'annBannerStack';

        let remaining = visible.length;

        shown.forEach(a => {
            const toast = document.createElement('div');
            toast.className = 'ann-toast' + (a.is_pinned ? ' pinned' : '');
            toast.setAttribute('data-ann-id', a.id);
            toast.innerHTML = `
                <i class="fa-solid fa-bullhorn ann-toast-icon"></i>
                <div class="ann-toast-marquee">
                    <div class="ann-toast-track">
                        <strong>${escapeHtml(a.title)}:</strong><span>${escapeHtml(a.body)}</span>
                    </div>
                </div>
                <button class="ann-toast-close" title="Dismiss">&times;</button>
            `;
            toast.querySelector('.ann-toast-close').addEventListener('click', () => {
                dismiss(a.id);
                toast.remove();
                remaining = Math.max(0, remaining - 1);
                updateNavBadge(remaining);
            });
            stack.appendChild(toast);
        });

        if (extra > 0) {
            const more = document.createElement('a');
            more.className = 'ann-toast-more';
            more.href = 'announcements.html';
            more.textContent = `+${extra} more`;
            stack.appendChild(more);
        }

        // Fixed/floating — appended straight to <body>, no need to anchor to
        // any particular page's layout (header, content wrapper, etc.).
        document.body.appendChild(stack);
    }

    document.addEventListener('DOMContentLoaded', initAnnouncementsBanner);
})();

/**
 * Auto-inject an "Announcements" sidebar link on School Portal pages.
 * Guarded on `.school-pill-sidebar`, which only exists in the portal
 * sidebar markup — so this never touches the SDO dashboard sidebar
 * (that side is handled by permissions.js's injectAnnouncementsNav()).
 * Visible to all portal users; no permission gating needed on this side.
 */
document.addEventListener('DOMContentLoaded', function () {
    const isPortalPage = document.querySelector('.school-pill-sidebar');
    if (!isPortalPage) return;

    const navMenu = document.querySelector('.nav-menu');
    if (!navMenu) return;
    if (navMenu.querySelector('[data-portal-nav="announcements"]')) return; // already present, e.g. on the announcements page itself

    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.setAttribute('data-portal-nav', 'announcements');
    btn.setAttribute('onclick', "window.location.href='school-portal-announcements.html'");
    btn.innerHTML = '<i class="fa-solid fa-bullhorn nav-icon"></i><span>Announcements</span>' +
        '<span class="nav-badge" id="announcementsBadge" style="display:none;"></span>';

    const currentPage = window.location.pathname.split('/').pop();
    if (currentPage === 'school-portal-announcements.html') btn.classList.add('active');

    // Insert as the first item under the "Account" section label, to match
    // placement on school-portal-announcements.html itself. Anchoring on the
    // section label (rather than searching for the Audit/Profile buttons) is
    // deterministic across every portal page, even if a given page's sidebar
    // markup has Audit/Profile in a different order or is missing the
    // data-portal-nav attribute on them.
    const sectionLabels = Array.from(navMenu.querySelectorAll('.nav-section-label'));
    const accountLabel = sectionLabels.find(el => el.textContent.trim().toLowerCase() === 'account');

    if (accountLabel && accountLabel.nextElementSibling) {
        navMenu.insertBefore(btn, accountLabel.nextElementSibling);
    } else if (accountLabel) {
        // "Account" label exists but has no following item (unlikely) — append after the label
        accountLabel.insertAdjacentElement('afterend', btn);
    } else {
        // No "Account" section on this page — fall back to end of nav
        navMenu.appendChild(btn);
    }
});

/**
 * School Portal Announcements — banner + nav badge.
 * Mirrors the SDO widget above (initAnnouncementsBanner), but runs only on
 * portal pages and hits the portal-scoped, audience-filtered endpoint
 * (school-portal-announcements.php) instead of the SDO one. Needed because
 * school-portal-announcements.js — which also fetches this data — only
 * loads on school-portal-announcements.html itself, so without this widget
 * every other portal page (dashboard, tracker, calendar, etc.) never shows
 * the badge count or the dismissible toast banner.
 */
(function () {
    function isPortalPage() {
        return !!document.querySelector('.school-pill-sidebar');
    }

    function dismissKey() {
        const uid = localStorage.getItem('edu_user_id') || 'anon';
        return 'dismissed_portal_announcement_ids_' + uid;
    }

    function getDismissed() {
        try {
            const raw = localStorage.getItem(dismissKey());
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
    }

    function dismiss(id) {
        const list = getDismissed();
        if (!list.includes(id)) list.push(id);
        try { localStorage.setItem(dismissKey(), JSON.stringify(list)); } catch (_) { /* ignore quota errors */ }
    }

    function injectStyles() {
        // Same stylesheet id/rules as the SDO widget above. Idempotent (bails
        // if already present), and harmless since SDO vs portal pages are
        // mutually exclusive — only one of the two widgets ever runs per page.
        if (document.getElementById('ann-banner-styles')) return;
        const style = document.createElement('style');
        style.id = 'ann-banner-styles';
        style.textContent = `
            .ann-toast-stack {
                position:fixed; left:0; right:0; bottom:0; z-index:9999;
                display:flex; flex-direction:column-reverse; gap:8px;
                padding:12px 16px; pointer-events:none;
            }
            .ann-toast {
                pointer-events:auto;
                display:flex; align-items:center; gap:12px;
                background:linear-gradient(90deg,#12294f,#1a3a6b);
                border-left:4px solid #f5d800;
                border-radius:10px; padding:10px 14px;
                box-shadow:0 6px 24px rgba(0,0,0,0.25);
                font-family:'Plus Jakarta Sans', system-ui, sans-serif;
                max-width:720px; margin:0 auto; width:100%;
                animation: annToastIn 0.3s ease;
            }
            .ann-toast.pinned { border-left-color:#f59e0b; }
            .ann-toast-icon { color:#f5d800; font-size:16px; flex-shrink:0; }
            .ann-toast-marquee {
                flex:1; min-width:0; overflow:hidden; position:relative;
                white-space:nowrap; -webkit-mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);
                        mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);
            }
            .ann-toast-track {
                display:inline-block; padding-left:100%;
                animation: annMarquee 18s linear infinite;
            }
            .ann-toast:hover .ann-toast-track { animation-play-state:paused; }
            .ann-toast-track strong { color:#f5d800; margin-right:6px; }
            .ann-toast-track span { color:#e5edf9; font-size:13px; }
            .ann-toast-close {
                background:none; border:none; color:#9fb3d6; cursor:pointer;
                font-size:16px; line-height:1; padding:2px 4px; flex-shrink:0;
            }
            .ann-toast-close:hover { color:#ffffff; }
            .ann-toast-more {
                font-size:12px; color:#0f172a; text-decoration:none; font-weight:700;
                background:#f5d800; border-radius:8px; padding:4px 10px; flex-shrink:0;
                white-space:nowrap;
            }
            @keyframes annToastIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
            @keyframes annMarquee { from { transform:translateX(0); } to { transform:translateX(-100%); } }
        `;
        document.head.appendChild(style);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function updateBadge(count) {
        // The portal sidebar always has exactly one Announcements nav item,
        // with this fixed id — hardcoded on school-portal-announcements.html
        // itself, and injected with the same id everywhere else above — so
        // there's no need for the onclick-substring matching the SDO
        // updateNavBadge() uses to handle multiple/unknown sidebar layouts.
        const badge = document.getElementById('announcementsBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }
    }

    async function initPortalAnnouncementsBanner() {
        if (!isPortalPage()) return;
        if (!localStorage.getItem('edu_user_id')) return;

        let data;
        try {
            const res = await fetch(CONFIG.API_URL + '/school-portal-announcements.php', { credentials: 'include' });
            if (!res.ok) return; // not logged in yet, or transient error — fail silently
            const json = await res.json();
            if (!json.success) return;
            data = json.data || [];
        } catch (_) {
            return;
        }

        const dismissed = getDismissed();
        const visible = data.filter(a => !dismissed.includes(a.id));

        injectStyles();
        updateBadge(visible.length);

        if (visible.length === 0) return;

        const MAX_SHOWN = 3;
        const shown = visible.slice(0, MAX_SHOWN);
        const extra = visible.length - shown.length;

        const stack = document.createElement('div');
        stack.className = 'ann-toast-stack';
        stack.id = 'portalAnnBannerStack';

        let remaining = visible.length;

        shown.forEach(a => {
            const toast = document.createElement('div');
            toast.className = 'ann-toast' + (a.is_pinned ? ' pinned' : '');
            toast.setAttribute('data-ann-id', a.id);
            toast.innerHTML = `
                <i class="fa-solid fa-bullhorn ann-toast-icon"></i>
                <div class="ann-toast-marquee">
                    <div class="ann-toast-track">
                        <strong>${escapeHtml(a.title)}:</strong><span>${escapeHtml(a.body)}</span>
                    </div>
                </div>
                <button class="ann-toast-close" title="Dismiss">&times;</button>
            `;
            toast.querySelector('.ann-toast-close').addEventListener('click', () => {
                dismiss(a.id);
                toast.remove();
                remaining = Math.max(0, remaining - 1);
                updateBadge(remaining);
            });
            stack.appendChild(toast);
        });

        if (extra > 0) {
            const more = document.createElement('a');
            more.className = 'ann-toast-more';
            more.href = 'school-portal-announcements.html';
            more.textContent = `+${extra} more`;
            stack.appendChild(more);
        }

        // Fixed/floating — appended straight to <body>, same as the SDO widget.
        document.body.appendChild(stack);
    }

    document.addEventListener('DOMContentLoaded', initPortalAnnouncementsBanner);
})();