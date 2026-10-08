/**
 * documents-submitted.js
 * Admin modal: lists School Calendar submissions with detail view, status update, and download actions.
 */

const DS = (() => {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────────
    let _records      = [];
    let _filterStatus = 'all';
    let _searchQuery  = '';
    let _detailId     = null;   // currently-open detail record id
    let _editingId    = null;   // record being status-updated

    // ── Calendar-specific statuses ─────────────────────────────────────────
    const STATUS_MAP = {
        'Pending Review':           { cls: 'ds-pending',     icon: 'fa-clock',          dot: '#d97706' },
        'Approved':                 { cls: 'ds-approved',    icon: 'fa-circle-check',   dot: '#16a34a' },
        'Returned for Correction':  { cls: 'ds-returned',    icon: 'fa-circle-xmark',   dot: '#dc2626' },
        'For Endorsement':          { cls: 'ds-endorsement', icon: 'fa-file-signature', dot: '#0369a1' },
        'Released to School':       { cls: 'ds-released',    icon: 'fa-paper-plane',    dot: '#7c3aed' },
    };

    // ── Helpers ────────────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function apiUrl(path) {
        return (typeof CONFIG !== 'undefined' && CONFIG.API_URL)
            ? CONFIG.API_URL + path : path;
    }
    function formatDate(str) {
        if (!str) return '—';
        try {
            return new Date(str).toLocaleDateString('en-PH', {
                year: 'numeric', month: 'short', day: 'numeric'
            });
        } catch (e) { return str; }
    }
    function formatDateTime(str) {
        if (!str) return '—';
        try {
            return new Date(str).toLocaleString('en-PH', {
                dateStyle: 'medium', timeStyle: 'short'
            });
        } catch (e) { return str; }
    }
    function statusMeta(status) {
        return STATUS_MAP[status] || { cls: 'ds-pending', icon: 'fa-clock', dot: '#9ca3af' };
    }

    // ── Fetch ──────────────────────────────────────────────────────────────
    async function fetchRecords() {
        _showBodyState('loading');
        try {
            const res  = await fetch(apiUrl('/documents-submitted.php?action=list'), { credentials: 'include' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load.');
            _records = json.records || [];
            _renderStats();
            _renderCards();
        } catch (e) {
            _showBodyState('error', e.message || 'Could not load records.');
        }
    }

    // ── Body states ────────────────────────────────────────────────────────
    function _showBodyState(state, msg) {
        const body = document.getElementById('dsBody');
        if (!body) return;
        if (state === 'loading') {
            body.innerHTML = `<div class="ds-loading"><div class="ds-spinner"></div><p>Loading submissions…</p></div>`;
        } else if (state === 'error') {
            body.innerHTML = `<div class="ds-empty"><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626"></i><p>${esc(msg)}</p></div>`;
        }
    }

    // ── Stats bar ──────────────────────────────────────────────────────────
    function _renderStats() {
        const bar = document.getElementById('dsStatsBar');
        if (!bar) return;
        const counts = {};
        _records.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
        let html = `<span class="ds-total-count">${_records.length} submission${_records.length !== 1 ? 's' : ''}</span>`;
        Object.entries(STATUS_MAP).forEach(([status, meta]) => {
            if (counts[status]) {
                html += `<div class="ds-stat-chip ${meta.cls}">
                    <i class="fa-solid ${meta.icon}"></i>
                    <span>${counts[status]}</span>
                    <span>${esc(status)}</span>
                </div>`;
            }
        });
        bar.innerHTML = html;
    }

    // ── Card grid ──────────────────────────────────────────────────────────
    function _renderCards() {
        const body  = document.getElementById('dsBody');
        const count = document.getElementById('dsFooterCount');
        if (!body) return;

        let filtered = _records;
        if (_filterStatus !== 'all') {
            filtered = filtered.filter(r => r.status === _filterStatus);
        }
        if (_searchQuery) {
            const q = _searchQuery.toLowerCase();
            filtered = filtered.filter(r =>
                (r.school_name  || '').toLowerCase().includes(q) ||
                (r.submitted_by || '').toLowerCase().includes(q) ||
                (r.status       || '').toLowerCase().includes(q) ||
                (r.remarks      || '').toLowerCase().includes(q)
            );
        }

        if (count) count.textContent = filtered.length + ' record' + (filtered.length !== 1 ? 's' : '');

        if (!filtered.length) {
            body.innerHTML = `<div class="ds-empty">
                <i class="fa-solid fa-folder-open"></i>
                <p>${_searchQuery || _filterStatus !== 'all' ? 'No records match your filter.' : 'No calendar submissions yet.'}</p>
            </div>`;
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'ds-cards-grid';
        grid.innerHTML = filtered.map(r => _cardHtml(r)).join('');
        body.innerHTML = '';
        body.appendChild(grid);
    }

    function _cardHtml(r) {
        const meta = statusMeta(r.status);
        const syStr = (r.school_year || '').trim() ||
            (() => {
                // Try to extract SY from title e.g. "School Calendar - Name (2026-2027)"
                const m = (r.title || '').match(/\((\d{4}-\d{4})\)/);
                return m ? m[1] : '—';
            })();

        return `
        <div class="ds-card" onclick="DS.openDetail(${r.id})">
            <div class="ds-card-inner">
                <div class="ds-card-header">
                    <span class="ds-status-badge ${meta.cls}">
                        <i class="fa-solid ${meta.icon}"></i>${esc(r.status)}
                    </span>
                    <span class="ds-card-date">${formatDate(r.date_submitted)}</span>
                </div>
                <div class="ds-card-school">${esc(r.school_name || r.title || '—')}</div>
                <div class="ds-card-sub">
                    <span><i class="fa-solid fa-calendar-range"></i> S.Y. ${esc(syStr)}</span>
                    ${r.submitted_by ? `<span><i class="fa-solid fa-user"></i> ${esc(r.submitted_by)}</span>` : ''}
                </div>
                ${r.remarks ? `<div class="ds-card-remarks"><i class="fa-solid fa-comment-dots"></i>${esc(r.remarks)}</div>` : ''}
            </div>
            <div class="ds-card-footer" onclick="event.stopPropagation()">
                <button class="ds-action-btn" onclick="DS.openDetail(${r.id})">
                    <i class="fa-solid fa-eye"></i> View
                </button>
                <button class="ds-action-btn ds-action-download" onclick="DS.downloadRecord(${r.id}, 'pdf')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-file-pdf"></i> Download PDF
                </button>
                <button class="ds-action-btn ds-action-primary" onclick="DS.openStatusForm(${r.id})">
                    <i class="fa-solid fa-pen-to-square"></i> Update Status
                </button>
            </div>
        </div>`;
    }

    // ── Main Modal ─────────────────────────────────────────────────────────
    function openModal() {
        const overlay = document.getElementById('dsOverlay');
        if (!overlay) return;
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        fetchRecords();
    }

    function closeModal(e) {
        if (e && e.target !== e.currentTarget) return;
        const overlay = document.getElementById('dsOverlay');
        if (!overlay) return;
        overlay.classList.remove('open');
        document.body.style.overflow = '';
    }

    function setFilter(status, btn) {
        _filterStatus = status;
        document.querySelectorAll('.ds-fpill').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        _renderCards();
    }

    function onSearch(val) {
        _searchQuery = val;
        _renderCards();
    }

    function downloadRecord(id, format = 'pdf') {
        const rec = _records.find(x => x.id === id);
        if (!rec) {
            _showToast('Record not found.', 'error');
            return;
        }
        const fmt = String(format || '').toLowerCase();
        if (!['pdf', 'word', 'json'].includes(fmt)) {
            _showToast('Unsupported download format.', 'error');
            return;
        }

        const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=${encodeURIComponent(fmt)}`);
        window.open(url, '_blank', 'noopener');
    }

    function previewRecord(id, format = 'pdf') {
        const rec = _records.find(x => x.id === id);
        if (!rec) {
            _showToast('Record not found.', 'error');
            return;
        }
        const fmt = String(format || '').toLowerCase();
        if (!['pdf', 'word', 'json'].includes(fmt)) {
            _showToast('Unsupported preview format.', 'error');
            return;
        }

        const url = apiUrl(`/documents-submitted.php?action=download&id=${encodeURIComponent(id)}&format=${encodeURIComponent(fmt)}&preview=1`);
        window.open(url, '_blank', 'noopener');
    }

    function openBuilderPreview(id) {
        const rec = _records.find(x => x.id === id);
        if (!rec) {
            _showToast('Record not found.', 'error');
            return;
        }
        if (!rec.calendar_document_id) {
            _showToast('No calendar document linked to this record.', 'error');
            return;
        }
        const url = apiUrl(`/documents-submitted.php?action=builder_preview&id=${encodeURIComponent(id)}&_t=${Date.now()}`);
        window.open(url, '_blank', 'noopener');
    }

    // ── Inline File Preview ────────────────────────────────────────────────
    function _escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fileExt(nameOrPath) {
        const v = String(nameOrPath || '').trim();
        const clean = v.split('?')[0].split('#')[0];
        const idx = clean.lastIndexOf('.');
        return idx < 0 ? '' : clean.slice(idx + 1).toLowerCase();
    }

    function _ensurePreviewModal() {
        if (document.getElementById('dsFpOverlay')) return;
        const el = document.createElement('div');
        el.id = 'dsFpOverlay';
        el.className = 'ads-fp-overlay';
        el.innerHTML = `
            <div class="ads-fp-modal" onclick="event.stopPropagation()">
                <div class="ads-fp-header">
                    <span class="ads-fp-title" id="dsFpTitle"></span>
                    <div class="ads-fp-header-actions">
                        <a class="ads-fp-open-btn" id="dsFpOpenBtn" target="_blank" rel="noopener">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open in new tab
                        </a>
                        <button class="ads-fp-close-btn" onclick="DS.closeFilePreview()">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div class="ads-fp-body" id="dsFpBody"></div>
            </div>`;
        el.addEventListener('click', (e) => { if (e.target === el) DS.closeFilePreview(); });
        document.body.appendChild(el);
    }

    function openFilePreview(path, fileName) {
        if (!path) return;
        const raw = String(path).trim();
        if (!raw) return;

        let url = raw;
        if (!/^https?:\/\//i.test(raw)) {
            const base = raw.startsWith('/') ? window.location.origin : window.location.href;
            url = new URL(raw, base).toString();
        }

        const name = fileName || raw.split('/').pop().split('?')[0] || 'File';
        const ext = _fileExt(fileName || raw);

        _ensurePreviewModal();

        const overlay = document.getElementById('dsFpOverlay');
        const titleEl = document.getElementById('dsFpTitle');
        const openBtn = document.getElementById('dsFpOpenBtn');
        const bodyEl  = document.getElementById('dsFpBody');

        if (titleEl) titleEl.textContent = name;
        if (openBtn) openBtn.href = url;

        if (ext === 'pdf') {
            bodyEl.innerHTML = `<iframe class="ads-fp-iframe" src="${_escHtml(url)}" title="${_escHtml(name)}"></iframe>`;
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            bodyEl.innerHTML = `<div class="ads-fp-img-wrap"><img class="ads-fp-img" src="${_escHtml(url)}" alt="${_escHtml(name)}"></div>`;
        } else if (ext === 'doc' || ext === 'docx') {
            const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`;
            bodyEl.innerHTML = `<iframe class="ads-fp-iframe" src="${_escHtml(viewerUrl)}" title="${_escHtml(name)}"></iframe>`;
        } else {
            bodyEl.innerHTML = `
                <div class="ads-fp-unsupported">
                    <i class="fa-solid fa-file-circle-question"></i>
                    <p>This file type (<strong>${_escHtml(ext || 'unknown')}</strong>) cannot be previewed in the browser.</p>
                    <a class="ads-fp-download-btn" href="${_escHtml(url)}" download target="_blank" rel="noopener">
                        <i class="fa-solid fa-file-arrow-down"></i> Download File
                    </a>
                </div>`;
        }

        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function closeFilePreview() {
        const overlay = document.getElementById('dsFpOverlay');
        if (!overlay) return;
        overlay.classList.remove('open');
        document.body.style.overflow = '';
        const body = document.getElementById('dsFpBody');
        if (body) body.innerHTML = '';
    }

    // ── Detail Modal ───────────────────────────────────────────────────────
    async function openDetail(id) {
        _detailId = id;
        const r = _records.find(x => x.id === id);
        if (!r) return;

        const overlay = document.getElementById('dsdOverlay');
        if (!overlay) return;

        const meta = statusMeta(r.status);

        // Set title
        const titleEl = document.getElementById('dsdTitle');
        if (titleEl) titleEl.textContent = r.school_name || r.title || 'Submission Detail';

        // Render skeleton while preview loads
        const bodyEl = document.getElementById('dsdBody');
        if (bodyEl) bodyEl.innerHTML = _detailSkeletonHtml(r, meta);

        // Actions
        const actEl = document.getElementById('dsdActions');
        // Store file info on the overlay element so inline onclick can safely reference it
        // without JS string injection risk.
        if (overlay) {
            overlay.dataset.filePath = r.file_path || '';
            overlay.dataset.fileName = r.file_name || '';
        }

        if (actEl) {
            const hasUploadedFile = !!r.file_path;
            actEl.innerHTML = `
                <button class="dsd-btn-secondary" onclick="DS.openStatusForm(${r.id}); DS.closeDetail();">
                    <i class="fa-solid fa-pen-to-square"></i> Update Status
                </button>
                <button class="dsd-btn-secondary" onclick="DS.openBuilderPreview(${r.id})" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-table-cells-large"></i> Preview Mode
                </button>
                <button class="dsd-btn-secondary" onclick="DS.previewRecord(${r.id}, 'pdf')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-eye"></i> Preview PDF
                </button>
                <button class="dsd-btn-secondary" onclick="DS.previewRecord(${r.id}, 'word')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-eye"></i> Preview Word
                </button>
                <button class="dsd-btn-secondary" id="dsdPreviewFileBtn" onclick="DS._previewFileFromDetail()" ${hasUploadedFile ? '' : 'disabled'}>
                    <i class="fa-solid fa-magnifying-glass"></i> Preview File
                </button>
                <button class="dsd-btn-primary" onclick="DS.downloadRecord(${r.id}, 'pdf')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-file-pdf"></i> Download PDF
                </button>
                <button class="dsd-btn-primary" onclick="DS.downloadRecord(${r.id}, 'word')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-file-word"></i> Download Word
                </button>
                <button class="dsd-btn-primary" onclick="DS.downloadRecord(${r.id}, 'json')" ${r.calendar_document_id ? '' : 'disabled'}>
                    <i class="fa-solid fa-file-code"></i> Download JSON
                </button>
            `;
        }

        overlay.classList.add('open');

        // Load preview summary async
        if (r.calendar_document_id) {
            try {
                const res  = await fetch(apiUrl(`/documents-submitted.php?action=preview&id=${id}`), { credentials: 'include' });
                const json = await res.json();
                if (json.success && bodyEl) {
                    bodyEl.innerHTML = _detailFullHtml(r, meta, json.summary || null);
                }
            } catch (_) { /* keep skeleton */ }
        }
    }

    function _detailSkeletonHtml(r, meta) {
        return `
            <div class="dsd-status-hero ${meta.cls}">
                <div class="dsd-hero-icon"><i class="fa-solid ${meta.icon}"></i></div>
                <div>
                    <div class="dsd-hero-status">${esc(r.status)}</div>
                    <div class="dsd-hero-date">Submitted ${formatDate(r.date_submitted)}</div>
                </div>
            </div>
            <div class="dsd-section">
                <div class="dsd-section-title"><i class="fa-solid fa-circle-info"></i> Loading preview…</div>
                <div class="ds-loading" style="padding:20px 0"><div class="ds-spinner"></div></div>
            </div>`;
    }

    function _detailFullHtml(r, meta, summary) {
        // Base fields
        const syStr = (summary?.fields?.sy_from && summary?.fields?.sy_to)
            ? `${summary.fields.sy_from}–${summary.fields.sy_to}`
            : (r.school_year || '—');

        const schoolName  = summary?.fields?.school  || r.school_name || r.title || '—';
        const dept        = summary?.fields?.dept     || '—';
        const sid         = summary?.fields?.sid      || '—';
        const opening     = summary?.fields?.opening  || '—';
        const closing     = summary?.fields?.closing  || '—';
        const principal   = summary?.fields?.principal || '—';
        const totalDays   = summary?.total_school_days ?? '—';
        const marks       = summary?.mark_counts || {};

        const inRange     = typeof totalDays === 'number' && totalDays >= 200 && totalDays <= 220;
        const daysColor   = typeof totalDays !== 'number' ? '#6b7280'
                          : inRange ? '#16a34a'
                          : totalDays < 200 ? '#dc2626' : '#d97706';
        const daysIcon    = typeof totalDays !== 'number' ? 'fa-question'
                          : inRange ? 'fa-circle-check' : 'fa-triangle-exclamation';

        const fields = [
            { label: 'School / Institution', value: schoolName },
            { label: 'Department',           value: dept },
            { label: 'School ID',            value: sid },
            { label: 'School Year',          value: syStr },
            { label: 'Opening of Classes',   value: formatDate(opening) },
            { label: 'End of Classes',       value: formatDate(closing) },
            { label: 'Prepared By',          value: principal },
            { label: 'Submitted By',         value: r.submitted_by || '—' },
            { label: 'Date Submitted',       value: formatDate(r.date_submitted) },
            { label: 'Date Actioned',        value: r.date_actioned ? formatDate(r.date_actioned) : '—' },
        ];

        const fieldRows = fields.map(f => `
            <div class="dsd-field-row">
                <div class="dsd-field-label">${esc(f.label)}</div>
                <div class="dsd-field-value">${esc(f.value || '—')}</div>
            </div>`).join('');

        // School days summary
        const daysSummary = summary?.has_payload ? `
            <div class="dsd-days-card" style="border-color:${daysColor}20;background:${daysColor}08;">
                <div class="dsd-days-icon" style="color:${daysColor};">
                    <i class="fa-solid ${daysIcon}"></i>
                </div>
                <div class="dsd-days-body">
                    <div class="dsd-days-value" style="color:${daysColor};">${totalDays}</div>
                    <div class="dsd-days-label">Total School Days</div>
                    <div class="dsd-days-range" style="color:${daysColor};">
                        ${typeof totalDays === 'number'
                            ? (inRange ? 'Within required 200–220 range ✓'
                                       : (totalDays < 200 ? 'Below minimum of 200 days' : 'Exceeds maximum of 220 days'))
                            : 'Range unknown'}
                    </div>
                </div>
                <div class="dsd-days-marks">
                    <div class="dsd-mark-row"><span class="dsd-mark-x">✕</span><span>Holidays</span><strong>${marks.holiday || 0}</strong></div>
                    <div class="dsd-mark-row"><span class="dsd-mark-sq">□</span><span>Activities</span><strong>${marks.activity || 0}</strong></div>
                    <div class="dsd-mark-row"><span class="dsd-mark-tri">△</span><span>Exams</span><strong>${marks.exam || 0}</strong></div>
                </div>
            </div>` : '';

        // Status history timeline
        let historyHtml = '';
        const history = r.history || [];
        if (history.length) {
            historyHtml = `
                <div class="dsd-section">
                    <div class="dsd-section-title"><i class="fa-solid fa-clock-rotate-left"></i> Status History</div>
                    <div class="dsd-timeline">
                        ${history.map(h => {
                            const hm = statusMeta(h.status);
                            return `<div class="dsd-tl-item">
                                <div class="dsd-tl-dot ${hm.cls}">
                                    <i class="fa-solid ${hm.icon}"></i>
                                </div>
                                <div class="dsd-tl-content">
                                    <div class="dsd-tl-status">${esc(h.status)}</div>
                                    <div class="dsd-tl-ts">${formatDateTime(h.timestamp)}${h.by ? ' · ' + esc(h.by) : ''}</div>
                                    ${h.note ? `<div class="dsd-tl-note">${esc(h.note)}</div>` : ''}
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
        }

        // Remarks block
        const remarksHtml = r.remarks ? `
            <div class="dsd-section">
                <div class="dsd-section-title"><i class="fa-solid fa-comment-dots"></i> Remarks / Notes</div>
                <div class="dsd-remarks-box">${esc(r.remarks)}</div>
            </div>` : '';

        return `
            <div class="dsd-status-hero ${meta.cls}">
                <div class="dsd-hero-icon"><i class="fa-solid ${meta.icon}"></i></div>
                <div>
                    <div class="dsd-hero-status">${esc(r.status)}</div>
                    <div class="dsd-hero-date">${r.date_actioned ? 'Actioned ' + formatDate(r.date_actioned) : 'Submitted ' + formatDate(r.date_submitted)}</div>
                </div>
            </div>

            ${daysSummary}

            <div class="dsd-section">
                <div class="dsd-section-title"><i class="fa-solid fa-circle-info"></i> Submission Details</div>
                ${fieldRows}
            </div>

            ${remarksHtml}
            ${historyHtml}
        `;
    }

    function closeDetail(e) {
        if (e && e.target !== e.currentTarget) return;
        document.getElementById('dsdOverlay')?.classList.remove('open');
        _detailId = null;
    }

    // ── Status Update Form ─────────────────────────────────────────────────
    function openStatusForm(id) {
        _editingId = id;
        const r    = _records.find(x => x.id === id);
        if (!r) return;

        const overlay = document.getElementById('dsfOverlay');
        if (!overlay) return;

        // Build status buttons — use data attributes to avoid inline JS string encoding issues.
        const statusBtns = Object.entries(STATUS_MAP).map(([status, meta]) => {
            const active = r.status === status ? 'active' : '';
            return `<button type="button" class="dsf-status-btn ${active}" data-status="${esc(status)}">
                <i class="fa-solid ${meta.icon}"></i>${esc(status)}
            </button>`;
        }).join('');

        const modal = document.getElementById('dsfModal');
        if (modal) {
            document.getElementById('dsfTitle').textContent    = 'Update Submission Status';
            document.getElementById('dsfSchoolLabel').textContent = r.school_name || r.title || '';
            const wrap = document.getElementById('dsfStatusWrap');
            wrap.innerHTML = statusBtns;
            // Attach click handlers via JS rather than inline onclick to avoid encoding pitfalls.
            wrap.querySelectorAll('.dsf-status-btn').forEach(btn => {
                btn.addEventListener('click', () => DS._selectStatus(btn.dataset.status, btn));
            });
            document.getElementById('dsfRemarks').value         = r.remarks || '';
            document.getElementById('dsfStatusVal').value       = r.status || '';
            const msgEl = document.getElementById('dsfMsg');
            if (msgEl) { msgEl.className = 'dsf-msg'; msgEl.textContent = ''; }
        }

        overlay.classList.add('open');
    }

    function closeStatusForm(e) {
        if (e && e.target !== e.currentTarget) return;
        document.getElementById('dsfOverlay')?.classList.remove('open');
    }

    function _selectStatus(status, btn) {
        document.querySelectorAll('.dsf-status-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        const hid = document.getElementById('dsfStatusVal');
        if (hid) hid.value = status;
    }

    async function saveStatus() {
        const status  = (document.getElementById('dsfStatusVal')?.value || '').trim();
        const remarks = (document.getElementById('dsfRemarks')?.value   || '').trim();
        const msgEl   = document.getElementById('dsfMsg');
        const saveBtn = document.getElementById('dsfSaveBtn');

        function showErr(m) {
            if (msgEl) { msgEl.textContent = m; msgEl.className = 'dsf-msg error'; }
        }
        if (!status)  return showErr('Please select a status.');

        if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
        if (msgEl) { msgEl.className = 'dsf-msg'; msgEl.textContent = ''; }

        try {
            const res  = await fetch(apiUrl('/documents-submitted.php'), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'update', id: _editingId, status, remarks }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message || 'Save failed.');

            document.getElementById('dsfOverlay')?.classList.remove('open');
            _showToast('Status updated.', 'success');
            await fetchRecords();
        } catch (e) {
            showErr('⚠ ' + (e.message || 'Could not save.'));
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save'; }
        }
    }

    // ── Toast ──────────────────────────────────────────────────────────────
    let _toastTimer = null;
    function _showToast(msg, type) {
        if (typeof showToast === 'function') { showToast(msg, type); return; }
        let el = document.getElementById('_dsToast');
        if (!el) {
            el = document.createElement('div');
            el.id = '_dsToast';
            el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .3s;font-family:inherit;';
            document.body.appendChild(el);
        }
        el.style.background = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#6366f1';
        el.style.opacity = '1';
        el.textContent = msg;
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
    }

    // Called from the inline "Preview File" button; reads file info from data attributes
    // to avoid any JS string injection issues with file paths.
    function _previewFileFromDetail() {
        const overlay = document.getElementById('dsdOverlay');
        const path = overlay?.dataset.filePath || '';
        const name = overlay?.dataset.fileName || '';
        openFilePreview(path, name);
    }

    // ── Public API ─────────────────────────────────────────────────────────
    return {
        openModal,
        closeModal,
        setFilter,
        onSearch,
        openDetail,
        closeDetail,
        openStatusForm,
        closeStatusForm,
        saveStatus,
        downloadRecord,
        previewRecord,
        openBuilderPreview,
        openFilePreview,
        closeFilePreview,
        _previewFileFromDetail,
        _selectStatus,
    };
})();