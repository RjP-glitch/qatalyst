const ADS = (() => {
    'use strict';

    let expandedMenus = {};
    let allRecords = [];
    let detailRecordId = null;

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escJsSingle(v) {
        return String(v == null ? '' : v)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
    }

    function apiUrl(path) {
        return (typeof CONFIG !== 'undefined' && CONFIG.API_URL) ? (CONFIG.API_URL + path) : path;
    }

    function toAbsoluteUrl(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw)) return raw;
        const base = raw.startsWith('/') ? window.location.origin : window.location.href;
        try { return new URL(raw, base).toString(); }
        catch (_) { return raw; }
    }

    function isSameOriginUrl(rawUrl) {
        const abs = toAbsoluteUrl(rawUrl);
        if (!abs) return false;
        try { return new URL(abs).origin === window.location.origin; }
        catch (_) { return false; }
    }

    function ensureCalendarPreviewStyles() {
        const head = document.head;
        if (!head) return;
        if (!document.getElementById('adsPortalCalendarCss')) {
            const link = document.createElement('link');
            link.id   = 'adsPortalCalendarCss';
            link.rel  = 'stylesheet';
            link.href = 'css/school-portal-calendar.css?v29';
            head.appendChild(link);
        }
    }

    // Reuses the school portal's own tuition-builder stylesheet so the admin
    // preview renders with the exact same official-document look (DepEd
    // letterhead, seals, "Breakdown of School Fees" table) the school sees,
    // instead of maintaining a second, unstyled copy of those rules here.
    function ensureTuitionPreviewStyles() {
        const head = document.head;
        if (!head) return;
        if (!document.getElementById('adsPortalTuitionCss')) {
            const link = document.createElement('link');
            link.id   = 'adsPortalTuitionCss';
            link.rel  = 'stylesheet';
            link.href = 'css/school-portal-tuition.css?v1';
            head.appendChild(link);
        }
    }

    function formatDate(v) {
        if (!v) return '—';
        try { return new Date(v).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }); }
        catch (_) { return String(v); }
    }

    function statusMeta(status) {
        const map = {
            'Pending Review':          { cls: 'ds-pending',     icon: 'fa-clock' },
            'Approved':                { cls: 'ds-approved',    icon: 'fa-circle-check' },
            'Returned for Correction': { cls: 'ds-returned',    icon: 'fa-circle-xmark' },
            'For Endorsement':         { cls: 'ds-endorsement', icon: 'fa-file-signature' },
            'Released to School':      { cls: 'ds-released',    icon: 'fa-paper-plane' },
            'draft':                   { cls: 'ds-draft',       icon: 'fa-pen-to-square' },
        };
        return map[status] || { cls: 'ds-pending', icon: 'fa-clock' };
    }

    function fileExt(nameOrPath) {
        const v = String(nameOrPath || '').trim();
        if (!v) return '';
        const clean = v.split('?')[0].split('#')[0];
        const idx = clean.lastIndexOf('.');
        if (idx < 0) return '';
        return clean.slice(idx + 1).toLowerCase();
    }

    function typeLabel(record) {
        return record.document_type_label || record.type || 'Document';
    }

    function typeIcon(type) {
        const t = String(type || '').toLowerCase();
        if (t === 'calendar') return 'fa-calendar-days';
        if (t === 'tuition')  return 'fa-money-bill-wave';
        if (t === 'permit')   return 'fa-file-shield';
        return 'fa-file-lines';
    }

    function permitAppTypeLabel(appType, fallbackLabel = '') {
        const val = String(appType || '').trim().toLowerCase();
        if (val === 'new_school') return 'New School (Government Authority to Operate)';
        if (val === 'recognition') return 'Existing School (Government Recognition)';
        if (val === 'new_course') return 'New Course / Program';
        return String(fallbackLabel || '').trim() || '—';
    }

    function getPermitMeta(record) {
        if (!record || typeof record !== 'object') return null;

        const history = record.history;
        if (history && typeof history === 'object' && !Array.isArray(history) && history.gpr3_submission && typeof history.gpr3_submission === 'object') {
            return history.gpr3_submission;
        }

        if (Array.isArray(history)) {
            for (const entry of history) {
                if (entry && typeof entry === 'object' && entry.gpr3_submission && typeof entry.gpr3_submission === 'object') {
                    return entry.gpr3_submission;
                }
            }
        }

        return null;
    }

    /* Returns all edit_request history entries for a record that occurred AFTER the last
       edit_approved event, sorted newest-first. Handles multiple edit cycles correctly. */
    function getEditRequests(record) {
        const history = Array.isArray(record?.history) ? record.history : [];
        const lastApproved = history
            .filter((e) => e && e.event === 'edit_approved')
            .map((e) => new Date(e.created_at || 0).getTime())
            .reduce((max, t) => Math.max(max, t), 0);
        return history
            .filter((e) => e && typeof e === 'object' && e.event === 'edit_request')
            .filter((e) => new Date(e.created_at || 0).getTime() > lastApproved)
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    /* ── Permit batch helpers ── */

    /* Returns the permit_batch_id for a record (from its history_json gpr3_submission).
       Falls back to a per-record pseudo-key so lone/legacy rows still render. */
    function getPermitBatchId(record) {
        if (!record) return null;
        const meta = getPermitMeta(record);
        const bid = String(meta?.permit_batch_id || '').trim();
        return bid || ('solo-' + record.id);
    }

    /* Groups an array of permit records into an ordered Map: batchId → records[].
       Within each batch, rows are sorted by id ascending so they display in
       submission order (Board Resolution → Statement of Philosophy → … etc.). */
    function groupPermitsByBatch(records) {
        const map = new Map();
        records.forEach((r) => {
            const key = getPermitBatchId(r);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(r);
        });
        map.forEach((batch) => batch.sort((a, b) => Number(a.id) - Number(b.id)));
        return map;
    }

    /* Returns ALL records that belong to the same batch as `record`.
       Used when opening the detail modal so we can list every file. */
    function getBatchSiblings(record) {
        const bid = getPermitBatchId(record);
        return allRecords.filter((r) => String(r.type || '').toLowerCase() === 'permit' && getPermitBatchId(r) === bid);
    }

    /* Merges history arrays from all records in a batch into a single
       chronological list, deduplicating exact-duplicate entries. */
    function mergeBatchHistory(batchRecords) {
        const seen = new Set();
        const merged = [];
        batchRecords.forEach((r) => {
            const hist = Array.isArray(r.history) ? r.history : [];
            hist.forEach((entry) => {
                // Deduplicate by event+created_at+by combo
                const key = `${entry.event || ''}|${entry.created_at || entry.timestamp || ''}|${entry.by || ''}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    merged.push(entry);
                }
            });
        });
        // Sort newest-first
        merged.sort((a, b) => {
            const tA = new Date(a.created_at || a.timestamp || 0).getTime();
            const tB = new Date(b.created_at || b.timestamp || 0).getTime();
            return tB - tA;
        });
        return merged;
    }

    /* The "representative" record for a batch — the one with the most
       actionable status (same priority logic as school-portal-permit.php).
       Used to show a single status badge on the grouped card and to seed
       the status dropdown in the detail modal. */
    function batchRepresentativeRecord(batchRecords) {
        const rank = { 'Returned for Correction': 4, 'Pending Review': 3, 'For Endorsement': 2, 'Approved': 1, 'Released to School': 0, 'draft': -1 };
        return batchRecords.reduce((best, r) => {
            const rb = rank[best.status] ?? 1;
            const rc = rank[r.status]    ?? 1;
            return rc > rb ? r : best;
        }, batchRecords[0]);
    }

    function renderPermitChecklist(checklist) {
        if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) {
            return '<div class="ads-permit-checklist-empty">No checklist data saved.</div>';
        }

        const entries = Object.entries(checklist);
        if (!entries.length) return '<div class="ads-permit-checklist-empty">No checklist data saved.</div>';

        const items = entries
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            .map(([key, value]) => {
                const label = String(key || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const done = !!value;
                return `
                    <div class="ads-permit-check-item ${done ? 'is-done' : 'is-pending'}">
                        <i class="fa-solid ${done ? 'fa-circle-check' : 'fa-circle'}"></i>
                        <span>${esc(label)}</span>
                    </div>
                `;
            }).join('');

        return `<div class="ads-permit-checklist">${items}</div>`;
    }

    async function checkAuthentication() {
        try {
            const res = await fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' });
            if (!res.ok) { window.location.replace('login.html'); return false; }

            const json = await res.json();
            if (!json.success || !json.data?.id) { window.location.replace('login.html'); return false; }
            if (json.data.account_type === 'portal_user') { window.location.replace('school-portal-dashboard.html'); return false; }

            if (typeof Permissions !== 'undefined') {
                await Permissions.loadRolePermissions();
                if (!Permissions.has('school_submissions')) { window.location.replace('dashboard.html'); return false; }
                Permissions.applyNavPermissions();
            }

            if (json.data.full_name) localStorage.setItem('full_name', json.data.full_name);
            if (json.data.email) localStorage.setItem('email', json.data.email);

            const profilePicture = json.data.profile_picture || '';
            if (profilePicture) localStorage.setItem('profile_picture', profilePicture);
            else localStorage.removeItem('profile_picture');

            loadUserInfo(json.data.full_name || '', json.data.email || '', profilePicture);

            const overlay = document.getElementById('loadingOverlay');
            if (overlay) overlay.classList.add('hidden');
            return true;
        } catch (_) {
            window.location.replace('login.html');
            return false;
        }
    }

    function loadUserInfo(fullName, email, profilePicture) {
        const nameValue = fullName || 'User';
        const emailValue = email || '';
        const avatar        = document.getElementById('sidebarAvatar');
        const name          = document.getElementById('sidebarUserName');
        const emailEl       = document.getElementById('sidebarUserEmail');

        if (avatar) {
            if (profilePicture) {
                avatar.innerHTML = `<img src="${esc(profilePicture)}" alt="Profile" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
            } else {
                avatar.textContent = nameValue.charAt(0).toUpperCase();
            }
        }
        if (name)    name.textContent    = nameValue;
        if (emailEl) emailEl.textContent = emailValue;
    }

    async function fetchRecords() {
        const body   = document.getElementById('adsBody');
        const type   = document.getElementById('adsType')?.value   || 'all';

        if (body) body.innerHTML = '<div class="all-docs-empty"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Loading submissions...</div>';

        const url = apiUrl(`/documents-submitted.php?action=list&scope=all&type=${encodeURIComponent(type)}`);

        try {
            const res  = await fetch(url, { credentials: 'include' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load submissions.');
            allRecords = Array.isArray(json.records) ? json.records : [];
            renderCards();
        } catch (err) {
            if (body) body.innerHTML = `<div class="all-docs-empty">${esc(err.message || 'Could not load submissions.')}</div>`;
        }
    }

    /* ─────────────────────────────────────────────────────────────────
       Tab definitions — order matches spec §2
    ───────────────────────────────────────────────────────────────── */
    const STATUS_TABS = [
        { key: 'pending',  label: 'Pending Review',  status: 'Pending Review' },
        { key: 'returned', label: 'Returned',         status: 'Returned for Correction' },
        { key: 'endorsed', label: 'Indorsed to RO',   status: 'For Endorsement' },
        { key: 'approved', label: 'Approved',         status: 'Approved' },
        { key: 'released', label: 'Released',         status: 'Released to School' },
        { key: 'history',  label: 'History',          status: null },
    ];

    let activeTab = 'pending';
    let historyRecordId = null;

    function renderCards() {
        const body = document.getElementById('adsBody');
        if (!body) return;

        const q = (document.getElementById('adsSearch')?.value || '').toLowerCase().trim();

        const filtered = allRecords.filter((r) => {
            if (!q) return true;
            const haystack = [r.school_name, r.title, r.submitted_by, r.status, r.type, r.document_type_label, r.remarks]
                .map((v) => String(v || '').toLowerCase()).join(' ');
            return haystack.includes(q);
        });

        // Tab strip with search + filters embedded below tabs
        const tabsHtml = STATUS_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const count = tab.status === null
                ? allRecords.length
                : allRecords.filter(r => r.status === tab.status).length;
            return `<button class="ads-status-tab${isActive ? ' ads-status-tab--active' : ''}"
                        data-tab="${tab.key}" onclick="ADS.switchTab('${tab.key}')">
                        ${esc(tab.label)}
                        <span class="ads-tab-badge${isActive ? '' : ' ads-tab-badge--inactive'}">${count}</span>
                    </button>`;
        }).join('');

        const currentType   = document.getElementById('adsType')?.value   || 'all';
        const currentSearch = document.getElementById('adsSearch')?.value || '';

        const tabStripHtml = `
            <div class="ads-tabs-strip" id="adsTabStrip">${tabsHtml}</div>
            <div class="ads-tabs-toolbar">
                <div class="all-docs-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="adsSearch" type="search" placeholder="Search school, submitted by, status, type..."
                           value="${esc(currentSearch)}" oninput="ADS._onSearchInput(this.value)" />
                </div>
                <div class="all-docs-select-row">
                    <select id="adsType" class="all-docs-select" onchange="ADS._onTypeChange(this.value)">
                        <option value="all"${currentType==='all'?' selected':''}>All Types</option>
                        <option value="calendar"${currentType==='calendar'?' selected':''}>School Calendar</option>
                        <option value="tuition"${currentType==='tuition'?' selected':''}>Tuition Fee Increase</option>
                        <option value="no_tuition"${currentType==='no_tuition'?' selected':''}>No Tuition Fee Increase</option>
                        <option value="permit"${currentType==='permit'?' selected':''}>School Permit</option>
                    </select>
                </div>
            </div>`;

        let contentHtml;
        if (activeTab === 'history') {
            contentHtml = renderHistoryTabContent(filtered);
        } else {
            const tabDef     = STATUS_TABS.find(t => t.key === activeTab);
            const tabRecords = filtered.filter(r => r.status === tabDef?.status);
            if (!tabRecords.length) {
                contentHtml = '<div class="all-docs-empty">No submissions in this status.</div>';
            } else {
                contentHtml = renderTabContent(tabRecords);
            }
        }

        body.innerHTML = tabStripHtml + `<div class="ads-tab-content" id="adsTabContent">${contentHtml}</div>`;
        bindCardEvents(body);
    }

    /* ─────────────────────────────────────────────────────────────────────
       renderTabContent  —  builds ONE unified table for every record in
       this tab, regardless of document type (calendar, permit, tuition,
       etc). Permit records are first collapsed into one row per batch;
       everything else renders one row per record.
    ───────────────────────────────────────────────────────────────────── */
    function renderTabContent(records) {
        if (!records.length) return '';

        const calRecords    = records.filter(r => String(r.type || '').toLowerCase() === 'calendar');
        const permitRecords = records.filter(r => String(r.type || '').toLowerCase() === 'permit');
        const otherRecords  = records.filter(r => {
            const t = String(r.type || '').toLowerCase();
            return t !== 'calendar' && t !== 'permit';
        });

        // Calendar rows — sorted by school name, then by level, so a
        // school's submissions stay next to each other in the table.
        const levelOrder = ['kinder','preschool','elementary','junior high','jhs','senior high','shs','college','sped'];
        const sortedCal = calRecords.slice().sort((a, b) => {
            const schoolCmp = String(a.school_name || a.title || '').localeCompare(String(b.school_name || b.title || ''));
            if (schoolCmp !== 0) return schoolCmp;
            const aIdx = levelOrder.findIndex(l => String(a.cal_level || '').toLowerCase().includes(l));
            const bIdx = levelOrder.findIndex(l => String(b.cal_level || '').toLowerCase().includes(l));
            return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
        });
        const calRows = sortedCal.map(r => renderCalendarTableRow(r)).join('');

        // Permit rows — one row per batch (a batch may bundle several files)
        const permitBatches = groupPermitsByBatch(permitRecords);
        const permitRows = Array.from(permitBatches.values())
            .map(batch => renderPermitTableRow(batch))
            .join('');

        // Everything else (tuition fee, no tuition fee increase, etc.)
        const docRows = otherRecords.map(r => renderDocTableRow(r)).join('');

        const rowsHtml = calRows + permitRows + docRows;
        if (!rowsHtml) return '<div class="all-docs-empty">No submissions in this status.</div>';

        return `
            <div class="ads-table-wrap ads-unified-table-wrap">
                <table class="ads-cal-table ads-unified-table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Level</th>
                            <th>School</th>
                            <th>Status</th>
                            <th>School Year</th>
                            <th>Submitted By</th>
                            <th>Date Submitted</th>
                            <th>Details</th>
                            <th class="ads-cal-table-action-col"></th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
    }

    /* Renders one permit application (batch) as a single table row.
       Shows the school name, app type, status, meta columns, and a
       compact list of file chips (each individually clickable) in the
       Details column. Clicking anywhere else on the row opens the batch
       detail modal via the representative record. */
    function renderPermitTableRow(batchRecords) {
        if (!batchRecords || !batchRecords.length) return '';
        const rep       = batchRepresentativeRecord(batchRecords);
        const status    = statusMeta(rep.status);
        const meta      = getPermitMeta(rep);
        const schoolLabel = meta?.school_name || rep.school_name || rep.title || '—';
        const appLabel  = permitAppTypeLabel(meta?.app_type, meta?.app_type_label || rep.document_type_label || '');
        const hasEditReq = batchRecords.some(r => getEditRequests(r).length > 0);

        // File chips — clicking opens that specific file's record; being
        // nested inside the row, closest() resolves to the chip first.
        const fileChips = batchRecords.map((r) => {
            const fname = r.file_name || (r.file_path ? r.file_path.split('/').pop().split('?')[0] : 'File');
            return `<span class="ads-permit-file-chip ads-card-click" role="button" tabindex="0"
                data-action="open-card" data-id="${Number(r.id)}">
                <i class="fa-solid fa-file-lines"></i>
                <span class="ads-permit-chip-name">${esc(fname)}</span>
            </span>`;
        }).join('');

        return `
            <tr class="ads-cal-table-row ads-permit-table-row ads-card-click" role="button" tabindex="0"
                data-action="open-card" data-id="${Number(rep.id)}">
                <td>
                    <div class="ds-doc-type-chip">
                        <i class="fa-solid fa-file-shield"></i>
                        School Permit
                    </div>
                    <div class="ads-permit-row-apptype">${esc(appLabel)}</div>
                    ${hasEditReq ? `<span class="ads-edit-req-badge ads-edit-req-badge-sm"><i class="fa-solid fa-pen-to-square"></i> Edit Req.</span>` : ''}
                </td>
                <td>—</td>
                <td>${esc(schoolLabel)}</td>
                <td>
                    <span class="ds-status-badge ${status.cls}">
                        <i class="fa-solid ${status.icon}"></i>${esc(rep.status || 'Pending')}
                    </span>
                </td>
                <td>${esc(rep.school_year || meta?.school_year || '—')}</td>
                <td>${esc(rep.submitted_by || '—')}</td>
                <td>${esc(formatDate(rep.date_submitted || rep.submitted_at))}</td>
                <td class="ads-cal-table-details-cell"><div class="ads-permit-table-files">${fileChips}</div></td>
                <td class="ads-cal-table-action">
                    <i class="fa-solid fa-eye" title="Click to view &amp; preview"></i>
                </td>
            </tr>`;
    }

    /* A single table row for one calendar level submission. */
    function renderCalendarTableRow(r) {
        const status     = statusMeta(r.status);
        const editReqs   = getEditRequests(r);
        const hasEditReq = editReqs.length > 0;
        const levelLabel = r.cal_level || r.document_type_label || 'School Calendar';
        const calInfo    = (r.cal_opening || r.cal_days)
            ? `${r.cal_opening ? `Opens ${esc(formatDate(r.cal_opening))}` : ''}${(r.cal_opening && r.cal_days) ? ' &middot; ' : ''}${r.cal_days ? `${esc(r.cal_days)} days` : ''}`
            : '—';

        return `
            <tr class="ads-cal-table-row ads-card-click" role="button" tabindex="0"
                data-action="open-card" data-id="${Number(r.id)}">
                <td>
                    <div class="ds-doc-type-chip">
                        <i class="fa-solid fa-calendar-days"></i>
                        School Calendar
                    </div>
                    ${hasEditReq ? `<span class="ads-edit-req-badge ads-edit-req-badge-sm"><i class="fa-solid fa-pen-to-square"></i> Edit Req.</span>` : ''}
                </td>
                <td>
                    <div class="ds-doc-type-chip ads-cal-level-chip ${deptChipClass(levelLabel)}">
                        <i class="fa-solid fa-graduation-cap"></i>
                        ${esc(levelLabel)}
                    </div>
                </td>
                <td>${esc(r.school_name || r.title || '—')}</td>
                <td>
                    <span class="ds-status-badge ${status.cls}">
                        <i class="fa-solid ${status.icon}"></i>${esc(r.status || 'Pending')}
                    </span>
                </td>
                <td>${esc(r.school_year || '—')}</td>
                <td>${esc(r.submitted_by || '—')}</td>
                <td>${esc(formatDate(r.date_submitted || r.submitted_at))}</td>
                <td>${calInfo}</td>
                <td class="ads-cal-table-action">
                    <i class="fa-solid fa-eye" title="Click to view &amp; preview"></i>
                </td>
            </tr>`;
    }

    /* Returns a CSS class for color-coding the level chip, mirroring the
       deptBadgeMeta() logic in the school portal calendar builder. */
    function deptChipClass(level) {
        const l = String(level || '').toLowerCase();
        if (l.includes('kinder') || l.includes('preschool'))            return 'ads-dept-kinder';
        if (l.includes('elementary'))                                   return 'ads-dept-elem';
        if (l.includes('junior high') || l === 'jhs' || l.includes('jhs')) return 'ads-dept-jhs';
        if (l.includes('senior high') || l === 'shs' || l.includes('shs')) return 'ads-dept-shs';
        if (l.includes('college'))                                      return 'ads-dept-college';
        if (l.includes('sped'))                                         return 'ads-dept-sped';
        return '';
    }

    /* Renders one non-calendar, non-permit submission (e.g. Tuition Fee
       Increase, No Tuition Fee Increase) as a single table row. */
    function renderDocTableRow(r) {
        const status     = statusMeta(r.status);
        const editReqs   = getEditRequests(r);
        const hasEditReq = editReqs.length > 0;

        return `
            <tr class="ads-cal-table-row ads-card-click" role="button" tabindex="0"
                data-action="open-card" data-id="${Number(r.id)}">
                <td>
                    <div class="ds-doc-type-chip">
                        <i class="fa-solid ${typeIcon(r.type)}"></i>
                        ${esc(r.document_type_label || r.type || 'Document')}
                    </div>
                    ${hasEditReq ? `<span class="ads-edit-req-badge ads-edit-req-badge-sm"><i class="fa-solid fa-pen-to-square"></i> Edit Req.</span>` : ''}
                </td>
                <td>—</td>
                <td>${esc(r.school_name || r.title || '—')}</td>
                <td>
                    <span class="ds-status-badge ${status.cls}">
                        <i class="fa-solid ${status.icon}"></i>${esc(r.status || 'Pending')}
                    </span>
                </td>
                <td>${esc(r.school_year || '—')}</td>
                <td>${esc(r.submitted_by || '—')}</td>
                <td>${esc(formatDate(r.date_submitted || r.submitted_at))}</td>
                <td class="ads-cal-table-details-cell">${r.file_name ? `<span class="ads-doc-table-file"><i class="fa-solid fa-file"></i> ${esc(r.file_name)}</span>` : '—'}</td>
                <td class="ads-cal-table-action">
                    <i class="fa-solid fa-eye" title="Click to view &amp; preview"></i>
                </td>
            </tr>`;
    }



    /* ─────────────────────────────────────────────────────────────────
       History tab  —  spec §6
       Left: scrollable list of all matching submissions.
       Right: full audit trail for the selected record, newest-first.
       Permit batches are shown as a single entry in the list and their
       merged history is displayed on the right.
    ───────────────────────────────────────────────────────────────── */
    function renderHistoryTabContent(filtered) {
        if (!filtered.length) {
            return '<div class="all-docs-empty">No submissions found for the current filters.</div>';
        }

        // Build a deduplicated list of "history entries":
        // - For calendars / non-permits: one entry per record (as before)
        // - For permits: one entry per batch (using the rep record's id as key)
        const seenBatches = new Set();
        const historyEntries = []; // { id (rep record id), record (rep), batchRecords, label, sublabel }
        filtered.forEach((r) => {
            const isPermit = String(r.type || '').toLowerCase() === 'permit';
            if (isPermit) {
                const bid = getPermitBatchId(r);
                if (seenBatches.has(bid)) return;
                seenBatches.add(bid);
                const batch = filtered.filter(fr => String(fr.type || '').toLowerCase() === 'permit' && getPermitBatchId(fr) === bid);
                const rep   = batchRepresentativeRecord(batch);
                const meta  = getPermitMeta(rep);
                const appLabel = permitAppTypeLabel(meta?.app_type, meta?.app_type_label || rep.document_type_label || '');
                historyEntries.push({
                    id: Number(rep.id),
                    record: rep,
                    batchRecords: batch,
                    label: rep.school_name || rep.title || '—',
                    sublabel: `${appLabel} · ${batch.length} file${batch.length > 1 ? 's' : ''} · ${rep.status || ''}`,
                });
            } else {
                const typeDisplay = r.cal_level
                    ? esc(r.document_type_label || r.type || '') + ' · ' + esc(r.cal_level)
                    : esc(r.document_type_label || r.type || '');
                historyEntries.push({
                    id: Number(r.id),
                    record: r,
                    batchRecords: [r],
                    label: r.school_name || r.title || '—',
                    sublabel: `${r.document_type_label || r.type || ''} · ${r.status || ''}`,
                });
            }
        });

        if (!historyEntries.length) {
            return '<div class="all-docs-empty">No submissions found for the current filters.</div>';
        }

        if (!historyRecordId || !historyEntries.find(e => e.id === historyRecordId)) {
            historyRecordId = historyEntries[0].id;
        }

        const selectedEntry = historyEntries.find(e => e.id === historyRecordId) || historyEntries[0];

        const listHtml = historyEntries.map((entry) => {
            const isSelected = entry.id === Number(selectedEntry.id);
            return `<div class="ads-hist-record-item${isSelected ? ' ads-hist-record-item--active' : ''}"
                        data-action="select-history-record" data-id="${entry.id}">
                        <div class="ads-hist-record-name">${esc(entry.label)}</div>
                        <div class="ads-hist-record-meta">${entry.sublabel}</div>
                    </div>`;
        }).join('');

        const mergedHistory = mergeBatchHistory(selectedEntry.batchRecords);
        const trailRecord   = Object.assign({}, selectedEntry.record, { history: mergedHistory });

        return `
            <div class="ads-history-layout">
                <div class="ads-hist-list" id="adsHistList">
                    <div class="ads-hist-list-title">All Submissions</div>
                    ${listHtml}
                </div>
                <div class="ads-hist-trail" id="adsHistTrail">
                    <div class="ads-hist-trail-header">
                        <strong>${esc(selectedEntry.label)}</strong>
                        <span class="ads-hist-trail-sub">${esc(selectedEntry.record.document_type_label || selectedEntry.record.type || '')}</span>
                        ${selectedEntry.batchRecords.length > 1 ? `<span class="ads-hist-trail-sub ads-hist-batch-note"><i class="fa-solid fa-paperclip"></i> ${selectedEntry.batchRecords.length} files in this application — history merged</span>` : ''}
                    </div>
                    ${renderHistoryTrail(trailRecord)}
                </div>
            </div>`;
    }

    function renderHistoryTrail(record) {
        const rawHistory = Array.isArray(record?.history) ? record.history : [];

        // The school portal now writes a { event: 'submitted' } entry into
        // history_json on first submission (school-portal-calendar.php INSERT path).
        // For older records that predate this, synthesize one as a fallback using
        // submitted_at (which may be the resubmission time for edited records, but
        // is the best available signal for legacy rows).
        const hasSubmittedEvent = rawHistory.some(e => e && e.event === 'submitted');
        const syntheticHistory = [...rawHistory];
        if (!hasSubmittedEvent) {
            const submittedAt = record.submitted_at || record.date_submitted || null;
            const submittedBy = record.submitted_by || record.created_by_name || null;
            if (submittedAt) {
                syntheticHistory.push({
                    event:      'submitted',
                    by:         submittedBy || '—',
                    created_at: submittedAt,
                });
            }
        }

        if (!syntheticHistory.length) {
            return '<div class="all-docs-empty" style="padding:24px 0;">No history entries for this submission.</div>';
        }

        // Sort newest-first; backward-compat: fall back to legacy timestamp field (spec §8.2)
        const sorted = [...syntheticHistory].sort((a, b) => {
            const tA = new Date(a.created_at || a.timestamp || 0).getTime();
            const tB = new Date(b.created_at || b.timestamp || 0).getTime();
            return tB - tA;
        });

        const EVENT_META = {
            status_update: { color: '#378ADD', label: (e) => `Status updated \u2192 ${e.status || ''}` },
            edit_request:  { color: '#7F77DD', label: ()    => 'Edit requested' },
            edit_approved: { color: '#639922', label: ()    => 'Edit approved' },
            submitted:     { color: '#888780', label: ()    => 'Document submitted' },
        };

        const entriesHtml = sorted.map((entry) => {
            const ev   = entry.event || 'status_update';
            const ts   = entry.created_at || entry.timestamp || null;
            const meta = EVENT_META[ev] || { color: '#888780', label: () => esc(ev) };

            const dateStr = ts
                ? (new Date(ts).toLocaleDateString('en-PH') + ' ' +
                   new Date(ts).toLocaleTimeString('en-PH', { hour12: true }))
                : '—';

            const note = String(entry.note || entry.reason || '').trim();

            return `
                <div class="ads-hist-entry">
                    <span class="ads-hist-dot" style="background:${meta.color}"></span>
                    <div class="ads-hist-entry-body">
                        <div class="ads-hist-entry-main">
                            <span class="ads-hist-event-label">${meta.label(entry)}</span>
                            <span class="ads-hist-entry-by">by ${esc(entry.by || '—')}</span>
                            <span class="ads-hist-entry-time">${esc(dateStr)}</span>
                        </div>
                        ${note ? `<div class="ads-hist-entry-note">${esc(note)}</div>` : ''}
                    </div>
                </div>`;
        }).join('');

        const legendHtml = `
            <div class="ads-hist-legend">
                <span class="ads-hist-legend-title">Legend</span>
                <div class="ads-hist-legend-items">
                    <span class="ads-hist-legend-item">
                        <span class="ads-hist-dot" style="background:#888780;flex-shrink:0;"></span>
                        Document submitted
                    </span>
                    <span class="ads-hist-legend-item">
                        <span class="ads-hist-dot" style="background:#378ADD;flex-shrink:0;"></span>
                        Status updated
                    </span>
                    <span class="ads-hist-legend-item">
                        <span class="ads-hist-dot" style="background:#7F77DD;flex-shrink:0;"></span>
                        Edit requested
                    </span>
                    <span class="ads-hist-legend-item">
                        <span class="ads-hist-dot" style="background:#639922;flex-shrink:0;"></span>
                        Edit approved
                    </span>
                </div>
            </div>`;

        return `<div class="ads-hist-trail-entries">${legendHtml}${entriesHtml}</div>`;
    }

    function _onSearchInput(val) {
        // Re-render just the content pane, not the whole body (preserves input focus)
        const q = (val || '').toLowerCase().trim();
        const filtered = allRecords.filter((r) => {
            if (!q) return true;
            const haystack = [r.school_name, r.title, r.submitted_by, r.status, r.type, r.document_type_label, r.remarks]
                .map((v) => String(v || '').toLowerCase()).join(' ');
            return haystack.includes(q);
        });

        const tabContent = document.getElementById('adsTabContent');
        if (!tabContent) return;

        let contentHtml;
        if (activeTab === 'history') {
            contentHtml = renderHistoryTabContent(filtered);
        } else {
            const tabDef     = STATUS_TABS.find(t => t.key === activeTab);
            const tabRecords = filtered.filter(r => r.status === tabDef?.status);
            contentHtml = tabRecords.length
                ? renderTabContent(tabRecords)
                : '<div class="all-docs-empty">No submissions in this status.</div>';
        }
        tabContent.innerHTML = contentHtml;
        bindCardEvents(document.getElementById('adsBody'));
    }

    function _onTypeChange(val) {
        // Refetch with the new type filter
        fetchRecords();
    }

    function _onStatusChange(val) {
        fetchRecords();
    }

    function switchTab(key) {
        activeTab = key;
        renderCards();
    }

    function bindCardEvents(body) {
        body.addEventListener('click', (e) => {
            // History tab: clicking a record in the left list updates the trail panel only.
            // Do NOT call bindCardEvents again here — the listener on `body` persists across
            // partial re-renders and re-calling it would stack duplicate listeners on every click.
            const histItem = e.target.closest('[data-action="select-history-record"]');
            if (histItem) {
                historyRecordId = Number(histItem.dataset.id || 0);

                // Update active highlight in the left list
                document.querySelectorAll('.ads-hist-record-item').forEach((el) => {
                    el.classList.toggle('ads-hist-record-item--active', Number(el.dataset.id) === historyRecordId);
                });

                // Re-render only the right trail panel — no full re-render, no new listener
                const trail = document.getElementById('adsHistTrail');
                if (trail) {
                    const record = allRecords.find(r => Number(r.id) === historyRecordId);
                    if (record) {
                        const isPermit = String(record.type || '').toLowerCase() === 'permit';
                        let batchRecords = [record];
                        if (isPermit) {
                            const bid = getPermitBatchId(record);
                            batchRecords = allRecords.filter(r => String(r.type || '').toLowerCase() === 'permit' && getPermitBatchId(r) === bid);
                        }
                        const mergedHistory = mergeBatchHistory(batchRecords);
                        const trailRecord   = Object.assign({}, record, { history: mergedHistory });
                        const appLabel      = isPermit ? permitAppTypeLabel(getPermitMeta(record)?.app_type, record.document_type_label || '') : '';
                        trail.innerHTML = `
                            <div class="ads-hist-trail-header">
                                <strong>${esc(record.school_name || record.title || '—')}</strong>
                                <span class="ads-hist-trail-sub">${esc(record.document_type_label || record.type || '')}${record.cal_level ? ' \u00b7 ' + esc(record.cal_level) : ''}</span>
                                ${isPermit && batchRecords.length > 1 ? `<span class="ads-hist-trail-sub ads-hist-batch-note"><i class="fa-solid fa-paperclip"></i> ${batchRecords.length} files — history merged</span>` : ''}
                            </div>
                            ${renderHistoryTrail(trailRecord)}`;
                    }
                }
                return;
            }

            const btn = e.target.closest('[data-action]:not([data-action="open-card"])');
            if (btn) {
                const action = btn.dataset.action;
                const id     = Number(btn.dataset.id || 0);

                if (action === 'toggle-menu')        { e.stopPropagation(); toggleDownloadMenu(e, id, btn); return; }
                if (action === 'preview-file')        { e.stopPropagation(); if (btn.dataset.isCalendar) printCalendarPreview(id); else openFilePreview(btn.dataset.filePath || '', btn.dataset.fileName || ''); return; }
                if (action === 'open-file')           { e.stopPropagation(); openFile(btn.dataset.filePath || ''); return; }
                if (action === 'download')            { e.stopPropagation(); downloadSubmission(id, btn.dataset.type || '', btn.dataset.filePath || '', btn.dataset.format || 'pdf'); return; }
                if (action === 'generate-indorsement'){ e.stopPropagation(); closeAllDownloadMenus(); generateIndorsementFromRecord(id); return; }
            }

            const card = e.target.closest('[data-action="open-card"]');
            if (card) openCard(Number(card.dataset.id || 0));
        });

        body.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('[data-action="open-card"]');
            if (!card) return;
            e.preventDefault();
            openCard(Number(card.dataset.id || 0));
        });
    }

    function openPreview(id, format) {
        const record = allRecords.find((x) => Number(x.id) === Number(id));
        const type   = String(record?.type || '').toLowerCase();
        const isCal  = type === 'calendar';
        const isTf   = type === 'tuition' || type === 'no_tuition';
        if (String(format || '').toLowerCase() === 'pdf') {
            if (isCal) { printCalendarPreview(id); return; }
        }
        if (isTf && ['pdf', 'word', 'docx'].includes(String(format || '').toLowerCase())) {
            exportSubmittedTuitionWord(id);
            return;
        }
        const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=${encodeURIComponent(format)}&preview=1`);
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }

    function closeAllDownloadMenus() {
        document.querySelectorAll('.ads-download-dropdown.open').forEach((el) => el.classList.remove('open'));
    }

    function toggleDownloadMenu(event, id, btnEl) {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        const menu = document.getElementById(`adsDownloadMenu-${Number(id)}`);
        if (!menu) return;
        const willOpen = !menu.classList.contains('open');
        closeAllDownloadMenus();
        if (willOpen) {
            const anchor = btnEl || event.currentTarget;
            const rect   = anchor.getBoundingClientRect();
            menu.style.top   = `${rect.bottom + 6}px`;
            menu.style.right = `${window.innerWidth - rect.right}px`;
            menu.classList.add('open');
        }
    }

    async function downloadSubmission(id, type, filePath, format) {
        closeAllDownloadMenus();
        const t = String(type || '').toLowerCase();

        if (t === 'calendar') {
            if (format === 'pdf') { printCalendarPreview(id); return; }
            if (format === 'word') {
                const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=word`);
                try {
                    const res = await fetch(url, { credentials: 'include' });
                    const ct  = res.headers.get('Content-Type') || '';
                    if (ct.includes('application/json')) { const json = await res.json(); alert('Download failed: ' + (json.message || 'Unknown error')); return; }
                    const blob    = await res.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl; a.download = `calendar-${id}.docx`; a.rel = 'noopener';
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                } catch (err) { alert('Download failed: ' + err.message); }
                return;
            }
        }

        if (!filePath) return;
        try {
            let url = String(filePath).trim();
            if (!/^https?:\/\//i.test(url)) url = new URL(url, url.startsWith('/') ? window.location.origin : window.location.href).toString();
            const res = await fetch(url, { credentials: 'include' });
            const ct  = res.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) { const json = await res.json(); alert('Download failed: ' + (json.message || 'Unknown error')); return; }
            const blob    = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl; a.download = String(filePath).split('/').pop().split('?')[0] || ('download.' + format); a.rel = 'noopener';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        } catch (err) { alert('Download failed: ' + err.message); }
    }

    function openCard(id) { openDetailModal(id); }

    async function printCalendarPreview(id) {
        ensureCalendarPreviewStyles();
        if (Number(detailRecordId) !== Number(id)) openDetailModal(id);
        await loadCalendarPreviewHtml(id, { silent: true });

        const sourceHost = document.getElementById('adsCalendarPreviewHost');
        if (!sourceHost || sourceHost.dataset.loaded !== '1') { alert('Preview is not ready yet. Please try again.'); return; }

        const existingHost = document.getElementById('adsPrintHost');
        if (existingHost) existingHost.remove();

        const printHost = document.createElement('div');
        printHost.id        = 'adsPrintHost';
        printHost.className = 'ads-print-target';
        printHost.innerHTML = sourceHost.innerHTML;
        document.body.appendChild(printHost);

        document.body.dataset.printing = '1';

        const allPages = printHost.querySelectorAll('.doc-page');
        allPages.forEach((p) => p.style.setProperty('display', 'block', 'important'));

        const skipped = [];
        printHost.querySelectorAll('.paper').forEach((paper) => {
            const clone = paper.cloneNode(true);
            const lh    = clone.querySelector('.lh');
            if (lh) lh.remove();
            if (!(clone.textContent || '').replace(/\s+/g, '')) {
                paper.style.setProperty('display', 'none', 'important');
                skipped.push(paper);
            }
        });

        const hiddenPages = [];
        printHost.querySelectorAll('.doc-page').forEach((page) => {
            const papers = Array.from(page.querySelectorAll('.paper'));
            if (!papers.length || papers.every((p) => p.style.display === 'none')) {
                page.style.setProperty('display', 'none', 'important');
                hiddenPages.push(page);
            }
        });

        window.print();

        const restore = () => {
            allPages.forEach((p) => p.style.removeProperty('display'));
            skipped.forEach((p) => p.style.removeProperty('display'));
            hiddenPages.forEach((p) => p.style.removeProperty('display'));
            if (printHost.parentNode) printHost.parentNode.removeChild(printHost);
            delete document.body.dataset.printing;
            window.removeEventListener('afterprint', restore);
        };

        window.addEventListener('afterprint', restore);
        setTimeout(restore, 2000);
    }

    async function printTuitionPreview(id) {
        ensureTuitionPreviewStyles();
        if (Number(detailRecordId) !== Number(id)) openDetailModal(id);
        await loadTuitionPreviewHtml(id, { silent: true });

        const sourceHost = document.getElementById('adsTuitionPreviewHost');
        if (!sourceHost || sourceHost.dataset.loaded !== '1') { alert('Preview is not ready yet. Please try again.'); return; }

        const existingHost = document.getElementById('adsPrintHost');
        if (existingHost) existingHost.remove();

        const printHost = document.createElement('div');
        printHost.id        = 'adsPrintHost';
        printHost.className = 'ads-print-target ads-print-target-tuition';
        printHost.innerHTML = sourceHost.innerHTML;
        document.body.appendChild(printHost);

        document.body.dataset.printing = '1';

        // Skip visually-empty pages the same way the calendar print flow does:
        // strip the letterhead/official-header chrome from a clone and check
        // whether anything is left. A page with only a header and no fee rows
        // (e.g. a level that was never enabled) shouldn't print a blank sheet.
        const skipped = [];
        printHost.querySelectorAll('.paper').forEach((paper) => {
            const clone = paper.cloneNode(true);
            const header = clone.querySelector('.tf-official-header');
            if (header) header.remove();
            if (!(clone.textContent || '').replace(/\s+/g, '')) {
                paper.style.setProperty('display', 'none', 'important');
                skipped.push(paper);
            }
        });

        window.print();

        const restore = () => {
            skipped.forEach((p) => p.style.removeProperty('display'));
            if (printHost.parentNode) printHost.parentNode.removeChild(printHost);
            delete document.body.dataset.printing;
            window.removeEventListener('afterprint', restore);
        };

        window.addEventListener('afterprint', restore);
        setTimeout(restore, 2000);
    }

    /* ─────────────────────────────────────────────────────────────────
       openDetailModal  —  all layout via CSS classes, zero inline styles
    ───────────────────────────────────────────────────────────────── */
    function openDetailModal(id, preserveMsg = false) {
        const record = allRecords.find((x) => Number(x.id) === Number(id));
        if (!record) return;
        detailRecordId = Number(id);

        const overlay = document.getElementById('adsDetailOverlay');
        const titleEl = document.getElementById('adsDetailTitle');
        const bodyEl  = document.getElementById('adsDetailBody');
        if (!overlay || !titleEl || !bodyEl) return;

        const m          = statusMeta(record.status);
        const isCalendar = String(record.type || '').toLowerCase() === 'calendar';
        const isTuition  = String(record.type || '').toLowerCase() === 'tuition';
        const isPermit   = String(record.type || '').toLowerCase() === 'permit';
        const canInd     = typeof openIndorsementModal === 'function';
        const permitMeta = isPermit ? getPermitMeta(record) : null;

        // Gather batch siblings for permit applications
        const permitBatch    = isPermit ? getBatchSiblings(record) : [record];
        const permitBatchRep = isPermit ? batchRepresentativeRecord(permitBatch) : record;
        // Use rep status for the dropdown seed
        const seedStatus     = isPermit ? (permitBatchRep.status || record.status) : record.status;

        /* Header title + inline status badge */
        titleEl.innerHTML =
            esc(record.school_name || record.title || 'Submission Details') +
            `<span class="dsd-title-status-badge ${m.cls}">` +
            `<i class="fa-solid ${m.icon}"></i>${esc(record.status || 'Pending Review')}</span>`;

        /* Calendar-specific rows */
        const calRows = isCalendar ? `
            ${record.cal_level      ? `<div class="dsd-field-row"><div class="dsd-field-label">Level</div><div class="dsd-field-value">${esc(record.cal_level)}</div></div>` : ''}
            ${record.school_address ? `<div class="dsd-field-row"><div class="dsd-field-label">Address</div><div class="dsd-field-value">${esc(record.school_address)}</div></div>` : ''}
            ${record.cal_opening    ? `<div class="dsd-field-row"><div class="dsd-field-label">Start Date</div><div class="dsd-field-value">${esc(formatDate(record.cal_opening))}</div></div>` : ''}
            ${record.cal_closing    ? `<div class="dsd-field-row"><div class="dsd-field-label">End Date</div><div class="dsd-field-value">${esc(formatDate(record.cal_closing))}</div></div>` : ''}
            ${record.cal_days       ? `<div class="dsd-field-row"><div class="dsd-field-label">Total School Days</div><div class="dsd-field-value"><strong>${esc(record.cal_days)}</strong> days</div></div>` : ''}
            <div class="dsd-section">
                <div class="dsd-section-title"><i class="fa-solid fa-folder-open"></i> Supporting Documents</div>
                <div id="adsCalendarSupportingDocs" class="ads-tf-supp-list">
                    <div class="ads-tf-supp-loading"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Loading…</div>
                </div>
            </div>
        ` : '';

        /* Tuition-specific rows — full breakdown loads into the preview
           panel via loadTuitionPreviewHtml(); the sidebar just shows the
           address if we already have it from the join in actionList. */
        const tuitionRows = isTuition ? `
            ${record.school_address ? `<div class="dsd-field-row"><div class="dsd-field-label">Address</div><div class="dsd-field-value">${esc(record.school_address)}</div></div>` : ''}
            <div id="adsTuitionExtraDetails"></div>
            <div class="dsd-section ads-tf-supporting-section">
                <div class="dsd-section-title"><i class="fa-solid fa-folder-open"></i> Supporting Documents</div>
                <div id="adsTuitionSupportingDocs" class="ads-tf-supp-list">
                    <div class="ads-tf-supp-loading"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Loading…</div>
                </div>
            </div>
        ` : '';

        const permitChecklist = permitMeta && permitMeta.checklist && typeof permitMeta.checklist === 'object' ? permitMeta.checklist : null;
        const permitChecklistEntries = permitChecklist ? Object.values(permitChecklist) : [];
        const permitChecklistReady = permitChecklistEntries.filter(Boolean).length;
        const permitChecklistTotal = permitChecklistEntries.length;
        const permitRows = isPermit ? `
            <div class="dsd-section ads-permit-section">
                <div class="dsd-section-title"><i class="fa-solid fa-file-shield"></i> Permit Details</div>
                <div class="dsd-field-row"><div class="dsd-field-label">Application Type</div><div class="dsd-field-value">${esc(permitAppTypeLabel(permitMeta?.app_type, permitMeta?.app_type_label || record.document_type_label || ''))}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">School Name</div><div class="dsd-field-value">${esc(permitMeta?.school_name || record.school_name || '—')}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">Address</div><div class="dsd-field-value">${esc(permitMeta?.address || '—')}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">Course / Program</div><div class="dsd-field-value">${esc(permitMeta?.course || '—')}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">Curriculum Year(s)</div><div class="dsd-field-value">${esc(permitMeta?.curriculum_year || '—')}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">Gov. Authority</div><div class="dsd-field-value">${esc(permitMeta?.gov_authority || '—')}</div></div>
                <div class="dsd-field-row"><div class="dsd-field-label">Checklist</div><div class="dsd-field-value">${permitChecklistTotal ? `<strong>${permitChecklistReady}/${permitChecklistTotal}</strong> ready` : 'No checklist data'}</div></div>
                <div class="dsd-field-row ads-permit-checklist-row"><div class="dsd-field-label">Checklist Items</div><div class="dsd-field-value">${renderPermitChecklist(permitChecklist)}</div></div>
            </div>
        ` : '';

        /* File info */
        const rawFilePath  = String(record.file_path  || '').trim();
        const rawFileName  = String(record.file_name  || '').trim();
        const fileName     = rawFileName || (rawFilePath ? rawFilePath.split('/').pop().split('?')[0] : '');
        const fileExtLower = fileExt(fileName || rawFilePath);
        const fileUrl      = rawFilePath
            ? (!/^https?:\/\//i.test(rawFilePath)
                ? new URL(rawFilePath, rawFilePath.startsWith('/') ? window.location.origin : window.location.href).toString()
                : rawFilePath)
            : '';
        const isInlinePdf  = !isCalendar && !isTuition && fileUrl && fileExtLower === 'pdf';

        /* Build the preview region */
        let previewRegion;
        if (isCalendar) {
            previewRegion = `<div id="adsCalendarPreviewHost" class="ads-calendar-preview"></div>`;
        } else if (isTuition) {
            previewRegion = `<div id="adsTuitionPreviewHost" class="ads-tuition-preview"></div>`;
        } else if (isInlinePdf) {
            previewRegion = `<div id="adsInlineFilePreview"></div>`;
        } else if (fileUrl) {
            previewRegion = `
                <div class="dsd-no-preview">
                    <i class="fa-solid fa-file"></i>
                    <div>Preview not available for this file type.</div>
                    <button class="dsd-no-preview-btn" onclick="ADS.openFile('${escJsSingle(rawFilePath)}')">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open file
                    </button>
                </div>`;
        } else {
            previewRegion = `
                <div class="dsd-no-preview">
                    <i class="fa-solid fa-file-circle-question"></i>
                    <span>No file preview available for this document.</span>
                </div>`;
        }

        /* Permit batch file list — shown when there are multiple files in the application */
        const permitBatchFilesHtml = (isPermit && permitBatch.length > 1) ? `
            <div class="dsd-section ads-permit-batch-files-section">
                <div class="dsd-section-title"><i class="fa-solid fa-paperclip"></i> Files in this Application (${permitBatch.length})</div>
                ${permitBatch.map((br) => {
                    const bfName = br.file_name || (br.file_path ? br.file_path.split('/').pop().split('?')[0] : 'File');
                    const bStatus = statusMeta(br.status);
                    const isActive = Number(br.id) === Number(record.id);
                    return `<div class="ads-permit-batch-file-row${isActive ? ' is-active' : ''}">
                        <i class="fa-solid fa-file-lines"></i>
                        <span class="ads-permit-batch-file-name">${esc(bfName)}</span>
                        <span class="ds-status-badge ${bStatus.cls}" style="font-size:10px;padding:2px 7px;">
                            <i class="fa-solid ${bStatus.icon}"></i>${esc(br.status || 'Pending')}
                        </span>
                    </div>`;
                }).join('')}
                <p class="ads-permit-batch-note"><i class="fa-solid fa-circle-info"></i> Saving status below will update <strong>all ${permitBatch.length} files</strong> in this application.</p>
            </div>
        ` : '';
        const editReqs = getEditRequests(record);
        const editReqAlertHtml = editReqs.length > 0 ? `
            <div class="dsd-section ads-edit-req-section">
                <div class="dsd-section-title ads-edit-req-title">
                    <i class="fa-solid fa-pen-to-square"></i> Edit Request${editReqs.length > 1 ? 's (' + editReqs.length + ')' : ''}
                </div>
                ${editReqs.map((req) => `
                    <div class="ads-edit-req-entry">
                        <div class="ads-edit-req-meta">
                            <span class="ads-edit-req-by"><i class="fa-solid fa-user"></i> ${esc(req.by || 'Unknown')}</span>
                            <span class="ads-edit-req-date">${esc(formatDate(req.created_at || ''))}</span>
                        </div>
                        ${req.reason ? `<div class="ads-edit-req-reason">${esc(req.reason)}</div>` : '<div class="ads-edit-req-reason ads-edit-req-no-reason">No reason provided</div>'}
                    </div>
                `).join('')}
                <button class="ads-approve-edit-btn" id="adsApproveEditBtn"
                    data-action="approve-edit" data-id="${Number(record.id)}"
                    onclick="ADS.approveEditRequest(${Number(record.id)})">
                    <i class="fa-solid fa-unlock"></i> Approve Edit
                </button>
            </div>
        ` : '';

        bodyEl.innerHTML = `
            <div class="dsd-layout preview-hidden" id="adsDetailLayout">

                <!-- LEFT SIDEBAR -->
                <div class="dsd-sidebar">
                    ${permitBatchFilesHtml}
                    ${editReqAlertHtml}
                    <div class="dsd-section">
                        <div class="dsd-section-title"><i class="fa-solid fa-circle-info"></i> Details</div>
                        <div class="dsd-field-row"><div class="dsd-field-label">Type</div><div class="dsd-field-value">${esc(typeLabel(record))}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">School</div><div class="dsd-field-value">${esc(record.school_name || '—')}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">School Year</div><div class="dsd-field-value">${esc(record.school_year || '—')}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">Submitted By</div><div class="dsd-field-value">${esc(record.submitted_by || '—')}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">Date Submitted</div><div class="dsd-field-value">${esc(formatDate(record.date_submitted || record.submitted_at))}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">Date Actioned</div><div class="dsd-field-value">${esc(formatDate(record.date_actioned || ''))}</div></div>
                        ${calRows}
                        ${tuitionRows}
                    </div>
                    ${permitRows}

                    <!-- Status update form removed — now in fixed footer -->
                </div>

                <!-- RIGHT PREVIEW PANEL — hidden by default -->
                <div class="dsd-preview-panel preview-hidden" id="adsPreviewPanel">

                    <!-- Preview area -->
                    <div class="ads-preview-frame-wrap" id="adsPreviewFrameWrap">
                        ${previewRegion}
                    </div>

                </div>
            </div>
        `;

        /* Populate modal header action buttons */
        const headActions = document.getElementById('adsModalHeadActions');
        if (headActions) {
            headActions.innerHTML = `
                <button class="dsd-btn-toggle-preview" id="adsTogglePreviewBtn" onclick="ADS.toggleDetailPreview()">
                    <i class="fa-solid fa-eye" id="adsTogglePreviewIcon"></i>
                    <span id="adsTogglePreviewLabel">Show Preview</span>
                </button>
                ${canInd ? `
                <button class="dsd-btn-indorsement" onclick="ADS.generateIndorsementFromRecord(${Number(id)})">
                    <i class="fa-solid fa-file-signature"></i> Generate Indorsement
                </button>` : ''}
                ${isCalendar ? `
                <button class="dsd-btn-print" onclick="ADS.printCalendarPreview(${Number(id)})">
                    <i class="fa-solid fa-print"></i> Print / PDF
                </button>` : ''}
                ${isTuition ? `
                <button class="dsd-btn-print" onclick="ADS.exportSubmittedTuitionWord(${Number(id)})">
                    <i class="fa-solid fa-file-word"></i> Export Word
                </button>` : ''}
            `;
        }

        /* Restore form values */
        const statusEl  = document.getElementById('adsDetailStatus');
        const remarksEl = document.getElementById('adsDetailRemarks');
        const msgEl     = document.getElementById('adsDetailMsg');
        if (statusEl)  statusEl.value  = seedStatus || 'Pending Review';
        if (remarksEl) remarksEl.value = record.remarks || '';
        if (msgEl && !preserveMsg) { msgEl.className = 'dsf-msg'; msgEl.textContent = ''; }

        if (isCalendar)  { loadCalendarPreviewHtml(id); loadCalendarSupportingDocsList(id); }
        if (isTuition)   { loadTuitionPreviewHtml(id); loadTuitionSupportingDocsList(id); }
        if (isInlinePdf) loadInlineFilePreview(fileUrl, fileName, rawFilePath);

        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function generateIndorsementFromRecord(id) {
        const record = allRecords.find((x) => Number(x.id) === Number(id));
        if (!record) return;
        if (typeof openIndorsementModal !== 'function') { alert('Indorsement generator is not loaded on this page.'); return; }

        const overlay = document.getElementById('adsDetailOverlay');
        if (overlay) overlay.classList.remove('open');
        document.body.style.overflow = '';
        detailRecordId = null;

        const typeMap  = { calendar: 'school_calendar', tuition: 'tuition_increase', permit: 'school_permit' };
        const prefill  = {
            schoolName: record.school_name || record.title || '',
            address:    record.school_address || '',
            sy:         record.school_year    || '',
            totalDays:  record.cal_days       || '',
            startDate:  record.cal_opening    || '',
            endDate:    record.cal_closing    || '',
            level:      record.cal_level      || '',
            checklistType: typeMap[String(record.type || '').toLowerCase()] || 'school_calendar',
            schoolId:        record.private_school_id || record.school_id || null,
            privateSchoolId: record.private_school_id || null,
        };
        setTimeout(() => openIndorsementModal(prefill), 120);
    }

    async function approveEditRequest(id) {
        if (!id) return;
        if (!confirm('Approve this edit request? The school will be able to edit and re-submit this document.')) return;

        const btn = document.getElementById('adsApproveEditBtn');
        const origHTML = btn ? btn.innerHTML : null;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Approving…'; }

        try {
            const res  = await fetch(apiUrl('/documents-submitted.php'), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'approve_edit', id: Number(id) }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message || 'Failed to approve edit request.');

            // Patch the in-memory record so getEditRequests() returns empty on re-render
            const rec = allRecords.find((x) => Number(x.id) === Number(id));
            if (rec) {
                const currentUserName = localStorage.getItem('full_name') || 'SDO Admin';
                if (!Array.isArray(rec.history)) rec.history = [];
                rec.history.push({ event: 'edit_approved', by: currentUserName, created_at: new Date().toISOString() });
            }

            // Refresh records from server then re-open modal showing clean state
            await fetchRecords();
            openDetailModal(Number(id), true);

        } catch (err) {
            alert(String(err.message || 'Could not approve the edit request. Please try again.'));
            if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
        }
    }

    function closeDetailModal(event) {
        if (event && event.target !== event.currentTarget) return;
        const overlay = document.getElementById('adsDetailOverlay');
        if (overlay) overlay.classList.remove('open');
        document.body.style.overflow = '';
        detailRecordId = null;
    }

    async function saveDetailStatus() {
        if (!detailRecordId) return;
        const statusEl  = document.getElementById('adsDetailStatus');
        const remarksEl = document.getElementById('adsDetailRemarks');
        const msgEl     = document.getElementById('adsDetailMsg');
        const saveBtn   = document.getElementById('adsDetailSaveBtn');
        const status    = (statusEl?.value  || '').trim();
        const remarks   = (remarksEl?.value || '').trim();

        if (!status) {
            if (msgEl) { msgEl.textContent = 'Please select a status.'; msgEl.className = 'dsf-msg error'; }
            return;
        }

        if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
        if (msgEl)   { msgEl.textContent = ''; msgEl.className = 'dsf-msg'; }

        // Determine which IDs to update — for permits, update the whole batch
        const record     = allRecords.find((x) => Number(x.id) === Number(detailRecordId));
        const isPermit   = record && String(record.type || '').toLowerCase() === 'permit';
        const idsToUpdate = isPermit
            ? getBatchSiblings(record).map(r => Number(r.id))
            : [detailRecordId];

        try {
            // Fire updates sequentially (batch could be 2-5 rows; avoid race conditions)
            for (const id of idsToUpdate) {
                const res  = await fetch(apiUrl('/documents-submitted.php'), {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'update', id, status, remarks }),
                });
                const json = await res.json();
                if (!res.ok || !json.success) throw new Error(json.message || 'Failed to update status.');
            }

            if (msgEl) {
                const note = idsToUpdate.length > 1 ? ` (${idsToUpdate.length} files updated)` : '';
                msgEl.textContent = `Status updated successfully.${note}`;
                msgEl.className = 'dsf-msg success';
            }
            await fetchRecords();
            openDetailModal(detailRecordId, true);
        } catch (err) {
            if (msgEl) { msgEl.textContent = String(err.message || 'Could not save changes.'); msgEl.className = 'dsf-msg error'; }
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Status'; }
        }
    }

    async function loadCalendarPreviewHtml(id, opts = {}) {
        const host     = document.getElementById('adsCalendarPreviewHost');
        if (!host) return;
        const silent   = !!opts.silent;
        const targetId = String(id || '').trim();
        if (!targetId) return;
        if (host.dataset.calendarId === targetId && host.dataset.loaded === '1') return;

        ensureCalendarPreviewStyles();
        host.dataset.calendarId = targetId;
        host.dataset.loaded     = '0';
        host.innerHTML = `
            <div class="dsd-loading-state">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:24px;"></i>
                <p>Loading calendar preview…</p>
            </div>`;

        try {
            const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=json&preview=1`);
            let payload = null;

            try {
                const res = await fetch(url, { credentials: 'include' });
                if (res.ok) {
                    const ct = res.headers.get('Content-Type') || '';
                    if (ct.includes('application/json')) payload = await res.json();
                }
            } catch (_) { /* fall through to summary fallback */ }

            if (!payload || typeof payload !== 'object') {
                const record = allRecords.find(x => Number(x.id) === Number(id));
                if (!record) throw new Error('Record not found.');

                payload = {
                    form: {
                        f_school:      record.school_name || record.title || '',
                        f_dept:        record.cal_level   || 'Elementary School',
                        f_sid:         '',
                        f_sy1:         (record.school_year || '2026-2027').split('-')[0]?.trim() || '2026',
                        f_sy2:         (record.school_year || '2026-2027').split('-')[1]?.trim() || '2027',
                        f_opening:     record.cal_opening  || '',
                        f_closing:     record.cal_closing  || '',
                        f_chk_address: record.school_address || '',
                    },
                    savedMarks: {}, savedRemarks: {},
                    legends: {
                        holiday:  { label: 'Holiday',        color: '#dc2626', symbol: 'X',  includeInSchoolDays: false },
                        activity: { label: 'School Activity', color: '#374151', symbol: '□',  includeInSchoolDays: true  },
                        exam:     { label: 'Exam / Quarter',  color: '#854d0e', symbol: '△',  includeInSchoolDays: true  },
                    },
                };

                host.innerHTML = `
                    <div class="dsd-preview-notice">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        Limited preview — calendar marks not available due to a connection issue.
                        <a href="${url}" target="_blank" rel="noopener">Open full version</a>
                    </div>
                    <div id="adsCalendarPreviewInner"></div>`;

                const inner = document.getElementById('adsCalendarPreviewInner');
                if (inner) inner.innerHTML = _buildAdminCalendarPreview(payload);
                host.dataset.loaded = '1';
                return;
            }

            host.innerHTML = _buildAdminCalendarPreview(payload);
            host.dataset.loaded = '1';

        } catch (err) {
            if (!silent) {
                host.innerHTML = `
                    <div class="ads-fp-unsupported">
                        <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;"></i>
                        <p>Could not load calendar preview: ${esc(err.message || 'Unknown error')}</p>
                    </div>`;
            }
        }
    }

    /* _populateTuitionSidebarDetails — fills the left "Details" panel with
       the official-form identifying fields (Division, School ID, Gov.
       Recognition No., School Year Current/Proposed, Principal, Contact
       No., Fee Increase status) once the linked tuition document loads.
       These used to be duplicated inside the document preview itself; the
       preview now mirrors the school portal's actual builder output 1:1
       (which only repeats Name of School / Location per page), so this is
       their one home — the admin-facing sidebar. */
    function _populateTuitionSidebarDetails(payload, id) {
        const wrap = document.getElementById('adsTuitionExtraDetails');
        if (!wrap) return;

        const form = (payload.form && typeof payload.form === 'object') ? payload.form : {};
        const isIncrease = String(payload.mode || 'increase') !== 'no_increase';
        const pct = Number(form.increase_pct || 0);

        const modeBadge = isIncrease
            ? `<span class="ads-tf-mode-badge ads-tf-mode-increase"><i class="fa-solid fa-arrow-trend-up"></i> Fee Increase (${esc(String(pct))}%)</span>`
            : `<span class="ads-tf-mode-badge ads-tf-mode-retain"><i class="fa-solid fa-lock"></i> Retaining Existing Fees</span>`;

        const rows = [
            ['Division', form.division],
            ['School ID', form.school_id],
            ['Gov. Recognition No.', form.gov_recog],
            ['School Year (Current)', form.current_sy],
            ['School Year (Proposed)', form.proposed_sy],
            ['Principal', form.principal],
            ['Contact No.', form.principal_contact],
        ].map(([label, value]) => `
            <div class="dsd-field-row"><div class="dsd-field-label">${esc(label)}</div><div class="dsd-field-value">${esc(value || '—')}</div></div>
        `).join('');

        wrap.innerHTML = `
            <div class="dsd-field-row"><div class="dsd-field-label">Fee Status</div><div class="dsd-field-value">${modeBadge}</div></div>
            ${rows}
        `;
    }

    /* ── Supporting Documents (tuition) ──────────────────────────────────
       Admin-facing list of the files a school actually uploaded through
       the "Supporting Documents Checklist" in the tuition builder
       (school-portal-tuition.js: uploadSupportingDocument()). These were
       previously invisible to admins entirely — the checklist state saved
       in payload_json.supporting_docs only tracks checkbox booleans, not
       the files themselves, and the school-portal API's own download
       endpoint is scoped to the uploading school's account. This calls
       the new admin-scoped list/download actions in documents-submitted.php
       instead. */
    function _formatUploadSize(bytes) {
        const n = Number(bytes || 0);
        if (!n) return '';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function _renderTuitionSupportingDocsList(id, items) {
        const host = document.getElementById('adsTuitionSupportingDocs');
        if (!host) return;

        if (!items || !items.length) {
            host.innerHTML = `<div class="ads-tf-supp-empty">No supporting documents were uploaded with this submission.</div>`;
            return;
        }

        host.innerHTML = items.map(doc => `
            <div class="ads-tf-supp-item">
                <div class="ads-tf-supp-main">
                    <i class="fa-solid ${esc(doc.icon || 'fa-file')}"></i>
                    <div class="ads-tf-supp-text">
                        <span class="ads-tf-supp-label">${esc(doc.label || doc.slug)}</span>
                        <span class="ads-tf-supp-filename">${esc(doc.original_filename || '')}${doc.file_size ? ` · ${esc(_formatUploadSize(doc.file_size))}` : ''}</span>
                    </div>
                </div>
                <button type="button" class="ads-tf-supp-view-btn" onclick="ADS.openSupportingUpload(${Number(id)}, '${escJsSingle(doc.slug)}')">
                    <i class="fa-solid fa-eye"></i> View
                </button>
            </div>
        `).join('');
    }

    async function loadTuitionSupportingDocsList(id) {
        const host = document.getElementById('adsTuitionSupportingDocs');
        if (!host) return;
        try {
            const url = apiUrl(`/documents-submitted.php?action=list_supporting_uploads&id=${encodeURIComponent(id)}`);
            const res = await fetch(url, { credentials: 'include' });
            const payload = await res.json();
            if (!payload || payload.success === false) {
                throw new Error(payload?.message || 'Could not load supporting documents.');
            }
            _renderTuitionSupportingDocsList(id, payload.items || []);
        } catch (err) {
            host.innerHTML = `<div class="ads-tf-supp-empty">Could not load supporting documents: ${esc(err.message || 'Unknown error')}</div>`;
        }
    }

    function _renderCalendarSupportingDocsList(id, items) {
        const host = document.getElementById('adsCalendarSupportingDocs');
        if (!host) return;

        if (!items || !items.length) {
            host.innerHTML = `<div class="ads-tf-supp-empty">No supporting documents were uploaded with this submission.</div>`;
            return;
        }

        host.innerHTML = items.map(doc => `
            <div class="ads-tf-supp-item">
                <div class="ads-tf-supp-main">
                    <i class="fa-solid ${esc(doc.icon || 'fa-file')}"></i>
                    <div class="ads-tf-supp-text">
                        <span class="ads-tf-supp-label">${esc(doc.label || doc.slug)}</span>
                        <span class="ads-tf-supp-filename">${esc(doc.original_filename || '')}${doc.file_size ? ` · ${esc(_formatUploadSize(doc.file_size))}` : ''}</span>
                    </div>
                </div>
                <button type="button" class="ads-tf-supp-view-btn" onclick="ADS.openSupportingUpload(${Number(id)}, '${escJsSingle(doc.slug)}')">
                    <i class="fa-solid fa-eye"></i> View
                </button>
            </div>
        `).join('');
    }

    async function loadCalendarSupportingDocsList(id) {
        const host = document.getElementById('adsCalendarSupportingDocs');
        if (!host) return;
        try {
            const url = apiUrl(`/documents-submitted.php?action=list_supporting_uploads&id=${encodeURIComponent(id)}`);
            const res = await fetch(url, { credentials: 'include' });
            const payload = await res.json();
            if (!payload || payload.success === false) {
                throw new Error(payload?.message || 'Could not load supporting documents.');
            }
            _renderCalendarSupportingDocsList(id, payload.items || []);
        } catch (err) {
            host.innerHTML = `<div class="ads-tf-supp-empty">Could not load supporting documents: ${esc(err.message || 'Unknown error')}</div>`;
        }
    }

    function openSupportingUpload(id, slug) {
        if (!id || !slug) return;
        const url = apiUrl(`/documents-submitted.php?action=download_supporting_upload&id=${encodeURIComponent(id)}&slug=${encodeURIComponent(slug)}`);
        window.open(url, '_blank', 'noopener');
    }

    async function loadTuitionPreviewHtml(id, opts = {}) {
        const host     = document.getElementById('adsTuitionPreviewHost');
        if (!host) return;
        const silent   = !!opts.silent;
        const targetId = String(id || '').trim();
        if (!targetId) return;
        if (host.dataset.tuitionId === targetId && host.dataset.loaded === '1') return;

        ensureTuitionPreviewStyles();
        host.dataset.tuitionId = targetId;
        host.dataset.loaded    = '0';
        host.innerHTML = `
            <div class="dsd-loading-state">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:24px;"></i>
                <p>Loading tuition fee preview…</p>
            </div>`;

        try {
            const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=json&preview=1`);
            const res = await fetch(url, { credentials: 'include' });
            const ct  = res.headers.get('Content-Type') || '';

            if (!res.ok || !ct.includes('application/json')) {
                throw new Error('Tuition fee document not found for this submission.');
            }

            const payload = await res.json();
            if (!payload || typeof payload !== 'object' || payload.success === false) {
                throw new Error(payload?.message || 'Tuition fee document not found for this submission.');
            }

            host.innerHTML = _buildAdminTuitionPreview(payload, id);
            host.dataset.loaded = '1';
            _populateTuitionSidebarDetails(payload, id);

        } catch (err) {
            // Fallback: render whatever summary fields actionList already gave us
            // (school name/address) so the preview isn't completely empty even
            // when the linked school_tuition_documents row can't be resolved.
            const record = allRecords.find(x => Number(x.id) === Number(id));
            if (!silent && record) {
                host.innerHTML = `
                    <div class="dsd-preview-notice">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        Limited preview — fee breakdown not available: ${esc(err.message || 'Unknown error')}
                    </div>
                    <div class="dsd-section">
                        <div class="dsd-field-row"><div class="dsd-field-label">School</div><div class="dsd-field-value">${esc(record.school_name || record.title || '—')}</div></div>
                        <div class="dsd-field-row"><div class="dsd-field-label">School Year</div><div class="dsd-field-value">${esc(record.school_year || '—')}</div></div>
                    </div>`;
            } else if (!silent) {
                host.innerHTML = `
                    <div class="ads-fp-unsupported">
                        <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;"></i>
                        <p>Could not load tuition fee preview: ${esc(err.message || 'Unknown error')}</p>
                    </div>`;
            }
        }
    }

    /* Maps each built-in fee row's label to its official form section number
       (1 = TUITION FEE, 2 = MISCELLANEOUS FEES, 3 = OTHER FEES), mirroring
       the field groupings in DS_TUITION_FIELDS / KINDER_FIELDS / ELEM_FIELDS /
       JHS_FIELDS / SHS_FIELDS on the server and in school-portal-tuition.js.
       Any row whose label isn't found here is a school-added custom fee —
       those default to section 3, matching injectCustomFeeRow()'s own
       default ('other') in the school portal builder. */
    const TF_SECTION_BY_LABEL = {
        kinder: {
            'Tuition Fee': 1,
            'ID / Insurance': 2, 'Insurance': 2, 'Handbook Fee': 2, 'Water Fee': 2,
            'Instructional & Test Mat.': 2, 'Medical Supplies': 2,
            'Registration Fee': 3, 'Books': 3, 'Development Fee': 3,
        },
        elem: {
            'Tuition Fee': 1,
            'ID Card': 2, 'Insurance': 2, 'Handbook Fee': 2, 'Laboratory Fee': 2, 'Water Fee': 2,
            'Instructional & Test Mat.': 2, 'Medical Supplies': 2,
            'Registration Fee': 3, 'Books': 3, 'PACES (1st Sem)': 3, 'PACES (2nd Sem)': 3,
        },
        jhs: {
            'Tuition Fee': 1,
            'ID Card': 2, 'Insurance': 2, 'Handbook Fee': 2, 'Computer Laboratory Fee': 2, 'Water Fee': 2,
            'Instructional & Test Mat.': 2, 'Medical Supplies': 2,
            'Registration Fee': 3, 'Books': 3, 'PACES (1st Sem)': 3, 'PACES (2nd Sem)': 3,
        },
        shs: {
            'Tuition Fee': 1, 'Tuition Fee (Grade 11)': 1, 'Tuition Fee (Grade 12)': 1,
            'ID Card': 2, 'Insurance': 2, 'Examination Fee': 2, 'Sports Development / Athletics': 2,
            'Student ID Card (SID)': 2, 'Handbook Fee': 2, 'Computer Laboratory Fee': 2, 'Water Fee': 2,
            'Instructional & Test Mat.': 2, 'Medical Supplies': 2,
            'Registration Fee': 3, 'Books': 3, 'Development Fee': 3,
        },
    };
    const TF_LEVEL_FORM_NAME = { kinder: 'KINDERGARTEN', elem: 'ELEMENTARY', jhs: 'JUNIOR HIGH SCHOOL', shs: 'SENIOR HIGH SCHOOL' };

    /* Shared bucket helper — same logic as the local bucketRows() closure
       inside _buildAdminTuitionPreview, hoisted to module scope so the
       Word export (exportSubmittedTuitionWord) can reuse the exact same
       section grouping without duplicating the mapping logic. */
    function _tfBucketsFor(key, lvl) {
        const sectionMap = TF_SECTION_BY_LABEL[key] || {};
        const rows = (lvl && lvl.rows) || [];
        const buckets = { 1: [], 2: [], 3: [] };
        rows.forEach(r => {
            const section = sectionMap[r.label] || 3;
            buckets[section].push(r);
        });
        return buckets;
    }

    /* Official DepEd letterhead block — identical markup/classes to the
       .tf-official-header used in school-portal-tuition.html, so it picks
       up the real form styling from the stylesheet loaded by
       ensureTuitionPreviewStyles(). */
    function _tfOfficialHeader() {
        return `
            <table class="tf-official-header">
                <tr>
                    <td class="tf-oh-seal-cell">
                        <img class="tf-official-seal" src="images/republic-of-the-philippines-doe.jpg" alt="Republic of the Philippines Seal" />
                    </td>
                    <td class="tf-oh-center-cell">
                        <div class="tf-oh-l2">DEPARTMENT OF EDUCATION REGION III</div>
                        <div class="tf-oh-l3">Matalino St. D.M. Government Center, Maimpis, City of San Fernando (P)</div>
                    </td>
                    <td class="tf-oh-right-seal-cell">
                        <img class="tf-official-seal" src="images/kagawaran-ng-edukasyon-logo.png" alt="DepEd Seal" />
                    </td>
                    <td class="tf-oh-formno-cell">
                        <div class="tf-oh-formno-top">DepEd3-QAD-NSF-001</div>
                        <div class="tf-oh-formno-bottom">
                            <div class="tf-oh-version-cell">Version No.<span class="tf-oh-version-num">2</span></div>
                            <div class="tf-oh-revno-cell">Rev. No<span class="tf-oh-revno-num">01</span></div>
                        </div>
                    </td>
                </tr>
            </table>`;
    }

    /* Reproduces the builder's full signatory block exactly (see
       pvBreakKinder/pvCompKinder etc. in school-portal-tuition.html):
       "Prepared by" (principal, centered) + "Processed and Evaluated by"
       (SDO EPS) + "Validated by" (RO QAD) + the "NOTED pursuant to D.O.
       No. 12, s. 1997" block pinned to the bottom of the page. The admin
       preview previously only rendered "Prepared by", which is why real
       submissions appeared to be missing three signatories. */
    function _tfSignatoryBlock(form) {
        const principal          = form.principal || '';
        const principalPosition  = form.principal_position || 'School Principal';
        const reviewedBy         = form.reviewed_by || '';
        const reviewedByPosition = form.reviewed_by_position || 'SDO, EPS In Charge';
        const validatedBy        = form.validated_by || '';
        const validatedByPosition= form.validated_by_position || 'EPS,QAD DepEd RO 3';
        const notedBy            = form.noted_by || 'MAY B. ECLAR, PhD, CESO III';
        const notedByPosition    = form.noted_by_position || 'Regional Director';

        if (!principal && !reviewedBy && !validatedBy) return '';

        return `
            <div class="tf-comp-sig-prepared">
                <div style="font-weight: 800;">Prepared by:</div>
                <div class="tf-comp-sig-line">${esc(principal)}</div>
                <div>${esc(principalPosition)}</div>
            </div>
            <div class="tf-comp-sig-block">
                <div style="font-weight: 800;">Processed and Evaluated by:</div>
                <div class="tf-comp-sig-line">${esc(reviewedBy)}</div>
                <div>${esc(reviewedByPosition)}</div>
            </div>
            <div class="tf-comp-sig-block">
                <div style="font-weight: 800;">Validated by:</div>
                <div class="tf-comp-sig-line">${esc(validatedBy)}</div>
                <div>${esc(validatedByPosition)}</div>
            </div>
            <div class="tf-comp-noted-block">
                <div class="tf-comp-noted" style="text-align:center; font-weight: 800;">NOTED pursuant to D.O. No. 12, s. 1997</div>
                <div class="tf-comp-noted-name" style="text-align:center;">${esc(notedBy)}</div>
                <div class="tf-comp-noted-role" style="text-align:center;">${esc(notedByPosition)}</div>
            </div>`;
    }

    /* _buildAdminTuitionPreview — renders the submission as the actual
       official document (DepEd letterhead + "Breakdown of School Fees"
       table per grade level, Current/Proposed/Increase columns added so
       admins reviewing a fee-increase request can see the delta at a
       glance) instead of a flat label/value details list. Reuses the same
       .paper / .tf-official-header / .tf-bd-* classes as the school's own
       builder preview (loaded via ensureTuitionPreviewStyles()) so it's a
       faithful, consistent rendering of the same document. */
    /* ── Comparative Schedule row math ──────────────────────────────────
       Given a level's bucketed rows (1=tuition, 2=misc, 3=other) and the
       level object, computes the Current/Proposed/Increase pair for the
       Tuition Fee column and for the combined Misc+Other Fees column —
       exactly what the builder's own compRow() / pv-tf- / pv-mf-
       selectors resolve to, and what buildComparativePage() in the
       Word export sums per grade row. */
    function _tfCalcCompRow(buckets) {
        const tuitionRow = buckets[1][0] || { current: 0, proposed: 0, increase: 0 };
        const mfRows = [...buckets[2], ...buckets[3]];
        const mfCurr = mfRows.reduce((s, r) => s + Number(r.current  || 0), 0);
        const mfProp = mfRows.reduce((s, r) => s + Number(r.proposed || 0), 0);
        const tfCurr = Number(tuitionRow.current  || 0);
        const tfProp = Number(tuitionRow.proposed || 0);
        const tfInc  = Number(tuitionRow.increase != null ? tuitionRow.increase : (tfProp - tfCurr));
        return { tfCurr, tfProp, tfInc, mfCurr, mfProp, mfInc: mfProp - mfCurr };
    }

    /* ── Comparative Schedule page — ONE page per level ─────────────────
       Mirrors the builder's separate pvCompKinder / pvCompElem / pvCompJHS
       pages: each level gets its own .paper.tf-comp-page with a
       .tf-comp-level-label heading and one row per grade (Kindergarten
       has a single row; Elementary repeats the same level totals across
       Grade 1–6; JHS repeats them across Grade 7–10 — the school portal
       only collects one fee schedule per level, not per individual grade,
       so the builder itself repeats the same figures on every grade row;
       this mirrors that faithfully rather than inventing per-grade data
       that was never collected).
       The 150px bottom padding on the inner wrapper is copied from the
       builder verbatim — .tf-comp-noted-block is position:absolute;
       bottom:26px against the .paper, so without this reserved space the
       signature block can crowd or overlap the pinned "NOTED pursuant..."
       footer. */
    function _tfCompPage(levelLabel, gradeLabels, row, form, schoolName, address, proposedSy) {
        const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const pct = (inc, base) => base ? `${(inc / base * 100).toFixed(2)}%` : '0.00%';
        const bodyRows = gradeLabels.map(label => `
            <tr>
                <td>${esc(label)}</td>
                <td>${fmt(row.tfCurr)}</td>
                <td>${fmt(row.tfProp)}</td>
                <td>${fmt(row.tfInc)}</td>
                <td>${pct(row.tfInc, row.tfCurr)}</td>
                <td>${fmt(row.mfCurr)}</td>
                <td>${fmt(row.mfProp)}</td>
                <td>${fmt(row.mfInc)}</td>
                <td>${pct(row.mfInc, row.mfCurr)}</td>
            </tr>`).join('');

        return `
            <div class="paper tf-comp-page">
                ${_tfOfficialHeader()}
                <div style="padding:12px 20px 150px;">
                    <div class="tf-comp-title">Comparative Schedule of Tuition, Miscellaneous &amp; Other Fees</div>
                    <div class="tf-comp-sy">for S.Y. ${esc(String(proposedSy))}</div>
                    <div class="tf-comp-fields" style="margin-top:10px;">
                        <div class="tf-comp-row"><span class="tf-comp-label">Name of School</span><span>:</span><span class="tf-comp-line">${esc(schoolName)}</span></div>
                        <div class="tf-comp-row"><span class="tf-comp-label">Location</span><span>:</span><span class="tf-comp-line">${esc(address)}</span></div>
                    </div>
                    <div class="tf-comp-level-label">${esc(levelLabel)}</div>
                    <table class="tf-preview-table tf-comp-table">
                        <thead>
                            <tr>
                                <th rowspan="2">LEVEL</th>
                                <th colspan="4">TUITION FEES</th>
                                <th colspan="4">MISCELLANEOUS &amp; OTHER FEES</th>
                            </tr>
                            <tr>
                                <th>Approved TF<br>SY: ${esc(form.current_sy || '—')}</th>
                                <th>Proposed TF<br>SY: ${esc(String(proposedSy))}</th>
                                <th>Amount of Increase</th>
                                <th>% Increase</th>
                                <th>Approved MF<br>SY: ${esc(form.current_sy || '—')}</th>
                                <th>Proposed MF<br>SY: ${esc(String(proposedSy))}</th>
                                <th>Amount of Increase</th>
                                <th>% Increase</th>
                            </tr>
                        </thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                    ${_tfSignatoryBlock(form)}
                </div>
            </div>`;
    }

    /* ── SHS "Breakdown of School Fees" page — TWO value columns ────────
       Unlike Kinder/Elem/JHS (one FEES column), the builder's pvBreakSHS
       has a two-row thead ("SENIOR HIGH SCHOOL" spanning Grade 11 | Grade
       12) because SHS tuition is captured per grade (s11_tuition /
       s12_tuition) while Misc/Other fees are a single shared schedule
       for both grades — see dsTuitionFields()['shs'] on the server.
       Reproduces that exact two-column layout instead of the generic
       single-column table used for the other levels. */
    function _tfShsBreakdownPage(form, buckets, schoolName, address) {
        const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const g11 = buckets[1].find(r => r.label === 'Tuition Fee (Grade 11)') || buckets[1].find(r => r.label === 'Tuition Fee') || { proposed: 0 };
        const g12 = buckets[1].find(r => r.label === 'Tuition Fee (Grade 12)') || buckets[1].find(r => r.label === 'Tuition Fee') || { proposed: 0 };
        const miscRows  = buckets[2];
        const otherRows = buckets[3];
        const miscTotal  = miscRows.reduce((s, r) => s + Number(r.proposed || 0), 0);
        const otherTotal = otherRows.reduce((s, r) => s + Number(r.proposed || 0), 0);
        const g11Total = Number(g11.proposed || 0) + miscTotal + otherTotal;
        const g12Total = Number(g12.proposed || 0) + miscTotal + otherTotal;

        /* Misc/Other rows are shared between both grades, so the same
           proposed amount is echoed into both value columns. */
        const sharedRow = (r) => `<tr data-field=""><td></td><td class="tf-bd-fee tf-bd-item">${esc(r.label)}</td><td>${fmt(r.proposed)}</td><td>${fmt(r.proposed)}</td></tr>`;
        const miscHtml = miscRows.length
            ? `<tr data-section-header="s_misc"><td class="tf-bd-roman">II.</td><td class="tf-bd-fee tf-bd-section">MISCELLANEOUS FEES</td><td></td><td></td></tr>` + miscRows.map(sharedRow).join('')
            : '';
        const otherHtml = otherRows.length
            ? `<tr data-section-header="s_other"><td class="tf-bd-roman">III.</td><td class="tf-bd-fee tf-bd-section">OTHER FEES</td><td></td><td></td></tr>` + otherRows.map(sharedRow).join('')
            : '';
        const hasAny = buckets[1].length || miscRows.length || otherRows.length;
        const bodyRows = hasAny
            ? (`<tr><td class="tf-bd-roman">I.</td><td class="tf-bd-fee">TUITION FEE</td><td>${fmt(g11.proposed)}</td><td>${fmt(g12.proposed)}</td></tr>` + miscHtml + otherHtml)
            : `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:10px;">No fees entered for this level.</td></tr>`;

        return `
            <div class="paper tf-breakdown-page">
                ${_tfOfficialHeader()}
                <div class="tf-bd-body">
                    <div class="tf-comp-fields" style="margin-top:6px;">
                        <div class="tf-comp-row"><span class="tf-comp-label">Name of School</span><span>:</span><span class="tf-comp-line">${esc(schoolName)}</span></div>
                        <div class="tf-comp-row"><span class="tf-comp-label">Location</span><span>:</span><span class="tf-comp-line">${esc(address)}</span></div>
                    </div>
                    <div class="tf-bd-title">BREAKDOWN OF SCHOOL FEES</div>
                    <div class="tf-bd-part">Part I</div>
                    <table class="tf-bd-table">
                        <thead>
                            <tr>
                                <th colspan="2" rowspan="2">FEES</th>
                                <th colspan="2">SENIOR HIGH SCHOOL</th>
                            </tr>
                            <tr>
                                <th>Grade 11</th>
                                <th>Grade 12</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${bodyRows}
                            <tr class="tf-bd-total">
                                <td>&nbsp;</td>
                                <td>TOTAL</td>
                                <td>${fmt(g11Total)}</td>
                                <td>${fmt(g12Total)}</td>
                            </tr>
                        </tbody>
                    </table>
                    ${_tfSignatoryBlock(form)}
                </div>
            </div>`;
    }

    /* ── SHS "Certification of School Fees" page (Grade 11 / Grade 12) ──
       SHS does NOT get a Comparative Schedule page in the real builder —
       it gets this separate DepEd SHS Voucher Program certification form
       instead (.cert-box / .cert-section / .cert-row — a plain-bordered
       box, not the grid-style .tf-preview-table used elsewhere), matching
       buildSHSCertPage() in the Word export exactly. Previously the admin
       preview had no equivalent at all and just added SHS as another row
       to the generic Comparative Schedule table.
       Track/Strand/School ID and the SDS ("NOTED pursuant to DECS Order
       #12") signatory fields aren't part of TF_SECTION_BY_LABEL/the fee
       payload — best-effort field names are used below with the same
       fallback defaults as the builder/Word export; verify against the
       actual saved keys in school-portal-tuition.js if they render blank. */
    function _tfShsCertPage(form, buckets, grade, schoolName, address, proposedSy) {
        const fmtP = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const tuitionRow = buckets[1].find(r => r.label === `Tuition Fee (Grade ${grade})`) || buckets[1].find(r => r.label === 'Tuition Fee') || { proposed: 0 };
        const miscRows  = buckets[2];
        const otherRows = buckets[3];
        const miscTotal  = miscRows.reduce((s, r) => s + Number(r.proposed || 0), 0);
        const otherTotal = otherRows.reduce((s, r) => s + Number(r.proposed || 0), 0);
        const grandTotal = Number(tuitionRow.proposed || 0) + miscTotal + otherTotal;

        const row = (label, value, cls = '') => `<div class="cert-row ${cls}"><span>${esc(label)}</span><span>${value === null ? '' : esc(value)}</span></div>`;
        const miscHtml  = miscRows.map(r => row(r.label, fmtP(r.proposed), 'cert-indent')).join('');
        const otherHtml = otherRows.map(r => row(r.label, fmtP(r.proposed), 'cert-indent')).join('');

        const principal         = form.principal || '';
        const principalPosition = form.principal_position || 'School Principal';
        const reviewedBy        = form.reviewed_by || '';
        const sdsName           = form.shs_noted_by          || 'ROWENA T. QUIAMBAO, CESO VI';
        const sdsPosition       = form.shs_noted_by_position || 'Schools Division Superintendent';
        const sdsOffice         = form.shs_noted_by_office   || 'Office of the Schools Division Superintendent';

        return `
            <div class="paper cert-box">
                <div class="cert-title">Certification of School Fees</div>
                <div class="cert-subtitle">For School Year ${esc(String(proposedSy))}</div>
                <div class="cert-hdr-block">
                    <div>School ID: <span class="underline-field">${esc(form.school_id || '—')}</span></div>
                    <div>School Name: <span class="underline-field wide">${esc(schoolName)}</span></div>
                    <div>School Address: <span class="underline-field wide">${esc(address)}</span></div>
                    <div class="cert-hdr-two-col">
                        <div>Track: <span class="underline-field">${esc(form.shs_track || '—')}</span></div>
                        <div>Strand: <span class="underline-field">${esc(form.shs_strand || '—')}</span></div>
                    </div>
                    <div>Grade Level: <span class="cert-grade-val">${esc(String(grade))}</span></div>
                </div>
                <div class="cert-section">
                    <div class="cert-row cert-row-roman"><span>I.&nbsp;&nbsp;Tuition Fee</span><span></span></div>
                    <div class="cert-row"><span class="cert-amt-label">Amount</span><span class="cert-amt-label"></span></div>
                    <div class="cert-row"><span></span><span>${fmtP(tuitionRow.proposed)}</span></div>
                </div>
                <div class="cert-section">
                    <div class="cert-row cert-row-roman"><span>II.&nbsp;&nbsp;Miscellaneous Fees</span><span></span></div>
                    ${miscHtml}
                    <div class="cert-row cert-total"><span>Total Miscellaneous Fees</span><span>${fmtP(miscTotal)}</span></div>
                </div>
                <div class="cert-section">
                    <div class="cert-row cert-row-roman"><span>III.&nbsp;Other Fees</span><span></span></div>
                    ${otherHtml}
                    <div class="cert-row"><span class="cert-amt-label"></span><span class="cert-amt-label">Amount</span></div>
                    <div class="cert-row cert-total"><span>Total Other Fees</span><span>${fmtP(otherTotal)}</span></div>
                </div>
                <div class="cert-section">
                    <div class="cert-row cert-grand"><span>IV.&nbsp;&nbsp;Total Tuition and Other School Fees (Sum of Part I, Part II, and Part III)</span><span></span></div>
                    <div class="cert-row cert-grand"><span class="cert-amt-label">Amount</span><span></span></div>
                    <div class="cert-row cert-grand"><span></span><span>${fmtP(grandTotal)}</span></div>
                </div>
                <div class="cert-section">
                    <div class="cert-row-header">V.&nbsp; Please Indicate any special concessions given to SHS Voucher Program Beneficiaries (e.g. Tuition waiver, discounts, any forms of financial assistance):</div>
                    <div style="font-style:italic;color:#6b7280;">None indicated.</div>
                </div>
                <div class="cert-statement">
                    I certify, under the penalties of perjury, that the above information contained herein is true and correct and is in accordance with the SHS VP Implementation Guidelines.
                </div>
                <div class="cert-sig-row">
                    <div class="cert-sig-note">Note: Signature over printed name</div>
                    <div class="cert-sig-block">
                        <div class="cert-sig-caption">Prepared by:</div>
                        <div class="cert-sig-spacer"></div>
                        <div class="cert-sig-name">${esc(principal)}</div>
                        <div class="cert-sig-title">${esc(principalPosition)}</div>
                    </div>
                </div>
                <div class="cert-section cert-section-bottom">
                    <div class="cert-sig-row cert-sig-row-bottom">
                        <div class="cert-sig-block cert-sig-block-left">
                            <div class="cert-reviewed-row">Reviewed by:</div>
                            <div class="cert-sig-spacer"></div>
                            <div class="cert-sig-name">${esc(reviewedBy)}</div>
                            <div class="cert-sig-title">Chief, SGOD / In-Charge of Private Schools</div>
                        </div>
                        <div class="cert-sig-block cert-sig-block-right">
                            <div class="cert-noted-label">NOTED pursuant to DECS Order #12, s.1997</div>
                            <div class="cert-sig-spacer"></div>
                            <div class="cert-sig-name">${esc(sdsName)}</div>
                            <div class="cert-sig-title">${esc(sdsPosition)}</div>
                            <div class="cert-sig-office">${esc(sdsOffice)}</div>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    /* _buildAdminTuitionPreview — renders the submission as the actual
       official document (DepEd letterhead + "Breakdown of School Fees"
       table per grade level, Current/Proposed/Increase columns added so
       admins reviewing a fee-increase request can see the delta at a
       glance) instead of a flat label/value details list. Reuses the same
       .paper / .tf-official-header / .tf-bd-* classes as the school's own
       builder preview (loaded via ensureTuitionPreviewStyles()) so it's a
       faithful, consistent rendering of the same document.
       Page order mirrors the builder/Word export exactly: Breakdown of
       Fees (one page per level, SHS gets its own two-column Grade 11/12
       table), then the Comparative Schedule (one page per level, SHS
       excluded), then the SHS Certification of Fees (Grade 11 and Grade
       12, if SHS is present). */
    function _buildAdminTuitionPreview(payload, id) {
        const form   = (payload.form && typeof payload.form === 'object') ? payload.form : {};
        const levels = (payload.computed_levels && typeof payload.computed_levels === 'object') ? payload.computed_levels : {};
        const record = allRecords.find(x => Number(x.id) === Number(id));

        const isIncrease = String(payload.mode || 'increase') !== 'no_increase';
        const pct = Number(form.increase_pct || 0);
        const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const schoolName  = form.school_name || record?.school_name || record?.title || '—';
        const address     = form.address || record?.school_address || '—';
        const proposedSy  = form.proposed_sy || record?.school_year || '—';

        const modeBadge = isIncrease
            ? `<span class="ads-tf-mode-badge ads-tf-mode-increase"><i class="fa-solid fa-arrow-trend-up"></i> Fee Increase (${esc(String(pct))}%)</span>`
            : `<span class="ads-tf-mode-badge ads-tf-mode-retain"><i class="fa-solid fa-lock"></i> Retaining Existing Fees</span>`;

        /* Admin-only status banner — the real school-portal builder has no
           separate cover page (each breakdown page repeats just Name of
           School / Location, same as below), so we don't fabricate one
           here either. The fee-increase % is admin-relevant context only,
           shown as a slim banner instead of a full extra page. The rest
           of the identifying fields (Division, School ID, Gov. Recognition
           No., School Year, Principal, Contact No.) now live in the
           sidebar's Details panel — see _populateTuitionSidebarDetails(). */
        const statusBanner = `<div class="ads-tf-status-banner">${modeBadge}</div>`;

        const levelOrder = ['kinder', 'elem', 'jhs', 'shs'];
        const levelDisplayLabel = { kinder: 'KINDERGARTEN', elem: 'ELEMENTARY', jhs: 'JUNIOR HIGH SCHOOL', shs: 'SENIOR HIGH SCHOOL' };
        let grandCurr = 0, grandProp = 0;

        const bucketRows = (key, lvl) => {
            const sectionMap = TF_SECTION_BY_LABEL[key] || {};
            const rows = lvl.rows || [];
            const buckets = { 1: [], 2: [], 3: [] };
            rows.forEach(r => {
                const section = sectionMap[r.label] || 3;
                buckets[section].push(r);
            });
            return buckets;
        };

        /* ── Breakdown of Fees (Part I) — one page per level ──────────── */
        const levelPages = levelOrder
            .filter(key => levels[key])
            .map(key => {
                const lvl = levels[key];
                grandCurr += Number(lvl.total_current  || 0);
                grandProp += Number(lvl.total_proposed || 0);
                const buckets = bucketRows(key, lvl);

                if (key === 'shs') {
                    return _tfShsBreakdownPage(form, buckets, schoolName, address);
                }

                const sectionMap = TF_SECTION_BY_LABEL[key] || {};
                const feeRow = (r, isCustom = false) => `
                    <tr data-field="">
                        <td></td>
                        <td class="tf-bd-fee tf-bd-item">${esc(r.label)}${isCustom ? ' <span class="ads-tf-custom-tag">custom</span>' : ''}</td>
                        <td>${fmt(r.proposed)}</td>
                    </tr>`;

                const tuitionFeeRow = buckets[1][0] || { current: 0, proposed: 0, increase: 0 };
                const tuitionRow = `<tr><td class="tf-bd-roman">I.</td><td class="tf-bd-fee">TUITION FEE</td><td>${fmt(tuitionFeeRow.proposed)}</td></tr>`;

                const miscRows = buckets[2].length
                    ? `<tr data-section-header="misc"><td class="tf-bd-roman">II.</td><td class="tf-bd-fee tf-bd-section">MISCELLANEOUS FEES</td><td></td></tr>`
                      + buckets[2].map(r => feeRow(r)).join('')
                    : '';

                const otherRows = buckets[3].length
                    ? `<tr data-section-header="other"><td class="tf-bd-roman">III.</td><td class="tf-bd-fee tf-bd-section">OTHER FEES</td><td></td></tr>`
                      + buckets[3].map(r => feeRow(r, r.label && !Object.prototype.hasOwnProperty.call(sectionMap, r.label))).join('')
                    : '';

                const bodyRows = lvl.rows && lvl.rows.length
                    ? (tuitionRow + miscRows + otherRows)
                    : `<tr><td colspan="3" style="text-align:center;color:#9ca3af;padding:10px;">No fees entered for this level.</td></tr>`;

                return `
                    <div class="paper tf-breakdown-page">
                        ${_tfOfficialHeader()}
                        <div class="tf-bd-body">
                            <div class="tf-comp-fields" style="margin-top:6px;">
                                <div class="tf-comp-row"><span class="tf-comp-label">Name of School</span><span>:</span><span class="tf-comp-line">${esc(schoolName)}</span></div>
                                <div class="tf-comp-row"><span class="tf-comp-label">Location</span><span>:</span><span class="tf-comp-line">${esc(address)}</span></div>
                            </div>
                            <div class="tf-bd-title">BREAKDOWN OF SCHOOL FEES</div>
                            <div class="tf-bd-part">Part I</div>
                            <table class="tf-bd-table">
                                <thead>
                                    <tr>
                                        <th colspan="2">FEES</th>
                                        <th>${esc(TF_LEVEL_FORM_NAME[key] || lvl.label.toUpperCase())}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${bodyRows}
                                    <tr class="tf-bd-total">
                                        <td>&nbsp;</td>
                                        <td>TOTAL</td>
                                        <td>${fmt(lvl.total_proposed)}</td>
                                    </tr>
                                </tbody>
                            </table>
                            ${_tfSignatoryBlock(form)}
                        </div>
                    </div>`;
            }).join('');

        /* ── Comparative Schedule — one page per level, SHS excluded ──── */
        const compPages = [];
        if (levels.kinder) {
            const row = _tfCalcCompRow(bucketRows('kinder', levels.kinder));
            compPages.push(_tfCompPage('Kindergarten', ['KINDERGARTEN'], row, form, schoolName, address, proposedSy));
        }
        if (levels.elem) {
            const row = _tfCalcCompRow(bucketRows('elem', levels.elem));
            compPages.push(_tfCompPage('Elementary', [1, 2, 3, 4, 5, 6].map(g => `Grade ${g}`), row, form, schoolName, address, proposedSy));
        }
        if (levels.jhs) {
            const row = _tfCalcCompRow(bucketRows('jhs', levels.jhs));
            compPages.push(_tfCompPage('Junior High School', [7, 8, 9, 10].map(g => `Grade ${g}`), row, form, schoolName, address, proposedSy));
        }

        /* ── SHS Certification of Fees — Grade 11 and Grade 12 ─────────
           Replaces SHS's old (incorrect) row in the Comparative Schedule
           table above — the real builder never puts SHS on that page. */
        let shsCertPages = '';
        if (levels.shs) {
            const buckets = bucketRows('shs', levels.shs);
            shsCertPages =
                _tfShsCertPage(form, buckets, 11, schoolName, address, proposedSy) +
                _tfShsCertPage(form, buckets, 12, schoolName, address, proposedSy);
        }

        const grandTotal = (levelPages || compPages.length || shsCertPages) ? `
            <div class="ads-tf-grand-total">
                <span>Grand Total (All Levels)</span>
                <span>₱${fmt(grandCurr)} → ₱${fmt(grandProp)}</span>
            </div>` : '';

        const noLevels = (!levelPages && !compPages.length && !shsCertPages)
            ? '<p style="text-align:center;color:#9ca3af;font-family:var(--ds-font, inherit);font-size:13px;">No grade levels were marked in this submission.</p>'
            : '';

        return `
            <div class="ads-tf-doc">
                ${statusBanner}
                ${levelPages}
                ${compPages.join('')}
                ${shsCertPages}
                ${grandTotal}
                ${noLevels}
            </div>`;
    }

    /* ═══════════════════════════════════════════════════════════════════
       exportSubmittedTuitionWord — client-side .docx export for a
       submitted Tuition Fee document, replacing the old "Print / PDF"
       action in the admin detail modal. Modeled directly on
       exportTuitionWord() in school-portal-tuition.html (same docx
       library, same DepEd letterhead/table structure), but sourced from
       the submission's saved payload (form fields + computed_levels)
       instead of live builder-form DOM values, since the admin is
       reviewing a already-submitted record rather than an open builder.
       Page content/order mirrors _buildAdminTuitionPreview() above
       exactly, so the exported Word file matches what the admin sees
       in the preview panel. ═══════════════════════════════════════════ */
    async function exportSubmittedTuitionWord(id) {
        if (typeof window.docx === 'undefined') {
            alert('Word export needs the docx library, which failed to load on this page.');
            return;
        }

        const {
            Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            WidthType, AlignmentType, BorderStyle, VerticalAlign,
            Header, Footer, ImageRun, TableLayoutType,
        } = window.docx;

        // ── Fetch the submission's saved tuition payload ───────────────
        let payload;
        try {
            const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=json&preview=1`);
            const res = await fetch(url, { credentials: 'include' });
            const ct  = res.headers.get('Content-Type') || '';
            if (!res.ok || !ct.includes('application/json')) throw new Error('Tuition fee document not found for this submission.');
            payload = await res.json();
            if (!payload || typeof payload !== 'object' || payload.success === false) {
                throw new Error(payload?.message || 'Tuition fee document not found for this submission.');
            }
        } catch (err) {
            alert('Word export failed: ' + (err.message || 'Unknown error'));
            return;
        }

        const form   = (payload.form && typeof payload.form === 'object') ? payload.form : {};
        const levels = (payload.computed_levels && typeof payload.computed_levels === 'object') ? payload.computed_levels : {};
        const record = allRecords.find(x => Number(x.id) === Number(id));

        // ── Supporting Documents: fetch the real checklist state ────────
        // Mirrors renderSupportingDocsListInView()/markSupportingDocsInView()
        // in school-portal-tuition-submitted.html, so this export matches
        // that read-only view — the DB-driven item catalog (labels can be
        // edited by admins in school_supporting_documents) with genuine
        // checkmarks — instead of the old 5-item hardcoded list with empty
        // boxes that never reflected what was actually submitted.
        // sd_copies is always auto-fulfilled: it's the Comparative Schedule /
        // Breakdown of Fees copies this builder's own export produces, so
        // it's never something the school uploads or ticks separately.
        const SD_HARDCODED_ITEM = {
            id: 'sd_copies',
            label: `Three (3) copies per offering/s of the Comparative Schedule of Tuition, Miscellaneous & Other Fees / Breakdown of School Fees for SY ${form.proposed_sy || record?.school_year || '________'} in one (1) folder`,
        };
        const SD_AUTO_FULFILLED_IDS = ['sd_copies'];
        // Same fallback list as TF_SUPPORTING_DOCS_FALLBACK in
        // school-portal-tuition.js — used only if the DB catalog fetch
        // fails or comes back empty, so a down/unmigrated table doesn't
        // leave the export showing just the one auto-fulfilled row.
        const SD_FALLBACK_ITEMS = [
            { id: 'sd_minutes',   label: 'Minutes of consultation with Student Government and parents' },
            { id: 'sd_alloc',     label: 'Notarized Allocation Program of Expenditures' },
            { id: 'sd_financial', label: 'CPA-certified Financial Statement' },
            { id: 'sd_sec',       label: 'Latest SEC Certificate of Registration' },
        ];

        let supportingDocItems = [SD_HARDCODED_ITEM, ...SD_FALLBACK_ITEMS];
        try {
            const docType = (payload.mode === 'no_increase') ? 'tuition_no_increase' : 'tuition_increase';
            const catUrl  = apiUrl(`/documents-submitted.php?action=supporting_docs_catalog&doc_type=${encodeURIComponent(docType)}`);
            const catRes  = await fetch(catUrl, { credentials: 'include' });
            const catData = await catRes.json();
            if (catData?.success && Array.isArray(catData?.items) && catData.items.length) {
                const rest = catData.items.filter(it => it.id !== SD_HARDCODED_ITEM.id);
                supportingDocItems = [SD_HARDCODED_ITEM, ...rest];
            }
        } catch (_) { /* fall back to SD_FALLBACK_ITEMS already set above */ }

        const tickedState = (payload.supporting_docs && typeof payload.supporting_docs === 'object' && !Array.isArray(payload.supporting_docs))
            ? payload.supporting_docs
            : {};

        let uploadedSlugs = {};
        try {
            const upUrl  = apiUrl(`/documents-submitted.php?action=list_supporting_uploads&id=${encodeURIComponent(id)}`);
            const upRes  = await fetch(upUrl, { credentials: 'include' });
            const upData = await upRes.json();
            if (upData?.success && Array.isArray(upData?.items)) {
                upData.items.forEach(row => { uploadedSlugs[row.slug] = true; });
            }
        } catch (_) { /* non-fatal — fall back to just the ticked state */ }

        const supportingDocsChecklist = supportingDocItems.map(it => ({
            label: it.label,
            fulfilled: SD_AUTO_FULFILLED_IDS.includes(it.id) || !!tickedState[it.id] || !!uploadedSlugs[it.id],
            isAuto: SD_AUTO_FULFILLED_IDS.includes(it.id),
        }));

        // ── Read saved values (payload first, record as fallback) ──────
        const schoolName         = form.school_name || record?.school_name || record?.title || '___________________________';
        const address            = form.address || record?.school_address || '___________________________';
        const schoolId            = form.school_id || '___________';
        const currSY              = form.current_sy || '________';
        const propSY              = form.proposed_sy || record?.school_year || '________';
        const principal           = form.principal || '___________________________';
        const principalPosition   = form.principal_position || 'School Principal';
        const reviewedBy          = form.reviewed_by || '___________________________';
        const reviewedByPosition  = form.reviewed_by_position || 'SDO, EPS In Charge';
        const validatedBy         = form.validated_by || '';
        const validatedByPosition = form.validated_by_position || 'EPS,QAD DepEd RO 3';
        const notedBy             = form.noted_by || 'MAY B. ECLAR, PhD, CESO III';
        const notedByPosition     = form.noted_by_position || 'Regional Director';
        const shsTrack            = form.shs_track || '—';
        const shsStrand           = form.shs_strand || '—';
        const sdsName             = form.shs_noted_by || 'ROWENA T. QUIAMBAO, CESO VI';
        const sdsPosition         = form.shs_noted_by_position || 'Schools Division Superintendent';
        const sdsOffice           = form.shs_noted_by_office || 'Office of the Schools Division Superintendent';

        const showK = !!levels.kinder;
        const showE = !!levels.elem;
        const showJ = !!levels.jhs;
        const showS = !!levels.shs;

        if (!showK && !showE && !showJ && !showS) {
            alert('No grade levels were marked in this submission — nothing to export.');
            return;
        }

        // ── Page constants (A4, ~0.35" margins) — same as the reference builder ──
        const PAGE_W    = 11906;
        const PAGE_H    = 16838;
        const MARGIN    = 504;
        const CONTENT_W = PAGE_W - MARGIN * 2;

        const NIL = { style: BorderStyle.NIL };
        const bdr = (color = '000000', sz = 4) => ({ style: BorderStyle.SINGLE, size: sz, color });
        const allBorders = (color = '000000') => ({ top: bdr(color), bottom: bdr(color), left: bdr(color), right: bdr(color) });
        const CM = { top: 60, bottom: 60, left: 100, right: 100 };

        const F  = 'Bookman Old Style';
        const SZ = 18; // 9pt
        const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const fmtPeso = (n) => '\u20b1' + fmt(n);
        const r  = (text, opts = {}) => new TextRun({ text: String(text ?? ''), font: F, size: SZ, ...opts });
        const rb = (text, opts = {}) => r(text, { bold: true, ...opts });
        const p  = (children, opts = {}) => new Paragraph({ children: Array.isArray(children) ? children : [r(children)], spacing: { after: 40 }, ...opts });
        const emptyP = () => new Paragraph({ children: [r('')], spacing: { after: 60 } });
        const centeredP = (children, opts = {}) => p(children, { alignment: AlignmentType.CENTER, ...opts });
        const hdr1 = text => new Paragraph({ children: [rb(text, { size: 22, allCaps: true })], alignment: AlignmentType.CENTER, spacing: { before: 80, after: 60 } });
        const hdr2 = text => new Paragraph({ children: [rb(text, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 } });
        const partLabel = text => new Paragraph({ children: [rb(text, { size: 19 })], alignment: AlignmentType.LEFT, spacing: { before: 0, after: 60 } });

        const cell = (children, opts = {}) => new TableCell({
            children: Array.isArray(children) ? children : [p(children)],
            borders: allBorders(), margins: CM, verticalAlign: VerticalAlign.CENTER, ...opts,
        });
        const hdrCell = (text, opts = {}) => cell([p([rb(text, { size: SZ })], { alignment: AlignmentType.CENTER, spacing: { after: 0 } })], opts);
        const valCell = (text, opts = {}) => cell([p([r(text)], { alignment: AlignmentType.CENTER, spacing: { after: 0 } })], opts);
        const labelCell = (text, opts = {}) => cell([p([r(text)], { spacing: { after: 0 } })], opts);
        const boldLabelCell = (text, opts = {}) => cell([p([rb(text)], { spacing: { after: 0 } })], opts);

        // ── Fetch letterhead images (relative to this admin page, same
        //    folder the inline <img> preview already loads them from) ──
        const fetchImg = async relPath => {
            try {
                const base = window.location.pathname.replace(/\/[^/]*$/, '');
                const res  = await fetch(`${base}/${relPath}`.replace(/([^:])\/\/+/g, '$1/'));
                return res.ok ? await res.arrayBuffer() : null;
            } catch (_) { return null; }
        };
        const [phSealData, sealData] = await Promise.all([
            fetchImg('images/republic-of-the-philippines-doe.jpg'),
            fetchImg('images/kagawaran-ng-edukasyon-logo.png'),
        ]);
        const imgRun = (data, width, height, ext = 'png') => data ? new ImageRun({
            type: ext, data, transformation: { width, height }, altText: { title: '', description: '', name: '' },
        }) : null;

        // ── Official DepEd letterhead header (identical layout to the
        //    reference builder's makeWordHeader()) ──────────────────────
        function makeWordHeader() {
            const cellBorder = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
            const noBord     = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
            const noBorders2 = { top: noBord, bottom: noBord, left: noBord, right: noBord, insideH: noBord, insideV: noBord };

            const SEAL_W   = 900, FORMNO_W = 1900;
            const CENTER_W = CONTENT_W - SEAL_W * 2 - FORMNO_W;

            const sealCell = new TableCell({
                children: [new Paragraph({ children: phSealData ? [imgRun(phSealData, 52, 52, 'jpg')] : [r('')], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder },
                margins: { top: 40, bottom: 40, left: 60, right: 60 }, verticalAlign: VerticalAlign.CENTER,
                width: { size: SEAL_W, type: WidthType.DXA },
            });
            const rightSealCell = new TableCell({
                children: [new Paragraph({ children: sealData ? [imgRun(sealData, 52, 52)] : [r('')], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder },
                margins: { top: 40, bottom: 40, left: 60, right: 60 }, verticalAlign: VerticalAlign.CENTER,
                width: { size: SEAL_W, type: WidthType.DXA },
            });
            const centerCell = new TableCell({
                children: [
                    new Paragraph({ children: [rb('DEPARTMENT OF EDUCATION REGION III', { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }),
                    new Paragraph({ children: [r('Matalino St. D.M. Government Center, Maimpis, City of San Fernando (P)', { size: 16 })], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
                ],
                borders: { top: cellBorder, bottom: cellBorder, left: noBord, right: noBord },
                margins: { top: 60, bottom: 60, left: 80, right: 80 }, verticalAlign: VerticalAlign.CENTER,
                width: { size: CENTER_W, type: WidthType.DXA },
            });
            const formCodeRow = new TableRow({ children: [new TableCell({
                children: [new Paragraph({ children: [rb('DepEd3-QAD-NSF-001', { size: 16 })], alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 } })],
                borders: { top: noBord, bottom: cellBorder, left: noBord, right: noBord }, margins: { top: 20, bottom: 20, left: 40, right: 40 }, columnSpan: 2,
            })] });
            const versionRow = new TableRow({ children: [
                new TableCell({ children: [
                    new Paragraph({ children: [r('Version No.', { size: 14 })], alignment: AlignmentType.CENTER, spacing: { before: 20, after: 10 } }),
                    new Paragraph({ children: [rb('2', { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }),
                ], borders: { top: noBord, bottom: noBord, left: noBord, right: cellBorder }, margins: { top: 20, bottom: 20, left: 40, right: 40 } }),
                new TableCell({ children: [
                    new Paragraph({ children: [r('Rev. No', { size: 14 })], alignment: AlignmentType.CENTER, spacing: { before: 20, after: 10 } }),
                    new Paragraph({ children: [rb('01', { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }),
                ], borders: { top: noBord, bottom: noBord, left: noBord, right: noBord }, margins: { top: 20, bottom: 20, left: 40, right: 40 } }),
            ] });
            const innerFormTable = new Table({ width: { size: FORMNO_W - 20, type: WidthType.DXA }, columnWidths: [Math.round((FORMNO_W - 20) / 2), Math.round((FORMNO_W - 20) / 2)], borders: noBorders2, rows: [formCodeRow, versionRow] });
            const formNoCell = new TableCell({ children: [innerFormTable], borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, verticalAlign: VerticalAlign.TOP, width: { size: FORMNO_W, type: WidthType.DXA } });

            const headerTable = new Table({
                width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [SEAL_W, CENTER_W, SEAL_W, FORMNO_W],
                borders: noBorders2, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER,
                rows: [new TableRow({ children: [sealCell, centerCell, rightSealCell, formNoCell] })],
            });
            return new Header({ children: [headerTable, emptyP()] });
        }

        function notedFooterChildren(name, role) {
            return [
                centeredP([rb('NOTED pursuant to D.O. No. 12, s. 1997')], { spacing: { before: 0, after: 20 } }),
                centeredP([rb(name)], { spacing: { after: 20 } }),
                centeredP([r(role)], { spacing: { after: 0 } }),
            ];
        }
        function makeWordFooter(noted = true) {
            return new Footer({ children: noted ? notedFooterChildren(notedBy, notedByPosition) : [emptyP()] });
        }

        function sigBlock(leftLabel, leftName, leftRole, rightLabel, rightRole, rightName) {
            return [
                centeredP([rb(leftLabel)], { spacing: { before: 40, after: 200 } }),
                centeredP([rb(leftName || '', { underline: { color: '000000' } })], { spacing: { after: 20 } }),
                centeredP([r(leftRole)], { spacing: { after: 220 } }),
                p([rb(rightLabel)], { spacing: { after: 200 } }),
                p([rb(rightName || '', { underline: { color: '000000' } })], { spacing: { after: 20 } }),
                p([r(rightRole)], { spacing: { after: 0 } }),
            ];
        }
        function validatedAndNoted() {
            return [
                new Paragraph({ children: [rb('Validated by:')], spacing: { before: 80, after: 100 } }),
                ...(validatedBy ? [p([rb(validatedBy)], { spacing: { after: 20 } })] : []),
                new Paragraph({ children: [r('')], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' } }, spacing: { after: 20 }, indent: { right: Math.round(CONTENT_W * 0.55) } }),
                p([r(validatedByPosition)]),
            ];
        }
        function schoolInfoGrid() {
            return [
                p([rb('Name of School'), r('  :  '), r(schoolName)], { spacing: { after: 20 } }),
                p([rb('Location'), r('  :  '), r(address)], { spacing: { after: 40 } }),
            ];
        }

        // ── Breakdown of School Fees page — one column per level, two for
        //    SHS (Grade 11 / Grade 12), mirroring _buildAdminTuitionPreview's
        //    own single-column-per-level rendering exactly. ──────────────
        function buildBreakdownPage(levelFormName, colHeaders, sections, totals) {
            const numCols  = colHeaders.length;
            const COL_ROMAN = 400;
            const COL_LABEL = numCols > 1 ? Math.min(2800, Math.floor(CONTENT_W * 0.28)) : Math.min(3600, Math.floor(CONTENT_W * 0.4));
            const COL_EACH  = Math.floor((CONTENT_W - COL_ROMAN - COL_LABEL) / numCols);
            const colWidths = [COL_ROMAN, COL_LABEL, ...Array(numCols).fill(COL_EACH)];
            const used = COL_ROMAN + COL_LABEL + COL_EACH * numCols;
            colWidths[colWidths.length - 1] += (CONTENT_W - used);

            const headerRows = [];
            if (numCols > 1) {
                headerRows.push(new TableRow({ children: [hdrCell('FEES', { columnSpan: 2, rowSpan: 2 }), hdrCell(levelFormName, { columnSpan: numCols })] }));
                headerRows.push(new TableRow({ children: colHeaders.map(h => hdrCell(h)) }));
            } else {
                headerRows.push(new TableRow({ children: [hdrCell('FEES', { columnSpan: 2 }), hdrCell(colHeaders[0])] }));
            }

            const dataRows = [];
            sections.forEach(sec => {
                dataRows.push(new TableRow({ children: [labelCell(sec.roman), boldLabelCell(sec.label), ...Array(numCols).fill(null).map(() => valCell(''))] }));
                sec.rows.forEach(row => {
                    dataRows.push(new TableRow({ children: [labelCell(''), labelCell('  ' + row.label), ...row.values.map(v => valCell(v || ''))] }));
                });
            });
            dataRows.push(new TableRow({ children: [valCell(''), boldLabelCell('TOTAL'), ...totals.map(v => valCell(v))] }));

            const table = new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: colWidths, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER, rows: [...headerRows, ...dataRows] });

            return [
                ...schoolInfoGrid(), emptyP(),
                hdr1('BREAKDOWN OF SCHOOL FEES'), partLabel('Part I'),
                table, emptyP(),
                ...sigBlock('Prepared by:', principal, principalPosition, 'Processed and Evaluated by:', reviewedByPosition, reviewedBy),
                ...validatedAndNoted(),
            ];
        }

        // ── Comparative Schedule page — one page per level, one row per
        //    grade (same figures repeated per grade), matching
        //    _tfCompPage()/_tfCalcCompRow() used by the admin preview. ───
        function buildComparativePage(levelLabel, gradeLabels, row) {
            const COL_LEVEL = Math.floor(CONTENT_W * 0.14);
            const COL_EACH  = Math.floor((CONTENT_W - COL_LEVEL) / 8);
            const lastW     = CONTENT_W - COL_LEVEL - COL_EACH * 7;
            const colWidths = [COL_LEVEL, COL_EACH, COL_EACH, COL_EACH, COL_EACH, COL_EACH, COL_EACH, COL_EACH, lastW];

            const pct = (inc, base) => base ? `${(inc / base * 100).toFixed(2)}%` : '0.00%';
            const headerRow1 = new TableRow({ children: [
                hdrCell('LEVEL', { rowSpan: 2 }),
                hdrCell('TUITION FEES', { columnSpan: 4 }),
                hdrCell('MISCELLANEOUS & OTHER FEES', { columnSpan: 4 }),
            ] });
            const headerRow2 = new TableRow({ children: [
                hdrCell(`Approved TF\nSY: ${currSY}`), hdrCell(`Proposed TF\nSY: ${propSY}`), hdrCell('Amount of Increase'), hdrCell('% Increase'),
                hdrCell(`Approved MF\nSY: ${currSY}`), hdrCell(`Proposed MF\nSY: ${propSY}`), hdrCell('Amount of Increase'), hdrCell('% Increase'),
            ] });
            const dataRows = gradeLabels.map(label => new TableRow({ children: [
                labelCell(label),
                valCell(fmt(row.tfCurr)), valCell(fmt(row.tfProp)), valCell(fmt(row.tfInc)), valCell(pct(row.tfInc, row.tfCurr)),
                valCell(fmt(row.mfCurr)), valCell(fmt(row.mfProp)), valCell(fmt(row.mfInc)), valCell(pct(row.mfInc, row.mfCurr)),
            ] }));

            const table = new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: colWidths, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER, rows: [headerRow1, headerRow2, ...dataRows] });

            return [
                ...schoolInfoGrid(),
                hdr1('Comparative Schedule of Tuition, Miscellaneous & Other Fees'),
                hdr2(`for S.Y. ${propSY}`),
                new Paragraph({ children: [rb(levelLabel, { size: 20 })], spacing: { before: 40, after: 80 } }),
                table, emptyP(),
                ...sigBlock('Prepared by:', principal, principalPosition, 'Processed and Evaluated by:', reviewedByPosition, reviewedBy),
                ...validatedAndNoted(),
            ];
        }

        // ── SHS "Certification of School Fees" page — boxed layout,
        //    matching _tfShsCertPage()/buildSHSCertPage() in the reference. ──
        function buildSHSCertPage(grade, buckets) {
            const CERT_FONT = 'Arial';
            const cr  = (text, opts = {}) => r(text, { font: CERT_FONT, color: '000000', ...opts });
            const crb = (text, opts = {}) => cr(text, { bold: true, ...opts });

            const OUTER_BORDER = bdr('1A1A1A', 8);
            const RULE_BORDER  = bdr('1A1A1A', 5);
            const BOX_INSET    = 520;
            const INNER_W      = CONTENT_W - BOX_INSET;
            const COL_LABEL    = Math.floor(INNER_W * 0.72);
            const COL_AMT      = INNER_W - COL_LABEL;
            const noBorders    = { top: NIL, bottom: NIL, left: NIL, right: NIL, insideH: NIL, insideV: NIL };

            const fullRule = () => new Paragraph({ children: [], border: { top: RULE_BORDER }, spacing: { before: 50, after: 50 }, indent: { left: -260, right: -260 } });
            const certRow = (leftText, rightText, opts = {}) => {
                const { bold = false, indent = false, small = false } = opts;
                const mkRun = t => small ? cr(t, { size: 15, bold: true }) : (bold ? crb(t) : cr(t));
                const leftPara  = new Paragraph({ children: [mkRun(leftText)], spacing: { after: 0 }, indent: indent ? { left: 220 } : undefined });
                const rightPara = new Paragraph({ children: [mkRun(rightText)], alignment: AlignmentType.RIGHT, spacing: { after: 0 } });
                const cm = { top: 22, bottom: 22, left: 0, right: 0 };
                return new TableRow({ children: [
                    new TableCell({ children: [leftPara], borders: noBorders, margins: cm, width: { size: COL_LABEL, type: WidthType.DXA } }),
                    new TableCell({ children: [rightPara], borders: noBorders, margins: cm, width: { size: COL_AMT, type: WidthType.DXA } }),
                ] });
            };
            const miniTable = rows => new Table({ width: { size: INNER_W, type: WidthType.DXA }, columnWidths: [COL_LABEL, COL_AMT], borders: noBorders, rows });

            const tuitionRow = buckets[1].find(x => x.label === `Tuition Fee (Grade ${grade})`) || buckets[1].find(x => x.label === 'Tuition Fee') || { proposed: 0 };
            const miscRows   = buckets[2];
            const otherRows  = buckets[3];
            const miscTotal  = miscRows.reduce((s, x) => s + Number(x.proposed || 0), 0);
            const otherTotal = otherRows.reduce((s, x) => s + Number(x.proposed || 0), 0);
            const grandTotal = Number(tuitionRow.proposed || 0) + miscTotal + otherTotal;

            const tuitionTable = miniTable([certRow('I.  Tuition Fee', '', { bold: true }), certRow('Amount', '', { small: true }), certRow('', fmtPeso(tuitionRow.proposed), {})]);
            const miscTable = miniTable([
                certRow('II.  Miscellaneous Fees', '', { bold: true }),
                ...miscRows.map(x => certRow(x.label, fmtPeso(x.proposed), { indent: true })),
                certRow('Total Miscellaneous Fees', fmtPeso(miscTotal), { bold: true }),
            ]);
            const otherTable = miniTable([
                certRow('III.  Other Fees', '', { bold: true }),
                ...otherRows.map(x => certRow(x.label, fmtPeso(x.proposed), { indent: true })),
                certRow('', 'Amount', { small: true }),
                certRow('Total Other Fees', fmtPeso(otherTotal), { bold: true }),
            ]);
            const grandTable = miniTable([certRow('IV.  Total Tuition and Other School Fees (Sum of Part I, Part II, and Part III)', '', { bold: true }), certRow('Amount', '', { small: true }), certRow('', fmtPeso(grandTotal), { bold: true })]);

            const infoHalfW = Math.floor(INNER_W / 2);
            const mkI = (lbl, v) => new TableCell({ children: [p([crb(lbl + ': '), cr(v)], { spacing: { after: 0 } })], borders: noBorders, margins: { top: 24, bottom: 24, left: 0, right: 0 }, width: { size: infoHalfW, type: WidthType.DXA } });

            const sigHalfW = Math.floor(INNER_W / 2);
            const sigCell = (children, align) => new TableCell({ children: [new Paragraph({ children, alignment: align, spacing: { after: 0 } })], borders: noBorders, margins: { top: 12, bottom: 12, left: 0, right: 0 }, width: { size: sigHalfW, type: WidthType.DXA } });
            const sigSpacerCell = (align) => new TableCell({ children: [new Paragraph({ children: [], spacing: { after: 0 } })], borders: noBorders, margins: { top: 90, bottom: 90, left: 0, right: 0 }, width: { size: sigHalfW, type: WidthType.DXA } });
            const preparedTable = new Table({ width: { size: INNER_W, type: WidthType.DXA }, columnWidths: [sigHalfW, sigHalfW], borders: noBorders, rows: [
                new TableRow({ children: [sigCell([], AlignmentType.LEFT), sigCell([crb('Prepared by:')], AlignmentType.RIGHT)] }),
                new TableRow({ children: [sigSpacerCell(AlignmentType.LEFT), sigSpacerCell(AlignmentType.RIGHT)] }),
                new TableRow({ children: [sigCell([], AlignmentType.LEFT), sigCell([crb(principal || '', { underline: { color: '000000' } })], AlignmentType.RIGHT)] }),
                new TableRow({ children: [sigCell([cr('Note: Signature over printed name', { size: 15 })], AlignmentType.LEFT), sigCell([crb(principalPosition)], AlignmentType.RIGHT)] }),
            ] });
            const reviewedTable = new Table({ width: { size: INNER_W, type: WidthType.DXA }, columnWidths: [sigHalfW, sigHalfW], borders: noBorders, rows: [
                new TableRow({ children: [
                    sigCell([crb('Reviewed by:')], AlignmentType.LEFT),
                    sigCell([crb('NOTED pursuant to DECS Order #12, s.1997')], AlignmentType.RIGHT),
                ] }),
                new TableRow({ children: [sigSpacerCell(AlignmentType.LEFT), sigSpacerCell(AlignmentType.RIGHT)] }),
                new TableRow({ children: [
                    sigCell([crb(reviewedBy || '', { underline: { color: '000000' } })], AlignmentType.LEFT),
                    sigCell([crb(sdsName, { underline: { color: '000000' } })], AlignmentType.RIGHT),
                ] }),
                new TableRow({ children: [
                    sigCell([cr('Chief, SGOD / In-Charge of Private Schools', { size: 15 })], AlignmentType.LEFT),
                    sigCell([cr(sdsPosition, { size: 15 })], AlignmentType.RIGHT),
                ] }),
                new TableRow({ children: [
                    sigCell([], AlignmentType.LEFT),
                    sigCell([cr(sdsOffice, { size: 15 })], AlignmentType.RIGHT),
                ] }),
            ] });

            const boxChildren = [
                new Paragraph({ children: [crb('Certification of School Fees', { size: 22 })], alignment: AlignmentType.CENTER, spacing: { after: 15 } }),
                new Paragraph({ children: [cr(`For School Year ${propSY}`, { size: 19 })], alignment: AlignmentType.CENTER, spacing: { after: 90 } }),
                new Table({ width: { size: INNER_W, type: WidthType.DXA }, columnWidths: [infoHalfW, infoHalfW], borders: noBorders, rows: [
                    new TableRow({ children: [mkI('School ID', schoolId), new TableCell({ children: [emptyP()], borders: noBorders })] }),
                    new TableRow({ children: [new TableCell({ children: [p([crb('School Name: '), cr(schoolName)], { spacing: { after: 0 } })], borders: noBorders, margins: { top: 16, bottom: 16, left: 0, right: 0 }, columnSpan: 2 })] }),
                    new TableRow({ children: [new TableCell({ children: [p([crb('School Address: '), cr(address)], { spacing: { after: 0 } })], borders: noBorders, margins: { top: 16, bottom: 16, left: 0, right: 0 }, columnSpan: 2 })] }),
                    new TableRow({ children: [mkI('Track', shsTrack), mkI('Strand', shsStrand)] }),
                    new TableRow({ children: [new TableCell({ children: [p([crb('Grade Level: '), cr(String(grade))], { spacing: { after: 0 } })], borders: noBorders, margins: { top: 16, bottom: 16, left: 0, right: 0 }, columnSpan: 2 })] }),
                ] }),
                fullRule(), tuitionTable, fullRule(), miscTable, fullRule(), otherTable, fullRule(), grandTable, fullRule(),
                new Paragraph({ children: [cr('V. Please indicate any special concessions given to SHS Voucher Program Beneficiaries (e.g. Tuition waiver, discounts, any forms of financial assistance):', { bold: true, size: 16 })], spacing: { before: 0, after: 40 } }),
                new Paragraph({ children: [cr('None indicated.', { italics: true, size: 16 })], spacing: { after: 40 } }),
                fullRule(),
                new Paragraph({ children: [cr('I certify, under the penalties of perjury, that the above information contained herein is true and correct and is in accordance with the SHS VP Implementation Guidelines.', { size: 16 })], spacing: { before: 0, after: 60 } }),
                preparedTable, fullRule(), reviewedTable,
            ];

            const outerCell = new TableCell({ children: boxChildren, borders: { top: OUTER_BORDER, bottom: OUTER_BORDER, left: OUTER_BORDER, right: OUTER_BORDER }, margins: { top: 140, bottom: 140, left: 260, right: 260 }, width: { size: CONTENT_W, type: WidthType.DXA } });
            const outerBox = new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W], layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER, rows: [new TableRow({ children: [outerCell] })] });

            return [outerBox];
        }

        // ── Supporting Documents checklist page ─────────────────────────
        function buildSupportingDocsPage() {
            const noBorders = { top: NIL, bottom: NIL, left: NIL, right: NIL, insideH: NIL, insideV: NIL };
            const checkRows = supportingDocsChecklist.map(it => new TableRow({ children: [
                new TableCell({
                    children: [p([it.fulfilled ? rb('✓', { size: 22 }) : r('')], { alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
                    borders: allBorders(), margins: CM, width: { size: 480, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
                }),
                new TableCell({
                    children: [p([r(it.label), ...(it.isAuto ? [r('  (auto — generated by builder)', { italics: true, size: 15 })] : [])], { spacing: { after: 0 } })],
                    borders: noBorders, margins: { top: 60, bottom: 60, left: 120, right: 0 },
                }),
            ] }));
            return [
                hdr1('Supporting Documents'), emptyP(),
                new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [480, CONTENT_W - 480], borders: noBorders, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER, rows: checkRows }),
                emptyP(),
                ...sigBlock('Prepared by:', principal, principalPosition, 'Processed and Evaluated by:', reviewedByPosition, reviewedBy),
            ];
        }

        // ═══ MAIN ASSEMBLY ═══
        try {
            // BUG FIX: a docx `Header` object can only belong to ONE section.
            // This used to build `wordHeader` once here and reuse that same
            // instance for every section below — the school-portal's own
            // reference builder (exportTuitionWord() in
            // school-portal-tuition.html) instead calls makeWordHeader(imgs)
            // fresh inside addSection() for every page, which is why its
            // export always shows the DepEd letterhead and this one didn't.
            const allSections = [];
            let firstSection = true;
            const addSection = (children, showNoted = true, showHeader = true) => {
                allSections.push({
                    headers: { default: showHeader ? makeWordHeader() : new Header({ children: [] }) },
                    footers: { default: makeWordFooter(showNoted) },
                    properties: {
                        page: {
                            size: { width: PAGE_W, height: PAGE_H },
                            // Leave generous top room for the letterhead when it's shown;
                            // when suppressed (showHeader=false) there's nothing to leave
                            // room for, so use a normal top margin instead of a blank gap.
                            margin: { top: showHeader ? 1800 : 500, right: MARGIN, bottom: showHeader ? 1440 : 600, left: MARGIN },
                            ...(firstSection ? {} : { type: 'nextPage' }),
                        },
                    },
                    children,
                });
                firstSection = false;
            };

            // ── Breakdown of School Fees — one page per level ───────────
            const feeRow = (label, values) => ({ label, values });
            if (showK) {
                const b = _tfBucketsFor('kinder', levels.kinder);
                const sections = [
                    { roman: 'I.', label: 'TUITION FEE', rows: [feeRow('Tuition Fee', [fmt((b[1][0] || {}).proposed)])] },
                    { roman: 'II.', label: 'MISCELLANEOUS FEES', rows: b[2].map(x => feeRow(x.label, [fmt(x.proposed)])) },
                    { roman: 'III.', label: 'OTHER FEES', rows: b[3].map(x => feeRow(x.label, [fmt(x.proposed)])) },
                ];
                addSection(buildBreakdownPage('KINDERGARTEN', ['KINDERGARTEN'], sections, [fmt(levels.kinder.total_proposed)]));
            }
            if (showE) {
                const b = _tfBucketsFor('elem', levels.elem);
                const cols = [1,2,3,4,5,6].map(g => `Grade ${g}`);
                const rep = v => cols.map(() => v);
                const sections = [
                    { roman: 'I.', label: 'TUITION FEE', rows: [feeRow('Tuition Fee', rep(fmt((b[1][0] || {}).proposed)))] },
                    { roman: 'II.', label: 'MISCELLANEOUS FEES', rows: b[2].map(x => feeRow(x.label, rep(fmt(x.proposed)))) },
                    { roman: 'III.', label: 'OTHER FEES', rows: b[3].map(x => feeRow(x.label, rep(fmt(x.proposed)))) },
                ];
                addSection(buildBreakdownPage('ELEMENTARY', cols, sections, rep(fmt(levels.elem.total_proposed))));
            }
            if (showJ) {
                const b = _tfBucketsFor('jhs', levels.jhs);
                const cols = [7,8,9,10].map(g => `Grade ${g}`);
                const rep = v => cols.map(() => v);
                const sections = [
                    { roman: 'I.', label: 'TUITION FEE', rows: [feeRow('Tuition Fee', rep(fmt((b[1][0] || {}).proposed)))] },
                    { roman: 'II.', label: 'MISCELLANEOUS FEES', rows: b[2].map(x => feeRow(x.label, rep(fmt(x.proposed)))) },
                    { roman: 'III.', label: 'OTHER FEES', rows: b[3].map(x => feeRow(x.label, rep(fmt(x.proposed)))) },
                ];
                addSection(buildBreakdownPage('JUNIOR HIGH SCHOOL', cols, sections, rep(fmt(levels.jhs.total_proposed))));
            }
            if (showS) {
                const b = _tfBucketsFor('shs', levels.shs);
                const g11 = b[1].find(x => x.label === 'Tuition Fee (Grade 11)') || b[1].find(x => x.label === 'Tuition Fee') || { proposed: 0 };
                const g12 = b[1].find(x => x.label === 'Tuition Fee (Grade 12)') || b[1].find(x => x.label === 'Tuition Fee') || { proposed: 0 };
                const miscTotal  = b[2].reduce((s, x) => s + Number(x.proposed || 0), 0);
                const otherTotal = b[3].reduce((s, x) => s + Number(x.proposed || 0), 0);
                const g11Total = Number(g11.proposed || 0) + miscTotal + otherTotal;
                const g12Total = Number(g12.proposed || 0) + miscTotal + otherTotal;
                const shared = x => [fmt(x.proposed), fmt(x.proposed)];
                const sections = [
                    { roman: 'I.', label: 'TUITION FEE', rows: [feeRow('Tuition Fee', [fmt(g11.proposed), fmt(g12.proposed)])] },
                    { roman: 'II.', label: 'MISCELLANEOUS FEES', rows: b[2].map(x => feeRow(x.label, shared(x))) },
                    { roman: 'III.', label: 'OTHER FEES', rows: b[3].map(x => feeRow(x.label, shared(x))) },
                ];
                addSection(buildBreakdownPage('SENIOR HIGH SCHOOL', ['Grade 11', 'Grade 12'], sections, [fmt(g11Total), fmt(g12Total)]));
            }

            // ── Comparative Schedule — one page per level (SHS excluded,
            //    exactly as in _buildAdminTuitionPreview) ─────────────────
            if (showK) addSection(buildComparativePage('Kindergarten', ['KINDERGARTEN'], _tfCalcCompRow(_tfBucketsFor('kinder', levels.kinder))));
            if (showE) addSection(buildComparativePage('Elementary', [1,2,3,4,5,6].map(g => `Grade ${g}`), _tfCalcCompRow(_tfBucketsFor('elem', levels.elem))));
            if (showJ) addSection(buildComparativePage('Junior High School', [7,8,9,10].map(g => `Grade ${g}`), _tfCalcCompRow(_tfBucketsFor('jhs', levels.jhs))));

            // ── SHS Certification of School Fees — Grade 11 and Grade 12 ──
            if (showS) {
                const b = _tfBucketsFor('shs', levels.shs);
                addSection(buildSHSCertPage(11, b), false, false);
                addSection(buildSHSCertPage(12, b), false, false);
            }

            // ── Supporting Documents checklist ───────────────────────────
            addSection(buildSupportingDocsPage(), false);

            const doc = new Document({ styles: { default: { document: { run: { font: F, size: SZ } } } }, sections: allSections });
            const blob = await Packer.toBlob(doc);
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `TuitionFee_${String(schoolName).replace(/[\\/?:%*|"<>]/g, '-')}_SY${propSY}.docx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('exportSubmittedTuitionWord error:', err);
            alert('Word export failed: ' + (err.message || 'Unknown error'));
        }
    }


    function _buildAdminCalendarPreview(payload) {
        const e = (v) => String(v == null ? '' : v)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        /* SVG symbol helper — matches the updated school-portal legend symbols */
        const symSvg = (key, color, size = 12) => {
            const s = size;
            if (key === 'holiday') return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><rect x="1" y="1" width="16" height="16" fill="none" stroke="${color}" stroke-width="1.8"/><line x1="1" y1="1" x2="17" y2="17" stroke="${color}" stroke-width="1.8"/><line x1="17" y1="1" x2="1" y2="17" stroke="${color}" stroke-width="1.8"/></svg>`;
            if (key === 'activity') return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><rect x="1" y="1" width="16" height="16" fill="none" stroke="${color}" stroke-width="1.8"/></svg>`;
            if (key === 'exam')     return `<svg width="${s}" height="${s}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><polygon points="9,1 17,17 1,17" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
            return `<span style="display:inline-block;width:${s}px;height:${s}px;border-radius:50%;background:${color};vertical-align:middle;"></span>`;
        };

        const form         = (payload.form         && typeof payload.form         === 'object') ? payload.form         : {};
        const savedMarks   = (payload.savedMarks   && typeof payload.savedMarks   === 'object') ? payload.savedMarks   : {};
        const savedRemarks = (payload.savedRemarks && typeof payload.savedRemarks === 'object') ? payload.savedRemarks : {};
        const DEFAULT_LEGENDS = {
            holiday:  { label:'Holiday',        color:'#dc2626', symbol:'X',  includeInSchoolDays:false },
            activity: { label:'School Activity', color:'#374151', symbol:'□',  includeInSchoolDays:true  },
            exam:     { label:'Exam / Quarter',  color:'#854d0e', symbol:'△',  includeInSchoolDays:true  },
        };
        const legends      = (payload.legends      && typeof payload.legends      === 'object') ? payload.legends      : { ...DEFAULT_LEGENDS };

        /* ── Period/term structure (Quarters / Trimesters / Semesters) ──────
           Mirrors school-portal-calendar.js's PERIOD_LEVEL_MAP + override
           dropdown so the admin "School Days per Quarter/Semester" page
           (Page 7) groups months exactly the same way the school's own
           builder does. */
        const PERIOD_LEVEL_MAP = [
            { test: d => d.includes('senior high') || d === 'shs', type: 'semester', count: 2 },
            { test: d => d.includes('college'),                     type: 'semester', count: 2 },
            { test: d => d.includes('kinder'),                      type: 'quarter',  count: 4 },
            { test: d => d.includes('preschool'),                   type: 'quarter',  count: 4 },
            { test: d => d.includes('elementary'),                  type: 'quarter',  count: 4 },
            { test: d => d.includes('junior high') || d === 'jhs', type: 'quarter',  count: 4 },
            { test: d => d.includes('sped'),                        type: 'quarter',  count: 4 },
        ];
        const getPeriodConfigForLevel = (rawDept) => {
            const d = String(rawDept || '').toLowerCase().trim();
            const match = PERIOD_LEVEL_MAP.find(p => p.test(d));
            const type  = match ? match.type  : 'quarter';
            const count = match ? match.count : 4;
            return { type, count, label: type === 'semester' ? 'SEMESTER' : type === 'trimester' ? 'TRIMESTER' : 'QUARTER' };
        };
        const getPeriodOverrideConfig = () => {
            const raw = (form.f_period_override || '').trim();
            if (!raw) return null;
            const [type, countStr] = raw.split(':');
            const count = parseInt(countStr, 10);
            if (!type || !count) return null;
            const label = type === 'semester' ? 'SEMESTER' : type === 'trimester' ? 'TRIMESTER' : 'QUARTER';
            return { type, count, label };
        };
        const _splitAcadMonths = (count) => {
            const total = 11;
            const base = Math.floor(total / count);
            const extra = total % count;
            const parts = [];
            for (let i = 0; i < count; i++) parts.push(base + (i < extra ? 1 : 0));
            return parts;
        };

        const school     = (form.f_school          || '').trim() || 'School';
        const dept       = (form.f_dept            || 'Elementary School').trim();
        const sid        = (form.f_sid             || '').trim();
        const gov        = (form.f_gov             || '').trim();
        const sy1        = (form.f_sy1             || '2026').trim();
        const sy2        = (form.f_sy2             || '2027').trim();
        const opening    = (form.f_opening         || '').trim();
        const closing    = (form.f_closing         || '').trim();
        const principal  = (form.f_principal       || '').trim();
        const prinTitle  = (form.f_principal_title || 'Principal').trim();
        const rdName     = (form.f_rd_name         || '').trim();
        const rdPos      = (form.f_rd_pos          || '').trim();
        const rdOffice   = (form.f_rd_office       || '').trim();
        const sdsName    = (form.f_sds_name        || '').trim();
        const sdsPos     = (form.f_sds_pos         || '').trim();
        const sdsOffice  = (form.f_sds_office      || '').trim();
        const sdsCity    = (form.f_sds_city        || '').trim();
        const loiP1      = (form.f_loi_p1          || '').trim();
        const loiP2      = (form.f_loi_p2          || '').trim();
        const loiClosing = (form.f_loi_closing     || '').trim();
        const rec        = (form.f_recommending    || '').trim();
        const recPos     = (form.f_rec_pos         || '').trim();
        const recOrg     = (form.f_rec_org         || '').trim();
        const approved   = (form.f_approved        || '').trim();
        const appPos     = (form.f_app_pos         || '').trim();
        const appOrg     = (form.f_app_org         || '').trim();

        const syRange = `${e(sy1)}–${e(sy2)}`;
        const syDash  = `${e(sy1)}-${e(sy2)}`;
        const meta    = `School ID: ${e(sid)}${gov ? '   ' + e(gov) : ''}`;
        const deptShort = dept.replace(/\s*School\s*$/i, '');

        const logoRaw  = (payload.logoDataUrl || '').trim();
        const logoHtml = logoRaw
            ? `<img class="lh-logo" src="${e(logoRaw)}" alt="School logo">`
            : `<div class="lh-logo-placeholder"><i class="fa-solid fa-school"></i></div>`;

        const lh = () => `
            <div class="lh">
                <div class="lh-left">
                    ${logoHtml}
                    <div class="lh-text">
                        <h3>${e(school)}</h3>
                        <p>${e(dept)}</p>
                        <p>${e(meta)}</p>
                    </div>
                </div>
            </div>`;

        const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const DAY_SHORT   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

        const sy1i = parseInt(sy1, 10) || 2026;
        const sy2i = parseInt(sy2, 10) || 2027;
        const ACAD_MONTHS = [
            {y:sy1i,m:5},{y:sy1i,m:6},{y:sy1i,m:7},{y:sy1i,m:8},
            {y:sy1i,m:9},{y:sy1i,m:10},{y:sy1i,m:11},
            {y:sy2i,m:0},{y:sy2i,m:1},{y:sy2i,m:2},{y:sy2i,m:3},
        ];

        const daysInMonth  = (y, m)    => new Date(y, m + 1, 0).getDate();
        const isWeekend    = (y, m, d) => { const w = new Date(y,m,d).getDay(); return w===0||w===6; };
        const mkKey        = (y, m, d) => `${y}-${m}-${d}`;
        const parseDate    = (v)       => { if (!v) return null; const d = new Date(v+'T00:00:00'); return isNaN(d.getTime()) ? null : d; };
        const openingDate  = parseDate(opening);
        const closingDate  = parseDate(closing);
        const fmtLongDate  = (dt, fallback) => {
            if (!(dt instanceof Date) || isNaN(dt.getTime())) return e(fallback || '');
            try {
                return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            } catch (_) {
                return e(fallback || '');
            }
        };
        const openingLabel = fmtLongDate(openingDate, opening);
        const closingLabel = fmtLongDate(closingDate, closing);
        const inRange      = (y, m, d) => {
            const dt = new Date(y, m, d);
            if (openingDate && dt < openingDate) return false;
            if (closingDate && dt > closingDate) return false;
            return true;
        };

        const schoolDaysInMonth = (y, m) => {
            let count = 0;
            const total = daysInMonth(y, m);
            for (let d = 1; d <= total; d++) {
                if (!inRange(y, m, d)) continue;
                const k    = mkKey(y, m, d);
                const mark = savedMarks[k];
                if (!mark) { if (!isWeekend(y, m, d)) count++; }
                else {
                    const leg = legends[mark];
                    if (leg ? leg.includeInSchoolDays !== false : true) count++;
                }
            }
            return count;
        };

        const grandTotal = ACAD_MONTHS.reduce((s, {y, m}) => s + schoolDaysInMonth(y, m), 0);
        const totalColor = grandTotal === 0 ? '' : grandTotal < 200 ? 'color:#ef4444;' : grandTotal <= 220 ? 'color:#22c55e;' : 'color:#f59e0b;';
        const totalIcon  = grandTotal === 0 ? '' : grandTotal < 200 ? ' ⚠ Below minimum' : grandTotal <= 220 ? ' ✓' : ' ⚠ Above maximum';

        /* ── Page 7 term/quarter grouping — mirrors TERM_MAP in the builder */
        const periodCfg = getPeriodOverrideConfig() || getPeriodConfigForLevel(dept);
        const monthCounts = _splitAcadMonths(periodCfg.count);
        const TERM_MAP = {};
        (() => {
            let idx = 0;
            monthCounts.forEach((numMonths, periodIdx) => {
                for (let i = 0; i < numMonths; i++) {
                    const { y, m } = ACAD_MONTHS[idx++];
                    TERM_MAP[`${y}-${m}`] = `${periodCfg.label} ${periodIdx + 1}`;
                }
            });
        })();
        let prevTermLabel = '';
        const termTotals  = {};
        const termRowsArr = [];
        ACAD_MONTHS.forEach(({ y, m }, i) => {
            const sd = schoolDaysInMonth(y, m);
            const tk = `${y}-${m}`;
            const tLabel = TERM_MAP[tk] || `${periodCfg.label} 1`;
            termTotals[tLabel] = (termTotals[tLabel] || 0) + sd;
            if (tLabel !== prevTermLabel) { termRowsArr.push(`<tr class="term-hdr"><td colspan="2">${e(tLabel)}</td></tr>`); prevTermLabel = tLabel; }
            termRowsArr.push(`<tr><td>${MONTH_NAMES[m]}</td><td>${sd}</td></tr>`);
            const next = ACAD_MONTHS[i + 1];
            const nextLabel = next ? (TERM_MAP[`${next.y}-${next.m}`] || tLabel) : null;
            if (!next || nextLabel !== tLabel) termRowsArr.push(`<tr class="sub-total"><td>TOTAL</td><td>${termTotals[tLabel] || 0}</td></tr>`);
        });
        termRowsArr.push(`<tr class="total-row"><td>TOTAL${totalIcon}</td><td style="${totalColor}font-weight:900;">${grandTotal}</td></tr>`);
        const termRows = termRowsArr.join('');

        const attachedRaw  = (form.f_attached || '').split('\n').filter(s => s.trim());
        const attachedList = attachedRaw.length
            ? attachedRaw.map(a => `<li>${e(a.trim())}</li>`).join('')
            : `<li>Letter of Intent</li>
               <li>School Calendar for S.Y. ${syDash}</li>
               <li>Board Resolution</li>
               <li>Photocopy of SEC Registration</li>
               <li>Photocopy of Government Recognition/Permit</li>`;

        const summaryRows = ACAD_MONTHS.map(({y, m}) => {
            const sd = schoolDaysInMonth(y, m);
            return `<tr><td>${MONTH_NAMES[m]}</td><td>${sd}</td></tr>`;
        }).join('') +
        `<tr class="total-row"><td>TOTAL</td><td style="font-weight:900;">${grandTotal}</td></tr>`;

        const chkRows = [1,2,3,4,5].map(i => {
            const req = (form[`f_chk_req${i}`]    || '').trim();
            const rem = (form[`f_chk_remark${i}`] || '').trim();
            return `<tr>
                <td>${i}.</td>
                <td><span>${e(req)}</span></td>
                <td><span class="chk-remark">${e(rem)}</span></td>
            </tr>`;
        }).join('');

        const openingYear  = openingDate ? openingDate.getFullYear() : null;
        const openingMonth = openingDate ? openingDate.getMonth()    : null;
        const openingDay   = openingDate ? openingDate.getDate()     : null;
        const closingYear  = closingDate ? closingDate.getFullYear() : null;
        const closingMonth = closingDate ? closingDate.getMonth()    : null;
        const closingDay   = closingDate ? closingDate.getDate()     : null;
        const sameStartEnd = openingYear === closingYear && openingMonth === closingMonth
            && openingDay === closingDay && openingDay !== null;

        const buildMonthGrid = (acadMonths) => {
            let html = '';
            acadMonths.forEach(({y, m}) => {
                const mName    = MONTH_NAMES[m];
                const total    = daysInMonth(y, m);
                const firstDow = new Date(y, m, 1).getDay();
                const sd       = schoolDaysInMonth(y, m);
                const isOpeningMonth = openingYear === y && openingMonth === m;
                const isClosingMonth = closingYear === y && closingMonth === m;

                let calHtml = `<div class="mini-cal-header">${mName}</div>`;
                calHtml += `<table class="mini-cal"><thead><tr>`;
                DAY_SHORT.forEach(d => calHtml += `<th class="${d==='Su'?'sun':d==='Sa'?'sat':''}">${d}</th>`);
                calHtml += `</tr></thead><tbody><tr>`;

                let cellCount = 0;
                for (let i = 0; i < firstDow; i++) { calHtml += `<td></td>`; cellCount++; }

                for (let d = 1; d <= total; d++) {
                    if (cellCount % 7 === 0 && cellCount > 0) calHtml += `</tr><tr>`;
                    const dow    = new Date(y, m, d).getDay();
                    const isWknd = dow === 0 || dow === 6;
                    const k      = mkKey(y, m, d);
                    const mark   = savedMarks[k];
                    const isStartDay = isOpeningMonth && d === openingDay;
                    const isEndDay   = isClosingMonth && d === closingDay;
                    let cls      = isWknd ? (dow === 0 ? 'sun' : 'sat') : '';
                    if (isStartDay) cls += ' start-day';
                    if (isEndDay)   cls += ' end-day';
                    if (isStartDay && isEndDay) cls += ' start-end-day';
                    let content  = String(d);
                    if      (mark === 'holiday')  { cls += ' holiday-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="1" x2="17" y2="17" stroke="currentColor" stroke-width="1.5"/><line x1="17" y1="1" x2="1" y2="17" stroke="currentColor" stroke-width="1.5"/><text x="9" y="12" text-anchor="middle" font-size="8" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                    else if (mark === 'activity') { cls += ' activity-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="9" y="12" text-anchor="middle" font-size="8" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                    else if (mark === 'exam')     { cls += ' exam-day'; content = `<svg class="day-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><polygon points="9,1 17,17 1,17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><text x="9" y="15" text-anchor="middle" font-size="7" font-family="inherit" fill="currentColor" font-weight="700">${d}</text></svg>`; }
                    else if (mark && legends[mark]) {
                        /* Custom user-created legend category — fill the day
                           cell with its own color as a pill so the calendar
                           box itself (not just the activity list) reflects
                           the custom legend, matching the school-portal
                           builder's design. */
                        const customLeg   = legends[mark];
                        const customColor = customLeg.color || '#64748b';
                        cls += ' custom-mark-day';
                        content = `<span class="custom-mark-pill" style="background:${customColor};" title="${e(customLeg.label || mark)}">${d}</span>`;
                    }
                    calHtml += `<td class="${cls.trim()}">${content}</td>`;
                    cellCount++;
                }
                const rem = 7 - (cellCount % 7);
                if (rem < 7) for (let i = 0; i < rem; i++) calHtml += `<td></td>`;
                calHtml += `</tr></tbody></table>`;
                calHtml += `<div class="class-days-row">Class days: ${sd}</div>`;

                const monthMarks = Object.entries(savedMarks)
                    .filter(([k]) => { const [ky,km] = k.split('-').map(Number); return ky===y && km===m; })
                    .sort((a,b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));

                const monthNotes = Object.entries(savedRemarks)
                    .filter(([k]) => { const [ky,km] = k.split('-').map(Number); return ky===y && km===m && !savedMarks[k]; })
                    .map(([k]) => [k, '__note_only__']);

                let combined = [...monthMarks, ...monthNotes];
                if (sameStartEnd && isOpeningMonth && openingDay) {
                    combined.push([mkKey(openingYear, openingMonth, openingDay), '__start_end__']);
                } else {
                    if (isOpeningMonth && openingDay) combined.push([mkKey(openingYear, openingMonth, openingDay), '__start__']);
                    if (isClosingMonth && closingDay) combined.push([mkKey(closingYear, closingMonth, closingDay), '__end__']);
                }
                combined.sort((a,b) => parseInt(a[0].split('-')[2]) - parseInt(b[0].split('-')[2]));

                let actHtml = `<div class="month-name">${mName.toUpperCase()}</div><ul class="activity-list">`;
                if (!combined.length) {
                    actHtml += `<li><span class="act-date" style="color:#94a3b8;">—</span> <span style="color:#94a3b8;">No activities marked</span></li>`;
                } else {
                    const grouped = [];
                    combined.forEach(([k, type]) => {
                        const day    = parseInt(k.split('-')[2], 10);
                        const remark = savedRemarks[k] || '';
                        const last   = grouped[grouped.length - 1];
                        const canMerge = !!last && last.type === type && last.remark === remark && day === last.endDay + 1
                            && type !== '__note_only__' && type !== '__start__' && type !== '__end__' && type !== '__start_end__';
                        if (canMerge) { last.endDay = day; } else { grouped.push({ type, remark, startDay: day, endDay: day }); }
                    });
                    grouped.forEach(({ type, remark, startDay, endDay }) => {
                        const dayLabel = startDay === endDay ? String(startDay) : `${startDay}-${endDay}`;
                        const rmk = remark ? ` — <em style="color:#475569;">${e(remark)}</em>` : '';
                        if (type === '__start_end__') { actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:13px;border-radius:6px;background:#0a1f3d;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;letter-spacing:.5px;padding:0 5px;">START/END</span> <strong>Start and End of Classes</strong></li>`; return; }
                        if (type === '__start__')     { actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#0a1f3d;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;">★</span> <strong>Start of Classes</strong></li>`; return; }
                        if (type === '__end__')       { actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:13px;border-radius:6px;background:#991b1b;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;letter-spacing:.5px;padding:0 5px;">END</span> <strong>End of Classes</strong></li>`; return; }
                        if (type === '__note_only__') { actHtml += `<li><span class="act-date">${dayLabel}</span> <span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#0f172a;color:#fff;font-size:8px;font-weight:900;flex-shrink:0;">✎</span> <strong>Note</strong>${rmk}</li>`; return; }
                        const leg = legends[type] || { label: type, color: '#64748b', symbol: '●' };
                        if (type === 'holiday' || type === 'activity' || type === 'exam') {
                            actHtml += `<li><span class="act-date">${dayLabel}</span> ${symSvg(type, leg.color || '#64748b', 12)} ${e(leg.label)}${rmk}</li>`;
                        } else {
                            /* Custom legend entry — swatch pill matches the
                               color used in the day cell above. */
                            actHtml += `<li><span class="act-date">${dayLabel}</span> <span class="custom-mark-pill custom-mark-pill-sm" style="background:${leg.color || '#64748b'};"></span> ${e(leg.label)}${rmk}</li>`;
                        }
                    });
                }
                actHtml += `</ul>`;

                html += `
                    <div class="month-block">
                        <div class="mb-left">${actHtml}</div>
                        <div class="mb-right">${calHtml}</div>
                    </div>`;
            });
            return html;
        };

        const monthGrid1 = buildMonthGrid(ACAD_MONTHS.slice(0, 6));
        const monthGrid2 = buildMonthGrid(ACAD_MONTHS.slice(6));

        return `
            <div class="doc-page active" id="pg-cover">
                <div class="paper-section-label"><i class="fa-solid fa-book-open"></i> Page 1 — Cover Page</div>
                <div class="paper">
                    ${lh()}
                    <div class="cover-body">
                        <div class="cover-title">${e(deptShort)}<br>School Calendar</div>
                        <div class="cover-sy">S.Y. ${syRange}</div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-transmittal">
                <div class="paper-section-label"><i class="fa-solid fa-envelope"></i> Page 2 — Transmittal Letter</div>
                <div class="paper">
                    ${lh()}
                    <div class="doc-body">
                        <div class="addressee-block">
                            <div class="adname">${e(rdName)}</div>
                            <div class="adpos">${e(rdPos)}</div>
                            <div class="adpos">${e(rdOffice)}</div>
                        </div>
                        <div class="thru-block">
                            <span class="thru-lbl">Thru: </span><span class="adname">${e(sdsName)}</span>
                            <div class="adpos">${e(sdsPos)}</div>
                            <div class="adpos">${e(sdsOffice)}</div>
                            <div class="adpos">${e(sdsCity)}</div>
                        </div>
                        <p class="salutation">Dear Sir/Ma'am,</p>
                        <p>Greetings in Christ!</p>
                        <p class="indent">We are pleased to submit to your good office the documents listed below of for the School Year <strong>${syRange}</strong> for your review and consideration.</p>
                        <p style="margin-top:14px">The following documents are attached:</p>
                        <ul class="doc-list">${attachedList}</ul>
                        <p class="indent">We are pleased to inform your good office that will commence its school year <strong>${syRange}</strong> on <span>${openingLabel}</span>, and conclude on <span>${closingLabel}</span>. Our primary mode of instruction will be full face-to-face learning. This calendar ensures a total of <span>${grandTotal}</span> days in full compliance with Department of Education policies. Thank you so much and God bless!</p>
                        <div class="closing-block">
                            <div class="closing">Sincerely,</div>
                            <div class="sig-name">${e(principal)}</div>
                            <div class="sig-title">${e(prinTitle)}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-loi-cover">
                <div class="paper-section-label"><i class="fa-solid fa-file-signature"></i> Page 3 — Letter of Intent (Cover)</div>
                <div class="paper">
                    ${lh()}
                    <div class="loi-cover-body">
                        <div class="loi-cover-title">Letter of Intent</div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-loi">
                <div class="paper-section-label"><i class="fa-solid fa-pen-nib"></i> Page 4 — Letter of Intent</div>
                <div class="paper">
                    ${lh()}
                    <div class="doc-body">
                        <div class="addressee-block">
                            <div class="adname">${e(rdName)}</div>
                            <div class="adpos">${e(rdPos)}</div>
                            <div class="adpos">${e(rdOffice)}</div>
                        </div>
                        <div class="thru-block">
                            <span class="thru-lbl">Thru: </span><span class="adname">${e(sdsName)}</span>
                            <div class="adpos">${e(sdsPos)}</div>
                            <div class="adpos">${e(sdsOffice)}</div>
                            <div class="adpos">${e(sdsCity)}</div>
                        </div>
                        <p class="salutation">Dear Sir/Ma'am,</p>
                        <p>Greetings of peace!</p>
                        <p class="indent">${e(loiP1)}</p>
                        <p class="indent">${e(loiP2)}</p>
                        <p>${e(loiClosing)}</p>
                        <div class="closing-block">
                            <div class="closing">Truly yours,</div>
                            <div class="sig-name">${e(principal)}</div>
                            <div class="sig-title">${e(prinTitle)}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-cal-cover">
                <div class="paper-section-label"><i class="fa-solid fa-calendar"></i> Page 5 — School Calendar Cover</div>
                <div class="paper">
                    ${lh()}
                    <div class="cal-cover-body">
                        <div class="cal-cover-title">School Calendar<br>for</div>
                        <div class="cal-cover-sy">S.Y. ${syRange}</div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-summary">
                <div class="paper-section-label"><i class="fa-solid fa-table-list"></i> Page 6 — Calendar Summary</div>
                <div class="paper">
                    ${lh()}
                    <div class="summary-table-wrap" style="padding-top:22px">
                        <div class="summary-heading">${e(dept.toUpperCase())} SCHOOL CALENDAR<br>FOR SCHOOL YEAR ${syRange}</div>
                        <table class="summary-table">
                            <thead><tr><th style="width:60%">MONTH</th><th>SCHOOL DAYS</th></tr></thead>
                            <tbody>${summaryRows}</tbody>
                        </table>
                        <div class="sig-grid" style="margin-top:22px">
                            <div class="sig-col">
                                <div class="sig-role">Prepared By:</div>
                                <div class="sig-name">${e(principal)}</div>
                                <div class="sig-pos">${e(prinTitle)}</div>
                            </div>
                        </div>
                        <div style="padding:0 32px 7px">
                            <div style="font-family:var(--serif);font-size:12.5px;margin-bottom:18px;">Recommending Approval:</div>
                            <div class="sig-name">${e(rec)}</div>
                            <div class="sig-pos">${e(recPos)}</div>
                            <div class="sig-org">${e(recOrg)}</div>
                            <div style="font-family:var(--serif);font-size:12.5px;margin:22px 0 18px;">Approved:</div>
                            <div class="sig-name">${e(approved)}</div>
                            <div class="sig-pos">${e(appPos)}</div>
                            <div class="sig-org">${e(appOrg)}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-summary-term">
                <div class="paper-section-label"><i class="fa-solid fa-layer-group"></i> Page 7 — School Days per ${e(periodCfg.label === 'SEMESTER' ? 'Semester' : periodCfg.label === 'TRIMESTER' ? 'Trimester' : 'Quarter')}</div>
                <div class="paper">
                    ${lh()}
                    <div class="summary-table-wrap" style="padding-top:12px">
                        <div class="summary-heading">${e(dept.toUpperCase())} SCHOOL CALENDAR<br>FOR SCHOOL YEAR ${syRange}</div>
                        <table class="summary-table term-days-table">
                            <thead><tr><th style="width:60%">MONTH</th><th>SCHOOL DAYS</th></tr></thead>
                            <tbody>${termRows}</tbody>
                        </table>
                        <div class="sig-grid" style="margin-top:12px">
                            <div class="sig-col">
                                <div class="sig-role">Prepared By:</div>
                                <div class="sig-name">${e(principal)}</div>
                                <div class="sig-pos">${e(prinTitle)}</div>
                            </div>
                        </div>
                        <div style="padding:0 32px 4px">
                            <div style="font-family:var(--serif);font-size:12px;margin-bottom:10px;">Recommending Approval:</div>
                            <div class="sig-name">${e(rec)}</div>
                            <div class="sig-pos">${e(recPos)}</div>
                            <div class="sig-org">${e(recOrg)}</div>
                            <div style="font-family:var(--serif);font-size:12px;margin:12px 0 10px;">Approved:</div>
                            <div class="sig-name">${e(approved)}</div>
                            <div class="sig-pos">${e(appPos)}</div>
                            <div class="sig-org">${e(appOrg)}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-checklist">
                <div class="paper-section-label"><i class="fa-solid fa-clipboard-list"></i> Page 8 — Checklist</div>
                <div class="paper">
                    ${lh()}
                    <div class="checklist-meta">
                        <div class="checklist-meta-row"><span class="chk-label">Name of School:</span><span class="chk-value">${e(school)}</span></div>
                        <div class="checklist-meta-row"><span class="chk-label">Location/Address:</span><span class="chk-value">${e((form.f_chk_address||'').trim())}</span></div>
                        <div class="checklist-meta-row"><span class="chk-label">School ID:</span><span class="chk-value">${e(sid)}</span></div>
                        <div class="checklist-meta-row"><span class="chk-label">Proposed:</span><span class="chk-value">${e((form.f_chk_proposed||'').trim())}</span></div>
                    </div>
                    <div class="checklist-rule"></div>
                    <div class="checklist-table-title">CHECKLIST FOR SUBMISSION OF CALENDAR ACTIVITIES</div>
                    <table class="checklist-table">
                        <thead><tr><th style="width:40px">No.</th><th>Requirements</th><th style="width:150px">Remarks</th></tr></thead>
                        <tbody>${chkRows}</tbody>
                    </table>
                    <div class="checklist-footer">
                        <div class="checklist-checked-label">Checked by:</div>
                        <div class="checklist-checked-line">${e((form.f_chk_checked_by||'').trim())}</div>
                    </div>
                </div>
            </div>

            <div class="doc-page active" id="pg-monthly">
                <div class="paper-section-label"><i class="fa-solid fa-calendar-days"></i> Pages 9–10 — Monthly Calendar Detail</div>
                <div class="paper">
                    ${lh()}
                    <div class="monthly-wrap" style="padding-top:14px">
                        <div class="monthly-heading">SCHOOL CALENDAR FOR SCHOOL YEAR ${syRange}</div>
                        <div>${monthGrid1}</div>
                    </div>
                </div>
                <div class="paper">
                    ${lh()}
                    <div class="monthly-wrap" style="padding-top:14px">
                        <div class="monthly-heading">SCHOOL CALENDAR FOR SCHOOL YEAR ${syRange}</div>
                        <div>${monthGrid2}</div>
                        <div class="legend-box" style="margin-top:18px">
                            <div class="leg-title">Legend:</div>
                            <div class="legend-item"><span style="font-size:12px;font-weight:700;text-decoration:line-through;color:#dc2626;">X</span> — Declared Holidays</div>
                            <div class="legend-item"><span style="display:inline-block;width:13px;height:13px;border:1.5px solid #374151;"></span> — School activities for teachers, personnel, and other stakeholders</div>
                            <div class="legend-item"><span style="font-size:12px;color:#374151;">△</span> — Administration of Quarter examination</div>
                            <div class="legend-item"><span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:#0a1f3d;color:#fff;font-size:8px;font-weight:900;">★</span> — Start of Classes</div>
                            <div class="legend-item"><span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:#991b1b;color:#fff;font-size:8px;font-weight:900;">■</span> — End of Classes</div>
                            ${Object.keys(legends).filter(k => !DEFAULT_LEGENDS[k]).map(k => {
                                const leg = legends[k];
                                return `<div class="legend-item"><span class="custom-mark-pill custom-mark-pill-sm" style="background:${leg.color || '#64748b'};"></span><span>— ${e(leg.label || k)}</span></div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    async function loadInlineFilePreview(url, name, rawPath) {
        const host = document.getElementById('adsInlineFilePreview');
        if (!host) return;
        const targetUrl = toAbsoluteUrl(url);

        if (!isSameOriginUrl(targetUrl)) {
            host.innerHTML = `<div class="ads-fp-unsupported">
                <i class="fa-solid fa-up-right-from-square"></i>
                <p>This file is hosted on another domain and cannot be embedded here.</p>
                <button class="dsd-no-preview-btn" onclick="ADS.openFile('${escJsSingle(rawPath || targetUrl || url)}')">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Open file
                </button>
            </div>`;
            return;
        }

        host.innerHTML = `<div class="ads-fp-unsupported">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <p>Loading preview…</p>
        </div>`;

        try {
            const res = await fetch(targetUrl, { credentials: 'include' });
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const ct = res.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) { const json = await res.json(); throw new Error(json.message || 'File not available'); }
            const blob    = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            host.innerHTML = `<iframe class="ads-preview-frame" src="${esc(blobUrl)}" title="${esc(name || 'Document')}"></iframe>`;
            setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        } catch (err) {
            host.innerHTML = `<div class="ads-fp-unsupported">
                <i class="fa-solid fa-circle-exclamation"></i>
                <p>Could not load PDF: ${esc(err.message || 'Unknown error')}</p>
                <button class="dsd-no-preview-btn" onclick="ADS.openFile('${escJsSingle(rawPath || url)}')">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Open file
                </button>
            </div>`;
        }
    }

    async function openFilePreview(path, fileName) {
        if (!path) return;
        const raw = String(path).trim();
        if (!raw)  return;

        const url = toAbsoluteUrl(raw);
        const name = fileName || raw.split('/').pop().split('?')[0] || 'File';
        const ext  = fileExt(fileName || raw);
        const canFramePreview = isSameOriginUrl(url);

        _ensurePreviewModal();

        const overlay = document.getElementById('adsFilePreviewOverlay');
        const titleEl = document.getElementById('adsFilePreviewTitle');
        const bodyEl  = document.getElementById('adsFilePreviewBody');
        const openBtn = document.getElementById('adsFilePreviewOpenBtn');

        if (titleEl) titleEl.textContent = name;

        bodyEl.innerHTML = `<div class="ads-fp-unsupported"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading preview…</p></div>`;
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';

        if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
            try {
                const res = await fetch(url, { credentials: 'include' });
                const blob    = await res.blob();
                const blobUrl = URL.createObjectURL(blob);
                bodyEl.innerHTML = `<div class="ads-fp-img-wrap"><img class="ads-fp-img" src="${esc(blobUrl)}" alt="${esc(name)}"></div>`;
                if (openBtn) openBtn.href = blobUrl;
                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
            } catch (err) {
                bodyEl.innerHTML = `<div class="ads-fp-unsupported"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load image: ${esc(err.message)}</p></div>`;
            }

        } else if (ext === 'pdf') {
            if (!canFramePreview) {
                bodyEl.innerHTML = `<div class="ads-fp-unsupported">
                    <i class="fa-solid fa-up-right-from-square"></i>
                    <p>This PDF is hosted on another domain and cannot be embedded here.</p>
                    <button class="dsd-no-preview-btn" onclick="ADS.openFile('${escJsSingle(raw)}')">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open file
                    </button>
                </div>`;
                if (openBtn) openBtn.href = url;
                return;
            }
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) throw new Error(`Server returned ${res.status}`);
                const ct = res.headers.get('Content-Type') || '';
                if (ct.includes('application/json')) { const json = await res.json(); throw new Error(json.message || 'File not available'); }
                const blob    = await res.blob();
                const blobUrl = URL.createObjectURL(blob);
                bodyEl.innerHTML = `<iframe class="ads-fp-iframe" src="${esc(blobUrl)}" title="${esc(name)}"></iframe>`;
                if (openBtn) openBtn.href = blobUrl;
                setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
            } catch (err) {
                bodyEl.innerHTML = `<div class="ads-fp-unsupported"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load PDF: ${esc(err.message)}</p></div>`;
            }

        } else if (ext === 'doc' || ext === 'docx') {
            bodyEl.innerHTML = `<div class="ads-fp-unsupported"><i class="fa-solid fa-file-word"></i><p>Word files are opened in a new tab to match portal behavior.</p></div>`;
            if (openBtn) openBtn.href = url;
        } else {
            bodyEl.innerHTML = `<div class="ads-fp-unsupported"><i class="fa-solid fa-file-circle-question"></i><p>This file type (<strong>${esc(ext || 'unknown')}</strong>) cannot be previewed.</p></div>`;
        }
    }

    function openFile(path) {
        if (!path) return;
        const raw = String(path).trim();
        if (!raw) return;
        let target = raw;
        if (!/^https?:\/\//i.test(raw)) target = new URL(raw, raw.startsWith('/') ? window.location.origin : window.location.href).toString();
        window.open(target, '_blank', 'noopener');
    }

    function closeFilePreview() {
        const overlay = document.getElementById('adsFilePreviewOverlay');
        if (!overlay) return;
        overlay.classList.remove('open');
        document.body.style.overflow = '';
        const body = document.getElementById('adsFilePreviewBody');
        if (body) body.innerHTML = '';
        detailRecordId = null;
    }

    function toggleDetailPreview() {
        const panel   = document.getElementById('adsPreviewPanel');
        const layout  = document.getElementById('adsDetailLayout');
        const icon    = document.getElementById('adsTogglePreviewIcon');
        const label   = document.getElementById('adsTogglePreviewLabel');
        if (!panel) return;

        const isHidden = panel.classList.contains('preview-hidden');

        if (isHidden) {
            panel.classList.remove('preview-hidden');
            layout?.classList.remove('preview-hidden');
            if (icon)  { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
            if (label) label.textContent = 'Hide Document Preview';
        } else {
            panel.classList.add('preview-hidden');
            layout?.classList.add('preview-hidden');
            if (icon)  { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
            if (label) label.textContent = 'Show Document Preview';
        }
    }

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

    function toggleMobileSidebar() {
        document.getElementById('sidebar')?.classList.toggle('mobile-open');
        document.getElementById('sidebarBackdrop')?.classList.toggle('open');
    }

    function closeMobileSidebar() {
        document.getElementById('sidebar')?.classList.remove('mobile-open');
        document.getElementById('sidebarBackdrop')?.classList.remove('open');
    }

    async function init() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.classList.remove('hidden');
        try {
            const ok = await checkAuthentication();
            if (!ok) return;

            document.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="toggle-menu"]')) return;
                closeAllDownloadMenus();
            });
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') { closeAllDownloadMenus(); closeFilePreview(); }
            });

            // Search and type filter are rendered dynamically inside renderCards;
            // their events are wired via inline handlers (ADS._onSearchInput / ADS._onTypeChange).

            await fetchRecords();
        } finally {
            // Always hide the overlay — even if auth fails or an error is thrown.
            // Without this, the overlay stays on screen on mobile and blocks all taps,
            // including the hamburger button that opens the sidebar.
            if (overlay) overlay.classList.add('hidden');
        }
    }

    return {
        init,
        navigate,
        toggleSubmenu,
        toggleMobileSidebar,
        closeMobileSidebar,
        openPreview,
        toggleDownloadMenu,
        downloadSubmission,
        openCard,
        openDetailModal,
        closeDetailModal,
        saveDetailStatus,
        approveEditRequest,
        openFile,
        openFilePreview,
        closeFilePreview,
        generateIndorsementFromRecord,
        printCalendarPreview,
        printTuitionPreview,
        exportSubmittedTuitionWord,
        openSupportingUpload,
        toggleDetailPreview,
        switchTab,
        _onSearchInput,
        _onTypeChange,
        _onStatusChange,
    };
})();

window.ADS = ADS;

function navigate(sectionName)    { ADS.navigate(sectionName); }
function toggleSubmenu(name)      { ADS.toggleSubmenu(name); }
function toggleMobileSidebar()    { ADS.toggleMobileSidebar(); }
function closeMobileSidebar()     { ADS.closeMobileSidebar(); }

async function logout() {
    const btn = document.getElementById('logoutBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging out…'; }
    try {
        await fetch(`${CONFIG.API_URL}/logout.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
    } catch (_) {
        // Network errors ignored — cookie expiry handles server-side invalidation
    } finally {
        clearSessionAndRedirect();
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

document.addEventListener('DOMContentLoaded', () => { ADS.init(); });