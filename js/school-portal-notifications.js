/**
 * QATALYST School Portal Notification System
 * Handles notification bell, badge, and dropdown for school portal users.
 *
 * Notifications shown here are school-facing events:
 *   - Submission status changes (approved, rejected, endorsed, under review)
 *   - SDO remarks / feedback on a submission
 *   - Document tracker step updates (endorsed to RO, approved, released)
 *
 * Usage: include this script on every school portal page that has a sidebar.
 * Call SchoolNotifications.init() after DOMContentLoaded, or it auto-inits.
 */

const SchoolNotifications = {
    pollInterval: null,
    POLL_INTERVAL_MS: 30000,
    isDropdownOpen: false,

    // ── Initialize ─────────────────────────────────────────────────────────
    init() {
        this.injectBellIntoSidebar();
        this.bindEvents();
        this.fetchNotifications();
        this.startPolling();
    },

    // ── Inject bell HTML into the sidebar user-info area ──────────────────
    injectBellIntoSidebar() {
        // Avoid double-injection
        if (document.getElementById('schoolNotifBell')) return;

        // Primary target: .page-header-right (pages that have a top header)
        // Fallback: sidebar user-info block (calendar page, etc.)
        const headerRight = document.querySelector('.page-header-right');
        const userInfo    = document.querySelector('.user-info-sidebar');

        const wrapper = document.createElement('div');
        wrapper.className = 'sn-container';
        wrapper.id        = 'schoolNotifContainer';
        wrapper.innerHTML = `
            <button class="sn-bell" id="schoolNotifBell" title="Notifications">
                <i class="fa-solid fa-bell"></i>
                <span class="sn-badge" id="schoolNotifBadge" style="display:none;">0</span>
            </button>
            <div class="sn-dropdown" id="schoolNotifDropdown">
                <div class="sn-dropdown-head">
                    <h3><i class="fa-solid fa-bell" style="font-size:13px;opacity:0.7;"></i> Notifications</h3>
                    <button class="sn-mark-all" id="schoolNotifMarkAll" title="Mark all as read">
                        <i class="fa-solid fa-check-double"></i> Mark all read
                    </button>
                </div>
                <div class="sn-list" id="schoolNotifList">
                    <div class="sn-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading…
                    </div>
                </div>
                <div class="sn-footer">
                    <a href="school-portal-submissions.html">
                        <i class="fa-solid fa-folder-open" style="margin-right:5px;"></i>View All Submissions
                    </a>
                </div>
            </div>`;

        if (headerRight) {
            // Insert before logout if present
            const logout = headerRight.querySelector('.logout-btn, .sidebar-logout-btn');
            logout ? headerRight.insertBefore(wrapper, logout) : headerRight.appendChild(wrapper);
        } else if (userInfo) {
            // Insert before the user-info block in the sidebar
            userInfo.parentNode.insertBefore(wrapper, userInfo);
        } else {
            // Last resort: append to body (should not normally happen)
            document.body.appendChild(wrapper);
        }
    },

    // ── Bind events ────────────────────────────────────────────────────────
    bindEvents() {
        document.addEventListener('click', (e) => {
            if (e.target.closest('#schoolNotifBell')) {
                this.toggleDropdown();
                return;
            }
            if (!e.target.closest('#schoolNotifDropdown') && !e.target.closest('#schoolNotifBell')) {
                this.closeDropdown();
            }
        });

        document.addEventListener('click', (e) => {
            if (e.target.closest('#schoolNotifMarkAll')) {
                this.markAllRead();
            }
        });
    },

    // ── Toggle dropdown ────────────────────────────────────────────────────
    toggleDropdown() {
        this.isDropdownOpen = !this.isDropdownOpen;
        const dd = document.getElementById('schoolNotifDropdown');
        if (dd) dd.classList.toggle('show', this.isDropdownOpen);
        if (this.isDropdownOpen) this.fetchNotifications();
    },

    // ── Close dropdown ─────────────────────────────────────────────────────
    closeDropdown() {
        const dd = document.getElementById('schoolNotifDropdown');
        if (dd) dd.classList.remove('show');
        this.isDropdownOpen = false;
    },

    // ── Fetch notifications from API ───────────────────────────────────────
    async fetchNotifications() {
        try {
            const res = await fetch(CONFIG.API_URL + '/school-portal-notifications.php', {
                method: 'GET',
                credentials: 'include',
            });

            if (!res.ok) {
                if (res.status === 401) return; // Not logged in — silently skip
                throw new Error('HTTP ' + res.status);
            }

            const data = await res.json();
            if (data.success) {
                this.updateBadge(data.data.unread_count);
                this.renderNotifications(data.data.notifications);
            }
        } catch (e) {
            console.warn('[SchoolNotifications] fetch error:', e);
        }
    },

    // ── Update bell badge ──────────────────────────────────────────────────
    updateBadge(count) {
        const badge = document.getElementById('schoolNotifBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent   = count > 99 ? '99+' : String(count);
            badge.style.display = 'flex';
            badge.classList.add('sn-pulse');
            setTimeout(() => badge.classList.remove('sn-pulse'), 700);
        } else {
            badge.style.display = 'none';
        }
    },

    // ── Render notification list ───────────────────────────────────────────
    renderNotifications(notifications) {
        const list = document.getElementById('schoolNotifList');
        if (!list) return;

        if (!notifications || notifications.length === 0) {
            list.innerHTML = `
                <div class="sn-empty">
                    <i class="fa-solid fa-inbox"></i>
                    <p>No notifications yet</p>
                    <span>Status updates on your submissions will appear here.</span>
                </div>`;
            return;
        }

        list.innerHTML = notifications.map(n => {
            const iconInfo = this.getIconForType(n.type);
            return `
            <div class="sn-item ${n.is_read ? '' : 'sn-unread'}"
                 data-id="${n.id}"
                 onclick="SchoolNotifications.handleItemClick(${n.id}, '${this.esc(n.link || '')}')">
                <div class="sn-item-icon sn-icon-${iconInfo.color}">
                    <i class="fa-solid ${iconInfo.icon}"></i>
                </div>
                <div class="sn-item-body">
                    <p class="sn-item-title">${this.esc(n.title)}</p>
                    <p class="sn-item-msg">${this.esc(n.message)}</p>
                    <span class="sn-item-time">${this.esc(n.time_ago)}</span>
                </div>
                ${!n.is_read ? '<span class="sn-dot"></span>' : ''}
            </div>`;
        }).join('');
    },

    // ── Map notification type → icon + colour ─────────────────────────────
    getIconForType(type) {
        const map = {
            approved:         { icon: 'fa-circle-check',        color: 'green'  },
            rejected:         { icon: 'fa-circle-xmark',        color: 'red'    },
            endorsed:         { icon: 'fa-paper-plane',         color: 'blue'   },
            review:           { icon: 'fa-magnifying-glass',    color: 'amber'  },
            remarks:          { icon: 'fa-comment-dots',        color: 'purple' },
            tracker_update:   { icon: 'fa-chart-gantt',         color: 'indigo' },
            submission:       { icon: 'fa-file-arrow-up',       color: 'teal'   },
            general:          { icon: 'fa-bell',                color: 'gray'   },
        };
        return map[type] || map.general;
    },

    // ── Handle click on a notification item ───────────────────────────────
    async handleItemClick(notifId, link) {
        // Mark single item as read
        await this.markOneRead(notifId);

        // Remove unread styling immediately
        const item = document.querySelector(`.sn-item[data-id="${notifId}"]`);
        if (item) {
            item.classList.remove('sn-unread');
            const dot = item.querySelector('.sn-dot');
            if (dot) dot.remove();
        }

        this.closeDropdown();

        if (link) {
            window.location.href = link;
        }
    },

    // ── Mark one notification as read ─────────────────────────────────────
    async markOneRead(notifId) {
        try {
            await fetch(CONFIG.API_URL + '/school-portal-notifications.php', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'mark_read', notification_id: notifId }),
            });
        } catch (e) {
            console.warn('[SchoolNotifications] markOneRead error:', e);
        }
    },

    // ── Mark all as read ───────────────────────────────────────────────────
    async markAllRead() {
        try {
            const res = await fetch(CONFIG.API_URL + '/school-portal-notifications.php', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'mark_all_read' }),
            });

            if (res.ok) {
                this.updateBadge(0);
                document.querySelectorAll('.sn-item.sn-unread').forEach(el => {
                    el.classList.remove('sn-unread');
                    el.querySelector('.sn-dot')?.remove();
                });
            }
        } catch (e) {
            console.warn('[SchoolNotifications] markAllRead error:', e);
        }
    },

    // ── Polling ────────────────────────────────────────────────────────────
    startPolling() {
        this.pollInterval = setInterval(() => {
            if (!this.isDropdownOpen) this.fetchNotifications();
        }, this.POLL_INTERVAL_MS);
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    // ── XSS-safe escape ───────────────────────────────────────────────────
    esc(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    },
};

// ── Auto-init after DOM ready ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Only run when a portal session exists
    if (localStorage.getItem('edu_user_id')) {
        SchoolNotifications.init();
    }
});

// ── Clean up polling on unload ─────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    SchoolNotifications.stopPolling();
});
