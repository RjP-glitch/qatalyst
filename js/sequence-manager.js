// ═══════════════════════════════════════════════════════════════════════════
//  sequence-manager.js
//  Sequence Number Manager — modal panel for viewing and editing all
//  workshop sequence numbers from a single place.
//
//  Dependencies:
//    - CONFIG.API_URL  (from config.js)
//    - showToast()     (from programs.js)
//    - loadPrograms()  (from programs.js, to refresh main list after edits)
//
//  Usage in programs.html:
//    1. Add <link rel="stylesheet" href="css/sequence-manager.css">
//    2. Add <script src="js/sequence-manager.js"></script>  (after programs.js)
//    3. Add the trigger button in .page-header-right:
//       <button class="btn-seq-manager" onclick="openSeqManager()">
//           <i class="fa-solid fa-hashtag"></i>
//           <span>Sequence Nos.</span>
//           <span class="seq-badge" id="seqMissingBadge" style="display:none;"></span>
//       </button>
//    4. Place the modal HTML block (see bottom of this file) before </body>
// ═══════════════════════════════════════════════════════════════════════════

const SeqManager = (() => {

    // ── Private state ────────────────────────────────────────────────────────
    let _allRecords    = [];   // full list from API
    let _filtered      = [];   // current filtered view
    let _editingRow    = null; // id of row currently in edit mode
    let _debounceMap   = {};   // per-row debounce timers
    let _searchTimer   = null;

    const API = () => `${CONFIG.API_URL}/sequence_manager_api.php`;

    // ── DOM helpers ───────────────────────────────────────────────────────────
    const $  = id => document.getElementById(id);
    const el = (tag, attrs = {}, ...children) => {
        const node = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'className') node.className = v;
            else if (k === 'style') node.style.cssText = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
            else node.setAttribute(k, v);
        });
        children.forEach(c => c && node.append(c));
        return node;
    };

    function esc(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    // ── Open / Close ──────────────────────────────────────────────────────────
    function open() {
        $('seqManagerModal').classList.add('active');
        loadData();
    }

    function close() {
        $('seqManagerModal').classList.remove('active');
        _editingRow = null;
    }

    // ── Load data from API ────────────────────────────────────────────────────
    async function loadData() {
        renderLoading();
        try {
            const res  = await fetch(API(), { credentials: 'include' });
            const json = await res.json();
            if (!json.success) throw new Error(json.message || 'Failed to load');

            _allRecords = json.records || [];
            applyFilters();
            renderStats(json.stats || {});
            updateMissingBadge(json.stats?.without_sn || 0);
        } catch (e) {
            renderError(e.message);
        }
    }

    // ── Stats bar ─────────────────────────────────────────────────────────────
    function renderStats(stats) {
        $('seqStatTotal').textContent    = `${stats.total ?? 0} Total`;
        $('seqStatAssigned').textContent = `${stats.with_sn ?? 0} Assigned`;
        $('seqStatMissing').textContent  = `${stats.without_sn ?? 0} Missing`;
        $('seqStatNext').textContent     = `Next: ${stats.next_sn ?? '—'}`;

        // Show/hide bulk button
        const bulkBtn = $('seqBulkBtn');
        if (bulkBtn) bulkBtn.style.display = (stats.without_sn > 0) ? 'inline-flex' : 'none';
    }

    function updateMissingBadge(count) {
        const badge = $('seqMissingBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }

    // ── Filtering ─────────────────────────────────────────────────────────────
    function applyFilters() {
        const q      = ($('seqSearch')?.value || '').trim().toLowerCase();
        const filter = $('seqFilter')?.value || 'all';

        _filtered = _allRecords.filter(r => {
            // Status filter
            if (filter === 'missing'  && r.sequence_number) return false;
            if (filter === 'assigned' && !r.sequence_number) return false;

            // Search
            if (q) {
                const haystack = [
                    r.title, r.division_memo, r.sequence_number,
                    r.inclusive_dates, r.proponents, r.unit
                ].map(x => (x || '').toLowerCase()).join(' ');
                if (!haystack.includes(q)) return false;
            }
            return true;
        });

        renderTable();
        $('seqFooterCount').textContent =
            `Showing ${_filtered.length} of ${_allRecords.length} records`;
    }

    // ── Table rendering ───────────────────────────────────────────────────────
    function renderLoading() {
        const tbody = $('seqTableBody');
        if (!tbody) return;
        tbody.innerHTML = `
            <tr class="seq-empty-row">
                <td colspan="7">
                    <i class="fa-solid fa-spinner" style="animation:spin 0.8s linear infinite;"></i>
                    Loading records…
                </td>
            </tr>`;
    }

    function renderError(msg) {
        const tbody = $('seqTableBody');
        if (!tbody) return;
        tbody.innerHTML = `
            <tr class="seq-empty-row">
                <td colspan="7" style="color:#dc2626;">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    ${esc(msg)}
                </td>
            </tr>`;
    }

    function renderTable() {
        const tbody = $('seqTableBody');
        if (!tbody) return;

        if (_filtered.length === 0) {
            tbody.innerHTML = `
                <tr class="seq-empty-row">
                    <td colspan="7">
                        <i class="fa-solid fa-inbox"></i>
                        No records match your filter.
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = '';
        _filtered.forEach((r, idx) => {
            const tr = document.createElement('tr');
            if (!r.sequence_number) tr.classList.add('row-missing-sn');
            tr.dataset.id = r.id;
            tr.innerHTML  = buildRowHTML(r, idx + 1);
            tbody.appendChild(tr);
        });
    }

    function buildRowHTML(r, no) {
        const sn       = r.sequence_number || '';
        const isEditing = _editingRow === r.id;
        const dateStr  = r.inclusive_dates
            ? esc(r.inclusive_dates)
            : (r.start_date ? formatDateRange(r.start_date, r.end_date) : '—');

        const snCell = isEditing
            ? buildEditCell(r)
            : buildViewCell(r);

        const statusPill = r.status
            ? `<span class="status-pill ${esc(r.status)}">${esc(r.status)}</span>`
            : '—';

        const sourceDot = r.source_type === 'excel'
            ? `<span class="source-dot excel" title="Excel Import"></span>`
            : `<span class="source-dot system" title="System"></span>`;

        return `
            <td class="seq-col-no">${no}</td>
            <td class="seq-col-sn">${snCell}</td>
            <td class="seq-col-dm">${r.division_memo ? `<span style="font-size:12px;color:#1e293b;">${esc(r.division_memo)}</span>` : '<span style="color:#cbd5e1;">—</span>'}</td>
            <td class="seq-col-title">
                ${sourceDot}
                <span style="font-weight:600;color:#1e293b;">${esc(r.title) || 'Untitled'}</span>
                ${r.unit ? `<br><span style="font-size:11px;color:#64748b;">${esc(r.unit)}</span>` : ''}
            </td>
            <td class="seq-col-date" style="font-size:12px;color:#475569;">${dateStr}</td>
            <td class="seq-col-status">${statusPill}</td>
            <td class="seq-col-act">${buildActionCell(r)}</td>
        `;
    }

    function buildViewCell(r) {
        if (r.sequence_number) {
            return `
                <div class="sn-cell-inner">
                    <span class="sn-tag">
                        <i class="fa-solid fa-hashtag" style="font-size:9px;opacity:0.7;"></i>
                        ${esc(r.sequence_number)}
                    </span>
                </div>`;
        }
        return `
            <div class="sn-cell-inner">
                <span class="sn-empty">
                    <i class="fa-solid fa-circle-exclamation" style="font-size:10px;"></i> Not set
                </span>
            </div>`;
    }

    function buildEditCell(r) {
        const cur = r.sequence_number || '';
        return `
            <div class="sn-edit-wrap" id="snEditWrap_${r.id}">
                <div>
                    <input
                        class="sn-input"
                        id="snInput_${r.id}"
                        type="text"
                        value="${esc(cur)}"
                        placeholder="SDOCB-SMME-YYYY-NNN"
                        autocomplete="off"
                        oninput="SeqManager._onInput(${r.id}, this.value)"
                    >
                    <small class="sn-hint info" id="snHint_${r.id}">Format: SDOCB-SMME-YYYY-NNN</small>
                </div>
                <button class="btn-sn-save" id="snSaveBtn_${r.id}" onclick="SeqManager._saveRow(${r.id})">
                    <i class="fa-solid fa-check"></i>
                </button>
                <button class="btn-sn-cancel" onclick="SeqManager._cancelEdit(${r.id})">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <button class="btn-sn-auto" onclick="SeqManager._autoAssign(${r.id})" title="Auto-assign next number">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Auto
                </button>
            </div>`;
    }

    function buildActionCell(r) {
        if (_editingRow === r.id) return '';
        const editBtn = `<button class="btn-sn-edit" onclick="SeqManager._startEdit(${r.id})">
            <i class="fa-solid fa-pen-to-square"></i> Edit
        </button>`;
        return editBtn;
    }

    // ── Edit flow ─────────────────────────────────────────────────────────────
    function _startEdit(id) {
        _editingRow = id;
        rerenderRow(id);
        // Focus the input
        setTimeout(() => {
            const inp = $(`snInput_${id}`);
            if (inp) { inp.focus(); inp.select(); }
        }, 30);
    }

    function _cancelEdit(id) {
        _editingRow = null;
        rerenderRow(id);
    }

    function _onInput(id, val) {
        clearTimeout(_debounceMap[id]);
        const hint    = $(`snHint_${id}`);
        const input   = $(`snInput_${id}`);
        const saveBtn = $(`snSaveBtn_${id}`);
        if (!hint || !input) return;

        const SN_PATTERN = /^SDOCB-SMME-\d{4}-\d{3,}$/;
        const trimmed = val.trim();

        if (!trimmed) {
            hint.textContent = 'Leave empty to clear the sequence number.';
            hint.className   = 'sn-hint info';
            input.className  = 'sn-input';
            if (saveBtn) saveBtn.disabled = false;
            return;
        }

        if (!SN_PATTERN.test(trimmed)) {
            hint.textContent = '⚠ Format must be SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)';
            hint.className   = 'sn-hint error';
            input.className  = 'sn-input error';
            if (saveBtn) saveBtn.disabled = true;
            return;
        }

        hint.textContent = 'Checking…';
        hint.className   = 'sn-hint info';
        input.className  = 'sn-input';
        if (saveBtn) saveBtn.disabled = true;

        _debounceMap[id] = setTimeout(async () => {
            try {
                const r   = await fetch(
                    `${API()}?action=check_sequence&sn=${encodeURIComponent(trimmed)}&exclude_id=${id}`,
                    { credentials: 'include' }
                );
                const j   = await r.json();
                if (j.duplicate) {
                    hint.textContent = `⚠ Already used by "${j.title}" (ID #${j.id})`;
                    hint.className   = 'sn-hint error';
                    input.className  = 'sn-input error';
                    if (saveBtn) saveBtn.disabled = true;
                } else {
                    hint.textContent = '✓ Available';
                    hint.className   = 'sn-hint ok';
                    input.className  = 'sn-input ok';
                    if (saveBtn) saveBtn.disabled = false;
                }
            } catch (_) {
                hint.textContent = 'Could not verify. You may still save.';
                hint.className   = 'sn-hint info';
                if (saveBtn) saveBtn.disabled = false;
            }
        }, 480);
    }

    async function _saveRow(id) {
        const input   = $(`snInput_${id}`);
        const saveBtn = $(`snSaveBtn_${id}`);
        if (!input) return;

        const val = input.value.trim();

        // Client-side format guard
        const SN_PATTERN = /^SDOCB-SMME-\d{4}-\d{3,}$/;
        if (val && !SN_PATTERN.test(val)) {
            showToast('error', 'Invalid format. Use SDOCB-SMME-YYYY-NNN.');
            return;
        }

        if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner" style="animation:spin 0.7s linear infinite;"></i>'; }

        try {
            const res  = await fetch(API(), {
                method:      'PATCH',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ id, sequence_number: val || null }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.message);

            // Update local cache
            const rec = _allRecords.find(r => r.id === id);
            if (rec) rec.sequence_number = json.sequence_number || val || null;

            _editingRow = null;
            applyFilters();

            // Refresh stats
            const missing = _allRecords.filter(r => !r.sequence_number).length;
            const total   = _allRecords.length;
            renderStats({ total, with_sn: total - missing, without_sn: missing });
            updateMissingBadge(missing);

            showToast('success', val ? `Set to ${val}` : 'Sequence number cleared.');

            // Soft-refresh the main programs list in the background
            if (typeof loadPrograms === 'function') loadPrograms();

        } catch (e) {
            showToast('error', e.message || 'Save failed.');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-check"></i>'; }
        }
    }

    async function _autoAssign(id) {
        const wrap = $(`snEditWrap_${id}`);
        if (wrap) {
            wrap.innerHTML = `<span class="sn-saving"><i class="fa-solid fa-spinner"></i> Assigning…</span>`;
        }
        try {
            const res  = await fetch(API(), {
                method:      'PATCH',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ id, auto_assign: true }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.message);

            const rec = _allRecords.find(r => r.id === id);
            if (rec) rec.sequence_number = json.sequence_number;

            _editingRow = null;
            applyFilters();

            const missing = _allRecords.filter(r => !r.sequence_number).length;
            const total   = _allRecords.length;
            renderStats({ total, with_sn: total - missing, without_sn: missing });
            updateMissingBadge(missing);

            showToast('success', `Auto-assigned: ${json.sequence_number}`);
            if (typeof loadPrograms === 'function') loadPrograms();

        } catch (e) {
            showToast('error', e.message || 'Auto-assign failed.');
            _editingRow = null;
            rerenderRow(id);
        }
    }

    // ── Bulk assign ───────────────────────────────────────────────────────────
    async function bulkAssign() {
        const btn = $('seqBulkBtn');
        const missing = _allRecords.filter(r => !r.sequence_number).length;
        if (!missing) { showToast('info', 'No records are missing a sequence number.'); return; }

        if (!confirm(`Auto-assign sequence numbers to ${missing} record(s) that have none?\n\nThis will use MAX+1 logic (gaps are not filled).`)) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner" style="animation:spin 0.7s linear infinite;"></i> Assigning…'; }

        try {
            const res  = await fetch(`${API()}?action=bulk_assign`, {
                method:      'POST',
                credentials: 'include',
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.message);

            showToast('success', json.message);
            loadData();
            if (typeof loadPrograms === 'function') loadPrograms();
        } catch (e) {
            showToast('error', e.message || 'Bulk assign failed.');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Auto-assign Missing'; }
        }
    }

    // ── Export to CSV ─────────────────────────────────────────────────────────
    function exportCSV() {
        if (!_allRecords.length) { showToast('info', 'No records to export.'); return; }

        const headers = ['#', 'Sequence Number', 'Division Memo', 'Title', 'Unit', 'Inclusive Dates', 'Status'];
        const rows    = _allRecords.map((r, i) => [
            i + 1,
            r.sequence_number || '',
            r.division_memo   || '',
            r.title           || '',
            r.unit            || '',
            r.inclusive_dates || (r.start_date ? formatDateRange(r.start_date, r.end_date) : ''),
            r.status          || '',
        ]);

        const csv = [headers, ...rows]
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\r\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `sequence-numbers-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function rerenderRow(id) {
        const tbody = $('seqTableBody');
        if (!tbody) return;
        const tr = tbody.querySelector(`tr[data-id="${id}"]`);
        if (!tr) { renderTable(); return; }

        const rec = _allRecords.find(r => r.id === id);
        if (!rec) return;

        const idx = _filtered.findIndex(r => r.id === id);
        tr.className = rec.sequence_number ? '' : 'row-missing-sn';
        tr.innerHTML = buildRowHTML(rec, idx + 1);
    }

    function formatDateRange(start, end) {
        if (!start) return '—';
        const fmt = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        open,
        close,
        bulkAssign,
        exportCSV,
        _startEdit,
        _cancelEdit,
        _onInput,
        _saveRow,
        _autoAssign,
        reload: loadData,
        _searchChanged() {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(applyFilters, 280);
        },
        _filterChanged: applyFilters,
    };

})();

// Global shortcut used by the trigger button in the HTML
function openSeqManager() { SeqManager.open(); }
