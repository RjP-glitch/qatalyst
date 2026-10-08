// ═══════════════════════════════════════════════════════════════════════════════
// guided-tour.js  —  QATALYST Excel Importer Interactive Guided Tour  v4
// Fixes: auto-detect mode on launch, skip upload step if file already loaded,
//        fileBadge display:'flex' detection, mode auto-selection from app state.
// ═══════════════════════════════════════════════════════════════════════════════

(function () {

const CSS = `
/* ── Backdrop — cut-out spotlight ───────────────────────────────────── */
#gtBackdrop {
    position: fixed; inset: 0; z-index: 10000;
    pointer-events: none;
    transition: opacity 0.28s ease;
    opacity: 0;
}
#gtBackdrop.gt-visible { opacity: 1; }

#gtBackdropSvg {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    pointer-events: none;
}

#gtClickCatcher {
    position: fixed; inset: 0; z-index: 10001;
    pointer-events: none; background: transparent;
}
#gtClickCatcher.gt-catchable { pointer-events: all; cursor: pointer; }

#gtRing {
    position: fixed; z-index: 10003;
    border: 2.5px solid #3B82F6;
    border-radius: 10px;
    box-shadow: 0 0 0 3px rgba(59,130,246,.25), 0 0 24px rgba(59,130,246,.35);
    pointer-events: none;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1),
                width 0.32s cubic-bezier(.4,0,.2,1),
                height 0.32s cubic-bezier(.4,0,.2,1),
                opacity 0.2s;
    opacity: 0;
}
#gtRing.gt-visible { opacity: 1; }

#gtClickArrow {
    position: fixed; z-index: 10004;
    width: 36px; height: 36px;
    pointer-events: none;
    opacity: 0;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1),
                opacity 0.2s;
    animation: gtBounce 0.9s ease-in-out infinite;
}
#gtClickArrow.gt-visible { opacity: 1; }
#gtClickArrow svg { width: 100%; height: 100%; }
@keyframes gtBounce {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(-6px); }
}

#gtClickLabel {
    position: fixed; z-index: 10004;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 11px; font-weight: 800; color: #fff;
    background: #3B82F6; border-radius: 6px; padding: 3px 9px;
    pointer-events: none; opacity: 0; white-space: nowrap;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1),
                opacity 0.2s;
    letter-spacing: .05em; text-transform: uppercase;
    box-shadow: 0 2px 8px rgba(59,130,246,.4);
}
#gtClickLabel.gt-visible { opacity: 1; }

#gtPulse {
    position: fixed; z-index: 10004;
    width: 18px; height: 18px; border-radius: 50%;
    background: #3B82F6; pointer-events: none; opacity: 0;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1),
                opacity 0.2s;
}
#gtPulse.gt-visible { opacity: 1; }
#gtPulse::after {
    content: ''; position: absolute; inset: -6px;
    border-radius: 50%; border: 2px solid rgba(59,130,246,.5);
    animation: gtPulseAnim 1.4s ease-out infinite;
}
@keyframes gtPulseAnim {
    0%   { transform: scale(.7); opacity: .9; }
    100% { transform: scale(1.9); opacity: 0; }
}

#gtTooltip {
    position: fixed; z-index: 10005;
    width: 330px;
    background: #0F172A; border: 1.5px solid #1E3A5F;
    border-radius: 14px; padding: 0;
    box-shadow: 0 16px 48px rgba(0,0,0,.45);
    pointer-events: all; opacity: 0;
    transform: scale(.94) translateY(6px);
    transition: opacity 0.25s ease, transform 0.25s ease,
                left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1);
    overflow: hidden;
}
#gtTooltip.gt-visible { opacity: 1; transform: scale(1) translateY(0); }

#gtArrow {
    position: fixed; z-index: 10005;
    width: 14px; height: 14px;
    background: #0F172A; border: 1.5px solid #1E3A5F;
    transform: rotate(45deg); pointer-events: none; opacity: 0;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1),
                opacity 0.25s;
}
#gtArrow.gt-visible { opacity: 1; }

.gt-mode-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 15px;
    font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
}
.gt-mode-banner.auto   { background: #064E3B; color: #6EE7B7; }
.gt-mode-banner.manual { background: #1E3A5F; color: #93C5FD; }
.gt-mode-banner.shared { background: #1E1B4B; color: #C4B5FD; }

.gt-tip-header {
    padding: 11px 15px 9px;
    border-bottom: 1px solid #1E3A5F;
    display: flex; align-items: center; gap: 10px;
}
.gt-step-badge {
    background: #1E3A5F; color: #93C5FD;
    font-size: 10px; font-weight: 700;
    padding: 2px 8px; border-radius: 20px;
    flex-shrink: 0; letter-spacing: .04em;
}
.gt-tip-title { font-size: 13px; font-weight: 700; color: #F1F5F9; flex: 1; line-height: 1.3; }
.gt-close-btn {
    width: 22px; height: 22px; border-radius: 6px;
    border: 1px solid #1E3A5F; background: transparent;
    color: #64748B; cursor: pointer; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s; flex-shrink: 0; font-family: inherit;
}
.gt-close-btn:hover { background: #1E3A5F; color: #F1F5F9; }

.gt-tip-body {
    padding: 12px 15px;
    font-size: 12.5px; color: #94A3B8; line-height: 1.65;
}
.gt-tip-body strong { color: #E2E8F0; font-weight: 600; }
.gt-tip-body code {
    font-family: monospace; font-size: 11px;
    background: #1E3A5F; color: #93C5FD;
    padding: 1px 5px; border-radius: 4px;
}

.gt-action-hint {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 9px 11px;
    background: rgba(59,130,246,.15);
    border: 1px solid rgba(59,130,246,.3);
    border-radius: 8px; font-size: 12px; color: #93C5FD; font-weight: 600;
}
.gt-action-hint .gt-hint-icon { font-size: 14px; flex-shrink: 0; }

.gt-upload-hint {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 10px 12px;
    background: rgba(16,185,129,.12);
    border: 1px solid rgba(16,185,129,.3);
    border-radius: 8px; font-size: 12px; color: #6EE7B7; font-weight: 600;
    animation: gtUploadPulse 2s ease-in-out infinite;
}
@keyframes gtUploadPulse {
    0%, 100% { border-color: rgba(16,185,129,.3); }
    50%       { border-color: rgba(16,185,129,.7); }
}

/* "File already loaded" info banner — shown when upload step is skipped */
.gt-file-loaded-info {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 9px 11px;
    background: rgba(16,185,129,.12);
    border: 1px solid rgba(16,185,129,.3);
    border-radius: 8px; font-size: 12px; color: #6EE7B7; font-weight: 600;
}

.gt-missing-warn {
    display: flex; align-items: center; gap: 7px;
    margin-top: 8px; padding: 7px 10px;
    background: rgba(234,179,8,.1); border: 1px solid rgba(234,179,8,.25);
    border-radius: 7px; font-size: 11.5px; color: #FCD34D;
}

.gt-mode-switch {
    display: flex; gap: 6px;
    margin-top: 10px; padding: 10px 11px;
    background: rgba(255,255,255,.04);
    border: 1px solid #1E3A5F; border-radius: 8px;
    flex-wrap: wrap;
}
.gt-mode-switch-label { font-size: 10px; color: #64748B; font-weight: 700; margin-bottom: 4px; width: 100%; }
.gt-mode-btn {
    flex: 1; padding: 7px 8px;
    border-radius: 6px; border: 1px solid #1E3A5F;
    background: transparent; color: #64748B;
    font-size: 11px; font-weight: 700; cursor: pointer;
    font-family: inherit; transition: all .15s; text-align: center;
}
.gt-mode-btn:hover { border-color: #3B82F6; color: #93C5FD; }
.gt-mode-btn.active-auto   { background: #064E3B; border-color: #10B981; color: #6EE7B7; }
.gt-mode-btn.active-manual { background: #1E3A5F; border-color: #3B82F6; color: #93C5FD; }

.gt-tip-footer {
    padding: 10px 15px;
    border-top: 1px solid #1E3A5F;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.gt-dot-track { display: flex; gap: 5px; align-items: center; }
.gt-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #1E3A5F; cursor: pointer;
    transition: background 0.15s, transform 0.15s;
}
.gt-dot.active { background: #3B82F6; transform: scale(1.3); }
.gt-dot.done   { background: #10B981; }

.gt-nav { display: flex; gap: 6px; }
.gt-nav-btn {
    padding: 5px 13px; border-radius: 7px;
    font-size: 12px; font-weight: 600; cursor: pointer;
    border: 1px solid #1E3A5F; background: transparent; color: #94A3B8;
    font-family: inherit; transition: all 0.15s;
}
.gt-nav-btn:hover:not(:disabled) { background: #1E3A5F; color: #F1F5F9; }
.gt-nav-btn:disabled { opacity: 0.3; cursor: default; }
.gt-nav-btn.primary { background: #3B82F6; border-color: #3B82F6; color: #fff; }
.gt-nav-btn.primary:hover { background: #2563EB; }

#gtMascot {
    position: fixed; z-index: 10006;
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, #3B82F6, #6366F1);
    display: flex; align-items: center; justify-content: center; font-size: 22px;
    box-shadow: 0 4px 16px rgba(59,130,246,.4); pointer-events: none; opacity: 0;
    transition: left 0.32s cubic-bezier(.4,0,.2,1),
                top  0.32s cubic-bezier(.4,0,.2,1), opacity 0.25s;
}
#gtMascot.gt-visible { opacity: 1; }

#gtSkipBtn {
    position: fixed; z-index: 10007;
    bottom: 20px; left: 50%; transform: translateX(-50%);
    padding: 7px 18px; border-radius: 20px;
    background: rgba(15,23,42,.8); border: 1px solid #1E3A5F;
    color: #64748B; font-size: 12px; cursor: pointer;
    font-family: inherit; backdrop-filter: blur(8px);
    transition: color 0.15s, opacity 0.2s;
    opacity: 0; pointer-events: none;
}
#gtSkipBtn.gt-visible { opacity: 1; pointer-events: all; }
#gtSkipBtn:hover { color: #F1F5F9; }

#gtSectionNotice {
    position: fixed; z-index: 10008;
    top: 50%; left: 50%; transform: translate(-50%, -50%) scale(.9);
    background: #0F172A; border: 1.5px solid #1E3A5F;
    border-radius: 16px; padding: 24px 28px; text-align: center;
    max-width: 340px; pointer-events: none;
    opacity: 0; transition: all 0.25s ease;
}
#gtSectionNotice.gt-visible {
    opacity: 1; transform: translate(-50%, -50%) scale(1); pointer-events: all;
}
#gtSectionNotice .gt-notice-icon  { font-size: 28px; margin-bottom: 8px; }
#gtSectionNotice .gt-notice-title { font-size: 15px; font-weight: 700; color: #F1F5F9; margin-bottom: 6px; }
#gtSectionNotice .gt-notice-sub   { font-size: 13px; color: #94A3B8; line-height: 1.5; }

#gtWaitingOverlay {
    position: fixed; z-index: 10008;
    bottom: 60px; left: 50%; transform: translateX(-50%);
    background: #064E3B; border: 1.5px solid #10B981;
    border-radius: 12px; padding: 12px 20px;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 13px; font-weight: 700; color: #6EE7B7;
    display: flex; align-items: center; gap: 10px;
    pointer-events: none; opacity: 0;
    transition: opacity .25s;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    white-space: nowrap;
}
#gtWaitingOverlay.gt-visible { opacity: 1; }
#gtWaitingOverlay::before {
    content: '';
    width: 8px; height: 8px; border-radius: 50%;
    background: #10B981; flex-shrink: 0;
    animation: gtPulseAnim 1.4s ease-out infinite;
}

.gt-highlight-pulse {
    outline: 2.5px solid #3B82F6 !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 5px rgba(59,130,246,.2), 0 0 18px rgba(59,130,246,.35) !important;
    animation: gtLivePulse 1.2s ease-in-out infinite !important;
    position: relative !important; z-index: 9999 !important;
}
@keyframes gtLivePulse {
    0%, 100% { box-shadow: 0 0 0 5px rgba(59,130,246,.2), 0 0 18px rgba(59,130,246,.35); }
    50%       { box-shadow: 0 0 0 8px rgba(59,130,246,.08), 0 0 28px rgba(59,130,246,.5); }
}
`;

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS_SHARED_INTRO = [
    {
        id: 'welcome',
        mode: 'shared',
        target: null,
        triggerTarget: null,
        position: 'center',
        section: null,
        title: 'Welcome to the Excel Importer!',
        body: `I'm <strong>Q</strong>, your QATALYST guide.\n\nThere are <strong>two import flows</strong> — pick the one that matches your situation:`,
        showModeSwitcher: true,
        actionHint: null,
    },
];

const STEPS_AUTO = [
    {
        id: 'a-upload',
        mode: 'auto',
        target: '.upload-drop-zone',
        triggerTarget: '.upload-drop-btn',
        position: 'right',
        section: 'columns',
        title: 'Step 1 — Import your file',
        body: `Click <strong>Browse Files</strong> or <strong>drag & drop</strong> your <code>.xlsx</code>, <code>.xls</code>, or <code>.csv</code> onto this zone.\n\nOnce you upload, the system will try to <strong>auto-match a saved column config</strong> and compute instantly — you may not need to configure anything at all!`,
        waitForUpload: true,
        actionHint: { icon: '👆', text: 'Click Browse Files — the tour pauses until your file is ready' },
    },
    {
        id: 'a-results',
        mode: 'auto',
        target: '#resultsSection',
        triggerTarget: null,
        position: 'left',
        section: 'compute',
        title: 'Auto-computed! Review your results',
        body: `The system recognised your file and computed everything automatically.\n\nReview the <strong>summary cards</strong> (total respondents, overall average, scale) and the <strong>respondent table</strong> below.\n\nRows highlighted in <span style="background:#FEF9C3;color:#92400E;padding:0 4px;border-radius:3px">yellow</span> are duplicate responses — only the first per email is counted.`,
        missingMsg: 'Results appear here after auto-computation. Upload a file first.',
        actionHint: { icon: '👀', text: 'Review the results above' },
    },
    {
        id: 'a-consolidated',
        mode: 'auto',
        target: '#consolidatedSection',
        triggerTarget: null,
        position: 'left',
        section: 'compute',
        title: 'Consolidated report',
        body: `Scroll down to see the <strong>Consolidated Report</strong> — per-category averages, result labels (Outstanding, Very Satisfactory…), and per-speaker ratings broken down by day.\n\nThis is what gets saved to the database.`,
        missingMsg: 'The consolidated report appears below the respondent table after computation.',
        actionHint: { icon: '📋', text: 'Scroll down to see the full report' },
    },
    {
        id: 'a-save',
        mode: 'auto',
        target: '#saveBtn',
        triggerTarget: '#saveBtn',
        position: 'left',
        section: 'compute',
        title: 'Step 2 — Save to Database',
        body: `Click <strong>Save to Database</strong> to open the save form.\n\nFill in:\n• <strong>Title</strong> (auto-filled from filename)\n• <strong>Sequence number</strong> — duplicate-checked in real time\n• <strong>Speaker names</strong> — replaces "Speaker 1, 2…" in the report\n• Optionally link to a Workshop record`,
        missingMsg: '⚠ This button appears after computation completes.',
        actionHint: { icon: '👆', text: 'Click Save to Database' },
    },
    {
        id: 'a-done',
        mode: 'auto',
        target: null,
        triggerTarget: null,
        position: 'center',
        section: null,
        title: 'You\'re all set! 🎉',
        body: `<strong>Auto-import recap:</strong>\n\n① Import file → auto-matched config\n② Verify results & consolidated report\n③ Save to database with program details\n\nIf the system ever fails to auto-compute (new column structure), it opens the <strong>Column Mapper</strong> so you can configure manually.\n\nReopen this tour via <strong>🎓 Take a Tour</strong> anytime.`,
        actionHint: null,
    },
];

const STEPS_MANUAL = [
    {
        id: 'm-upload',
        mode: 'manual',
        target: '.upload-drop-zone',
        triggerTarget: '.upload-drop-btn',
        position: 'right',
        section: 'columns',
        title: 'Step 1 — Import your file',
        body: `Click <strong>Browse Files</strong> or <strong>drag & drop</strong> your <code>.xlsx</code>, <code>.xls</code>, or <code>.csv</code> here.\n\nAfter uploading, if the system can't auto-match a saved config, the <strong>Column Mapper</strong> will open so you can configure each column manually.`,
        waitForUpload: true,
        actionHint: { icon: '👆', text: 'Click Browse Files — the tour pauses until your file is ready' },
    },
    {
        id: 'm-sheets',
        mode: 'manual',
        target: '#sheetTabs',
        triggerTarget: '#sheetTabs',
        position: 'below',
        section: 'columns',
        title: 'Step 2 — Switch between sheets',
        body: `Each worksheet appears as a <strong>tab</strong> (Day 1, Day 2…). Click a tab to switch.\n\nThe badge shows how many <strong>score columns</strong> are configured on each sheet — aim for a number greater than 0 on all sheets.`,
        actionHint: { icon: '🗂️', text: 'Click any sheet tab to switch' },
        missingMsg: '⚠ Sheet tabs appear after you import a file.',
    },
    {
        id: 'm-table',
        mode: 'manual',
        target: '#tableWrap',
        triggerTarget: '#tableWrap',
        position: 'left',
        section: 'columns',
        title: 'Step 3 — The column table',
        body: `Every column header shows its <strong>letter</strong>, <strong>header name</strong>, and an auto-detected <strong>type badge</strong> (score / info / feedback / unset).\n\n<strong>Click any column header</strong> to open the Configure Column panel below the table.`,
        actionHint: { icon: '👆', text: 'Click any column header to configure it' },
        missingMsg: '⚠ The column table appears after you import a file.',
    },
    {
        id: 'm-type',
        mode: 'manual',
        target: '.type-tgl',
        triggerTarget: '#ttScore',
        position: 'above',
        section: 'columns',
        title: 'Step 4 — Set the column type',
        body: `In the <strong>Configure Column</strong> panel, pick one of three types:\n• <strong>📊 Score</strong> — numeric/Likert ratings, averaged per category\n• <strong>ℹ️ Info</strong> — respondent metadata (name, school…)\n• <strong>💬 Feedback</strong> — open-text responses`,
        actionHint: { icon: '👆', text: 'Click Score, Info, or Feedback' },
        missingMsg: '⚠ Open Configure Column panel by clicking a column header in the table.',
    },
    {
        id: 'm-category',
        mode: 'manual',
        target: '#epCat',
        triggerTarget: '#epCat',
        position: 'right',
        section: 'columns',
        title: 'Step 5 — Choose a category',
        body: `After setting the type, choose a <strong>Category</strong>.\n\nFor <em>score</em> columns: <em>Program Management</em>, <em>Resource Speaker</em>, etc.\nFor <em>info</em> columns: <em>Full Name</em>, <em>Email</em>, <em>School / Office</em>, etc.\n\nCan't find the right category? Use <strong>+ Add New Category…</strong> at the bottom of the list.`,
        actionHint: { icon: '👆', text: 'Click this dropdown to pick a category' },
        missingMsg: '⚠ Open the Configure Column panel first.',
    },
    {
        id: 'm-save-ep',
        mode: 'manual',
        target: '.ep-actions',
        triggerTarget: '.ep-actions .btn-primary',
        position: 'above',
        section: 'columns',
        title: 'Step 6 — Save the column config',
        body: `Click <strong>✓ Save</strong> to apply your type and category to the selected column.\n\nThen click the next column or use the shortcuts below to configure many columns at once.`,
        actionHint: { icon: '👆', text: 'Click ✓ Save to apply' },
        missingMsg: '⚠ The Save button appears at the bottom of the Configure Column panel.',
    },
    {
        id: 'm-range',
        mode: 'manual',
        target: '.range-row',
        triggerTarget: '.range-row .btn-primary',
        position: 'above',
        section: 'columns',
        title: 'Shortcut — Apply Range',
        body: `Instead of clicking each column one by one, type a start letter (e.g. <code>N</code>) and end letter (e.g. <code>AU</code>), then click <strong>Apply Range</strong>.\n\nEvery column from N → AU gets the same type and category instantly.`,
        actionHint: { icon: '⚡', text: 'Enter start → end, then click Apply Range' },
        missingMsg: '⚠ The Apply Range row appears inside the Configure Column panel.',
    },
    {
        id: 'm-similar',
        mode: 'manual',
        target: '.ep-actions .btn[onclick*="applyToAllSame"]',
        triggerTarget: '.ep-actions .btn[onclick*="applyToAllSame"]',
        position: 'above',
        section: 'columns',
        title: 'Shortcut — Apply to All Similar',
        body: `Click <strong>↻ Apply to All Similar</strong> to set every column that shares the same base name — perfect for repeated speaker criteria.\n\nOne click configures all four speaker slots at once.`,
        actionHint: { icon: '🔁', text: 'Click ↻ Apply to All Similar' },
        missingMsg: '⚠ This button appears inside the Configure Column panel.',
    },
    {
        id: 'm-stats',
        mode: 'manual',
        target: '#statsToggleBtn',
        triggerTarget: '#statsToggleBtn',
        position: 'below',
        section: 'columns',
        title: 'Check your progress — Column Stats',
        body: `Click <strong>Column Stats</strong> to see Score / Info / Feedback counts and — most importantly — the <strong>Unset count</strong>.\n\nAim for zero unset columns before computing.`,
        actionHint: { icon: '👆', text: 'Click Column Stats to expand' },
    },
    {
        id: 'm-filters',
        mode: 'manual',
        target: '#filterToggleBtn',
        triggerTarget: '#filterToggleBtn',
        position: 'below',
        section: 'columns',
        title: 'Narrow your view — Filters',
        body: `Click <strong>Filters</strong> then tap a category chip to show only columns from that category.\n\nUseful for large files — quickly verify all <em>Resource Speaker</em> columns are assigned correctly.`,
        actionHint: { icon: '👆', text: 'Click Filters, then pick a category chip' },
    },
    {
        id: 'm-rules',
        mode: 'manual',
        target: '#presetAgree',
        triggerTarget: '#presetAgree',
        position: 'right',
        section: 'settings',
        title: 'Optional — Find & Replace presets',
        body: `If responses use text like <em>"Strongly Agree"</em>, click a <strong>preset button</strong> in Settings → Find & Replace to load conversion rules.\n\nThese convert text → numbers before computing averages.`,
        actionHint: { icon: '👆', text: 'Click a preset to load conversion rules' },
    },
    {
        id: 'm-proceed',
        mode: 'manual',
        target: '#proceedBar',
        triggerTarget: '#proceedBtn',
        position: 'above',
        section: 'columns',
        title: 'Step 7 — Save & Compute',
        body: `When all columns are configured, click <strong>Save Settings & Compute →</strong>.\n\n• <span style="color:#4ADE80">● Green dot</span> = ready\n• <span style="color:#F59E0B">● Yellow dot</span> = some columns still unset\n\nThis saves your column config and switches to the Results tab.`,
        actionHint: { icon: '👆', text: 'Click Save Settings & Compute →' },
        missingMsg: '⚠ The proceed bar appears at the bottom of the mapper after you import a file.',
    },
    {
        id: 'm-compute',
        mode: 'manual',
        target: '#computeBtn',
        triggerTarget: '#computeBtn',
        position: 'above',
        section: 'compute',
        title: 'Step 8 — Compute Results',
        body: `On the <strong>② Compute & Results</strong> tab, click <strong>⚡ Compute Results</strong>.\n\nThe system will:\n1. Apply find/replace rules\n2. Average scores per category\n3. Group speaker criteria\n4. Build the consolidated report`,
        actionHint: { icon: '👆', text: 'Click ⚡ Compute Results' },
    },
    {
        id: 'm-save-db',
        mode: 'manual',
        target: '#saveBtn',
        triggerTarget: '#saveBtn',
        position: 'left',
        section: 'compute',
        title: 'Step 9 — Save to Database',
        body: `After computing, click <strong>Save to Database</strong> to open the save form.\n\nFill in the title, sequence number, speaker names, and optionally link to an existing Workshop record.`,
        actionHint: { icon: '👆', text: 'Click Save to Database' },
        missingMsg: '⚠ This button appears after you click ⚡ Compute Results.',
    },
    {
        id: 'm-done',
        mode: 'manual',
        target: null,
        triggerTarget: null,
        position: 'center',
        section: null,
        title: 'You\'re all set! 🎉',
        body: `<strong>Manual import recap:</strong>\n\n① Import file\n② Map columns (type + category)\n③ Set Find & Replace rules if using text responses\n④ Save Settings & Compute\n⑤ Save to the database\n\nReopen this tour via <strong>🎓 Take a Tour</strong> anytime.`,
        actionHint: null,
    },
];

const TOURS = {
    choose: STEPS_SHARED_INTRO,
    auto:   [...STEPS_SHARED_INTRO, ...STEPS_AUTO],
    manual: [...STEPS_SHARED_INTRO, ...STEPS_MANUAL],
};

// ── State ─────────────────────────────────────────────────────────────────────
let tourMode    = 'choose';
let current     = 0;
let injected    = false;
let posRAF      = null;
let waitingForUpload = false;
let _lastHighlightedEl = null;
let _uploadObservers = [];

let backdrop, clickCatcher, ring, pulse, clickArrow, clickLabel, tooltip, arrow, mascot,
    skipBtn, sectionNotice, waitingOverlay;

// ── Check whether a file is already loaded in the app ────────────────────────
function isFileAlreadyLoaded() {
    const badge = document.getElementById('fileBadge');
    const label = document.getElementById('fileNameLabel');
    const badgeVisible = badge && badge.style.display && badge.style.display !== 'none';
    const hasLabel     = label && label.textContent && label.textContent.trim() !== '';
    return badgeVisible && hasLabel;
}

// ── Check whether results have already been computed ─────────────────────────
function isResultsAlreadyComputed() {
    const resultsSection = document.getElementById('resultsSection');
    return resultsSection && !resultsSection.classList.contains('hidden');
}

// ── Auto-detect best tour mode based on current app state ────────────────────
// Returns: 'auto' | 'manual' | 'choose'
function detectTourMode() {
    const fileLoaded   = isFileAlreadyLoaded();
    const hasResults   = isResultsAlreadyComputed();

    // Results exist → clearly auto mode succeeded
    if (hasResults) return 'auto';

    // File is loaded but no results yet — check if mapper is showing (manual flow)
    if (fileLoaded) {
        const mapperContent = document.getElementById('mapperContent');
        const mapperVisible = mapperContent && mapperContent.style.display !== 'none';
        return mapperVisible ? 'manual' : 'auto';
    }

    // No file yet — show chooser
    return 'choose';
}

// ── Find the best starting step index given app state and mode ───────────────
function detectStartStep(mode) {
    const steps = TOURS[mode] || TOURS.choose;

    const fileLoaded = isFileAlreadyLoaded();
    const hasResults = isResultsAlreadyComputed();

    if (mode === 'auto') {
        if (hasResults) {
            // Skip welcome + upload steps — jump straight to results review
            const idx = steps.findIndex(s => s.id === 'a-results');
            return idx >= 0 ? idx : 0;
        }
        if (fileLoaded) {
            // File is loaded, waiting for compute tab
            const idx = steps.findIndex(s => s.id === 'a-results');
            return idx >= 0 ? idx : 0;
        }
        // Start from upload step (skip welcome)
        const idx = steps.findIndex(s => s.id === 'a-upload');
        return idx >= 0 ? idx : 0;
    }

    if (mode === 'manual') {
        if (fileLoaded) {
            // Skip upload step — go to sheet tabs
            const idx = steps.findIndex(s => s.id === 'm-sheets');
            return idx >= 0 ? idx : 0;
        }
        // Start from upload step (skip welcome)
        const idx = steps.findIndex(s => s.id === 'm-upload');
        return idx >= 0 ? idx : 0;
    }

    // 'choose' mode: always show welcome
    return 0;
}

// ── Inject DOM ────────────────────────────────────────────────────────────────
function inject() {
    if (injected) return;
    injected = true;

    const style = document.createElement('style');
    style.id = 'gtStyles';
    style.textContent = CSS;
    document.head.appendChild(style);

    backdrop = document.createElement('div');
    backdrop.id = 'gtBackdrop';
    backdrop.innerHTML = `<svg id="gtBackdropSvg" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <mask id="gtMask">
                <rect width="100%" height="100%" fill="white"/>
                <rect id="gtCutout" rx="10" fill="black"/>
            </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(5,10,25,0.72)" mask="url(#gtMask)"/>
    </svg>`;
    document.body.appendChild(backdrop);

    clickCatcher = document.createElement('div');
    clickCatcher.id = 'gtClickCatcher';
    clickCatcher.addEventListener('click', function () {
        if (!waitingForUpload) advanceTour();
    });
    document.body.appendChild(clickCatcher);

    ring = document.createElement('div'); ring.id = 'gtRing';
    document.body.appendChild(ring);

    pulse = document.createElement('div'); pulse.id = 'gtPulse';
    document.body.appendChild(pulse);

    clickArrow = document.createElement('div');
    clickArrow.id = 'gtClickArrow';
    clickArrow.innerHTML = `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="18" cy="18" r="18" fill="#3B82F6" opacity="0.15"/>
        <path d="M18 8 L18 26 M12 20 L18 27 L24 20" stroke="#3B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    document.body.appendChild(clickArrow);

    clickLabel = document.createElement('div'); clickLabel.id = 'gtClickLabel';
    clickLabel.textContent = 'Click here';
    document.body.appendChild(clickLabel);

    arrow = document.createElement('div'); arrow.id = 'gtArrow';
    document.body.appendChild(arrow);

    tooltip = document.createElement('div'); tooltip.id = 'gtTooltip';
    document.body.appendChild(tooltip);

    mascot = document.createElement('div'); mascot.id = 'gtMascot';
    mascot.textContent = '🎓';
    document.body.appendChild(mascot);

    skipBtn = document.createElement('button'); skipBtn.id = 'gtSkipBtn';
    skipBtn.textContent = 'Skip tour';
    skipBtn.onclick = endTour;
    document.body.appendChild(skipBtn);

    sectionNotice = document.createElement('div'); sectionNotice.id = 'gtSectionNotice';
    document.body.appendChild(sectionNotice);

    waitingOverlay = document.createElement('div'); waitingOverlay.id = 'gtWaitingOverlay';
    waitingOverlay.textContent = 'Tour paused — waiting for your file upload…';
    document.body.appendChild(waitingOverlay);

    document.addEventListener('keydown', onKey);
    watchForFileImport();
}

// ── Watch for file import — detect display:'flex' correctly ──────────────────
function watchForFileImport() {
    // Disconnect any previous observers to avoid duplicates on re-start
    _uploadObservers.forEach(o => o.disconnect());
    _uploadObservers = [];

    const badge = document.getElementById('fileBadge');
    const label = document.getElementById('fileNameLabel');

    // Helper: fires when a file is detected post-upload
    const onFileDetected = () => {
        if (!waitingForUpload) return;
        // Give the app time to finish its post-upload work (auto-compute, etc.)
        setTimeout(() => {
            if (!waitingForUpload) return;
            stopWaitingForUpload();
            advanceTour();
        }, 900);
    };

    // Watch the badge's style attribute — display goes from 'none' → 'flex'
    if (badge) {
        const obs = new MutationObserver(() => {
            const d = badge.style.display;
            // Matches 'flex', 'block', 'inline-flex' — anything that isn't hidden/empty
            if (d && d !== 'none') onFileDetected();
        });
        obs.observe(badge, { attributes: true, attributeFilter: ['style'] });
        _uploadObservers.push(obs);
    }

    // Also watch the filename label text change as a secondary signal
    if (label) {
        const obsLabel = new MutationObserver(() => {
            if (label.textContent && label.textContent.trim()) onFileDetected();
        });
        obsLabel.observe(label, { childList: true, characterData: true, subtree: true });
        _uploadObservers.push(obsLabel);
    }
}

// ── Enter / exit "waiting for upload" mode ────────────────────────────────────
function startWaitingForUpload() {
    waitingForUpload = true;
    if (waitingOverlay) waitingOverlay.classList.add('gt-visible');
    if (clickCatcher)   clickCatcher.classList.remove('gt-catchable');
}

function stopWaitingForUpload() {
    waitingForUpload = false;
    if (waitingOverlay) waitingOverlay.classList.remove('gt-visible');
}

// ── Key handler ───────────────────────────────────────────────────────────────
function onKey(e) {
    if (!backdrop || !backdrop.classList.contains('gt-visible')) return;
    if (waitingForUpload) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') advanceTour();
    if (e.key === 'ArrowLeft') goTo(current - 1);
    if (e.key === 'Escape') endTour();
}

// ── Section helpers ───────────────────────────────────────────────────────────
function getActiveSection() {
    const a = document.querySelector('.tab-btn.active');
    return a ? a.dataset.sec : null;
}
function switchToSection(sec) {
    const btn = document.querySelector(`.tab-btn[data-sec="${sec}"]`);
    if (btn && getActiveSection() !== sec) { btn.click(); return true; }
    return false;
}

function resolveEl(selector) {
    if (!selector) return null;
    for (const sel of selector.split(',').map(s => s.trim())) {
        try {
            const el = document.querySelector(sel);
            if (el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) return el;
        } catch (_) {}
    }
    return null;
}

function clearTriggerHighlight() {
    if (_lastHighlightedEl) {
        _lastHighlightedEl.classList.remove('gt-highlight-pulse');
        _lastHighlightedEl = null;
    }
}
function applyTriggerHighlight(el) {
    clearTriggerHighlight();
    if (!el) return;
    el.classList.add('gt-highlight-pulse');
    _lastHighlightedEl = el;
}

function getSteps() { return TOURS[tourMode] || TOURS.choose; }

// ── Position all overlay elements ─────────────────────────────────────────────
function positionElements(step) {
    const PAD = 10, TIP_W = 330, TIP_H = tooltip.offsetHeight || 260;
    const ARROW_SIZE = 14, VW = window.innerWidth, VH = window.innerHeight;

    const targetEl  = resolveEl(step.target);
    const triggerEl = resolveEl(step.triggerTarget);
    const cutout    = document.getElementById('gtCutout');

    if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const r = targetEl.getBoundingClientRect();
        const p = 7;
        const cx = r.left - p, cy = r.top - p, cw = r.width + p*2, ch = r.height + p*2;

        if (cutout) {
            cutout.setAttribute('x', cx); cutout.setAttribute('y', cy);
            cutout.setAttribute('width', cw); cutout.setAttribute('height', ch);
            cutout.setAttribute('rx', 10);
        }
        ring.style.left   = cx + 'px'; ring.style.top    = cy + 'px';
        ring.style.width  = cw + 'px'; ring.style.height = ch + 'px';
        ring.classList.add('gt-visible');
        pulse.style.left = (cx + cw - 9) + 'px'; pulse.style.top = (cy - 9) + 'px';
        pulse.classList.add('gt-visible');

        const pos = step.position || 'right';
        let tx, ty, ax, ay, arrowBorder = '';
        if (pos === 'right') {
            tx = Math.min(r.right + PAD + ARROW_SIZE, VW - TIP_W - 8);
            ty = Math.max(8, Math.min(r.top, VH - TIP_H - 8));
            ax = tx - ARROW_SIZE/2 - 1; ay = r.top + r.height/2 - ARROW_SIZE/2;
            arrowBorder = 'border-right-color:transparent;border-top-color:transparent;';
        } else if (pos === 'left') {
            tx = Math.max(8, r.left - ARROW_SIZE - TIP_W - PAD);
            ty = Math.max(8, Math.min(r.top, VH - TIP_H - 8));
            ax = tx + TIP_W - ARROW_SIZE/2 + 1; ay = r.top + r.height/2 - ARROW_SIZE/2;
            arrowBorder = 'border-left-color:transparent;border-bottom-color:transparent;';
        } else if (pos === 'below') {
            tx = Math.max(8, Math.min(r.left + r.width/2 - TIP_W/2, VW - TIP_W - 8));
            ty = r.bottom + PAD + ARROW_SIZE;
            ax = r.left + r.width/2 - ARROW_SIZE/2; ay = ty - ARROW_SIZE/2 - 1;
            arrowBorder = 'border-bottom-color:transparent;border-right-color:transparent;';
        } else {
            tx = Math.max(8, Math.min(r.left + r.width/2 - TIP_W/2, VW - TIP_W - 8));
            ty = Math.max(8, r.top - TIP_H - PAD - ARROW_SIZE);
            ax = r.left + r.width/2 - ARROW_SIZE/2; ay = ty + TIP_H - ARROW_SIZE/2 + 1;
            arrowBorder = 'border-top-color:transparent;border-left-color:transparent;';
        }
        ty = Math.max(8, Math.min(ty, VH - TIP_H - 8));
        tx = Math.max(8, Math.min(tx, VW - TIP_W - 8));
        tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
        tooltip.style.width = TIP_W + 'px';
        arrow.style.left = ax + 'px'; arrow.style.top = ay + 'px';
        arrow.style.cssText += arrowBorder;
        arrow.classList.add('gt-visible');
        mascot.style.left = (cx + cw - 28) + 'px'; mascot.style.top = (cy - 62) + 'px';
        mascot.classList.add('gt-visible');
    } else {
        if (cutout) { cutout.setAttribute('width', 0); cutout.setAttribute('height', 0); }
        ring.classList.remove('gt-visible');
        pulse.classList.remove('gt-visible');
        arrow.classList.remove('gt-visible');
        mascot.classList.remove('gt-visible');
        tooltip.style.left  = Math.max(8, (VW - TIP_W)/2) + 'px';
        tooltip.style.top   = Math.max(8, (VH - TIP_H)/2) + 'px';
        tooltip.style.width = TIP_W + 'px';
    }

    const trig = triggerEl || targetEl;
    if (trig && step.triggerTarget) {
        trig.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const tr = trig.getBoundingClientRect();
        const aX = tr.left + tr.width/2 - 18;
        const aY = tr.top - 36 - 22 - 6;
        clickArrow.style.left = aX + 'px';
        clickArrow.style.top  = Math.max(4, aY + 22 + 4) + 'px';
        clickLabel.style.left = (tr.left + tr.width/2 - 40) + 'px';
        clickLabel.style.top  = Math.max(4, aY) + 'px';
        clickArrow.classList.add('gt-visible');
        clickLabel.classList.add('gt-visible');
        applyTriggerHighlight(trig);
    } else {
        clickArrow.classList.remove('gt-visible');
        clickLabel.classList.remove('gt-visible');
        clearTriggerHighlight();
    }

    tooltip.classList.add('gt-visible');
    backdrop.classList.add('gt-visible');
    skipBtn.classList.add('gt-visible');

    if (clickCatcher) {
        const needsPageInteraction = !!step.triggerTarget || !!step.waitForUpload;
        clickCatcher.classList.toggle('gt-catchable', !needsPageInteraction && !waitingForUpload);
    }
}

// ── Render tooltip HTML ───────────────────────────────────────────────────────
function renderTooltip(step, idx) {
    const steps   = getSteps();
    const isLast  = idx === steps.length - 1;
    const bodyHtml = step.body.replace(/\n/g, '<br>');
    const fileLoaded = isFileAlreadyLoaded();

    const modeLabels = { auto: '⚡ Auto Import', manual: '🗂️ Manual Import', shared: '👋 Getting Started', choose: '👋 Getting Started' };
    const modeCls    = { auto: 'auto', manual: 'manual', shared: 'shared', choose: 'shared' };
    const bannerHtml = `<div class="gt-mode-banner ${modeCls[step.mode] || 'shared'}">
        <span class="gt-mode-icon">${step.mode === 'auto' ? '⚡' : step.mode === 'manual' ? '🗂️' : '👋'}</span>
        ${modeLabels[step.mode] || 'Tour'}
    </div>`;

    // Determine action hint — if file is already loaded and this is a waitForUpload step,
    // show a "file already loaded" notice instead of the upload prompt
    let actionHtml = '';
    if (step.waitForUpload) {
        if (fileLoaded) {
            const fname = document.getElementById('fileNameLabel')?.textContent?.trim() || 'file';
            actionHtml = `<div class="gt-file-loaded-info">
                <span>✅</span>
                <span><strong>${fname}</strong> is already loaded — click <strong>Next →</strong> to continue</span>
            </div>`;
        } else {
            actionHtml = `<div class="gt-upload-hint">
                <span class="gt-hint-icon">📂</span>
                <span>Upload your file now — the tour will continue automatically</span>
            </div>`;
        }
    } else if (step.actionHint) {
        actionHtml = `<div class="gt-action-hint">
            <span class="gt-hint-icon">${step.actionHint.icon}</span>
            <span>${step.actionHint.text}</span>
        </div>`;
    }

    const targetPresent = resolveEl(step.target) !== null;
    const missingHtml = (!targetPresent && step.target && step.missingMsg)
        ? `<div class="gt-missing-warn">⚠ ${step.missingMsg}</div>` : '';

    let modeSwitchHtml = '';
    if (step.showModeSwitcher) {
        modeSwitchHtml = `<div class="gt-mode-switch">
            <div class="gt-mode-switch-label">Which tour do you need?</div>
            <button class="gt-mode-btn ${tourMode === 'auto' ? 'active-auto' : ''}"
                onclick="gtSwitchMode('auto')" style="text-align:left;padding:9px 11px;">
                <div style="font-weight:800;margin-bottom:3px">⚡ Auto Import</div>
                <div style="font-size:10px;opacity:.75">File is recognised, system computes automatically</div>
            </button>
            <button class="gt-mode-btn ${tourMode === 'manual' ? 'active-manual' : ''}"
                onclick="gtSwitchMode('manual')" style="text-align:left;padding:9px 11px;">
                <div style="font-weight:800;margin-bottom:3px">🗂️ Manual Import</div>
                <div style="font-size:10px;opacity:.75">New file, needs column mapping &amp; configuration</div>
            </button>
        </div>`;
    }

    const dots = steps.map((_, i) => {
        const cls = i < idx ? 'done' : (i === idx ? 'active' : '');
        return `<div class="gt-dot ${cls}" onclick="gtGoTo(${i})" title="Step ${i+1}"></div>`;
    }).join('');

    const stepLabel = step.showModeSwitcher ? 'Welcome' : `STEP ${idx + 1} / ${steps.length}`;

    // Determine Next button label/state
    let nextLabel = 'Next →';
    let nextDisabled = false;
    if (isLast) {
        nextLabel = '✓ Done';
    } else if (step.waitForUpload && !fileLoaded) {
        nextLabel = 'Upload to continue ↑';
        nextDisabled = true;
    }

    tooltip.innerHTML = `
        ${bannerHtml}
        <div class="gt-tip-header">
            <span class="gt-step-badge">${stepLabel}</span>
            <span class="gt-tip-title">${step.title}</span>
            <button class="gt-close-btn" onclick="endTour()" title="Close">✕</button>
        </div>
        <div class="gt-tip-body">
            ${bodyHtml}
            ${missingHtml}
            ${modeSwitchHtml}
            ${actionHtml}
        </div>
        <div class="gt-tip-footer">
            <div class="gt-dot-track">${dots}</div>
            <div class="gt-nav">
                <button class="gt-nav-btn" onclick="gtGoTo(${idx-1})" ${idx===0?'disabled':''}>← Back</button>
                <button class="gt-nav-btn primary" ${nextDisabled ? 'disabled style="opacity:.4"' : ''}
                    onclick="${isLast ? 'endTour()' : 'gtGoTo('+(idx+1)+')'}">
                    ${nextLabel}
                </button>
            </div>
        </div>`;
}

// ── Show a step ───────────────────────────────────────────────────────────────
function showStep(idx) {
    const steps = getSteps();
    if (idx < 0 || idx >= steps.length) return;
    current = idx;
    const step = steps[idx];

    // Handle waitForUpload — if file is already there, don't pause
    if (step.waitForUpload) {
        if (!isFileAlreadyLoaded()) {
            startWaitingForUpload();
        } else {
            // File already loaded — skip upload step entirely, go to next
            stopWaitingForUpload();
            goTo(idx + 1);
            return;
        }
    } else {
        stopWaitingForUpload();
    }

    if (step.section && getActiveSection() !== step.section) {
        showSectionNotice(step.section, () => {
            switchToSection(step.section);
            setTimeout(() => renderStep(step, idx), 380);
        });
        return;
    }
    renderStep(step, idx);
}

function renderStep(step, idx) {
    sectionNotice.classList.remove('gt-visible');
    renderTooltip(step, idx);
    requestAnimationFrame(() => requestAnimationFrame(() => positionElements(step)));
}

function showSectionNotice(sec, cb) {
    const labels = { columns: '① Import & Map', compute: '② Compute & Results', settings: '⚙ Settings' };
    const icons  = { columns: '🗂️', compute: '⚡', settings: '⚙️' };
    sectionNotice.innerHTML = `
        <div class="gt-notice-icon">${icons[sec] || '📄'}</div>
        <div class="gt-notice-title">Switching to ${labels[sec] || sec}</div>
        <div class="gt-notice-sub">The next step is on a different tab. Switching now…</div>`;
    sectionNotice.classList.add('gt-visible');
    setTimeout(cb, 900);
}

// ── Navigation ────────────────────────────────────────────────────────────────
function advanceTour() {
    const steps = getSteps();
    if (current < steps.length - 1) goTo(current + 1);
    else endTour();
}

function goTo(idx) {
    const steps = getSteps();
    if (idx < 0 || idx >= steps.length) return;
    clearTriggerHighlight();
    stopWaitingForUpload();
    tooltip.classList.remove('gt-visible');
    arrow.classList.remove('gt-visible');
    clickArrow.classList.remove('gt-visible');
    clickLabel.classList.remove('gt-visible');
    setTimeout(() => showStep(idx), 160);
}

// ── Mode switching ────────────────────────────────────────────────────────────
function switchMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') return;
    tourMode = mode;
    renderTooltip(getSteps()[0], 0);
    requestAnimationFrame(() => requestAnimationFrame(() => positionElements(getSteps()[0])));
}

// ── End tour ──────────────────────────────────────────────────────────────────
function endTour() {
    clearTriggerHighlight();
    stopWaitingForUpload();
    _uploadObservers.forEach(o => o.disconnect());
    _uploadObservers = [];
    if (clickCatcher) clickCatcher.classList.remove('gt-catchable');
    [backdrop, ring, pulse, clickArrow, clickLabel, arrow, tooltip, mascot, skipBtn, sectionNotice, waitingOverlay]
        .forEach(el => el && el.classList.remove('gt-visible'));
    document.removeEventListener('keydown', onKey);
}

// ── Reposition on scroll/resize ───────────────────────────────────────────────
function onScroll() {
    if (!backdrop || !backdrop.classList.contains('gt-visible')) return;
    cancelAnimationFrame(posRAF);
    posRAF = requestAnimationFrame(() => positionElements(getSteps()[current]));
}
window.addEventListener('scroll', onScroll, true);
window.addEventListener('resize', onScroll);

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * startGuidedTour(startIdx?, mode?)
 *
 * If mode is not provided, it is auto-detected from the current app state:
 *   - Results already computed  → 'auto' tour, starting at results review step
 *   - File loaded, mapper open  → 'manual' tour, starting at sheet tabs step
 *   - File loaded, no mapper    → 'auto' tour, starting at results step
 *   - No file loaded            → 'choose' mode (welcome + mode picker)
 *
 * Passing mode explicitly overrides auto-detection.
 */
window.startGuidedTour = function (startIdx, mode) {
    inject();

    // Re-register key handler (may have been removed by endTour)
    document.removeEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);

    // Re-attach upload observers (disconnected on endTour)
    watchForFileImport();

    // Auto-detect mode if not explicitly provided
    if (mode === 'auto' || mode === 'manual') {
        tourMode = mode;
    } else {
        tourMode = detectTourMode();
    }

    // Auto-detect start step if not explicitly provided
    const start = (typeof startIdx === 'number') ? startIdx : detectStartStep(tourMode);

    showStep(start);
};

window.gtSwitchMode = switchMode;
window.endTour      = endTour;
window.gtGoTo       = goTo;

})();