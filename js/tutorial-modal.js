// ═══════════════════════════════════════════════════════════════════════════════
// tutorial-modal.js  —  QATALYST Excel Importer Interactive Tutorial
// Attach to the Help button: onclick="openTutorial()"
// ═══════════════════════════════════════════════════════════════════════════════

(function () {

    // ── Styles ────────────────────────────────────────────────────────────────
    const CSS = `
#tutorialOverlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
    opacity: 0; pointer-events: none;
    transition: opacity 0.22s ease;
}
#tutorialOverlay.tut-open {
    opacity: 1; pointer-events: all;
}
#tutorialModal {
    background: var(--surface, #fff);
    border: 1.5px solid var(--border, #e2e8f0);
    border-radius: 16px;
    width: 100%; max-width: 620px;
    max-height: 90vh;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,.18);
    transform: translateY(12px) scale(.98);
    transition: transform 0.22s ease;
    overflow: hidden;
}
#tutorialOverlay.tut-open #tutorialModal {
    transform: translateY(0) scale(1);
}

/* Header */
.tut-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--border, #e2e8f0);
    flex-shrink: 0;
}
.tut-header-left { display: flex; align-items: center; gap: 10px; }
.tut-logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, #3B82F6, #6366F1);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 14px;
}
.tut-header-title { font-size: 14px; font-weight: 700; color: var(--ink, #0f172a); }
.tut-header-sub { font-size: 11.5px; color: var(--ink-3, #94A3B8); margin-top: 1px; }
.tut-close {
    width: 30px; height: 30px; border-radius: 8px;
    border: 1px solid var(--border, #e2e8f0);
    background: transparent; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: var(--ink-2, #64748B); font-size: 16px; line-height: 1;
    transition: background 0.15s;
}
.tut-close:hover { background: var(--surface-2, #f8fafc); }

/* Progress steps */
.tut-progress {
    display: flex; align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border, #e2e8f0);
    background: var(--surface-2, #f8fafc);
    gap: 0; flex-shrink: 0; overflow-x: auto;
}
.tut-prog-step {
    display: flex; flex-direction: column; align-items: center;
    gap: 4px; flex: 1; min-width: 70px;
    cursor: pointer; opacity: 0.45;
    transition: opacity 0.2s;
}
.tut-prog-step.tut-done { opacity: 0.7; }
.tut-prog-step.tut-active { opacity: 1; }
.tut-prog-dot {
    width: 26px; height: 26px; border-radius: 50%;
    border: 1.5px solid var(--border, #e2e8f0);
    background: var(--surface, #fff);
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
    color: var(--ink-3, #94A3B8);
    transition: all 0.2s;
}
.tut-prog-step.tut-active .tut-prog-dot {
    background: #3B82F6; border-color: #3B82F6; color: #fff;
}
.tut-prog-step.tut-done .tut-prog-dot {
    background: #10B981; border-color: #10B981; color: #fff;
}
.tut-prog-label {
    font-size: 9.5px; text-align: center; line-height: 1.3;
    color: var(--ink-3, #94A3B8); max-width: 72px;
}
.tut-prog-step.tut-active .tut-prog-label {
    color: var(--ink, #0f172a); font-weight: 600;
}
.tut-prog-line {
    height: 1.5px; flex: 0 0 12px;
    background: var(--border, #e2e8f0); flex-shrink: 0;
}

/* Body (scrollable) */
.tut-body {
    padding: 18px 20px; overflow-y: auto; flex: 1;
    display: flex; flex-direction: column; gap: 12px;
}

/* Step hero */
.tut-step-hero {
    display: flex; align-items: center; gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border, #e2e8f0);
}
.tut-step-icon {
    width: 42px; height: 42px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
}
.tut-step-title { font-size: 15px; font-weight: 700; color: var(--ink, #0f172a); }
.tut-step-sub { font-size: 12px; color: var(--ink-3, #94A3B8); margin-top: 2px; }

/* Tip rows */
.tut-tip {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px;
    background: var(--surface-2, #f8fafc);
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 10px;
}
.tut-tip-num {
    width: 20px; height: 20px; border-radius: 50%;
    background: #3B82F6; color: #fff;
    font-size: 10.5px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 1px;
}
.tut-tip-text {
    font-size: 13px; color: var(--ink, #0f172a); line-height: 1.6;
}
.tut-tip-text code {
    font-family: 'DM Mono', monospace; font-size: 11.5px;
    background: #DBEAFE; color: #1D4ED8;
    padding: 1px 5px; border-radius: 4px;
}
.tut-tip-text strong { font-weight: 700; }

/* Callout */
.tut-callout {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 13px; border-radius: 10px;
    font-size: 12.5px; line-height: 1.55;
}
.tut-callout.info { background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; }
.tut-callout.warn { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }
.tut-callout.success { background: #ECFDF5; color: #065F46; border: 1px solid #A7F3D0; }
.tut-callout-icon { font-size: 13px; flex-shrink: 0; margin-top: 1px; }

/* Column type chips */
.tut-type-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
}
.tut-type-card {
    padding: 10px 12px; border-radius: 10px;
    border: 1px solid var(--border, #e2e8f0);
    background: var(--surface-2, #f8fafc);
}
.tut-type-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 20px;
    font-size: 11px; font-weight: 700; margin-bottom: 5px;
}
.badge-score { background: #DBEAFE; color: #1D4ED8; }
.badge-info  { background: #F1F5F9; color: #475569; }
.badge-fb    { background: #EDE9FE; color: #5B21B6; }
.tut-type-desc { font-size: 12px; color: var(--ink-2, #475569); line-height: 1.4; }

/* Screen mock */
.tut-mock {
    background: var(--surface-2, #f8fafc);
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 10px; overflow: hidden;
}
.tut-mock-bar {
    height: 28px; background: var(--surface, #fff);
    border-bottom: 1px solid var(--border, #e2e8f0);
    display: flex; align-items: center; gap: 5px; padding: 0 10px;
}
.tut-mock-dot { width: 7px; height: 7px; border-radius: 50%; }
.tut-mock-body { padding: 10px 12px; font-size: 12px; color: var(--ink-3, #94A3B8); }
.tut-mock-zone {
    border: 1.5px dashed var(--border, #e2e8f0);
    border-radius: 8px; text-align: center;
    padding: 14px; margin: 6px 0; font-size: 12px;
}
.tut-mock-btn {
    display: inline-block; margin-top: 6px;
    background: #3B82F6; color: #fff;
    border-radius: 6px; padding: 4px 12px; font-size: 11.5px;
}
.tut-mock-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.tut-mock-table th {
    background: var(--surface, #fff);
    padding: 4px 7px;
    border-bottom: 1px solid var(--border, #e2e8f0);
    font-weight: 600; color: var(--ink-3, #94A3B8);
    text-align: left;
}
.tut-mock-table td { padding: 4px 7px; border-bottom: 1px solid var(--border, #e2e8f0); }
.tut-mock-table .hl { background: #DBEAFE; color: #1D4ED8; font-weight: 600; }
.tut-mock-table .hl-g { background: #D1FAE5; color: #065F46; font-weight: 600; }
.tut-mock-table .hl-p { background: #EDE9FE; color: #5B21B6; }

/* Footer nav */
.tut-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--border, #e2e8f0);
    background: var(--surface-2, #f8fafc);
    flex-shrink: 0;
}
.tut-nav-btn {
    padding: 7px 16px; border-radius: 8px;
    border: 1px solid var(--border, #e2e8f0);
    background: var(--surface, #fff);
    color: var(--ink, #0f172a); font-size: 13px;
    cursor: pointer; font-family: inherit;
    transition: background 0.15s;
    display: flex; align-items: center; gap: 6px;
}
.tut-nav-btn:hover:not(:disabled) { background: var(--surface-2, #f8fafc); }
.tut-nav-btn:disabled { opacity: 0.35; cursor: default; }
.tut-nav-btn.primary {
    background: #3B82F6; border-color: #3B82F6; color: #fff;
}
.tut-nav-btn.primary:hover { background: #2563EB; }
.tut-step-counter {
    font-size: 12px; color: var(--ink-3, #94A3B8); font-weight: 600;
}

/* Ask buttons (final step) */
.tut-ask-section {
    display: flex; flex-direction: column; gap: 6px; margin-top: 4px;
}
.tut-ask-label {
    font-size: 11px; font-weight: 700; color: var(--ink-3, #94A3B8);
    text-transform: uppercase; letter-spacing: .05em; margin-bottom: 2px;
}
.tut-ask-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--border, #e2e8f0);
    background: var(--surface-2, #f8fafc);
    color: var(--ink, #0f172a); font-size: 12.5px;
    cursor: pointer; font-family: inherit; text-align: left;
    transition: background 0.15s, border-color 0.15s;
}
.tut-ask-btn:hover { background: var(--surface, #fff); border-color: #3B82F6; }
.tut-ask-icon { color: #3B82F6; font-size: 12px; flex-shrink: 0; }
`;

    // ── Step definitions ──────────────────────────────────────────────────────
    const STEPS = [
        {
            icon: '📂', iconBg: '#DBEAFE',
            title: 'Import your file',
            sub: 'Upload an Excel or CSV to get started',
            render: () => `
                <div class="tut-mock">
                    <div class="tut-mock-bar">
                        <div class="tut-mock-dot" style="background:#EF4444"></div>
                        <div class="tut-mock-dot" style="background:#F59E0B"></div>
                        <div class="tut-mock-dot" style="background:#10B981"></div>
                    </div>
                    <div class="tut-mock-body">
                        <div style="font-size:10px;color:var(--ink-3,#94A3B8);margin-bottom:6px">Programs / Workshops › Excel Importer</div>
                        <div class="tut-mock-zone">
                            <div style="font-size:20px">☁</div>
                            <div style="margin:4px 0">Drag &amp; drop your <strong>.xlsx</strong> or <strong>.csv</strong> here</div>
                            <div class="tut-mock-btn">Browse Files</div>
                        </div>
                    </div>
                </div>
                ${tip(1, 'Click <strong>Import New File</strong> in the top-right, or <strong>drag and drop</strong> your <code>.xlsx</code>, <code>.xls</code>, or <code>.csv</code> onto the upload zone.')}
                ${tip(2, 'The file is read <strong>entirely in your browser</strong> — nothing is sent to the server at this stage, so large files are fine.')}
                ${tip(3, 'After upload, columns are <strong>auto-detected</strong> and the system attempts to apply a matching saved configuration automatically. Check the Column Mapper to confirm.')}
                ${callout('info', '💡', 'If a saved config matches this file\'s name or column structure, it is applied instantly — you may not need to map anything manually.')}
            `
        },
        {
            icon: '🗂️', iconBg: '#EDE9FE',
            title: 'Map your columns',
            sub: 'Tell the system what each column means',
            render: () => `
                <div class="tut-type-grid">
                    <div class="tut-type-card">
                        <div class="tut-type-badge badge-score">📊 score</div>
                        <div class="tut-type-desc">Numeric / Likert ratings — averaged per category and reported.</div>
                    </div>
                    <div class="tut-type-card">
                        <div class="tut-type-badge badge-info">ℹ info</div>
                        <div class="tut-type-desc">Respondent metadata (name, school, email) — shown but not scored.</div>
                    </div>
                    <div class="tut-type-card">
                        <div class="tut-type-badge badge-fb">💬 feedback</div>
                        <div class="tut-type-desc">Open-text responses — collected and shown, not averaged.</div>
                    </div>
                </div>
                <div class="tut-mock">
                    <div class="tut-mock-bar">
                        <div class="tut-mock-dot" style="background:#EF4444"></div>
                        <div class="tut-mock-dot" style="background:#F59E0B"></div>
                        <div class="tut-mock-dot" style="background:#10B981"></div>
                    </div>
                    <div class="tut-mock-body">
                        <table class="tut-mock-table">
                            <tr><th>Col</th><th>Header</th><th>Type</th><th>Category</th></tr>
                            <tr><td>J</td><td>Full Name</td><td class="hl-p">info</td><td>Full Name</td></tr>
                            <tr><td>N</td><td>The program was well-structured…</td><td class="hl">score</td><td>Program Mgmt</td></tr>
                            <tr><td>AU</td><td>The speaker was knowledgeable…</td><td class="hl">score</td><td>Resource Speaker</td></tr>
                            <tr><td>BM</td><td>What were your expectations?</td><td class="hl-g">feedback</td><td>Feedbacks</td></tr>
                        </table>
                    </div>
                </div>
                ${tip(1, 'Click any column header in the table to open the <strong>Configure Column</strong> editor panel below the table.')}
                ${tip(2, 'Use <strong>Apply Range</strong> (e.g. <code>N → AU</code>) to set the same type and category across a block of columns at once — much faster than clicking one by one.')}
                ${tip(3, 'Click <strong>↻ Apply to All Similar</strong> to auto-assign the same config to columns sharing the same base name (e.g. all speaker criteria).')}
                ${tip(4, 'Use the <strong>Filters</strong> toggle to show only columns from one category, making large files easier to review.')}
                ${callout('warn', '⚠', 'Columns left as <em>unset</em> are skipped during computation. The yellow badge in the Proceed bar shows how many remain.')}
            `
        },
        {
            icon: '⚙️', iconBg: '#D1FAE5',
            title: 'Configure settings',
            sub: 'Scale, replace rules, and respondent fields',
            render: () => `
                ${tip(1, 'Open the <strong>⚙ Settings</strong> tab. Under <strong>Find &amp; Replace Rules</strong>, load a preset (e.g. <em>+ Agree/Disagree Scale</em>) if your data uses text responses like "Strongly Agree".')}
                ${tip(2, 'Check <strong>Respondent Info Columns</strong> — confirm the column letters for Name (<code>J</code>), Email (<code>L</code>), School (<code>M</code>), etc. These are auto-filled from the file but may need adjusting.')}
                ${tip(3, 'Under <strong>Scale &amp; Labels</strong>, review result thresholds. Defaults: 90% = <strong>Outstanding</strong>, 80% = Very Satisfactory, 70% = Satisfactory.')}
                ${tip(4, 'Add sheet names to <strong>Skip Sheets</strong> to exclude summary or cover tabs from processing.')}
                <div class="tut-mock">
                    <div class="tut-mock-bar">
                        <div class="tut-mock-dot" style="background:#EF4444"></div>
                        <div class="tut-mock-dot" style="background:#F59E0B"></div>
                        <div class="tut-mock-dot" style="background:#10B981"></div>
                    </div>
                    <div class="tut-mock-body" style="display:flex;gap:8px;flex-wrap:wrap">
                        <div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:4px 10px;font-size:11px;color:#065F46">✓ Strongly Agree → 4</div>
                        <div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:4px 10px;font-size:11px;color:#065F46">✓ Agree → 3</div>
                        <div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:4px 10px;font-size:11px;color:#065F46">✓ Disagree → 2</div>
                        <div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:4px 10px;font-size:11px;color:#065F46">✓ Strongly Disagree → 1</div>
                    </div>
                </div>
                ${callout('success', '✓', 'Settings are saved to the database when you click <strong>Save Settings &amp; Compute</strong> — they persist across sessions.')}
            `
        },
        {
            icon: '⚡', iconBg: '#FEF3C7',
            title: 'Compute results',
            sub: 'Run the calculation and review output',
            render: () => `
                ${tip(1, 'Click <strong>Save Settings &amp; Compute</strong> in the Proceed bar (Step ① tab) — this saves your column config and jumps to the Compute tab automatically.')}
                ${tip(2, 'Or switch to the <strong>② Compute &amp; Results</strong> tab and click the <strong>⚡ Compute Results</strong> button directly.')}
                ${tip(3, 'Review the <strong>Respondent Results</strong> table. Rows highlighted in yellow are <strong>duplicate responses</strong> — only the first per email is counted in averages.')}
                ${tip(4, 'Scroll down to the <strong>Consolidated Report</strong> to see per-category averages, result labels, and per-speaker ratings broken down by day.')}
                <div class="tut-mock">
                    <div class="tut-mock-bar">
                        <div class="tut-mock-dot" style="background:#EF4444"></div>
                        <div class="tut-mock-dot" style="background:#F59E0B"></div>
                        <div class="tut-mock-dot" style="background:#10B981"></div>
                    </div>
                    <div class="tut-mock-body" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
                        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px;text-align:center">
                            <div style="font-size:18px;font-weight:700;color:#3B82F6">83</div>
                            <div style="font-size:10px;color:var(--ink-3,#94A3B8)">Respondents</div>
                        </div>
                        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px;text-align:center">
                            <div style="font-size:18px;font-weight:700;color:#10B981">3.7612</div>
                            <div style="font-size:10px;color:var(--ink-3,#94A3B8)">Overall Avg</div>
                        </div>
                        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px;text-align:center">
                            <div style="font-size:18px;font-weight:700;color:#6366F1">1–4</div>
                            <div style="font-size:10px;color:var(--ink-3,#94A3B8)">Scale</div>
                        </div>
                    </div>
                </div>
                ${callout('info', '💡', 'If the detected scale looks wrong (e.g. shows 1–30), add a Find &amp; Replace rule in Settings to convert text responses to numbers before computing.')}
            `
        },
        {
            icon: '💾', iconBg: '#D1FAE5',
            title: 'Save to database',
            sub: 'Fill in program details and persist the record',
            render: () => `
                ${tip(1, 'Click <strong>Save to Database</strong> in the Respondent Results section. A modal appears with the <strong>Title</strong> and <strong>Division Memo</strong> auto-filled from your filename.')}
                ${tip(2, 'Enter the <strong>Sequence Number</strong> (format: <code>SDOCB-SMME-YYYY-NNN</code>). The field checks for duplicates in real time as you type.')}
                ${tip(3, 'Enter <strong>Resource Speaker Names</strong> inside the modal — they replace the generic "Speaker 1, 2…" labels in the final consolidated report.')}
                ${tip(4, 'Optionally link to an existing <strong>Workshop</strong> from the dropdown to associate this import with an existing program record.')}
                ${callout('success', '✓', 'After saving, a <strong>View in Dashboard</strong> button appears — click it to open charts, speaker summaries, and the printable PDF report.')}
                <div class="tut-ask-section">
                    <div class="tut-ask-label">Want a hands-on walkthrough?</div>
                    <button class="tut-ask-btn" onclick="closeTutorial();startGuidedTour(0)" style="border-color:#3B82F6;background:#EFF6FF;color:#1D4ED8;">
                        <span class="tut-ask-icon">🎓</span>
                        <strong>Start the interactive guided tour</strong> — I'll point to each part of the page
                    </button>
                    <button class="tut-ask-btn" onclick="openManual()">
                        <span class="tut-ask-icon">📖</span>
                        Open the full User Manual for this page
                    </button>
                </div>
            `
        }
    ];

    // ── Helpers ───────────────────────────────────────────────────────────────
    function tip(n, html) {
        return `<div class="tut-tip">
            <div class="tut-tip-num">${n}</div>
            <div class="tut-tip-text">${html}</div>
        </div>`;
    }
    function callout(type, icon, html) {
        return `<div class="tut-callout ${type}">
            <div class="tut-callout-icon">${icon}</div>
            <div>${html}</div>
        </div>`;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let current = 0;
    let injected = false;

    // ── Inject DOM ────────────────────────────────────────────────────────────
    function inject() {
        if (injected) return;
        injected = true;

        // Styles
        const style = document.createElement('style');
        style.id = 'tutorialStyles';
        style.textContent = CSS;
        document.head.appendChild(style);

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'tutorialOverlay';
        overlay.innerHTML = `<div id="tutorialModal" role="dialog" aria-modal="true" aria-label="Excel Importer Tutorial">
            <div class="tut-header">
                <div class="tut-header-left">
                    <div class="tut-logo"><i class="fa-solid fa-star"></i></div>
                    <div>
                        <div class="tut-header-title">Excel Importer — Tutorial</div>
                        <div class="tut-header-sub">Step-by-step guide to importing and computing</div>
                    </div>
                </div>
                <button class="tut-close" onclick="closeTutorial()" title="Close tutorial">✕</button>
            </div>
            <div class="tut-progress" id="tutProgress"></div>
            <div class="tut-body" id="tutBody"></div>
            <div class="tut-footer">
                <button class="tut-nav-btn" id="tutPrevBtn" onclick="tutPrev()">← Back</button>
                <span class="tut-step-counter" id="tutCounter"></span>
                <button class="tut-nav-btn primary" id="tutNextBtn" onclick="tutNext()"></button>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeTutorial();
        });

        // Close on Escape
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeTutorial();
        });
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function renderProgress() {
        const container = document.getElementById('tutProgress');
        if (!container) return;
        container.innerHTML = STEPS.map((s, i) => {
            const cls = i < current ? 'tut-done' : (i === current ? 'tut-active' : '');
            const dot = i < current ? '✓' : (i + 1);
            return `${i > 0 ? '<div class="tut-prog-line"></div>' : ''}
                <div class="tut-prog-step ${cls}" onclick="tutGoTo(${i})" title="${s.title}">
                    <div class="tut-prog-dot">${dot}</div>
                    <div class="tut-prog-label">${s.title}</div>
                </div>`;
        }).join('');
    }

    function renderBody() {
        const body = document.getElementById('tutBody');
        const s = STEPS[current];
        if (!body || !s) return;
        body.innerHTML = `
            <div class="tut-step-hero">
                <div class="tut-step-icon" style="background:${s.iconBg}">${s.icon}</div>
                <div>
                    <div class="tut-step-title">Step ${current + 1} — ${s.title}</div>
                    <div class="tut-step-sub">${s.sub}</div>
                </div>
            </div>
            ${s.render()}
        `;
        body.scrollTop = 0;
    }

    function renderFooter() {
        const prev = document.getElementById('tutPrevBtn');
        const next = document.getElementById('tutNextBtn');
        const counter = document.getElementById('tutCounter');
        if (prev) prev.disabled = current === 0;
        if (counter) counter.textContent = `${current + 1} of ${STEPS.length}`;
        if (next) {
            if (current < STEPS.length - 1) {
                next.textContent = 'Next →';
                next.onclick = tutNext;
            } else {
                next.textContent = '✓ Done';
                next.onclick = closeTutorial;
            }
        }
    }

    function render() {
        renderProgress();
        renderBody();
        renderFooter();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window.openTutorial = function (startStep) {
        inject();
        current = (typeof startStep === 'number') ? startStep : 0;
        render();
        requestAnimationFrame(() => {
            document.getElementById('tutorialOverlay').classList.add('tut-open');
        });
    };

    window.closeTutorial = function () {
        const overlay = document.getElementById('tutorialOverlay');
        if (overlay) overlay.classList.remove('tut-open');
    };

    window.tutNext = function () {
        if (current < STEPS.length - 1) { current++; render(); }
    };

    window.tutPrev = function () {
        if (current > 0) { current--; render(); }
    };

    window.tutGoTo = function (i) {
        current = i; render();
    };

    window.openManual = function () {
        closeTutorial();
        window.location.href = 'user-manual.html?page=import-excell.html';
    };

})();
