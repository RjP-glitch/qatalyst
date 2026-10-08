// ═══════════════════════════════════════════════════════════════════════════════
// import-excell.js  —  Merged Column Settings + Excel Importer + Compute/Save
// ═══════════════════════════════════════════════════════════════════════════════

// ==================== NAVIGATION ====================

// Read the ?page= param set by programs.js when navigating here,
// so the "Programs / Workshops" sidebar link and any back-navigation
// returns to the correct page (qatame.html, qms.html, sbm.html, etc.)
// instead of always going to programs.html.
const _PAGE_BACK = (() => {
    const pageMap = {
        qatame:  'qatame.html',
        qms:     'qms.html',
        sbm:     'sbm.html',
        sgc:     'sgc.html',
        sdopir:  'sdopir.html',
        spir:    'spir.html',
    };
    const param = new URLSearchParams(window.location.search).get('page') || '';
    return pageMap[param] || 'qatame.html'; // default to qatame if param missing/unknown
})();

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

function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}

function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

let expandedMenus = {};

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


// ═══════════════════════════════════════════════════════════════════════════════
// COLUMN SETTINGS DATA
// ═══════════════════════════════════════════════════════════════════════════════

// (Data is loaded dynamically via file upload — no hardcoded data)

// Sample rows are populated dynamically after file upload

// ── CHANGE 1: Renamed to FALLBACK_SCORE_CATEGORIES — used only if DB call fails ──
const FALLBACK_SCORE_CATEGORIES = [
    { name: 'Program Management and Operations', color: '#1D4ED8', bg: '#DBEAFE', border: '#93C5FD' },
    { name: 'Attainment of Objectives',          color: '#065F46', bg: '#D1FAE5', border: '#6EE7B7' },
    { name: 'Delivery of Content',               color: '#92400E', bg: '#FEF3C7', border: '#FCD34D' },
    { name: 'Conduct of the Ceremony',           color: '#0E7490', bg: '#ECFEFF', border: '#67E8F9' },
    { name: 'Venue',                             color: '#5B21B6', bg: '#EDE9FE', border: '#C4B5FD' },
    { name: 'Meal',                              color: '#9D174D', bg: '#FCE7F3', border: '#F9A8D4' },
    { name: 'Program Management Team',           color: '#0E7490', bg: '#ECFEFF', border: '#67E8F9' },
    { name: 'Feedbacks',                         color: '#6D28D9', bg: '#F5F3FF', border: '#C4B5FD' },
    { name: 'Resource Speaker',                  color: '#B45309', bg: '#FEF3C7', border: '#FDE68A' },
];

// ── CHANGE 1 (cont): Runtime list populated from DB on boot ──
// Falls back to FALLBACK_SCORE_CATEGORIES if the API is unreachable.
let DB_SCORE_CATEGORIES = [];

// ── CHANGE 1 (cont): Load categories from evaluation_question_categories table ──
async function loadCategoriesFromDB() {
    try {
        const res  = await fetch(CONFIG.API_URL + '/evaluation_question_categories.php');
        const data = await res.json();
        if (data.success && Array.isArray(data.categories) && data.categories.length) {
            const persistedStyles = getPersistedCategoryStyles();
            const byName = new Map(FALLBACK_SCORE_CATEGORIES.map(c => [c.name, c]));
            DB_SCORE_CATEGORIES = data.categories.map(cat => {
                const name = normalizeCategoryName(cat.name);
                const persisted = persistedStyles[name];
                if (persisted) return { name, color: persisted.color, bg: persisted.bg, border: persisted.border };
                const preset = byName.get(name);
                if (preset) return preset;
                return { name, ...getPaletteStyleForName(name) };
            });
            return true;
        }
    } catch (err) {
        console.warn('[loadCategoriesFromDB] failed, using fallback:', err.message);
    }
    DB_SCORE_CATEGORIES = [...FALLBACK_SCORE_CATEGORIES];
    return false;
}

// ── CHANGE 1 (cont): Save a new category to the DB ──
async function saveNewCategoryToDB(name) {
    // Defense-in-depth: even if a caller bypasses the dropdown's own dedup
    // check, don't POST a name that's just a variant of one we already know.
    const existing = findMatchingKnownScoreCategory(name);
    if (existing) return true;

    try {
        const res  = await fetch(CONFIG.API_URL + '/evaluation_question_categories.php', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name: name.trim() }),
        });
        const data = await res.json();
        if (data.success) {
            await loadCategoriesFromDB(); // refresh local list
            return true;
        }
        console.warn('[saveNewCategoryToDB]', data.message);
        return false;
    } catch (err) {
        console.warn('[saveNewCategoryToDB] network error:', err.message);
        return false;
    }
}

// Palette for categories that come from Teams/forms but are not in defaults.
const CATEGORY_STYLE_PALETTE = [
    { color: '#1D4ED8', bg: '#DBEAFE', border: '#93C5FD' },
    { color: '#065F46', bg: '#D1FAE5', border: '#6EE7B7' },
    { color: '#92400E', bg: '#FEF3C7', border: '#FCD34D' },
    { color: '#5B21B6', bg: '#EDE9FE', border: '#C4B5FD' },
    { color: '#9D174D', bg: '#FCE7F3', border: '#F9A8D4' },
    { color: '#0E7490', bg: '#ECFEFF', border: '#67E8F9' },
    { color: '#6D28D9', bg: '#F5F3FF', border: '#C4B5FD' },
    { color: '#B45309', bg: '#FEF3C7', border: '#FDE68A' },
];

const ADD_NEW_CATEGORY_VALUE = '__add_new_category__';
let runtimeCustomScoreCategories = [];

// Info sub-categories (for respondent metadata columns)
const INFO_CATEGORIES = [
    { name: 'Full Name', color: '#1E40AF', bg: '#DBEAFE', border: '#93C5FD', field: 'ri_name', keywords: ['full name', 'fullname', 'complete name', 'name of respondent', 'respondent name', 'participant name', 'your name'] },
    { name: 'Email', color: '#7C3AED', bg: '#EDE9FE', border: '#C4B5FD', field: 'ri_email', keywords: ['email address', 'email', 'e-mail', 'gmail', 'electronic mail', 'koreo'] },
    { name: 'Sex / Gender', color: '#BE185D', bg: '#FCE7F3', border: '#F9A8D4', field: 'ri_sex', keywords: ['sex', 'gender', 'male/female', 'sex/gender', 'kasarian', 'lalaki/babae'] },
    { name: 'Participant Type', color: '#0369A1', bg: '#E0F2FE', border: '#7DD3FC', field: 'ri_type', keywords: ['participants', 'participant', 'type of participant', 'respondent type', 'category of participant'] },
    { name: 'Designation', color: '#92400E', bg: '#FEF3C7', border: '#FCD34D', field: 'ri_desig', keywords: ['designation', 'position', 'rank', 'job title', 'title'] },
    { name: 'School / Office', color: '#065F46', bg: '#D1FAE5', border: '#6EE7B7', field: 'ri_school', keywords: ['school', 'office', 'office/school', 'school/office', 'station', 'workplace', 'organization', 'agency', 'division'] },
    { name: 'ID', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['response id', 'respondent id', 'id number'] },
    { name: 'Timestamp', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['start time', 'completion time', 'timestamp', 'last modified', 'modified time', 'date submitted', 'submit time'] },
    { name: 'Privacy Notice', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['privacy', 'consent', 'your privacy', 'data privacy', 'agree to'] },
    { name: 'District', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['district'] },
    { name: 'Region', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['region'] },
    { name: 'Contact', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1', field: null, keywords: ['contact', 'phone', 'mobile', 'cellphone'] },
];

function normalizeCategoryName(name) {
    return String(name || '').trim();
}

// ── Dedup guard: prevents "+ Add New Category" from creating near-duplicate
// categories (different case, extra whitespace, or "&" vs "and") that would
// silently fork the canonical evaluation_question_categories list. This is
// the client-side half of the fix — it stops new drift from being created;
// it does not retroactively clean up any variant spellings already saved.
function categoryDedupKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\(.*?\)/g, ' ')   // strip parenthetical qualifiers, e.g. "(FOR IN-PERSON ATTENDEES ONLY)" — mirrors normalizeCategoryMatchKey() in config/category_matching.php
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Returns the existing category (from the DB-backed known list) whose
// dedup key matches the candidate name, or null if there's no match.
// Checked against getScoreCategories() rather than just DB_SCORE_CATEGORIES
// so it also catches collisions with runtime/session-added or
// settings-configured categories, not only ones already persisted to DB.
function findMatchingKnownScoreCategory(name) {
    const key = categoryDedupKey(name);
    if (!key) return null;
    return getScoreCategories().find(c => categoryDedupKey(c.name) === key) || null;
}

function getConfiguredCategoryNamesFromSettings() {
    if (!dbSettings || !dbSettings.categories || typeof dbSettings.categories !== 'object') return [];
    return Object.keys(dbSettings.categories).map(normalizeCategoryName).filter(Boolean);
}

function isValidCategoryStyle(style) {
    return !!style
        && typeof style === 'object'
        && typeof style.color === 'string'
        && typeof style.bg === 'string'
        && typeof style.border === 'string'
        && style.color.trim() !== ''
        && style.bg.trim() !== ''
        && style.border.trim() !== '';
}

function getPersistedCategoryStyles() {
    if (!dbSettings || !dbSettings.category_styles || typeof dbSettings.category_styles !== 'object') {
        return {};
    }
    const out = {};
    Object.entries(dbSettings.category_styles).forEach(([name, style]) => {
        const key = normalizeCategoryName(name);
        if (!key || !isValidCategoryStyle(style)) return;
        out[key] = {
            color: style.color.trim(),
            bg: style.bg.trim(),
            border: style.border.trim()
        };
    });
    return out;
}

function getPaletteStyleForName(name) {
    let hash = 0;
    const str = normalizeCategoryName(name).toLowerCase();
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % CATEGORY_STYLE_PALETTE.length;
    return CATEGORY_STYLE_PALETTE[idx];
}

function getCategoryNamesFromMappedSheets() {
    const names = new Set();
    Object.values(sheetsData || {}).forEach(cols => {
        (cols || []).forEach(c => {
            if (c && c.type === 'score' && c.category) {
                const name = normalizeCategoryName(c.category);
                if (name) names.add(name);
            }
        });
    });
    return [...names];
}

// ── CHANGE 2: getScoreCategories() now reads from DB_SCORE_CATEGORIES ──
function getScoreCategories() {
    const base = DB_SCORE_CATEGORIES.length
        ? DB_SCORE_CATEGORIES
        : FALLBACK_SCORE_CATEGORIES;

    const byName        = new Map(base.map(c => [c.name, c]));
    const persistedStyles = getPersistedCategoryStyles();
    const orderedNames  = [];
    const pushUnique    = n => {
        const name = normalizeCategoryName(n);
        if (name && !orderedNames.includes(name)) orderedNames.push(name);
    };

    // Priority: DB categories → settings-configured → runtime custom → sheet-mapped
    base.forEach(c => pushUnique(c.name));
    getConfiguredCategoryNamesFromSettings().forEach(pushUnique);
    runtimeCustomScoreCategories.forEach(pushUnique);
    getCategoryNamesFromMappedSheets().forEach(pushUnique);

    return orderedNames.map(name => {
        const persisted = persistedStyles[name];
        if (persisted) return { name, color: persisted.color, bg: persisted.bg, border: persisted.border };
        const preset = byName.get(name);
        if (preset) return preset;
        return { name, ...getPaletteStyleForName(name) };
    });
}

function addRuntimeScoreCategory(name) {
    const normalized = normalizeCategoryName(name);
    if (!normalized) return '';
    if (!runtimeCustomScoreCategories.includes(normalized)) {
        runtimeCustomScoreCategories.push(normalized);
    }
    return normalized;
}

function getAllCategories() {
    return [...getScoreCategories(), ...INFO_CATEGORIES];
}

function getSpeakerCriteriaCount(speakerCols) {
    if (!Array.isArray(speakerCols) || speakerCols.length === 0) return 0;

    const configuredCount = Array.isArray(dbSettings?.speaker_criteria)
        ? dbSettings.speaker_criteria.filter(Boolean).length
        : 0;
    if (configuredCount > 0) return configuredCount;

    const normalize = name => String(name || '')
        .replace(/\s*\[Speaker\s+\d+\]\s*/ig, '')
        .replace(/\s*\(\d+\)\s*$/, '')
        .replace(/\s*[.\-_]?\s*\d+\s*$/, '')
        .replace(/Somewhat Satisfied\s*$/i, '')
        .trim()
        .toLowerCase();

    const firstBase = normalize(speakerCols[0]?.name);
    if (!firstBase) return Math.min(6, speakerCols.length);

    let inferred = speakerCols.length;
    for (let i = 1; i < speakerCols.length; i++) {
        if (normalize(speakerCols[i]?.name) === firstBase) {
            inferred = i;
            break;
        }
    }
    if (!Number.isFinite(inferred) || inferred <= 0) return Math.min(6, speakerCols.length);
    return inferred;
}

function detectImportMappingDrift(sheetsMap) {
    // Build known category dedup keys from DB list + settings.
    // Uses categoryDedupKey() (case/whitespace/"&" vs "and"/parenthetical-
    // insensitive) rather than exact string equality, so a category already
    // in the DB — however it happens to be spelled/punctuated in this
    // particular Excel file's header — isn't falsely flagged as "new".
    // Mirrors findMatchingKnownScoreCategory()'s matching behavior.
    const knownCategoryKeys = new Set([
        ...(DB_SCORE_CATEGORIES.length ? DB_SCORE_CATEGORIES : FALLBACK_SCORE_CATEGORIES).map(c => categoryDedupKey(c.name)),
        ...getConfiguredCategoryNamesFromSettings().map(categoryDedupKey),
    ]);

    const unknownCategories = new Set();
    const uncategorizedQuestions = [];
    const speakerCriteriaMismatches = [];

    Object.entries(sheetsMap || {}).forEach(([sheetName, cols]) => {
        const speakerCols = [];

        (cols || []).forEach(col => {
            if (!col || (col.type !== 'score' && col.type !== 'feedback')) return;

            if (col.type === 'score' && !col.category) {
                uncategorizedQuestions.push({
                    sheet: sheetName,
                    letter: col.letter,
                    name: String(col.name || '').trim()
                });
                return;
            }

            // feedback columns with a category are fine (e.g. 'Feedbacks' is expected);
            // only flag score columns whose category is completely unknown.
            const catKey = categoryDedupKey(col.category);
            if (col.type === 'score' && col.category && catKey && !knownCategoryKeys.has(catKey)) {
                unknownCategories.add(col.category);
            }

            if (col.category === 'Resource Speaker') {
                speakerCols.push(col);
            }
        });

        if (speakerCols.length > 0) {
            const criteriaCount = getSpeakerCriteriaCount(speakerCols);
            if (criteriaCount > 0 && speakerCols.length % criteriaCount !== 0) {
                speakerCriteriaMismatches.push({
                    sheet: sheetName,
                    speakerCols: speakerCols.length,
                    criteriaCount,
                });
            }
        }
    });

    const needsReview = unknownCategories.size > 0
        || uncategorizedQuestions.length > 0
        || speakerCriteriaMismatches.length > 0;

    return {
        needsReview,
        unknownCategories: [...unknownCategories],
        uncategorizedQuestions,
        speakerCriteriaMismatches,
    };
}

function buildImportDriftWarningMessage(drift) {
    const lines = [];

    if (drift.unknownCategories.length > 0) {
        lines.push('New category detected: ' + drift.unknownCategories.join(', '));
    }

    if (drift.uncategorizedQuestions.length > 0) {
        const preview = drift.uncategorizedQuestions
            .slice(0, 3)
            .map(q => `${q.sheet} ${q.letter}: ${q.name || 'Untitled question'}`)
            .join(' | ');
        lines.push(`${drift.uncategorizedQuestions.length} score question column(s) need category mapping${preview ? ' (' + preview + ')' : ''}.`);
    }

    if (drift.speakerCriteriaMismatches.length > 0) {
        const detail = drift.speakerCriteriaMismatches
            .map(m => `${m.sheet}: ${m.speakerCols} speaker cols vs ${m.criteriaCount} criteria`)
            .join(' | ');
        lines.push('Speaker criteria pattern changed (' + detail + ').');
    }

    return lines.join(' ');
}

/**
 * Detect the best info sub-category from a column header name.
 * Returns the INFO_CATEGORIES entry or null.
 */
function detectInfoCategory(headerName) {
    const lower = headerName.toLowerCase().trim();
    let best = null, bestLen = 0;
    for (const ic of INFO_CATEGORIES) {
        for (const kw of ic.keywords) {
            if (lower.includes(kw) && kw.length > bestLen) {
                best = ic; bestLen = kw.length;
            }
        }
    }
    return best;
}

/**
 * After columns are classified, auto-populate the respondent info inputs
 * (ri_name, ri_email, etc.) from the first sheet's detected info columns.
 */
function autoPopulateRespondentFields(sheetCols) {
    for (const ic of INFO_CATEGORIES) {
        if (!ic.field) continue;
        const col = sheetCols.find(c => c.type === 'info' && c.category === ic.name);
        const el = document.getElementById(ic.field);
        if (col && el) el.value = col.letter;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
let sheetsData = {};
let currentSheet = '';
let selIdx = null;
let customTags = [];
let activeFilter = null;
let SAMPLE_ROWS_DYNAMIC = null;
let pendingConfig = null;
let dbSettings = null;

// Compute / results state
let selectedFile = null;
let findReplaceRules = [];
let resultsData = null;
let speakerNames = {};
let lastConsolidated = null;
let replaceImportId = null;
let replaceProgramId = null;


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
function setSection(el) {
    document.querySelectorAll('.tab-btn').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.content-area > .section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById('sec-' + el.dataset.sec);
    if (sec) sec.classList.add('active');
}


// ═══════════════════════════════════════════════════════════════════════════════
// HEADER DROPDOWN
// ═══════════════════════════════════════════════════════════════════════════════
function toggleHeaderDropdown(e) {
    e.stopPropagation();
    const menu = document.getElementById('headerDropdownMenu');
    menu.classList.toggle('open');
}
document.addEventListener('click', function() {
    const menu = document.getElementById('headerDropdownMenu');
    if (menu) menu.classList.remove('open');
});


// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS ACCORDION
// ═══════════════════════════════════════════════════════════════════════════════
function toggleAccordion(btn) {
    const isOpen = btn.classList.contains('open');
    btn.classList.toggle('open');
    const body = btn.nextElementSibling;
    body.classList.toggle('open');
}


// ═══════════════════════════════════════════════════════════════════════════════
// STATS BAR TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════
function toggleStatsBar() {
    const bar = document.getElementById('statsBar');
    const btn = document.getElementById('statsToggleBtn');
    const isHidden = bar.classList.contains('stats-bar--hidden');
    bar.classList.toggle('stats-bar--hidden', !isHidden);
    bar.classList.toggle('stats-bar--visible', isHidden);
    btn.classList.toggle('open', isHidden);
}

function toggleFilterBar() {
    const bar = document.getElementById('catLegend');
    const btn = document.getElementById('filterToggleBtn');
    const isHidden = bar.classList.contains('stats-bar--hidden');
    bar.classList.toggle('stats-bar--hidden', !isHidden);
    btn.classList.toggle('open', isHidden);
}

function toggleOverviewBar() {
    const bar = document.getElementById('overviewWrap');
    const btn = document.getElementById('overviewToggleBtn');
    const isHidden = bar.classList.contains('stats-bar--hidden');
    bar.classList.toggle('stats-bar--hidden', !isHidden);
    btn.classList.toggle('open', isHidden);
}

function toggleFindReplace() {
    const body = document.getElementById('findReplaceBody');
    const arrow = document.getElementById('findReplaceArrow');
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    arrow.style.transform = isHidden ? '' : 'rotate(180deg)';
}

function toggleResultsBody() {
    const body = document.getElementById('resultsBody');
    const arrow = document.getElementById('resultsBodyArrow');
    const sticky = document.getElementById('summaryCardsSticky');
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    arrow.style.transform = isHidden ? '' : 'rotate(180deg)';
    if (sticky) sticky.classList.toggle('hidden', isHidden);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLUMN MAPPER — INIT & RENDER
// ═══════════════════════════════════════════════════════════════════════════════
function init() {
    showUploadZone();
    updateWorkflowStep(1);
}

function showUploadZone() {
    document.getElementById('uploadZone').style.display = 'flex';
    document.getElementById('mapperContent').style.display = 'none';
    document.getElementById('fileBadge').style.display = 'none';
    const pb = document.getElementById('proceedBar');
    if (pb) pb.style.display = 'none';
    document.getElementById('heroSub').innerHTML = 'Import an Excel file (.xlsx, .xls) or CSV to get started.';
}

function showMapperContent() {
    document.getElementById('uploadZone').style.display = 'none';
    document.getElementById('mapperContent').style.display = '';
    const pb = document.getElementById('proceedBar');
    if (pb) pb.style.display = 'flex';
}

function renderSheetTabs() {
    const container = document.getElementById('sheetTabs');
    container.innerHTML = Object.keys(sheetsData).map(s => {
        const cols = sheetsData[s];
        const scoreCount = cols.filter(c => c.type === 'score').length;
        return `<div class="st${s === currentSheet ? ' active' : ''}" onclick="switchSheet('${s}')">
      ${s} <span class="st-badge">${scoreCount} score</span>
    </div>`;
    }).join('');
    const sheets = Object.keys(sheetsData);
    if (sheets.length >= 2) {
        const d1 = sheetsData[sheets[0]].length;
        const d2 = sheetsData[sheets[1]].length;
        if (d1 !== d2) {
            document.getElementById('sheetDiffNote').innerHTML = `<span class="diff-badge">⚠ Column count differs: ${sheets[0]}=${d1}, ${sheets[1]}=${d2}</span>`;
        }
    }
}

let allInlineConfigs = [];
let appliedConfigId  = null;

function toggleInlineConfigs() {
    const bar = document.getElementById('inlineConfigsBar');
    bar.classList.toggle('open');
}

function openInlineConfigs() {
    const bar = document.getElementById('inlineConfigsBar');
    bar.classList.add('open');
}

async function loadInlineConfigs() {
    const grid       = document.getElementById('inlineConfigsGrid');
    const countBadge = document.getElementById('inlineConfigsCount');

    if (grid) {
        grid.innerHTML = '<div class="inline-configs-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading configurations…</div>';
    }

    try {
        const res = await fetch(CONFIG.API_URL + '/column_configs.php');

        if (!res.ok) throw new Error('Server error: HTTP ' + res.status);

        const data = await res.json();

        if (!data.success || !Array.isArray(data.configs) || !data.configs.length) {
            if (grid) {
                grid.innerHTML = '<div class="inline-configs-empty"><i class="fa-solid fa-box-open"></i> No saved configurations yet. Map your columns and click "Save Config" to create one!</div>';
            }
            if (countBadge) countBadge.textContent = '0';
            allInlineConfigs = [];
            return;
        }

        allInlineConfigs = data.configs;
        if (countBadge) countBadge.textContent = data.configs.length;
        if (grid) renderInlineConfigGrid(data.configs);

    } catch (err) {
        allInlineConfigs = [];
        if (countBadge) countBadge.textContent = '0';
        if (grid) grid.innerHTML = `<div class="inline-configs-empty" style="color:#EF4444"><i class="fa-solid fa-circle-exclamation"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
        console.error('[loadInlineConfigs]', err);
    }
}

function renderInlineConfigGrid(configs) {
    const grid = document.getElementById('inlineConfigsGrid');

    if (!configs.length) {
        grid.innerHTML = '<div class="inline-configs-empty"><i class="fa-solid fa-magnifying-glass"></i> No configurations match your search.</div>';
        return;
    }

    grid.innerHTML = configs.map(c => {
        const date = new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        let scoreCount = 0, speakerCount = 0, feedbackCount = 0, infoCount = 0, totalCols = 0;
        if (c.config && c.config.sheets) {
            const firstSheet = c.config.sheets[Object.keys(c.config.sheets)[0]] ?? [];
            totalCols     = firstSheet.length;
            scoreCount    = firstSheet.filter(col => col.type === 'score' && col.category !== 'Resource Speaker').length;
            speakerCount  = firstSheet.filter(col => col.category === 'Resource Speaker').length;
            feedbackCount = firstSheet.filter(col => col.type === 'feedback').length;
            infoCount     = firstSheet.filter(col => col.type === 'info').length;
        }

        const pills = [
            scoreCount    ? `<span class="icfg-pill icfg-pill--score">📊 ${scoreCount} score</span>` : '',
            speakerCount  ? `<span class="icfg-pill icfg-pill--speaker">🎤 ${speakerCount} speaker</span>` : '',
            feedbackCount ? `<span class="icfg-pill icfg-pill--feedback">💬 ${feedbackCount} feedback</span>` : '',
            infoCount     ? `<span class="icfg-pill icfg-pill--info">ℹ️ ${infoCount} info</span>` : '',
        ].filter(Boolean).join('');

        const isApplied  = appliedConfigId === c.id;
        const sheetCount = c.config && c.config.sheets ? Object.keys(c.config.sheets).length : c.sheet_count;

        return `<div class="inline-config-card${isApplied ? ' is-applied' : ''}" onclick="applyInlineConfig(${c.id})">
            <div class="icfg-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
            <div class="icfg-meta">${sheetCount} sheet(s) · ${totalCols || c.column_count} cols · ${date}</div>
            ${pills ? `<div class="icfg-pills">${pills}</div>` : ''}
            ${c.description ? `<div class="icfg-desc">${escapeHtml(c.description)}</div>` : ''}
            <div class="icfg-actions">
                <button class="icfg-btn icfg-btn--apply" onclick="event.stopPropagation();applyInlineConfig(${c.id})">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Apply to File
                </button>
                <button class="icfg-btn icfg-btn--delete" onclick="event.stopPropagation();deleteInlineConfig(${c.id},'${escapeHtml(c.name).replace(/'/g,"\\'")}')" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

function filterInlineConfigs(q) {
    if (!q.trim()) {
        renderInlineConfigGrid(allInlineConfigs);
        return;
    }
    const lower = q.toLowerCase();
    renderInlineConfigGrid(allInlineConfigs.filter(c =>
        c.name.toLowerCase().includes(lower) ||
        (c.description && c.description.toLowerCase().includes(lower))
    ));
}

async function applyInlineConfig(id) {
    try {
        showToast('⏳ Applying configuration…', 'info');
        const res  = await fetch(CONFIG.API_URL + '/column_configs.php?id=' + id);
        const data = await res.json();

        if (!data.success || !data.config || !data.config.config || !data.config.config.sheets) {
            showToast('Invalid config data', 'err'); return;
        }

        const cfg = data.config.config;

        if (!selectedFile) {
            pendingConfig = cfg.sheets;
            applyRespondentInfoFields(cfg.respondent_info_cols);
            document.getElementById('heroSub').innerHTML =
                `Config <strong style="color:#93C5FD">${escapeHtml(data.config.name)}</strong> staged — <strong>import your Excel file</strong> and columns will be auto-mapped.`;
            showToast('✓ Config staged — import your file now', 'info');
            return;
        }

        applyConfigToSheets(cfg.sheets, sheetsData);
        applyRespondentInfoFields(cfg.respondent_info_cols);

        appliedConfigId = id;

        const banner = document.getElementById('appliedConfigBanner');
        const nameEl = document.getElementById('appliedConfigName');
        if (banner && nameEl) {
            nameEl.textContent = data.config.name;
            banner.style.display = 'flex';
        }

        const hintEl = document.getElementById('inlineConfigsHint');
        if (hintEl) hintEl.textContent = `"${data.config.name}" applied — columns are now mapped`;

        renderInlineConfigGrid(allInlineConfigs);

        document.getElementById('heroSub').innerHTML =
            `Config <strong style="color:#93C5FD">${escapeHtml(data.config.name)}</strong> applied to current file.`;

        closeEP();
        renderCatLegend();
        renderAll();
        renderSheetTabs();
        updateComputeBtn();

        showToast(`✓ "${data.config.name}" applied — columns mapped!`, 'ok');

    } catch (e) {
        showToast('Failed to apply config: ' + e.message, 'err');
    }
}

function applyRespondentInfoFields(ri) {
    if (!ri) return;
    if (ri.fullname)         document.getElementById('ri_name').value  = ri.fullname;
    if (ri.email)            document.getElementById('ri_email').value  = ri.email;
    if (ri.sex)              document.getElementById('ri_sex').value    = ri.sex;
    if (ri.participant_type) document.getElementById('ri_type').value   = ri.participant_type;
    if (ri.designation)      document.getElementById('ri_desig').value  = ri.designation;
    if (ri.school)           document.getElementById('ri_school').value = ri.school;
}

function clearAppliedConfig() {
    appliedConfigId = null;
    const banner = document.getElementById('appliedConfigBanner');
    if (banner) banner.style.display = 'none';
    const hintEl = document.getElementById('inlineConfigsHint');
    if (hintEl) hintEl.textContent = 'Select a config to auto-map your columns';
    renderInlineConfigGrid(allInlineConfigs);
    showToast('Config cleared', 'info');
}

async function deleteInlineConfig(id, name) {
    if (!confirm(`Delete configuration "${name}"? This cannot be undone.`)) return;
    try {
        const res  = await fetch(CONFIG.API_URL + '/column_configs.php?id=' + id, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            if (appliedConfigId === id) clearAppliedConfig();
            showToast('🗑 Configuration deleted', 'ok');
            allInlineConfigs = allInlineConfigs.filter(c => c.id !== id);
            const countBadge = document.getElementById('inlineConfigsCount');
            if (countBadge) countBadge.textContent = allInlineConfigs.length;
            renderInlineConfigGrid(allInlineConfigs);
            loadSavedConfigs();
        } else { showToast(data.message || 'Delete failed', 'err'); }
    } catch (e) { showToast('Delete failed: ' + e.message, 'err'); }
}

function switchSheet(s) {
    currentSheet = s;
    selIdx = null;
    closeEP();
    renderAll();
    renderSheetTabs();
}

function renderCatLegend() {
    const el = document.getElementById('catLegend');
    const scoreCategories = getScoreCategories();
    const chips = scoreCategories.map(c => {
        const escapedName = c.name.replace(/'/g, "\\'");
        return `<div class="cat-chip${activeFilter === c.name ? ' active-filter' : ''}" 
      onclick="filterCat('${escapedName}')"
      style="background:${c.bg};color:${c.color};border-color:${c.border}">${c.name}</div>`;
    }).join('');
    const cols = sheetsData[currentSheet] || [];
    const usedInfoCats = new Set(cols.filter(c => c.type === 'info' && c.category).map(c => c.category));
    const infoChips = INFO_CATEGORIES.filter(ic => usedInfoCats.has(ic.name)).map(ic => {
        const escapedName = ic.name.replace(/'/g, "\\'");
        return `<div class="cat-chip${activeFilter === ic.name ? ' active-filter' : ''}" 
      onclick="filterCat('${escapedName}')"
      style="background:${ic.bg};color:${ic.color};border-color:${ic.border}">ℹ️ ${ic.name}</div>`;
    }).join('');
    el.innerHTML = `<span class="cat-legend-label">Filter:</span>
    <div class="cat-chip${!activeFilter ? ' active-filter' : ''}" onclick="filterCat(null)" style="background:#F1F5F9;color:var(--ink-2);border-color:var(--border)">All</div>
    ${chips}${infoChips ? '<span style="margin:0 4px;color:var(--ink-3);font-size:.65rem">│</span>' + infoChips : ''}`;
}

function filterCat(cat) {
    activeFilter = cat;
    renderCatLegend();
    renderOverview();
    const summary = document.getElementById('filterSummary');
    if (summary) summary.textContent = cat ? cat.split(' ')[0] : 'All';
}

function renderAll() {
    const cols = sheetsData[currentSheet];
    if (!cols) return;
    updateStats(cols);
    renderOverview();
    renderTable();
}

function updateStats(cols) {
    document.getElementById('stTotal').textContent = cols.length;
    document.getElementById('stScore').textContent = cols.filter(c => c.type === 'score').length;
    document.getElementById('stInfo').textContent = cols.filter(c => c.type === 'info').length;
    document.getElementById('stFeedback').textContent = cols.filter(c => c.type === 'feedback').length;
    document.getElementById('stUnset').textContent = cols.filter(c => !c.type).length;
    const summary = document.getElementById('statsSummary');
    if (summary) summary.textContent = cols.length + ' cols · ' + cols.filter(c => c.type === 'score').length + ' score';

    const ovSummary = document.getElementById('overviewSummary');
    if (ovSummary) ovSummary.textContent = cols.length + ' cols';

    const mapperSummary = document.getElementById('mapperSummaryText');
    if (mapperSummary) {
        const sheetName = currentSheet || '—';
        const scoreCount = cols.filter(c => c.type === 'score').length;
        const fileName = document.getElementById('fileNameLabel')?.textContent || '';
        mapperSummary.innerHTML = '<strong>' + sheetName + '</strong> · ' + scoreCount + ' score columns' + (fileName ? ' <span style="color:var(--ink-3)">(' + fileName + ')</span>' : '');
    }
}

function renderOverview() {
    const cols = sheetsData[currentSheet];
    const show = activeFilter ? cols.filter(c => c.category === activeFilter) : cols;

    document.getElementById('overviewWrap').innerHTML = show.map(c => {
        const realIdx = cols.indexOf(c);

        let chipStyle = '';
        if (c.type === 'score' || c.type === 'feedback') {
            const catObj = getAllCategories().find(x => x.name === c.category);
            if (catObj) {
                chipStyle = `background:${catObj.bg};color:${catObj.color};border-color:${catObj.border}`;
            } else if (c.type === 'feedback') {
                chipStyle = `background:#F5F3FF;color:#6D28D9;border-color:#C4B5FD`;
            } else {
                chipStyle = `background:#FEF3C7;color:#92400E;border-color:#FCD34D;border-style:dashed`;
            }
        } else if (c.type === 'info') {
            const infoCatObj = INFO_CATEGORIES.find(x => x.name === c.category);
            if (infoCatObj) {
                chipStyle = `background:${infoCatObj.bg};color:${infoCatObj.color};border-color:${infoCatObj.border}`;
            } else {
                chipStyle = `background:#F8FAFC;color:#64748B;border-color:#CBD5E1`;
            }
        } else {
            chipStyle = `background:#FEF3C7;color:#92400E;border-color:#FCD34D;border-style:dashed`;
        }

        const escapedName = c.name.replace(/"/g, '&quot;');
        const shortCat = c.category ? c.category.split(' ')[0] : '';

        return `<div class="ov-chip" style="${chipStyle}" onclick="openEP(${realIdx})" title="${escapedName}: ${c.category || 'unset'}">
            ${c.letter}${shortCat ? `<span style="font-size:.6rem;opacity:.75;font-weight:600">${shortCat}</span>` : ''}
        </div>`;
    }).join('');

    const summary = document.getElementById('overviewSummary');
    if (summary) summary.textContent = `${show.length} cols`;
}

function renderTable() {
    const cols = sheetsData[currentSheet];
    if (!cols || cols.length === 0) return;
    const rows = (SAMPLE_ROWS_DYNAMIC && SAMPLE_ROWS_DYNAMIC[currentSheet]) || [];
    const table = document.getElementById('sheetTable');
    let hRow = `<tr><th class="rn" style="min-width:34px;top:0;z-index:4;background:#1e293b;color:#94A3B8">#</th>`;
    cols.forEach((c, i) => {
        const cls = c.type === 'score' ? 'is-score' : c.type === 'feedback' ? 'is-feedback' : c.type === 'info' ? 'is-info' : '';
        const sel = selIdx === i ? 'selected' : '';
        const catObj = getAllCategories().find(x => x.name === c.category);
        const escapedName = c.name.replace(/"/g, '&quot;');
        hRow += `<th class="ch ${cls} ${sel}" onclick="openEP(${i})">
      <div class="ch-inner">
        <span class="ch-letter">${c.letter}</span>
        <span class="ch-name" title="${escapedName}">${c.name}</span>
        ${c.type ? `<span class="ch-badge b-${c.type === 'feedback' ? 'feedback' : c.type}">${c.type === 'score' ? '📊' : c.type === 'feedback' ? '💬' : 'ℹ️'} ${c.type}</span>` : '<span class="ch-badge b-unset">⚪ unset</span>'}
        ${c.category && catObj ? `<span class="ch-cat" style="background:${catObj.bg};color:${catObj.color}">${c.category}</span>` : ''}
      </div>
    </th>`;
    });
    hRow += '</tr>';
    const dataRows = rows.map((row, ri) => {
        let cells = `<td class="rn">${ri + 2}</td>`;
        cols.forEach((c, ci) => {
            const val = row[ci] !== undefined ? row[ci] : '';
            const cls = c.type === 'score' ? 'score-val' : c.type === 'info' || c.type === 'feedback' ? 'info-val' : '';
            cells += `<td class="${cls}" title="${val}">${val}</td>`;
        });
        return `<tr>${cells}</tr>`;
    }).join('');
    table.innerHTML = hRow + dataRows;
}


// ═══════════════════════════════════════════════════════════════════════════════
// EDITOR PANEL
// ═══════════════════════════════════════════════════════════════════════════════
function openEP(idx) {
    selIdx = idx;
    const col = sheetsData[currentSheet][idx];
    const ep = document.getElementById('ep');
    document.getElementById('epPill').textContent = col.letter;
    document.getElementById('epName').textContent = col.name;
    document.getElementById('rStart').value = col.letter;
    document.getElementById('rEnd').value = col.letter;
    setTypeUI(col.type || 'score');
    document.getElementById('epCat').value = col.category || '';
    const sc = document.getElementById('samplesContent');
    if (col.samples && col.samples.length) {
        sc.innerHTML = col.samples.map(s => `<span class="sample-val">${s}</span>`).join('');
    } else {
        sc.innerHTML = '<em style="font-size:.7rem">No sample data</em>';
    }
    customTags = [];
    renderTags();
    ep.classList.add('open');
    renderTable();
    ep.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEP() {
    selIdx = null;
    document.getElementById('ep').classList.remove('open');
    renderTable();
}

function setType(t) { setTypeUI(t); }

function setTypeUI(t) {
    document.getElementById('ttScore').className = 'tt' + (t === 'score' ? ' act-score' : '');
    document.getElementById('ttInfo').className = 'tt' + (t === 'info' ? ' act-info' : '');
    document.getElementById('ttFb').className = 'tt' + (t === 'feedback' ? ' act-feedback' : '');
    const descs = { score: 'Numeric / Likert scale ratings — averaged and analyzed per category.', info: 'Respondent metadata (name, school, designation) — excluded from scoring.', feedback: 'Open-text qualitative responses — collected but not scored.' };
    document.getElementById('typeDesc').textContent = descs[t] || '';
    const cat = document.getElementById('catCol');
    cat.style.opacity = '1';
    cat.style.pointerEvents = 'auto';
    const sel = document.getElementById('epCat');
    const curVal = sel.value;
    const catHint = document.getElementById('catHint');
    if (t === 'info') {
        sel.innerHTML = '<option value="">— Select Info Category —</option>'
            + INFO_CATEGORIES.map(ic => `<option value="${ic.name}">${ic.name}</option>`).join('');
        if (catHint) catHint.textContent = 'Pick the matching metadata field for this info column.';
    } else {
        const scoreCategories = getScoreCategories();
        sel.innerHTML = '<option value="">— Select Category —</option>'
            + scoreCategories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')
            + `<option value="${ADD_NEW_CATEGORY_VALUE}">+ Add New Category…</option>`;
        if (catHint) catHint.textContent = 'Choose an existing category or use + Add New Category.';
    }
    if ([...sel.options].some(o => o.value === curVal)) sel.value = curVal;
}

// ── CHANGE 3: handleCategoryDropdownChange() is now async — saves to DB ──
async function handleCategoryDropdownChange() {
    const sel = document.getElementById('epCat');
    if (!sel) return;
    if (getSelectedType() !== 'score') return;
    if (sel.value !== ADD_NEW_CATEGORY_VALUE) return;

    const entered = prompt('Enter new category name:');
    if (entered === null) {
        sel.value = '';
        return;
    }

    const categoryName = normalizeCategoryName(entered);
    if (!categoryName) {
        showToast('Category name cannot be empty', 'err');
        sel.value = '';
        return;
    }

    // Dedup guard: if this name is just a variant (case, spacing, "&" vs
    // "and") of a category we already know about, reuse the existing one
    // instead of creating a near-duplicate.
    const existing = findMatchingKnownScoreCategory(categoryName);
    if (existing && existing.name !== categoryName) {
        setTypeUI('score');
        sel.value = existing.name;
        renderCatLegend();
        showToast(`Using existing category "${existing.name}" (matches what you typed)`, 'info');
        return;
    }
    if (existing) {
        // Exact match already known — nothing to create, just select it.
        setTypeUI('score');
        sel.value = existing.name;
        renderCatLegend();
        return;
    }

    // Optimistically add to runtime list so the UI updates instantly
    addRuntimeScoreCategory(categoryName);
    setTypeUI('score');
    sel.value = categoryName;
    renderCatLegend();

    // Save to DB in the background
    showToast(`⏳ Saving category "${categoryName}"…`, 'info');
    const saved = await saveNewCategoryToDB(categoryName);
    if (saved) {
        // DB list is now refreshed — rebuild dropdown with the persisted entry
        setTypeUI('score');
        sel.value = categoryName;
        renderCatLegend();
        showToast(`✓ Category "${categoryName}" saved to database`, 'ok');
    } else {
        // Non-fatal — category still works this session via runtimeCustomScoreCategories
        showToast(`⚠ Category "${categoryName}" added locally (DB save failed)`, 'info');
    }
}

function getSelectedType() {
    if (document.getElementById('ttScore').classList.contains('act-score')) return 'score';
    if (document.getElementById('ttInfo').classList.contains('act-info')) return 'info';
    if (document.getElementById('ttFb').classList.contains('act-feedback')) return 'feedback';
    return 'score';
}

function saveEP() {
    const cols = sheetsData[currentSheet];
    const t = getSelectedType();
    const cat = document.getElementById('epCat').value;
    let count = 0;
    if (selIdx !== null) { cols[selIdx].type = t; cols[selIdx].category = cat; count++; }
    customTags.forEach(letter => {
        const c = cols.find(x => x.letter.toUpperCase() === letter.toUpperCase());
        if (c) { c.type = t; c.category = cat; count++; }
    });
    renderAll();
    renderSheetTabs();
    setStep(3);
    if (t === 'info') autoPopulateRespondentFields(cols);
    showToast(`✓ Saved ${count} column(s) as ${t}${cat ? ' · ' + cat.split(' ')[0] : ''}`, 'ok');
}

function clearEP() {
    if (selIdx === null) return;
    const cols = sheetsData[currentSheet];
    cols[selIdx].type = null;
    cols[selIdx].category = '';
    renderAll();
    renderSheetTabs();
    showToast('Column config cleared', 'ok');
}

function applyRange() {
    const s = document.getElementById('rStart').value.toUpperCase().trim();
    const e = document.getElementById('rEnd').value.toUpperCase().trim();
    const t = getSelectedType();
    const cat = document.getElementById('epCat').value;
    const cols = sheetsData[currentSheet];
    let applying = false, count = 0;
    cols.forEach(c => {
        if (c.letter === s) applying = true;
        if (applying) { c.type = t; c.category = cat; count++; }
        if (c.letter === e) applying = false;
    });
    renderAll();
    renderSheetTabs();
    showToast(`✓ Applied to ${count} columns (${s}→${e}) as ${t}`, 'ok');
}

function applyToAllSame() {
    if (selIdx === null) return;
    const cols = sheetsData[currentSheet];
    const src = cols[selIdx];
    const t = getSelectedType();
    const cat = document.getElementById('epCat').value;
    const baseName = src.name.replace(/\[Speaker \d+\]/, '').replace(/\d+$/, '').trim();
    let count = 0;
    cols.forEach(c => {
        const cBase = c.name.replace(/\[Speaker \d+\]/, '').replace(/\d+$/, '').trim();
        if (cBase === baseName && c !== src) { c.type = t; c.category = cat; count++; }
    });
    src.type = t; src.category = cat; count++;
    renderAll();
    renderSheetTabs();
    showToast(`✓ Applied to ${count} similar columns`, 'ok');
}

function tagKeydown(e) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').trim();
        if (v && !customTags.includes(v)) customTags.push(v);
        e.target.value = '';
        renderTags();
    }
}

function renderTags() {
    const wrap = document.getElementById('tagWrap');
    wrap.innerHTML = customTags.map((t, i) => `<span class="ctag">${t}<button class="ctag-rm" onclick="removeTag(${i})">✕</button></span>`).join('')
        + `<input class="tag-in" id="tagIn" placeholder="A, D, M…" onkeydown="tagKeydown(event)">`;
}

function removeTag(i) { customTags.splice(i, 1); renderTags(); }

function updateWorkflowStep(activeStep) {
    const steps  = [null, 'wfStep1', 'wfStep2', 'wfStep3', 'wfStep4'];
    const conns  = [null, 'wfConn1', 'wfConn2', 'wfConn3'];
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(steps[i]);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < activeStep)       el.classList.add('done');
        else if (i === activeStep) el.classList.add('active');
    }
    for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(conns[i]);
        if (!el) continue;
        el.classList.toggle('done', i < activeStep);
    }
}

function setStep(n) {
    updateWorkflowStep(n);
}

const STRUCTURAL_MATCH_MIN_SCORE = 0.66;
const STRUCTURAL_MATCH_MIN_HEADER_RATE = 0.48;
const STRUCTURAL_MATCH_MIN_COVERAGE_RATE = 0.58;
const STRUCTURAL_MATCH_MIN_GAP = 0.05;
const STRUCTURAL_MATCH_HIGH_CONFIDENCE_SCORE = 0.82;

function getParsedSavedConfig(rawConfig) {
    if (!rawConfig) return null;
    
    let parsed = null;
    if (typeof rawConfig === 'string') {
        try { parsed = JSON.parse(rawConfig); } catch (_) { return null; }
    } else if (typeof rawConfig === 'object') {
        parsed = rawConfig;
    } else {
        return null;
    }

    // ── Handle double-nested structure ──
    // Some API responses wrap config inside another config key:
    // { config: { exported_at, file, sheets } }
    // instead of just { exported_at, file, sheets }
    if (parsed && !parsed.file && !parsed.sheets && parsed.config) {
        return typeof parsed.config === 'string'
            ? JSON.parse(parsed.config)
            : parsed.config;
    }

    return parsed;
}

function normalizeColumnHeaderForMatch(header) {
    return String(header || '')
        // Strip a leading "RESOURCE SPEAKER (Evaluator Name)" / "RESOURCE PERSON (...)"
        // style artifact some source forms embed as a merged sub-header. This text
        // names whoever is doing the observing, not the question itself, and it
        // changes from import to import (different resource speaker each session) —
        // left in, it would make otherwise-identical questions fail to match across
        // imports purely because of who happened to be observing that day.
        .replace(/^\s*resource\s*(speaker|person)\s*\([^)]*\)\s*[\r\n]*\.?\s*/i, '')
        .toLowerCase()
        .replace(/\s*\[speaker\s+\d+\]\s*/ig, ' ')
        .replace(/\s*\(\d+\)\s*$/g, '')
        .replace(/\s*[.\-_]?\s*\d+\s*$/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
}

function scoreSheetSimilarity(savedCols, liveCols) {
    if (!Array.isArray(savedCols) || !Array.isArray(liveCols) || !liveCols.length) {
        return { score: 0, coverageRate: 0, headerMatchRate: 0, categoryMatchRate: 0, typeMatchRate: 0 };
    }

    const byLetter = new Map();
    const byName = new Map();
    savedCols.forEach(col => {
        const letter = String(col?.letter || '').trim().toUpperCase();
        if (letter && !byLetter.has(letter)) byLetter.set(letter, col);

        const norm = normalizeColumnHeaderForMatch(col?.name);
        if (!norm) return;
        if (!byName.has(norm)) byName.set(norm, []);
        byName.get(norm).push(col);
    });

    let matched = 0;
    let headerMatches = 0;
    let categoryMatches = 0;
    let typeMatches = 0;

    liveCols.forEach(liveCol => {
        const liveNameNorm = normalizeColumnHeaderForMatch(liveCol?.name);
        const liveLetter = String(liveCol?.letter || '').trim().toUpperCase();

        let matchedCol = null;
        let matchedByName = false;

        if (liveNameNorm && byName.has(liveNameNorm)) {
            matchedCol = byName.get(liveNameNorm)[0];
            matchedByName = true;
        } else if (liveLetter && byLetter.has(liveLetter)) {
            matchedCol = byLetter.get(liveLetter);
        }

        if (!matchedCol) return;

        matched += 1;
        if (matchedByName) headerMatches += 1;

        const liveCategory = normalizeCategoryName(liveCol?.category || '');
        const savedCategory = normalizeCategoryName(matchedCol?.category || '');
        if (liveCategory && savedCategory && liveCategory === savedCategory) {
            categoryMatches += 1;
        }

        if (liveCol?.type && matchedCol?.type && liveCol.type === matchedCol.type) {
            typeMatches += 1;
        }
    });

    const totalLive = Math.max(1, liveCols.length);
    const coverageRate = matched / totalLive;
    const headerMatchRate = headerMatches / totalLive;
    const categoryMatchRate = matched ? (categoryMatches / matched) : 0;
    const typeMatchRate = matched ? (typeMatches / matched) : 0;

    const maxCount = Math.max(savedCols.length, liveCols.length, 1);
    const countRate = 1 - (Math.abs(savedCols.length - liveCols.length) / maxCount);
    const coreScore = (coverageRate * 0.55)
        + (headerMatchRate * 0.25)
        + (categoryMatchRate * 0.15)
        + (typeMatchRate * 0.05);
    const score = Math.max(0, Math.min(1, coreScore * (0.85 + (Math.max(0, countRate) * 0.15))));

    return { score, coverageRate, headerMatchRate, categoryMatchRate, typeMatchRate };
}

function scoreConfigSimilarity(savedSheets, liveSheets) {
    const liveSheetNames = Object.keys(liveSheets || {});
    const savedSheetNames = Object.keys(savedSheets || {});
    if (!liveSheetNames.length || !savedSheetNames.length) {
        return { score: 0, coverageRate: 0, headerMatchRate: 0, categoryMatchRate: 0 };
    }

    let weightedScore = 0;
    let weightedCoverage = 0;
    let weightedHeader = 0;
    let weightedCategory = 0;
    let totalWeight = 0;

    liveSheetNames.forEach(liveSheetName => {
        const liveCols = Array.isArray(liveSheets[liveSheetName]) ? liveSheets[liveSheetName] : [];
        if (!liveCols.length) return;

        let best = null;
        savedSheetNames.forEach(savedSheetName => {
            const savedCols = Array.isArray(savedSheets[savedSheetName]) ? savedSheets[savedSheetName] : [];
            const sim = scoreSheetSimilarity(savedCols, liveCols);
            let adjustedScore = sim.score;
            if (savedSheetName === liveSheetName) adjustedScore = Math.min(1, adjustedScore + 0.03);

            if (!best || adjustedScore > best.score) {
                best = {
                    score: adjustedScore,
                    coverageRate: sim.coverageRate,
                    headerMatchRate: sim.headerMatchRate,
                    categoryMatchRate: sim.categoryMatchRate
                };
            }
        });

        if (!best) return;

        const weight = liveCols.length;
        totalWeight += weight;
        weightedScore += best.score * weight;
        weightedCoverage += best.coverageRate * weight;
        weightedHeader += best.headerMatchRate * weight;
        weightedCategory += best.categoryMatchRate * weight;
    });

    if (!totalWeight) {
        return { score: 0, coverageRate: 0, headerMatchRate: 0, categoryMatchRate: 0 };
    }

    const sheetPenalty = Math.min(0.1, Math.abs(savedSheetNames.length - liveSheetNames.length) * 0.04);
    const score = Math.max(0, (weightedScore / totalWeight) - sheetPenalty);

    return {
        score,
        coverageRate: weightedCoverage / totalWeight,
        headerMatchRate: weightedHeader / totalWeight,
        categoryMatchRate: weightedCategory / totalWeight
    };
}

function findBestSavedConfigByStructure(liveSheets, configs) {
    if (!Array.isArray(configs) || !configs.length) return null;

    const candidates = [];

    configs.forEach(item => {
        const parsed = getParsedSavedConfig(item?.config);
        const savedSheets = parsed?.sheets;
        if (!savedSheets || typeof savedSheets !== 'object') return;

        const similarity = scoreConfigSimilarity(savedSheets, liveSheets);
        candidates.push({
            id: item.id,
            name: item.name || 'Saved configuration',
            config: parsed,
            score: similarity.score,
            coverageRate: similarity.coverageRate,
            headerMatchRate: similarity.headerMatchRate,
            categoryMatchRate: similarity.categoryMatchRate
        });
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1] || null;

    const passMinimums = best.score >= STRUCTURAL_MATCH_MIN_SCORE
        && best.coverageRate >= STRUCTURAL_MATCH_MIN_COVERAGE_RATE
        && best.headerMatchRate >= STRUCTURAL_MATCH_MIN_HEADER_RATE;

    const isHighConfidence = best.score >= STRUCTURAL_MATCH_HIGH_CONFIDENCE_SCORE
        && best.coverageRate >= STRUCTURAL_MATCH_MIN_COVERAGE_RATE
        && best.headerMatchRate >= Math.max(0.42, STRUCTURAL_MATCH_MIN_HEADER_RATE - 0.06);

    if (!passMinimums && !isHighConfidence) return null;

    if (!isHighConfidence && second) {
        const scoreGap = best.score - second.score;
        const headerGap = best.headerMatchRate - second.headerMatchRate;
        if (scoreGap < STRUCTURAL_MATCH_MIN_GAP && headerGap < 0.04) {
            return null;
        }
    }

    return best;
}

async function hydrateConfigsForAutoMatch(configs) {
    if (!Array.isArray(configs) || !configs.length) return [];

    const normalized = await Promise.all(configs.map(async item => {
        const parsedInline = getParsedSavedConfig(item?.config || item?.config_json);
        if (parsedInline?.sheets) {
            return { ...item, config: parsedInline };
        }

        try {
            const res = await fetch(CONFIG.API_URL + '/column_configs.php?id=' + item.id);
            const data = await res.json();
            const parsedFull = getParsedSavedConfig(data?.config?.config);
            if (parsedFull?.sheets) {
                return { ...item, config: parsedFull };
            }
        } catch (_) {
            // Keep original item; matching will skip if config is unavailable.
        }

        return item;
    }));

    return normalized;
}

async function proceedToCompute() {
    if (!selectedFile) {
        showToast('Upload a file first in Step ①', 'err');
        return;
    }
 
    saveSettingsToDB();
 
    if (Object.keys(sheetsData).length) {
        const configName = (
            document.getElementById('fileNameLabel').textContent ||
            selectedFile.name.replace(/\.[^.]+$/, '')
        ).trim();
 
        const config = {
            exported_at: new Date().toISOString(),
            file: configName,
            sheets: Object.keys(sheetsData).reduce((acc, s) => {
                acc[s] = sheetsData[s].map(c => ({
                    letter:   c.letter,
                    name:     c.name,
                    type:     c.type,
                    category: c.category,
                }));
                return acc;
            }, {}),
            respondent_info_cols: {
                fullname:         document.getElementById('ri_name').value.trim().toUpperCase()  || 'J',
                email:            document.getElementById('ri_email').value.trim().toUpperCase() || 'L',
                sex:              document.getElementById('ri_sex').value.trim().toUpperCase()   || 'H',
                participant_type: document.getElementById('ri_type').value.trim().toUpperCase()  || 'I',
                designation:      document.getElementById('ri_desig').value.trim().toUpperCase() || 'K',
                school:           document.getElementById('ri_school').value.trim().toUpperCase()|| 'M',
            },
        };
 
        try {
            const res  = await fetch(CONFIG.API_URL + '/column_configs.php', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    name:        configName,
                    description: '[Auto-saved on Compute]',
                    config,
                }),
            });
            const data = await res.json();
 
            if (data.success) {
                const wasExisting = Array.isArray(allInlineConfigs) &&
                    allInlineConfigs.some(
                        c => c.name.trim().toLowerCase() === configName.toLowerCase()
                    );
                const verb = wasExisting ? 'updated' : 'saved';
                showToast(`✓ Config "${configName}" ${verb} — will auto-apply next import`, 'ok');
 
                if (typeof loadInlineConfigs === 'function') loadInlineConfigs();
                if (typeof loadSavedConfigs  === 'function') loadSavedConfigs();
            } else {
                showToast('⚠ Config could not be saved: ' + (data.message || 'unknown error'), 'err');
                console.warn('[proceedToCompute] config save failed:', data);
            }
        } catch (err) {
            showToast('⚠ Config save failed (network): ' + err.message, 'err');
            console.error('[proceedToCompute] config save error:', err);
        }
    }
 
    const computeTab = document.getElementById('tabCompute');
    if (computeTab) setSection(computeTab);
 
    const computeBtn = document.getElementById('computeBtn');
    if (computeBtn) {
        setTimeout(() => computeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    }
 
    updateWorkflowStep(3);
    showToast('✓ Settings saved — click Compute Results to proceed', 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD (SheetJS — parse locally for column mapping)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleFileUpload(e) {
    const f = e.target.files[0];
    if (!f) return;
    let autoMatchedConfigMessage = '';
    let configsForMatching = Array.isArray(allInlineConfigs) ? allInlineConfigs : [];

    selectedFile = f;
    const fileName = f.name.replace(/\.[^.]+$/, '');
    document.getElementById('fileNameLabel').textContent = fileName;
    document.getElementById('fileBadge').style.display = 'flex';
    showToast(`⏳ Reading ${f.name}…`, 'info');

    if (configsForMatching.length) {
        configsForMatching = await hydrateConfigsForAutoMatch(configsForMatching);
    }

    // Pre-match by filename only (structural match runs after workbook is parsed).
    if (!pendingConfig && configsForMatching.length) {
        const normalizedFileName = fileName.trim().toLowerCase();
        const match = configsForMatching.find(cfg => {
            const parsed = getParsedSavedConfig(cfg?.config || cfg?.config_json);
            const savedFile = String(parsed?.file || '').trim().toLowerCase();
            return savedFile && savedFile === normalizedFileName;
        });

        if (match) {
            const parsed = getParsedSavedConfig(match?.config || match?.config_json);
            if (parsed?.sheets) pendingConfig = parsed.sheets;
            if (parsed?.respondent_info_cols) {
                applyRespondentInfoFields(parsed.respondent_info_cols);
            }
            autoMatchedConfigMessage = `✓ Auto-matched "${match.name}" by file name`;
        }
    }

    const reader = new FileReader();
    reader.onload = async function (ev) {
        try {
            const data = new Uint8Array(ev.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const newSheetsData = {};
            const newSampleRows = {};
            workbook.SheetNames.forEach(sheetName => {
                const ws = workbook.Sheets[sheetName];
                const jsonRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                if (!jsonRows.length || jsonRows.length < 2) return;
                const headerRow = jsonRows[0];
                const dataRows = jsonRows.slice(1);
                const columns = headerRow.map((name, i) => {
                    const letter = colToLetter(i + 1);
                    const samples = dataRows.slice(0, 3).map(r => {
                        const val = r[i];
                        return val !== undefined && val !== null ? String(val) : '';
                    }).filter(v => v !== '');
                    const nameLower = String(name).toLowerCase();
                    let type = 'score';
                    let category = '';

                    const isPrivacyNoticeHeader = /your privacy is important to us|data privacy act|executive order no\.?\s*2|deped order no\.?\s*72|privacy notice|data privacy/i.test(nameLower);
                    if (isPrivacyNoticeHeader) {
                        type = 'info';
                        category = 'Privacy Notice';
                    }
                    
                    const looksLikeQuestion = !isPrivacyNoticeHeader && /^the\s|was\s.*\w+|were\s.*\w+|is\s.*\w+|are\s.*\w+|delivered|managed|structured|defined|attainable|organized|sufficient|adequately|serviceable|courteous|efficient|responsive|knowledgeable|engaging/i.test(nameLower);
                    
                    if (!looksLikeQuestion) {
                        const isExcluded = excludedKeywords.some(kw => nameLower.includes(kw));
                        if (isExcluded) type = 'info';
                        const infoPatterns = /(^id$|email address|e-?mail|gmail|electronic mail|koreo|full\s*name|complete\s*name|^name$|name of respondent|timestamp|start time|completion time|last modified|^sex$|^gender$|^sex\/gender$|^kasarian$|^male\/female$|type of participant|participant type|^participants$|^designation$|^position$|position\/designation|designation\/position|office\/school|school\/office|^school$|^office$|^station$|^district$|^division$|^region$|contact number|phone|mobile|^address$|^age$|birth|civil status|employee id|id number)/i;
                        if (infoPatterns.test(nameLower)) type = 'info';
                    }
                    
                    if (type === 'info') {
                        const infoCat = detectInfoCategory(String(name));
                        if (infoCat) category = infoCat.name;
                    }
                    if (type === 'score' && samples.length > 0) {
                        const likertWords = ['strongly agree', 'agree', 'disagree', 'very satisfied', 'satisfied', 'dissatisfied'];
                        const looksLikert = samples.some(s => likertWords.some(w => s.toLowerCase().includes(w)));
                        const allNumeric = samples.every(s => !isNaN(parseFloat(s)));
                        if (!looksLikert && !allNumeric) {
                            const avgLen = samples.reduce((sum, s) => sum + s.length, 0) / samples.length;
                            if (avgLen > 30) { type = 'feedback'; category = 'Feedbacks'; }
                        }
                    }
                    if (type === 'score' && !category) {
                        if (/speaker|resource person|knowledgeable.*topic|well prepared|engaging.*supportive|clear understanding|presentations were relevant|start and end on time/i.test(nameLower)) category = 'Resource Speaker';
                        else if (/delivered as planned|managed efficiently|well-structured|well structured|training matrix/i.test(nameLower)) category = 'Program Management and Operations';
                        else if (/objective|attainable|smart|measurable|realistic|time.?bounded|presented prior|clearly defined/i.test(nameLower)) category = 'Attainment of Objectives';
                        else if (/reliable sources|generating learning|slide presentation|materials and handouts|presentation of ideas|content.*appropriate|comprehensiveness|meet expectations|quality.*slide|handouts were|ideas was organized|trainees roles/i.test(nameLower)) category = 'Delivery of Content';
                        else if (/conference hall|adequately lit|well ventilated|soundproof|sufficient space|clean space|serviceable|comfort room|toiletries/i.test(nameLower)) category = 'Venue';
                        else if (/sufficient quantity|sufficient variety|generally healthy|utensil|spoons.*forks|served on time|portioning|protocol.*serving|protocol.*holding/i.test(nameLower)) category = 'Meal';
                        else if (/courteous|efficient|responsive.*needs|responsive to the needs|safe work|emcee|host speaks|speaks with clarity/i.test(nameLower)) category = 'Program Management Team';
                        else if (/expectations.*met|expectations of the event|be improved|significant insight|further training|additional.*training/i.test(nameLower)) { type = 'feedback'; category = 'Feedbacks'; }
                    }

                    // Safety net: 'Feedbacks' is never a score category.
                    // If it was selected/detected as a category, force it to feedback type.
                    if (category === 'Feedbacks') {
                        type = 'feedback';
                    }
                    
                    if (type === 'score' && !category && i < 13 && !looksLikeQuestion) {
                        type = 'info';
                        const fallbackCat = detectInfoCategory(String(name));
                        if (fallbackCat) category = fallbackCat.name;
                    }
                    
                    return { index: i, letter: letter, name: String(name), type: type, category: category, samples: samples };
                });

                // Post-pass: detect repeated speaker criteria groups
                const baseNameGroups = {};
                columns.forEach((col, idx) => {
                    if (col.type !== 'score') return;
                    const baseName = col.name
                        .replace(/\s*[\.\-_]?\s*\d+\s*$/, '')
                        .replace(/\s*\(\d+\)\s*$/, '')
                        .replace(/Somewhat Satisfied\s*$/i, '')
                        .trim().toLowerCase();
                    if (!baseName) return;
                    if (!baseNameGroups[baseName]) baseNameGroups[baseName] = [];
                    baseNameGroups[baseName].push(idx);
                });
                Object.values(baseNameGroups).forEach(indices => {
                    if (indices.length < 2) return;
                    const hasSpeaker = indices.some(i => columns[i].category === 'Resource Speaker');
                    if (hasSpeaker) {
                        indices.forEach(i => { columns[i].category = 'Resource Speaker'; });
                    }
                });
                
                // Second pass: detect unassigned speaker criteria by keyword patterns
                const speakerKeywords = /knowledgeable|well prepared|well-prepared|presentations were relevant|start and end on time|engaging and supportive|clear understanding|resource person|resource speaker/i;
                columns.forEach((col) => {
                    if (col.type === 'score' && !col.category) {
                        if (speakerKeywords.test(col.name.toLowerCase())) {
                            col.category = 'Resource Speaker';
                        }
                    }
                });
                
                newSheetsData[sheetName] = columns;
                newSampleRows[sheetName] = dataRows.slice(0, 3).map(row => headerRow.map((_, i) => {
                    const val = row[i];
                    return val !== undefined && val !== null ? String(val) : '—';
                }));
            });

            if (Object.keys(newSheetsData).length === 0) {
                showToast('No valid sheets found in the file', 'err');
                return;
            }

            // ── Day-label normalisation ───────────────────────────────────────
            // Determine whether this is a linked-program import (day_label in URL)
            // or a standalone import.
            //
            // • Standalone  → always rename sheets to "Day 1", "Day 2", …
            //   regardless of the tab name in the Excel file.
            // • Linked (container) with a single day_label in the URL → rename
            //   all sheets starting from that label (Day 2 → Day 2, Day 3, …)
            //   so the saved day labels match the container's import order.
            //
            // This removes the requirement for the user to rename tabs before importing.
            const urlParamsForDay = new URLSearchParams(window.location.search);
            const linkedDayLabelRaw = decodeURIComponent(urlParamsForDay.get('day_label') || '');
            const sheetNamesOriginal = Object.keys(newSheetsData);

            // Determine starting day number from URL param, e.g. "Day 2" → 2
            let startDayNum = 1;
            if (linkedDayLabelRaw) {
                const m = linkedDayLabelRaw.match(/(\d+)/);
                if (m) startDayNum = parseInt(m[1], 10) || 1;
            }

            // Build normalised sheetData with "Day N" keys
            const normalisedSheetsData = {};
            const normalisedSampleRows = {};
            sheetNamesOriginal.forEach((originalName, idx) => {
                const dayLabel = 'Day ' + (startDayNum + idx);
                normalisedSheetsData[dayLabel] = newSheetsData[originalName];
                normalisedSampleRows[dayLabel] = newSampleRows[originalName];
            });

            sheetsData = normalisedSheetsData;
            SAMPLE_ROWS_DYNAMIC = normalisedSampleRows;
            currentSheet = Object.keys(sheetsData)[0];
            selIdx = null;
            activeFilter = null;

            // If no file-name match was found, try best structural match
            if (!pendingConfig && configsForMatching.length) {
                const bestMatch = findBestSavedConfigByStructure(newSheetsData, configsForMatching);
                // ── DEBUG: why did structural match fail? ──
                console.log('[debug] structural bestMatch:', bestMatch 
                    ? `"${bestMatch.name}" score:${bestMatch.score.toFixed(2)} coverage:${bestMatch.coverageRate.toFixed(2)} header:${bestMatch.headerMatchRate.toFixed(2)}`
                    : 'NO MATCH — below thresholds'
                );
                if (bestMatch && bestMatch.config && bestMatch.config.sheets) {
                    pendingConfig = bestMatch.config.sheets;
                    if (bestMatch.config.respondent_info_cols) {
                        applyRespondentInfoFields(bestMatch.config.respondent_info_cols);
                    }
                    const scorePct = Math.round(bestMatch.score * 100);
                    const coveragePct = Math.round(bestMatch.coverageRate * 100);
                    const headerPct = Math.round(bestMatch.headerMatchRate * 100);
                    const categoryPct = Math.round(bestMatch.categoryMatchRate * 100);
                    autoMatchedConfigMessage = `✓ Auto-matched "${bestMatch.name}" by columns/categories (${scorePct}% similarity, ${coveragePct}% coverage, ${headerPct}% header, ${categoryPct}% category)`;
                }
            }

            // Apply any pending config (filename match or structural match)
            let configWasApplied = false;
            if (pendingConfig) {
                applyConfigToSheets(pendingConfig, sheetsData);
                pendingConfig = null;
                configWasApplied = true;
                showToast(autoMatchedConfigMessage || '✓ Staged config applied to imported file', 'ok');
            }

            // Auto-populate respondent info fields from the first sheet
            autoPopulateRespondentFields(sheetsData[currentSheet]);
            const sheetNames = Object.keys(sheetsData);
            const sheetInfo = sheetNames.join(' & ');

            // Drift check:
            // - No config applied  → run on raw newSheetsData (pre-apply auto-detection).
            // - Config was applied → run on the live sheetsData AFTER apply, so columns
            //   the saved config didn't cover (new columns, unknown categories left behind,
            //   type mismatches) are still caught rather than silently passed through.
            const drift = detectImportMappingDrift(configWasApplied ? sheetsData : newSheetsData);

            if (drift.needsReview) {
                const msg = buildImportDriftWarningMessage(drift) || 'New or changed columns detected. Please review mappings.';
                showMapperWithError(msg);
                renderCatLegend();
                renderAll();
                renderSheetTabs();
                updateComputeBtn();
                const columnsTab = document.querySelector('.tab-btn[data-sec="columns"]');
                if (columnsTab) setSection(columnsTab);
                updateWorkflowStep(2);
                showToast('Warning: new or changed columns detected. Please review Column Mapper.', 'info');
                return;
            }
            
            // Auto-compute flow
            document.getElementById('heroSub').innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing <strong style="color:#93C5FD">${fileName}</strong>…`;
            closeEP();
            document.getElementById('uploadZone').style.display = 'none';
            document.getElementById('mapperContent').style.display = 'none';
            const pb = document.getElementById('proceedBar');
            if (pb) pb.style.display = 'none';
            
            renderCatLegend();
            renderAll();
            renderSheetTabs();
            updateComputeBtn();
            showToast(`✓ ${f.name} imported — auto-computing…`, 'ok');
            
            await doComputeAutoMode(fileName, sheetInfo);
        } catch (err) {
            showToast('Failed to parse file: ' + err.message, 'err');
        }
    };
    reader.onerror = function () { showToast('Failed to read file', 'err'); };
    reader.readAsArrayBuffer(f);
    e.target.value = '';
}


// ═══════════════════════════════════════════════════════════════════════════════
// FIND & REPLACE RULES
// ═══════════════════════════════════════════════════════════════════════════════
function addRule(find, replace) {
    find = find.trim(); replace = replace.trim();
    if (!find || !replace) return;
    if (findReplaceRules.some(r => r.find.toLowerCase() === find.toLowerCase())) return;
    findReplaceRules.push({ find, replace });
    renderRules(); saveRulesToStorage();
}

function removeRule(i) { findReplaceRules.splice(i, 1); renderRules(); saveRulesToStorage(); }

function renderRules() {
    const rulesContainer = document.getElementById('rulesContainer');
    if (!findReplaceRules.length) {
        rulesContainer.innerHTML = '<p class="no-rules">No rules added yet. Add rules above or use a preset.</p>';
        return;
    }
    let html = `<div class="rule-count">📝 ${findReplaceRules.length} rule(s) active</div>`;
    findReplaceRules.forEach((r, i) => {
        html += `<div class="rule-item">
            <span class="rule-find">"${escapeHtml(r.find)}"</span>
            <span class="rule-arrow">→</span>
            <span class="rule-replace">${escapeHtml(r.replace)}</span>
            <button class="rule-remove" data-index="${i}" title="Remove">✕</button>
        </div>`;
    });
    rulesContainer.innerHTML = html;
    rulesContainer.querySelectorAll('.rule-remove').forEach(btn =>
        btn.addEventListener('click', () => removeRule(parseInt(btn.dataset.index))));
}

function saveRulesToStorage() { localStorage.setItem('findReplaceRules', JSON.stringify(findReplaceRules)); }

function loadRulesFromStorage() {
    try { const s = localStorage.getItem('findReplaceRules'); if (s) { findReplaceRules = JSON.parse(s); renderRules(); } } catch (e) { findReplaceRules = []; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Send a canonical XLSX package rather than exporter-specific metadata or filenames.
// Keep every worksheet, cell position, formula and number format used by computation.
async function buildComputeUpload(file) {
    const source = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
        type: 'array', cellNF: true, cellFormula: true
    });
    const workbook = XLSX.utils.book_new();
    source.SheetNames.forEach(name => {
        XLSX.utils.book_append_sheet(workbook, source.Sheets[name], name);
    });
    if (!workbook.SheetNames.length) throw new Error('The workbook has no worksheets.');
    // Preserve the active tab used by the PHP importer.
    if (source.Workbook && source.Workbook.Views) {
        workbook.Workbook = { Views: source.Workbook.Views };
    }
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    return new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
}

// Parse hosting errors without trying to interpret an HTML error page as JSON.
async function readComputeResponse(res) {
    const body = await res.text();
    let json;
    try {
        json = JSON.parse(body);
    } catch (_) {
        const hints = {
            403: 'The hosting server blocked the import request. Check its security or firewall logs.',
            413: 'The upload exceeds the hosting server request-size limit.',
            500: 'The server failed while processing the workbook. Check the PHP error log.',
            502: 'The hosting server could not get a valid response from PHP. Check the server error log.',
            503: 'The hosting server is unavailable or reached a resource limit.',
            504: 'Workbook processing timed out on the hosting server.'
        };
        throw new Error(`Import returned HTTP ${res.status} instead of JSON. ${hints[res.status] || 'Check the process.php response and hosting error log.'}`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error(`Import returned an invalid response (HTTP ${res.status}).`);
    }
    if (!res.ok) {
        throw new Error(json.message || `Import failed (HTTP ${res.status}).`);
    }
    return json;
}

// COMPUTE (sends file to process.php via API)
// ═══════════════════════════════════════════════════════════════════════════════
function updateComputeBtn() {
    const btn         = document.getElementById('computeBtn');
    const descEl      = document.getElementById('computeDesc');
    const metaEl      = document.getElementById('computeMeta');
    const scoreBadge  = document.getElementById('computeScoreBadge');
    const fileBadge   = document.getElementById('computeFileBadge');
    const proceedBtn  = document.getElementById('proceedBtn');
    const proceedDot  = document.querySelector('.proceed-dot');
    const proceedText = document.getElementById('proceedStatusText');

    if (selectedFile && sheetsData[currentSheet]) {
        const scoreCols = sheetsData[currentSheet].filter(c => c.type === 'score').length;
        const unset     = sheetsData[currentSheet].filter(c => !c.type).length;

        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Compute Results';
        if (descEl) descEl.textContent = 'Settings saved. Click to compute respondent averages, category scores, and consolidated reports.';
        if (metaEl) metaEl.style.display = 'flex';
        if (scoreBadge) scoreBadge.textContent = scoreCols + ' score cols';
        if (fileBadge) fileBadge.textContent = selectedFile.name;

        if (proceedBtn) proceedBtn.disabled = false;
        if (proceedDot) proceedDot.classList.add('ready');
        if (proceedText) {
            if (unset > 0) {
                proceedText.innerHTML = `<strong style="color:#F59E0B">${unset} columns still unset</strong> — you can proceed or configure them above.`;
            } else {
                proceedText.innerHTML = `<strong style="color:#4ADE80">All ${scoreCols} score columns configured.</strong> Ready to compute!`;
            }
        }

        const computeTab = document.getElementById('tabCompute');
        if (computeTab && !computeTab.querySelector('.tab-badge')) {
            const badge = document.createElement('span');
            badge.className = 'tab-badge';
            badge.textContent = 'Ready';
            computeTab.appendChild(badge);
        }

    } else {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Compute Results';
        if (descEl) descEl.textContent = 'Upload a file and map your columns in Step ①, then click Compute Results.';
        if (metaEl) metaEl.style.display = 'none';
        if (proceedBtn) proceedBtn.disabled = true;
        if (proceedDot) proceedDot.classList.remove('ready');
        if (proceedText) proceedText.textContent = 'Import a file in Step ① to get started.';
    }
}

function buildColumnConfig(sheetsData) {
    const config = {
        categories: {},
        speaker_slots: {},
        feedback_columns: [],   // flat ordered array of 1-based col indices
        respondent_info_cols: { fullname: null, email: null, sex: null, participant_type: null, designation: null, school: null },
        per_sheet: {}
    };

    const infoFieldMap = {
        'ri_name': 'fullname',
        'ri_email': 'email',
        'ri_sex': 'sex',
        'ri_type': 'participant_type',
        'ri_desig': 'designation',
        'ri_school': 'school'
    };

    Object.entries(sheetsData).forEach(([sheetName, columns]) => {
        const sheetCategories = {};
        const sheetSpeakerSlots = {};
        const speakerCols = [];
        const sheetFeedbackCols = [];

        columns.forEach(col => {
            const colNum = col.index + 1;

            // Safety net: treat any column categorized as 'Feedbacks' as feedback.
            const isFeedbackCategory = col.category === 'Feedbacks';

            if (col.type === 'score' && !isFeedbackCategory) {
                if (col.category === 'Resource Speaker') {
                    speakerCols.push({ index: col.index, colNum, name: col.name });
                } else if (col.category) {
                    if (!sheetCategories[col.category]) sheetCategories[col.category] = [];
                    sheetCategories[col.category].push(colNum);
                }
            } else if (col.type === 'info' && col.category) {
                const infocat = INFO_CATEGORIES.find(ic => ic.name === col.category);
                if (infocat && infocat.field) {
                    const backendKey = infoFieldMap[infocat.field];
                    if (backendKey && config.respondent_info_cols[backendKey] === null) {
                        config.respondent_info_cols[backendKey] = colNum;
                    }
                }
            } else if (col.type === 'feedback' || isFeedbackCategory) {
                sheetFeedbackCols.push({ index: col.index, colNum, name: col.name });
            }
        });

        // Sort feedback cols by column position and collect as ordered list of colNums.
        sheetFeedbackCols.sort((a, b) => a.index - b.index);
        const sheetFbColNums = sheetFeedbackCols.map(c => c.colNum);

        // Seed global list from first sheet that has feedback; subsequent sheets fill gaps.
        sheetFbColNums.forEach(n => {
            if (!config.feedback_columns.includes(n)) config.feedback_columns.push(n);
        });

        if (speakerCols.length > 0) {
            const criteriaPerSpeaker = getSpeakerCriteriaCount(speakerCols);
            const numSpeakers = Math.floor(speakerCols.length / criteriaPerSpeaker);
            for (let slot = 1; slot <= numSpeakers; slot++) {
                const startIdx = (slot - 1) * criteriaPerSpeaker;
                const slotCols = speakerCols.slice(startIdx, startIdx + criteriaPerSpeaker).map(c => c.colNum);
                if (slotCols.length === criteriaPerSpeaker) {
                    sheetSpeakerSlots[slot] = slotCols;
                }
            }
        }

        Object.entries(sheetCategories).forEach(([cat, cols]) => {
            if (!config.categories[cat]) config.categories[cat] = cols;
        });
        Object.entries(sheetSpeakerSlots).forEach(([slot, cols]) => {
            if (!config.speaker_slots[slot]) config.speaker_slots[slot] = cols;
        });

        config.per_sheet[sheetName] = {
            activeSpeakers: Object.keys(sheetSpeakerSlots).map(Number),
            categories: sheetCategories,
            speaker_slots: sheetSpeakerSlots,
            feedback: sheetFbColNums,   // flat ordered array of 1-based col indices
        };
    });

    return config;
}

async function doCompute() {
    if (!selectedFile) { showError('Please upload a file first via the Column Mapper tab.'); return; }
    if (!sheetsData[currentSheet]) { showError('No column data available. Please upload a file first.'); return; }
    const computeBtn = document.getElementById('computeBtn');
    computeBtn.disabled = true;
    computeBtn.textContent = '⏳ Computing…';
    hideError();

    const cols = sheetsData[currentSheet];
    const excludedColumns = [];
    cols.forEach(c => { if (c.type !== 'score' || c.category === 'Feedbacks') excludedColumns.push(c.index); });

    const columnConfig = buildColumnConfig(sheetsData);

    const fd = new FormData();
    fd.append('rules', JSON.stringify(findReplaceRules));
    fd.append('excluded_columns', JSON.stringify(excludedColumns));
    fd.append('speaker_names', JSON.stringify(speakerNames));
    fd.append('column_config', JSON.stringify(columnConfig));
    // Send normalised sheet labels (e.g. ["Day 2"]) so process.php can use
    // them instead of raw Excel tab names when labelling consolidated days.
    fd.append('sheet_names', JSON.stringify(Object.keys(sheetsData)));

    try {
        fd.append('excel_file', await buildComputeUpload(selectedFile), 'evaluation.xlsx');
        const res = await fetch(CONFIG.API_URL + '/process.php', { method: 'POST', body: fd });
        const json = await readComputeResponse(res);
        if (!json.success) { showError(json.message || 'An error occurred.'); return; }
        resultsData = json.data;
        // FIX: Remap consolidated day labels from raw sheet names to normalised Day N keys
        const normKeys = Object.keys(sheetsData);
        if (resultsData.consolidated && Array.isArray(resultsData.consolidated.days)) {
            resultsData.consolidated.days.forEach((d, i) => { if (normKeys[i]) d.day = normKeys[i]; });
        }
        // FIX (Bug 1): Only assign a fallback day when the respondent's .day is
        // missing or does not match any of the normalised sheet labels.
        // The old code unconditionally stamped normKeys[0] ("Day 1") on every
        // respondent, clobbering correct "Day 2", "Day 3" … labels that
        // process.php had already assigned via the sheet_names map.
        if (Array.isArray(resultsData.respondents)) {
            const normKeySet = new Set(normKeys);
            resultsData.respondents.forEach(r => {
                if (!r.day || !normKeySet.has(r.day)) {
                    r.day = normKeys[0]; // fallback only — day is missing or unrecognised
                }
            });
        }
        lastConsolidated = resultsData.consolidated;
        renderComputeResults(resultsData);
        renderConsolidated(resultsData.consolidated);
        if (resultsData.consolidated && resultsData.consolidated.days) {
            renderSpeakerNamesForm(resultsData.consolidated.days);
        }
        setStep(3);
        showToast('✓ Computation complete!', 'ok');
    } catch (err) { showError('Import failed: ' + err.message); }
    finally { updateComputeBtn(); }
}

async function doComputeAutoMode(fileName, sheetInfo) {
    if (!selectedFile || !sheetsData[currentSheet]) {
        showMapperContent();
        showMapperWithError('File data not available. Please configure columns manually.');
        return;
    }

    const cols = sheetsData[currentSheet];
    const excludedColumns = [];
    cols.forEach(c => { if (c.type !== 'score' || c.category === 'Feedbacks') excludedColumns.push(c.index); });

    const columnConfig = buildColumnConfig(sheetsData);

    const fd = new FormData();
    fd.append('rules', JSON.stringify(findReplaceRules));
    fd.append('excluded_columns', JSON.stringify(excludedColumns));
    fd.append('speaker_names', JSON.stringify(speakerNames));
    fd.append('column_config', JSON.stringify(columnConfig));
    fd.append('sheet_names', JSON.stringify(Object.keys(sheetsData)));

    try {
        fd.append('excel_file', await buildComputeUpload(selectedFile), 'evaluation.xlsx');
        const res = await fetch(CONFIG.API_URL + '/process.php', { method: 'POST', body: fd });
        const json = await readComputeResponse(res);
        
        if (!json.success) {
            showMapperWithError(json.message || 'Computation failed. Please review column mappings.');
            return;
        }
        
        resultsData = json.data;

        // FIX: process.php labels consolidated days using the raw Excel sheet tab names
        // (e.g. "Sheet1", "Sheet2") which don't match the normalised "Day N" keys we
        // built during file upload. Remap them now so every downstream consumer
        // (renderConsolidated, submitSave, speaker forms, respondent .day field) all
        // see the correct "Day 1", "Day 2", … labels.
        const normalisedSheetKeys = Object.keys(sheetsData); // e.g. ["Day 2"]
        if (resultsData.consolidated && Array.isArray(resultsData.consolidated.days)) {
            resultsData.consolidated.days.forEach((day, idx) => {
                const correctLabel = normalisedSheetKeys[idx];
                if (correctLabel) day.day = correctLabel;
            });
        }
        if (Array.isArray(resultsData.respondents)) {
            resultsData.respondents.forEach((r, idx) => {
                // Each respondent already has a .day from process.php (wrong sheet name).
                // Map it to the correct normalised label by matching the day index.
                if (resultsData.consolidated && Array.isArray(resultsData.consolidated.days)) {
                    const dayIdx = resultsData.consolidated.days.findIndex(d => d.day === (r.day || ''));
                    if (dayIdx >= 0 && normalisedSheetKeys[dayIdx]) {
                        r.day = normalisedSheetKeys[dayIdx];
                    } else if (normalisedSheetKeys[0]) {
                        // Single-sheet import: assign to the one normalised key
                        r.day = normalisedSheetKeys[0];
                    }
                }
            });
        }

        lastConsolidated = resultsData.consolidated;

        const computeTab = document.getElementById('tabCompute');
        if (computeTab) setSection(computeTab);
        
        document.getElementById('heroSub').innerHTML = `<strong style="color:#4ADE80">✓</strong> Results computed from <strong style="color:#93C5FD">${fileName} (${sheetInfo})</strong>`;
        
        renderComputeResults(resultsData);
        renderConsolidated(resultsData.consolidated);
        if (resultsData.consolidated && resultsData.consolidated.days) {
            renderSpeakerNamesForm(resultsData.consolidated.days);
        }
        updateWorkflowStep(4);
        updateComputeBtn();
        showToast('✓ Computation complete!', 'ok');
        
    } catch (err) {
        showMapperWithError('Import failed: ' + err.message);
    }
}

function showMapperWithError(errorMsg) {
    document.getElementById('heroSub').innerHTML = `<span style="color:#F59E0B"><i class="fa-solid fa-triangle-exclamation"></i> ${errorMsg}</span><br><span style="font-size:0.85em;color:var(--ink-3)">Review columns below and click Compute when ready.</span>`;
    
    showMapperContent();
    loadInlineConfigs();
    setStep(2);
    updateComputeBtn();
    showToast('⚠ Please review column mappings', 'info');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SPEAKER NAMES FORM
// ═══════════════════════════════════════════════════════════════════════════════
function renderSpeakerNamesForm(days) {
    _lastSpeakerDays = days;
}

let _lastSpeakerDays = null;

function populateModalSpeakerInputs(days) {
    const section = document.getElementById('modalSpeakersSection');
    const form    = document.getElementById('modalSpeakersForm');
    if (!section || !form) return;
    let html = '';
    (days || []).forEach(day => {
        if (!day.speakers || !day.speakers.length) return;
        if ((days || []).filter(d => d.speakers && d.speakers.length).length > 1) {
            html += `<div style="font-size:11px;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">📅 ${escapeHtml(day.day)}</div>`;
        }
        day.speakers.forEach(sp => {
            // A user-typed override (from a previous edit in this session) always
            // wins. Otherwise, prefill with the name process.php auto-detected
            // from the Excel header (e.g. "RESOURCE SPEAKER (Cecille. E Cruz, ...)")
            // — but only if it's a real name, not the generic "Speaker N" placeholder
            // process.php falls back to when no name could be detected.
            const explicit = (speakerNames[day.day] || {})[sp.slot];
            const isPlaceholderName = /^Speaker\s+\d+$/i.test((sp.name || '').trim());
            const autoDetected = !isPlaceholderName ? (sp.name || '').trim() : '';
            const stored = (explicit !== undefined && explicit !== '') ? explicit : autoDetected;

            // Keep speakerNames in sync with the auto-filled value so it's
            // consistent everywhere it's read from (consolidated panel, save
            // payload) even before the user interacts with this input.
            if (autoDetected && (explicit === undefined || explicit === '')) {
                if (!speakerNames[day.day]) speakerNames[day.day] = {};
                speakerNames[day.day][sp.slot] = autoDetected;
            }

            html += `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:12px;font-weight:600;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:4px 10px;white-space:nowrap;min-width:76px;text-align:center;">
                    Speaker ${sp.slot}
                </span>
                <input type="text"
                    class="speaker-name-input"
                    data-day="${escapeHtml(day.day)}"
                    data-slot="${sp.slot}"
                    value="${escapeHtml(stored)}"
                    placeholder="Enter speaker name…"
                    style="flex:1;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            </div>`;
        });
    });
    if (!html) { section.style.display = 'none'; return; }
    form.innerHTML = html;
    section.style.display = '';
    form.querySelectorAll('.speaker-name-input').forEach(inp => {
        inp.addEventListener('input', () => {
            const day  = inp.dataset.day;
            const slot = inp.dataset.slot;
            if (!speakerNames[day]) speakerNames[day] = {};
            speakerNames[day][slot] = inp.value.trim();
            if (lastConsolidated) updateSpeakerNamesInPanel();
        });
    });
}

function updateSpeakerNamesInPanel() {
    document.querySelectorAll('.sp-name[data-day][data-slot]').forEach(el => {
        const name = (speakerNames[el.dataset.day] || {})[el.dataset.slot] || `Speaker ${el.dataset.slot}`;
        el.textContent = name;
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// RENDER RESULTS (respondent table)
// ═══════════════════════════════════════════════════════════════════════════════
function renderComputeResults(d) {
    const summaryCards = document.getElementById('summaryCards');
    summaryCards.innerHTML = `
        <div class="summary-card blue"><div class="card-value">${d.totalRespondents}</div><div class="card-label">Total Respondents</div></div>
        <div class="summary-card"><div class="card-value">${d.totalQuestions}</div><div class="card-label">Questions (Score)</div></div>
        <div class="summary-card green"><div class="card-value">${d.overallAverage}</div><div class="card-label">Overall Average</div></div>
        <div class="summary-card orange"><div class="card-value">${d.highest}</div><div class="card-label">Highest Average</div></div>
        <div class="summary-card red"><div class="card-value">${d.lowest}</div><div class="card-label">Lowest Average</div></div>
        <div class="summary-card" style="background:linear-gradient(135deg,#6c5ce7,#a29bfe)"><div class="card-value">1–${d.detectedScale}</div><div class="card-label">Detected Scale</div></div>
        ${d.replacementCount > 0 ? `<div class="summary-card" style="background:linear-gradient(135deg,#36d1dc,#5b86e5)"><div class="card-value">${d.replacementCount}</div><div class="card-label">Cells Replaced</div></div>` : ''}`;

    let head = '<tr><th>#</th>';
    d.infoHeaders.forEach(h => head += `<th>${escapeHtml(h)}</th>`);
    d.questionHeaders.forEach(h => head += `<th title="${escapeHtml(h)}">${escapeHtml(truncate(h, 40))}</th>`);
    head += '<th>Average</th><th>Result</th></tr>';
    const stickyBar = document.getElementById('summaryCardsSticky');
    if (stickyBar) {
        stickyBar.innerHTML = `
            <span class="sticky-stat"><span>👥</span>${d.totalRespondents} respondents</span>
            <span class="sticky-stat"><span>⌀</span>${d.overallAverage} avg</span>
            <span class="sticky-stat" style="color:#4ade80"><span>↑</span>${d.highest} high</span>
            <span class="sticky-stat" style="color:#f87171"><span>↓</span>${d.lowest} low</span>
            <span class="sticky-stat" style="color:#a78bfa"><span>📏</span>1–${d.detectedScale} scale</span>
            ${d.replacementCount > 0
                ? `<span class="sticky-stat" style="color:#67e8f9"><span>🔄</span>${d.replacementCount} replaced</span>`
                : ''}
            <span class="sticky-stat" style="cursor:pointer;background:rgba(255,255,255,.18)" onclick="toggleResultsBody()" title="Show results">▲ Show</span>
        `;
    }
    document.getElementById('tableHead').innerHTML = head;
    renderResultTableRows(d.respondents);
    renderDuplicateNotice(d.respondents);
    document.getElementById('resultsSection').classList.remove('hidden');
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
}

function renderDuplicateNotice(respondents) {
    const old = document.getElementById('duplicateNoticeBanner');
    if (old) old.remove();
    if (!respondents || !respondents.length) return;

    const SKIP_EMAILS = new Set(['anonymous', 'n/a', 'na', 'none', '-', '']);

    const nameMap  = {};
    const emailMap = {};
    respondents.forEach((r, i) => {
        const normName  = (r.name  || '').trim().toLowerCase();
        const normEmail = (r.email || '').trim().toLowerCase();
        if (normName)  { (nameMap[normName]  = nameMap[normName]  || []).push(i + 1); }
        if (normEmail && !SKIP_EMAILS.has(normEmail)) {
            (emailMap[normEmail] = emailMap[normEmail] || []).push(i + 1);
        }
    });

    const dupByName  = Object.entries(nameMap).filter(([, rows]) => rows.length > 1);
    const dupByEmail = Object.entries(emailMap).filter(([, rows]) => rows.length > 1);

    if (!dupByName.length && !dupByEmail.length) return;

    const dupRowNums = new Set([
        ...dupByName.flatMap(([, rows]) => rows),
        ...dupByEmail.flatMap(([, rows]) => rows),
    ]);
    document.querySelectorAll('#tableBody tr').forEach((tr, i) => {
        if (dupRowNums.has(i + 1)) {
            tr.style.background = 'rgba(251,191,36,.2)';
            tr.title = 'Duplicate detected — respondent count is already deduplicated by email';
        }
    });

    let detailsHtml = '';
    if (dupByName.length) {
        detailsHtml += `<div class="dup-group-label">⚠ Same Name (${dupByName.length} group${dupByName.length > 1 ? 's' : ''})</div>`;
        dupByName.forEach(([name, rows]) => {
            detailsHtml += `<div class="dup-item">
                <span class="dup-name">${escapeHtml(name)}</span>
                <span class="dup-rows">rows ${rows.join(', ')}</span>
            </div>`;
        });
    }
    if (dupByEmail.length) {
        detailsHtml += `<div class="dup-group-label" style="margin-top:8px;">✉ Same Email (${dupByEmail.length} group${dupByEmail.length > 1 ? 's' : ''})</div>`;
        dupByEmail.forEach(([email, rows]) => {
            detailsHtml += `<div class="dup-item">
                <span class="dup-name">${escapeHtml(email)}</span>
                <span class="dup-rows">rows ${rows.join(', ')}</span>
            </div>`;
        });
    }

    const totalDupRows = dupRowNums.size;
    const banner = document.createElement('div');
    banner.id = 'duplicateNoticeBanner';
    banner.innerHTML = `
        <div class="dup-banner-header" onclick="this.parentElement.querySelector('.dup-banner-body').classList.toggle('dup-collapsed')">
            <span class="dup-banner-icon">⚠</span>
            <span class="dup-banner-title">${totalDupRows} possible duplicate response${totalDupRows > 1 ? 's' : ''} detected</span>
            <span class="dup-banner-sub"> — highlighted in yellow. Only the first response per email will be saved; duplicates are automatically excluded.</span>
            <span class="dup-banner-toggle">▼ Details</span>
        </div>
        <div class="dup-banner-body">${detailsHtml}</div>`;

    const tableControls = document.querySelector('#resultsSection .table-controls');
    if (tableControls) tableControls.before(banner);
}

function renderResultTableRows(respondents) {
    document.getElementById('tableBody').innerHTML = respondents.map((r, i) =>
        `<tr><td>${i + 1}</td>${r.info.map(v => `<td>${escapeHtml(v || '-')}</td>`).join('')}${r.scores.map(s => `<td>${s !== null ? s : '-'}</td>`).join('')}<td class="avg-cell">${r.average}</td><td class="${getResultClass(r.result)}">${escapeHtml(r.result)}</td></tr>`
    ).join('');
}


// ═══════════════════════════════════════════════════════════════════════════════
// RENDER CONSOLIDATED REPORT
// ═══════════════════════════════════════════════════════════════════════════════
function renderConsolidated(c) {
    if (!c || !c.days) return;
    const resultBadge = label => {
        const cls = { 'Outstanding': 'badge-outstanding', 'Very Satisfactory': 'badge-vs', 'Satisfactory': 'badge-sat', 'Fair': 'badge-fair', 'Needs Improvement': 'badge-ni' }[label] || '';
        return `<span class="result-badge ${cls}">${escapeHtml(label)}</span>`;
    };
    let html = '';
    c.days.forEach(day => {
        html += `<div class="con-day-block"><div class="con-day-header">📅 ${escapeHtml(day.day)} <span class="con-day-count">${day.respondents} respondents</span></div>`;
        html += `<div class="con-section-label">📊 Category Ratings</div><table class="con-table"><thead><tr><th>Category / Column</th><th>Average</th><th>Result</th></tr></thead><tbody>`;
        Object.entries(day.categories).forEach(([cat, data]) => {
            if (!data) { html += `<tr><td>${escapeHtml(cat)}</td><td colspan="2" class="no-data">No data</td></tr>`; return; }
            html += `<tr class="con-cat-row"><td><strong>${escapeHtml(cat)}</strong></td><td class="avg-cell"><strong>${data.avg.toFixed(4)}</strong></td><td>${resultBadge(data.result)}</td></tr>`;
            if (data.colAvgs && data.colAvgs.length) {
                data.colAvgs.forEach((col, idx) => {
                    html += `<tr class="con-col-row"><td class="con-col-label">↳ Q${idx + 1} <span class="con-col-index">(col ${col.colIndex + 1})</span></td><td class="avg-cell">${col.avg !== null ? col.avg.toFixed(4) : '—'}</td><td class="con-col-n">${col.n} resp.</td></tr>`;
                });
            }
        });
        html += '</tbody></table>';
        if (day.speakers && day.speakers.length) {
            html += `<div class="con-section-label">🎤 Speaker Ratings</div>`;
            day.speakers.forEach(sp => {
                const displayName = (speakerNames[day.day] || {})[sp.slot] || sp.name || `Speaker ${sp.slot}`;
                html += `<div class="con-speaker-block"><div class="con-speaker-header"><span class="con-speaker-slot">Speaker ${sp.slot}</span><span class="sp-name" data-day="${escapeHtml(day.day)}" data-slot="${sp.slot}">${escapeHtml(displayName)}</span><span class="con-speaker-avg">${sp.overall.toFixed(4)}</span>${resultBadge(sp.result)}</div><table class="con-table con-table--sm"><thead><tr><th>Criterion</th><th>Average</th></tr></thead><tbody>`;
                sp.criteriaAvgs.forEach(cr => {
                    html += `<tr><td>${escapeHtml(cr.label)}</td><td class="avg-cell">${cr.avg !== null ? cr.avg.toFixed(4) : '—'}</td></tr>`;
                });
                html += '</tbody></table></div>';
            });
        }
        html += '</div>';
    });
    if (c.overallCategories && Object.keys(c.overallCategories).length) {
        html += `<div class="con-day-block con-overall"><div class="con-day-header">📋 Overall Category Summary (All Days)</div><table class="con-table"><thead><tr><th>Category</th><th>Average</th><th>Result</th></tr></thead><tbody>`;
        Object.entries(c.overallCategories).forEach(([cat, data]) => {
            html += `<tr><td>${escapeHtml(cat)}</td><td class="avg-cell">${data.avg.toFixed(4)}</td><td>${resultBadge(data.result)}</td></tr>`;
        });
        html += '</tbody></table></div>';
    }
    document.getElementById('consolidatedBody').innerHTML = html;
    document.getElementById('consolidatedSection').classList.remove('hidden');
    document.getElementById('consolidatedSection').scrollIntoView({ behavior: 'smooth' });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE TO DATABASE
// ═══════════════════════════════════════════════════════════════════════════════
function parseFilenameForMeta(raw) {
    let name = raw.replace(/\.[^.]+$/, '');
    for (let i = 0; i < 5; i++) {
        const before = name;
        name = name.replace(/[\s_\-]*[\(\[]\s*\d[\d\s\-]*\s*[\)\]]\s*$/g, '').trim();
        name = name.replace(/[\s_\-]+\d+[\s\-]+\d+\s*$/g, '').trim();
        name = name.replace(/[\s_\-]+\d+\s*$/g, '').trim();
        if (name === before) break;
    }
    name = name.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const dmMatch = name.match(/^(DM\s*[\d]+\s*S[\s,]*\s*\d{4})\s*(.*)/i);
    if (!dmMatch) return { divisionMemo: '', title: name.toUpperCase() };
    const dmRaw = dmMatch[1].trim();
    let titleRaw = dmMatch[2].trim();
    const divisionMemo = dmRaw.replace(/DM\s*([\d]+)\s*S[\s,]*\s*(\d{4})/i, (_, n, y) => `DM No.${n} S, ${y}`);
    titleRaw = titleRaw.replace(/^DAY\s+\d+\s*/i, '').trim();
    titleRaw = titleRaw.replace(/\s+\d{4}\s*$/, '').trim();
    return { divisionMemo, title: titleRaw.toUpperCase() };
}

const DEFAULT_WORKSHOP_OPTION_HTML = '<option value="">— None (standalone import) —</option>';

function setWorkshopStatusMessage(message, type = 'warn') {
    const el = document.getElementById('workshopStatusMsg');
    if (!el) return;

    if (!message) {
        el.className = 'save-status hidden';
        el.textContent = '';
        el.hidden = true;
        return;
    }

    const typeClass = type === 'err'
        ? 'save-status--err'
        : (type === 'ok' ? 'save-status--ok' : 'save-status--warn');
    el.className = `save-status ${typeClass}`;
    el.textContent = message;
    el.hidden = false;
}

function normalizeDropdownLabel(label) {
    return String(label || '').trim().replace(/\s+/g, ' ');
}

async function fetchApiJsonOrThrow(url, options = {}) {
    // Always send session cookies so the server can authenticate the request.
    options.credentials = options.credentials || 'include';

    const response = await fetch(url, options);
    const raw = await response.text();

    let data = null;
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (_) {
            data = null;
        }
    }

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Session expired or not logged in. Please refresh the page and log in again.');
        }
        if (response.status === 403) {
            throw new Error('You do not have permission to perform this action.');
        }
        throw new Error((data && data.message) || `Request failed (${response.status}).`);
    }
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid server response.');
    }

    return data;
}

function populateManagedDropdown(selectEl, options, fallbackValue) {
    if (!selectEl) return;

    const currentRaw = normalizeDropdownLabel(selectEl.value || fallbackValue || '');
    const labels = [];

    (Array.isArray(options) ? options : []).forEach(opt => {
        const label = normalizeDropdownLabel(opt?.label);
        if (label && !labels.some(existing => existing.toLowerCase() === label.toLowerCase())) {
            labels.push(label);
        }
    });

    if (currentRaw && !labels.some(existing => existing.toLowerCase() === currentRaw.toLowerCase())) {
        labels.unshift(currentRaw);
    }
    if (!labels.length && fallbackValue) {
        labels.push(fallbackValue);
    }

    const current = currentRaw || labels[0] || '';
    selectEl.innerHTML = labels.map(label =>
        `<option value="${escapeHtml(label)}"${label.toLowerCase() === current.toLowerCase() ? ' selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');
}

async function promptAddDropdownOption(type) {
    const typeKey = type === 'nature_of_event' ? 'nature_of_event' : 'unit';
    const prettyType = typeKey === 'nature_of_event' ? 'nature of event' : 'unit';
    const labelInput = prompt('Enter new ' + prettyType + ':');

    if (labelInput === null) return;

    const label = normalizeDropdownLabel(labelInput);
    if (!label) {
        setWorkshopStatusMessage('Please enter a valid ' + prettyType + ' label.', 'warn');
        return;
    }

    try {
        const json = await fetchApiJsonOrThrow(CONFIG.API_URL + '/programs.php?manage_options=1', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: typeKey, label })
        });

        if (!json.success) {
            throw new Error(json.message || 'Unable to save dropdown option.');
        }

        await loadSaveModalDropdowns();

        const selectId = typeKey === 'unit' ? 'meta_unit' : 'meta_nature';
        const selectEl = document.getElementById(selectId);
        if (selectEl) selectEl.value = label;

        setWorkshopStatusMessage('Added "' + label + '" to ' + prettyType + '.', 'ok');
        showToast('✓ Added ' + prettyType + ': ' + label, 'ok');
    } catch (err) {
        setWorkshopStatusMessage('Could not add ' + prettyType + ': ' + err.message, 'err');
        showToast('Failed to add ' + prettyType, 'err');
    }
}

async function openSaveModal() {
    if (!resultsData) return;

    // ── Read URL params for container-linked import mode ──────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const linkedWorkshopId  = urlParams.get('workshop_id');
    const linkedDayLabel    = urlParams.get('day_label') || '';
    replaceImportId   = urlParams.get('replace_import_id');   // set when replacing a day
    replaceProgramId  = urlParams.get('replace_program_id');  // old program_id to unlink

    const titleEl = document.getElementById('meta_title');
    const memoEl  = document.getElementById('meta_division_memo');
    if (selectedFile && titleEl && !titleEl.value.trim()) {
        const { divisionMemo, title } = parseFilenameForMeta(selectedFile.name);
        titleEl.value = title;
        if (memoEl && !memoEl.value.trim() && divisionMemo) memoEl.value = divisionMemo;
    }

    const seqEl = document.getElementById('meta_sequence_number');
    if (seqEl && !seqEl.value.trim()) {
        try {
            const seqRes = await fetch(CONFIG.API_URL + '/records_api.php?action=next_sequence', {
                credentials: 'include'
            });
            const seqJson = await seqRes.json();
            if (seqJson.success && seqJson.sequence_number) {
                seqEl.value = seqJson.sequence_number;
            }
        } catch (_) { /* non-fatal */ }
    }

    const saveStatusEl = document.getElementById('saveStatus');
    if (saveStatusEl) saveStatusEl.hidden = true;
    setWorkshopStatusMessage('');

    const wsSel = document.getElementById('meta_workshop');
    const wsGroup = document.getElementById('meta_workshop_group');

    // ── Toggle standalone-only fields based on linked mode ───────────────────
    // Fields with data-standalone-only are hidden for container-linked imports;
    // the container program already owns all program detail metadata.
    const standaloneOnlyEls = document.querySelectorAll('[data-standalone-only]');
    const linkedNotice = document.getElementById('linkedModeNotice');
    const titleInput   = document.getElementById('meta_title');
    if (linkedWorkshopId) {
        standaloneOnlyEls.forEach(el => { el.style.display = 'none'; });
        if (linkedNotice) linkedNotice.style.display = '';
        // Remove required from title — we'll auto-generate it in save.php
        if (titleInput) titleInput.removeAttribute('required');
    } else {
        standaloneOnlyEls.forEach(el => { el.style.display = ''; });
        if (linkedNotice) linkedNotice.style.display = 'none';
        if (titleInput) titleInput.setAttribute('required', 'required');
    }

    // ── Container-linked mode: pre-fill and lock the workshop dropdown ─────────
    if (linkedWorkshopId && wsSel) {
        if (wsGroup) wsGroup.style.display = '';
        wsSel.innerHTML = '';
        // Show a locked banner instead of the dropdown
        let wsLockBanner = document.getElementById('wsLockBanner');
        if (!wsLockBanner) {
            wsLockBanner = document.createElement('div');
            wsLockBanner.id = 'wsLockBanner';
            wsLockBanner.style.cssText = 'padding:10px 14px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;font-size:13px;color:#1e3a8a;display:flex;align-items:center;gap:8px;margin-bottom:8px;';
            wsSel.parentNode.insertBefore(wsLockBanner, wsSel);
        }
        wsSel.style.display = 'none';
        // Fetch the container program name to display
        try {
            const wsRes = await fetch(`${CONFIG.API_URL}/programs.php?id=${linkedWorkshopId}`, { credentials: 'include' });
            const wsJson = await wsRes.json();
            const wsTitle = wsJson.success ? wsJson.data.title : `Program #${linkedWorkshopId}`;
            const modeLabel = replaceImportId
                ? `<span style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;">REPLACING ${escapeHtml(linkedDayLabel)}</span>`
                : `<span style="color:#6b7280;font-size:12px;">(${linkedDayLabel || 'Day Import'})</span>`;
            wsLockBanner.innerHTML = `<i class="fa-solid fa-link" style="color:#3b82f6;"></i> <strong>Linking to:</strong> ${wsTitle} &nbsp;${modeLabel}`;
        } catch (_) {
            wsLockBanner.innerHTML = `<i class="fa-solid fa-link" style="color:#3b82f6;"></i> <strong>Linking to program #${linkedWorkshopId}</strong>`;
        }
        // Set the hidden value so submitSave picks it up
        wsSel.dataset.lockedWorkshopId = linkedWorkshopId;

        // ── Auto-calculate per-day inclusive date from container's start_date ──
        // Day N date = start_date + (N - 1) days, formatted as "Month D, YYYY"
        const linkedDatesGroup = document.getElementById('linkedDatesGroup');
        const linkedDatesInput = document.getElementById('meta_day_inclusive_dates');
        if (linkedDatesGroup && linkedDatesInput) {
            linkedDatesGroup.style.display = '';
            try {
                const wsRes2 = await fetch(`${CONFIG.API_URL}/programs.php?id=${linkedWorkshopId}`, { credentials: 'include' });
                const wsJson2 = await wsRes2.json();
                const containerStartDate = wsJson2.success ? wsJson2.data.start_date : null;
                const dayNum = parseInt(String(linkedDayLabel).match(/\d+/)?.[0] || '1');
                if (containerStartDate && dayNum) {
                    const d = new Date(containerStartDate);
                    d.setDate(d.getDate() + (dayNum - 1));
                    const formatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                    if (!linkedDatesInput.value.trim()) linkedDatesInput.value = formatted;
                }
            } catch (_) { /* non-fatal — user can type it manually */ }
        }
    } else if (wsSel && !wsSel.dataset.loaded) {
        // Normal mode (standalone import): linking to legacy live workshops is disabled.
        // Container-day imports are linked via URL params (workshop_id/day_label) only.
        if (wsGroup) wsGroup.style.display = 'none';
        const wsLockBanner = document.getElementById('wsLockBanner');
        if (wsLockBanner) wsLockBanner.style.display = 'none';
        wsSel.style.display = 'none';
        wsSel.innerHTML = DEFAULT_WORKSHOP_OPTION_HTML;
        delete wsSel.dataset.lockedWorkshopId;
    }

    await loadSaveModalDropdowns();
    populateModalSpeakerInputs(_lastSpeakerDays);
    populateModalParticipantInputs();

    document.getElementById('saveModal').classList.add('modal--open');
}

function populateModalParticipantInputs() {
    const pip = document.getElementById('meta_total_participants');
    if (pip && !pip.value) {
        pip.value = (resultsData && resultsData.totalRespondents) || '';
    }
    renderPerDayDisplay();
    updateParticipantPct();
}

function renderPerDayDisplay() {
    const container = document.getElementById('meta_perday_display');
    if (!container) return;
    const consolidatedDays = (resultsData && resultsData.consolidated && resultsData.consolidated.days) || [];
    if (consolidatedDays.length <= 1) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = consolidatedDays.map(day => {
        const dayName   = day.day || 'Day';
        const respCount = day.respondents || 0;
        return `<div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;font-weight:600;color:#1e3a8a;background:#dbeafe;
                         border:1px solid #93c5fd;border-radius:6px;padding:3px 10px;
                         white-space:nowrap;min-width:60px;text-align:center;">
                ${escapeHtml(dayName)}
            </span>
            <span style="font-size:13px;color:#374151;flex:1;">
                ${respCount} response${respCount !== 1 ? 's' : ''}
            </span>
            <span class="day-pct-label" data-responses="${respCount}"
                  style="font-size:13px;font-weight:600;color:#059669;min-width:52px;text-align:right;"></span>
        </div>`;
    }).join('');
    updateParticipantPct();
}

function updateParticipantPct() {
    const total = parseInt(document.getElementById('meta_total_participants')?.value) || 0;
    document.querySelectorAll('.day-pct-label').forEach(el => {
        const responses = parseInt(el.dataset.responses) || 0;
        el.textContent = total > 0
            ? Math.min((responses / total) * 100, 100).toFixed(1) + '%'
            : '';
    });
    const pctEl = document.getElementById('meta_pct_display');
    if (pctEl) {
        const responses = (resultsData && resultsData.totalRespondents) || 0;
        pctEl.textContent = total > 0 && responses > 0
            ? Math.min((responses / total) * 100, 100).toFixed(1) + '%'
            : '';
    }
}

async function loadSaveModalDropdowns() {
    try {
        const json = await fetchApiJsonOrThrow(CONFIG.API_URL + '/programs.php?dropdown_options=1', {
            credentials: 'include'
        });
        if (!json.success) throw new Error(json.message || 'Failed to load dropdown options.');

        const { unit = [], nature_of_event = [] } = json.data;

        const unitSel   = document.getElementById('meta_unit');
        const natureSel = document.getElementById('meta_nature');

        populateManagedDropdown(unitSel, unit, 'SGOD');
        populateManagedDropdown(natureSel, nature_of_event, 'Training');
    } catch (e) {
        console.warn('Could not load save modal dropdowns:', e);
        setWorkshopStatusMessage('Could not load Unit/Nature options: ' + e.message + ' You can still use the default choices.', 'warn');
    }
}

function closeModal() { document.getElementById('saveModal').classList.remove('modal--open'); }

async function submitSave(e) {
    e.preventDefault();
    const saveSubmitBtn = document.getElementById('saveSubmitBtn');
    const saveStatus = document.getElementById('saveStatus');
    saveSubmitBtn.disabled = true;
    saveSubmitBtn.textContent = 'Saving...';
    saveStatus.hidden = true;

    const meta = {
        title:              document.getElementById('meta_title').value.trim(),
        sequence_number:    document.getElementById('meta_sequence_number')?.value.trim() || '',
        division_memo:      document.getElementById('meta_division_memo').value.trim(),
        proponents:         document.getElementById('meta_proponents').value.trim(),
        training_venue:     document.getElementById('meta_venue').value.trim(),
        inclusive_dates:    (document.getElementById('meta_day_inclusive_dates')?.offsetParent !== null
                                ? document.getElementById('meta_day_inclusive_dates')?.value.trim()
                                : document.getElementById('meta_dates').value.trim()) || '',
        start_date:         document.getElementById('meta_start_date').value.trim(),
        end_date:           document.getElementById('meta_end_date').value.trim(),
        qame_associates:    document.getElementById('meta_qame').value.trim(),
        total_participants: parseInt(document.getElementById('meta_total_participants').value) || 0,
        status:             'completed',
        unit:               document.getElementById('meta_unit')?.value.trim() || '',
        nature_of_event:    document.getElementById('meta_nature')?.value.trim() || '',
        description:        document.getElementById('meta_description')?.value.trim() || '',
        page:               new URLSearchParams(window.location.search).get('page') || window.PAGE_KEY || 'qatame',
    };
    const workshopSel = document.getElementById('meta_workshop');
    // In container-linked mode the dropdown is hidden; read from dataset instead
    const lockedWorkshopId = workshopSel ? parseInt(workshopSel.dataset.lockedWorkshopId || '', 10) : NaN;
    const selectedWorkshopValue = !isNaN(lockedWorkshopId) ? String(lockedWorkshopId) : (workshopSel ? workshopSel.value : '');
    const workshopId = selectedWorkshopValue ? parseInt(selectedWorkshopValue, 10) : null;
    if (selectedWorkshopValue && !Number.isFinite(workshopId)) {
        saveStatus.className = 'save-status save-status--err';
        saveStatus.innerHTML = '<strong>Error:</strong> Invalid workshop link selected. Please reselect a workshop.';
        saveStatus.hidden = false;
        saveSubmitBtn.textContent = 'Save to Database';
        saveSubmitBtn.disabled = false;
        return;
    }

    // Read day_label from URL param (container mode) or leave empty (standalone)
    const urlParams = new URLSearchParams(window.location.search);
    const dayLabel = decodeURIComponent(urlParams.get('day_label') || '');
    // FIX: Priority order matters here.
    // 1. dayLabel from the URL — set by addDayImport(), always correct (e.g. "Day 2")
    // 2. Server's consolidated day label — fallback only; process.php may return
    //    "Day 1" regardless of actual sheet name, so it must NOT take priority
    // 3. 'Day 1' — last resort for standalone imports with no URL param
    // The old order (server first) was the root cause: Day 2 was saved as Day 1.
    const firstDay = dayLabel || resultsData.consolidated?.days?.[0]?.day || 'Day 1';

    const SKIP_EMAILS_SAVE = new Set(['anonymous', 'n/a', 'na', 'none', '-', '']);
    const seenEmailsByDay = {};
    const enriched = (resultsData.respondents || [])
        .filter(r => {
            const normEmail = (r.email || '').trim().toLowerCase();
            const isReal = normEmail && !SKIP_EMAILS_SAVE.has(normEmail);
            if (isReal) {
                const day = r.day || firstDay;
                if (!seenEmailsByDay[day]) seenEmailsByDay[day] = new Set();
                if (seenEmailsByDay[day].has(normEmail)) return false;
                seenEmailsByDay[day].add(normEmail);
            }
            return true;
        })
        .map(r => ({
            ...r, day: r.day || firstDay, fullname: r.fullname || r.name || '', feedback: r.feedback || {},
        }));
    
    const consolidatedWithNames = JSON.parse(JSON.stringify(resultsData.consolidated || {}));
    if (consolidatedWithNames.days) {
        consolidatedWithNames.days.forEach(day => {
            if (day.speakers && speakerNames[day.day]) {
                day.speakers.forEach(sp => {
                    const enteredName = speakerNames[day.day][sp.slot];
                    if (enteredName && enteredName.trim()) {
                        sp.name = enteredName.trim();
                    }
                });
            }
        });
    }

    const payload = {
        meta, respondents: enriched,
        questionHeaders: resultsData.questionHeaders || [],
        detectedScale: resultsData.detectedScale || 4,
        consolidated: consolidatedWithNames,
        filename: selectedFile ? selectedFile.name : '',
        questionCategoryMap: resultsData.questionCategoryMap || {},
        workshop_id: workshopId,
        day_label: firstDay,  // FIX: always a valid "Day N" string, never undefined/empty
        replace_import_id: replaceImportId || null,  // pass so save.php inherits correct day_number
    };
    try {
        const json = await fetchApiJsonOrThrow(CONFIG.API_URL + '/save.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (json.success) {
            const s = json.stats;
            saveSubmitBtn.dataset.lastProgramId = json.program_id;

            // In replace mode: remove the old program_imports link now that the
            // new import has been saved and linked successfully.
            if (replaceImportId && workshopId) {
                try {
                    await fetch(`${CONFIG.API_URL}/programs.php?program_imports=1&id=${replaceImportId}`, {
                        method: 'DELETE',
                        credentials: 'include'
                    });
                } catch (_) { /* non-fatal — old link stays but new one is added */ }
            }

            // In container mode: offer to import the next day immediately
            const nextDayNum = (parseInt(urlParams.get('day_label')?.match(/\d+/)?.[0] || '1')) + 1;
            const nextDayLabel = encodeURIComponent('Day ' + nextDayNum);

            const returnBtn = workshopId
                ? `<button onclick="window.location.href='${_PAGE_BACK}'" style="margin-top:8px;margin-right:8px;padding:6px 14px;background:#6b7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;"><i class="fa-solid fa-arrow-left"></i> Back to Programs</button>`
                : '';

            const nextDayBtn = (workshopId && !replaceImportId)
                ? `<button onclick="window.location.href='import-excell.html?workshop_id=${workshopId}&day_label=${nextDayLabel}'" style="margin-top:8px;margin-right:8px;padding:6px 14px;background:#15803d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;"><i class="fa-solid fa-file-import"></i> Import Day ${nextDayNum}</button>`
                : '';

            saveStatus.className = 'save-status save-status--ok';
            saveStatus.innerHTML = '<strong>Saved! Program ID #' + json.program_id + '</strong><br>' +
                s.respondents_saved + ' respondents saved &middot; ' + s.days_saved + ' day(s) &middot; ' +
                'Overall avg: <strong>' + s.overall_average + '</strong> (' + s.overall_result + ') &middot; ' +
                'Response rate: <strong>' + s.pct_responses + '%</strong>' +
                '<br>' + nextDayBtn + returnBtn +
                '<button onclick="window.location.href=\'workshop-dashboard.html?' + (workshopId ? 'workshop_id=' + workshopId : 'program_id=' + json.program_id) + '\'" ' +
                'style="margin-top:8px;padding:6px 14px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">' +
                '<i class="fa-solid fa-chart-line"></i> View in Dashboard</button>';
            saveStatus.hidden = false;

            saveSubmitBtn.textContent = 'Re-save to Database';
            saveSubmitBtn.disabled = false;
            saveSubmitBtn.style.background = 'linear-gradient(135deg,#6366f1,#8b5cf6)';

            document.getElementById('saveBtn').textContent = 'Saved to Database';
            document.getElementById('saveBtn').style.background = 'linear-gradient(135deg,#059669,#34d399)';
            showToast('✓ Saved to database', 'ok');
        } else { throw new Error(json.message || 'Unknown error.'); }
    } catch (err) {
        saveStatus.className = 'save-status save-status--err';
        saveStatus.innerHTML = '<strong>Error:</strong> ' + escapeHtml(err.message);
        saveStatus.hidden = false;
        saveSubmitBtn.textContent = 'Save to Database';
        saveSubmitBtn.disabled = false;
        setWorkshopStatusMessage('Save failed: ' + err.message, 'err');
        showToast('Save failed', 'err');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH & EXPORT CSV
// ═══════════════════════════════════════════════════════════════════════════════
function searchResults() {
    if (!resultsData) return;
    const q = document.getElementById('searchInput').value.toLowerCase().trim();
    if (!q) { renderResultTableRows(resultsData.respondents); return; }
    renderResultTableRows(resultsData.respondents.filter(r =>
        r.name.toLowerCase().includes(q) || r.result.toLowerCase().includes(q) || r.info.some(v => v && v.toLowerCase().includes(q))
    ));
}

function exportCSV() {
    if (!resultsData) return;
    let csv = 'No,';
    resultsData.infoHeaders.forEach(h => csv += `"${h}",`);
    resultsData.questionHeaders.forEach(h => csv += `"${h}",`);
    csv += 'Average,Result\n';
    resultsData.respondents.forEach((r, i) => {
        csv += `${i + 1},`;
        r.info.forEach(v => csv += `"${v || ''}",`);
        r.scores.forEach(s => csv += `${s !== null ? s : ''},`);
        csv += `${r.average},"${r.result}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'form_results_' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click(); URL.revokeObjectURL(link.href);
}


// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ACTIONS (reset, save settings, download JSON)
// ═══════════════════════════════════════════════════════════════════════════════
function resetAll() {
    if (!confirm('Reset all data and return to upload screen?')) return;
    sheetsData = {};
    currentSheet = '';
    selIdx = null; customTags = []; activeFilter = null;
    selectedFile = null;
    SAMPLE_ROWS_DYNAMIC = null;
    resultsData = null;
    lastConsolidated = null;
    excludedKeywords = ['privacy', 'email', 'name', 'time'];
    scaleCandidates = [4, 5, 7];
    skipSheets = ['summary', 'cover'];
    closeEP();
    showUploadZone();
    renderExcludedKeywords();
    renderScaleCandidates();
    renderSkipSheets();
    setStep(1);
    updateComputeBtn();
    showToast('↺ Reset — upload a new file to begin', 'info');
}

/**
 * Save only the non-column settings (skip sheets, scale, thresholds, respondent cols,
 * excluded keywords) without requiring a file to be uploaded first.
 * Safe to call from the Settings tab at any time.
 */
async function saveSettingsOnly() {
    const btn = document.querySelector('#saveSettingsBar .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
        // Build a minimal payload from the current UI state only.
        // If a file is loaded we include full column config; otherwise just the standalone settings.
        const hasFile = Object.keys(sheetsData).length > 0;
        let payload;
        if (hasFile) {
            payload = buildSettingsPayload();
        } else {
            // Collect standalone settings from UI
            const thresholdInputs = document.querySelectorAll('#sec-settings .threshold-input');
            const thresholds = Array.from(thresholdInputs).map((inp, i) => {
                const labels = ['Outstanding','Very Satisfactory','Satisfactory','Fair','Needs Improvement'];
                return { label: labels[i] || `Level ${i+1}`, pct: parseInt(inp.value) || 0 };
            });
            payload = {
                skip_sheets: [...skipSheets],
                excluded_keywords: [...excludedKeywords],
                scale_candidates: [...scaleCandidates],
                result_thresholds: thresholds,
                respondent_info_cols: {
                    fullname:         document.getElementById('ri_name')?.value  || null,
                    email:            document.getElementById('ri_email')?.value || null,
                    sex:              document.getElementById('ri_sex')?.value   || null,
                    participant_type: document.getElementById('ri_type')?.value  || null,
                    designation:      document.getElementById('ri_desig')?.value || null,
                    school:           document.getElementById('ri_school')?.value|| null,
                },
            };
            // Preserve existing categories/speaker config from dbSettings so we don't wipe them
            if (dbSettings?.categories)     payload.categories     = dbSettings.categories;
            if (dbSettings?.speaker_slots)  payload.speaker_slots  = dbSettings.speaker_slots;
            if (dbSettings?.speaker_criteria) payload.speaker_criteria = dbSettings.speaker_criteria;
            if (dbSettings?.category_styles)  payload.category_styles  = dbSettings.category_styles;
        }

        const res = await fetch(CONFIG.API_URL + '/settings_api.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            showToast('✓ Settings saved to database', 'ok');
            // Refresh local dbSettings so subsequent operations use the new values
            dbSettings = { ...(dbSettings || {}), ...payload };
        } else {
            throw new Error(data.message || 'Unknown error');
        }
    } catch (err) {
        showToast('Error saving settings: ' + err.message, 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings'; }
    }
}

async function resetCategoryStyles() {
    if (!confirm('Reset and regenerate saved category colors? This keeps your categories but refreshes their style mapping.')) {
        return;
    }

    showToast('⏳ Resetting category colors…', 'info');

    const previousStyles = dbSettings?.category_styles;
    if (!dbSettings || typeof dbSettings !== 'object') dbSettings = {};
    delete dbSettings.category_styles;

    const ok = await saveSettingsToDB();
    if (!ok) {
        if (previousStyles) dbSettings.category_styles = previousStyles;
        showToast('Failed to reset category colors', 'err');
        return;
    }

    await loadSettingsFromDB();
    if (Object.keys(sheetsData).length) {
        renderCatLegend();
        renderAll();
    }
    showToast('✓ Category colors reset and saved', 'ok');
}

function downloadJSON() {
    const payload = {
        exported_at: new Date().toISOString(),
        file: document.getElementById('fileNameLabel').textContent || 'Sample-DM-057-S-2026',
        sheets: Object.keys(sheetsData).reduce((acc, s) => {
            acc[s] = sheetsData[s].map(c => ({ letter: c.letter, name: c.name, type: c.type, category: c.category }));
            return acc;
        }, {})
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qatalyst-column-config.json';
    a.click();
    showToast('↓ JSON backup downloaded', 'ok');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — DB Load/Save
// ═══════════════════════════════════════════════════════════════════════════════

async function loadSettingsFromDB() {
    try {
        const res = await fetch(CONFIG.API_URL + '/settings_api.php');
        const data = await res.json();
        if (data.success && data.settings) {
            dbSettings = data.settings;
            applyDBSettingsToUI(data.settings);
            showToast('✓ Settings loaded from database', 'ok');
        } else { showToast('Could not load settings — using defaults', 'info'); }
    } catch (err) { showToast('Error loading settings: ' + err.message, 'err'); }
}

function applyDBSettingsToUI(s) {
    const ri = s.respondent_info_cols;
    if (ri) {
        if (ri.fullname) document.getElementById('ri_name').value = ri.fullname;
        if (ri.email) document.getElementById('ri_email').value = ri.email;
        if (ri.sex) document.getElementById('ri_sex').value = ri.sex;
        if (ri.participant_type) document.getElementById('ri_type').value = ri.participant_type;
        if (ri.designation) document.getElementById('ri_desig').value = ri.designation;
        if (ri.school) document.getElementById('ri_school').value = ri.school;
    }
    if (s.excluded_keywords && Array.isArray(s.excluded_keywords)) { excludedKeywords = [...s.excluded_keywords]; renderExcludedKeywords(); }
    if (s.scale_candidates && Array.isArray(s.scale_candidates)) { scaleCandidates = [...s.scale_candidates]; renderScaleCandidates(); }
    if (s.result_thresholds && Array.isArray(s.result_thresholds)) {
        const inputs = document.querySelectorAll('#sec-settings .threshold-input');
        s.result_thresholds.forEach((t, i) => { if (inputs[i]) inputs[i].value = t.pct; });
    }
    if (s.skip_sheets && Array.isArray(s.skip_sheets)) { skipSheets = [...s.skip_sheets]; renderSkipSheets(); }

    if (Object.keys(sheetsData).length) {
        renderCatLegend();
        renderAll();
    }
}

async function saveSettingsToDB() {
    try {
        const payload = buildSettingsPayload();
        const res = await fetch(CONFIG.API_URL + '/settings_api.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.success) {
            showToast('✓ Settings saved to database', 'ok');
            return true;
        }
        else { throw new Error(data.message || 'Unknown error'); }
    }
    catch (err) {
        showToast('Error saving settings: ' + err.message, 'err');
        return false;
    }
}

function buildCategoryStylesForSave() {
    const saved = getPersistedCategoryStyles();
    const styles = { ...saved };
    getScoreCategories().forEach(c => {
        if (!c || !c.name || !isValidCategoryStyle(c)) return;
        styles[c.name] = {
            color: c.color,
            bg: c.bg,
            border: c.border
        };
    });
    return styles;
}

function buildSettingsPayload() {
    const cols = sheetsData[currentSheet] || [];
    const categories = {};
    cols.forEach(c => {
        if (c.type === 'score' && c.category && c.category !== 'Resource Speaker' && c.category !== 'Feedbacks') {
            if (!categories[c.category]) categories[c.category] = [];
            categories[c.category].push(c.index + 1);
        }
    });

    const speakerSlots = {};
    let speakerCriteria = [];
    const speakerCols = cols.filter(c => c.type === 'score' && c.category === 'Resource Speaker');

    const speakerGroups = {};
    let hasExplicitSlots = false;
    speakerCols.forEach(c => {
        const match = c.name.match(/\[Speaker (\d+)\]/);
        if (match) {
            hasExplicitSlots = true;
            if (!speakerGroups[match[1]]) speakerGroups[match[1]] = [];
            speakerGroups[match[1]].push(c.index + 1);
            if (match[1] === '1') speakerCriteria.push(c.name.replace(/\s*\[Speaker \d+\]/, '').trim());
        }
    });
    if (hasExplicitSlots) {
        Object.keys(speakerGroups).sort().forEach(num => { speakerSlots[num] = speakerGroups[num]; });
    }

    if (!hasExplicitSlots && speakerCols.length > 0) {
        const criteriaCount = getSpeakerCriteriaCount(speakerCols);
        const numSpeakers = Math.floor(speakerCols.length / criteriaCount);
        for (let s = 0; s < numSpeakers; s++) {
            const group = speakerCols.slice(s * criteriaCount, (s + 1) * criteriaCount);
            speakerSlots[s + 1] = group.map(c => c.index + 1);
        }
        speakerCols.slice(0, criteriaCount).forEach(c => {
            speakerCriteria.push(c.name
                .replace(/\s*\d+\s*$/, '')
                .replace(/Somewhat Satisfied\s*$/i, '')
                .trim());
        });
    }
    const feedbackCols = cols.filter(c => c.type === 'feedback').sort((a, b) => a.index - b.index);
    const feedback = feedbackCols.map(c => c.index + 1);  // flat ordered array of 1-based col indices
    const _riSex   = letterToCol(document.getElementById('ri_sex').value);
    const _riName  = letterToCol(document.getElementById('ri_name').value);
    const _riEmail = letterToCol(document.getElementById('ri_email').value);
    const _riType  = letterToCol(document.getElementById('ri_type').value);
    const _riDesig = letterToCol(document.getElementById('ri_desig').value);
    const _riSchool= letterToCol(document.getElementById('ri_school').value);
    const respondent_info_cols = {
        fullname:         isNaN(_riName)   ? null : _riName,
        email:            isNaN(_riEmail)  ? null : _riEmail,
        sex:              isNaN(_riSex)    ? null : _riSex,
        participant_type: isNaN(_riType)   ? null : _riType,
        designation:      isNaN(_riDesig)  ? null : _riDesig,
        school:           isNaN(_riSchool) ? null : _riSchool,
    };
    const thresholdLabels = ['Outstanding', 'Very Satisfactory', 'Satisfactory', 'Needs Improvement'];
    const thresholdInputs = document.querySelectorAll('#sec-settings .threshold-input');
    const result_thresholds = thresholdLabels.map((label, i) => ({ label, pct: thresholdInputs[i] ? parseInt(thresholdInputs[i].value) || 0 : 0 }));
    const sheet_overrides = {};
    const sheetNames = Object.keys(sheetsData);
    if (sheetNames.length > 1) {
        sheetNames.slice(1).forEach(sn => {
            const sCols = sheetsData[sn];
            const sSpkCols = sCols.filter(c => c.type === 'score' && c.category === 'Resource Speaker');

            let sActiveSpeakers = [];
            let sHasExplicit = false;
            const sGroups = {};
            sSpkCols.forEach(c => {
                const m = c.name.match(/\[Speaker (\d+)\]/);
                if (m) { sHasExplicit = true; if (!sGroups[m[1]]) sGroups[m[1]] = []; sGroups[m[1]].push(c.index + 1); }
            });
            if (sHasExplicit) {
                sActiveSpeakers = Object.keys(sGroups).map(Number);
            } else if (sSpkCols.length > 0) {
                const cc = getSpeakerCriteriaCount(sSpkCols);
                const ns = Math.floor(sSpkCols.length / cc);
                for (let s = 0; s < ns; s++) sActiveSpeakers.push(s + 1);
            }

            const sFb = sCols.filter(c => c.type === 'feedback').sort((a, b) => a.index - b.index);
            sheet_overrides[sn] = { activeSpeakers: sActiveSpeakers, feedback: sFb.map(c => c.index + 1) };
        });
    }
    return {
        categories,
        category_styles: buildCategoryStylesForSave(),
        speaker_slots: speakerSlots,
        // NOTE: speaker_criteria is intentionally NOT sent here anymore.
        // This function runs on every routine import (proceedToCompute ->
        // saveSettingsToDB), and used to overwrite the global,
        // shared eval_settings.speaker_criteria fallback with whatever text
        // happened to be in *this* file's speaker-column headers -- including
        // stray data-entry noise (e.g. an evaluator's name left in a header
        // cell) -- which then silently applied to every other workshop's
        // display too. process.php now reads each sheet's own real header
        // text directly for each speaker's criteria label, so this shared
        // array is only used as a last-resort fallback when a header is
        // missing/blank, and should only be changed intentionally (e.g. via
        // a dedicated settings control), never as a side effect of importing
        // a file.
        feedback_columns: feedback,
        respondent_info_cols,
        excluded_keywords: [...excludedKeywords],
        scale_candidates: [...scaleCandidates],
        result_thresholds,
        skip_sheets: [...skipSheets],
        sheet_overrides
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAG INPUT HELPERS (Excluded Keywords, Scale Candidates, Skip Sheets)
// ═══════════════════════════════════════════════════════════════════════════════
let excludedKeywords = ['privacy', 'email', 'e-mail', 'gmail', 'electronic mail', 'koreo', 'name', 'time', 'id', 'timestamp', 'sex', 'gender', 'school', 'office', 'designation', 'position', 'district', 'region', 'contact', 'respondent', 'participants'];
function renderExcludedKeywords() {
    const wrap = document.getElementById('excWrap');
    wrap.innerHTML = excludedKeywords.map((kw, i) => `<span class="ctag">${kw}<button class="ctag-rm" onclick="removeExcKeyword(${i})">✕</button></span>`).join('') + `<input class="tag-in" id="excIn" placeholder="type keyword…" style="width:100px" onkeydown="excKeydown(event)">`;
}
function removeExcKeyword(i) { excludedKeywords.splice(i, 1); renderExcludedKeywords(); }
function excKeydown(e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = e.target.value.trim().toLowerCase(); if (v && !excludedKeywords.includes(v)) excludedKeywords.push(v); e.target.value = ''; renderExcludedKeywords(); } }

let scaleCandidates = [4, 5, 7];
function renderScaleCandidates() {
    const wrap = document.getElementById('scaleWrap');
    wrap.innerHTML = scaleCandidates.map((s, i) => `<span class="ctag" style="background:#D1FAE5;color:#065F46;border-color:#A7F3D0">${s}<button class="ctag-rm" onclick="removeScaleCand(${i})">✕</button></span>`).join('') + `<input class="tag-in" id="scaleIn" placeholder="add…" style="width:40px" onkeydown="scaleKeydown(event)">`;
}
function removeScaleCand(i) { scaleCandidates.splice(i, 1); renderScaleCandidates(); }
function scaleKeydown(e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = parseInt(e.target.value.trim()); if (v && !scaleCandidates.includes(v)) scaleCandidates.push(v); e.target.value = ''; scaleCandidates.sort((a, b) => a - b); renderScaleCandidates(); } }

let skipSheets = ['summary', 'cover'];
function renderSkipSheets() {
    const wrap = document.getElementById('skipWrap');
    wrap.innerHTML = skipSheets.map((s, i) => `<span class="ctag" style="background:#FEE2E2;color:#991B1B;border-color:#FECACA">${s}<button class="ctag-rm" onclick="removeSkipSheet(${i})">✕</button></span>`).join('') + `<input class="tag-in" id="skipIn" placeholder="sheet name…" style="width:110px" onkeydown="skipKeydown(event)">`;
    const activeNote = document.querySelector('#sec-settings .cfg-card div[style*="margin-top:8px"]');
    if (activeNote) {
        const activeSheetsList = Object.keys(sheetsData).filter(s => !skipSheets.includes(s.toLowerCase()));
        activeNote.innerHTML = 'Currently active sheets: ' + activeSheetsList.map(s => `<strong style="color:var(--green)">${s}</strong>`).join(', ');
    }
}
function removeSkipSheet(i) { skipSheets.splice(i, 1); renderSkipSheets(); }
function skipKeydown(e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = e.target.value.trim().toLowerCase(); if (v && !skipSheets.includes(v)) skipSheets.push(v); e.target.value = ''; renderSkipSheets(); } }


// ═══════════════════════════════════════════════════════════════════════════════
// SAVED COLUMN CONFIGURATIONS — Load / Save / Apply / Delete
// ═══════════════════════════════════════════════════════════════════════════════
async function loadSavedConfigs() {
    const lists = [document.getElementById('savedConfigsList'), document.getElementById('savedConfigsListBackup')].filter(Boolean);
    try {
        const res = await fetch(CONFIG.API_URL + '/column_configs.php');
        const data = await res.json();
        if (!data.success || !data.configs.length) {
            allInlineConfigs = [];
            const empty = '<div class="saved-configs-empty"><i class="fa-solid fa-box-open"></i> No saved configurations yet</div>';
            lists.forEach(l => l.innerHTML = empty);
            return;
        }
        allInlineConfigs = data.configs;
        if (!lists.length) return;
        const html = data.configs.map(c => {
            const date = new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

            let scoreCount = 0, speakerCount = 0, feedbackCount = 0, infoCount = 0;
            if (c.config && c.config.sheets) {
                const firstSheet = c.config.sheets[Object.keys(c.config.sheets)[0]] ?? [];
                scoreCount    = firstSheet.filter(col => col.type === 'score' && col.category !== 'Resource Speaker').length;
                speakerCount  = firstSheet.filter(col => col.category === 'Resource Speaker').length;
                feedbackCount = firstSheet.filter(col => col.type === 'feedback').length;
                infoCount     = firstSheet.filter(col => col.type === 'info').length;
            }

            const summaryParts = [];
            if (scoreCount)    summaryParts.push(`<span style="color:#1D4ED8">📊 ${scoreCount} score</span>`);
            if (speakerCount)  summaryParts.push(`<span style="color:#B45309">🎤 ${speakerCount} speaker cols</span>`);
            if (feedbackCount) summaryParts.push(`<span style="color:#6D28D9">💬 ${feedbackCount} feedback</span>`);
            if (infoCount)     summaryParts.push(`<span style="color:#64748B">ℹ️ ${infoCount} info</span>`);
            const summaryHtml = summaryParts.join(' · ') || '<span style="color:#94A3B8">No column data</span>';

            return `<div class="saved-config-card" onclick="applySavedConfig(${c.id})">
                <div class="saved-config-info">
                    <div class="saved-config-name"><i class="fa-solid fa-bookmark" style="color:#3B82F6;margin-right:6px"></i>${escapeHtml(c.name)}</div>
                    <div class="saved-config-meta">${c.sheet_count} sheet(s) · ${c.column_count} columns · ${date}</div>
                    <div class="saved-config-meta" style="margin-top:3px">${summaryHtml}</div>
                    ${c.description ? `<div class="saved-config-desc">${escapeHtml(c.description)}</div>` : ''}
                </div>
                <div class="saved-config-actions">
                    <button class="saved-config-btn apply" onclick="event.stopPropagation();applySavedConfig(${c.id})" title="Apply this config">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button class="saved-config-btn delete" onclick="event.stopPropagation();deleteSavedConfig(${c.id},'${escapeHtml(c.name).replace(/'/g, "\\'")}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
        lists.forEach(l => l.innerHTML = html);
    } catch (e) {
        allInlineConfigs = [];
        const err = '<div class="saved-configs-empty" style="color:#EF4444"><i class="fa-solid fa-circle-exclamation"></i> Failed to load configs</div>';
        lists.forEach(l => l.innerHTML = err);
    }
}

async function applySavedConfig(id) {
    try {
        showToast('⏳ Loading configuration…', 'info');
        const res = await fetch(CONFIG.API_URL + '/column_configs.php?id=' + id);
        const data = await res.json();
        if (!data.success || !data.config || !data.config.config || !data.config.config.sheets) {
            showToast('Invalid config data', 'err'); return;
        }
        const cfg = data.config.config;

        if (!selectedFile) {
            pendingConfig = cfg.sheets;

            if (cfg.respondent_info_cols) {
                const ri = cfg.respondent_info_cols;
                if (ri.fullname)          document.getElementById('ri_name').value  = ri.fullname;
                if (ri.email)             document.getElementById('ri_email').value  = ri.email;
                if (ri.sex)               document.getElementById('ri_sex').value    = ri.sex;
                if (ri.participant_type)  document.getElementById('ri_type').value   = ri.participant_type;
                if (ri.designation)       document.getElementById('ri_desig').value  = ri.designation;
                if (ri.school)            document.getElementById('ri_school').value = ri.school;
            }

            document.getElementById('heroSub').innerHTML =
                `Config <strong style="color:#93C5FD">${escapeHtml(data.config.name)}</strong> staged — 
                 <strong>now import your Excel file</strong> and columns will be auto-mapped.`;

            showToast('✓ Config staged — import your file now', 'info');
            return;
        }

        applyConfigToSheets(cfg.sheets, sheetsData);

        if (cfg.respondent_info_cols) {
            const ri = cfg.respondent_info_cols;
            if (ri.fullname)          document.getElementById('ri_name').value  = ri.fullname;
            if (ri.email)             document.getElementById('ri_email').value  = ri.email;
            if (ri.sex)               document.getElementById('ri_sex').value    = ri.sex;
            if (ri.participant_type)  document.getElementById('ri_type').value   = ri.participant_type;
            if (ri.designation)       document.getElementById('ri_desig').value  = ri.designation;
            if (ri.school)            document.getElementById('ri_school').value = ri.school;
        }

        document.getElementById('heroSub').innerHTML =
            `Config <strong style="color:#93C5FD">${escapeHtml(data.config.name)}</strong> applied to current file.`;

        closeEP();
        renderCatLegend();
        renderAll();
        renderSheetTabs();
        setStep(2);
        updateComputeBtn();
        showToast('✓ Configuration "' + data.config.name + '" applied', 'ok');

    } catch (e) {
        showToast('Failed to load config: ' + e.message, 'err');
    }
}

function applyConfigToSheets(savedSheets, liveSheets) {
    Object.keys(liveSheets).forEach(sheetName => {

        // Prefer exact sheet name match, then fuzzy, then first sheet
        const savedKey = savedSheets[sheetName]
            ? sheetName
            : Object.keys(savedSheets).find(k =>
                k.toLowerCase().trim() === sheetName.toLowerCase().trim()
              )
            ?? Object.keys(savedSheets).find(k =>
                k.toLowerCase().includes(sheetName.toLowerCase()) ||
                sheetName.toLowerCase().includes(k.toLowerCase())
              )
            ?? Object.keys(savedSheets)[0];

        const savedCols = savedSheets[savedKey] ?? [];

        // Pre-build a normalized name map for faster lookup
        const savedByNormalizedName = new Map();
        const savedByLetter = new Map();

        savedCols.forEach(col => {
            const letter = String(col.letter || '').trim().toUpperCase();
            if (letter && !savedByLetter.has(letter)) {
                savedByLetter.set(letter, col);
            }

            const norm = normalizeColumnHeaderForMatch(col.name);
            if (norm && !savedByNormalizedName.has(norm)) {
                savedByNormalizedName.set(norm, col);
            }
        });

        liveSheets[sheetName].forEach(liveCol => {
            const liveNorm   = normalizeColumnHeaderForMatch(liveCol.name);
            const liveLetter = String(liveCol.letter || '').trim().toUpperCase();

            // Priority: normalized name > letter
            // Name match is more reliable than letter when columns shift.
            // Letter-only fallback is only trusted when the saved column's
            // normalized name is also similar to the live column's name —
            // a pure letter match with a completely different header means
            // the file has a different column at that position, so we leave
            // the live column's auto-detected type intact for the drift check.
            let match = (liveNorm && savedByNormalizedName.get(liveNorm)) ?? null;

            if (!match && liveLetter) {
                const letterMatch = savedByLetter.get(liveLetter);
                if (letterMatch) {
                    const savedNorm = normalizeColumnHeaderForMatch(letterMatch.name);
                    // Accept the letter match only when at least one word overlaps
                    // between the live and saved header names.
                    const liveWords  = new Set((liveNorm  || '').split(' ').filter(Boolean));
                    const savedWords = (savedNorm || '').split(' ').filter(Boolean);
                    const hasWordOverlap = savedWords.some(w => w.length > 2 && liveWords.has(w));
                    if (hasWordOverlap) match = letterMatch;
                }
            }

            if (match && match.type) {
                liveCol.type     = match.type;
                liveCol.category = match.category ?? '';
            }
        });
    });
}

async function deleteSavedConfig(id, name) {
    if (!confirm('Delete configuration "' + name + '"? This cannot be undone.')) return;
    try {
        const res = await fetch(CONFIG.API_URL + '/column_configs.php?id=' + id, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('🗑 Configuration deleted', 'ok');
            loadSavedConfigs();
        } else { showToast(data.message || 'Delete failed', 'err'); }
    } catch (e) { showToast('Delete failed: ' + e.message, 'err'); }
}

function openSaveConfigModal() {
    if (!Object.keys(sheetsData).length) {
        showToast('Upload a file or apply a config first', 'err');
        return;
    }
    document.getElementById('cfgName').value = document.getElementById('fileNameLabel').textContent || '';
    document.getElementById('cfgDesc').value = '';
    document.getElementById('cfgSaveStatus').hidden = true;
    document.getElementById('saveConfigModal').classList.add('modal--open');
    document.getElementById('cfgName').focus();
}

function closeSaveConfigModal() {
    document.getElementById('saveConfigModal').classList.remove('modal--open');
}

async function submitSaveConfig(e) {
    e.preventDefault();
    const btn = document.getElementById('cfgSaveBtn');
    const status = document.getElementById('cfgSaveStatus');
    const name = document.getElementById('cfgName').value.trim();
    if (!name) { showToast('Please enter a name', 'err'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    status.hidden = true;

    const config = {
        exported_at: new Date().toISOString(),
        file: document.getElementById('fileNameLabel').textContent || '',
        sheets: Object.keys(sheetsData).reduce((acc, s) => {
            acc[s] = sheetsData[s].map(c => ({ letter: c.letter, name: c.name, type: c.type, category: c.category }));
            return acc;
        }, {}),
        respondent_info_cols: {
            fullname: document.getElementById('ri_name').value.trim().toUpperCase() || 'J',
            email: document.getElementById('ri_email').value.trim().toUpperCase() || 'L',
            sex: document.getElementById('ri_sex').value.trim().toUpperCase() || 'H',
            participant_type: document.getElementById('ri_type').value.trim().toUpperCase() || 'I',
            designation: document.getElementById('ri_desig').value.trim().toUpperCase() || 'K',
            school: document.getElementById('ri_school').value.trim().toUpperCase() || 'M'
        }
    };

    try {
        const res = await fetch(CONFIG.API_URL + '/column_configs.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, description: document.getElementById('cfgDesc').value.trim(), config: config })
        });
        const data = await res.json();
        if (data.success) {
            status.className = 'save-status save-status--ok';
            status.innerHTML = '<strong>✓ Saved!</strong> Config ID #' + data.id;
            status.hidden = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
            showToast('✓ Configuration "' + name + '" saved', 'ok');
            loadSavedConfigs();
            loadInlineConfigs();
            setTimeout(() => closeSaveConfigModal(), 1200);
        } else { throw new Error(data.message || 'Unknown error'); }
    } catch (err) {
        status.className = 'save-status save-status--err';
        status.innerHTML = '<strong>Error:</strong> ' + escapeHtml(err.message);
        status.hidden = false;
        btn.innerHTML = '<i class="fa-solid fa-bookmark"></i> Save Config';
        btn.disabled = false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function colToLetter(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
function letterToCol(str) { str = str.trim().toUpperCase().replace(/[^A-Z]/g, ''); if (!str) return NaN; let n = 0; for (let i = 0; i < str.length; i++) n = n * 26 + (str.charCodeAt(i) - 64); return n; }
const getResultClass = r => ({ 'Outstanding': 'result-outstanding', 'Very Satisfactory': 'result-very-satisfactory', 'Satisfactory': 'result-satisfactory', 'Fair': 'result-fair', 'Needs Improvement': 'result-needs-improvement' }[r] || '');
function showError(msg) { const el = document.getElementById('errorMsg'); el.textContent = msg; el.classList.remove('hidden'); }
function hideError() { const el = document.getElementById('errorMsg'); el.classList.add('hidden'); el.textContent = ''; }
function truncate(str, max) { return str && str.length > max ? str.substring(0, max) + '…' : str || ''; }
// Faster escapeHtml replacement
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

let toastT;
function showToast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 3200);
}


// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════════
async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res = await fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' });
        if (!res.ok) {
            clearSessionAndRedirect();
            return false;
        }

        const json = await res.json();
        if (!json.success || !json.data?.id) {
            clearSessionAndRedirect();
            return false;
        }

        if (json.data.id) {
            localStorage.setItem('user_id', String(json.data.id));
        }
        if (json.data.full_name) {
            fullName = json.data.full_name;
            localStorage.setItem('full_name', json.data.full_name);
        }
        if (json.data.email) {
            email = json.data.email;
            localStorage.setItem('email', json.data.email);
        }
        if (json.data.role) {
            localStorage.setItem('role', json.data.role);
        }
        if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
        if (Array.isArray(json.data.permissions)) {
            localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('programs')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);

        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }

        if (json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
            }
        } else {
            loadProfilePicture();
        }

        return true;
    } catch (e) {
        console.warn('Session validation network error:', e);

        if (!cachedUserId) {
            clearSessionAndRedirect();
            return false;
        }

        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('programs')) return false;
            Permissions.applyNavPermissions();
        }

        loadUserInfo(fullName, email);
        loadProfilePicture();
        return true;
    }
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    document.getElementById('sidebarAvatar').textContent = initial;
    document.getElementById('sidebarUserName').textContent = fullName || 'User';
    document.getElementById('sidebarUserEmail').textContent = email || '';
}

async function loadProfilePicture() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            avatar.innerHTML = `<img src="${json.data.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        }
    } catch (e) { /* silently fail */ }
}

async function logout() {
    try {
        await fetch(`${CONFIG.API_URL}/logout.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
    } catch (e) { /* ignore errors */ }
    finally {
        ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
        window.location.href = 'login.html';
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ── CHANGE 4: loadCategoriesFromDB() called FIRST before anything else ──
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    if (!(await checkAuthentication())) return;

    // Load categories from DB FIRST — dropdowns and drift check depend on this
    await loadCategoriesFromDB();

    // Initialize column mapper
    init();
    renderExcludedKeywords();
    renderScaleCandidates();
    renderSkipSheets();
    loadRulesFromStorage();
    
    await Promise.all([
        loadSettingsFromDB(),
        loadSavedConfigs(),
    ]);
    
    updateComputeBtn();

    // Wire up drag & drop on the upload zone
    const dropZone = document.getElementById('uploadZone');
    if (dropZone) {
        ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.add('drag-over');
        }));
        ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.remove('drag-over');
        }));
        dropZone.addEventListener('drop', e => {
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (!['xlsx', 'xls', 'csv'].includes(ext)) {
                showToast('Unsupported file type — use .xlsx, .xls, or .csv', 'err');
                return;
            }
            const input = document.getElementById('fileInput');
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change'));
        });
    }

    // Wire up find/replace UI
    const addRuleBtn = document.getElementById('addRuleBtn');
    const findInput = document.getElementById('findInput');
    const replaceInput = document.getElementById('replaceInput');
    addRuleBtn.addEventListener('click', () => { addRule(findInput.value, replaceInput.value); findInput.value = ''; replaceInput.value = ''; findInput.focus(); });
    replaceInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRuleBtn.click(); } });
    findInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceInput.focus(); } });
    document.getElementById('presetAgree').addEventListener('click', () => { addRule('Strongly Agree', '4'); addRule('Agree', '3'); addRule('Disagree', '2'); addRule('Strongly Disagree', '1'); });
    document.getElementById('presetSatisfied').addEventListener('click', () => { addRule('Very Satisfied', '4'); addRule('Somewhat Satisfied', '3'); addRule('Somewhat Dissatisfied', '2'); addRule('Dissatisfied', '1'); addRule('Very Dissatisfied', '1'); });
    document.getElementById('presetFrequency').addEventListener('click', () => { addRule('Always', '5'); addRule('Often', '4'); addRule('Sometimes', '3'); addRule('Rarely', '2'); addRule('Never', '1'); });
    document.getElementById('presetLikert').addEventListener('click', () => { addRule('Strongly Agree', '5'); addRule('Agree', '4'); addRule('Neutral', '3'); addRule('Disagree', '2'); addRule('Strongly Disagree', '1'); });
    document.getElementById('clearRules').addEventListener('click', () => { findReplaceRules = []; renderRules(); saveRulesToStorage(); });

    const epCat = document.getElementById('epCat');
    if (epCat) {
        epCat.addEventListener('change', handleCategoryDropdownChange);
    }

    // Wire up compute button
    document.getElementById('computeBtn').addEventListener('click', doCompute);

    // Wire up search & export
    document.getElementById('searchInput').addEventListener('input', searchResults);
    document.getElementById('exportBtn').addEventListener('click', exportCSV);

    // Wire up save modal
    document.getElementById('saveBtn').addEventListener('click', openSaveModal);
    document.getElementById('saveModalClose').addEventListener('click', closeModal);
    document.getElementById('saveModalClose2').addEventListener('click', closeModal);
    document.getElementById('saveModal').addEventListener('click', e => { if (e.target.id === 'saveModal') closeModal(); });
    document.getElementById('saveForm').addEventListener('submit', submitSave);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSaveConfigModal(); } });
    document.getElementById('saveConfigModal').addEventListener('click', e => { if (e.target.id === 'saveConfigModal') closeSaveConfigModal(); });

    // Sequence number: real-time format validation + live duplicate check
    const seqInput = document.getElementById('meta_sequence_number');
    if (seqInput) {
        const seqHint = document.createElement('small');
        seqHint.id = 'seqHint';
        seqHint.style.cssText = 'display:block;margin-top:4px;font-size:11.5px;';
        seqInput.parentNode.appendChild(seqHint);

        const SN_PATTERN = /^SDOCB-SMME-\d{4}-\d{3,}$/;
        let seqDebounce = null;

        seqInput.addEventListener('input', () => {
            clearTimeout(seqDebounce);
            const val = seqInput.value.trim();

            if (!val) {
                seqHint.textContent = '';
                seqInput.style.borderColor = '';
                return;
            }

            if (!SN_PATTERN.test(val)) {
                seqHint.style.color = '#dc2626';
                seqHint.textContent = '⚠ Format must be SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)';
                seqInput.style.borderColor = '#dc2626';
                return;
            }

            seqHint.style.color = '#6b7280';
            seqHint.textContent = 'Checking...';
            seqInput.style.borderColor = '';

            seqDebounce = setTimeout(async () => {
                try {
                    const r = await fetch(
                        CONFIG.API_URL + '/records_api.php?action=check_sequence&sn=' + encodeURIComponent(val),
                        { credentials: 'include' }
                    );
                    const j = await r.json();
                    if (j.duplicate) {
                        seqHint.style.color = '#dc2626';
                        seqHint.textContent = `⚠ Already used by "${j.title}" (ID #${j.id}). Choose a different number.`;
                        seqInput.style.borderColor = '#dc2626';
                    } else {
                        seqHint.style.color = '#16a34a';
                        seqHint.textContent = '✓ Available';
                        seqInput.style.borderColor = '#16a34a';
                    }
                } catch (_) {
                    seqHint.textContent = '';
                }
            }, 500);
        });
    }
});

// ─── Back-button / bfcache guard ─────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${CONFIG.API_URL}/main-settings.php`, { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('login.html'); })
            .catch(() => {});
    }
});
