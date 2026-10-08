/**
 * QATALYST Notification System
 * Handles notification bell, badge updates, and dropdown
 */

const NotificationSystem = {
    pollInterval: null,
    POLL_INTERVAL_MS: 30000, // Check every 30 seconds
    isDropdownOpen: false,

    /**
     * Initialize the notification system
     */
    init() {
        this.createNotificationHTML();
        this.bindEvents();
        this.fetchNotifications();
        this.startPolling();
    },

    /**
     * Create the notification bell HTML and inject into header
     */
    createNotificationHTML() {
        const headerRight = document.querySelector('.page-header-right');
        if (!headerRight) return;

        // Create notification container
        const notifContainer = document.createElement('div');
        notifContainer.className = 'notification-container';
        notifContainer.innerHTML = `
            <button class="notification-bell" id="notificationBell" title="Notifications">
                <i class="fa-solid fa-bell"></i>
                <span class="notification-badge" id="notificationBadge" style="display: none;">0</span>
            </button>
            <div class="notification-dropdown" id="notificationDropdown">
                <div class="notification-header">
                    <h3>Notifications</h3>
                    <button class="mark-read-btn" id="markAllRead" title="Mark all as read">
                        <i class="fa-solid fa-check-double"></i>
                    </button>
                </div>
                <div class="notification-list" id="notificationList">
                    <div class="notification-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading...
                    </div>
                </div>
                <div class="notification-footer">
                    <a href="documents-submitted-all.html">View All Submissions</a>
                </div>
            </div>
        `;

        // Insert before logout button
        const logoutBtn = headerRight.querySelector('.logout-btn');
        if (logoutBtn) {
            headerRight.insertBefore(notifContainer, logoutBtn);
        } else {
            headerRight.appendChild(notifContainer);
        }
    },

    /**
     * Bind click events
     */
    bindEvents() {
        // Toggle dropdown on bell click
        document.addEventListener('click', (e) => {
            const bell = document.getElementById('notificationBell');
            const dropdown = document.getElementById('notificationDropdown');

            if (!bell || !dropdown) return;

            if (e.target.closest('#notificationBell')) {
                this.toggleDropdown();
            } else if (!e.target.closest('.notification-dropdown')) {
                this.closeDropdown();
            }
        });

        // Mark all as read
        document.addEventListener('click', (e) => {
            if (e.target.closest('#markAllRead')) {
                this.markAllRead();
            }
        });
    },

    /**
     * Toggle dropdown visibility
     */
    toggleDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;

        this.isDropdownOpen = !this.isDropdownOpen;
        dropdown.classList.toggle('show', this.isDropdownOpen);

        if (this.isDropdownOpen) {
            this.fetchNotifications();
        }
    },

    /**
     * Close dropdown
     */
    closeDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        if (dropdown) {
            dropdown.classList.remove('show');
            this.isDropdownOpen = false;
        }
    },

    /**
     * Fetch notifications from API
     */
    async fetchNotifications() {
        try {
            const response = await fetch(CONFIG.API_URL + '/notifications.php', {
                method: 'GET',
                credentials: 'include'
            });

            if (!response.ok) {
                if (response.status === 401) return; // Not logged in
                throw new Error('Failed to fetch notifications');
            }

            const data = await response.json();
            if (data.success) {
                this.updateBadge(data.data.unread_count);
                this.renderNotifications(data.data.recent);
            }
        } catch (e) {
            console.warn('Notification fetch error:', e);
        }
    },

    /**
     * Update the badge count
     */
    updateBadge(count) {
        const badge = document.getElementById('notificationBadge');
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'flex';
            // Add pulse animation for new notifications
            badge.classList.add('pulse');
            setTimeout(() => badge.classList.remove('pulse'), 1000);
        } else {
            badge.style.display = 'none';
        }
    },

    /**
     * Render notification items — handles calendar, tuition, permit, and directory_update types
     */
    renderNotifications(notifications) {
        const list = document.getElementById('notificationList');
        if (!list) return;

        if (!notifications || notifications.length === 0) {
            list.innerHTML = `
                <div class="notification-empty">
                    <i class="fa-solid fa-inbox"></i>
                    <p>No notifications yet</p>
                </div>
            `;
            return;
        }

        list.innerHTML = notifications.map(n => {
            const type = n.notification_type;

            if (type === 'school_approval') {
                const userId = parseInt(n.participant_id || n.id, 10) || 0;
                const schoolName = this.escapeHtml(n.school_name || 'A school');
                const accountName = this.escapeHtml(n.participant_name || 'A school user');
                return `
                    <a class="notification-item ${n.is_new ? 'unread' : ''}"
                       href="user-management.html?tab=portal&user_id=${userId}"
                       style="text-decoration:none;color:inherit;">
                        <div class="notification-icon"><i class="fa-solid fa-user-check"></i></div>
                        <div class="notification-content">
                            <p class="notification-text"><strong>${accountName}</strong> — School account awaiting approval</p>
                            <span class="notification-meta">${schoolName} · ${this.escapeHtml(n.time_ago || '')}</span>
                        </div>
                        ${n.is_new ? '<span class="notification-dot"></span>' : ''}
                    </a>`;
            }

            if (type === 'calendar') {
                // ── Calendar submission notification ──────────────────────
                const schoolName  = this.escapeHtml(n.school_name  || 'A school');
                const docTitle    = this.escapeHtml(n.submission_title || 'School Calendar');
                const submissionId = parseInt(n.id, 10) || 0;

                return `
                    <div class="notification-item ${n.is_new ? 'unread' : ''}"
                         data-submission-id="${submissionId}"
                         style="cursor:pointer;"
                         onclick="NotificationSystem.openCalendarSubmission(${submissionId})">
                        <div class="notification-icon notification-icon--calendar">
                            <i class="fa-solid fa-calendar-check"></i>
                        </div>
                        <div class="notification-content">
                            <p class="notification-text">
                                <strong>${schoolName}</strong> submitted a school calendar for review
                            </p>
                            <span class="notification-meta">
                                ${docTitle} · ${n.time_ago}
                            </span>
                        </div>
                        ${n.is_new ? '<span class="notification-dot"></span>' : ''}
                    </div>`;
            }

            if (type === 'tuition') {
                // ── Tuition fee submission notification ───────────────────
                const schoolName   = this.escapeHtml(n.school_name     || 'A school');
                const docTitle     = this.escapeHtml(n.submission_title || 'Tuition Fee Schedule');
                const submissionId = parseInt(n.id, 10) || 0;

                return `
                    <div class="notification-item ${n.is_new ? 'unread' : ''}"
                         data-submission-id="${submissionId}"
                         style="cursor:pointer;"
                         onclick="NotificationSystem.openTuitionSubmission(${submissionId})">
                        <div class="notification-icon notification-icon--tuition">
                            <i class="fa-solid fa-file-invoice-dollar"></i>
                        </div>
                        <div class="notification-content">
                            <p class="notification-text">
                                <strong>${schoolName}</strong> submitted a tuition fee schedule for review
                            </p>
                            <span class="notification-meta">
                                ${docTitle} · ${n.time_ago}
                            </span>
                        </div>
                        ${n.is_new ? '<span class="notification-dot"></span>' : ''}
                    </div>`;
            }

            if (type === 'permit') {
                // ── School Permit submission notification ─────────────────
                // FIX: this branch was missing, so permit items fell through
                // to "Unknown notification type — skip" and rendered as
                // nothing, even after being counted in the badge.
                const schoolName   = this.escapeHtml(n.school_name     || 'A school');
                const docTitle     = this.escapeHtml(n.submission_title || 'School Permit');
                const submissionId = parseInt(n.id, 10) || 0;

                return `
                    <div class="notification-item ${n.is_new ? 'unread' : ''}"
                         data-submission-id="${submissionId}"
                         style="cursor:pointer;"
                         onclick="NotificationSystem.openPermitSubmission(${submissionId})">
                        <div class="notification-icon notification-icon--permit">
                            <i class="fa-solid fa-id-card"></i>
                        </div>
                        <div class="notification-content">
                            <p class="notification-text">
                                <strong>${schoolName}</strong> submitted a school permit application for review
                            </p>
                            <span class="notification-meta">
                                ${docTitle} · ${n.time_ago}
                            </span>
                        </div>
                        ${n.is_new ? '<span class="notification-dot"></span>' : ''}
                    </div>`;
            }

            // ── Directory/Profile update notification ─────────────────
            if (type === 'directory_update') {
                // ── Directory/Profile update notification ─────────────────
                const schoolName = this.escapeHtml(n.school_name || 'A school');
                const editorName = this.escapeHtml(n.participant_name || 'A portal user');

                return `
                    <div class="notification-item ${n.is_new ? 'unread' : ''}"
                         style="cursor:pointer;"
                         onclick="NotificationSystem.openDirectory()">
                        <div class="notification-icon">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </div>
                        <div class="notification-content">
                            <p class="notification-text">
                                <strong>${schoolName}</strong> updated directory information
                            </p>
                            <span class="notification-meta">
                                Edited by ${editorName} · ${n.time_ago}
                            </span>
                        </div>
                        ${n.is_new ? '<span class="notification-dot"></span>' : ''}
                    </div>`;
            }

            // ── Unknown notification type — skip ──────────────────────
            return '';
        }).join('');
    },

    /**
     * Mark all notifications as read
     */
    async markAllRead() {
        try {
            const response = await fetch(CONFIG.API_URL + '/notifications.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ action: 'mark_read' })
            });

            if (response.ok) {
                this.updateBadge(0);
                // Remove unread styling from all items
                document.querySelectorAll('.notification-item.unread').forEach(item => {
                    item.classList.remove('unread');
                    const dot = item.querySelector('.notification-dot');
                    if (dot) dot.remove();
                });
            }
        } catch (e) {
            console.warn('Mark read error:', e);
        }
    },

    /**
     * Start polling for new notifications
     */
    startPolling() {
        this.pollInterval = setInterval(() => {
            if (!this.isDropdownOpen) {
                this.fetchNotifications();
            }
        }, this.POLL_INTERVAL_MS);
    },

    /**
     * Stop polling
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    /**
     * Navigate to the school submissions page for a calendar submission
     */
    openCalendarSubmission(submissionId) {
        this.closeDropdown();
        window.location.href = `documents-submitted-all.html?id=${submissionId}`;
    },

    /**
     * Navigate to the school submissions page for a tuition fee submission
     */
    openTuitionSubmission(submissionId) {
        this.closeDropdown();
        window.location.href = `documents-submitted-all.html?id=${submissionId}`;
    },

    /**
     * Navigate to the school submissions page for a permit submission
     */
    openPermitSubmission(submissionId) {
        this.closeDropdown();
        window.location.href = `documents-submitted-all.html?id=${submissionId}`;
    },

    /**
     * Navigate to the Directory page for reviewing school info updates
     */
    openDirectory() {
        this.closeDropdown();
        window.location.href = 'directory.html';
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Only initialize if user is logged in
    if (localStorage.getItem('user_id')) {
        NotificationSystem.init();
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    NotificationSystem.stopPolling();
});
