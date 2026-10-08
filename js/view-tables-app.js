// app.js — Schema Explorer Application Logic

// ============================================================
// STATE
// ============================================================
let transform = { x: 40, y: 80, scale: 0.85 };
let dragging = null;
let vpDrag = null;
let nodePositions = {};
let showRelations = true;
let activeTable = null;

// ============================================================
// LAYOUT POSITIONS
// ============================================================
const INITIAL_POSITIONS = {
    // Auth cluster (top-right)
    users: { x: 1400, y: 60 },
    login_sessions: { x: 1650, y: 60 },
    password_reset_tokens: { x: 1400, y: 320 },
    email_verification_codes: { x: 1650, y: 320 },

    // Core cluster (top-left)
    workshops: { x: 60, y: 60 },
    workshop_days: { x: 320, y: 60 },
    workshop_participants: { x: 60, y: 380 },
    resource_speakers: { x: 320, y: 380 },
    participant_roles: { x: 60, y: 660 },

    // Eval cluster (middle)
    evaluation_programs: { x: 620, y: 60 },
    evaluation_question_categories: { x: 880, y: 60 },
    evaluation_questions: { x: 880, y: 340 },
    evaluation_submissions: { x: 620, y: 380 },
    evaluation_answers: { x: 620, y: 660 },
    evaluation_speaker_answers: { x: 880, y: 640 },
    evaluation_reminders: { x: 620, y: 900 },
    rating_scales: { x: 880, y: 880 },
    eval_settings: { x: 1130, y: 880 },

    // Analytics cluster (bottom-left to bottom-mid)
    category_averages: { x: 60, y: 960 },
    column_averages: { x: 280, y: 960 },
    respondents: { x: 60, y: 1200 },
    respondent_feedback: { x: 320, y: 1200 },
    respondent_scores: { x: 570, y: 1200 },
    speaker_averages: { x: 820, y: 1200 },
    speaker_criteria: { x: 820, y: 1440 },
    qame_super_categories: { x: 1100, y: 1200 },
    qame_category_mappings: { x: 1100, y: 1440 },

    // Files cluster (right)
    program_files: { x: 1400, y: 600 },
    user_files: { x: 1400, y: 860 },
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    Object.assign(nodePositions, INITIAL_POSITIONS);
    buildERD();
    buildTableList();
    setupViewportDrag();
    setupTabs();
    setupZoom();
    applyTransform();
    updateRelationLines();
});

// ============================================================
// TABS
// ============================================================
function setupTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            if (btn.dataset.tab === 'diagram') {
                setTimeout(updateRelationLines, 50);
            }
        });
    });
}

// ============================================================
// ERD BUILD
// ============================================================
function buildERD() {
    const canvas = document.getElementById('erd-canvas');
    canvas.innerHTML = '';

    Object.entries(TABLES).forEach(([tname, tdef]) => {
        const pos = nodePositions[tname] || { x: 100, y: 100 };
        const group = GROUPS[tdef.group];

        const node = document.createElement('div');
        node.className = 'erd-node';
        node.id = 'node-' + tname;
        node.style.left = pos.x + 'px';
        node.style.top = pos.y + 'px';
        node.style.zIndex = 10;

        // Show only first 6 cols in ERD to keep nodes compact
        const visibleCols = tdef.columns.slice(0, 7);
        const moreCount = tdef.columns.length - visibleCols.length;

        node.innerHTML = `
      <div class="node-header">
        <div class="node-color-bar" style="background:${group.color}"></div>
        <span class="node-title">${tname}</span>
        <span class="node-count">${tdef.columns.length}</span>
      </div>
      <div class="node-cols">
        ${visibleCols.map(c => `
          <div class="node-col ${c.pk ? 'pk' : ''} ${c.fk ? 'fk' : ''}">
            <span>${c.pk ? '<span class="pk-icon">⬡</span>' : c.fk ? '<span class="fk-icon">→</span>' : ''}</span>
            <span class="col-name">${c.name}</span>
            <span class="col-type">${shortType(c.type)}</span>
          </div>
        `).join('')}
        ${moreCount > 0 ? `<div class="node-col" style="color:var(--text-dim);font-size:10px;padding-top:4px">+${moreCount} more…</div>` : ''}
      </div>
    `;

        makeDraggable(node, tname);
        node.addEventListener('dblclick', () => {
            switchToTable(tname);
        });
        node.addEventListener('mouseenter', () => highlightRelations(tname));
        node.addEventListener('mouseleave', () => clearHighlight());

        canvas.appendChild(node);
    });
}

function shortType(type) {
    return type.replace(/\(.*\)/, '').replace(/unsigned/i, '').trim().toUpperCase();
}

// ============================================================
// DRAGGABLE NODES
// ============================================================
function makeDraggable(node, tname) {
    node.addEventListener('mousedown', e => {
        if (e.target.closest('a')) return;
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = nodePositions[tname].x;
        const origY = nodePositions[tname].y;
        dragging = { tname, startX, startY, origX, origY };
        node.style.zIndex = 100;
        node.style.cursor = 'grabbing';
    });
}

document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = (e.clientX - dragging.startX) / transform.scale;
    const dy = (e.clientY - dragging.startY) / transform.scale;
    const nx = dragging.origX + dx;
    const ny = dragging.origY + dy;
    nodePositions[dragging.tname] = { x: nx, y: ny };
    const node = document.getElementById('node-' + dragging.tname);
    if (node) { node.style.left = nx + 'px'; node.style.top = ny + 'px'; }
    updateRelationLines();
});

document.addEventListener('mouseup', () => {
    if (dragging) {
        const node = document.getElementById('node-' + dragging.tname);
        if (node) { node.style.zIndex = 10; node.style.cursor = ''; }
        dragging = null;
    }
    if (vpDrag) vpDrag = null;
});

// ============================================================
// VIEWPORT PAN + ZOOM
// ============================================================
function setupViewportDrag() {
    const vp = document.getElementById('erd-viewport');
    vp.addEventListener('mousedown', e => {
        if (e.target !== vp && !e.target.classList.contains('erd-canvas') && !e.target.classList.contains('erd-svg')) return;
        vpDrag = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
    });
    document.addEventListener('mousemove', e => {
        if (!vpDrag) return;
        transform.x = vpDrag.origX + (e.clientX - vpDrag.startX);
        transform.y = vpDrag.origY + (e.clientY - vpDrag.startY);
        applyTransform();
    });
}

function setupZoom() {
    document.getElementById('erd-viewport').addEventListener('wheel', e => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.08 : 0.92;
        const newScale = Math.min(2, Math.max(0.2, transform.scale * delta));
        const rect = document.getElementById('erd-viewport').getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        transform.x = mx - (mx - transform.x) * (newScale / transform.scale);
        transform.y = my - (my - transform.y) * (newScale / transform.scale);
        transform.scale = newScale;
        applyTransform();
        updateRelationLines();
    }, { passive: false });
}

function applyTransform() {
    document.getElementById('erd-canvas').style.transform =
        `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    updateRelationLines();
}

function resetZoom() {
    transform = { x: 40, y: 80, scale: 0.85 };
    applyTransform();
}

// ============================================================
// RELATION LINES (SVG)
// ============================================================
function updateRelationLines() {
    const layer = document.getElementById('relations-layer');
    if (!layer) return;
    layer.innerHTML = '';
    if (!showRelations) return;

    const svg = document.getElementById('erd-svg');
    const svgRect = svg.getBoundingClientRect();

    RELATIONS.forEach((rel, idx) => {
        const [fromTable] = rel.from.split('.');
        const [toTable] = rel.to.split('.');
        const fromNode = document.getElementById('node-' + fromTable);
        const toNode = document.getElementById('node-' + toTable);
        if (!fromNode || !toNode) return;

        const fr = fromNode.getBoundingClientRect();
        const tr = toNode.getBoundingClientRect();

        const x1 = fr.left + fr.width / 2 - svgRect.left;
        const y1 = fr.top + fr.height / 2 - svgRect.top;
        const x2 = tr.left + tr.width / 2 - svgRect.left;
        const y2 = tr.top + tr.height / 2 - svgRect.top;

        const cx1 = x1 + (x2 - x1) * 0.5;
        const cy1 = y1;
        const cx2 = x1 + (x2 - x1) * 0.5;
        const cy2 = y2;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'rel-line');
        path.setAttribute('id', 'rel-' + idx);
        path.setAttribute('d', `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`);
        path.setAttribute('marker-end', 'url(#arrow)');
        path.dataset.from = fromTable;
        path.dataset.to = toTable;
        layer.appendChild(path);
    });
}

function highlightRelations(tname) {
    document.querySelectorAll('.erd-node').forEach(n => {
        if (n.id !== 'node-' + tname) n.classList.add('dim');
        else n.classList.add('highlighted');
    });

    const related = new Set([tname]);
    RELATIONS.forEach(r => {
        const [ft] = r.from.split('.');
        const [tt] = r.to.split('.');
        if (ft === tname) related.add(tt);
        if (tt === tname) related.add(ft);
    });
    related.forEach(t => {
        const n = document.getElementById('node-' + t);
        if (n) { n.classList.remove('dim'); n.classList.add('highlighted'); }
    });

    document.querySelectorAll('.rel-line').forEach(line => {
        if (line.dataset.from === tname || line.dataset.to === tname) {
            line.classList.add('active');
            line.setAttribute('marker-end', 'url(#arrow-hover)');
        }
    });
}

function clearHighlight() {
    document.querySelectorAll('.erd-node').forEach(n => {
        n.classList.remove('dim', 'highlighted');
    });
    document.querySelectorAll('.rel-line').forEach(line => {
        line.classList.remove('active');
        line.setAttribute('marker-end', 'url(#arrow)');
    });
}

function toggleRelations() {
    showRelations = !showRelations;
    document.getElementById('rel-toggle').textContent = showRelations ? 'Hide Relations' : 'Show Relations';
    updateRelationLines();
}

// ============================================================
// TABLE BROWSER
// ============================================================
function buildTableList() {
    const ul = document.getElementById('table-list');
    Object.entries(TABLES).forEach(([tname, tdef]) => {
        const color = GROUPS[tdef.group].color;
        const li = document.createElement('li');
        li.className = 'tlist-item';
        li.id = 'tlist-' + tname;
        li.innerHTML = `<span class="tlist-dot" style="background:${color}"></span>${tname}`;
        li.onclick = () => showTableDetail(tname);
        ul.appendChild(li);
    });
}

function filterTables(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.tlist-item').forEach(li => {
        li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

function showTableDetail(tname) {
    activeTable = tname;
    document.querySelectorAll('.tlist-item').forEach(li => li.classList.remove('active'));
    const li = document.getElementById('tlist-' + tname);
    if (li) li.classList.add('active');

    const tdef = TABLES[tname];
    const group = GROUPS[tdef.group];
    const color = group.color;

    // Relations in/out
    const relsOut = RELATIONS.filter(r => r.from.startsWith(tname + '.'));
    const relsIn = RELATIONS.filter(r => r.to.startsWith(tname + '.'));

    const detail = document.getElementById('table-detail');
    detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-color-stripe" style="background:${color}"></div>
      <div class="detail-title-block">
        <h2>${tname}</h2>
        <div class="detail-meta">
          <span>${tdef.columns.length} columns</span>
          <span>${relsOut.length + relsIn.length} relations</span>
          <span class="group-tag" style="color:${color};border-color:${color}">${group.label}</span>
        </div>
      </div>
    </div>

    <table class="col-table">
      <thead>
        <tr>
          <th>Column</th>
          <th>Type</th>
          <th>Nullable</th>
          <th>Key</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${tdef.columns.map(c => `
          <tr>
            <td class="${c.pk ? 'pk-cell' : c.fk ? 'fk-cell' : ''}">${c.name}</td>
            <td><span class="type-pill">${c.type}</span></td>
            <td><span class="null-badge ${c.nullable ? 'null-yes' : 'null-no'}">${c.nullable ? 'YES' : 'NO'}</span></td>
            <td>
              ${c.pk ? `<span style="color:var(--accent);font-size:11px">⬡ PK</span>` : ''}
              ${c.fk ? `<span style="color:var(--c-eval);font-size:11px">→ FK</span>` : ''}
            </td>
            <td class="comment-text">${c.comment || (c.fk ? `→ ${c.fk}` : '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    ${(relsOut.length || relsIn.length) ? `
    <div class="relations-section">
      <h3>Relationships</h3>
      <ul class="rel-list">
        ${relsOut.map(r => {
        const [, fromCol] = r.from.split('.');
        const [toTable, toCol] = r.to.split('.');
        return `<li class="rel-item rel-out" onclick="showTableDetail('${toTable}')">
            <span class="rel-dir">→</span>
            <span>
              <span class="rel-name">${toTable}</span>
              <span class="rel-via"> via </span>
              <span class="rel-col">${fromCol}</span>
              <span class="rel-via"> → </span>
              <span class="rel-col">${toCol}</span>
            </span>
            ${r.onDelete === 'CASCADE' ? `<span class="rel-cascade">CASCADE</span>` : ''}
          </li>`;
    }).join('')}
        ${relsIn.map(r => {
        const [fromTable, fromCol] = r.from.split('.');
        const [, toCol] = r.to.split('.');
        return `<li class="rel-item rel-in" onclick="showTableDetail('${fromTable}')">
            <span class="rel-dir">←</span>
            <span>
              <span class="rel-name">${fromTable}</span>
              <span class="rel-via"> references via </span>
              <span class="rel-col">${fromCol}</span>
            </span>
            ${r.onDelete === 'CASCADE' ? `<span class="rel-cascade">CASCADE</span>` : ''}
          </li>`;
    }).join('')}
      </ul>
    </div>
    ` : ''}
  `;
}

function switchToTable(tname) {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    document.querySelector('[data-tab="tables"]').classList.add('active');
    document.getElementById('tab-tables').classList.add('active');
    showTableDetail(tname);
}