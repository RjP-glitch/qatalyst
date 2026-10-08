// PART 1 OF 5 — Config, State, Init, Navigation, Programs Display
// Sections: 1-7 (constants, state, init, nav, delegation, categories, load/display)

// ═══════════════════════════════════════════════════════════════════════════
//  programs.js  —  Refactored
//
//  Changes from original:
//  1. All mutable globals consolidated into a single `State` object.
//  2. generateQAMEReport() split into fetchReportData() + buildReportHTML()
//     + renderReport() — each with a single responsibility.
//  3. Hardcoded "AI summary" text removed; the section now uses real
//     participant feedback parsed from the DB response.
//  4. exportReportToWord() now mirrors the full HTML preview (all indicator
//     tables, speaker sections, feedback, signatories).
//  5. Event delegation replaces inline onclick for program/record rows.
//  6. ratingScalesCache gains a TTL (5 minutes) so stale scales are
//     re-fetched automatically.
// ═══════════════════════════════════════════════════════════════════════════

// const { HorizontalPositionAlign } = require("docx");

const API_URL = CONFIG.API_URL;

// Identifies which page/section this instance is running on.
// Each HTML page sets window.PAGE_KEY before loading this script.
const PAGE_KEY = window.PAGE_KEY || 'qatame';

let expandedMenus = {};



// ─── REPORT SIGNATORIES CONFIG ─────────────────────────────────────────────
// Loaded dynamically from the DB via programs.php?signatories on page load.
// Falls back to hardcoded values if the fetch fails, so exports still work.
const _SIGNATORIES_FALLBACK = {
	preparedBy: {
		name: 'TIFFANY JOY P. GONZALES',
		title: 'EPS II-SMME'
	},
	checkedBy: {
		name: 'CECILLE E. CRUZ',
		title: 'SEPS-SMME'
	},
	noted: [
		{ name: 'MA. AUREA RHODORA DC. GERONIMO, PhD', title: 'Chief Education Supervisor-SGOD' },
		{ name: 'ERWIN JOHN F. SANTOS, CESE', title: 'Assistant Schools Division Superintendent' },
		{ name: 'ROWENA T. QUIAMBAO, CESO VI', title: 'Schools Division Superintendent' }
	]
};

/**
 * Always returns a valid SIGNATORIES object.
 * Uses the live DB value once loadSignatories() has resolved,
 * otherwise returns the hardcoded fallback.
 */
function SIGNATORIES() {
	return State.signatories || _SIGNATORIES_FALLBACK;
}

/**
 * Fetches the active signatory row from the DB and caches it in State.
 * Called once on DOMContentLoaded; silently falls back on error.
 */
async function loadSignatories() {
	try {
		const res = await fetch(`${API_URL}/programs.php?signatories`, { credentials: 'include' });
		const json = await res.json();
		if (json.success && json.data) {
			State.signatories = json.data;
		}
	} catch (_) {
		// Network/parse error — fallback stays in effect
	}
}

// ─── FEEDBACK COLUMN CONFIG ────────────────────────────────────────────────
// Single source of truth for participant feedback column labels.
// Used by buildReportHTML, exportReportToWord, exportReportToPPT, and the
// Excel-export view. Update here when the evaluation form changes.
const FEEDBACK_COLUMN_DEFAULTS = {
	expectations: 'Were your expectations of the event met?',
	improvements: 'How can the sessions, venue/platform be improved, if any',
	insights:     'What are your significant insights during the activity?',
	further:      'Would you be interested in additional/further training? If Yes, what topic/s?',
};

// ─── 1. CENTRALISED STATE ──────────────────────────────────────────────────
/**
 * Single source of truth for all runtime state.
 * Replaces 14+ scattered module-level variables.
 */
const State = {
	// programs list
	allPrograms: [],

	// list view controls: search / date filter / sort / pagination
	searchQuery: '',
	dateFrom: null,        // 'YYYY-MM-DD' or null
	dateTo: null,          // 'YYYY-MM-DD' or null
	sortOrder: 'newest',   // 'newest' | 'oldest'
	currentPage: 1,
	pageSize: 12,

	// modal editing
	editingId: null,
	dayCounter: 0,
	speakerCounter: 0,

	// view modal
	viewingId: null,
	containerWorkshopId: null,  // original workshop ID when viewing a container program
	workshopData: null,
	isRecord: false,

	// responses
	responses: [],
	filteredResponses: [],
	responseQuestionMap: {},

	// monitoring
	monitoringData: null,

	// original days snapshot (used to detect changes on edit)
	originalDays: null,

	// records (excel imports)
	allRecords: [],

	// rating scales cache with TTL
	_ratingScales: null,
	_ratingScalesTTL: 0,

	// signatories: loaded from DB on init, null until resolved
	signatories: null,

	// layout: 'card' | 'table'
	layout: localStorage.getItem('programsLayout') || 'card',

	reset() {
		this.viewingId = null;
		this.containerWorkshopId = null;
		this.workshopData = null;
		this.isRecord = false;
		this.responses = [];
		this.filteredResponses = [];
		this.responseQuestionMap = {};
		this.monitoringData = null;
	}
};

// ─── 3. INIT ───────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
	checkAuthentication();
	loadSignatories();
	document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);

	// ── Sequence number: real-time format + duplicate validation (Edit modal) ──
	const erSeqInput = document.getElementById('erSequenceNumber');
	if (erSeqInput) {
		const seqHint = document.createElement('small');
		seqHint.id = 'erSeqHint';
		seqHint.style.cssText = 'display:block;margin-top:4px;font-size:11.5px;';
		erSeqInput.parentNode.appendChild(seqHint);

		const SN_PATTERN = /^SDOCB-SMME-\d{4}-\d{3,}$/;
		let debounce = null;

		erSeqInput.addEventListener('input', () => {
			clearTimeout(debounce);
			const val = erSeqInput.value.trim();
			const currentId = parseInt(document.getElementById('erRecordId')?.value) || 0;

			if (!val) {
				seqHint.textContent = '';
				erSeqInput.style.borderColor = '';
				return;
			}
			if (!SN_PATTERN.test(val)) {
				seqHint.style.color = '#dc2626';
				seqHint.textContent = '⚠ Format must be SDOCB-SMME-YYYY-NNN (e.g. SDOCB-SMME-2026-047)';
				erSeqInput.style.borderColor = '#dc2626';
				return;
			}

			seqHint.style.color = '#6b7280';
			seqHint.textContent = 'Checking...';
			erSeqInput.style.borderColor = '';

			debounce = setTimeout(async () => {
				try {
					const r = await fetch(
						`${API_URL}/records_api.php?action=check_sequence&sn=${encodeURIComponent(val)}&exclude_id=${currentId}`,
						{ credentials: 'include' }
					);
					const j = await r.json();
					if (j.duplicate) {
						seqHint.style.color = '#dc2626';
						seqHint.textContent = `⚠ Already used by "${j.title}" (ID #${j.id}). Choose a different number.`;
						erSeqInput.style.borderColor = '#dc2626';
					} else {
						seqHint.style.color = '#16a34a';
						seqHint.textContent = '✓ Available';
						erSeqInput.style.borderColor = '#16a34a';
					}
				} catch (_) { seqHint.textContent = ''; }
			}, 500);
		});
	}
});

async function checkAuthentication() {
	// SECURITY: Verify session with server instead of trusting localStorage
	try {
		const res = await fetch(`${API_URL}/main-settings.php`, {
			credentials: 'include'
		});

		if (!res.ok) {
			// Session invalid - clear localStorage and redirect
			clearLocalStorage();
			window.location.href = 'login.html';
			return;
		}

		const json = await res.json();
		if (!json.success || !json.data?.id) {
			clearLocalStorage();
			window.location.href = 'login.html';
			return;
		}

		// Use server-verified identity
		const userData = json.data;
		loadUserInfo(userData.full_name, userData.email);

		// Block school portal users from accessing SDO dashboard
		if (userData.account_type === 'portal_user') {
			window.location.href = 'school-portal-dashboard.html';
			return;
		}
		if (userData.account_type) localStorage.setItem('account_type', userData.account_type);

		// Display profile picture if available
		if (userData.profile_picture) {
			document.getElementById('sidebarAvatar').innerHTML =
				`<img src="${userData.profile_picture}"
				      style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
				      alt="Profile">`;
		}

		if (typeof Permissions !== 'undefined') {
			if (!Permissions.check('programs')) return;
			Permissions.applyNavPermissions();
		}

		loadPrograms().then(() => checkNotificationDeepLink());
		loadDropdownOptions();
		attachTableDelegation();
		setLayout(State.layout);

	} catch (err) {
		console.error('Auth verification failed:', err);

		const cachedUserId = localStorage.getItem('user_id');
		if (!cachedUserId) {
			clearLocalStorage();
			window.location.href = 'login.html';
			return;
		}

		if (typeof Permissions !== 'undefined') {
			if (!Permissions.check('programs')) return;
			Permissions.applyNavPermissions();
		}

		loadUserInfo(localStorage.getItem('full_name'), localStorage.getItem('email'));
		loadProfilePicture();
		loadPrograms().then(() => checkNotificationDeepLink());
		loadDropdownOptions();
		attachTableDelegation();
		setLayout(State.layout);
	}
}

function clearLocalStorage() {
	['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type'].forEach(k => localStorage.removeItem(k));
}

function loadUserInfo(fullName, email) {
	const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
	const avatar = document.getElementById('sidebarAvatar');
	if (avatar && !avatar.querySelector('img')) avatar.textContent = initial;
	const nameEl = document.getElementById('sidebarUserName');
	const emailEl = document.getElementById('sidebarUserEmail');
	if (nameEl) nameEl.textContent = fullName || 'User';
	if (emailEl) emailEl.textContent = email || '';
}

async function loadProfilePicture() {
	try {
		const res = await fetch(`${API_URL}/main-settings.php`, {
			credentials: 'include'
		});
		const json = await res.json();
		if (json.success && json.data.profile_picture) {
			document.getElementById('sidebarAvatar').innerHTML =
				`<img src="${json.data.profile_picture}"
              style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
              alt="Profile">`;
		}
	} catch (_) { /* keep initial letter */ }
}

// ─── 4. NAVIGATION ─────────────────────────────────────────────────────────
function toggleSubmenu(name) {
	expandedMenus[name] = !expandedMenus[name];
	const sub = document.getElementById(name + '-submenu');
	const arrow = document.getElementById(name + '-arrow');
	if (sub) sub.classList.toggle('expanded', expandedMenus[name]);
	if (arrow) arrow.classList.toggle('rotate', expandedMenus[name]);
}
function toggleMobileSidebar() {
	document.querySelector('.sidebar')?.classList.toggle('mobile-open');
	document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}
function closeMobileSidebar() {
	document.querySelector('.sidebar')?.classList.remove('mobile-open');
	document.getElementById('sidebarBackdrop')?.classList.remove('open');
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
		importfile: `import-excell.html?page=${encodeURIComponent(PAGE_KEY || 'qatame')}`,
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

// ─── 5. EVENT DELEGATION (replaces inline onclick in table rows) ────────────
/**
 * All program-row and record-row actions bubble up to their parent <tbody>.
 * This eliminates escapeAttr() inside onclick strings (fix #5).
 */
function attachTableDelegation() {
	// Navigation menu delegation (replaces inline onclick)
	const navMenu = document.querySelector('.nav-menu');
	if (navMenu) {
		navMenu.addEventListener('click', e => {
			const navBtn = e.target.closest('[data-nav]');
			if (navBtn) {
				navigate(navBtn.dataset.nav);
				return;
			}
			const submenuBtn = e.target.closest('[data-submenu]');
			if (submenuBtn) {
				toggleSubmenu(submenuBtn.dataset.submenu);
			}
		});
	}

	// Programs table (unified — handles both system and excel-source rows)
	// Also delegates from card grid — both use the same data-action pattern
	[document.getElementById('programsTableBody'), document.getElementById('programCardGrid')]
		.filter(Boolean).forEach(container => {
			container.addEventListener('click', e => {
				const btn = e.target.closest('[data-action]');
				if (!btn) return;
				const id = parseInt(btn.dataset.id);
				const title = btn.dataset.title || '';
				const src = btn.dataset.source || '';
				const evalId = parseInt(btn.dataset.evalId) || null;
				const isExcel = src === 'excel';
				switch (btn.dataset.action) {
					case 'view':
						// Routing logic:
						// - Non-Excel rows (system/container): always viewProgram
						// - Standalone Excel (evalId === rowId, no separate workshop): viewRecord
						// - Container-linked Excel (evalId !== rowId): viewProgram with the container's rowId
						if (!isExcel) {
							viewProgram(id);
						} else if (evalId && evalId === id) {
							// Standalone excel import — its own record IS the program
							viewRecord(evalId);
						} else {
							// Linked import — id is the container workshop ID
							viewProgram(id);
						}
						break;
					case 'dashboard':
						if (isExcel) {
							window.location.href = `workshop-dashboard.html?program_id=${evalId || id}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
						} else {
							viewInDashboard(id);
						}
						break;
					case 'edit': editProgram(id); break;
					case 'edit-record': openEditRecordModal(id, title); break;
					case 'delete':
						isExcel && evalId && evalId === id
							? deleteRecord(id, title)
							: deleteProgram(id, title);
						break;
				}
			});
		});
}

// ─── 6. CATEGORIES ─────────────────────────────────────────────────────────
// ── DROPDOWN OPTIONS ───────────────────────────────────────────────────────
/**
 * Fetches unit and nature_of_event options from the DB and populates
 * the two <select> elements in the Add/Edit Program modal.
 */
async function loadDropdownOptions() {
	try {
		const res = await fetch(`${API_URL}/programs.php?dropdown_options=1`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (!result.success) {
			console.warn('Could not load dropdown options:', result.message);
			// Fallback so selects are never left on "Loading…"
			populateSelect('programUnit', ['SGOD', 'CID', 'OSDS'], 'SGOD');
			populateSelect('programNatureOfEvent', ['Training', 'Seminar', 'Workshop', 'Conference'], 'Training');
			return;
		}

		const { unit = [], nature_of_event = [] } = result.data;

		populateSelect('programUnit', unit, 'SGOD');
		populateSelect('programNatureOfEvent', nature_of_event, 'Training');

	} catch (e) {
		console.warn('Could not load dropdown options:', e);
		// Fallback so selects are never left on "Loading…"
		populateSelect('programUnit', ['SGOD', 'CID', 'OSDS'], 'SGOD');
		populateSelect('programNatureOfEvent', ['Training', 'Seminar', 'Workshop', 'Conference'], 'Training');
	}
}

const DROPDOWN_SELECT_TYPE_MAP = {
	programUnit: 'unit',
	erUnit: 'unit',
	programNatureOfEvent: 'nature_of_event',
	erNatureOfEvent: 'nature_of_event'
};

function getDropdownTypeForSelect(selectId) {
	return DROPDOWN_SELECT_TYPE_MAP[selectId] || null;
}

function getDropdownDefaultForType(type) {
	if (type === 'unit') return 'SGOD';
	if (type === 'nature_of_event') return 'Training';
	return '';
}

async function requestManageOption(method, body = null, query = '') {
	const url = `${API_URL}/programs.php?manage_options=1${query ? `&${query}` : ''}`;
	const init = {
		method,
		credentials: 'include'
	};

	if (body !== null) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(body);
	}

	const res = await fetch(url, init);
	const data = await res.json();
	if (!res.ok || !data.success) {
		throw new Error(data.message || `Request failed (${res.status})`);
	}
	return data;
}

async function addOrGetDropdownOption(type, label) {
	const data = await requestManageOption('POST', {
		type,
		label,
		display_order: 0
	});
	return {
		id: parseInt(data.id, 10) || null,
		label: String(data.label || label || '').trim(),
		existing: Boolean(data.existing)
	};
}

async function refreshDropdownSelectsByType(type, preferredValues = {}) {
	const res = await fetch(`${API_URL}/programs.php?dropdown_options=1&type=${encodeURIComponent(type)}`, {
		credentials: 'include'
	});
	const data = await res.json();
	if (!res.ok || !data.success) {
		throw new Error(data.message || 'Failed to refresh dropdown options');
	}

	const options = (data.data && Array.isArray(data.data[type])) ? data.data[type] : [];
	const normalizeLabel = o => String(o?.label ?? o?.value ?? o?.name ?? '').trim();
	const availableLabels = new Set(
		options
			.map(normalizeLabel)
			.filter(Boolean)
			.map(v => v.toLowerCase())
	);
	const firstAvailable = options.map(normalizeLabel).find(Boolean) || '';
	const fallback = firstAvailable || getDropdownDefaultForType(type) || '';
	const selectedBySelectId = {};

	Object.keys(DROPDOWN_SELECT_TYPE_MAP).forEach(selectId => {
		if (DROPDOWN_SELECT_TYPE_MAP[selectId] !== type) return;
		const sel = document.getElementById(selectId);
		if (!sel) return;

		const explicitPreferred = String(preferredValues[selectId] ?? '').trim();
		const explicitPreferredExists = explicitPreferred && availableLabels.has(explicitPreferred.toLowerCase());
		const current = String((sel.value && sel.value !== '__add_custom__' ? sel.value : '') || '').trim();
		const currentStillExists = current && availableLabels.has(current.toLowerCase());

		const preserved = (explicitPreferredExists ? explicitPreferred : '') || (currentStillExists ? current : fallback);
		populateSelect(selectId, options, preserved);
		selectedBySelectId[selectId] = document.getElementById(selectId)?.value || '';
	});

	return selectedBySelectId;
}

async function renameSelectedDropdownOption(selectId) {
	const sel = document.getElementById(selectId);
	const type = getDropdownTypeForSelect(selectId);
	if (!sel || !type) return;

	const current = String(sel.value || '').trim();
	if (!current || current === '__add_custom__') {
		showAlert('error', 'Select a saved option to rename.');
		return;
	}

	const selectedOpt = sel.selectedOptions?.[0] || null;
	const optionId = parseInt(selectedOpt?.dataset.optionId || '0', 10);
	if (!optionId) {
		showAlert('error', 'Only database-saved options can be renamed.');
		return;
	}

	const fieldLabel = type === 'unit' ? 'Unit' : 'Nature of Event';
	const entered = prompt(`Rename ${fieldLabel}:`, current);
	const nextLabel = String(entered || '').trim();
	if (!nextLabel) return;
	if (nextLabel.toLowerCase() === current.toLowerCase()) return;

	try {
		await requestManageOption('PUT', {
			id: optionId,
			label: nextLabel,
			display_order: 0,
			is_active: 1
		});
		const preferred = {};
		preferred[selectId] = nextLabel;
		await refreshDropdownSelectsByType(type, preferred);
		showAlert('success', `${fieldLabel} option updated.`);
	} catch (e) {
		showAlert('error', e.message || 'Failed to rename option');
	}
}

async function deleteSelectedDropdownOption(selectId) {
	const sel = document.getElementById(selectId);
	const type = getDropdownTypeForSelect(selectId);
	if (!sel || !type) return;

	const current = String(sel.value || '').trim();
	if (!current || current === '__add_custom__') {
		showAlert('error', 'Select a saved option to delete.');
		return;
	}

	const selectedOpt = sel.selectedOptions?.[0] || null;
	const optionId = parseInt(selectedOpt?.dataset.optionId || '0', 10);
	if (!optionId) {
		showAlert('error', 'Only database-saved options can be deleted.');
		return;
	}

	const fieldLabel = type === 'unit' ? 'Unit' : 'Nature of Event';
	if (!confirm(`Delete ${fieldLabel} option "${current}"?`)) return;

	try {
		const deletedLabel = current;
		await requestManageOption('DELETE', null, `id=${optionId}`);
		const selectedAfterRefresh = await refreshDropdownSelectsByType(type);
		const nextSelected = String(selectedAfterRefresh?.[selectId] || '').trim();
		const msg = nextSelected && nextSelected !== '__add_custom__'
			? `${fieldLabel} deleted: ${deletedLabel}. Selected: ${nextSelected}`
			: `${fieldLabel} deleted: ${deletedLabel}`;
		showToast('success', msg);
	} catch (e) {
		showAlert('error', e.message || 'Failed to delete option');
	}
}

function populateSelect(selectId, options, defaultValue) {
	const sel = document.getElementById(selectId);
	if (!sel) return;

	const normalizeOption = o => {
		if (o === null || o === undefined) return null;
		if (typeof o === 'string') {
			const label = o.trim();
			return label ? { label, id: null } : null;
		}
		if (typeof o === 'object') {
			const label = String(o.label ?? o.value ?? o.name ?? '').trim();
			const id = parseInt(o.id, 10);
			if (!label) return null;
			return { label, id: Number.isFinite(id) && id > 0 ? id : null };
		}
		const label = String(o).trim();
		return label ? { label, id: null } : null;
	};

	const normalizedDefault = String(defaultValue ?? '').trim();
	const rawCurrent = normalizedDefault || (sel.value && sel.value !== '__add_custom__' ? sel.value : '');
	const current = String(rawCurrent || '').trim();

	const seen = new Map();
	const entries = [];
	(options || []).forEach(o => {
		const normalized = normalizeOption(o);
		if (!normalized) return;
		const key = normalized.label.toLowerCase();
		if (seen.has(key)) {
			const idx = seen.get(key);
			if (!entries[idx].id && normalized.id) entries[idx].id = normalized.id;
			return;
		}
		seen.set(key, entries.length);
		entries.push(normalized);
	});

	if (current) {
		const key = current.toLowerCase();
		if (!seen.has(key)) {
			entries.unshift({ label: current, id: null });
			seen.set(key, 0);
		}
	}

	sel.innerHTML = '';
	entries.forEach(entry => {
		const opt = document.createElement('option');
		opt.value = entry.label;
		opt.textContent = entry.label;
		if (entry.id) opt.dataset.optionId = String(entry.id);
		sel.appendChild(opt);
	});

	const allowsCustom = selectId === 'erUnit'
		|| selectId === 'erNatureOfEvent'
		|| selectId === 'programUnit'
		|| selectId === 'programNatureOfEvent';
	if (allowsCustom) {
		const addOpt = document.createElement('option');
		addOpt.value = '__add_custom__';
		addOpt.textContent = '+ Add new...';
		sel.appendChild(addOpt);

		if (sel.dataset.customAddBound !== '1') {
			sel.addEventListener('change', async () => {
				if (sel.value !== '__add_custom__') {
					sel.dataset.prevValue = sel.value;
					return;
				}

				const previous = sel.dataset.prevValue || '';
				const type = getDropdownTypeForSelect(selectId);
				const fieldLabel = type === 'unit' ? 'Unit' : 'Nature of Event';
				const entered = prompt(`Enter new ${fieldLabel}:`);
				const custom = String(entered || '').trim();

				if (!custom) {
					sel.value = previous || (sel.options[0]?.value || '');
					return;
				}

				const existing = Array.from(sel.options)
					.find(opt => opt.value !== '__add_custom__' && opt.value.toLowerCase() === custom.toLowerCase());

				if (existing) {
					sel.value = existing.value;
					sel.dataset.prevValue = existing.value;
					showToast('success', `${fieldLabel} selected: ${existing.value}`);
					return;
				}

				if (type) {
					try {
						const saved = await addOrGetDropdownOption(type, custom);
						const preferred = {};
						preferred[selectId] = saved.label || custom;
						const selectedAfterRefresh = await refreshDropdownSelectsByType(type, preferred);
						const updatedSel = document.getElementById(selectId);
						if (updatedSel) updatedSel.dataset.prevValue = updatedSel.value;
						const selectedNow = String(selectedAfterRefresh?.[selectId] || updatedSel?.value || saved.label || custom).trim();
						const action = saved.existing ? 'selected' : 'added';
						const msg = selectedNow
							? `${fieldLabel} ${action}: ${saved.label}. Selected: ${selectedNow}`
							: `${fieldLabel} ${action}: ${saved.label}`;
						showToast('success', msg);
						return;
					} catch (e) {
						showAlert('error', e.message || `Failed to save ${fieldLabel}`);
						sel.value = previous || (sel.options[0]?.value || '');
						return;
					}
				}

				const customOpt = document.createElement('option');
				customOpt.value = custom;
				customOpt.textContent = custom;
				sel.insertBefore(customOpt, sel.querySelector('option[value="__add_custom__"]'));
				sel.value = custom;
				sel.dataset.prevValue = custom;
			});

			sel.dataset.customAddBound = '1';
		}
	}

	const target = current || entries[0]?.label || '';
	const matched = Array.from(sel.options)
		.find(opt => opt.value !== '__add_custom__' && opt.value.toLowerCase() === target.toLowerCase());
	if (matched) sel.value = matched.value;

	if (allowsCustom) {
		sel.dataset.prevValue = sel.value;
	}
}

// ─── 7. LOAD / DISPLAY PROGRAMS ────────────────────────────────────────────
async function loadPrograms() {
	try {
		document.getElementById('loadingOverlay').classList.remove('hidden');
		const cacheBuster = Date.now();
		const res = await fetch(`${API_URL}/programs.php?page=${encodeURIComponent(PAGE_KEY)}&_=${cacheBuster}`, {
			credentials: 'include',
			cache: 'no-store'
		});
		const result = await res.json();
		if (result.success) { State.allPrograms = result.data; applyProgramsView({ resetPage: true }); }
		else showAlert('error', result.message || 'Failed to load programs');
	} catch (err) { console.error('loadPrograms:', err); showAlert('error', 'Failed to load programs'); }
	finally { document.getElementById('loadingOverlay').classList.add('hidden'); }
}

// ─── 7b. SEARCH / DATE FILTER / SORT / PAGINATION PIPELINE ─────────────────
/**
 * Returns the best available date for a program, used for both date-range
 * filtering and newest/oldest sorting. Prefers the program's own start_date
 * (the actual event date) and falls back to created_at for rows that have
 * no start_date (e.g. some standalone Excel imports).
 */
function getProgramSortDate(p) {
	const raw = p.start_date || p.created_at;
	if (!raw) return null;
	const t = Date.parse(raw);
	return Number.isNaN(t) ? null : t;
}

/**
 * Applies the current search text, date-range filter, and sort order to
 * State.allPrograms, then paginates the result and renders both the card
 * grid and the table body for whichever page is active.
 * Call with { resetPage: true } whenever the underlying filters change
 * (new search term, new date range, new sort order, fresh data load) so
 * the user doesn't get stranded on a page that no longer has data.
 */
function applyProgramsView(opts = {}) {
	if (opts.resetPage) State.currentPage = 1;

	const q = (State.searchQuery || '').toLowerCase();
	let list = (State.allPrograms || []).filter(p => {
		if (!q) return true;
		return (p.title || '').toLowerCase().includes(q) ||
			(p.division_memo || '').toLowerCase().includes(q) ||
			(p.venue || '').toLowerCase().includes(q) ||
			(p.proponents || '').toLowerCase().includes(q);
	});

	if (State.dateFrom || State.dateTo) {
		const fromT = State.dateFrom ? Date.parse(State.dateFrom) : -Infinity;
		// Add one day minus 1ms to "to" so the end date itself is inclusive
		const toT = State.dateTo ? Date.parse(State.dateTo) + (24 * 60 * 60 * 1000 - 1) : Infinity;
		list = list.filter(p => {
			const t = getProgramSortDate(p);
			if (t === null) return false; // exclude undated rows when a date filter is active
			return t >= fromT && t <= toT;
		});
	}

	list = [...list].sort((a, b) => {
		const ta = getProgramSortDate(a);
		const tb = getProgramSortDate(b);
		// Undated rows always sink to the bottom regardless of sort direction
		if (ta === null && tb === null) return 0;
		if (ta === null) return 1;
		if (tb === null) return -1;
		return State.sortOrder === 'oldest' ? ta - tb : tb - ta;
	});

	const totalItems = list.length;
	const totalPages = Math.max(1, Math.ceil(totalItems / State.pageSize));
	if (State.currentPage > totalPages) State.currentPage = totalPages;
	if (State.currentPage < 1) State.currentPage = 1;

	const start = (State.currentPage - 1) * State.pageSize;
	const pageItems = list.slice(start, start + State.pageSize);

	displayPrograms(pageItems);
	renderPagination(totalItems, totalPages, start);
}

function onDateFilterChange() {
	const from = document.getElementById('filterDateFrom').value || null;
	const to = document.getElementById('filterDateTo').value || null;
	State.dateFrom = from;
	State.dateTo = to;
	document.getElementById('clearDateFilterBtn').style.display = (from || to) ? 'inline-flex' : 'none';
	applyProgramsView({ resetPage: true });
}

function clearDateFilter() {
	document.getElementById('filterDateFrom').value = '';
	document.getElementById('filterDateTo').value = '';
	State.dateFrom = null;
	State.dateTo = null;
	document.getElementById('clearDateFilterBtn').style.display = 'none';
	applyProgramsView({ resetPage: true });
}

function toggleSortOrder() {
	State.sortOrder = State.sortOrder === 'newest' ? 'oldest' : 'newest';
	const icon = document.getElementById('sortToggleIcon');
	const label = document.getElementById('sortToggleLabel');
	if (State.sortOrder === 'oldest') {
		icon.className = 'fa-solid fa-arrow-up-wide-short';
		label.textContent = 'Oldest First';
	} else {
		icon.className = 'fa-solid fa-arrow-down-wide-short';
		label.textContent = 'Newest First';
	}
	applyProgramsView({ resetPage: true });
}

function goToPage(n) {
	State.currentPage = n;
	applyProgramsView();
	// Scroll the list back into view when paging, without jumping the whole page
	document.getElementById('pageSectionPrograms')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Renders "Showing X–Y of Z" text plus Prev / page-number / Next controls.
 * Uses a windowed page-number list (max 5 numbers + first/last + ellipses)
 * so it stays readable even with dozens of pages.
 */
function renderPagination(totalItems, totalPages, start) {
	const info = document.getElementById('paginationInfo');
	const controls = document.getElementById('paginationControls');
	if (!info || !controls) return;

	if (totalItems === 0) {
		info.textContent = '';
		controls.innerHTML = '';
		return;
	}

	const end = Math.min(start + State.pageSize, totalItems);
	info.textContent = `Showing ${start + 1}–${end} of ${totalItems} program${totalItems === 1 ? '' : 's'}`;

	const page = State.currentPage;
	let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})" title="Previous page">
		<i class="fa-solid fa-chevron-left"></i></button>`;

	const windowSize = 2; // pages shown on either side of the current page
	const pages = [];
	for (let i = 1; i <= totalPages; i++) {
		if (i === 1 || i === totalPages || (i >= page - windowSize && i <= page + windowSize)) {
			pages.push(i);
		}
	}

	let lastRendered = 0;
	pages.forEach(i => {
		if (lastRendered && i - lastRendered > 1) {
			html += `<span class="page-ellipsis">…</span>`;
		}
		html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
		lastRendered = i;
	});

	html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})" title="Next page">
		<i class="fa-solid fa-chevron-right"></i></button>`;

	controls.innerHTML = html;
}

function displayPrograms(programs) {
	const tbody = document.getElementById('programsTableBody');
	if (!programs.length) {
		displayProgramCards(programs);
		setLayout(State.layout);
		tbody.innerHTML = `<tr><td colspan="11" class="no-data">
      <div class="no-data-icon"><i class="fas fa-calendar-times"></i></div>
      <p>No programs found</p>
    </td></tr>`;
		return;
	}

	displayProgramCards(programs);
	setLayout(State.layout);
	tbody.innerHTML = programs.map(p => {
		const isExcel = p.source === 'excel';
		const evalId = p.eval_program_id || '';   // evaluation_programs.id (for standalone)
		// For standalone excel rows the row id IS the eval_program_id (no workshop)
		const rowId = p.id;

		const sourceBadge = isExcel
			? `<span class="badge-excel-import" title="Imported from Excel"><i class="fa-solid fa-file-excel"></i> Excel</span>`
			: p.program_type === 'container'
				? `<span class="badge-system-entry" title="Multi-day container program" style="background:#f0fdf4;color:#15803d;border-color:#86efac;"><i class="fa-solid fa-layer-group"></i> Container</span>`
				: `<span class="badge-system-entry" title="Legacy live-form program"><i class="fa-solid fa-desktop"></i> Live Form</span>`;

		// System-only buttons hidden for Excel rows; Excel rows get their own edit button.
		// For Excel rows: container-linked imports have eval_program_id = the import's records_api ID,
		// standalone imports have no eval_program_id so fall back to rowId (which IS the records_api ID).
		const tableEditRecordId = isExcel ? (evalId || rowId) : rowId;
		const systemBtns = isExcel
			? `<button class="btn-icon btn-edit" data-action="edit-record" data-id="${tableEditRecordId}" data-title="${escapeAttr(p.title)}" title="Edit Record"><i class="fas fa-edit"></i></button>`
			: `
      <button class="btn-icon btn-edit"      data-action="edit"      data-id="${rowId}"                                           title="Edit"><i class="fas fa-edit"></i></button>`;

		return `
<tr>
  <td><strong>${escapeHtml(p.title)}</strong></td>
  <td>${escapeHtml(p.division_memo || '—')}</td>
  <td>${p.proponents ? escapeHtml(p.proponents) : '<span style="color:#9ca3af;font-size:12px;">—</span>'}</td>
  <td>${p.start_date ? (isExcel ? escapeHtml(p.start_date) : formatDate(p.start_date) + (p.end_date ? ' – ' + formatDate(p.end_date) : '')) : '—'}</td>
  <td>${escapeHtml(p.venue || '—')}</td>
  <td>${p.days_count || 0}</td>
  <td>${p.responses_count || 0}</td>
  <td>${p.total_participants || '<span style="color:#9ca3af;font-size:12px;">—</span>'}</td>
  <td>${sourceBadge}</td>
  <td><span class="status-badge status-${p.status}">${p.status}</span></td>
  <td>
    <div class="action-buttons">
      <button class="btn-icon btn-view"      data-action="view"      data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}" title="View Details"><i class="fas fa-eye"></i></button>
      <button class="btn-icon btn-dashboard" data-action="dashboard" data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}" title="Dashboard"><i class="fas fa-chart-pie"></i></button>
      ${systemBtns}
      <button class="btn-icon btn-delete"    data-action="delete"    data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}" data-title="${escapeAttr(p.title)}" title="Delete"><i class="fas fa-trash"></i></button>
    </div>
  </td>
</tr>`;
	}).join('');
}

// ─── LAYOUT TOGGLE ────────────────────────────────────────────────────────
function setLayout(layout) {
	State.layout = layout;
	localStorage.setItem('programsLayout', layout);
	document.getElementById('layoutBtnCard').classList.toggle('active', layout === 'card');
	document.getElementById('layoutBtnTable').classList.toggle('active', layout === 'table');
	document.getElementById('programCardGrid').style.display = layout === 'card' ? 'grid' : 'none';
	document.getElementById('programTableContainer').style.display = layout === 'table' ? '' : 'none';
}

function displayProgramCards(programs) {
	const grid = document.getElementById('programCardGrid');
	if (!programs.length) {
		grid.innerHTML = `<div class="no-data-card">
			<div class="no-data-icon"><i class="fas fa-calendar-times"></i></div>
			<p>No programs found</p>
		</div>`;
		return;
	}

	grid.innerHTML = programs.map(p => {
		const isExcel = p.source === 'excel';
		const evalId = p.eval_program_id || '';
		const rowId = p.id;

		// ── Permission flags ──
		const role = (typeof Permissions !== 'undefined') ? Permissions.getRole() : (localStorage.getItem('role') || 'viewer');
		const isAdmin       = role === 'admin';
		const canEdit       = isAdmin || role === 'facilitator';
		const canDelete     = isAdmin;

		const statusLabels = { ongoing: '● Ongoing', completed: '✓ Completed', upcoming: '● Upcoming', cancelled: '✗ Cancelled' };
		const statusLabel = statusLabels[p.status] || p.status;
		const statusBadge = `<span class="status-badge status-${p.status}">${statusLabel}</span>`;

		const isContainerCard = p.program_type === 'container';
		const days = isContainerCard
			? (p.days_count || 0)
			: (p.days_count || p.total_days || 1);

		// Parse day_imports — PHP attaches this for both container and standalone Excel programs
		const _dayImports = (() => {
			if (Array.isArray(p.day_imports)) return p.day_imports.length > 0 ? p.day_imports : null;
			if (typeof p.day_imports === 'string') {
				try {
					const parsed = JSON.parse(p.day_imports);
					return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
				} catch (_) { return null; }
			}
			return null;
		})();

		const _totalPartic = parseInt(p.total_participants) || 0;

		// Show per-day breakdown for container programs AND multi-day standalone Excel imports
		const _sortedDayImports = _dayImports
			? [..._dayImports].sort((a, b) => {
				const an = parseInt(String(a.label || a.day_label || '').match(/\d+/)?.[0] || 999);
				const bn = parseInt(String(b.label || b.day_label || '').match(/\d+/)?.[0] || 999);
				return an - bn;
			})
			: null;
		const cardFooterContent = _sortedDayImports
			? `<div class="card-day-breakdown">
				${_sortedDayImports.map(d => `
					<div class="card-day-row">
						<span class="card-day-count">
							<i class="fa-solid fa-users"></i>
							${d.responses}${_totalPartic ? `<span class="card-participants-sep">/</span>${_totalPartic}` : ''}
						</span>
						<span class="card-day-label">${escapeHtml(d.label)}</span>
					</div>`).join('')}
				<div class="card-day-total">Total Days: ${_sortedDayImports.length}</div>
			</div>`
			: `<span class="card-participants">
				<i class="fa-solid fa-users"></i>
				<span class="card-participants-current">${p.responses_count || 0}</span>
				<span class="card-participants-sep">/</span>
				<span class="card-participants-total">${p.total_participants || '—'}</span>
				participants
			</span>
			<span class="card-days-pill">${days} ${days === 1 ? 'day' : 'days'}</span>`;

		const avg = parseFloat(p.overall_average);
		const avgPill = avg > 0
			? `<span class="card-avg-pill">${avg.toFixed(2)} <em>${escapeHtml(p.overall_result || '')}</em></span>`
			: '';

		const dateStr = p.start_date
			? (isExcel ? escapeHtml(p.start_date) : formatDate(p.start_date) + (p.end_date ? ' – ' + formatDate(p.end_date) : ''))
			: '—';

		// Edit button — system vs excel source
		// For Excel rows: container-linked imports have eval_program_id = the import's records_api ID,
		// standalone imports have no eval_program_id so fall back to rowId (which IS the records_api ID).
		const editRecordId = isExcel ? (evalId || rowId) : rowId;
		const editBtn = canEdit ? (!isExcel
			? `<button class="card-dropdown-item item-edit"      data-action="edit"        data-id="${rowId}"><i class="fas fa-pen"></i> Edit Program</button>`
			: `<button class="card-dropdown-item item-edit"      data-action="edit-record" data-id="${editRecordId}" data-title="${escapeAttr(p.title)}"><i class="fas fa-pen"></i> Edit Record</button>`
		) : '';

		// System-only actions (not for Excel imports)
		const systemActions = (!isExcel && canEdit) ? `
			${p.program_type === 'container' ? `
			<button class="card-dropdown-item" style="color:#15803d;" onclick="addDayImport(${rowId})"><i class="fa-solid fa-file-import"></i> Add Day Import</button>
			` : ''}
		` : '';

		const deleteBtn = canDelete ? `
			<div class="card-dropdown-divider"></div>
			<button class="card-dropdown-item item-delete" data-action="delete" data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}" data-title="${escapeAttr(p.title)}"><i class="fas fa-trash"></i> Delete</button>
		` : '';

		return `<div class="program-card" data-id="${rowId}">
			<div class="program-card-header">
				<div class="card-badges">${statusBadge}</div>
				${avgPill}
				<div class="card-menu-wrapper">
					<button class="card-menu-btn" title="Actions" onclick="
						event.stopPropagation();
						var d=document.getElementById('card-menu-${rowId}');
						var wasOpen=d.classList.contains('open');
						document.querySelectorAll('.card-dropdown.open').forEach(function(x){x.classList.remove('open')});
						document.querySelectorAll('.program-card.menu-open').forEach(function(x){x.classList.remove('menu-open')});
						if(!wasOpen){d.classList.add('open');this.closest('.program-card').classList.add('menu-open');}
					"><i class="fa-solid fa-ellipsis-vertical"></i></button>
					<div class="card-dropdown" id="card-menu-${rowId}">
						<button class="card-dropdown-item item-view" data-action="view"      data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}"><i class="fas fa-eye"></i> View Details</button>
						<button class="card-dropdown-item item-dash" data-action="dashboard" data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}"><i class="fas fa-chart-pie"></i> Dashboard</button>
						${editBtn}
						${systemActions}
						${deleteBtn}
					</div>
				</div>
			</div>
			<div class="program-card-body" data-action="view" data-id="${rowId}" data-source="${p.source || ''}" data-eval-id="${evalId}" style="cursor:pointer;">
				${p.division_memo ? `<div class="card-proponent">${escapeHtml(p.division_memo)}</div>` : ''}
				<h3 class="card-title">${escapeHtml(p.title)}</h3>
				<div class="card-meta">
					<span><i class="fa-solid fa-calendar-days"></i> ${dateStr}</span>
					<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(p.venue || '—')}</span>
					${p.proponents ? `<span><i class="fa-solid fa-user"></i> ${escapeHtml(p.proponents)}</span>` : ''}
				</div>
			</div>
			<div class="program-card-footer">
				${cardFooterContent}
			</div>
		</div>`;
	}).join('');

	// Close dropdowns when clicking anywhere outside — registered once only
	if (!displayProgramCards._outsideClickBound) {
		document.addEventListener('click', function() {
			document.querySelectorAll('.card-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
			document.querySelectorAll('.program-card.menu-open').forEach(function(c) { c.classList.remove('menu-open'); });
		});
		displayProgramCards._outsideClickBound = true;
	}
}

function searchPrograms(q) {
	State.searchQuery = q || '';
	applyProgramsView({ resetPage: true });
}

// ─── 8. PROGRAM MODAL ──────────────────────────────────────────────────────
function openProgramModal(mode, programId = null) {
	State.editingId = programId;
	State.dayCounter = 0;
	State.speakerCounter = 0;

	document.getElementById('programForm').reset();
	document.getElementById('workshopDaysContainer').innerHTML = '';

	// Repopulate selects after form.reset(). For 'edit' mode, loadProgramData()
	// below calls loadDropdownOptions() itself and then overrides each select
	// with the program's actual saved value (e.g. nature_of_event) once the
	// fetch resolves. Calling it a second time here as well used to create a
	// race: if this earlier, uncorrelated fetch happened to resolve *after*
	// loadProgramData's, it would silently reset fields like "Nature of
	// Event" back to the default ("Training") right after they'd been
	// correctly populated — so the field looked unchanged on open, but a
	// subsequent save could quietly overwrite the real value. Only firing it
	// here for 'create' avoids that entirely.
	if (mode === 'create') loadDropdownOptions();

	// Hide the Add Day Import banner whenever the modal is (re)opened
	const addDayBanner = document.getElementById('addDayImportBanner');
	if (addDayBanner) addDayBanner.style.display = 'none';

	if (mode === 'create') {
		document.getElementById('modalTitle').textContent = 'Add New Program';
		document.getElementById('submitBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Program';
		// Hide Workshop Days section — containers link imports instead
		const daysSection = document.querySelector('.days-section');
		if (daysSection) daysSection.style.display = 'none';
	} else {
		document.getElementById('modalTitle').textContent = 'Edit Program';
		document.getElementById('submitBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update Program';
		// Restore sections for editing
		const daysSection = document.querySelector('.days-section');
		if (daysSection) daysSection.style.display = '';
		loadProgramData(programId);
	}

	switchTab('details');
	document.getElementById('programModal').classList.add('active');
}

function closeProgramModal() {
	document.getElementById('programModal').classList.remove('active');
	State.editingId = null;
	State.originalDays = null;
}

/**
 * Navigate to import-excell.html pre-linked to a container program.
 * Finds the lowest missing day number so deleting Day 2 then adding
 * a new import correctly labels it "Day 2" rather than COUNT+1.
 */
function addDayImport(workshopId) {
	fetch(`${API_URL}/programs.php?program_imports=1&workshop_id=${workshopId}`, {
		credentials: 'include'
	})
	.then(r => r.json())
	.then(j => {
		const imports = Array.isArray(j.data) ? j.data : [];
		// Collect existing day numbers (parsed from day_label e.g. "Day 2" → 2)
		const usedNums = new Set(
			imports.map(imp => {
				const m = String(imp.day_label || '').match(/\d+/);
				return m ? parseInt(m[0]) : null;
			}).filter(n => n !== null)
		);
		// Find the lowest positive integer not already used
		let nextNum = 1;
		while (usedNums.has(nextNum)) nextNum++;
		const dayLabel = encodeURIComponent('Day ' + nextNum);
		window.location.href = `import-excell.html?workshop_id=${workshopId}&day_label=${dayLabel}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
	})
	.catch(() => {
		window.location.href = `import-excell.html?workshop_id=${workshopId}&day_label=Day%201&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
	});
}

/**
 * Delete a linked day import from a container program.
 * Removes the program_imports row (unlinks) but keeps the evaluation_programs data intact.
 */
async function deleteImport(importId, workshopId, dayLabel) {
	const confirmed = await showConfirm({
		title: `Remove ${dayLabel}?`,
		message: `This will unlink "${dayLabel}" from this program. The imported data itself is NOT deleted — it will still exist as a standalone record. You can re-link it later.`,
		confirmText: 'Remove Link',
		confirmColor: '#dc2626',
		iconClass: 'fa-trash',
		iconBg: '#fef2f2',
		iconColor: '#dc2626'
	});
	if (!confirmed) return;
	try {
		const res = await fetch(`${API_URL}/programs.php?program_imports=1&id=${importId}`, {
			method: 'DELETE',
			credentials: 'include'
		});
		const result = await res.json();
		if (result.success) {
			showToast('success', `${dayLabel} removed from program`);
			// Reload the view modal to reflect the change
			viewProgram(workshopId);
		} else {
			showAlert('error', result.message || 'Failed to remove import');
		}
	} catch (_) {
		showAlert('error', 'Failed to remove import');
	}
}

/**
 * Save the inclusive_dates for a specific day import inline from the view modal.
 * Updates records_api.php and also patches State.workshopData.linked_imports
 * in-place so subsequent PPT/Word exports immediately reflect the new date.
 */
async function saveImportDates(programId, workshopId) {
	const input = document.getElementById(`imp-dates-${programId}`);
	if (!input) return;
	const inclusive_dates = input.value.trim() || null;

	const btn = input.nextElementSibling;
	const origHtml = btn.innerHTML;
	btn.disabled = true;
	btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

	try {
		const res = await fetch(`${API_URL}/records_api.php`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ id: programId, inclusive_dates })
		});
		const result = await res.json();
		if (result.success) {
			// Update in-memory so PPT/Word exports reflect the new date immediately
			if (State.workshopData?.linked_imports) {
				const imp = State.workshopData.linked_imports.find(
					i => String(i.program_id) === String(programId)
				);
				if (imp) imp.inclusive_dates = inclusive_dates;
			}
			btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
			btn.style.background = '#16a34a';
			setTimeout(() => {
				btn.innerHTML = origHtml;
				btn.style.background = '';
				btn.disabled = false;
			}, 2000);
		} else {
			showAlert('error', result.message || 'Failed to save date');
			btn.innerHTML = origHtml;
			btn.disabled = false;
		}
	} catch (_) {
		showAlert('error', 'Error saving date');
		btn.innerHTML = origHtml;
		btn.disabled = false;
	}
}

/**
 * Replace a linked day import — navigates to import-excell.html with the
 * same day label but marks the old program_imports row for replacement.
 * On save, the old link is deleted and the new import is linked in its place.
 */
function replaceImport(importId, workshopId, dayLabel, oldProgramId) {
	const label = encodeURIComponent(dayLabel);
	window.location.href = `import-excell.html?workshop_id=${workshopId}&day_label=${label}&replace_import_id=${importId}&replace_program_id=${oldProgramId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
}

// ─── 9. TABS ───────────────────────────────────────────────────────────────
function switchTab(tab) {
	document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
	document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
	const key = tab.charAt(0).toUpperCase() + tab.slice(1);
	document.getElementById(`tabBtn${key}`).classList.add('active');
	document.getElementById(`tab${key}`).classList.add('active');
}

// ─── 10. WORKSHOP DAYS / SPEAKERS ──────────────────────────────────────────
// addWorkshopDay / removeWorkshopDay are used by loadProgramData when populating
// the edit form for existing system programs that have days.
function addWorkshopDay() {
	State.dayCounter++;
	const container = document.getElementById('workshopDaysContainer');
	const num = container.children.length + 1;
	container.insertAdjacentHTML('beforeend', `
<div class="day-item" data-day-id="${State.dayCounter}">
  <div class="day-item-header">
    <span class="day-number">Day ${num}</span>
    <button type="button" class="btn-remove" onclick="removeWorkshopDay(${State.dayCounter})">Remove</button>
  </div>
  <div class="form-grid">
    <div class="form-group"><label>Day Title</label><input type="text" class="day-title" placeholder="e.g., Introduction"></div>
    <div class="form-group"><label>Date</label><input type="date" class="day-date"></div>
    <div class="form-group full-width"><label>Description</label><textarea class="day-description" placeholder="Brief description"></textarea></div>
  </div>
  <div class="speakers-section">
    <div class="speakers-header">
      <h4>🎤 Resource Speakers</h4>
      <button type="button" class="btn-add-speaker" onclick="addSpeaker(${State.dayCounter})">+ Add Speaker</button>
    </div>
    <div class="speakers-container" data-day-id="${State.dayCounter}"></div>
  </div>
</div>`);
}

function removeWorkshopDay(id) {
	document.querySelector(`.day-item[data-day-id="${id}"]`)?.remove();
	document.querySelectorAll('.day-item').forEach((d, i) =>
		d.querySelector('.day-number').textContent = `Day ${i + 1}`
	);
}

function addSpeaker(dayId) {
	State.speakerCounter++;
	const container = document.querySelector(`.speakers-container[data-day-id="${dayId}"]`);
	container.insertAdjacentHTML('beforeend', `
<div class="speaker-item" data-speaker-id="${State.speakerCounter}">
  <div class="speaker-item-header">
    <span class="speaker-number">Speaker ${container.children.length + 1}</span>
    <button type="button" class="btn-remove-speaker" onclick="removeSpeaker(${dayId},${State.speakerCounter})">Remove</button>
  </div>
  <div class="speaker-form-grid">
    <div class="speaker-form-group"><label>Name *</label><input type="text" class="speaker-name" placeholder="Speaker name"></div>
    <div class="speaker-form-group"><label>Designation</label><input type="text" class="speaker-designation" placeholder="Position/Title"></div>
    <div class="speaker-form-group full-width"><label>Organization</label><input type="text" class="speaker-organization" placeholder="Company/Institution"></div>
    <div class="speaker-form-group full-width"><label>Contact</label><input type="text" class="speaker-contact" placeholder="Contact information"></div>
    <div class="speaker-form-group full-width"><label>Topic</label><textarea class="speaker-topic" placeholder="Topic to be discussed"></textarea></div>
  </div>
</div>`);
	updateSpeakerNumbers(dayId);
}

function removeSpeaker(dayId, spId) {
	document.querySelector(`[data-speaker-id="${spId}"]`)?.remove();
	updateSpeakerNumbers(dayId);
}

function updateSpeakerNumbers(dayId) {
	document.querySelectorAll(`.speakers-container[data-day-id="${dayId}"] .speaker-item`)
		.forEach((s, i) => s.querySelector('.speaker-number').textContent = `Speaker ${i + 1}`);
}

// ─── 11. LOAD & SAVE PROGRAM ───────────────────────────────────────────────
async function loadProgramData(id) {
	try {
		const res = await fetch(`${API_URL}/programs.php?id=${id}`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (!result.success) { showAlert('error', result.message); return; }
		const p = result.data;

		document.getElementById('programId').value = p.id;
		document.getElementById('programTitle').value = p.title;
		document.getElementById('divisionMemo').value = p.division_memo;
		document.getElementById('programStatus').value = p.status;
		loadDropdownOptions().then(() => {
			document.getElementById('programUnit').value = p.unit || 'SGOD';
			document.getElementById('programNatureOfEvent').value = p.nature_of_event || 'Training';
		});
		document.getElementById('startDate').value = toDateInputValue(p.start_date);
		document.getElementById('endDate').value = toDateInputValue(p.end_date);
		document.getElementById('programVenue').value = p.venue;
		document.getElementById('programTotalParticipants').value = p.total_participants || '';
		document.getElementById('programDescription').value = p.description || '';
		document.getElementById('programProponents').value = p.proponents || '';

		p.days?.forEach(day => {
			addWorkshopDay();
			const item = document.querySelector(`.day-item[data-day-id="${State.dayCounter}"]`);
			item.querySelector('.day-title').value = day.title || '';
			item.querySelector('.day-date').value = toDateInputValue(day.date);
			item.querySelector('.day-description').value = day.description || '';
			day.speakers?.forEach(speaker => {
				addSpeaker(State.dayCounter);
				const si = document.querySelector(`[data-speaker-id="${State.speakerCounter}"]`);
				si.querySelector('.speaker-name').value = speaker.name || '';
				si.querySelector('.speaker-designation').value = speaker.designation || '';
				si.querySelector('.speaker-organization').value = speaker.organization || '';
				si.querySelector('.speaker-contact').value = speaker.contact || '';
				si.querySelector('.speaker-topic').value = speaker.topic || '';
			});
		});

		// Snapshot original days so we can detect changes on save
		State.originalDays = (p.days || []).map(day => ({
			title: day.title || '',
			date: day.date || '',
			description: day.description || '',
			speakers: (day.speakers || []).map(s => ({
				name: s.name || '',
				designation: s.designation || '',
				organization: s.organization || '',
				contact: s.contact || '',
				topic: s.topic || ''
			}))
		}));
	} catch (_) { showAlert('error', 'Failed to load program data'); }
}

async function saveProgramData(event) {
	event.preventDefault();
	const btn = document.getElementById('submitBtn');
	const originalHtml = btn.innerHTML;
	let saveSucceeded = false;

	btn.disabled = true;
	btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

	try {
		// Collect current days from the form
		const days = [];
		document.querySelectorAll('.day-item').forEach((item, i) => {
			const speakers = [];
			item.querySelectorAll('.speaker-item').forEach((si, j) => {
				speakers.push({
					speaker_number: j + 1,
					name: si.querySelector('.speaker-name').value,
					designation: si.querySelector('.speaker-designation').value,
					organization: si.querySelector('.speaker-organization').value,
					contact: si.querySelector('.speaker-contact').value,
					topic: si.querySelector('.speaker-topic').value
				});
			});
			days.push({
				day_number: i + 1,
				title: item.querySelector('.day-title').value,
				date: item.querySelector('.day-date').value,
				description: item.querySelector('.day-description').value,
				speakers
			});
		});

		// Compare current days against the original snapshot
		const orig = State.originalDays;
		const daysModified = !orig || (() => {
			if (days.length !== orig.length) return true;
			return days.some((d, i) => {
				const o = orig[i];
				if (d.title !== o.title || d.date !== o.date || d.description !== o.description) return true;
				if (d.speakers.length !== o.speakers.length) return true;
				return d.speakers.some((s, j) => {
					const os = o.speakers[j];
					return s.name !== os.name || s.designation !== os.designation ||
						s.organization !== os.organization || s.contact !== os.contact || s.topic !== os.topic;
				});
			});
		})();

		const data = {
			title: document.getElementById('programTitle').value,
			division_memo: document.getElementById('divisionMemo').value,
			status: document.getElementById('programStatus').value,
			unit: document.getElementById('programUnit').value,
			nature_of_event: document.getElementById('programNatureOfEvent').value,
			proponents: document.getElementById('programProponents').value.trim(),
			start_date: document.getElementById('startDate').value,
			end_date: document.getElementById('endDate').value,
			venue: document.getElementById('programVenue').value,
			total_participants: document.getElementById('programTotalParticipants').value || null,
			description: document.getElementById('programDescription').value,
			page: PAGE_KEY,
			// New programs are always containers; editing preserves existing type via PUT
			program_type: State.editingId ? undefined : 'container',
			// Only send days if they were actually changed
			...(daysModified ? { days } : {})
		};

		if (data.unit === '__add_custom__' || data.nature_of_event === '__add_custom__') {
			showAlert('error', 'Please finish adding custom Unit/Nature before saving.');
			return;
		}

		const method = State.editingId ? 'PUT' : 'POST';
		if (State.editingId) data.program_id = State.editingId;

		const res = await fetch(`${API_URL}/programs.php`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});
		const result = await res.json();

		if (result.success) {
			if (result.partial && result.requires_force) {
				showToast('success', result.message);
				loadPrograms();
				const confirmed = await showConfirm({
					title: 'Rebuild Day Schedule?',
					message: `Day schedule was NOT changed because ${result.submission_count} evaluation submission(s) already exist. Do you want to rebuild the days? This will permanently DELETE all ${result.submission_count} existing submission(s).`,
					confirmText: 'Yes, Delete & Rebuild',
					confirmColor: '#dc2626',
					iconClass: 'fa-triangle-exclamation',
					iconBg: '#fef2f2',
					iconColor: '#dc2626'
				});
				if (confirmed) {
					data.force_rebuild_days = true;
					const retryRes = await fetch(`${API_URL}/programs.php`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify(data)
					});
					const retryResult = await retryRes.json();
					showToast(retryResult.success ? 'success' : 'error',
						retryResult.message || (retryResult.success ? 'Days rebuilt successfully.' : 'Failed to rebuild days.'));
					if (retryResult.success) loadPrograms();
				}
			} else {
				showToast('success', result.message);
				if (!State.editingId && result.data?.id) {
					State.editingId = result.data.id;
					document.getElementById('programId').value = result.data.id;
					document.getElementById('modalTitle').textContent = 'Edit Program';
					btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update Program';

					// Show Add Day Import banner for the newly created container
					let banner = document.getElementById('addDayImportBanner');
					if (!banner) {
						banner = document.createElement('div');
						banner.id = 'addDayImportBanner';
						banner.style.cssText = 'margin:18px 0 0;padding:16px 20px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;';
						banner.innerHTML = `
							<div>
								<strong style="color:#1e3a8a;font-size:14px;"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px;"></i> Program container created!</strong>
								<p style="margin:4px 0 0;font-size:13px;color:#3b82f6;">Now import your Excel files for each day of this program.</p>
							</div>
							<button onclick="addDayImport(${result.data.id})" style="padding:10px 18px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;">
								<i class="fa-solid fa-file-import"></i> Add Day Import
							</button>`;
						document.getElementById('tabDetails').appendChild(banner);
					}
					banner.style.display = 'flex';
					saveSucceeded = true;
				}
				loadPrograms();
			}
		} else {
			showAlert('error', result.message);
		}
	} catch (err) {
		console.error('saveProgramData:', err);
		showAlert('error', 'Failed to save program');
	} finally {
		btn.disabled = false;
		// Only reset if we didn't already update the button on success
		if (!saveSucceeded && btn.innerHTML.includes('spin')) {
			btn.innerHTML = originalHtml;
		}
	}
}

// PART 2 OF 5 — View, Edit, Delete, Questions
// Sections: 8-13 (program modal, tabs, days/speakers, load/save, view/edit/delete)

// ─── 12. VIEW / EDIT / DELETE PROGRAM ──────────────────────────────────────
async function viewProgram(id) {
	State.viewingId = id;
	try {
		const res = await fetch(`${API_URL}/programs.php?id=${id}`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (!result.success) { showAlert('error', result.message); return; }
		const p = result.data;
		State.workshopData = p;

		// Excel-linked workshops: responses live in respondents table, not
		// evaluation_submissions. Route the same way as Records for those tabs.
		const isExcelSource = p.source === 'excel';
		const isContainer   = (p.program_type === 'container');

		// Container programs behave like records — their data comes from
		// linked evaluation_programs (excel imports), not evaluation_submissions.
		State.isRecord = isExcelSource || isContainer;

		// For linked excel rows, find the eval_program_id from the cached list
		if (isExcelSource) {
			const cached = State.allPrograms.find(r => r.id == id);
			p.eval_program_id = cached?.eval_program_id || null;
		}

		// For container programs: if linked imports exist, use the first one's
		// program_id as the primary data source for responses/overview/report.
		// If there are multiple imports, we aggregate across all of them.
		if (isContainer) {
			// Sort by day_number so display order is correct even after delete+re-add
			const imports = (p.linked_imports || []).slice().sort((a, b) => {
				const an = parseInt(String(a.day_label || '').match(/\d+/)?.[0] || 999);
				const bn = parseInt(String(b.day_label || '').match(/\d+/)?.[0] || 999);
				return an - bn;
			});
			p.linked_imports = imports; // keep sorted for all subsequent uses
			if (imports.length === 0) {
				// No imports yet — show a friendly empty state instead of broken tabs
				document.getElementById('viewModalTitle').textContent = p.title;
				document.getElementById('viewProgramContent').innerHTML = `
					<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 10px;background:#f0fdf4;color:#15803d;border:1px solid #86efac;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:12px;">
						<i class="fa-solid fa-layer-group"></i> Container Program
					</span>
					<p><strong>Title:</strong> ${escapeHtml(p.title)}</p>
					<p><strong>Division Memo:</strong> ${escapeHtml(p.division_memo || '—')}</p>
					<p><strong>Venue:</strong> ${escapeHtml(p.venue || '—')}</p>
					<p><strong>Date Range:</strong> ${formatDate(p.start_date)} – ${formatDate(p.end_date)}</p>
					<div style="margin-top:20px;padding:20px;background:#f8fafc;border:1.5px dashed #cbd5e1;border-radius:10px;text-align:center;">
						<i class="fa-solid fa-file-import" style="font-size:28px;color:#94a3b8;margin-bottom:10px;display:block;"></i>
						<p style="font-weight:600;color:#374151;margin-bottom:6px;">No day imports yet</p>
						<p style="font-size:13px;color:#6b7280;margin-bottom:14px;">Click "Add Day Import" to link Excel responses to this program.</p>
						<button onclick="closeViewModal();addDayImport(${id});" style="padding:10px 20px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;">
							<i class="fa-solid fa-file-import"></i> Add Day Import
						</button>
					</div>`;
				populateDaySelectors([]);
				switchViewTab('overview');
				document.getElementById('viewProgramModal').classList.add('active');
				return;
			}

			// Use the first linked import as the primary source for all tabs.
			// eval_program_id drives responses.php?program_id=X and records_api.php?id=X
			const primaryImport = imports[0];
			p.eval_program_id  = primaryImport.program_id;
			State.containerWorkshopId = id;           // preserve original workshop ID for dashboard nav
			State.viewingId    = primaryImport.program_id;  // responses/report use this
		}

		// Attach the saved Excel import snapshot (feedback labels, day_participants, etc.)
		// for Excel-sourced workshops and container programs.
		if (State.isRecord) {
			const evalProgramId = p.eval_program_id || null;
			if (evalProgramId && !p.settings_snapshot) {
				try {
					const snapRes = await fetch(`${API_URL}/records_api.php?id=${evalProgramId}`, { credentials: 'include' });
					const snapJson = await snapRes.json();
					if (snapJson?.success && snapJson?.program) {
						p.settings_snapshot = snapJson.program.settings_snapshot || null;
						p.feedback_labels   = snapJson.program.feedback_labels || null;
					}
				} catch (_) { /* non-fatal */ }
			}
		}

		document.getElementById('viewModalTitle').textContent = p.title;

		const sourcePill = isContainer
			? `<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 10px;background:#f0fdf4;color:#15803d;border:1px solid #86efac;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:12px;"><i class="fa-solid fa-layer-group"></i> Container Program</span>`
			: isExcelSource
				? `<span class="badge-excel-import" style="margin-bottom:12px;display:inline-block;"><i class="fa-solid fa-file-excel"></i> Excel Import</span>`
				: '';

		let daysHtml = '';
		if (!isContainer && p.days?.length) {
			daysHtml = `<div class="days-list"><h4 style="margin-bottom:12px;color:#1e3a8a;">Workshop Days:</h4>
      ${p.days.map(d => `
      <div class="day-detail">
        <strong>Day ${d.day_number}:</strong> ${escapeHtml(d.title || '—')}<br>
        <small>Date: ${d.date ? formatDate(d.date) : 'Not set'}</small>
        ${d.description ? `<br><small>${escapeHtml(d.description)}</small>` : ''}
        ${d.speakers?.length ? `<div style="margin-top:8px;"><strong style="font-size:13px;">🎤 Speakers:</strong>
          ${d.speakers.map(s => `<div class="speaker-detail">
            <strong>${escapeHtml(s.name)}</strong>
            ${s.designation ? `<br><small>${escapeHtml(s.designation)}</small>` : ''}
            ${s.organization ? `<br><small>${escapeHtml(s.organization)}</small>` : ''}
            ${s.topic ? `<br><small><em>Topic: ${escapeHtml(s.topic)}</em></small>` : ''}
          </div>`).join('')}
        </div>` : ''}
      </div>`).join('')}
    </div>`;
		}

		// For container programs: show the list of linked day imports
		let importsHtml = '';
		if (isContainer && (p.linked_imports || []).length > 0) {
			importsHtml = `<div class="days-list" style="margin-top:16px;">
				<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
					<h4 style="margin:0;color:#1e3a8a;">Linked Day Imports (${p.linked_imports.length})</h4>
					<button onclick="addDayImport(${id})" style="padding:7px 14px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;">
						<i class="fa-solid fa-file-import"></i> Add Day Import
					</button>
				</div>
				${p.linked_imports.map((imp, i) => {
					const avg = imp.overall_average ? parseFloat(imp.overall_average).toFixed(2) : '—';
					return `<div class="day-detail" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
						<div style="flex:1;min-width:0;">
							<strong>${escapeHtml(imp.day_label || `Day ${i + 1}`)}</strong>
							<span style="font-size:12px;color:#6b7280;margin-left:8px;word-break:break-all;">${escapeHtml(imp.source_filename || '')}</span><br>
							<small>${imp.total_responses || 0} responses</small>
							&nbsp;·&nbsp;<small>Avg: <strong style="color:#1e3a8a;">${avg}</strong></small>
							<div style="display:flex;align-items:center;gap:6px;margin-top:5px;">
								<input
									id="imp-dates-${imp.program_id}"
									type="text"
									value="${escapeAttr(imp.inclusive_dates || '')}"
									placeholder="e.g. May 19, 2026"
									style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;width:160px;"
								/>
								<button onclick="saveImportDates(${imp.program_id}, ${id})" style="padding:4px 10px;background:#1e3a8a;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap;">
									<i class="fa-solid fa-floppy-disk"></i> Save Date
								</button>
							</div>
						</div>
						<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
							<a href="workshop-dashboard.html?program_id=${imp.program_id}&day_label=${encodeURIComponent(imp.day_label || `Day ${i + 1}`)}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}" style="font-size:12px;color:#3b82f6;text-decoration:none;white-space:nowrap;padding:4px 8px;border:1px solid #bfdbfe;border-radius:6px;">
								<i class="fa-solid fa-chart-pie"></i> Dashboard
							</a>
							<button onclick="replaceImport(${imp.id}, ${id}, '${escapeAttr(imp.day_label || `Day ${i+1}`)}', ${imp.program_id})" title="Replace this day's Excel file" style="padding:4px 8px;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">
								<i class="fa-solid fa-rotate"></i> Replace
							</button>
							<button onclick="deleteImport(${imp.id}, ${id}, '${escapeAttr(imp.day_label || `Day ${i+1}`)}')" title="Remove this day import" style="padding:4px 8px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">
								<i class="fa-solid fa-trash"></i>
							</button>
						</div>
					</div>`;
				}).join('')}
			</div>`;
		}

		document.getElementById('viewProgramContent').innerHTML = `
      ${sourcePill}
      <p><strong>Title:</strong>         ${escapeHtml(p.title)}</p>
      <p><strong>Division Memo:</strong> ${escapeHtml(p.division_memo || '—')}</p>
      <p><strong>Proponent/s:</strong>   ${p.proponents ? escapeHtml(p.proponents) : '—'}</p>
      <p><strong>Status:</strong>        <span class="status-badge status-${p.status}">${p.status}</span></p>
      <p><strong>Date Range:</strong>    ${formatDate(p.start_date)} – ${formatDate(p.end_date)}</p>
      <p><strong>Venue:</strong>         ${escapeHtml(p.venue || '—')}</p>
      <p><strong>Description:</strong>   ${p.description ? escapeHtml(p.description) : '—'}</p>
      ${!isContainer ? `<p><strong>Total Days:</strong>    ${p.days?.length || 0}</p>
      <p><strong>Participants:</strong>  ${p.participants_count || 0}</p>` : ''}
      ${daysHtml}
      ${importsHtml}
      <div id="overviewCategoryAverages" style="margin-top:16px;">
        <p style="color:#9ca3af;font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading averages…</p>
      </div>`;

		// For container programs, populate day selectors from linked imports
		const daysForSelector = isContainer
			? (p.linked_imports || []).map((imp, i) => ({
				id: imp.program_id,  // used as value in the day select
				day_number: imp.day_number || (i + 1),
				title: imp.day_label || `Day ${i + 1}`,
			}))
			: (p.days || []);

		populateDaySelectors(daysForSelector);
		switchViewTab('overview');
		document.getElementById('viewProgramModal').classList.add('active');

		// Background loads — both paths use the same functions;
		// State.isRecord controls which API endpoint they hit internally.
		loadWorkshopResponses();
		loadMonitoringData();
		// For overview averages: container uses program_id (record path), system uses workshop_id
		loadOverviewCategoryAverages(State.viewingId, State.isRecord);
	} catch (_) { showAlert('error', 'Failed to load program details'); }
}

function closeViewModal() {
	document.getElementById('viewProgramModal').classList.remove('active');
	State.reset();
}

// ─── NOTIFICATION DEEP LINK ────────────────────────────────────────────────
/**
 * Called after loadPrograms() resolves.
 * Reads ?open_workshop=X&highlight_participant=Y from the URL and, if present,
 * opens the program modal, switches to the Responses tab, and highlights the row.
 */
function checkNotificationDeepLink() {
	const params = new URLSearchParams(window.location.search);
	const workshopId = parseInt(params.get('open_workshop')) || null;
	const participantId = parseInt(params.get('highlight_participant')) || null;
	if (workshopId) {
		openProgramAndHighlight(workshopId, participantId);
		// Clean URL so a refresh doesn't re-trigger it
		const clean = window.location.pathname;
		window.history.replaceState({}, '', clean);
	}
}

/**
 * Opens the view modal for a workshop, switches to Responses tab,
 * then highlights the given participant row once data has loaded.
 */
async function openProgramAndHighlight(workshopId, participantId) {
	await viewProgram(workshopId);
	switchViewTab('responses');

	if (!participantId) return;

	// loadWorkshopResponses is async — poll until the row appears (max ~3 s)
	let attempts = 0;
	const interval = setInterval(() => {
		attempts++;
		const highlighted = highlightParticipantRow(participantId);
		if (highlighted || attempts >= 15) clearInterval(interval);
	}, 200);
}

/**
 * Finds the table row whose View/Delete button has the matching participantId,
 * scrolls to it, and flashes it.  Returns true when found.
 */
function highlightParticipantRow(participantId) {
	const tbody = document.getElementById('responsesTableBody');
	if (!tbody) return false;

	// Rows contain buttons with onclick="viewResponseDetail(PID)"
	const rows = tbody.querySelectorAll('tr');
	for (const row of rows) {
		const btn = row.querySelector(`button[onclick="viewResponseDetail(${participantId})"]`);
		if (btn) {
			row.classList.add('highlight-row');
			row.scrollIntoView({ behavior: 'smooth', block: 'center' });
			setTimeout(() => row.classList.remove('highlight-row'), 3000);
			return true;
		}
	}
	return false;
}
// ─── OVERVIEW CATEGORY AVERAGES ────────────────────────────────────────────
/**
 * Fetches category averages for a system workshop and renders them
 * dynamically in the Overview tab using live rating_scales from the DB.
 */
async function loadOverviewCategoryAverages(workshopId, isRecord = false) {
	const container = document.getElementById('overviewCategoryAverages');
	if (!container) return;

	try {
		// Ensure rating scales are loaded before interpreting scores
		await loadRatingScales();

		// Container/excel programs: data lives in category_averages keyed by program_id
		// System programs: data lives in evaluation_answers keyed by workshop_id
		const param = isRecord ? 'program_id' : 'workshop_id';
		const res = await fetch(
			`${API_URL}/responses.php?${param}=${workshopId}&categories=1`,
			{ credentials: 'include' }
		);
		const json = await res.json();
		if (!json.success) { container.innerHTML = ''; return; }

		const cats = json.category_averages || [];
		const total = json.total_respondents ?? 0;
		const fmt = n => (n === null || n === undefined || isNaN(n)) ? '—' : parseFloat(n).toFixed(2);

		if (!cats.length) { container.innerHTML = ''; return; }

		// Compute overall average across all categories — prefer the API's true
		// weighted average (matches the live dashboard) over an unweighted mean
		// of category averages.
		const validScores = cats.map(c => parseFloat(c.average_score)).filter(n => !isNaN(n));
		const overallAvg = (json.overall_weighted_average !== null && json.overall_weighted_average !== undefined && !isNaN(json.overall_weighted_average))
			? parseFloat(json.overall_weighted_average)
			: (validScores.length ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null);
		const overallResult = overallAvg !== null ? getInterpretation(overallAvg, 'overall') : '—';

		const catRows = cats.map(c => {
			const avg = parseFloat(c.average_score);
			const result = !isNaN(avg) ? getInterpretation(avg, 'category') : '—';
			return `<tr>
				<td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(c.category_name || c.name || '—')}</td>
				<td style="padding:8px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:#1e3a8a;">${fmt(avg)}</td>
				<td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(result)}</td>
			</tr>`;
		}).join('');

		// Overall row
		const overallRow = overallAvg !== null ? `<tr style="background:#f2f2f2;">
			<td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Overall Average</td>
			<td style="padding:8px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:#1e3a8a;">${fmt(overallAvg)}</td>
			<td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">${escapeHtml(overallResult)}</td>
		</tr>` : '';

		container.innerHTML = `
			<hr style="margin:16px 0;border-color:#e5e7eb;">
			<div style="display:flex;gap:24px;margin-bottom:12px;flex-wrap:wrap;">
				<p><strong>Total Responses:</strong> ${total}</p>
				<p><strong>Overall Average:</strong> <span style="font-weight:700;color:#1e3a8a;">${fmt(overallAvg)}</span></p>
				<p><strong>Overall Result:</strong> <span style="font-weight:600;">${escapeHtml(overallResult)}</span></p>
			</div>
			<div style="margin-top:4px;">
				<h4 style="margin-bottom:10px;color:#1e3a8a;font-size:14px;">Category Averages</h4>
				<table style="width:100%;border-collapse:collapse;font-size:13px;">
					<thead>
						<tr>
							<th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:left;">Category</th>
							<th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:center;width:120px;">Average</th>
							<th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:left;width:180px;">Result</th>
						</tr>
					</thead>
					<tbody>${catRows}${overallRow}</tbody>
				</table>
			</div>`;
	} catch (_) {
		if (container) container.innerHTML = '';
	}
}



function switchViewTab(tabName) {
	document.querySelectorAll('.view-tab-btn').forEach(btn =>
		btn.classList.toggle('active', btn.dataset.tab === tabName)
	);
	document.querySelectorAll('.view-tab-panel').forEach(panel =>
		panel.classList.remove('active')
	);

	// Reset the report preview whenever the Reports tab is opened
	if (tabName === 'reports') {
		const container = document.getElementById('reportPreviewContainer');
		if (container) {
			container.innerHTML = `
				<div class="report-placeholder">
					<i class="fa-solid fa-file-lines"></i>
					<p>Click "Generate Preview" to see the QAME report</p>
				</div>`;
		}
		const groupingToggle = document.getElementById('superCategoryGroupingToggle');
		if (groupingToggle) groupingToggle.checked = getSuperCategoryGroupingPreference();
	}

	const panelId = 'viewTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
	const panel = document.getElementById(panelId);
	if (panel) {
		panel.classList.add('active');
	} else {
		// Fallback: if tab name is wrong, show overview so the modal is never blank
		console.warn(`switchViewTab: panel "${panelId}" not found, falling back to overview`);
		document.getElementById('viewTabOverview')?.classList.add('active');
		document.querySelector('.view-tab-btn[data-tab="overview"]')?.classList.add('active');
	}
}

function populateDaySelectors(days) {
	['viewDaySelect', 'reportDaySelect'].forEach((selId, i) => {
		const sel = document.getElementById(selId);
		sel.innerHTML = i === 0
			? '<option value="">All Days</option>'
			: '<option value="">All Days Combined</option>';
		days.forEach(d => {
			const opt = document.createElement('option');
			// Container programs: day selector value is program_id (each import is a day).
			// Excel records: value is day title string so &day= param matches day_sheet.
			// System workshops: value is workshop_day_id (numeric).
			if (State.workshopData?.program_type === 'container') {
				opt.value = d.id;  // d.id was set to imp.program_id in viewProgram
			} else if (State.isRecord) {
				opt.value = d.title || `Day ${d.day_number}`;
			} else {
				opt.value = d.id;
			}
			const autoLabel = `Day ${d.day_number}`;
			// For standalone Excel records, d.title is the Excel sheet tab name (e.g. "Day 2").
			// If it's just another "Day N" pattern, use it directly as the label — don't
			// combine it with autoLabel or you get "Day 1: Day 2" in the dropdown.
			const titleIsAnotherDayN = d.title && /^day\s*\d+$/i.test(d.title.trim());
			const titlePart = (!titleIsAnotherDayN && d.title && d.title !== autoLabel)
				? d.title
				: (d.date ? formatDate(d.date) : '');
			// If the title is itself a Day N label, use it directly; otherwise combine.
			opt.textContent = titleIsAnotherDayN ? d.title : (titlePart ? `${autoLabel}: ${titlePart}` : autoLabel);
			sel.appendChild(opt);
		});
	});
}

function editProgram(id) { openProgramModal('edit', id); }

async function deleteProgram(id, title, forceDelete = false) {
	if (!forceDelete && !confirm(`Delete "${title}"?\n\nThis will also delete all associated days, speakers, participants, and evaluations.`)) return;
	try {
		const url = forceDelete
			? `${API_URL}/programs.php?id=${id}&force=true`
			: `${API_URL}/programs.php?id=${id}`;
		const res = await fetch(url, {
			method: 'DELETE', credentials: 'include'
		});
		const result = await res.json();

		if (result.success) {
			showAlert('success', result.message);
			loadPrograms();
		} else if (result.requires_confirmation) {
			// Backend found existing submissions - ask for explicit confirmation
			if (confirm(`⚠️ WARNING: This program has ${result.submission_count} evaluation submissions.\n\nDeleting will PERMANENTLY remove all this data.\n\nAre you absolutely sure?`)) {
				deleteProgram(id, title, true); // Retry with force=true
			} else {
				showAlert('warning', 'Delete cancelled');
			}
		} else {
			showAlert('error', result.message);
		}
	} catch (err) {
		console.error('deleteProgram:', err);
		showAlert('error', 'Failed to delete program');
	}
}

// ─── 14. DASHBOARD / EVAL LINK ─────────────────────────────────────────────
function viewInDashboard(programId, isRecord = null) {
	// ── Called from modal footer (no args) ──────────────────────────────
	// Resolve routing entirely from State so the caller never needs to
	// know which ID to pass.
	if (programId === undefined) {
		const p = State.workshopData;
		const isExcel = p?.source === 'excel';
		const isContainer = !isExcel && p?.program_type === 'container';

		if (isExcel && State.viewingId) {
			// Standalone excel import → program_id
			window.location.href = `workshop-dashboard.html?program_id=${State.viewingId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
		} else if (isContainer) {
			// Container: use workshop_id so the dashboard opens in All Days view
			// with full prev/next navigation across all linked imports.
			const workshopId = p.id || State.viewingId;
			if (workshopId) {
				window.location.href = `workshop-dashboard.html?workshop_id=${workshopId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
			}
		} else if (State.viewingId) {
			window.location.href = `workshop-dashboard.html?program_id=${State.viewingId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
		}
		return;
	}

	// ── Called from card/table kebab (programId provided) ───────────────
	if (isExcelSource(programId)) {
		window.location.href = `workshop-dashboard.html?program_id=${programId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
		return;
	}
	// All non-excel programs are containers — route as workshop_id
	window.location.href = `workshop-dashboard.html?workshop_id=${programId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
}

function isExcelSource(id) {
	const prog = State.allPrograms?.find(p => p.id == id);
	return prog?.source === 'excel';
}
function viewRecordInDashboard(recordId) {
	if (!State.isRecord) {
		window.location.href = `workshop-dashboard.html?workshop_id=${recordId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
	} else {
		window.location.href = `workshop-dashboard.html?program_id=${recordId}&page=${encodeURIComponent(PAGE_KEY || 'qatame')}`;
	}
}

// ─── SUMMARY REPORT MODAL ────────────────────────────────────────────────
function openSummaryReportModal() {
	const modal = document.getElementById('summaryReportModal');
	const content = document.getElementById('summaryReportContent');
	if (!modal || !content) {
		showAlert('error', 'Summary report modal is not available on this page.');
		return;
	}

	const programs = Array.isArray(State.allPrograms) ? State.allPrograms : [];
	if (!programs.length) {
		content.innerHTML = '<p style="margin:0;color:#6b7280;">No program data available yet.</p>';
		modal.classList.add('active');
		return;
	}

	const QUARTER_OPTIONS = [
		{ value: 'all', label: '1st-4th Quarter (Overall)' },
		{ value: '1', label: '1st Quarter' },
		{ value: '2', label: '2nd Quarter' },
		{ value: '3', label: '3rd Quarter' },
		{ value: '4', label: '4th Quarter' },
	];

	const monthMap = {
		january: 0, jan: 0,
		february: 1, feb: 1,
		march: 2, mar: 2,
		april: 3, apr: 3,
		may: 4,
		june: 5, jun: 5,
		july: 6, jul: 6,
		august: 7, aug: 7,
		september: 8, sep: 8, sept: 8,
		october: 9, oct: 9,
		november: 10, nov: 10,
		december: 11, dec: 11,
	};

	const toNumber = value => {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	};

	const parseProgramDate = program => {
		const candidates = [program?.start_date, program?.inclusive_dates, program?.end_date];
		for (const raw of candidates) {
			if (!raw) continue;
			const txt = String(raw).trim();
			if (!txt) continue;

			const direct = new Date(txt);
			if (!Number.isNaN(direct.getTime())) return direct;

			const lower = txt.toLowerCase();
			const monthMatch = lower.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
			const yearMatch = lower.match(/\b(20\d{2})\b/);
			if (!monthMatch) continue;
			const monthIdx = monthMap[monthMatch[1]];
			if (!Number.isFinite(monthIdx)) continue;
			const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
			return new Date(year, monthIdx, 1);
		}
		return null;
	};

	const getQuarterKey = program => {
		const d = parseProgramDate(program);
		if (!d) return 'unknown';
		return String(Math.floor(d.getMonth() / 3) + 1);
	};

	const QUARTER_RANGE_LABELS = {
		'1': 'JAN - MARCH',
		'2': 'APRIL - JUNE',
		'3': 'JULY - SEPTEMBER',
		'4': 'OCTOBER - DECEMBER',
	};

	const QUARTER_ORDINAL = {
		'1': '1ST',
		'2': '2ND',
		'3': '3RD',
		'4': '4TH',
	};

	const getQuarterYear = quarterKey => {
		const years = programs
			.filter(p => getQuarterKey(p) === quarterKey)
			.map(p => parseProgramDate(p)?.getFullYear())
			.filter(y => Number.isFinite(y));
		if (!years.length) return new Date().getFullYear();
		const counts = {};
		years.forEach(y => { counts[y] = (counts[y] || 0) + 1; });
		return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], 10);
	};

	const getQuarterReportLine = quarterKey => {
		if (!QUARTER_ORDINAL[quarterKey]) return 'UNDATED PROGRAMS';
		const year = getQuarterYear(quarterKey);
		return `${QUARTER_ORDINAL[quarterKey]} QUARTER (${QUARTER_RANGE_LABELS[quarterKey]}, ${year})`;
	};

	const getIssuanceOrReportNo = p => {
		const seq = String(p?.sequence_number || '').trim();
		const memo = String(p?.division_memo || '').trim();
		if (seq && memo && seq !== memo) return `${seq} / ${memo}`;
		return seq || memo || '—';
	};

	const sortProgramsByDateThenTitle = list => {
		return [...list].sort((a, b) => {
			const ad = parseProgramDate(a);
			const bd = parseProgramDate(b);
			const at = ad ? ad.getTime() : Number.MAX_SAFE_INTEGER;
			const bt = bd ? bd.getTime() : Number.MAX_SAFE_INTEGER;
			if (at !== bt) return at - bt;
			return String(a?.title || '').localeCompare(String(b?.title || ''));
		});
	};

	const mapProgramRow = p => ({
		issuance: getIssuanceOrReportNo(p),
		eventName: String(p?.title || '').trim() || 'Untitled Program',
	});

	const buildRows = countsObj => {
		const rows = Object.entries(countsObj)
			.filter(([, count]) => count > 0)
			.sort((a, b) => b[1] - a[1]);
		if (!rows.length) {
			return '<tr><td style="padding:8px;color:#6b7280;" colspan="2">No data</td></tr>';
		}
		return rows.map(([label, count]) => `
			<tr>
				<td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(label)}</td>
				<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#1e3a8a;">${count}</td>
			</tr>`).join('');
	};

	const render = selectedQuarter => {
		const quarter = selectedQuarter || 'all';
		const quarterCounts = {
			'1st Quarter': 0,
			'2nd Quarter': 0,
			'3rd Quarter': 0,
			'4th Quarter': 0,
			'No Date': 0,
		};

		programs.forEach(p => {
			const q = getQuarterKey(p);
			if (q === '1') quarterCounts['1st Quarter'] += 1;
			else if (q === '2') quarterCounts['2nd Quarter'] += 1;
			else if (q === '3') quarterCounts['3rd Quarter'] += 1;
			else if (q === '4') quarterCounts['4th Quarter'] += 1;
			else quarterCounts['No Date'] += 1;
		});

		const filteredPrograms = quarter === 'all'
			? [...programs]
			: programs.filter(p => getQuarterKey(p) === quarter);

		const filteredProgramsSorted = sortProgramsByDateThenTitle(filteredPrograms);

		const groupedByQuarter = {
			'1': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '1')),
			'2': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '2')),
			'3': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '3')),
			'4': sortProgramsByDateThenTitle(programs.filter(p => getQuarterKey(p) === '4')),
		};

		const sourceCounts = { System: 0, Excel: 0 };
		const statusCounts = { Ongoing: 0, Upcoming: 0, Completed: 0, Cancelled: 0, Other: 0 };
		const unitCounts = {};

		let totalRespondents = 0;
		let totalExpectedParticipants = 0;

		filteredPrograms.forEach(p => {
			const isExcel = String(p.source || '').toLowerCase() === 'excel';
			sourceCounts[isExcel ? 'Excel' : 'System'] += 1;

			const status = String(p.status || '').toLowerCase();
			if (status === 'ongoing') statusCounts.Ongoing += 1;
			else if (status === 'upcoming') statusCounts.Upcoming += 1;
			else if (status === 'completed') statusCounts.Completed += 1;
			else if (status === 'cancelled') statusCounts.Cancelled += 1;
			else statusCounts.Other += 1;

			const unit = String(p.unit || 'Unspecified').trim() || 'Unspecified';
			unitCounts[unit] = (unitCounts[unit] || 0) + 1;

			totalRespondents += toNumber(p.responses_count);
			totalExpectedParticipants += toNumber(p.total_participants);
		});

		const responseRate = totalExpectedParticipants > 0
			? `${Math.min((totalRespondents / totalExpectedParticipants) * 100, 100).toFixed(1)}%`
			: '—';

		const quarterLabel = (QUARTER_OPTIONS.find(o => o.value === quarter)?.label) || '1st-4th Quarter (Overall)';
		const reportQuarterLine = quarter === 'all'
			? '1ST-4TH QUARTER (OVERALL SUMMARY)'
			: getQuarterReportLine(quarter);

		const quarterReportLinesByQuarter = {
			'1': getQuarterReportLine('1'),
			'2': getQuarterReportLine('2'),
			'3': getQuarterReportLine('3'),
			'4': getQuarterReportLine('4'),
		};

		State.summaryReportSnapshot = {
			quarter,
			quarterLabel,
			reportTitle: 'QATAME EVALUATION REPORTS',
			reportQuarterLine,
			totalPrograms: filteredPrograms.length,
			totalRespondents,
			totalExpectedParticipants,
			responseRate,
			quarterCounts: { ...quarterCounts },
			sourceCounts: { ...sourceCounts },
			statusCounts: { ...statusCounts },
			unitCounts: { ...unitCounts },
			programRows: filteredProgramsSorted.map(mapProgramRow),
			groupedProgramRowsByQuarter: {
				'1': groupedByQuarter['1'].map(mapProgramRow),
				'2': groupedByQuarter['2'].map(mapProgramRow),
				'3': groupedByQuarter['3'].map(mapProgramRow),
				'4': groupedByQuarter['4'].map(mapProgramRow),
			},
			quarterReportLinesByQuarter,
		};

		content.innerHTML = `
			<div style="display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
				<div>
					<div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Summary Filter</div>
					<select id="summaryQuarterFilter" style="min-width:240px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;">
						${QUARTER_OPTIONS.map(opt => `<option value="${opt.value}"${opt.value === quarter ? ' selected' : ''}>${opt.label}</option>`).join('')}
					</select>
				</div>
				<div style="font-size:12px;color:#6b7280;">Quarter is based on program start date month.</div>
			</div>

			<div style="font-size:13px;color:#334155;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 10px;margin-bottom:14px;">
				Showing: <strong>${escapeHtml(quarterLabel)}</strong> (${filteredPrograms.length} program${filteredPrograms.length === 1 ? '' : 's'})
			</div>

			<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
				<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
					<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Programs</div>
					<div style="font-size:24px;font-weight:700;color:#1e3a8a;">${filteredPrograms.length}</div>
				</div>
				<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
					<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Respondents</div>
					<div style="font-size:24px;font-weight:700;color:#1e3a8a;">${totalRespondents}</div>
				</div>
				<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
					<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Expected Participants</div>
					<div style="font-size:24px;font-weight:700;color:#1e3a8a;">${totalExpectedParticipants}</div>
				</div>
				<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
					<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Response Rate</div>
					<div style="font-size:24px;font-weight:700;color:#1e3a8a;">${responseRate}</div>
				</div>
			</div>

			<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
				<div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
					<div style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;">By Quarter (All Programs)</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;">
						<tbody>${buildRows(quarterCounts)}</tbody>
					</table>
				</div>
				<div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
					<div style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;">By Source</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;">
						<tbody>${buildRows(sourceCounts)}</tbody>
					</table>
				</div>
				<div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
					<div style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;">By Status</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;">
						<tbody>${buildRows(statusCounts)}</tbody>
					</table>
				</div>
				<div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
					<div style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;">By Unit</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;">
						<tbody>${buildRows(unitCounts)}</tbody>
					</table>
				</div>
			</div>`;

		const quarterSelect = document.getElementById('summaryQuarterFilter');
		if (quarterSelect) {
			quarterSelect.addEventListener('change', e => {
				render(e.target.value);
			});
		}
	};

	render('all');

	modal.classList.add('active');
}

function closeSummaryReportModal() {
	document.getElementById('summaryReportModal')?.classList.remove('active');
}

async function exportSummaryReportToWord() {
	if (typeof docx === 'undefined') {
		showAlert('error', 'Word export library is not loaded.');
		return;
	}

	const snapshot = State.summaryReportSnapshot;
	if (!snapshot) {
		showAlert('error', 'Open Summary Report first before exporting.');
		return;
	}

	try {
		const {
			Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
			WidthType, AlignmentType, BorderStyle,
		} = docx;

		const now = new Date();
		const dateText = now.toLocaleString();

		const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
		const metricRow = (label, value, bold = false) => new TableRow({
			children: [
				new TableCell({
					width: { size: 70, type: WidthType.PERCENTAGE },
					borders: { top: border, bottom: border, left: border, right: border },
					children: [new Paragraph({ children: [new TextRun({ text: String(label), bold })] })],
				}),
				new TableCell({
					width: { size: 30, type: WidthType.PERCENTAGE },
					borders: { top: border, bottom: border, left: border, right: border },
					children: [new Paragraph({
						alignment: AlignmentType.RIGHT,
						children: [new TextRun({ text: String(value), bold })],
					})],
				}),
			],
		});

		const countRows = countsObj => {
			const rows = Object.entries(countsObj)
				.filter(([, count]) => count > 0)
				.sort((a, b) => b[1] - a[1]);
			if (!rows.length) return [metricRow('No data', 0, false)];
			return rows.map(([label, count]) => metricRow(label, count, false));
		};

		const sectionTable = (title, countsObj) => new Table({
			width: { size: 100, type: WidthType.PERCENTAGE },
			rows: [
				metricRow(title, '', true),
				...countRows(countsObj),
			],
		});

		const programListTable = rows => {
			const headerRow = new TableRow({
				children: [
					new TableCell({
						width: { size: 10, type: WidthType.PERCENTAGE },
						borders: { top: border, bottom: border, left: border, right: border },
						children: [new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: 'No.', bold: true })],
						})],
					}),
					new TableCell({
						width: { size: 30, type: WidthType.PERCENTAGE },
						borders: { top: border, bottom: border, left: border, right: border },
						children: [new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: 'Issuance / Report No.', bold: true })],
						})],
					}),
					new TableCell({
						width: { size: 60, type: WidthType.PERCENTAGE },
						borders: { top: border, bottom: border, left: border, right: border },
						children: [new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: 'Name of Event / Activity', bold: true })],
						})],
					}),
				],
			});

			const dataRows = rows.length
				? rows.map((r, idx) => new TableRow({
					children: [
						new TableCell({
							width: { size: 10, type: WidthType.PERCENTAGE },
							borders: { top: border, bottom: border, left: border, right: border },
							children: [new Paragraph({
								alignment: AlignmentType.CENTER,
								children: [new TextRun({ text: String(idx + 1) })],
							})],
						}),
						new TableCell({
							width: { size: 30, type: WidthType.PERCENTAGE },
							borders: { top: border, bottom: border, left: border, right: border },
							children: [new Paragraph({ children: [new TextRun({ text: String(r.issuance || '—') })] })],
						}),
						new TableCell({
							width: { size: 60, type: WidthType.PERCENTAGE },
							borders: { top: border, bottom: border, left: border, right: border },
							children: [new Paragraph({ children: [new TextRun({ text: String(r.eventName || '—') })] })],
						}),
					],
				}))
				: [new TableRow({
					children: [new TableCell({
						columnSpan: 3,
						borders: { top: border, bottom: border, left: border, right: border },
						children: [new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: 'No programs/workshops for this quarter.' })],
						})],
					})],
				})];

			return new Table({
				width: { size: 100, type: WidthType.PERCENTAGE },
				rows: [headerRow, ...dataRows],
			});
		};

		const summaryTable = new Table({
			width: { size: 100, type: WidthType.PERCENTAGE },
			rows: [
				metricRow('Programs', snapshot.totalPrograms, true),
				metricRow('Respondents', snapshot.totalRespondents, true),
				metricRow('Expected Participants', snapshot.totalExpectedParticipants, true),
				metricRow('Response Rate', snapshot.responseRate, true),
			],
		});

		const children = [
			new Paragraph({
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: snapshot.reportTitle || 'QATAME EVALUATION REPORTS', bold: true, size: 28 })],
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: snapshot.reportQuarterLine || snapshot.quarterLabel || '', bold: true, size: 24 })],
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: `Generated: ${dateText}`, size: 20 })],
			}),
			new Paragraph({ children: [new TextRun({ text: '' })] }),
			summaryTable,
			new Paragraph({ children: [new TextRun({ text: '' })] }),
		];

		if (snapshot.quarter === 'all') {
			['1', '2', '3', '4'].forEach(q => {
				children.push(
					new Paragraph({
						alignment: AlignmentType.LEFT,
						children: [new TextRun({ text: snapshot.quarterReportLinesByQuarter?.[q] || `${q} QUARTER`, bold: true, size: 22 })],
					}),
					programListTable(snapshot.groupedProgramRowsByQuarter?.[q] || []),
					new Paragraph({ children: [new TextRun({ text: '' })] }),
				);
			});
		} else {
			children.push(
				programListTable(snapshot.programRows || []),
				new Paragraph({ children: [new TextRun({ text: '' })] }),
			);
		}

		children.push(
			sectionTable('By Quarter (All Programs)', snapshot.quarterCounts),
			new Paragraph({ children: [new TextRun({ text: '' })] }),
			sectionTable('By Source', snapshot.sourceCounts),
			new Paragraph({ children: [new TextRun({ text: '' })] }),
			sectionTable('By Status', snapshot.statusCounts),
			new Paragraph({ children: [new TextRun({ text: '' })] }),
			sectionTable('By Unit', snapshot.unitCounts),
		);

		const doc = new Document({
			sections: [{
			    properties: {
                    page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1181, bottom: 1094, left: 1440, header: 360, footer: 360 } }
                },
				children,
			}],
		});

		const blob = await Packer.toBlob(doc);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `QATAME_Evaluation_Reports_${(snapshot.reportQuarterLine || snapshot.quarterLabel || 'summary').replace(/[^a-z0-9]/gi, '_')}_${now.toISOString().slice(0, 10)}.docx`;
		a.click();
		URL.revokeObjectURL(url);
		showAlert('success', 'Summary report exported to Word');
	} catch (e) {
		console.error('exportSummaryReportToWord:', e);
		showAlert('error', 'Failed to export summary report');
	}
}

function copyEvaluationLink() {
	const inp = document.getElementById('evaluationLinkInput');
	inp.select(); inp.setSelectionRange(0, 99999);
	navigator.clipboard.writeText(inp.value)
		.then(() => showAlert('success', 'Link copied!'))
		.catch(() => { document.execCommand('copy'); showAlert('success', 'Link copied!'); });
}
function downloadQRCode() {
	const c = document.querySelector('#qrcode canvas');
	if (!c) { showAlert('error', 'QR not generated yet'); return; }
	const a = document.createElement('a');
	a.download = document.getElementById('programTitleDisplay').textContent.replace('Program: ', '') + '_QR.png';
	a.href = c.toDataURL(); a.click();
	showAlert('success', 'QR Code downloaded!');
}

// PART 3 OF 5 — Responses & Report Builder
// Sections: 16-17 (responses, QAME report HTML)

// ═══════════════════════════════════════════════════════════════════════════
//  16. RESPONSES TAB
// ═══════════════════════════════════════════════════════════════════════════
async function loadWorkshopResponses() {
	if (!State.viewingId) return;
	const dayId = document.getElementById('viewDaySelect')?.value || '';
	const tbody = document.getElementById('responsesTableBody');
	tbody.innerHTML = '<tr><td colspan="6" class="no-data"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';

	const isContainer = State.workshopData?.program_type === 'container';
	const imports = State.workshopData?.linked_imports || [];

	// FIX: "All Days Combined" for container programs was incorrectly fetching
	// only Day 1 because State.viewingId is set to the first import's program_id.
	// When no day is selected, fetch ALL imports and merge — even if there's only one,
	// so we always use the import's own program_id rather than the stale State.viewingId.
	if (State.isRecord && isContainer && !dayId && imports.length >= 1) {
		const allRows = [];
		const allQuestionMaps = {};
		for (const imp of imports) {
			try {
				const r = await fetch(`${API_URL}/responses.php?program_id=${imp.program_id}`, { credentials: 'include' });
				const j = await r.json();
				if (j.success) {
					allRows.push(...(j.data || []));
					Object.assign(allQuestionMaps, j.question_map || {});
				}
			} catch (_) { /* non-fatal — skip failed import */ }
		}
		State.responses = allRows;
		State.responseQuestionMap = allQuestionMaps;
		State.filteredResponses = [...allRows];
		updateResponsesStats();
		renderResponsesTable();
		document.getElementById('responsesCountBadge').textContent = State.filteredResponses.length;
		return;
	}

	try {
		let url;
		if (State.isRecord) {
			// Standalone/linked Excel import OR container program:
			// responses live in the respondents table keyed by evaluation_programs.id
			// For container programs with multiple imports, State.viewingId was already
			// set to the primary (first) import's program_id in viewProgram().
			// When the user picks a different day from the selector, dayId is that
			// import's program_id — switch State.viewingId to that import.
			const programId = dayId && !isNaN(parseInt(dayId)) && isContainer
				? parseInt(dayId)
				: State.viewingId;
			url = `${API_URL}/responses.php?program_id=${programId}`;
			// For non-container records, also support day_sheet filtering
			if (dayId && !isContainer) {
				url += `&day=${encodeURIComponent(dayId)}`;
			}
		} else {
			// System workshop: responses live in evaluation_submissions keyed
			// by workshop_day_id. Fall back to first day if none selected.
			let workshopDayId = dayId || State.workshopData?.days?.[0]?.id;
			if (!workshopDayId) {
				tbody.innerHTML = '<tr><td colspan="6" class="no-data">No workshop days configured</td></tr>';
				return;
			}
			url = `${API_URL}/responses.php?workshop_day_id=${workshopDayId}`;
		}

		const res = await fetch(url, { credentials: 'include' });
		const result = await res.json();

		if (result.success) {
			State.responses = result.data || [];
			State.responseQuestionMap = result.question_map || {};

			// Client-side day filter as safety net — only for non-container records
			// where the API may return all days and we need to filter by day_sheet label.
			// For container programs, the URL already targets the specific import's
			// program_id so all returned rows belong to that day — skip filtering.
			const selectedDay = document.getElementById('viewDaySelect')?.value || '';
			if (selectedDay && State.isRecord && !isContainer) {
				State.filteredResponses = State.responses.filter(r =>
					(r.day || r.day_sheet || '').toLowerCase() === selectedDay.toLowerCase()
				);
			} else {
				State.filteredResponses = [...State.responses];
			}

			updateResponsesStats();
			renderResponsesTable();
			// Badge always reflects the currently visible (filtered) count
			document.getElementById('responsesCountBadge').textContent = State.filteredResponses.length;
		} else {
			tbody.innerHTML = '<tr><td colspan="6" class="no-data">Failed to load responses</td></tr>';
		}
	} catch (_) {
		tbody.innerHTML = '<tr><td colspan="6" class="no-data">Error loading responses</td></tr>';
	}
}

function updateResponsesStats() {
	const total = State.filteredResponses.length;
	const males = State.filteredResponses.filter(r => (r.sex || '').toLowerCase() === 'male').length;
	const females = State.filteredResponses.filter(r => (r.sex || '').toLowerCase() === 'female').length;
	const preferNotToSay = State.filteredResponses.filter(r => {
		const s = (r.sex || '').toLowerCase();
		return s !== 'male' && s !== 'female';
	}).length;
	const ratings = State.filteredResponses
		.map(r => parseFloat(r.average_score || r.average_rating))
		.filter(n => !isNaN(n));
	const avgRating = ratings.length
		? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)
		: '-';

	document.getElementById('statTotalResponses').textContent = total;
	document.getElementById('statAvgRating').textContent = avgRating;
	document.getElementById('statMaleCount').textContent = males;
	document.getElementById('statFemaleCount').textContent = females;
	const preferEl = document.getElementById('statPreferNotToSayCount');
	if (preferEl) preferEl.textContent = preferNotToSay;
}

function renderResponsesTable() {
	const tbody = document.getElementById('responsesTableBody');
	if (!State.filteredResponses.length) {
		tbody.innerHTML = '<tr><td colspan="6" class="no-data">No responses found</td></tr>';
		return;
	}
	tbody.innerHTML = State.filteredResponses.map(r => {
		const avg = r.average_score !== undefined
			? parseFloat(r.average_score).toFixed(2)
			: (r.average_rating ? parseFloat(r.average_rating).toFixed(2) : '-');
		const sexDisplay = (() => {
			const s = (r.sex || '').trim().toLowerCase();
			if (s === 'male') return 'Male';
			if (s === 'female') return 'Female';
			return 'Prefer not to say';
		})();
		const pid = r.participant_id || r.id;
		return `<tr>
      <td><strong>${escapeHtml(r.full_name || r.name || 'Anonymous')}</strong></td>
      <td>${escapeHtml(sexDisplay)}</td>
      <td>${escapeHtml(r.participant_type || '-')}</td>
      <td>${escapeHtml(r.designation || '-')}</td>
      <td><strong>${avg}</strong></td>
      <td>
        <button class="btn-view-response"   onclick="viewResponseDetail(${pid})"><i class="fa-solid fa-eye"></i> View</button>
        <button class="btn-delete-response" onclick="deleteResponse(${pid})"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
	}).join('');
}

function filterResponses() {
	const search = (document.getElementById('viewResponseSearch')?.value || '').toLowerCase();
	const gender = document.getElementById('viewGenderFilter')?.value || '';
	State.filteredResponses = State.responses.filter(r => {
		const name = (r.full_name || r.name || '').toLowerCase();
		const sex = (r.sex || '').toLowerCase();
		let genderMatch = true;
		if (gender === 'prefer_not_to_say') {
			genderMatch = sex !== 'male' && sex !== 'female';
		} else if (gender) {
			genderMatch = sex === gender.toLowerCase();
		}
		return (!search || name.includes(search)) && genderMatch;
	});
	updateResponsesStats();
	renderResponsesTable();
	// Keep badge in sync with whatever is currently visible
	document.getElementById('responsesCountBadge').textContent = State.filteredResponses.length;
}

async function viewResponseDetail(participantId) {
	try {
		const res = await fetch(`${API_URL}/responses.php?participant_id=${participantId}`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (!result.success) { showAlert('error', result.message || 'Failed to load response'); return; }

		const r = result.data;
		const container = document.getElementById('responseDetailContent');

		let categoriesHtml = '';
		if (r.ratings && typeof r.ratings === 'object') {
			for (const [category, items] of Object.entries(r.ratings)) {
				if (Array.isArray(items) && items.length) {
					categoriesHtml += `
            <div class="response-category-section">
              <div class="response-category-title">${escapeHtml(category)}</div>
              ${items.map(item => `
                <div class="response-rating-item">
                  <span class="response-rating-label">${escapeHtml(item.question || item.label)}</span>
                  <span class="response-rating-value">${item.rating || item.value || '-'}</span>
                </div>`).join('')}
            </div>`;
				}
			}
		}

		const feedbackHtml = r.feedback ? `
      <div class="response-feedback-section">
        <div class="response-feedback-title">Feedback Comments</div>
        <div class="response-feedback-text">${escapeHtml(r.feedback)}</div>
      </div>` : '';

		container.innerHTML = `
      <div class="response-detail-header">
        <div>
          <div class="response-detail-name">${escapeHtml(r.full_name || r.name || 'Anonymous')}</div>
          <div class="response-detail-meta">${r.sex || '-'} • ${r.participant_type || '-'} • ${r.designation || '-'}</div>
        </div>
        <div class="response-detail-avg">
          <span class="avg-value">${r.average_rating ? parseFloat(r.average_rating).toFixed(2) : '-'}</span>
          <span class="avg-label">Avg Rating</span>
        </div>
      </div>
      ${categoriesHtml}
      ${feedbackHtml}`;

		document.getElementById('responseDetailModal').classList.add('active');
	} catch (_) { showAlert('error', 'Failed to load response details'); }
}

function closeResponseDetailModal() { document.getElementById('responseDetailModal').classList.remove('active'); }

async function deleteResponse(participantId) {
	if (!confirm('Delete this response? This action cannot be undone.')) return;
	try {
		const res = await fetch(`${API_URL}/responses.php?participant_id=${participantId}`, {
			method: 'DELETE', credentials: 'include'
		});
		const result = await res.json();
		if (result.success) { showAlert('success', 'Response deleted'); loadWorkshopResponses(); }
		else showAlert('error', result.message || 'Failed to delete response');
	} catch (_) { showAlert('error', 'Error deleting response'); }
}

function toExcelSafeValue(value) {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.join(' | ');
	if (typeof value === 'object') return JSON.stringify(value);
	// Normalize non-breaking spaces and collapse runs of whitespace
	if (typeof value === 'string') return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
	return value;
}

function cleanSheetName(name, fallback) {
	const sanitized = String(name || fallback || 'Sheet')
		.replace(/[\\/*?:\[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 31);
	return sanitized || fallback || 'Sheet';
}

function getQuestionColumnSortValue(meta) {
	const category = parseInt(meta?.category, 10);
	const catOrder = Number.isFinite(category) ? category : 999;
	const field = String(meta?.field || '');
	const qMatch = field.match(/_q(\d+)$/i);
	const qOrder = qMatch ? parseInt(qMatch[1], 10) : 999;
	return { catOrder, qOrder, field };
}

function getExportDataSourceId(dayId) {
    if (State.workshopData?.program_type === 'container') {
        if (dayId) {
            // dayId is a workshop_day_id; find the matching program_id from imports
            const imp = (State.programImports || []).find(i => String(i.workshop_day_id) === String(dayId));
            if (imp) return { id: imp.program_id, isRecord: true, isContainerAllDays: false };
        }
        return {
            id: State.containerWorkshopId || State.workshopData?.id || State.viewingId,
            isRecord: false,
            isContainerAllDays: true
        };
    }
    if (!State.isRecord) return { id: State.viewingId, isRecord: false, isContainerAllDays: false };
    return { id: State.workshopData?.eval_program_id || State.viewingId, isRecord: true, isContainerAllDays: false };
}

async function exportResponsesToExcel() {
	if (!State.filteredResponses.length) { showAlert('error', 'No responses to export'); return; }
	if (typeof XLSX === 'undefined') {
		showAlert('error', 'Excel export library is not loaded.');
		return;
	}

	const btn = document.querySelector('.btn-export-responses');
	const originalBtnHtml = btn?.innerHTML || '';
	if (btn) {
		btn.disabled = true;
		btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exporting...';
	}

	// ── Colour palette (matches system CSS vars) ──────────────────────────────
	const CLR = {
		blueDark  : '1A3A6B',   // --blue-dark  header backgrounds
		blueMid   : '2456A4',   // --blue-mid   subheader / accent rows
		blueLight : '4A90D9',   // --blue-light alternate / highlight
		blueXLight: 'D6E4F7',   // tint for zebra rows
		white     : 'FFFFFF',
		offWhite  : 'F4F7FC',   // very light tint for odd data rows
		textLight : 'FFFFFF',   // text on dark bg
		textDark  : '1A3A6B',   // text on light bg
		border    : 'B8CCE4',   // subtle border colour
		gold      : 'F5A623',   // accent for avg-score column
		goldLight : 'FEF3DC',   // tint for avg-score cells
	};

	// ── Style factories ───────────────────────────────────────────────────────
	const font  = (bold, color, sz = 11) => ({ name: 'Segoe UI', sz, bold, color: { rgb: color } });
	const fill  = rgb => ({ patternType: 'solid', fgColor: { rgb } });
	const align = (h, wrap = true) => ({ horizontal: h, vertical: 'center', wrapText: wrap });
	const border = () => ({
		top    : { style: 'thin', color: { rgb: CLR.border } },
		bottom : { style: 'thin', color: { rgb: CLR.border } },
		left   : { style: 'thin', color: { rgb: CLR.border } },
		right  : { style: 'thin', color: { rgb: CLR.border } },
	});

	// Primary header  (dark blue bg, white bold text, centered)
	const styleHeader = {
		font      : font(true, CLR.textLight, 11),
		fill      : fill(CLR.blueDark),
		alignment : align('center'),
		border    : border(),
	};
	// Sub-header / category label row  (mid-blue)
	const styleSubHeader = {
		font      : font(true, CLR.textLight, 11),
		fill      : fill(CLR.blueMid),
		alignment : align('left'),
		border    : border(),
	};
	// Even data row
	const styleDataEven = {
		font      : font(false, CLR.textDark),
		fill      : fill(CLR.white),
		alignment : align('left'),
		border    : border(),
	};
	// Odd data row (light blue tint)
	const styleDataOdd = {
		font      : font(false, CLR.textDark),
		fill      : fill(CLR.offWhite),
		alignment : align('left'),
		border    : border(),
	};
	// Numeric / score cell (centered)
	const styleScore = (odd) => ({
		font      : font(true, CLR.textDark),
		fill      : fill(odd ? CLR.goldLight : CLR.white),
		alignment : align('center', false),
		border    : border(),
		numFmt    : '0.00',
	});
	// Summary label cell
	const styleSummaryLabel = {
		font      : font(true, CLR.textLight, 11),
		fill      : fill(CLR.blueMid),
		alignment : align('left', false),
		border    : border(),
	};
	// Summary value cell
	const styleSummaryValue = {
		font      : font(false, CLR.textDark),
		fill      : fill(CLR.offWhite),
		alignment : align('left', false),
		border    : border(),
	};

	// ── Helper: apply a style object to a cell address in a sheet ────────────
	function styleCell(ws, addr, style) {
		if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
		ws[addr].s = style;
	}

	// ── Helper: apply a style to an entire row by column range ───────────────
	function styleRow(ws, rowIdx, colCount, style, scoreCol = -1) {
		for (let c = 0; c < colCount; c++) {
			const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
			if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
			ws[addr].s = (c === scoreCol) ? styleScore(rowIdx % 2 === 0) : style;
		}
	}

	// ── Helper: freeze the top row ────────────────────────────────────────────
	function freezeTopRow(ws) {
		ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
	}

	try {
		const dayId = document.getElementById('viewDaySelect')?.value || '';
		// Build report source mirroring getReportDataSourceId() but using viewDaySelect
		// (the Responses tab selector) instead of reportDaySelect (Report tab).
		const reportSourceId = (() => {
			if (State.workshopData?.program_type === 'container') {
				if (dayId) {
					return { id: parseInt(dayId), isRecord: true, isContainerAllDays: false };
				}
				return {
					id: State.containerWorkshopId || State.workshopData?.id || State.viewingId,
					isRecord: false,
					isContainerAllDays: true
				};
			}
			if (!State.isRecord) return { id: State.viewingId, isRecord: false, isContainerAllDays: false };
			return { id: State.workshopData?.eval_program_id || State.viewingId, isRecord: true, isContainerAllDays: false };
		})();
		const reportData = reportSourceId.id
			? await fetchReportData(reportSourceId, dayId)
			: { categories: [], columnAverages: [], speakerAverages: [], feedbackData: [] };

		const questionMetaList = Object.values(State.responseQuestionMap || {})
			.filter(meta => meta && meta.field && !meta.is_speaker)
			.sort((a, b) => {
				const sa = getQuestionColumnSortValue(a);
				const sb = getQuestionColumnSortValue(b);
				if (sa.catOrder !== sb.catOrder) return sa.catOrder - sb.catOrder;
				if (sa.qOrder !== sb.qOrder) return sa.qOrder - sb.qOrder;
				return sa.field.localeCompare(sb.field);
			});

		const speakerMetaList = Object.values(State.responseQuestionMap || {})
			.filter(meta => meta && meta.field && meta.is_speaker)
			.sort((a, b) => {
				const sa = getQuestionColumnSortValue(a);
				const sb = getQuestionColumnSortValue(b);
				if (sa.catOrder !== sb.catOrder) return sa.catOrder - sb.catOrder;
				if (sa.qOrder !== sb.qOrder) return sa.qOrder - sb.qOrder;
				return sa.field.localeCompare(sb.field);
			});

		const wb = XLSX.utils.book_new();

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 1 — Responses
		// ════════════════════════════════════════════════════════════════════
		const responseHeaders = [
			'Name', 'Sex', 'Participant Type', 'Designation',
			'Email', 'School/Office', 'Submitted At', 'Average Score',
			...questionMetaList.map(meta => meta.label || meta.field)
		];
		const avgScoreCol = 7; // 0-based index of "Average Score"

		const responseRows = State.filteredResponses.map(r => [
			toExcelSafeValue(r.full_name || r.name || 'Anonymous'),
			toExcelSafeValue(r.sex || ''),
			toExcelSafeValue(r.participant_type || ''),
			toExcelSafeValue(r.designation || ''),
			toExcelSafeValue(r.email || ''),
			toExcelSafeValue(r.school_office || ''),
			toExcelSafeValue(r.submitted_at || ''),
			toExcelSafeValue(r.average_score ?? r.average_rating ?? ''),
			...questionMetaList.map(meta => toExcelSafeValue(r[meta.field]))
		]);

		const responsesSheet = XLSX.utils.aoa_to_sheet([responseHeaders, ...responseRows]);
		responsesSheet['!autofilter'] = {
			ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: responseHeaders.length - 1 } })
		};
		responsesSheet['!cols'] = responseHeaders.map((h, i) => ({
			wch: i === avgScoreCol ? 14 : Math.min(Math.max(h.length + 2, 12), 48)
		}));
		responsesSheet['!rows'] = [{ hpt: 32 }]; // taller header row

		// Style header row
		styleRow(responsesSheet, 0, responseHeaders.length, styleHeader);

		// Style data rows with zebra striping; highlight avg-score column
		for (let r = 0; r < responseRows.length; r++) {
			const rowStyle = r % 2 === 0 ? styleDataEven : styleDataOdd;
			styleRow(responsesSheet, r + 1, responseHeaders.length, rowStyle, avgScoreCol);
		}

		freezeTopRow(responsesSheet);
		XLSX.utils.book_append_sheet(wb, responsesSheet, cleanSheetName('Responses', 'Responses'));

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 2 — Category Averages
		// ════════════════════════════════════════════════════════════════════
		const categoryDataRows = (reportData.categories || []).map(c => [
			toExcelSafeValue(c.category_name || c.category || ''),
			toExcelSafeValue(c.average_score ?? c.average ?? '')
		]);
		const categorySheet = XLSX.utils.aoa_to_sheet([
			['Category', 'Average Score'],
			...categoryDataRows
		]);
		categorySheet['!cols'] = [{ wch: 44 }, { wch: 16 }];
		categorySheet['!rows'] = [{ hpt: 28 }];

		styleRow(categorySheet, 0, 2, styleHeader);
		for (let r = 0; r < categoryDataRows.length; r++) {
			const rowStyle = r % 2 === 0 ? styleDataEven : styleDataOdd;
			styleRow(categorySheet, r + 1, 2, rowStyle, 1);
		}

		freezeTopRow(categorySheet);
		XLSX.utils.book_append_sheet(wb, categorySheet, cleanSheetName('Category Averages', 'Category Avg'));

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 3 — Question Averages  (grouped by category with sub-headers)
		// ════════════════════════════════════════════════════════════════════
		const questionAvgAoa  = [['Category', 'Question', 'Average Score']];
		const questionAvgMeta = [{ type: 'header' }]; // tracks row types for styling

		// ── Speaker section: use speakerAverages (structured, per-slot) ──────────
		// Each speaker gets a speaker-label sub-header row, then one row per criterion.
		const sortedSpk = [...(reportData.speakerAverages || [])].sort((a, b) =>
			String(a.day_sheet || '').localeCompare(String(b.day_sheet || '')) ||
			(a.slot_number || 0) - (b.slot_number || 0)
		);

		if (sortedSpk.length) {
			questionAvgAoa.push(['Resource Speakers', '', '']);
			questionAvgMeta.push({ type: 'category' });

			sortedSpk.forEach((sp, idx) => {
				const slot     = sp.slot_number || (idx + 1);
				const spName   = sp.speaker_name || `Speaker ${slot}`;
				const dayLabel = sp.day_sheet ? ` (${sp.day_sheet})` : '';
				const spLabel  = `Speaker ${slot}${dayLabel} — ${spName}`;

				// Speaker name row (light blue sub-sub-header)
				questionAvgAoa.push([spLabel, '', toExcelSafeValue(parseFloat(sp.overall_avg || 0).toFixed(2))]);
				questionAvgMeta.push({ type: 'speaker' });

				// Per-criterion rows
				for (const c of (sp.criteria || [])) {
					questionAvgAoa.push([
						'',
						toExcelSafeValue(c.criterion_label || ''),
						toExcelSafeValue(parseFloat(c.average_score || 0).toFixed(2))
					]);
					questionAvgMeta.push({ type: 'data' });
				}
			});
		}

		// ── Regular category sections ─────────────────────────────────────────
		let lastCat = null;
		const regularCols = (reportData.columnAverages || []).filter(c => c.category_name || c.category);

		for (const col of regularCols) {
			const catName = toExcelSafeValue(col.category_name || col.category || '');
			if (catName && catName !== lastCat) {
				questionAvgAoa.push([catName, '', '']);
				questionAvgMeta.push({ type: 'category' });
				lastCat = catName;
			}
			questionAvgAoa.push([
				'',
				toExcelSafeValue(col.question_header || col.question || ''),
				toExcelSafeValue(col.average_score ?? col.average ?? '')
			]);
			questionAvgMeta.push({ type: 'data' });
		}

		const questionAvgSheet = XLSX.utils.aoa_to_sheet(questionAvgAoa);
		questionAvgSheet['!cols'] = [{ wch: 48 }, { wch: 64 }, { wch: 16 }];
		questionAvgSheet['!rows'] = [{ hpt: 28 }];

		// Style for speaker name row (light blue, bold)
		const styleSpeakerRow = {
			font      : font(true, CLR.textLight, 10),
			fill      : fill(CLR.blueLight),
			alignment : align('left', false),
			border    : border(),
		};

		let dataRowCount = 0;
		for (let r = 0; r < questionAvgMeta.length; r++) {
			const mt = questionAvgMeta[r].type;
			if (mt === 'header') {
				styleRow(questionAvgSheet, r, 3, styleHeader);
			} else if (mt === 'category') {
				styleRow(questionAvgSheet, r, 3, styleSubHeader);
			} else if (mt === 'speaker') {
				styleRow(questionAvgSheet, r, 3, styleSpeakerRow, 2);
			} else {
				const rowStyle = dataRowCount % 2 === 0 ? styleDataEven : styleDataOdd;
				styleRow(questionAvgSheet, r, 3, rowStyle, 2);
				dataRowCount++;
			}
		}

		freezeTopRow(questionAvgSheet);
		XLSX.utils.book_append_sheet(wb, questionAvgSheet, cleanSheetName('Question Averages', 'Question Avg'));

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 4 — Speaker Ratings  (if any)
		// ════════════════════════════════════════════════════════════════════
		const speakerRows = [];
		for (const response of State.filteredResponses) {
			const baseName = response.full_name || response.name || 'Anonymous';
			for (const speaker of (response.speaker_ratings || [])) {
				const speakerScores = speakerMetaList
					.map(meta => parseFloat(speaker[meta.field]))
					.filter(value => Number.isFinite(value));
				const speakerAvg = speakerScores.length
					? (speakerScores.reduce((sum, v) => sum + v, 0) / speakerScores.length).toFixed(2)
					: '';
				speakerRows.push([
					toExcelSafeValue(baseName),
					toExcelSafeValue(speaker.speaker_number || ''),
					toExcelSafeValue(speaker.speaker_name || ''),
					toExcelSafeValue(speaker.speaker_designation || ''),
					toExcelSafeValue(speaker.speaker_topic || ''),
					...speakerMetaList.map(meta => toExcelSafeValue(speaker[meta.field])),
					toExcelSafeValue(speakerAvg)
				]);
			}
		}

		if (speakerRows.length) {
			const speakerHeaders = [
				'Participant Name', 'Speaker #', 'Speaker Name',
				'Designation', 'Topic',
				...speakerMetaList.map(meta => meta.label || meta.field),
				'Speaker Average'
			];
			const spAvgCol = speakerHeaders.length - 1;
			const speakerSheet = XLSX.utils.aoa_to_sheet([speakerHeaders, ...speakerRows]);
			speakerSheet['!cols'] = speakerHeaders.map((h, i) => ({
				wch: i === spAvgCol ? 16 : Math.min(Math.max(h.length + 2, 12), 40)
			}));
			speakerSheet['!rows'] = [{ hpt: 28 }];

			styleRow(speakerSheet, 0, speakerHeaders.length, styleHeader);
			for (let r = 0; r < speakerRows.length; r++) {
				const rowStyle = r % 2 === 0 ? styleDataEven : styleDataOdd;
				styleRow(speakerSheet, r + 1, speakerHeaders.length, rowStyle, spAvgCol);
			}

			freezeTopRow(speakerSheet);
			XLSX.utils.book_append_sheet(wb, speakerSheet, cleanSheetName('Speaker Ratings', 'Speaker Ratings'));
		}

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 5 — Feedback
		// ════════════════════════════════════════════════════════════════════
		// Resolve feedback column labels dynamically — same logic as buildReportHTML.
		// Prefers saved labels from feedback_labels / settings_snapshot; falls back to defaults.
		const exportFbLabels = (() => {
			const p = State.workshopData || {};
			const direct = p.feedback_labels || p.feedbackLabels;
			if (direct && typeof direct === 'object') return direct;
			try {
				const snap = JSON.parse(p.settings_snapshot || p.settingsSnapshot || '{}');
				const labels = snap?.feedback_labels || snap?.feedbackLabels;
				return (labels && typeof labels === 'object') ? labels : {};
			} catch (_) { return {}; }
		})();
		const hasAnySavedFbLabel = Object.values(exportFbLabels).some(v => typeof v === 'string' && v.trim());
		const fbLabelFor = (key, fallback) => {
			const v = exportFbLabels?.[key];
			return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
		};
		// Use already-loaded filteredResponses as feedback source — each response carries
		// feedback_expectations/improvements/insights/further directly (same fields the
		// view modal and AI summary use), so no separate API call is needed.
		const fbSource = State.filteredResponses;

		// Build feedback columns dynamically from actual data keys — same approach
		// as buildReportHTML so all exports stay in sync regardless of form changes.
		const FB_SKIP = new Set(['respondent_id', 'day_sheet', 'day', 'labels', 'id',
			'feedback_expectations', 'feedback_improvements', 'feedback_insights', 'feedback_further',
			'expectations', 'improvements', 'insights', 'further', 'met_expectations', 'additional_training']);
		const normFbKeyExcel = key =>
			String(key || '').replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')
				.replace(/\bDAY\s+\d+\b/gi, '').replace(/\s{2,}/g, ' ').trim();
		const rawByNormExcel = new Map();
		for (const fb of fbSource) {
			for (const rawKey of Object.keys(fb)) {
				if (FB_SKIP.has(rawKey)) continue;
				const norm = rawKey.startsWith('__pos_') ? rawKey : normFbKeyExcel(rawKey);
				if (!rawByNormExcel.has(norm)) rawByNormExcel.set(norm, []);
				if (!rawByNormExcel.get(norm).includes(rawKey)) rawByNormExcel.get(norm).push(rawKey);
			}
		}
		// Fall back to standard named fields if no raw keys found (old schema)
		if (!rawByNormExcel.size) {
			[
				['feedback_improvements', 'improvements'],
				['feedback_insights',     'insights'],
				['feedback_further',      'further'],
				['feedback_expectations', 'expectations'],
			].forEach(([a, b]) => {
				if (fbSource.some(fb => fb[a] || fb[b])) rawByNormExcel.set(a, [a, b]);
			});
		}
		const fbColsMaster = [...rawByNormExcel.entries()].map(([normKey, rawKeys], i) => ({
			key: normKey,
			label: normKey.startsWith('__pos_') ? ('Feedback ' + (i + 1)) : normKey,
			value: fb => rawKeys.map(k => fb[k] || '').find(v => v) || '',
		}));
		const fbCols = fbColsMaster;
		const cleanFbVal = v => {
			const s = String(v || '').replace(/\s+/g, ' ').trim();
			if (!s || FEEDBACK_NOISE_RX.test(s) || /^\d+(\.\d+)?$/.test(s) || /^[^a-zA-Z0-9]+$/.test(s)) return '';
			return s;
		};

		// Only include columns that have at least one meaningful value
		const activeFbCols = fbCols.filter(col =>
			fbSource.some(fb => cleanFbVal(col.value(fb)) !== '')
		);

		if (activeFbCols.length && fbSource.length) {
			// Group by day_sheet so rows are sorted by day then respondent order
			const fbByDay = new Map();
			for (const fb of fbSource) {
				const day = (fb.day_sheet || fb.day || '').trim() || '';
				if (!fbByDay.has(day)) fbByDay.set(day, []);
				fbByDay.get(day).push(fb);
			}

			const fbHeaders = ['Day', '#', ...activeFbCols.map(c => c.label)];
			const fbAoa     = [fbHeaders];
			const fbRowMeta = [{ type: 'header' }];

			for (const [day, rows] of fbByDay) {
				// Day label sub-header row (only if there are multiple days or a label exists)
				if (day) {
					fbAoa.push([day, '', ...activeFbCols.map(() => '')]);
					fbRowMeta.push({ type: 'day' });
				}

				let respondentNum = 0;
				for (const fb of rows) {
					const hasMeaning = activeFbCols.some(col => cleanFbVal(col.value(fb)) !== '');
					if (!hasMeaning) continue;
					respondentNum++;
					fbAoa.push([
						'',
						respondentNum,
						...activeFbCols.map(col => toExcelSafeValue(cleanFbVal(col.value(fb))))
					]);
					fbRowMeta.push({ type: 'data', idx: respondentNum });
				}
			}

			const feedbackSheet = XLSX.utils.aoa_to_sheet(fbAoa);
			feedbackSheet['!cols'] = [
				{ wch: 12 },  // Day
				{ wch: 5  },  // #
				...activeFbCols.map(() => ({ wch: 52 }))
			];
			// Taller rows for wrapped feedback text
			feedbackSheet['!rows'] = fbRowMeta.map((m, i) =>
				i === 0 ? { hpt: 28 } : (m.type === 'day' ? { hpt: 22 } : { hpt: 60 })
			);

			// Style: wrap text on feedback data cells
			const styleFbData = (odd) => ({
				font      : font(false, CLR.textDark),
				fill      : fill(odd ? CLR.offWhite : CLR.white),
				alignment : { horizontal: 'left', vertical: 'top', wrapText: true },
				border    : border(),
			});
			const styleFbNum = (odd) => ({
				font      : font(true, CLR.blueDark),
				fill      : fill(odd ? CLR.offWhite : CLR.white),
				alignment : { horizontal: 'center', vertical: 'top', wrapText: false },
				border    : border(),
			});

			let dataCount = 0;
			for (let r = 0; r < fbRowMeta.length; r++) {
				const mt = fbRowMeta[r].type;
				if (mt === 'header') {
					styleRow(feedbackSheet, r, fbHeaders.length, styleHeader);
				} else if (mt === 'day') {
					styleRow(feedbackSheet, r, fbHeaders.length, styleSubHeader);
				} else {
					const odd = dataCount % 2 !== 0;
					dataCount++;
					for (let c = 0; c < fbHeaders.length; c++) {
						const addr = XLSX.utils.encode_cell({ r, c });
						if (!feedbackSheet[addr]) feedbackSheet[addr] = { t: 'z', v: '' };
						feedbackSheet[addr].s = c === 1 ? styleFbNum(odd) : styleFbData(odd);
					}
				}
			}

			freezeTopRow(feedbackSheet);
			XLSX.utils.book_append_sheet(wb, feedbackSheet, cleanSheetName('Feedback', 'Feedback'));
		}

		// ════════════════════════════════════════════════════════════════════
		//  SHEET 6 — Export Summary
		// ════════════════════════════════════════════════════════════════════
		// Resolve dayId to a human-readable label for the summary sheet
		const dayLabel = (() => {
			if (!dayId) return 'All Days';
			const sel = document.getElementById('viewDaySelect');
			if (sel) {
				const opt = [...sel.options].find(o => o.value === String(dayId));
				if (opt?.textContent) return opt.textContent.trim();
			}
			return String(dayId);
		})();

		const summaryRows = [
			['Program / Workshop', toExcelSafeValue(State.workshopData?.title || 'Workshop')],
			['Selected Day',       toExcelSafeValue(dayLabel)],
			['Exported Rows',      toExcelSafeValue(State.filteredResponses.length)],
			['Generated At',       new Date().toLocaleString()],
			['Total Respondents (Averages)', toExcelSafeValue(reportData.totalRespondents ?? State.filteredResponses.length)]
		];
		const summarySheet = XLSX.utils.aoa_to_sheet([['Metric', 'Value'], ...summaryRows]);
		summarySheet['!cols'] = [{ wch: 32 }, { wch: 70 }];
		summarySheet['!rows'] = [{ hpt: 28 }];

		// Style header row of summary
		styleRow(summarySheet, 0, 2, styleHeader);
		// Style each label/value pair
		for (let r = 0; r < summaryRows.length; r++) {
			styleCell(summarySheet, XLSX.utils.encode_cell({ r: r + 1, c: 0 }), styleSummaryLabel);
			styleCell(summarySheet, XLSX.utils.encode_cell({ r: r + 1, c: 1 }), styleSummaryValue);
		}

		XLSX.utils.book_append_sheet(wb, summarySheet, cleanSheetName('Export Summary', 'Summary'));

		// ── Write file ────────────────────────────────────────────────────
		const safeTitle = (State.workshopData?.title || 'workshop')
			.replace(/[^a-zA-Z0-9 \-_]/g, '')
			.trim()
			.replace(/\s+/g, '_')
			.slice(0, 60) || 'workshop';
		const dateToken = new Date().toISOString().slice(0, 10);
		XLSX.writeFile(wb, `responses_${safeTitle}_${dateToken}.xlsx`, { cellStyles: true });

		showAlert('success', 'Responses exported to Excel successfully');
	} catch (error) {
		console.error('exportResponsesToExcel:', error);
		showAlert('error', 'Failed to export responses to Excel');
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.innerHTML = originalBtnHtml;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//  17. QAME REPORT  —  split into three layers
//       fetchReportData()  →  buildReportHTML()  →  renderReport()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Layer 1 — DATA FETCHING
 * All API calls in one place; returns a single plain data object.
 * Pure async, no DOM writes.
 */
async function fetchReportData(source, selectedDayId, isRecord) {
	// Accept either the legacy plain ID (number) or the new {id, isRecord, isContainerAllDays} object
	let workshopId, effectiveIsRecord;
	if (source && typeof source === 'object') {
		workshopId         = source.id;
		effectiveIsRecord  = source.isRecord;
	} else {
		workshopId        = source;
		effectiveIsRecord = isRecord;
	}

	// BUG FIX: for a container's "All Days Combined" export, `workshopId` is
	// definitely a workshop_id — never a valid program_id. Previously this list
	// always included a program_id fallback, so if the first (correct) call ever
	// came back with an empty category_averages array, it would retry using the
	// *same numeric ID* as a program_id. If that ID happened to collide with an
	// unrelated row (e.g. one day's own import sharing the ID sequence),
	// responses.php would silently return that single day's stats and respondent
	// count instead of the properly deduplicated combined total — producing
	// mismatches like "52 responses" in the PPT vs the true combined 97.
	const isContainerAllDays = source?.isContainerAllDays === true;
	const idParamOrder = isContainerAllDays
		? ['workshop_id']
		: (effectiveIsRecord ? ['program_id', 'workshop_id'] : ['workshop_id', 'program_id']);

	// For Excel records, responses.php filters by day_sheet string (e.g. "Day 1").
	// For system workshops, it filters by numeric workshop_day_id.
	// For container specific-day: source.id is already the import's program_id
	// so selectedDayId (also a program_id integer) must NOT be sent as day_sheet
	// — it would produce ?program_id=123&day_sheet=123 which matches nothing.
	const isContainerSpecificDay = source?.isRecord === true && !source?.isContainerAllDays &&
		State.workshopData?.program_type === 'container';
	const dayParam = (!selectedDayId || isContainerSpecificDay)
		? ''
		: (effectiveIsRecord
			? `&day_sheet=${encodeURIComponent(selectedDayId)}`
			: `&workshop_day_id=${encodeURIComponent(selectedDayId)}`);

	// Helper: try a URL and return parsed JSON or null
	const tryFetch = async url => {
		try {
			const res = await fetch(url, { credentials: 'include' });
			const json = await res.json();
			return json.success ? json : null;
		} catch (_) { return null; }
	};

	// 1. Category averages (try workshop_id first, fallback to program_id)
	let categories = [];
	let totalRespondents = State.responses.length;
	// True weighted overall average (AVG of every raw score row) — matches the
	// live dashboard's "OVER-ALL SCORE" exactly. null until a fetch supplies it;
	// callers should fall back to a mean-of-category-means only if this is null.
	let overallWeightedAverage = null;

	for (const param of idParamOrder) {
		const json = await tryFetch(
			`${API_URL}/responses.php?${param}=${workshopId}&categories=1${dayParam}`
		);
		if (json) {
			const cats = json.category_averages || json.categories || json.data?.categories || [];
			if (cats.length) {
				categories = cats;
				totalRespondents = json.total_respondents ?? totalRespondents;
				overallWeightedAverage = (json.overall_weighted_average !== undefined && json.overall_weighted_average !== null)
					? parseFloat(json.overall_weighted_average)
					: overallWeightedAverage;
				break;
			}
		}
	}

	// 2. Per-indicator (column) averages — try workshop_id then program_id
	let columnAverages = [];
	for (const param of idParamOrder) {
		const colJson = await tryFetch(`${API_URL}/responses.php?${param}=${workshopId}&column_averages=1${dayParam}`);
		const cols = colJson?.column_averages || colJson?.data?.column_averages || [];
		if (cols.length) { columnAverages = cols; break; }
	}

	// 3. Speaker averages — try workshop_id then program_id
	let speakerAverages = [];
	for (const param of idParamOrder) {
		const spkJson = await tryFetch(`${API_URL}/responses.php?${param}=${workshopId}&speaker_averages=1${dayParam}`);
		const spks = spkJson?.speaker_averages || spkJson?.data?.speaker_averages || [];
		if (spks.length) { speakerAverages = spks; break; }
	}

	// 4. Participant feedback — try the correct param order (same as other fetches)
	let feedbackData = [];
	for (const param of idParamOrder) {
		const fbJson = await tryFetch(`${API_URL}/responses.php?${param}=${workshopId}&feedback=1${dayParam}`);
		const fb = fbJson?.feedback || fbJson?.data?.feedback || [];
		if (fb.length) { feedbackData = fb; break; }
	}

	// If the API returns flat rows { feedback_label, feedback_value, respondent_id, day_sheet }
	// (new schema), pivot them into wide respondent objects { [label]: value, day_sheet, respondent_id }.
	// Wide rows (old schema, already have named fields) are left as-is.
	if (feedbackData.length > 0 && feedbackData[0].feedback_label !== undefined) {
		const byRespondent = new Map();

		// Normalise the raw Excel header into a stable column key by stripping the
		// day reference ("for DAY 1", "for DAY 2", etc.) from the label.
		// Without this, each day's feedback lands in a separate column because the
		// headers differ only in the day number ("…for DAY 1…" vs "…for DAY 2…").
		const normaliseFeedbackLabel = label =>
			String(label || '')
				.replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')   // strip "for DAY N …"
				.replace(/\bDAY\s+\d+\b/gi, '')                   // strip any remaining "DAY N"
				.replace(/\s{2,}/g, ' ')
				.trim();

		// First pass: build a map from raw label → normalised label, preferring the
		// shortest (most generic) form so all days collapse to the same key.
		const rawToNorm = new Map();
		for (const row of feedbackData) {
			const raw = (row.feedback_label || '').trim();
			if (!raw) continue;
			const norm = normaliseFeedbackLabel(raw);
			if (!rawToNorm.has(raw)) rawToNorm.set(raw, norm);
		}

		for (const row of feedbackData) {
			const key = `${row.respondent_id ?? ''}_${row.day_sheet ?? ''}`;
			if (!byRespondent.has(key)) {
				byRespondent.set(key, { respondent_id: row.respondent_id, day_sheet: row.day_sheet ?? '' });
			}
			const rawLabel = (row.feedback_label || '').trim();
			const normLabel = rawToNorm.get(rawLabel) || rawLabel;
			const value = (row.feedback_value || '').trim();
			if (normLabel) byRespondent.get(key)[normLabel] = value;
		}
		feedbackData = [...byRespondent.values()];
	}

	return { categories, totalRespondents, overallWeightedAverage, columnAverages, speakerAverages, feedbackData };
}

function getReportDataSourceId() {
	// Container programs: the report day selector value IS the program_id of that import.
	// When a specific day is selected, use that import's program_id.
	// When "All Days Combined" (empty value), use the container's workshop_id so
	// responses.php aggregates across ALL linked imports — not just the first one.
	if (State.workshopData?.program_type === 'container') {
		const dayVal = document.getElementById('reportDaySelect')?.value;
		if (dayVal) {
			// Specific day selected: return program_id of that import
			return { id: parseInt(dayVal), isRecord: true, isContainerAllDays: false };
		}
		// All days: return the original workshop_id for cross-import aggregation
		return {
			id: State.containerWorkshopId || State.workshopData?.id || State.viewingId,
			isRecord: false,
			isContainerAllDays: true
		};
	}
	if (!State.isRecord) return { id: State.viewingId, isRecord: false, isContainerAllDays: false };
	return { id: State.workshopData?.eval_program_id || State.viewingId, isRecord: true, isContainerAllDays: false };
}

const REPORT_STANDARD_CATEGORY_ORDER = [
	'Program Management and Operations',
	'Attainment of Objectives',
	'Delivery of Content',
	'Venue',
	'Meal',
	'Program Management Team'
];

// Kept in sync with normCatName() (PPT export, ~line 6416) and the server's
// program_dashboard.php normCat(). Previously this only lowercased/trimmed,
// so a raw imported category named "Program Management & Operations" never
// matched "Program Management and Operations" in REPORT_STANDARD_CATEGORY_ORDER
// (ampersand vs. "and"), silently falling through to the unmatched/"append at
// end" branch of getOrderedReportCategoryNames(). That's why Generate Preview
// showed Program Management and Operations LAST while PPT/Dashboard (which
// already normalized & -> and) showed it FIRST. Normalizing identically here
// keeps all three surfaces in the same order.
function normalizeReportCategoryName(name) {
	return String(name || '')
		.replace(/\u00a0/g, ' ')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/\(.*?\)/g, '')
		.replace(/[^a-z0-9 ]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function isExcludedReportCategory(name) {
	const n = normalizeReportCategoryName(name);
	return !n
		|| n === 'resource speaker'
		|| n === 'resource speakers'
		|| n === 'feedback'
		|| n === 'feedbacks';
}

function hasColumnCategoryMetadata(columnAverages) {
	if (!Array.isArray(columnAverages) || !columnAverages.length) return false;
	return columnAverages.some(c => {
		const name = c?.category_name || c?.category || '';
		return !isExcludedReportCategory(name);
	});
}

function getOrderedReportCategoryNames(categories, columnAverages) {
	const byNorm = new Map();
	const useColumnCategoriesOnly = hasColumnCategoryMetadata(columnAverages);
	const push = raw => {
		const name = String(raw || '').trim();
		if (!name || isExcludedReportCategory(name)) return;
		const norm = normalizeReportCategoryName(name);
		if (!byNorm.has(norm)) byNorm.set(norm, name);
	};

	(columnAverages || []).forEach(c => push(c.category_name || c.category));
	if (!useColumnCategoriesOnly) {
		(categories || []).forEach(c => push(c.category_name || c.name));
	}

	const ordered = [];
	REPORT_STANDARD_CATEGORY_ORDER.forEach(std => {
		const norm = normalizeReportCategoryName(std);
		if (byNorm.has(norm)) {
			ordered.push(byNorm.get(norm));
			byNorm.delete(norm);
		}
	});

	byNorm.forEach(name => ordered.push(name));
	return ordered;
}

function getCategoryAverageForReport(categories, columnAverages, categoryName) {
	const target = normalizeReportCategoryName(categoryName);
	if (!target) return null;

	// Same fix as the overall average (see line ~3930) and the PPT/Dashboard:
	// trust the API's authoritative per-category average_score first. It's a
	// true weighted average of that category's responses; recomputing an
	// unweighted mean from columnAverages ignores how many respondents
	// answered each question and drifts for multi-indicator categories
	// (e.g. "Program Management & Operations").
	const cat = (categories || []).find(c =>
		normalizeReportCategoryName(c.category_name || c.name) === target
	);
	if (cat) {
		const val = parseFloat(cat.average_score ?? cat.mean ?? NaN);
		if (!isNaN(val)) return val;
	}

	// Fallback: no authoritative category record found, so fall back to an
	// unweighted mean of the matching columnAverages rows.
	const rows = (columnAverages || []).filter(c =>
		normalizeReportCategoryName(c.category_name || c.category) === target
	);
	if (!rows.length) return null;

	const nums = rows
		.map(r => parseFloat(r.average_score))
		.filter(n => !isNaN(n));
	if (!nums.length) return null;

	return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ─── QAME Super Category grouping (Reports tab preview + Word export) ──────
// Whether report sections should be merged per configured QAME super category
// (qame_categories.php / qame_category_mappings) instead of shown one raw
// category at a time. Defaults to ON, matching the dashboard's
// updateSuperCategories() and the PPT export, which have always merged.
// Persisted so the choice survives across programs and page reloads.
const SUPER_CATEGORY_GROUPING_KEY = 'qatame_group_by_super_category';

function getSuperCategoryGroupingPreference() {
	return localStorage.getItem(SUPER_CATEGORY_GROUPING_KEY) !== '0';
}

function setSuperCategoryGroupingPreference(enabled) {
	localStorage.setItem(SUPER_CATEGORY_GROUPING_KEY, enabled ? '1' : '0');
}

// Toggle handler wired to the checkbox in the Reports tab (qatame.html).
// Re-runs the preview immediately so the change is visible without another click.
function onSuperCategoryGroupingToggle(checkbox) {
	setSuperCategoryGroupingPreference(!!checkbox.checked);
	if (typeof generateQAMEReport === 'function' && document.getElementById('reportPreviewContainer')) {
		generateQAMEReport();
	}
}

/**
 * Builds the ordered list of report sections (one per row-group), respecting
 * the super-category grouping preference.
 *
 * When grouping is ON and super categories are configured: one section per
 * QAME super category, combining the indicator rows of every raw category it
 * maps to, scored as the mean of those raw categories' own average_score
 * values — exactly mirroring updateSuperCategories() in
 * workshop-dashboard.js and the PPT export's merge logic, so the Reports tab
 * preview, the Word export, the dashboard, and the PPT export all agree.
 *
 * When grouping is OFF (or no super categories are configured / the fetch
 * fails): one section per raw category, unchanged from the original
 * behavior — each section's average is looked up individually via
 * getCategoryAverageForReport.
 *
 * Returns an array of { name, title, rows, avgSource } where avgSource is
 * either a number (merged super-category average) or a category-name string
 * (for buildIndicatorTable to look up individually).
 */
async function buildReportCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback) {
	const reportCategoryNames = getOrderedReportCategoryNames(categories, columnAverages);

	const buildRawSection = name => {
		const fallback = useLegacyFallback ? (fallbackByCategory[normalizeReportCategoryName(name)] || []) : [];
		const rows = buildCategoryBasedIndicatorRows(columnAverages, name, fallback);
		return { name, title: getReportCategoryTitle(name), rows, avgSource: name };
	};

	let qameSuperCats = [];
	if (getSuperCategoryGroupingPreference()) {
		try {
			const qameRes = await fetch(`${API_URL}/qame_categories.php`, { credentials: 'include' });
			const qameJson = await qameRes.json();
			if (qameJson.success) qameSuperCats = qameJson.data || [];
		} catch (_) { /* fall back to ungrouped raw categories below */ }
	}

	if (!qameSuperCats.length) {
		return reportCategoryNames.map(buildRawSection).filter(s => Array.isArray(s.rows) && s.rows.length > 0);
	}

	const usedNorms = new Set();
	const sections = [];

	qameSuperCats
		.slice()
		.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
		.forEach(sc => {
			const mappedNorms = (sc.mapped_categories || []).map(m => normalizeReportCategoryName(m.name));
			const matchedNames = reportCategoryNames.filter(n => mappedNorms.includes(normalizeReportCategoryName(n)));
			if (!matchedNames.length) return; // mirrors dashboard: super categories with no data are skipped

			let rows = [];
			matchedNames.forEach(n => {
				usedNorms.add(normalizeReportCategoryName(n));
				const fallback = useLegacyFallback ? (fallbackByCategory[normalizeReportCategoryName(n)] || []) : [];
				rows = rows.concat(buildCategoryBasedIndicatorRows(columnAverages, n, fallback));
			});
			if (!rows.length) return;

			const catScores = matchedNames
				.map(n => getCategoryAverageForReport(categories, columnAverages, n))
				.filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
			const mergedAvg = catScores.length ? catScores.reduce((a, b) => a + b, 0) / catScores.length : null;

			sections.push({ name: sc.name, title: sc.name, rows, avgSource: mergedAvg });
		});

	// Unmapped raw categories still get their own section, same as the
	// dashboard's "unmappedCategories" fallback, so newly imported categories
	// that aren't configured into a super category yet don't silently vanish.
	reportCategoryNames.forEach(n => {
		if (usedNorms.has(normalizeReportCategoryName(n))) return;
		const section = buildRawSection(n);
		if (section.rows.length) sections.push(section);
	});

	return sections;
}

/**
 * Builds one section PER RAW CATEGORY, always — regardless of the super-
 * category grouping preference. Used for the numbered per-category
 * indicator breakdown (section 2, 3, 4... below "SUMMARY OF RATINGS"), which
 * should never merge two raw categories' indicator rows into a single table
 * even when "Group by Super Category" is on and the summary table above
 * shows a combined row for them. Each section's average is looked up
 * individually via getCategoryAverageForReport, exactly like the grouping-
 * OFF branch of buildReportCategorySections.
 */
function buildRawCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback) {
	const reportCategoryNames = getOrderedReportCategoryNames(categories, columnAverages);
	const buildRawSection = name => {
		const fallback = useLegacyFallback ? (fallbackByCategory[normalizeReportCategoryName(name)] || []) : [];
		const rows = buildCategoryBasedIndicatorRows(columnAverages, name, fallback);
		return { name, title: getReportCategoryTitle(name), rows, avgSource: name };
	};
	return reportCategoryNames.map(buildRawSection).filter(s => Array.isArray(s.rows) && s.rows.length > 0);
}

function getReportCategoryTitle(categoryName) {
	const n = normalizeReportCategoryName(categoryName);
	if (n === 'delivery of content') return 'DELIVERY OF THE CONTENT';
	if (n === 'venue') return 'TRAINING VENUE';
	if (n === 'meal') return 'MEALS';
	return String(categoryName || '').toUpperCase();
}

// BUG FIX: this used to only try stripping the raw DB category name (e.g.
// "Delivery of Content"). But getReportCategoryTitle() maps that same
// category to a different display wording ("DELIVERY OF THE CONTENT" — note
// the added "THE"), and some imported Excel headers are prefixed with that
// display wording rather than the raw name. When the raw name didn't match,
// stripping silently failed, leaving the prefix in place — so a header like
// "DELIVERY OF THE CONTENT.Meet expectations" no longer matched the
// unprefixed "Meet expectations" row from another day's sheet, and the
// dedup step (which compares stripped labels) kept both as if they were
// different questions. Now this accepts one name or a list of candidate
// names/aliases and tries each until one actually strips something.
// Builds a regex source for a category name that matches regardless of
// "&" vs "and" wording (imports and category records disagree on this —
// e.g. "Program Management & Operations" vs "...and Operations", see the
// notes near normalizeReportCategoryName/REPORT_STANDARD_CATEGORY_ORDER
// above) and regardless of exact whitespace run length between words.
// Without this, stripCategoryPrefixFromIndicatorLabel did a literal string
// match against the category's stored name, so whichever spelling wasn't
// stored on this record's category never stripped from the header text,
// silently leaving the category name prefix visible in the report.
function buildFlexibleCategoryNamePattern(cat) {
	return String(cat || '')
		.trim()
		.split(/\s+/)
		.map(word => (/^(?:and|&)$/i.test(word) ? '(?:and|&)' : word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
		.join('\\s+');
}

function stripCategoryPrefixFromIndicatorLabel(label, categoryNames) {
	const raw = String(label || '').trim();
	if (!raw) return raw;

	const candidates = (Array.isArray(categoryNames) ? categoryNames : [categoryNames])
		.map(c => String(c || '').trim())
		.filter(Boolean);

	for (const cat of candidates) {
		const escaped = buildFlexibleCategoryNamePattern(cat);
		const catWithOptionalQualifiers = `${escaped}(?:\\s*\\([^)]*\\))*`;
		const patterns = [
			new RegExp(`^\\s*${catWithOptionalQualifiers}\\s*[.\-:|/\\u2013\\u2014]+\\s*`, 'i'),
			new RegExp(`^\\s*\\[\\s*${escaped}\\s*\\]\\s*`, 'i'),
			new RegExp(`^\\s*\\(\\s*${escaped}\\s*\\)\\s*`, 'i'),
		];

		for (const pattern of patterns) {
			const stripped = raw.replace(pattern, '').trim();
			if (stripped && stripped !== raw) return stripped;
		}
	}

	return raw;
}

function buildCategoryBasedIndicatorRows(columnAverages, categoryName, fallbackRows = []) {
	const target = normalizeReportCategoryName(categoryName);

	if (!target || !Array.isArray(columnAverages) || !columnAverages.length) {
		return fallbackRows;
	}

	// Try stripping using both the raw DB category name AND its mapped display
	// title (e.g. "Delivery of Content" AND "DELIVERY OF THE CONTENT") since
	// imported Excel headers may be prefixed with either wording.
	const displayTitle = getReportCategoryTitle(categoryName);
	const stripCandidates = [categoryName, displayTitle];

	const rows = columnAverages
		.filter(c => normalizeReportCategoryName(c.category_name || c.category || '') === target)
		.sort((a, b) => (Number(a.sort_order) || 999999) - (Number(b.sort_order) || 999999))
		.map(c => {
			const rawLabel = String(c.question_header || c.question || '').trim();
			const label = stripCategoryPrefixFromIndicatorLabel(rawLabel, stripCandidates) || 'Untitled indicator';
			const n = parseFloat(c.average_score || 0);
			const score = !isNaN(n) && n > 0 ? n.toFixed(2) : '—';
			return {
				label,
				score,
				desc: score !== '—' ? getInterpretation(parseFloat(score), 'category') : '—'
			};
		});

	if (!rows.length) return fallbackRows;

	const seen = new Set();
	const deduped = [];
	for (const row of rows) {
		const key = normalizeReportCategoryName(row.label);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		deduped.push(row);
	}

	return deduped.length ? deduped : fallbackRows;
}

/**
 * Layer 2 — HTML BUILDING
 * Pure function: takes data + program metadata, returns an HTML string.
 * No fetches, no DOM writes — easy to unit-test.
 */
// ── Shared constants/helpers used by buildReportHTML, exportReportToWord, exportReportToPPT ──
const FEEDBACK_NOISE_RX = /^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i;

function cleanFeedbackValues(values) {
	return values
		.map(v => String(v || '').replace(/\s+/g, ' ').trim())
		.filter(v => v && !FEEDBACK_NOISE_RX.test(v) && !/^\d+(\.\d+)?$/.test(v) && !/^[^a-zA-Z0-9]+$/.test(v));
}

async function buildReportHTML(p, data, scales) {
	const { categories, totalRespondents, columnAverages, speakerAverages, feedbackData } = data;

	/**
	 * Normalise a question_header string so we can do fuzzy matching:
	 * strip leading/trailing whitespace and collapse \u00a0 (non-breaking space) → space.
	 */
	const normalise = s => (s || '').replace(/\u00a0/g, ' ').trim().toLowerCase();

	/**
	 * Find a column average whose normalised header contains ALL of the
	 * supplied tokens (split by '|'). Each token is trimmed and matched
	 * with a simple substring check against the normalised header.
	 * The FIRST matching column_averages row whose header does NOT end with
	 * a digit (i.e. slot-1 / no suffix) is preferred; otherwise the first
	 * match is returned.
	 */
	const getColAvg = (tokens, excludeDigitSuffix = false) => {
		const parts = tokens.split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
		const matches = columnAverages.filter(c => {
			const h = normalise(c.question_header || c.question || '');
			return parts.every(p => h.includes(p));
		});
		if (!matches.length) return null;
		// prefer non-suffixed row (slot 1) when excludeDigitSuffix is true
		if (excludeDigitSuffix) {
			const nosuffix = matches.find(c => !/\d$/.test(normalise(c.question_header)));
			return parseFloat((nosuffix || matches[0]).average_score || 0);
		}
		return parseFloat(matches[0].average_score || 0);
	};

	/**
	 * Like getColAvg but for a specific speaker slot suffix.
	 * slot=1 → no digit suffix (or suffix "1"), slot=2 → "2", etc.
	 */
	const getColAvgSlot = (baseTokens, slot) => {
		const parts = baseTokens.split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
		const suffix = slot === 1 ? '' : String(slot);
		const col = columnAverages.find(c => {
			const h = normalise(c.question_header || c.question || '');
			if (!parts.every(p => h.includes(p))) return false;
			const endsWithDigit = /\d$/.test(h);
			if (suffix === '') return !endsWithDigit || h.endsWith('1');
			return h.endsWith(suffix);
		});
		return col ? parseFloat(col.average_score || 0) : null;
	};

	const fmtScore = v => {
		const n = parseFloat(v);
		return isNaN(n) || n === 0 ? '—' : n.toFixed(2);
	};

	// ── Saved feedback question labels (Excel import) ───────────────────────
	const savedFbLabels = (() => {
		const direct = p?.feedback_labels || p?.feedbackLabels;
		if (direct && typeof direct === 'object') return direct;
		const snapStr = p?.settings_snapshot || p?.settingsSnapshot || '';
		if (!snapStr) return {};
		try {
			const snap = JSON.parse(snapStr);
			const labels = snap?.feedback_labels || snap?.feedbackLabels || null;
			return (labels && typeof labels === 'object') ? labels : {};
		} catch (_) {
			return {};
		}
	})();
	const hasAnySavedFbLabel = Object.values(savedFbLabels || {}).some(v => typeof v === 'string' && v.trim());
	const fbLabel = (key, fallback) => {
		const v = savedFbLabels?.[key];
		return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
	};

	const makeRow = (tokens, label) => {
		const s = fmtScore(getColAvg(tokens, true));
		return { label, score: s, desc: s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—' };
	};

	const TH = 'border:1px solid #aaa;padding:6px 8px;background:#ffffff;color:#000;font-weight:bold;';
	const THC = TH + 'text-align:center;';
	const TD = 'border:1px solid #aaa;padding:5px 8px;';
	const TDC = TD + 'text-align:center;';
	const TDI = TD + 'font-style:italic;';
	const AVG = TD + 'background:#f2f2f2;font-weight:bold;';
	const AVGC = TDC + 'background:#f2f2f2;font-weight:bold;';
	const AVGI = TDI + 'background:#f2f2f2;font-weight:bold;';

	const buildIndicatorTable = (rows, scaleType = 'category', avgSource = null) => {
		const bodyRows = rows.map((r, i) => `
      <tr>
        <td style="${TDC}width:36px;">${i + 1}</td>
        <td style="${TD}">${r.label}</td>
        <td style="${TDC}width:110px;">${r.score}</td>
        <td style="${TDI}width:160px;">${r.desc}</td>
      </tr>`).join('');

		// avgSource can be:
		//  - a number: an already-computed authoritative average (e.g. a merged
		//    QAME super-category score — the mean of its mapped raw categories'
		//    own averages, matching updateSuperCategories() in
		//    workshop-dashboard.js and the PPT export).
		//  - a string: a single raw category name to look up via
		//    getCategoryAverageForReport (a true weighted average of that
		//    category's raw responses).
		//  - null/missing: fall back to a local mean of the already-rounded
		//    indicator scores below (only used when no authoritative figure is
		//    available, e.g. legacy data with no category metadata).
		// Re-averaging already-rounded scores can drift by a cent or two due to
		// double rounding and unequal respondent counts per indicator, so the
		// authoritative figure is always preferred when we have one.
		let authoritative = null;
		if (typeof avgSource === 'number') {
			authoritative = avgSource;
		} else if (typeof avgSource === 'string' && avgSource) {
			authoritative = getCategoryAverageForReport(categories, columnAverages, avgSource);
		}
		let avg;
		if (authoritative !== null && authoritative !== undefined && !isNaN(authoritative)) {
			avg = authoritative.toFixed(2);
		} else {
			const nums = rows.map(r => parseFloat(r.score)).filter(n => !isNaN(n));
			avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : '—';
		}
		const avgDesc = avg !== '—' ? getInterpretation(parseFloat(avg), scaleType) : '—';

		return `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">
      <thead><tr>
        <th style="${THC}width:36px;"></th>
        <th style="${TH}text-align:left;">INDICATORS</th>
        <th style="${THC}width:110px;">NUMERICAL<br>RATING</th>
        <th style="${TH}width:160px;">DESCRIPTIVE<br>RATING</th>
      </tr></thead>
      <tbody>
        ${bodyRows}
        <tr>
          <td style="${AVG}" colspan="2">Average</td>
          <td style="${AVGC}">${avg}</td>
          <td style="${AVGI}">${avgDesc}</td>
        </tr>
      </tbody>
    </table>`;
	};

	// ── Section indicator rows ──────────────────────────────────────────────
	// Tokens are matched against the normalised question_header in column_averages.
	// Use '|' to AND multiple tokens when a single word would be ambiguous.
	const pmFallback = [
		makeRow('delivered as planned', 'The activity/program was delivered as planned'),
		makeRow('managed efficiently', 'The activity/program was managed efficiently'),
		makeRow('well-structured', 'The activity/program was well-structured'),
		makeRow('training matrix', 'The activity/program has well-detailed and organized Training Matrix'),
	];
	const objFallback = [
		makeRow('objectives were clearly defined', 'The objectives were clearly defined'),
		makeRow('objectives were attainable', 'The objectives were attainable'),
		makeRow('smart', 'The objectives were SMART'),
		makeRow('presented prior to the session', 'The objectives were presented prior to the session'),
	];
	const contentFallback = [
		makeRow('reliable sources', 'Content delivery was based on reliable sources'),
		makeRow('effective in generating learning', 'The discussions were effective in generating learning'),
		makeRow('meet expectations', 'Met expectations'),
		makeRow('comprehensiveness of the slide', 'Quality and comprehensiveness of the slide presentation'),
		makeRow('materials and handouts', 'Materials and handouts were relevant, adequate and helpful'),
		makeRow('presentation of ideas was organized', 'The presentation of ideas was organized'),
		makeRow('training content|appropriate', "Content was appropriate to trainees' roles and responsibilities"),
	];
	const venueFallback = [
		makeRow('adequately lit', 'The conference hall was adequately lit'),
		makeRow('well ventilated', 'The conference hall was well ventilated'),
		makeRow('soundproofing', 'Adequate soundproofing'),
		makeRow('sufficient space for the activity', 'With sufficient space for the activity'),
		makeRow('clean space', 'Clean space'),
		makeRow('equipment was serviceable', 'Equipment was serviceable'),
		makeRow('clean comfort rooms', 'Clean comfort rooms with adequate toiletries and water supply'),
	];
	const mealsFallback = [
		makeRow('sufficient quantity', 'Sufficient quantity'),
		makeRow('sufficient variety', 'Sufficient variety'),
		makeRow('generally healthy', 'Generally healthy'),
		makeRow('utensils|spoons', 'Utensils were clean'),
		makeRow('meals are served on time', 'Meals were served on time'),
		makeRow('portioning of food', 'Followed protocol for holding, serving, and portioning of food'),
	];
	const pmtFallback = [
		makeRow('courteous', 'Courteous'),
		makeRow('efficient', 'Efficient'),
		makeRow('responsive to the needs', 'Responsive to the needs of participants'),
		makeRow('safe work techniques', 'Safe work techniques'),
		makeRow('emcee', 'The emcee/host spoke with clarity'),
	];

	const fallbackByCategory = {
		'program management and operations': pmFallback,
		'attainment of objectives': objFallback,
		'delivery of content': contentFallback,
		'venue': venueFallback,
		'meal': mealsFallback,
		'program management team': pmtFallback,
	};

	const reportCategoryNames = getOrderedReportCategoryNames(categories, columnAverages);
	const useLegacyFallback = !hasColumnCategoryMetadata(columnAverages);
	const categorySections = await buildReportCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback);
	// Per-category breakdown sections (2., 3., 4. ...) always show ONE RAW
	// CATEGORY per section, even when "Group by Super Category" is on and
	// the summary table above merges categories into a single row. Without
	// this, two unrelated raw categories mapped to the same super category
	// (e.g. "Program Management and Operations" + "Program Management Team")
	// would have their indicator rows concatenated into one combined table.
	const detailSections = buildRawCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback);

	const categorySectionsHtml = detailSections.map((section, i) => `
  <p style="margin-top:20px;margin-bottom:6px;font-weight:bold;font-family:'Arial',sans-serif;font-size:12px;">&nbsp;&nbsp;&nbsp;&nbsp;${i + 2}.&nbsp;&nbsp;${section.title}</p>
  ${buildIndicatorTable(section.rows, 'category', section.avgSource)}`).join('');

	const speakerSectionNumber = detailSections.length + 2;

	// ── Summary rows ────────────────────────────────────────────────────────
	// Built from categorySections (not the raw reportCategoryNames) so this
	// summary table reflects the configured QAME super-category grouping —
	// a merged super category shows one row here, combining the average of
	// the raw categories it's made of. The detailed breakdown below stays
	// per-raw-category regardless (see detailSections above).
	const resolveSummaryAvg = key => typeof key === 'number' ? key : getCategoryAverageForReport(categories, columnAverages, key);
	const summaryDefs = categorySections.map(section => ({ label: section.title, key: section.avgSource }));
	const summaryRows = summaryDefs.map((sd, i) => {
		const raw = resolveSummaryAvg(sd.key);
		const s = raw !== null ? raw.toFixed(2) : '—';
		const desc = s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—';
		return `<tr>
		<td style="${TDC}">${i + 1}</td>
		<td style="${TD}">${sd.label}</td>
		<td style="${TDC}">${s}</td>
		<td style="${TDI}">${desc}</td>
		</tr>`;
	}).join('');

	const catScores = summaryDefs
		.map(sd => resolveSummaryAvg(sd.key))
		.filter(n => n !== null && !isNaN(n) && n > 0);
	// Same fix as the PPT/Word exports: prefer the API's true weighted average
	// (matches the live dashboard) over an unweighted mean of category averages.
	const overallAvg = (data?.overallWeightedAverage !== null && data?.overallWeightedAverage !== undefined && !isNaN(data.overallWeightedAverage))
		? data.overallWeightedAverage.toFixed(2)
		: (catScores.length ? (catScores.reduce((a, b) => a + b, 0) / catScores.length).toFixed(2) : '—');
	const overallDesc = overallAvg !== '—' ? getInterpretation(parseFloat(overallAvg), 'overall') : '—';

	// ── Speaker sections ────────────────────────────────────────────────────
	// These tokens match the DB question_header for Resource Speaker columns.
	// Slot suffix: slot 1 → no trailing digit (or "1"), slot 2 → "2", etc.
	const SPEAKER_CRITERIA = [
		{ label: 'Knowledgeable of the topic and well organized', token: 'knowledgeable of the topic' },
		{ label: 'The Resource Person was well prepared', token: 'resource person was well prepared' },
		{ label: 'Materials and presentations were relevant', token: 'materials and presentations were relevant' },
		{ label: 'Started and ended on time', token: 'start and end on time' },
		{ label: 'The Resource Speaker was engaging and supportive', token: 'engaging and supportive' },
		{ label: 'Demonstrated a clear understanding of the content', token: 'clear understanding of the content' },
	];

	const realSpeakerNames = (p.days || []).flatMap(d => (d.speakers || []).map(s => s.name?.trim()).filter(Boolean));
	const sortedSpk = [...speakerAverages].sort((a, b) =>
		String(a.day_sheet || '').localeCompare(String(b.day_sheet || '')) ||
		(a.slot_number || 0) - (b.slot_number || 0)
	);
	// Group speakers into one summary row per person, merging their scores
	// across every day/session they appeared in — even when the designation
	// text after the name is entered slightly differently between days
	// (e.g. "Jerwin C. Roque, PhD SEPS Planning and Research" vs
	// "Jerwin C. Roque, PhD, SEPS Planning and Research").
	// SAFEGUARD: if two people's "Name, Title" blocks get concatenated into a
	// single field (a joint session where two speakers share one score, e.g.
	// "Jerwin C. Roque, PhD SEPS ... Ma. Aurea Rhodora DC. Geronimo, PhD SGOD
	// Chief"), that entry is much longer than a normal solo entry for either
	// person. So within each core-name group we only merge entries whose
	// overall length is close to one another; an entry far longer than its
	// group's other entries is kept as its own distinct row instead, since
	// that score belongs to the pair, not to either person individually.
	const SPEAKER_LENGTH_DIFF_THRESHOLD = 25;
	const speakerClustersByCore = new Map(); // coreName -> [{ name, scores, refLen }]
	const addSpeakerScore = (rawName, rawAvg) => {
		const s = (rawName || '').replace(/\s+/g, ' ').trim();
		const commaIdx = s.indexOf(',');
		const core = (commaIdx >= 0 ? s.slice(0, commaIdx) : s).replace(/\s+/g, ' ').trim().toLowerCase();
		if (!speakerClustersByCore.has(core)) speakerClustersByCore.set(core, []);
		const clusters = speakerClustersByCore.get(core);
		let best = null, bestDiff = Infinity;
		for (const c of clusters) {
			const diff = Math.abs(c.refLen - s.length);
			if (diff < bestDiff) { bestDiff = diff; best = c; }
		}
		if (best && bestDiff <= SPEAKER_LENGTH_DIFF_THRESHOLD) {
			if (!isNaN(rawAvg) && rawAvg > 0) best.scores.push(rawAvg);
		} else {
			const cluster = { name: rawName, scores: [], refLen: s.length };
			if (!isNaN(rawAvg) && rawAvg > 0) cluster.scores.push(rawAvg);
			clusters.push(cluster);
		}
	};

	let speakerSectionsHtml = '';

	if (sortedSpk.length) {
		sortedSpk.forEach((sp, idx) => {
			const slot = sp.slot_number || (idx + 1);
			const spName = realSpeakerNames[idx] || sp.speaker_name || `Speaker ${slot}`;
			const criteria = sp.criteria || [];

			const speakerRows = SPEAKER_CRITERIA.map((def, ci) => {
				let s = null;

				// 1. Try structured criteria array from speakerAverages
				if (criteria.length) {
					const c = criteria[ci] || criteria.find(c =>
						normalise(c.criterion_label || '').includes(def.token.slice(0, 12))
					);
					if (c) s = parseFloat(c.average_score);
				}

				// 2. Fall back to column_averages with slot-aware suffix matching
				if (s === null || isNaN(s)) {
					s = getColAvgSlot(def.token, slot);
				}

				// 3. Last resort: use the speaker's overall average
				if (s === null || isNaN(s)) s = parseFloat(sp.overall_avg || 0);

				const sStr = !isNaN(s) && s > 0 ? s.toFixed(2) : '—';
				return { label: def.label, score: sStr, desc: sStr !== '—' ? getInterpretation(parseFloat(sStr), 'speaker') : '—' };
			});

			speakerSectionsHtml += `
	<p style="margin-top:20px;margin-bottom:6px;font-weight:bold;font-family:'Arial',sans-serif;font-size:12px;">&nbsp;&nbsp;&nbsp;&nbsp;${speakerSectionNumber}.${idx + 1}&nbsp;&nbsp;RESOURCE PERSON (DAY ${sp.day_sheet || idx + 1}-SESSION ${sp.slot_number || idx + 1}) ${escapeHtml(spName)}</p>
        ${buildIndicatorTable(speakerRows, 'speaker')}`.replace(/DAY\s+Day\b/i, 'Day');

			addSpeakerScore(spName, parseFloat(sp.overall_avg || 0));
		});
	} else if (realSpeakerNames.length) {
		realSpeakerNames.forEach((name, idx) => {
			const rows = SPEAKER_CRITERIA.map(def => ({ label: def.label, score: '—', desc: '—' }));
			speakerSectionsHtml += `
        <p style="margin-top:18px;margin-bottom:4px;"><strong>${speakerSectionNumber}.${idx + 1} RESOURCE PERSON - ${escapeHtml(name)}</strong></p>
        ${buildIndicatorTable(rows, 'speaker')}`;
			addSpeakerScore(name, NaN);
		});
	} else {
		speakerSectionsHtml = `<p style="color:#9ca3af;font-style:italic;margin-top:8px;">No speaker data available.</p>`;
	}

	// Flatten the clusters into the final summary rows, one row per unique
	// speaker, averaging scores across all their appearances (days/sessions).
	// Kept as row data (not pre-built HTML) so the table below can be built
	// with the same column layout as the Word export's Section III table.
	const speakerSummaryRows = [];
	if (speakerClustersByCore.size) {
		speakerClustersByCore.forEach(clusters => clusters.forEach(({ name, scores }) => {
			if (scores.length) {
				const combinedAvg = (scores.reduce((sum, v) => sum + v, 0) / scores.length).toFixed(2);
				speakerSummaryRows.push([name, combinedAvg, getInterpretation(parseFloat(combinedAvg), 'speaker')]);
			} else {
				speakerSummaryRows.push([name, '—', '—']);
			}
		}));
	}

	// ── Participant feedback (real data) ────────────────────────────────────
	const FEEDBACK_NOISE_RX = /^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i;
	const cleanFeedbackCellValue = v => {
		const s = String(v || '').replace(/\s+/g, ' ').trim();
		if (!s) return '';
		if (FEEDBACK_NOISE_RX.test(s)) return '';
		if (/^\d+(\.\d+)?$/.test(s)) return '';
		if (/^[^a-zA-Z0-9]+$/.test(s)) return '';
		return s;
	};
	const isMeaningfulFeedbackCellValue = v => cleanFeedbackCellValue(v) !== '';

	// Build feedback columns dynamically from the actual label keys present in the data.
	// New schema: keys are the real Excel column header strings.
	// Old schema: keys are positional placeholders like "__pos_0", "__pos_1".
	const SKIP_FB_KEYS = new Set(['respondent_id', 'day_sheet', 'day', 'labels', 'id']);

	// Normalise a raw feedback key by stripping day references so that
	// "...for DAY 1 of the program..." and "...for DAY 2..." collapse to
	// the same column instead of creating one column per day.
	const normFbKey = key =>
		String(key || '')
			.replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')
			.replace(/\bDAY\s+\d+\b/gi, '')
			.replace(/\s{2,}/g, ' ')
			.trim();

	// Map every raw key to its normalised form, and collect the raw keys
	// that share each normalised key (so the value accessor checks all variants).
	const rawKeysByNorm = new Map();  // normKey → [rawKey, ...]
	for (const fb of (feedbackData || [])) {
		for (const rawKey of Object.keys(fb)) {
			if (SKIP_FB_KEYS.has(rawKey)) continue;
			const norm = rawKey.startsWith('__pos_') ? rawKey : normFbKey(rawKey);
			if (!rawKeysByNorm.has(norm)) rawKeysByNorm.set(norm, []);
			if (!rawKeysByNorm.get(norm).includes(rawKey)) rawKeysByNorm.get(norm).push(rawKey);
		}
	}

	const feedbackColumnsMaster = [...rawKeysByNorm.entries()].map(([normKey, rawKeys], i) => ({
		key: normKey,
		// Old-schema positional keys (__pos_N) have no meaningful header — use a generic label.
		header: normKey.startsWith('__pos_') ? ('Feedback ' + (i + 1)) : normKey,
		// Check all raw key variants that map to this normalised column
		value: fb => cleanFeedbackCellValue(rawKeys.map(k => fb[k] || '').find(v => v) || ''),
	}));

	const feedbackColumnsBase = feedbackColumnsMaster;

	const feedbackColumns = feedbackColumnsBase.filter(col =>
		(feedbackData || []).some(fb => isMeaningfulFeedbackCellValue(col.value(fb)))
	);

	const meaningfulFeedbackRows = (feedbackData || []).filter(fb =>
		feedbackColumns.some(col => isMeaningfulFeedbackCellValue(col.value(fb)))
	);

	const hasMeaningfulFeedback = feedbackColumns.length > 0 && meaningfulFeedbackRows.length > 0;

	const participantFeedbackSectionHtml = hasMeaningfulFeedback
		? (() => {
			const FB_TH = 'border:1px solid #aaa;padding:6px 8px;text-align:center;background:#1e3a8a;color:#fff;font-family:\'Arial\',sans-serif;';
			const FB_TD = 'border:1px solid #aaa;padding:5px 8px;vertical-align:top;';
			const w = (100 / feedbackColumns.length).toFixed(2) + '%';
			const thead = `<tr>${feedbackColumns
				.map(col => `<th style="${FB_TH}width:${w};">${escapeHtml(col.header)}</th>`)
				.join('')}</tr>`;

			// Group rows by day_sheet; fall back to a single group when no day info present
			const dayGroups = new Map();
			meaningfulFeedbackRows.forEach(fb => {
				const day = (fb.day_sheet || fb.day || '').trim() || '__all__';
				if (!dayGroups.has(day)) dayGroups.set(day, []);
				dayGroups.get(day).push(fb);
			});

			const multiDay = dayGroups.size > 1 || !dayGroups.has('__all__');

			// Sort groups: Day 1, Day 2, … then any remaining labels alphabetically
			const sortedDays = [...dayGroups.keys()].sort((a, b) => {
				if (a === '__all__') return 0;
				const na = parseInt(String(a).match(/\d+/)?.[0] ?? 9999);
				const nb = parseInt(String(b).match(/\d+/)?.[0] ?? 9999);
				return na !== nb ? na - nb : a.localeCompare(b);
			});

			const tablesHtml = sortedDays.map(day => {
				const rows = dayGroups.get(day);
				const tbody = rows
					.map(fb => `<tr>${feedbackColumns
						.map(col => `<td style="${FB_TD}">${escapeHtml(col.value(fb) || '')}</td>`)
						.join('')}</tr>`)
					.join('');
				const dayLabel = day === '__all__' ? '' : day;
				const heading = multiDay && dayLabel
					? `PARTICIPANT FEEDBACK - ${dayLabel}`
					: `PARTICIPANT FEEDBACK`;
				return `
	<p style="margin-top:20px;margin-bottom:6px;font-weight:bold;font-family:'Arial',sans-serif;font-size:12px;">${escapeHtml(heading)}</p>
	<table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-top:4px;">
		<thead>${thead}</thead>
		<tbody>${tbody}</tbody>
	</table>`;
			}).join('');

			return `<!-- Participant Feedback -->${tablesHtml}`;
		})()
		: '';

	// ── Section IV: highlights derived from REAL feedback ──────────────────
	/**
	 * Section IV used to be entirely static/hardcoded boilerplate.
	 * We now derive it from real feedbackData:
	 *   - strengths from positive language in "insights" column
	 *   - improvements from "improvements" column
	 *   - further topics from "further" column
	 * If data is sparse we fall back to descriptive placeholders.
	 */
	// cleanFeedbackValues is now a top-level function (see above buildReportHTML)

	// Helper: find a value from a feedback row by searching its keys for a keyword substring
	const getFbValueByKeyword = (fb, keyword) => {
		for (const key of Object.keys(fb)) {
			if (SKIP_FB_KEYS.has(key)) continue;
			if (key.toLowerCase().includes(keyword)) return fb[key] || '';
		}
		return '';
	};

	const improvements = hasMeaningfulFeedback
		? cleanFeedbackValues(feedbackData.map(fb =>
			fb.feedback_improvements || fb.improvements || getFbValueByKeyword(fb, 'improv') || ''
		  )).slice(0, 8)
		: [];

	const furtherTopics = hasMeaningfulFeedback
		? cleanFeedbackValues(feedbackData.map(fb =>
			fb.feedback_further || fb.further || fb.additional_training || getFbValueByKeyword(fb, 'further') || getFbValueByKeyword(fb, 'additional') || ''
		  )).slice(0, 8)
		: [];

	const insightSnippets = hasMeaningfulFeedback
		? cleanFeedbackValues(feedbackData.map(fb =>
			fb.feedback_insights || fb.insights || getFbValueByKeyword(fb, 'insight') || ''
		  )).slice(0, 8)
		: [];

	const hasUsefulFeedbackForHighlights = improvements.length > 0 || furtherTopics.length > 0 || insightSnippets.length > 0;

	const strengthsBullets = [
		`<strong>Content Delivery:</strong> Sessions received an overall rating of <strong>${overallAvg}</strong> (${overallDesc}) across all evaluated dimensions.`,
		`<strong>Resource Persons:</strong> All speakers received consistently high ratings demonstrating preparation, clarity, and content mastery.`,
		`<strong>Program Structure:</strong> The program was well-structured with clearly defined objectives aligned with actual execution.`,
		`<strong>Participant Engagement:</strong> Feedback reflected enhanced understanding and renewed enthusiasm among participants.`,
	].map(s => `<li>${s}</li>`).join('');

	const improvementBullets = improvements.length
		? improvements.map(i => `<li>${escapeHtml(i)}</li>`).join('')
		: `<li>No specific improvement suggestions were recorded.</li>`;

	const furtherBullets = furtherTopics.length
		? furtherTopics.map(t => `<li>${escapeHtml(t)}</li>`).join('')
		: `<li>No additional training topics were suggested.</li>`;

	// NOTE: Per spec, keep headings only (no content) for Section IV.
	const highlightsSectionHtml = `
	<!-- IV. Highlights (headings only) -->
	<p style="margin-top:16px;margin-bottom:4px;font-weight:bold;">IV. HIGHLIGHTS FROM PARTICIPANT FEEDBACK</p>
	<p style="margin-bottom:4px;font-weight:bold;">A. STRENGTHS OF THE TRAINING</p>
	<div style="height:8px"></div>
	<p style="margin-top:12px;margin-bottom:4px;font-weight:bold;">B. AREAS FOR IMPROVEMENT</p>
	<div style="height:8px"></div>
	<p style="margin-top:12px;margin-bottom:4px;font-weight:bold;">C. SUGGESTED ADDITIONAL TOPICS</p>
	<div style="height:8px"></div>`;

	// ── Rating scale tables ─────────────────────────────────────────────────
	const ratingScaleA = buildRatingScaleTable('category', scales);
	const ratingScaleB = buildRatingScaleTable('speaker', scales);
	const ratingScaleC = buildRatingScaleTable('overall', scales);

	// ── Signatories (uses SIGNATORIES config) ──────────────────────────────
	const proponentName = SIGNATORIES().preparedBy.name;
	const notedHtml = SIGNATORIES().noted.map(s =>
		`<div style="text-align:center;margin-top:32px;"><strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(s.title)}</div>`
	).join('');
	const signatureBlock = `
    <div style="margin-top:48px;font-size:11px;">
      <table style="width:100%;border-collapse:collapse;border:none;">
        <tr>
          <td style="width:50%;text-align:center;vertical-align:top;border:none;">
            Prepared by:<br><br><br>
            <strong>${escapeHtml(proponentName)}</strong><br>
            ${escapeHtml(SIGNATORIES().preparedBy.title)}
          </td>
          <td style="width:50%;text-align:center;vertical-align:top;border:none;">
            Checked by:<br><br><br>
            <strong>${escapeHtml(SIGNATORIES().checkedBy.name)}</strong><br>
            ${escapeHtml(SIGNATORIES().checkedBy.title)}
          </td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:24px;">Noted:</div>
      ${notedHtml}
    </div>`;

	// ── Header info ─────────────────────────────────────────────────────────
	const isExcel = !!(p.source_type === 'excel' || p.inclusive_dates);
	const displayDates = p.inclusive_dates
		? escapeHtml(p.inclusive_dates)
		: (p.start_date
			? formatDate(p.start_date) + (p.end_date && p.end_date !== p.start_date ? ' – ' + formatDate(p.end_date) : '')
			: '—');
	const numPartic = parseInt(p.total_participants) || 0;
	const numDays = p.days?.length || p.days_count || (isExcel ? 2 : 1);
	// Use actual per-day counts for avg if available, otherwise split evenly
	const _days = p.days || [];
	const _hasPerDay = _days.some(d => d.respondents != null && d.respondents > 0);
	const avgPerDay = _hasPerDay
		? Math.round(_days.reduce((s, d) => s + (d.respondents || 0), 0) / _days.length)
		: (numDays > 0 ? Math.round(totalRespondents / numDays) : totalRespondents);
	// Total expected = per-day participants × number of days (for multi-day "All Days" combined view)
	const totalExpected = numPartic * (numDays > 1 ? numDays : 1);
	const displayRate = totalExpected > 0 && totalRespondents > 0
		? Math.min((totalRespondents / totalExpected) * 100, 100).toFixed(1) + '%'
		: '—';

	// ── Category ratings (section II) ───────────────────────────────────────
	// Uses detailSections (one row per RAW category), not the possibly-merged
	// summaryDefs, since "II. CATEGORY RATINGS" should list categories
	// individually even when "Group by Super Category" combines them in the
	// "SUMMARY OF RATINGS" table above. Label uses the raw category name as
	// stored (normal case), not getReportCategoryTitle's all-caps display
	// title — this table should read in normal case, unlike the numbered
	// section headings below which stay upper-case per the original DepEd format.
	const detailDefs = detailSections.map(section => ({ label: section.name, key: section.avgSource }));
	const catRatingRows = detailDefs.length
		? detailDefs.map(sd => {
			const raw = resolveSummaryAvg(sd.key);
			const avg = raw !== null ? raw.toFixed(2) : '—';
			const desc = avg !== '—' ? getInterpretation(parseFloat(avg), 'category') : '—';
			return `<tr>
          <td style="${TD}">${escapeHtml(sd.label)}</td>
          <td style="${TDC}">${avg}</td>
          <td style="${TD}">${desc}</td>
        </tr>`;
		}).join('')
		: `<tr><td colspan="3" style="${TD}color:#9ca3af;text-align:center;">No data available</td></tr>`;

	const logoPath = window.location.pathname.replace(/\/[^/]*$/, '') + '/images/kagawaran-ng-edukasyon-logo.png';

	// ── Build per-day responses string with individual percentages ──
	// Format: "Day 1 - 50    83%" per line, matching the target report format.
	const dayResponsesStr = (() => {
		const days = p.days || [];
		if (!days.length) {
			if (!totalRespondents) return '—';
			const pct = numPartic > 0 ? Math.min((totalRespondents / numPartic) * 100, 100).toFixed(0) + '%' : '';
			// Use the selected day label when available, otherwise "Day 1"
			const selEl = document.getElementById('reportDaySelect');
			const fallbackLabel = (selEl?.value && selEl.selectedOptions?.[0]?.textContent?.trim()) || 'Day 1';
			return `${fallbackLabel} - ${totalRespondents}${pct ? '    ' + pct : ''}`;
		}
		const hasPerDayCounts = days.some(d => d.respondents != null && d.respondents > 0);
		// day_participants: per-day expected headcount saved alongside the record
		const dayParticipants = p.day_participants || {};
		const hasDayPartic = Object.keys(dayParticipants).length > 0;
		return days.map((d, i) => {
			const cnt = hasPerDayCounts ? (d.respondents || 0) : Math.round(totalRespondents / days.length);
			// FIX: use the stored day label (d.title / d.day) which is always correct
			// (e.g. "Day 2", "Day 3"). d.day_number was previously hardcoded to 1
			// for all imports due to a separate save bug, so reconstructing
			// "Day ${d.day_number}" produced "Day 1" for every row.
			const dayLabel = d.title || d.day || `Day ${i + 1}`;
			const dayTotal = hasDayPartic
				? (dayParticipants[dayLabel] || 0)
				: numPartic;
			const denom = dayTotal > 0 ? dayTotal : numPartic;
			const pct = denom > 0 ? Math.min((cnt / denom) * 100, 100).toFixed(0) + '%' : '';
			return `${dayLabel} - ${cnt}${pct ? '    ' + pct : ''}`;
		}).join('<br>');
	})();

	// ── Final HTML assembly ─────────────────────────────────────────────────
	return `
<div class="report-preview-content" style="font-family:'Bookman Old Style',Georgia,serif;font-size:12px;line-height:1.7;padding:36px 48px;color:#000;background:#fff;">

  <!-- DepEd Header -->
	<div style="text-align:center;margin-bottom:16px;padding-bottom:8px;">
    <img src="${logoPath}" onerror="this.style.display='none'" style="height:80px;width:80px;object-fit:contain;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto;" alt="DepEd Logo">
    <div style="font-family:'Old English Text MT',serif;font-size:11px;">Republic of the Philippines</div>
    <div style="font-family:'Old English Text MT',serif;font-size:22px;font-weight:normal;">Department of Education</div>
		<div style="font-family:'Times New Roman',serif;font-size:11px;font-weight:400;">REGION III-CENTRAL LUZON</div>
		<div style="font-family:'Tahoma',sans-serif;font-size:14px;font-weight:700;letter-spacing:0.2px;">SCHOOLS DIVISION OF CITY OF BALIWAG</div>
		<div style="font-family:'Tahoma',sans-serif;font-size:13px;font-weight:700;">City of Baliwag, Bulacan</div>
		<div style="margin-top:8px;border-bottom:2px solid #000;"></div>
  </div>

  <!-- Title block -->
  <div style="margin:16px 0 14px 0;">
    <div style="font-size:12px;font-weight:bold;font-family:'Bookman Old Style',sans-serif;letter-spacing:0.5px;">QAME ANALYSIS</div>
    ${p.sequence_number ? `<div style="font-size:12px;font-weight:bold;font-family:'Bookman Old Style',sans-serif;">${escapeHtml(p.sequence_number)}</div>` : ''}
  </div>

  <!-- Header info block -->
  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:18px;font-family:'Bookman Old Style',Georgia,serif;">
    <colgroup><col style="width:230px;"><col style="width:18px;"><col></colgroup>
    <tr><td style="padding:2px 0;font-weight:bold;">Title of Training Program</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${escapeHtml(p.title)}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Proponent/s</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${escapeHtml(p.proponents || '—')}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Training Venues</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${escapeHtml(p.venue || p.training_venue || '—')}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Inclusive Dates</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${displayDates}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Name of QAME Associates</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${escapeHtml(p.qame_associates || proponentName + ', ' + SIGNATORIES().preparedBy.title)}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Total Number of Participants</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${numPartic > 0 ? numPartic : '—'}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Average Number of Responses</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${dayResponsesStr}</td></tr>
    <tr><td style="padding:2px 0;font-weight:bold;">Percentage of Responses</td><td style="padding:2px 0;">:</td><td style="padding:2px 0;">${displayRate}</td></tr>
  </table>

  <!-- 1. Summary of Ratings -->
  <p style="margin-top:18px;margin-bottom:6px;font-weight:bold;font-family:'Arial',sans-serif;font-size:12px;">&nbsp;&nbsp;&nbsp;&nbsp;1.&nbsp;&nbsp;SUMMARY OF RATINGS</p>
  <table style="width:100%;border-collapse:collapse;font-size:11px;">
    <thead>
      <tr>
        <th style="${THC}width:36px;"></th>
        <th style="${TH}text-align:left;">INDICATORS</th>
        <th style="${THC}width:120px;">NUMERICAL<br>RATING</th>
        <th style="${TH}width:160px;">DESCRIPTIVE<br>RATING</th>
      </tr>
    </thead>
    <tbody>
      ${summaryRows}
      <tr>
        <td style="${AVG}" colspan="2">Average</td>
        <td style="${AVGC}">${overallAvg}</td>
        <td style="${AVGI}">${overallDesc}</td>
      </tr>
    </tbody>
  </table>

	${categorySectionsHtml}

	<p style="margin-top:20px;margin-bottom:6px;font-weight:bold;font-family:'Arial',sans-serif;font-size:12px;">&nbsp;&nbsp;&nbsp;&nbsp;${speakerSectionNumber}.&nbsp;&nbsp;RESOURCE PERSONS</p>
  ${speakerSectionsHtml}

	${participantFeedbackSectionHtml}

  ${signatureBlock}

  <!-- Rating Scale Legend -->
	<div style="margin-top:40px;border-top:2px solid #000;padding-top:16px;">
	  <p style="font-weight:bold;margin-bottom:6px;">A. <em>For Evaluation of PMT, Objectives, Content Relevance, Meals and Venue</em></p>
    ${ratingScaleA}
    <p style="font-weight:bold;margin-top:14px;margin-bottom:6px;">B. <em>For Resource Speaker</em></p>
    ${ratingScaleB}
    <p style="font-weight:bold;margin-top:14px;margin-bottom:6px;">C. <em>Over-all Score</em></p>
    ${ratingScaleC}
  </div>

  <!-- EVALUATION SUMMARY section -->
  <div style="margin-top:36px;text-align:center;">
    <div style="font-size:13px;font-weight:bold;text-transform:uppercase;text-decoration:underline;">EVALUATION SUMMARY</div>
    <div style="font-size:11px;font-weight:bold;margin-top:4px;">${escapeHtml(p.title)} (1–${totalRespondents}) ${formatDate(p.start_date)}</div>
  </div>

  <!-- I. Overall Ratings -->
  <p style="margin-top:16px;margin-bottom:4px;font-weight:bold;">I. OVERALL RATINGS</p>
  <table style="width:100%;border-collapse:collapse;font-size:11px;">
    <thead><tr>
      <th style="${TH}text-align:left;">Indicators</th>
      <th style="${THC}width:130px;">Numerical Rating</th>
      <th style="${TH}width:180px;">Descriptive Rating</th>
    </tr></thead>
    <tbody>
      ${summaryDefs.map(sd => {
		const raw = resolveSummaryAvg(sd.key);
		const s = raw !== null ? raw.toFixed(2) : '—';
		const desc = s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—';
		return `<tr>
			<td style="${TD}">${sd.label}</td>
			<td style="${TDC}">${s}</td>
			<td style="${TD}">${desc}</td>
		</tr>`;
	}).join('')}
      <tr>
        <td style="${AVG}">Overall Average</td>
        <td style="${AVGC}">${overallAvg}</td>
        <td style="${AVG}">${overallDesc}</td>
      </tr>
    </tbody>
  </table>

  <!-- II. Category Ratings -->
  <p style="margin-top:16px;margin-bottom:4px;font-weight:bold;">II. CATEGORY RATINGS</p>
  <table style="width:100%;border-collapse:collapse;font-size:11px;">
    <thead><tr>
      <th style="${TH}text-align:left;">Category</th>
      <th style="${THC}width:130px;">Average Rating</th>
      <th style="${TH}width:180px;">Descriptive Rating</th>
    </tr></thead>
    <tbody>${catRatingRows}</tbody>
  </table>

  <!-- III. Resource Persons Summary -->
  <p style="margin-top:16px;margin-bottom:4px;font-weight:bold;">III. RESOURCE PERSONS – SUMMARY OF PERFORMANCE</p>
  ${speakerSummaryRows.length ? `
  <table style="width:100%;border-collapse:collapse;font-size:11px;">
    <thead><tr>
      <th style="${TH}text-align:left;">Speaker Name</th>
      <th style="${THC}width:130px;">Average Rating</th>
      <th style="${TH}width:180px;">Descriptive Rating</th>
    </tr></thead>
    <tbody>
      ${speakerSummaryRows.map(row => `<tr>
        <td style="${TD}">${escapeHtml(row[0])}</td>
        <td style="${TDC}">${row[1]}</td>
        <td style="${TD}">${row[2]}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : `<p style="color:#9ca3af;font-style:italic;">No speaker data available.</p>`}

	${highlightsSectionHtml}


	<!-- V. Conclusion (heading only) -->
	<p style="margin-top:16px;margin-bottom:4px;font-weight:bold;">V. CONCLUSION</p>

  ${signatureBlock}
</div>`;
}

/**
 * Layer 3 — RENDERING
 * Orchestrates fetch → build → DOM write. Handles loading/error states.
 */
async function generateQAMEReport() {
	if (!State.viewingId || !State.workshopData) return;

	const container = document.getElementById('reportPreviewContainer');
	container.innerHTML = '<div class="report-placeholder"><i class="fa-solid fa-spinner fa-spin"></i><p>Generating report…</p></div>';

	try {
		const selectedDayId = document.getElementById('reportDaySelect')?.value || '';
		const reportSourceId = getReportDataSourceId();

		// Ensure rating scales are loaded (with TTL, fix #6)
		const scales = await loadRatingScales();

		// Fetch all data.
		// For container specific-day: reportSourceId already resolves to
		// { id: program_id, isRecord: true } so fetchReportData hits the
		// program_id path directly — no day_sheet param needed.
		// For container All Days Combined: selectedDayId is '' so the API
		// returns all days merged, now with day_sheet on each feedback row.
		const data = await fetchReportData(reportSourceId, selectedDayId);

		// For container programs with "All Days Combined", buildReportHTML needs
		// p.days populated with per-day respondent counts so it can render each
		// day's row instead of collapsing everything to "Day 1 - X".
		// State.workshopData.linked_imports already has total_responses per import.
		const workshopDataForReport = { ...State.workshopData };
		const imports = State.workshopData?.linked_imports || [];
		if (
			State.workshopData?.program_type === 'container' &&
			!selectedDayId &&
			imports.length > 0
		) {
			workshopDataForReport.days = imports.map((imp, i) => ({
				day_number: imp.day_number || (i + 1),
				title:      imp.day_label  || `Day ${i + 1}`,
				respondents: imp.total_responses || 0,
			}));
		}

		// For standalone records with a specific day selected, narrow p.days to
		// just that day so numDays, totalExpected, and dayResponsesStr are all
		// scoped to the selected day rather than showing all days combined.
		const isStandaloneRecord = State.workshopData?.source_type === 'standalone' ||
			(State.isRecord && State.workshopData?.program_type !== 'container');
		if (isStandaloneRecord && selectedDayId) {
			const allDays = State.workshopData?.days || [];
			// selectedDayId for standalone is the day title string, e.g. "Day 1"
			const matchedDay = allDays.find(d =>
				(d.title || d.day || `Day ${d.day_number}`) === selectedDayId
			);
			// Use the matched day only; fall back to a synthetic entry if not found
			workshopDataForReport.days = matchedDay
				? [{ ...matchedDay, respondents: data.totalRespondents }]
				: [{ day_number: 1, title: selectedDayId, respondents: data.totalRespondents }];
		}

		// Build HTML
		const html = await buildReportHTML(workshopDataForReport, data, scales);

		// Render
		container.innerHTML = html;
	} catch (e) {
		console.error('Report generation error:', e);
		container.innerHTML = '<div class="report-placeholder"><i class="fa-solid fa-exclamation-triangle"></i><p>Error generating report.</p></div>';
	}
}

// PART 4 OF 5 — Rating Scales & Word Export
// Sections: 18-19 (rating scales, export to Word)

// ═══════════════════════════════════════════════════════════════════════════
//  18. RATING SCALES  —  with TTL cache (fix #6)
// ═══════════════════════════════════════════════════════════════════════════
const RATING_SCALES_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadRatingScales() {
	const now = Date.now();
	if (State._ratingScales && now < State._ratingScalesTTL) return State._ratingScales;

	try {
		const res = await fetch(`${API_URL}/rating_scales.php`, {
			credentials: 'include'
		});
		const json = await res.json();

		if (json.success && json.scales) {
			const cache = { category: [], speaker: [], overall: [] };
			json.scales.forEach(row => {
				if (row.is_active && cache[row.scale_type]) {
					cache[row.scale_type].push({
						min: parseFloat(row.min_score),
						max: parseFloat(row.max_score),
						level: row.level_of_agreement,
						desc: row.descriptive_equivalent,
						order: row.display_order
					});
				}
			});
			Object.keys(cache).forEach(t => cache[t].sort((a, b) => a.order - b.order));
			State._ratingScales = cache;
			State._ratingScalesTTL = now + RATING_SCALES_TTL_MS;
			return cache;
		}
	} catch (_) {
		console.warn('Could not load rating scales from DB; using built-in fallback.');
	}
	// Fallback matching seed data
	const fallback = {
		category: [
			{ min: 3.26, max: 4.00, level: 'Strongly Agree (SA)', desc: 'Very Satisfactory', order: 1 },
			{ min: 2.51, max: 3.25, level: 'Agree (A)', desc: 'Satisfactory', order: 2 },
			{ min: 1.76, max: 2.50, level: 'Disagree (D)', desc: 'Unsatisfactory', order: 3 },
			{ min: 1.00, max: 1.75, level: 'Strongly Disagree (SD)', desc: 'Very Unsatisfactory', order: 4 },
		],
		speaker: [
			{ min: 3.26, max: 4.00, level: 'Very Satisfied', desc: 'Very Satisfactory', order: 1 },
			{ min: 2.51, max: 3.25, level: 'Somewhat Satisfied', desc: 'Satisfactory', order: 2 },
			{ min: 1.76, max: 2.50, level: 'Somewhat Dissatisfied', desc: 'Unsatisfactory', order: 3 },
			{ min: 1.00, max: 1.75, level: 'Dissatisfied', desc: 'Very Unsatisfactory', order: 4 },
		],
		overall: [
			{ min: 3.26, max: 4.00, level: 'Excellent', desc: 'Very Satisfactory', order: 1 },
			{ min: 2.51, max: 3.25, level: 'Good', desc: 'Satisfactory', order: 2 },
			{ min: 1.76, max: 2.50, level: 'Average', desc: 'Unsatisfactory', order: 3 },
			{ min: 1.00, max: 1.75, level: 'Fair', desc: 'Very Unsatisfactory', order: 4 },
		]
	};
	State._ratingScales = fallback;
	State._ratingScalesTTL = now + RATING_SCALES_TTL_MS;
	return fallback;
}

function getInterpretation(score, scaleType = 'category') {
	const scales = State._ratingScales;
	if (!scales) return _fallbackInterpretation(score, scaleType);

	const rows = scales[scaleType] || scales['category'];
	const n = parseFloat(score);
	if (isNaN(n)) return '—';

	for (const row of rows) { if (n >= row.min && n <= row.max) return row.desc; }
	return n > 4.00 ? rows[0].desc : rows[rows.length - 1].desc;
}

function _fallbackInterpretation(score, scaleType) {
	const n = parseFloat(score);
	if (isNaN(n)) return '—';
	if (n >= 3.26) return 'Very Satisfactory (VS)';
	if (n >= 2.51) return 'Satisfactory (S)';
	if (n >= 1.76) return 'Unsatisfactory (U)';
	return 'Very Unsatisfactory (VU)';
}

/** Backwards-compat alias */
function getInterpretationVS(score) { return getInterpretation(score, 'category'); }

function buildRatingScaleTable(scaleType, scales) {
	const rows = (scales && scales[scaleType]) || [];
	const bodyRows = rows.length
		? rows.map(r => `
        <tr>
          <td style="border:1px solid #aaa;padding:4px 8px;text-align:center;font-style:italic;">${r.min.toFixed(2)}–${r.max.toFixed(2)}</td>
          <td style="border:1px solid #aaa;padding:4px 8px;font-style:italic;">${r.level}</td>
          <td style="border:1px solid #aaa;padding:4px 8px;font-style:italic;">${r.desc}</td>
        </tr>`).join('')
		: `<tr><td colspan="3" style="padding:6px;color:#9ca3af;text-align:center;">Scale data not available</td></tr>`;

	return `<table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-top:6px;">
    <thead><tr>
      <th style="border:1px solid #aaa;padding:5px 8px;text-align:center;font-style:italic;background:#ffffff;color:#000;font-weight:bold;">Scale</th>
      <th style="border:1px solid #aaa;padding:5px 8px;text-align:center;font-style:italic;background:#ffffff;color:#000;font-weight:bold;">Level of Agreement</th>
      <th style="border:1px solid #aaa;padding:5px 8px;text-align:center;font-style:italic;background:#ffffff;color:#000;font-weight:bold;">Descriptive Equivalent</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  19. EXPORT TO WORD  —  fully mirrors the DOCX reference format
// ═══════════════════════════════════════════════════════════════════════════
async function exportReportToWord() {
	if (!State.workshopData) { showAlert('error', 'No data to export.'); return; }
	// For container programs, sum total_responses across all linked imports
	// (State.responses only holds the currently-viewed day, not all days combined)
	const _importsW = State.workshopData?.linked_imports || [];
	const _broadResponses = (
		State.workshopData?.program_type === 'container' && _importsW.length > 0
			? _importsW.reduce((s, imp) => s + (imp.total_responses || 0), 0)
			: (State.responses.length || State.workshopData?.total_responses || 0)
	);
	if (!_broadResponses) { showAlert('error', 'No responses available to export'); return; }

	try {
		const {
			Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
			WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign,
			PageNumber, PageBreak, Header, Footer, ImageRun,
			PositionalTab, PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader, HeightRule
		} = docx;

		const pRaw = State.workshopData;
		const getSavedFeedbackLabels = (programLike) => {
			const direct = programLike?.feedback_labels || programLike?.feedbackLabels;
			if (direct && typeof direct === 'object') return direct;
			const snapStr = programLike?.settings_snapshot || programLike?.settingsSnapshot || '';
			if (!snapStr) return null;
			try {
				const snap = JSON.parse(snapStr);
				const labels = snap?.feedback_labels || snap?.feedbackLabels || null;
				return (labels && typeof labels === 'object') ? labels : null;
			} catch (_) {
				return null;
			}
		};
		const savedFbLabels = getSavedFeedbackLabels(pRaw) || {};
		const fbLabel = (key, fallback) => {
			const v = savedFbLabels?.[key];
			return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
		};
		const selectedDayId = document.getElementById('reportDaySelect')?.value || '';
		const reportSourceId = getReportDataSourceId();
		const scales = await loadRatingScales();
		const data = await fetchReportData(reportSourceId, selectedDayId);
		const { categories, columnAverages, speakerAverages, feedbackData } = data;
		// Use the API-returned respondent count (already scoped to the selected day)
		const totalResponses = data.totalRespondents || _broadResponses;

		// Fetch SDO Seal for PPT header logo
		const pptSealData = await (async () => {
			try {
				const base = window.location.pathname.replace(/\/[^/]*$/, '');
				const res = await fetch(base + '/images/SDO-Seal.png');
				if (!res.ok) return null;
				const buf = await res.arrayBuffer();
				// Convert to base64 data URL for PptxGenJS addImage
				const bytes = new Uint8Array(buf);
				let binary = '';
				bytes.forEach(b => binary += String.fromCharCode(b));
				return 'data:image/png;base64,' + btoa(binary);
			} catch (_) { return null; }
		})();

		// Enrich p.days — mirrors the same logic as Generate Preview
		const p = { ...pRaw };
		if (pRaw.program_type === 'container' && (pRaw.linked_imports || []).length > 0) {
			if (selectedDayId) {
				// Specific day selected: narrow to just that import
				const selImp = pRaw.linked_imports.find(imp => String(imp.program_id) === String(selectedDayId));
				const selImpIdx = selImp ? pRaw.linked_imports.indexOf(selImp) : 0;
				p.days = selImp
					? [{ day_number: selImp.day_number || (selImpIdx + 1), title: selImp.day_label || `Day ${selImpIdx + 1}`, respondents: data.totalRespondents }]
					: [];
			} else {
				// All days combined
				p.days = pRaw.linked_imports.map((imp, i) => ({
					day_number:  imp.day_number  || (i + 1),
					title:       imp.day_label   || `Day ${i + 1}`,
					respondents: imp.total_responses || 0,
				}));
			}
		}
		// Standalone: narrow p.days to the selected day (mirrors Generate Preview fix)
		const isStandalonePPT = pRaw.source_type === 'standalone' ||
			(State.isRecord && pRaw.program_type !== 'container');
		if (isStandalonePPT && selectedDayId) {
			const allDays = pRaw.days || [];
			const matchedDay = allDays.find(d =>
				(d.title || d.day || `Day ${d.day_number}`) === selectedDayId
			);
			p.days = matchedDay
				? [{ ...matchedDay, respondents: data.totalRespondents }]
				: [{ day_number: 1, title: selectedDayId, respondents: data.totalRespondents }];
		}

		// ─── Page layout constants (US Letter, 1" margins) ──────────────────
		const PAGE_W = 12240;   // 8.5" in DXA
		const MARGIN = 1440;    // 1" in DXA
		const CONTENT_W = PAGE_W - MARGIN * 2;  // 9360 DXA
		const PAGE_MARGIN_LEFT = 1440;
		const PAGE_MARGIN_RIGHT = 1181;
		// Divider must ignore page text margins and span the full page width.
		const DIVIDER_CONTENT_W = PAGE_W;

		// ─── Column widths (DXA) ────────────────────────────────────────────
        const COL_NUM = 520;
        const COL_NUM_R = 1400;
        const COL_DESC = 2800;
        const COL_IND = CONTENT_W - COL_NUM - COL_NUM_R - COL_DESC;

		// ─── Border helpers ─────────────────────────────────────────────────
		const border = (color = '000000') => ({ style: BorderStyle.SINGLE, size: 4, color });
        const cellBorders = (color = '000000') => ({
			top: border(color), bottom: border(color),
			left: border(color), right: border(color)
		});
		const headerShading = { fill: 'FFFFFF', type: ShadingType.CLEAR };
		const avgShading = { fill: 'FFFFFF', type: ShadingType.CLEAR };
		const CELL_MARGIN = { top: 60, bottom: 60, left: 100, right: 100 };
		const HEADER_DIVIDER_BORDER = {
			style: BorderStyle.THICK_THIN_MEDIUM_GAP,
			size: 24,
			color: '000000',
			space: 0,
		};
		const FOOTER_DIVIDER_BORDER = {
			style: BorderStyle.THIN_THICK_MEDIUM_GAP,
			size: 24,
			color: '000000',
			space: 0,
		};

		// ─── Text helpers ────────────────────────────────────────────────────
		const run = (text, opts = {}) => new TextRun({ text: String(text ?? ''), font: 'Bookman Old Style', size: 22, ...opts });
		const bRun = (text, opts = {}) => run(text, { bold: true, ...opts });

		const para = (children, opts = {}) => new Paragraph({
			children: Array.isArray(children) ? children : [run(children)],
			spacing: { after: 60 },
			...opts
		});

		const dividerTable = (edge, labelText = '') => new Table({
            width: { size: DIVIDER_CONTENT_W, type: WidthType.DXA },
            columnWidths: [DIVIDER_CONTENT_W],
            alignment: AlignmentType.LEFT,
            indent: { size: -PAGE_MARGIN_LEFT, type: WidthType.DXA },
            borders: {
                top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL },
                left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL },
                insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL },
            },
            rows: [new TableRow({
                height: { value: 80, rule: HeightRule.EXACT }, // 👈 add this line
                children: [new TableCell({
                    children: labelText
                        ? [
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                spacing: { before: 0, after: 0 },
                                children: [
                                    new TextRun({
                                        text: labelText,
                                        font: 'Cambria',
                                        size: 4,
                                        bold: true
                                    })
                                ]
                            }),
                        ]
                        : [new Paragraph({ spacing: { before: 0, after: 0 } })],
                    width: { size: DIVIDER_CONTENT_W, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    borders: {
                        // Draw divider on the bottom edge for both header/footer.
                        // In Word export, complex top-edge footer borders can collapse visually.
                        top: { style: BorderStyle.NIL },
                        bottom: edge === 'top'
                            ? FOOTER_DIVIDER_BORDER
                            : (edge === 'bottom' ? HEADER_DIVIDER_BORDER : { style: BorderStyle.NIL }),
                        left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL },
                    },
                })],
            })],
        });

		const emptyPara = () => new Paragraph({ children: [run('')], spacing: { after: 80 } });

		const sectionHeading = text => new Paragraph({
			children: [bRun(text, { size: 22 })],
			spacing: { before: 200, after: 80 },
			indent: { left: COL_NUM },
		});

		// ─── Score / interpretation helpers ─────────────────────────────────
		const normalise = s => (s || '').replace(/\u00a0/g, ' ').trim().toLowerCase();

		const getColAvg = (tokens, excludeDigitSuffix = false) => {
			const parts = tokens.split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
			const matches = columnAverages.filter(c => {
				const h = normalise(c.question_header || c.question || '');
				return parts.every(p => h.includes(p));
			});
			if (!matches.length) return null;
			if (excludeDigitSuffix) {
				const nosuffix = matches.find(c => !/\d$/.test(normalise(c.question_header)));
				return parseFloat((nosuffix || matches[0]).average_score || 0);
			}
			return parseFloat(matches[0].average_score || 0);
		};

		const getColAvgSlot = (baseTokens, slot) => {
			const parts = baseTokens.split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
			const suffix = slot === 1 ? '' : String(slot);
			const col = columnAverages.find(c => {
				const h = normalise(c.question_header || c.question || '');
				if (!parts.every(p => h.includes(p))) return false;
				const endsWithDigit = /\d$/.test(h);
				if (suffix === '') return !endsWithDigit || h.endsWith('1');
				return h.endsWith(suffix);
			});
			return col ? parseFloat(col.average_score || 0) : null;
		};

		const fmtScore = v => {
			const n = parseFloat(v);
			return isNaN(n) || n === 0 ? '—' : n.toFixed(2);
		};

		const makeRow = (tokens, label) => {
			const s = fmtScore(getColAvg(tokens, true));
			return { label, score: s, desc: s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—' };
		};

		// ─── Generic cell builder ─────────────────────────────────────────────
		const cell = (children, opts = {}) => new TableCell({
			children: Array.isArray(children) ? children : [para(children)],
			margins: CELL_MARGIN,
			borders: cellBorders(),
			verticalAlign: VerticalAlign.CENTER,
			...opts
		});

		const headerCell = (text, w) => new TableCell({
			children: [new Paragraph({ children: [bRun(text, { size: 22 })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
			width: { size: w, type: WidthType.DXA },
			shading: headerShading,
			borders: cellBorders(),
			margins: CELL_MARGIN,
			verticalAlign: VerticalAlign.CENTER,
		});

		// ─── 4-column indicator table builder ────────────────────────────────
		const buildIndicatorTable = (rows, scaleType = 'category', avgSource = null) => {
			// Same fix as the HTML report builder: trust the authoritative
			// average instead of re-averaging already-rounded indicator scores.
			// avgSource is a number for a merged QAME super-category (mean of
			// its mapped raw categories' own averages), or a raw category name
			// string to look up individually.
			let authoritative = null;
			if (typeof avgSource === 'number') {
				authoritative = avgSource;
			} else if (typeof avgSource === 'string' && avgSource) {
				authoritative = getCategoryAverageForReport(categories, columnAverages, avgSource);
			}
			let avg;
			if (authoritative !== null && authoritative !== undefined && !isNaN(authoritative)) {
				avg = authoritative.toFixed(2);
			} else {
				const nums = rows.map(r => parseFloat(r.score)).filter(n => !isNaN(n));
				avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : '—';
			}
			const avgDesc = avg !== '—' ? getInterpretation(parseFloat(avg), scaleType) : '—';

			const tableRows = [
				// Header row
				new TableRow({
					children: [
						headerCell('', COL_NUM),
						headerCell('INDICATORS', COL_IND),
						headerCell('NUMERICAL RATING', COL_NUM_R),
						headerCell('DESCRIPTIVE RATING', COL_DESC),
					]
				}),
				// Data rows
				...rows.map((r, i) => new TableRow({
					children: [
						cell([new Paragraph({ children: [run(String(i + 1))], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
							{ width: { size: COL_NUM, type: WidthType.DXA } }),
						cell([new Paragraph({ children: [run(r.label)], spacing: { after: 0 } })],
							{ width: { size: COL_IND, type: WidthType.DXA } }),
						cell([new Paragraph({ children: [run(r.score)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
							{ width: { size: COL_NUM_R, type: WidthType.DXA } }),
						cell([new Paragraph({ children: [run(r.desc, { italics: true })], spacing: { after: 0 } })],
							{ width: { size: COL_DESC, type: WidthType.DXA } }),
					]
				})),
				// Average row
				new TableRow({
					children: [
						new TableCell({
							children: [new Paragraph({ children: [bRun('Average')], spacing: { after: 0 } })],
							columnSpan: 2,
							shading: avgShading,
							borders: cellBorders(),
							margins: CELL_MARGIN,
						}),
						new TableCell({
							children: [new Paragraph({ children: [bRun(avg)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
							width: { size: COL_NUM_R, type: WidthType.DXA },
							shading: avgShading,
							borders: cellBorders(),
							margins: CELL_MARGIN,
						}),
						new TableCell({
							children: [new Paragraph({ children: [run(avgDesc, { bold: true, italics: true })], spacing: { after: 0 } })],
							width: { size: COL_DESC, type: WidthType.DXA },
							shading: avgShading,
							borders: cellBorders(),
							margins: CELL_MARGIN,
						}),
					]
				}),
			];

			return new Table({
				width: { size: CONTENT_W, type: WidthType.DXA },
				columnWidths: [COL_NUM, COL_IND, COL_NUM_R, COL_DESC],
				rows: tableRows,
			});
		};

		// ─── 3-column summary table builder (no # column) ────────────────────
		const build3ColTable = (headers, rows, colWidths, avgRow = null) => {
			const [w1, w2, w3] = colWidths;
			const summaryDescMargins = { top: 60, bottom: 60, left: 40, right: 40 };
			return new Table({
				width: { size: CONTENT_W, type: WidthType.DXA },
				columnWidths: colWidths,
				rows: [
					new TableRow({
						children: headers.map((h, i) => new TableCell({
							children: [new Paragraph({ children: [bRun(h)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
							width: { size: colWidths[i], type: WidthType.DXA },
							shading: headerShading,
							borders: cellBorders(),
							margins: CELL_MARGIN,
						}))
					}),
					...rows.map(row => new TableRow({
						children: row.map((cellText, i) => new TableCell({
							children: [new Paragraph({ children: [run(cellText, i === 2 ? { size: 20 } : {})], spacing: { after: 0 } })],
							width: { size: colWidths[i], type: WidthType.DXA },
							borders: cellBorders(),
							margins: i === 2 ? summaryDescMargins : CELL_MARGIN,
						}))
					})),
					...(avgRow ? [new TableRow({
						children: avgRow.map((cellText, i) => new TableCell({
							children: [new Paragraph({ children: [bRun(cellText, i === 2 ? { size: 20 } : {})], spacing: { after: 0 } })],
							width: { size: colWidths[i], type: WidthType.DXA },
							shading: avgShading,
							borders: cellBorders(),
							margins: i === 2 ? summaryDescMargins : CELL_MARGIN,
						}))
					})] : [])
				]
			});
		};

		// ─── Rating scale table builder ───────────────────────────────────────
		const buildScaleTable = scaleType => {
			const scaleRows = (scales[scaleType] || []);
			const w1 = 1500, w2 = 4000, w3 = CONTENT_W - 1500 - 4000;
			return new Table({
				width: { size: CONTENT_W, type: WidthType.DXA },
				columnWidths: [w1, w2, w3],
				rows: [
					new TableRow({
						children: ['Scale', 'Level of Agreement', 'Descriptive Equivalent'].map((h, i) =>
							new TableCell({
								children: [new Paragraph({ children: [run(h, { bold: true, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
								width: { size: [w1, w2, w3][i], type: WidthType.DXA },
								shading: headerShading,
								borders: cellBorders(),
								margins: CELL_MARGIN,
							})
						)
					}),
					...scaleRows.map(r => new TableRow({
						children: [
							`${r.min.toFixed(2)}–${r.max.toFixed(2)}`,
							r.level,
							r.desc,
						].map((txt, i) => new TableCell({
							children: [new Paragraph({ children: [run(txt, { italics: true })], alignment: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 0 } })],
							width: { size: [w1, w2, w3][i], type: WidthType.DXA },
							borders: cellBorders(),
							margins: CELL_MARGIN,
						}))
					}))
				]
			});
		};

		// ─── Signatory block ──────────────────────────────────────────────────
		const proponentName = SIGNATORIES().preparedBy.name;
		const noBorderCell = { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL } };
		const sigTable = () => new Table({
			width: { size: CONTENT_W, type: WidthType.DXA },
			columnWidths: [CONTENT_W / 2, CONTENT_W / 2],
			borders: {
				top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL },
				left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL },
				insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL },
			},
			rows: [
				// Prepared by / Checked by
				new TableRow({
					children: [
						new TableCell({
							children: [
								para('Prepared by:'),
								emptyPara(),
								para([bRun(SIGNATORIES().preparedBy.name)]),
								para(SIGNATORIES().preparedBy.title),
							],
							borders: noBorderCell,
							margins: { top: 0, bottom: 0, left: 0, right: 0 },
						}),
						new TableCell({
							children: [
								para('Checked by:'),
								emptyPara(),
								para([bRun(SIGNATORIES().checkedBy.name)]),
								para(SIGNATORIES().checkedBy.title),
							],
							borders: noBorderCell,
							margins: { top: 0, bottom: 0, left: 0, right: 0 },
						}),
					]
				}),
				// Noted: label
				new TableRow({
					children: [
						new TableCell({
							columnSpan: 2,
							children: [emptyPara(), para('Noted:')],
							borders: noBorderCell,
							margins: { top: 0, bottom: 0, left: 0, right: 0 },
						}),
					]
				}),
				// One row per "Noted" signatory (driven by SIGNATORIES().noted array)
				...SIGNATORIES().noted.map(s => new TableRow({
					children: [
						new TableCell({
							columnSpan: 2,
							children: [
								emptyPara(),
								emptyPara(),
								new Paragraph({ children: [bRun(s.name)], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
								new Paragraph({ children: [run(s.title)], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
							],
							borders: noBorderCell,
							margins: { top: 0, bottom: 0, left: 0, right: 0 },
						}),
					]
				})),
			]
		});

		// ─── Indicator rows for each section ─────────────────────────────────
		const pmFallback = [
			makeRow('delivered as planned', 'The activity/program was delivered as planned'),
			makeRow('managed efficiently', 'The activity/program was managed efficiently'),
			makeRow('well-structured', 'The activity/program was well-structured'),
			makeRow('training matrix', 'The activity/program has well-detailed and organized Training Matrix'),
		];
		const objFallback = [
			makeRow('objectives were clearly defined', 'The objectives were clearly defined'),
			makeRow('objectives were attainable', 'The objectives were attainable'),
			makeRow('smart', 'The objectives were SMART'),
			makeRow('presented prior to the session', 'The objectives were presented prior to the session'),
		];
		const contentFallback = [
			makeRow('reliable sources', 'Content delivery was based on reliable sources'),
			makeRow('effective in generating learning', 'The discussions were effective in generating learning'),
			makeRow('meet expectations', 'Met expectations'),
			makeRow('comprehensiveness of the slide', 'Quality and comprehensiveness of the slide presentation'),
			makeRow('materials and handouts', 'Materials and handouts were relevant, adequate and helpful'),
			makeRow('presentation of ideas was organized', 'The presentation of ideas was organized'),
			makeRow('training content|appropriate', "Content was appropriate to trainees' roles and responsibilities"),
		];
		const venueFallback = [
			makeRow('adequately lit', 'The conference hall was adequately lit'),
			makeRow('well ventilated', 'The conference hall was well ventilated'),
			makeRow('soundproofing', 'Adequate soundproofing'),
			makeRow('sufficient space for the activity', 'With sufficient space for the activity'),
			makeRow('clean space', 'Clean space'),
			makeRow('equipment was serviceable', 'Equipment was serviceable'),
			makeRow('clean comfort rooms', 'Clean comfort rooms with adequate toiletries and water supply'),
		];
		const mealsFallback = [
			makeRow('sufficient quantity', 'Sufficient quantity'),
			makeRow('sufficient variety', 'Sufficient variety'),
			makeRow('generally healthy', 'Generally healthy'),
			makeRow('utensils|spoons', 'Utensils were clean'),
			makeRow('meals are served on time', 'Meals were served on time'),
			makeRow('portioning of food', 'Followed protocol for holding, serving, and portioning of food'),
		];
		const pmtFallback = [
			makeRow('courteous', 'Courteous'),
			makeRow('efficient', 'Efficient'),
			makeRow('responsive to the needs', 'Responsive to the needs of participants'),
			makeRow('safe work techniques', 'Safe work techniques'),
			makeRow('emcee', 'The emcee/host spoke with clarity'),
		];

		const fallbackByCategory = {
			'program management and operations': pmFallback,
			'attainment of objectives': objFallback,
			'delivery of content': contentFallback,
			'venue': venueFallback,
			'meal': mealsFallback,
			'program management team': pmtFallback,
		};

		const reportCategoryNames = getOrderedReportCategoryNames(categories, columnAverages);
		const useLegacyFallback = !hasColumnCategoryMetadata(columnAverages);
		const categorySections = await buildReportCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback);
		// Per-category breakdown sections always show one raw category each,
		// even when the summary table above merges categories under a super
		// category — see the matching comment in buildReportHTML.
		const detailSections = buildRawCategorySections(categories, columnAverages, fallbackByCategory, useLegacyFallback);

		const speakerSectionNumber = detailSections.length + 2;

		// ─── Summary rows ─────────────────────────────────────────────────────
		// Built from categorySections (not the raw reportCategoryNames) so this
		// summary table reflects the configured QAME super-category grouping.
		// The detailed breakdown below stays per-raw-category regardless.
		const resolveSummaryAvg = key => typeof key === 'number' ? key : getCategoryAverageForReport(categories, columnAverages, key);
		const summaryDefs = categorySections.map(section => ({ label: section.title, key: section.avgSource }));

		const catScores = summaryDefs
			.map(sd => resolveSummaryAvg(sd.key))
			.filter(n => n !== null && !isNaN(n) && n > 0);
		// Same fix as the PPT export: prefer the API's true weighted average
		// (AVG of every raw score row, matching the live dashboard) over an
		// unweighted mean of the category averages.
		const overallAvg = (data.overallWeightedAverage !== null && data.overallWeightedAverage !== undefined && !isNaN(data.overallWeightedAverage))
			? data.overallWeightedAverage.toFixed(2)
			: (catScores.length ? (catScores.reduce((a, b) => a + b, 0) / catScores.length).toFixed(2) : '—');
		const overallDesc = overallAvg !== '—' ? getInterpretation(parseFloat(overallAvg), 'overall') : '—';

		const summaryTableRows = summaryDefs.map((sd, i) => {
			const raw = resolveSummaryAvg(sd.key);
			const s = raw !== null ? raw.toFixed(2) : '—';
			return [String(i + 1), sd.label, s, s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—'];
		});

		// Build the summary table (4-column with # column)
		const buildSummaryTable = () => {
			const wNum = COL_NUM, wLbl = COL_IND, wNr = COL_NUM_R, wDr = COL_DESC;
			return new Table({
				width: { size: CONTENT_W, type: WidthType.DXA },
				columnWidths: [wNum, wLbl, wNr, wDr],
				rows: [
					new TableRow({
						children: [
							headerCell('', wNum),
							headerCell('INDICATORS', wLbl),
							headerCell('NUMERICAL RATING', wNr),
							headerCell('DESCRIPTIVE RATING', wDr),
						]
					}),
					...summaryTableRows.map(row => new TableRow({
						children: [
							cell([new Paragraph({ children: [run(row[0])], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: wNum, type: WidthType.DXA } }),
							cell([new Paragraph({ children: [run(row[1])], spacing: { after: 0 } })], { width: { size: wLbl, type: WidthType.DXA } }),
							cell([new Paragraph({ children: [run(row[2])], alignment: AlignmentType.CENTER, spacing: { after: 0 } })], { width: { size: wNr, type: WidthType.DXA } }),
							cell([new Paragraph({ children: [run(row[3], { italics: true })], spacing: { after: 0 } })], { width: { size: wDr, type: WidthType.DXA } }),
						]
					})),
					new TableRow({
						children: [
							new TableCell({
								children: [new Paragraph({ children: [bRun('Average')], spacing: { after: 0 } })],
								columnSpan: 2,
								shading: avgShading, borders: cellBorders(), margins: CELL_MARGIN,
							}),
							new TableCell({
								children: [new Paragraph({ children: [bRun(overallAvg)], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
								width: { size: wNr, type: WidthType.DXA },
								shading: avgShading, borders: cellBorders(), margins: CELL_MARGIN,
							}),
							new TableCell({
								children: [new Paragraph({ children: [run(overallDesc, { bold: true, italics: true })], spacing: { after: 0 } })],
								width: { size: wDr, type: WidthType.DXA },
								shading: avgShading, borders: cellBorders(), margins: CELL_MARGIN,
							}),
						]
					}),
				]
			});
		};

		// ─── Speaker sections ──────────────────────────────────────────────────
		const SPEAKER_CRITERIA = [
			{ label: 'Knowledgeable of the topic and well organized', token: 'knowledgeable of the topic' },
			{ label: 'The Resource Person was well prepared', token: 'resource person was well prepared' },
			{ label: 'Materials and presentations were relevant', token: 'materials and presentations were relevant' },
			{ label: 'Started and ended on time', token: 'start and end on time' },
			{ label: 'The Resource Speaker was engaging and supportive', token: 'engaging and supportive' },
			{ label: 'Demonstrated a clear understanding of the content', token: 'clear understanding of the content' },
		];

		const realSpeakerNames = (p.days || []).flatMap(d => (d.speakers || []).map(s => s.name?.trim()).filter(Boolean));
		const sortedSpk = [...speakerAverages].sort((a, b) =>
			String(a.day_sheet || '').localeCompare(String(b.day_sheet || '')) ||
			(a.slot_number || 0) - (b.slot_number || 0)
		);
		// Group speakers into one summary row per person, merging their scores
		// across every day/session they appeared in — even when the designation
		// text after the name is entered slightly differently between days.
		// SAFEGUARD: if two people's "Name, Title" blocks get concatenated into
		// a single field (a joint session where two speakers share one score),
		// that entry is much longer than a normal solo entry for either person.
		// So within each core-name group we only merge entries whose overall
		// length is close to one another; an entry far longer than its group's
		// other entries is kept as its own distinct row instead, since that
		// score belongs to the pair, not to either person individually.
		const SPEAKER_LENGTH_DIFF_THRESHOLD = 25;
		const speakerClustersByCore = new Map(); // coreName -> [{ name, scores, refLen }]
		const addSpeakerScore = (rawName, rawAvg) => {
			const s = (rawName || '').replace(/\s+/g, ' ').trim();
			const commaIdx = s.indexOf(',');
			const core = (commaIdx >= 0 ? s.slice(0, commaIdx) : s).replace(/\s+/g, ' ').trim().toLowerCase();
			if (!speakerClustersByCore.has(core)) speakerClustersByCore.set(core, []);
			const clusters = speakerClustersByCore.get(core);
			let best = null, bestDiff = Infinity;
			for (const c of clusters) {
				const diff = Math.abs(c.refLen - s.length);
				if (diff < bestDiff) { bestDiff = diff; best = c; }
			}
			if (best && bestDiff <= SPEAKER_LENGTH_DIFF_THRESHOLD) {
				if (!isNaN(rawAvg) && rawAvg > 0) best.scores.push(rawAvg);
			} else {
				const cluster = { name: rawName, scores: [], refLen: s.length };
				if (!isNaN(rawAvg) && rawAvg > 0) cluster.scores.push(rawAvg);
				clusters.push(cluster);
			}
		};

		const speakerBlocks = [];

		if (sortedSpk.length) {
			sortedSpk.forEach((sp, idx) => {
				const slot = sp.slot_number || (idx + 1);
				const spName = realSpeakerNames[idx] || sp.speaker_name || `Speaker ${slot}`;
				const criteria = sp.criteria || [];

				const speakerRows = SPEAKER_CRITERIA.map((def, ci) => {
					let s = null;
					if (criteria.length) {
						const c = criteria[ci] || criteria.find(c =>
							normalise(c.criterion_label || '').includes(def.token.slice(0, 12))
						);
						if (c) s = parseFloat(c.average_score);
					}
					if (s === null || isNaN(s)) s = getColAvgSlot(def.token, slot);
					if (s === null || isNaN(s)) s = parseFloat(sp.overall_avg || 0);
					const sStr = !isNaN(s) && s > 0 ? s.toFixed(2) : '—';
					return { label: def.label, score: sStr, desc: sStr !== '—' ? getInterpretation(parseFloat(sStr), 'speaker') : '—' };
				});

				speakerBlocks.push(
					new Paragraph({
						children: [bRun(`${speakerSectionNumber}.${idx + 1} RESOURCE PERSON (DAY ${sp.day_sheet || idx + 1}-SESSION ${sp.slot_number || idx + 1}) ${spName}`.replace(/DAY\s+Day\b/i, 'Day'))],
						spacing: { before: 160, after: 80 }
					}),
					buildIndicatorTable(speakerRows, 'speaker'),
					emptyPara()
				);

				addSpeakerScore(spName, parseFloat(sp.overall_avg || 0));
			});
		} else if (realSpeakerNames.length) {
			realSpeakerNames.forEach((name, idx) => {
				const rows = SPEAKER_CRITERIA.map(def => ({ label: def.label, score: '—', desc: '—' }));
				speakerBlocks.push(
					new Paragraph({
						children: [bRun(`${speakerSectionNumber}.${idx + 1} RESOURCE PERSON (SESSION ${idx + 1}) ${name}`)],
						spacing: { before: 160, after: 80 }
					}),
					buildIndicatorTable(rows, 'speaker'),
					emptyPara()
				);
				addSpeakerScore(name, NaN);
			});
		}

		// Flatten the clusters into the summary rows used by Section III,
		// combining every appearance of the same speaker (across all days)
		// into one averaged row, in order of first appearance.
		const speakerSummaryRows = [];
		speakerClustersByCore.forEach(clusters => clusters.forEach(({ name, scores }) => {
			if (scores.length) {
				const combinedAvg = (scores.reduce((sum, v) => sum + v, 0) / scores.length).toFixed(2);
				speakerSummaryRows.push([name, combinedAvg, getInterpretation(parseFloat(combinedAvg), 'speaker')]);
			} else {
				speakerSummaryRows.push([name, '—', '—']);
			}
		}));

		// ─── Participant Feedback table ────────────────────────────────────────
		const FEEDBACK_NOISE_RX = /^(none|nothing|no|nope|n\/a|na|n\.a\.?|nil|ok|okay|good|great|fine|yes|\.|-|--)$/i;
		const cleanFeedbackValue = v => {
			const s = String(v || '').replace(/\s+/g, ' ').trim();
			if (!s) return '';
			if (FEEDBACK_NOISE_RX.test(s)) return '';
			if (/^\d+(\.\d+)?$/.test(s)) return '';
			if (/^[^a-zA-Z0-9]+$/.test(s)) return '';
			return s;
		};

		// Build feedback columns dynamically from actual data keys — same approach
		// as buildReportHTML so all exports stay in sync regardless of form changes.
		const FB_SKIP_WORD = new Set(['respondent_id', 'day_sheet', 'day', 'labels', 'id',
			'feedback_expectations', 'feedback_improvements', 'feedback_insights', 'feedback_further',
			'expectations', 'improvements', 'insights', 'further', 'met_expectations', 'additional_training']);
		const normFbKeyWord = key =>
			String(key || '').replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')
				.replace(/\bDAY\s+\d+\b/gi, '').replace(/\s{2,}/g, ' ').trim();
		const rawByNormWord = new Map();
		for (const fb of (feedbackData || [])) {
			for (const rawKey of Object.keys(fb)) {
				if (FB_SKIP_WORD.has(rawKey)) continue;
				const norm = rawKey.startsWith('__pos_') ? rawKey : normFbKeyWord(rawKey);
				if (!rawByNormWord.has(norm)) rawByNormWord.set(norm, []);
				if (!rawByNormWord.get(norm).includes(rawKey)) rawByNormWord.get(norm).push(rawKey);
			}
		}
		if (!rawByNormWord.size) {
			[
				['feedback_improvements', 'improvements'],
				['feedback_insights',     'insights'],
				['feedback_further',      'further'],
				['feedback_expectations', 'expectations'],
			].forEach(([a, b]) => {
				if ((feedbackData || []).some(fb => fb[a] || fb[b])) rawByNormWord.set(a, [a, b]);
			});
		}
		const feedbackColumnsMaster = [...rawByNormWord.entries()].map(([normKey, rawKeys], i) => ({
			key: normKey,
			header: normKey.startsWith('__pos_') ? ('Feedback ' + (i + 1)) : normKey,
			value: fb => cleanFeedbackValue(rawKeys.map(k => fb[k] || '').find(v => v) || ''),
		}));

		const isMeaningfulFeedback = v => cleanFeedbackValue(v) !== '';

		// Group feedbackData by day_sheet for per-day rendering.
		// When a specific day is selected, day_sheet on each row may be empty
		// (the API already filtered to that day), so fall back to selectedDayId.
		const feedbackDayMap = new Map();
		for (const fb of (feedbackData || [])) {
			const label = (fb.day_sheet || '').trim() || (selectedDayId ? (p.days?.[0]?.title || String(selectedDayId)) : '');
			if (!feedbackDayMap.has(label)) feedbackDayMap.set(label, []);
			feedbackDayMap.get(label).push(fb);
		}
		const perDayFeedback = [...feedbackDayMap.entries()].map(([label, rows]) => ({ label, rows }));
		if (!perDayFeedback.length) perDayFeedback.push({ label: '', rows: [] });

		const feedbackColumnsBase = feedbackColumnsMaster;

		const buildFeedbackTable = (rows) => {
			const cols = feedbackColumnsBase.filter(col => rows.some(fb => isMeaningfulFeedback(col.value(fb))));
			const activeRows = rows.filter(fb => cols.some(col => isMeaningfulFeedback(col.value(fb))));
			if (!cols.length || !activeRows.length) return null;
			const fbColW = cols.map(() => Math.floor(CONTENT_W / cols.length));
			fbColW[fbColW.length - 1] += CONTENT_W - fbColW.reduce((a, b) => a + b, 0);
			return new Table({
				width: { size: CONTENT_W, type: WidthType.DXA },
				columnWidths: fbColW,
				rows: [
					new TableRow({
						children: cols.map((col, i) => new TableCell({
							children: [new Paragraph({ children: [bRun(col.header, { size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 0 } })],
							width: { size: fbColW[i], type: WidthType.DXA },
							shading: headerShading, borders: cellBorders(), margins: CELL_MARGIN,
						}))
					}),
					...activeRows.map(fb => new TableRow({
						children: cols.map((col, i) => new TableCell({
							children: [new Paragraph({ children: [run(col.value(fb), { size: 20 })], spacing: { after: 0 } })],
							width: { size: fbColW[i], type: WidthType.DXA },
							borders: cellBorders(), margins: CELL_MARGIN,
						}))
					}))
				]
			});
		};

		const hasMeaningfulFeedback = perDayFeedback.some(({ rows }) =>
			feedbackColumnsBase.some(col => rows.some(fb => isMeaningfulFeedback(col.value(fb))))
		);

		// Build per-day feedback blocks (heading + table per day)
		const feedbackBlocks = [];
		if (hasMeaningfulFeedback) {
			perDayFeedback.forEach(({ label, rows }) => {
				if (!rows.length) return;
				const tbl = buildFeedbackTable(rows);
				if (!tbl) return;
				if (label) {
					feedbackBlocks.push(new Paragraph({
						children: [bRun(label, { size: 21, italics: true })],
						spacing: { before: 80, after: 40 },
						indent: { left: 360 },
					}));
				}
				feedbackBlocks.push(tbl, emptyPara());
			});
		}

		// ─── Display dates ────────────────────────────────────────────────────
		// When a specific day is selected for a container program, prefer that
		// import's own inclusive_dates / start_date over the container's dates.
		const _wordSelImp = selectedDayId && pRaw.program_type === 'container'
			? (pRaw.linked_imports || []).find(imp => String(imp.program_id) === String(selectedDayId))
			: null;
		const _wordDateSource = _wordSelImp || p;
		const displayDates = _wordDateSource.inclusive_dates
			|| (_wordDateSource.start_date
				? formatDate(_wordDateSource.start_date) + (_wordDateSource.end_date && _wordDateSource.end_date !== _wordDateSource.start_date
					? ' – ' + formatDate(_wordDateSource.end_date) : '') : '')
			|| p.inclusive_dates
			|| (p.start_date
				? formatDate(p.start_date) + (p.end_date && p.end_date !== p.start_date ? ' – ' + formatDate(p.end_date) : '') : '');

		const numPartic = parseInt(p.total_participants) || 0;
		const numDays = p.days?.length || p.days_count || 1;
		// Use actual per-day counts for avg if available, otherwise split evenly
		const _wDays = p.days || [];
		const _wHasPerDay = _wDays.some(d => d.respondents != null && d.respondents > 0);
		const avgPerDay = _wHasPerDay
			? Math.round(_wDays.reduce((s, d) => s + (d.respondents || 0), 0) / _wDays.length)
			: (numDays > 0 ? Math.round(totalResponses / numDays) : totalResponses);
		const displayRate = numPartic > 0 && avgPerDay > 0
			? Math.min((avgPerDay / numPartic) * 100, 100).toFixed(0) + '%'
			: '—';

		// ─── Header info table (no borders) ──────────────────────────────────
		// 3 columns: label, colon (aligned), value
		const infoLblW = 3000, infoColonW = 200, infoValW = CONTENT_W - infoLblW - infoColonW;
		const noBorders = { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL } };
		const infoRow = (label, value) => new TableRow({
			children: [
				new TableCell({
					children: [new Paragraph({ children: [bRun(label)], spacing: { after: 0 } })],
					width: { size: infoLblW, type: WidthType.DXA },
					borders: noBorders,
					margins: { top: 40, bottom: 40, left: 0, right: 0 },
				}),
				new TableCell({
					children: [new Paragraph({ children: [bRun(':')], spacing: { after: 0 } })],
					width: { size: infoColonW, type: WidthType.DXA },
					borders: noBorders,
					margins: { top: 40, bottom: 40, left: 0, right: 0 },
				}),
				new TableCell({
					children: [new Paragraph({ children: [run(value)], spacing: { after: 0 } })],
					width: { size: infoValW, type: WidthType.DXA },
					borders: noBorders,
					margins: { top: 40, bottom: 40, left: 0, right: 0 },
				}),
			]
		});

		const headerInfoTable = new Table({
			width: { size: CONTENT_W, type: WidthType.DXA },
			columnWidths: [infoLblW, infoColonW, infoValW],
			borders: {
				top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL },
				left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL },
				insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL },
			},
			rows: [
				infoRow('Title of Training Program', p.title || '—'),
				infoRow('Proponent/s', p.proponents || '—'),
				infoRow('Training Venues', p.venue || p.training_venue || '—'),
				infoRow('Inclusive Dates', displayDates),
				infoRow('Name of QAME Associates', p.qame_associates || `${SIGNATORIES().preparedBy.name}, ${SIGNATORIES().preparedBy.title}`),
				infoRow('Total Number of Participants', numPartic > 0 ? String(numPartic) : '—'),
				// Average Number of Responses — one line per day with individual percentage
				// e.g. "Day 1 - 50    83%"
				...(() => {
					const days = p.days || [];
					const hasPerDayCounts = days.some(d => d.respondents != null && d.respondents > 0);
					const dayParticipants = p.day_participants || {};
					const hasDayPartic = Object.keys(dayParticipants).length > 0;
					const buildLine = (dayLabel, cnt) => {
						const dayTotal = hasDayPartic
							? (dayParticipants[dayLabel] || 0)
							: numPartic;
						const denom = dayTotal > 0 ? dayTotal : numPartic;
						const pct = denom > 0 ? Math.min((cnt / denom) * 100, 100).toFixed(0) + '%' : '';
						return `${dayLabel} - ${cnt}${pct ? '    ' + pct : ''}`;
					};
					const lines = days.length
						? days.map((d, i) => {
							const cnt = hasPerDayCounts ? (d.respondents || 0) : Math.round(totalResponses / days.length);
							// FIX: use stored title/day label, not d.day_number (which was
							// hardcoded to 1 for all imports due to a prior save bug).
							const dayLabel = d.title || d.day || `Day ${i + 1}`;
							return buildLine(dayLabel, cnt);
						})
						: [buildLine('Day 1', totalResponses)];
					// First day uses the label row; subsequent days use blank-label rows
					return lines.map((line, idx) => infoRow(idx === 0 ? 'Average Number of Responses' : '', line));
				})(),
				infoRow('Percentage of Responses', displayRate),
			]
		});

		// ─── Evaluation Summary — Section I (Overall Ratings) ─────────────────
		const SUMMARY_LABEL_W = CONTENT_W - 3200;
		const SUMMARY_NUM_W = 1200;
		const SUMMARY_DESC_W = 2000;

		const overallRatingsTable = build3ColTable(
			['Indicators', 'Numerical Rating', 'Descriptive Rating'],
			summaryDefs.map(sd => {
				const raw = resolveSummaryAvg(sd.key);
				const s = raw !== null ? raw.toFixed(2) : '—';
				return [sd.label, s, s !== '—' ? getInterpretation(parseFloat(s), 'category') : '—'];
			}),
			[SUMMARY_LABEL_W, SUMMARY_NUM_W, SUMMARY_DESC_W],
			['Overall Average', overallAvg, overallDesc]
		);

		// ─── Evaluation Summary — Section II (Category Ratings) ──────────────
		// Uses detailDefs (one row per RAW category), not summaryDefs, since
		// "II. CATEGORY RATINGS" should list categories individually even
		// when "Group by Super Category" combines them in the "SUMMARY OF
		// RATINGS" table above. Label uses the raw category name as stored
		// (normal case), not the all-caps display title used for section headings.
		const detailDefs = detailSections.map(section => ({ label: section.name, key: section.avgSource }));
		const catRatingRows = detailDefs.length
			? detailDefs.map(sd => {
				const raw = resolveSummaryAvg(sd.key);
				const avg = raw !== null ? raw.toFixed(2) : '—';
				return [sd.label, avg, avg !== '—' ? getInterpretation(parseFloat(avg), 'category') : '—'];
			})
			: [['No data available', '—', '—']];

		const catRatingsTable = build3ColTable(
			['Category', 'Average Rating', 'Descriptive Rating'],
			catRatingRows,
			[SUMMARY_LABEL_W, SUMMARY_NUM_W, SUMMARY_DESC_W]
		);

		// ─── Evaluation Summary — Section III (Resource Persons Summary) ──────
		const spkSummaryTable = speakerSummaryRows.length
			? build3ColTable(
				['Speaker Name', 'Average Rating', 'Descriptive Rating'],
				speakerSummaryRows,
				[SUMMARY_LABEL_W, SUMMARY_NUM_W, SUMMARY_DESC_W]
			)
			: null;

		// ─── Section IV: Highlights from feedback (AI-assisted) ───────────────
		const improvements = cleanFeedbackValues(
			feedbackData.map(fb => fb.feedback_improvements || fb.improvements || '')
		).slice(0, 8);

		const furtherTopics = cleanFeedbackValues(
			feedbackData.map(fb => fb.feedback_further || fb.further || fb.additional_training || '')
		).slice(0, 8);

		const insightSnippets = cleanFeedbackValues(
			feedbackData.map(fb => fb.feedback_insights || fb.insights || '')
		).slice(0, 8);

		const hasUsefulFeedbackForHighlights = improvements.length > 0 || furtherTopics.length > 0 || insightSnippets.length > 0;

		const categorySectionBlocks = detailSections.flatMap((section, idx) => [
			sectionHeading(`${idx + 2}. ${section.title}`),
			buildIndicatorTable(section.rows, 'category', section.avgSource),
			emptyPara(),
		]);

		// ─── Assemble the full document ────────────────────────────────────────
		const children = [
			// ── QAME ANALYSIS Title ───────────────────────────────────────────
			new Paragraph({
				children: [bRun('QAME ANALYSIS', { size: 21, allCaps: true })],
				alignment: AlignmentType.LEFT,
				spacing: { after: 60 },
			}),
			// ── Sequence Number (e.g. SDOCB-SMME-2025-047) ───────────────────
			...(p.sequence_number ? [new Paragraph({
				children: [bRun(p.sequence_number, { size: 22, bold: true, font: 'Bookman Old Style' })],
				alignment: AlignmentType.LEFT,
				spacing: { after: 160 },
			})] : [new Paragraph({ spacing: { after: 160 } })]),

			// ── Header info block ─────────────────────────────────────────────
			headerInfoTable,
			emptyPara(),

			// ── 1. Summary of Ratings ─────────────────────────────────────────
			sectionHeading('1. SUMMARY OF RATINGS'),
			buildSummaryTable(),
			emptyPara(),

			// ── 2..N Dynamic Category Sections ───────────────────────────────
			...categorySectionBlocks,

			// ── Resource Persons (per-speaker tables) ─────────────────────────
			sectionHeading(`${speakerSectionNumber}. RESOURCE PERSONS`),
			...speakerBlocks,

			// ── Participant Feedback (per-day) ────────────────────────────────
			...(hasMeaningfulFeedback ? [
				sectionHeading('PARTICIPANT FEEDBACK'),
				...feedbackBlocks,
			] : []),

			// ── First signatory block ─────────────────────────────────────────
			sigTable(),
			emptyPara(),

			// ── Rating Scale Legend ───────────────────────────────────────────
			new Paragraph({
				children: [run('A. ', { italics: true, bold: true }), run('For Evaluation of PMT, Objectives, Content Relevance, Meals and Venue', { italics: true })],
				spacing: { before: 240, after: 80 },
			}),
			buildScaleTable('category'),
			new Paragraph({
				children: [run('B. ', { italics: true, bold: true }), run('For Resource Speaker', { italics: true })],
				spacing: { before: 140, after: 80 },
			}),
			buildScaleTable('speaker'),
			new Paragraph({
				children: [run('C. ', { italics: true, bold: true }), run('Over-all Score', { italics: true })],
				spacing: { before: 140, after: 80 },
			}),
			buildScaleTable('overall'),
			emptyPara(),

			// ── Page break before Evaluation Summary ─────────────────────────
			new Paragraph({ children: [new PageBreak()] }),

			// ── EVALUATION SUMMARY header ─────────────────────────────────────
			new Paragraph({
				children: [bRun('EVALUATION SUMMARY', { size: 26, underline: {}, allCaps: true })],
				alignment: AlignmentType.CENTER,
				spacing: { after: 60 },
			}),
			new Paragraph({
				children: [bRun(`${p.title} (1–${totalResponses}) ${formatDate(p.start_date)}`, { size: 22 })],
				alignment: AlignmentType.CENTER,
				spacing: { after: 160 },
			}),

			// ── I. Overall Ratings ────────────────────────────────────────────
			new Paragraph({ children: [bRun('I. OVERALL RATINGS')], spacing: { before: 120, after: 80 } }),
			overallRatingsTable,
			emptyPara(),

			// ── II. Category Ratings ──────────────────────────────────────────
			new Paragraph({ children: [bRun('II. CATEGORY RATINGS')], spacing: { before: 120, after: 80 } }),
			catRatingsTable,
			emptyPara(),

			// ── III. Resource Persons Summary ─────────────────────────────────
			new Paragraph({ children: [bRun('III. RESOURCE PERSONS – SUMMARY OF PERFORMANCE')], spacing: { before: 120, after: 80 } }),
			...(spkSummaryTable ? [spkSummaryTable] : [para('No speaker data available.')]),
			emptyPara(),


			// ── IV. Highlights from Participant Feedback ──────────────────────
			new Paragraph({ children: [bRun('IV. HIGHLIGHTS FROM PARTICIPANT FEEDBACK')], spacing: { before: 120, after: 80 } }),
			new Paragraph({ children: [bRun('A. STRENGTHS OF THE TRAINING')], spacing: { before: 80, after: 60 } }),
			emptyPara(),
			new Paragraph({ children: [bRun('B. AREAS FOR IMPROVEMENT')], spacing: { before: 100, after: 60 } }),
			emptyPara(),
			new Paragraph({ children: [bRun('C. SUGGESTED ADDITIONAL TOPICS')], spacing: { before: 100, after: 60 } }),
			emptyPara(),

			// ── V. Conclusion ─────────────────────────────────────────────────
			new Paragraph({ children: [bRun('V. CONCLUSION')], spacing: { before: 120, after: 80 } }),
			emptyPara(),

			// ── Second signatory block ────────────────────────────────────────
			sigTable(),
		];

		// ─── Fetch logo as ArrayBuffer for ImageRun ───────────────────────────
		let logoData = null;
		try {
			const logoPath = window.location.pathname.replace(/\/[^/]*$/, '') + '/images/kagawaran-ng-edukasyon-logo.png';
			const logoRes = await fetch(logoPath);
			if (logoRes.ok) logoData = await logoRes.arrayBuffer();
		} catch (_) { /* logo optional — skip if unavailable */ }

		// ─── Fetch footer logos ───────────────────────────────────────────────
		const fetchImg = async relPath => {
			try {
				const base = window.location.pathname.replace(/\/[^/]*$/, '');
				const res = await fetch(base + relPath);
				return res.ok ? await res.arrayBuffer() : null;
			} catch (_) { return null; }
		};
		const depedLogoData = await fetchImg('/images/DepED-logo.png');
		const bagongPilipinasData = await fetchImg('/images/bagong-pilipinas-logo.png');
		const divisionSealData = await fetchImg('/images/SDO-Seal.png');
		const emailLogoData = await fetchImg('/images/old-gmail-logo.png');
		const facebookLogoData = await fetchImg('/images/Facebook-Logo-Circle-Creation-PNG.png');

		// ─── Header builder ───────────────────────────────────────────────────
		const headerChildren = [];

		if (logoData) {
			headerChildren.push(new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new ImageRun({
					type: 'png',
					data: logoData,
					transformation: { width: 70, height: 70 },
					altText: { title: 'DepEd Logo', description: 'DepEd Logo', name: 'DepEdLogo' }
				})]
			}));
		}

		headerChildren.push(
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new TextRun({ text: 'Republic of the Philippines', font: 'Old English Text MT', size: 22 })]
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new TextRun({ text: 'Department of Education', font: 'Old English Text MT', size: 32 })]
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new TextRun({ text: 'REGION III-CENTRAL LUZON', font: 'Times New Roman', size: 18 })]
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new TextRun({ text: 'SCHOOLS DIVISION OF CITY OF BALIWAG', font: 'Tahoma', size: 22, bold: true })]
			}),
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 0, after: 0 },
				children: [new TextRun({ text: 'City of Baliwag, Bulacan', font: 'Tahoma', size: 20, bold: true })]
			}),
			// Header divider as one-cell table border (Word Borders and Shading style)
			dividerTable('bottom', '')
		);

		// ── Footer: using floating images for absolute positioning ──────────────
		// Conversion: inches × 914400 = EMUs (for floating positions)
		// transformation uses pixels: 1 inch = 96px
		const in2emu = n => Math.round(n * 914400);
		const in2px = n => Math.round(n * 96);

		const ftRun = (text, opts = {}) =>
			new TextRun({ text, font: 'Cambria', size: 18, ...opts });

		// Helper: floating ImageRun anchored to a paragraph
		const floatingImg = (data, imgType, wIn, hgtIn, hPos, vPos, name) =>
			data ? new ImageRun({
				type: imgType,
				data,
				transformation: { width: in2px(wIn), height: in2px(hgtIn) },
				altText: { title: name, description: name, name: name.replace(/\s/g, '') },
				floating: {
					horizontalPosition: { relative: 'page', offset: in2emu(hPos) },
					verticalPosition: { relative: 'paragraph', offset: in2emu(vPos) },
					wrap: { type: 'none' },
					behindDocument: false,
				},
			}) : null;

		// ── Divider line at footer top as one-cell table border

		// ── Logos: sized & positioned to match reference document ───
		// hPos = distance from page left edge (inches)
		// vPos = distance from top of anchor paragraph (inches) w horizontal wrap (no vertical wrap)
		const imgDepEd   = floatingImg(depedLogoData,      'png', 1.06, 0.67, 0.25, 0, 'DepEdLogo');
        const imgBagong  = floatingImg(bagongPilipinasData, 'png', 0.73, 0.73, 1.46, 0, 'BagongPilipinas');
        const imgSDO     = floatingImg(divisionSealData,    'png', 0.70, 0.70, 2.25, 0, 'SDOSeal');
        const imgEmail   = floatingImg(emailLogoData,       'png', 0.18, 0.14, 3.30,  0.61, 'EmailLogo');
        const imgFacebook= floatingImg(facebookLogoData,    'png', 0.28, 0.22, 5.42,  0.56, 'FacebookLogo');

		// ── Single paragraph: floating logos + right-aligned contact text ──
		// Line 1: address | Line 2: telephone | Line 3: email + facebook
		const ftCombined = new Paragraph({
			alignment: AlignmentType.RIGHT,
			spacing: { before: 0, after: 0 },
			indent: { left: -1440, right: -821 },  // right: added ~0.25" padding from edge
			children: [
				...[imgDepEd, imgBagong, imgSDO, imgEmail, imgFacebook].filter(Boolean),
				ftRun('2nd Floor, Bayanihan Building, Doña Remedios Trinidad (DRT) Highway,'),
				new TextRun({ break: 1 }),
				ftRun('Barangay Pagala, City of Baliwag, Bulacan'),
				new TextRun({ break: 1 }),
				ftRun('Telephone No: ', { bold: true }),
				ftRun('(044) 762-2793'),
				new TextRun({ break: 1 }),
				new TextRun({ break: 1 }),
				ftRun('      baliwag.city@deped.gov.ph'),
				ftRun('                    '),
				ftRun('      https://www.facebook.com/SDOCityofBaliwag'),
			],
		});

		const footerChildren = [
            dividerTable('top'),
            ftCombined,
        ];


		// ─── Build and save ───────────────────────────────────────────────────
		const doc = new Document({
			styles: {
				default: {
					document: { run: { font: 'Bookman Old Style', size: 22 } }
				}
			},
			sections: [{
				properties: {
					page: {
						size: { width: 12240, height: 15840 },
						margin: {
							top: 1440, right: 1181, bottom: 1094, left: 1440,
							header: 360, footer: 360
						}
					}
				},
				headers: {
					default: new Header({ children: headerChildren })
				},
				footers: {
					default: new Footer({ children: footerChildren })
				},
				children
			}]
		});

		const blob = await Packer.toBlob(doc);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `QAME_Report_${p.title.replace(/[^a-z0-9]/gi, '_')}.docx`;
		a.click();
		URL.revokeObjectURL(url);
		showAlert('success', 'Word document exported successfully');
	} catch (e) {
		console.error(e);
		showAlert('error', 'Failed to export Word document');
	}
}

// PART 5 OF 5 — PPT Export, Records, Helpers
// Sections: 20-25 (PPT export, AI summary, evaluation link, records, shared helpers)

// ─── 20. EXPORT TO PPT ─────────────────────────────────────────────────────
async function exportReportToPPT() {
	if (!State.workshopData) { showAlert('error', 'No data to export.'); return; }
	// totalResponses is resolved after we know the selected day (inside try block below).
	// Do a quick early-exit check using the broadest count first.
	const _imports = State.workshopData?.linked_imports || [];
	const _broadResponses = (
		State.workshopData?.program_type === 'container' && _imports.length > 0
			? _imports.reduce((s, imp) => s + (imp.total_responses || 0), 0)
			: (State.responses.length || State.workshopData?.total_responses || 0)
	);
	if (!_broadResponses) { showAlert('error', 'No responses available to export'); return; }

	try {
		const pptx = new PptxGenJS();
		const pRaw = State.workshopData;
		const getSavedFeedbackLabels = (programLike) => {
			const direct = programLike?.feedback_labels || programLike?.feedbackLabels;
			if (direct && typeof direct === 'object') return direct;
			const snapStr = programLike?.settings_snapshot || programLike?.settingsSnapshot || '';
			if (!snapStr) return null;
			try {
				const snap = JSON.parse(snapStr);
				const labels = snap?.feedback_labels || snap?.feedbackLabels || null;
				return (labels && typeof labels === 'object') ? labels : null;
			} catch (_) {
				return null;
			}
		};
		const savedFbLabels = getSavedFeedbackLabels(pRaw) || {};
		const fbLabel = (key, fallback) => {
			const v = savedFbLabels?.[key];
			return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
		};
		const selectedDayId = document.getElementById('reportDaySelect')?.value || '';
		const reportSourceId = getReportDataSourceId();
		const scales = await loadRatingScales();
		const data = await fetchReportData(reportSourceId, selectedDayId);
		const { categories, columnAverages, speakerAverages, feedbackData } = data;
		// Use the API-returned respondent count (already scoped to the selected day)
		const totalResponses = data.totalRespondents || _broadResponses;

		// Fetch SDO Seal for PPT header logo
		const pptSealData = await (async () => {
			try {
				const base = window.location.pathname.replace(/\/[^/]*$/, '');
				const res = await fetch(base + '/images/SDO-Seal.png');
				if (!res.ok) return null;
				const buf = await res.arrayBuffer();
				const bytes = new Uint8Array(buf);
				let binary = '';
				bytes.forEach(b => binary += String.fromCharCode(b));
				return 'data:image/png;base64,' + btoa(binary);
			} catch (_) { return null; }
		})();

		// Enrich p.days — scoped to the selected day if one is chosen
		const p = { ...pRaw };
		if (pRaw.program_type === 'container' && (pRaw.linked_imports || []).length > 0) {
			if (selectedDayId) {
				// Specific day selected: narrow to just that import
				const selImp = pRaw.linked_imports.find(imp => String(imp.program_id) === String(selectedDayId));
				const selImpIdx = selImp ? pRaw.linked_imports.indexOf(selImp) : 0;
				p.days = selImp
					? [{ day_number: selImp.day_number || (selImpIdx + 1), title: selImp.day_label || `Day ${selImpIdx + 1}`, respondents: data.totalRespondents }]
					: [];
			} else {
				// All days combined
				p.days = pRaw.linked_imports.map((imp, i) => ({
					day_number:  imp.day_number  || (i + 1),
					title:       imp.day_label   || `Day ${i + 1}`,
					respondents: imp.total_responses || 0,
				}));
			}
		}
		// Standalone: narrow p.days to the selected day (mirrors Generate Preview fix)
		const isStandalonePPT = pRaw.source_type === 'standalone' ||
			(State.isRecord && pRaw.program_type !== 'container');
		if (isStandalonePPT && selectedDayId) {
			const allDays = pRaw.days || [];
			const matchedDay = allDays.find(d =>
				(d.title || d.day || `Day ${d.day_number}`) === selectedDayId
			);
			p.days = matchedDay
				? [{ ...matchedDay, respondents: data.totalRespondents }]
				: [{ day_number: 1, title: selectedDayId, respondents: data.totalRespondents }];
		}

		// ── Fetch respondents scoped to the selected day (or all days if none selected) ──
		// For container + specific day: fetch only that import's responses.
		// For container + all days: fetch all imports (deduplication applied below).
		// For standalone + specific day: filter State.responses by day_sheet.
		const _allDayRespondents = await (async () => {
			if (p.program_type === 'container' && (p.linked_imports || []).length > 0) {
				const importsToFetch = selectedDayId
					? (p.linked_imports || []).filter(imp => String(imp.program_id) === String(selectedDayId))
					: (p.linked_imports || []);
				const allRows = [];
				for (const imp of importsToFetch) {
					try {
						const r = await fetch(`${API_URL}/responses.php?program_id=${imp.program_id}`, { credentials: 'include' });
						const j = await r.json();
						if (j.success) allRows.push(...(j.data || []));
					} catch (_) { /* non-fatal */ }
				}
				return allRows;
			}
			// Standalone: filter by day_sheet if a specific day is selected
			const responses = State.responses || [];
			if (selectedDayId && responses.length > 0) {
				const filtered = responses.filter(r =>
					(r.day_sheet || r.day || '').toLowerCase() === selectedDayId.toLowerCase()
				);
				return filtered.length > 0 ? filtered : responses;
			}
			return responses;
		})();
		// Unique respondent count: deduplicate by participant_id, then email, then name —
		// matches the pattern used everywhere else in this file and the server's own
		// dedup logic in responses.php.
		// BUG FIX: this previously fell back to r.id before name — but r.id is the
		// response record's own unique database row ID, so it can never equal another
		// row's id. That silently defeated dedup entirely (every row "matched" only
		// itself), counting someone who submitted on both Day 1 and Day 2 as two
		// separate respondents instead of one — inflating this count above the
		// server-computed total_respondents and causing the PPT's header line and
		// RESPONSES badge to disagree.
		const _uniqueRespondents = (() => {
			const seen = new Set();
			return _allDayRespondents.filter(r => {
				const key = r.participant_id
					|| (r.email && r.email.trim() ? r.email.trim().toLowerCase() : '')
					|| (r.respondent_name || r.full_name || r.name || '').toLowerCase().trim();
				if (!key || seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		})();
		const uniqueRespondentCount = _uniqueRespondents.length || totalResponses;

		// ══════════════════════════════════════════════════════════════════════
		// LAYOUT — True 16:9 Widescreen 13.33" × 7.5"
		// ══════════════════════════════════════════════════════════════════════
		const W = 13.33;
		const H = 7.50;
		pptx.defineLayout({ name: 'WIDE169', width: W, height: H });
		pptx.layout = 'WIDE169';

		// ══════════════════════════════════════════════════════════════════════
		// DESIGN TOKENS
		// ══════════════════════════════════════════════════════════════════════
		const C = {
			primary:    '1E3A8A',
			accent:     '2563EB',
			lightBg:    'EFF4FF',
			dark:       '1F2937',
			gray:       '6B7280',
			borderGray: 'E2E8F0',
			light:      'F1F5F9',
			white:      'FFFFFF',
			gold:       'F59E0B',
			goldDark:   'D97706',
			green:      '059669',
			greenBg:    'D1FAE5',
			amberBg:    'FEF3C7',
			pink:       'EC4899',
			pinkBg:     'FCE7F3',
			purple:     '7C3AED',
			purpleBg:   'EDE9FE',
		};

		// (legacy helper stubs removed — new helpers defined below)

		let pageNum = 0;

		// ── Computed values ────────────────────────────────────────────────────
		const catScores  = categories.map(c => parseFloat(c.average_score || 0)).filter(n => n > 0);
		// BUG FIX: this used to be a simple mean of the 6 category averages
		// (mean-of-means), which drifts from the live dashboard's "OVER-ALL SCORE"
		// whenever categories have different numbers of answered questions — that's
		// what caused the PPT's overall score to differ from the dashboard by a few
		// hundredths (e.g. 3.97 vs 3.98). The dashboard computes a true weighted
		// average across every individual score row (AVG(rs.score)); responses.php
		// now returns that same figure as overallWeightedAverage, so use it here and
		// only fall back to the mean-of-means if it's unavailable for some reason.
		const overallAvg = (data.overallWeightedAverage !== null && data.overallWeightedAverage !== undefined && !isNaN(data.overallWeightedAverage))
			? data.overallWeightedAverage
			: (catScores.length ? catScores.reduce((a, b) => a + b, 0) / catScores.length : 0);
		const overallDesc = overallAvg > 0 ? getInterpretation(overallAvg, 'overall') : '—';
		// Same tie-rounding fix as the indicator rows below: round before toFixed()
		// so an exact .5 average (e.g. 3.985) matches the dashboard's rounding.
		const overallStr  = overallAvg > 0 ? (Math.round(overallAvg * 100) / 100).toFixed(2) : '—';
		const numPartic   = parseInt(p.total_participants) || uniqueRespondentCount;
		const pptNumDays  = p.days?.length || p.days_count || 1;
		// When a specific day is selected for a container program, prefer that
		// import's own inclusive_dates / start_date over the container's dates.
		const _pptSelImp = selectedDayId && pRaw.program_type === 'container'
			? (pRaw.linked_imports || []).find(imp => String(imp.program_id) === String(selectedDayId))
			: null;
		const _pptDateSource = _pptSelImp || p;
		const displayDates = _pptDateSource.inclusive_dates
			|| (_pptDateSource.start_date
				? formatDate(_pptDateSource.start_date) + (_pptDateSource.end_date && _pptDateSource.end_date !== _pptDateSource.start_date
					? ' \u2013 ' + formatDate(_pptDateSource.end_date) : '') : '')
			|| (p.inclusive_dates
				|| (p.start_date
					? formatDate(p.start_date) + (p.end_date && p.end_date !== p.start_date
						? ' \u2013 ' + formatDate(p.end_date) : '') : ''));
		// Total expected = per-day participants × number of days (for multi-day "All Days" combined view)
		const totalExpectedPpt = numPartic * (pptNumDays > 1 ? pptNumDays : 1);
		const responseRatePct = totalExpectedPpt > 0
			? Math.min((uniqueRespondentCount / totalExpectedPpt) * 100, 100).toFixed(0) + '%' : '—';
		const showExpected = numPartic && numPartic !== uniqueRespondentCount;

		// ── Gender breakdown (deduplicated unique respondents) ─────────────────
		const genderCounts = { Male: 0, Female: 0, Other: 0 };
		_uniqueRespondents.forEach(r => {
			const s = (r.sex || r.gender || '').trim().toLowerCase();
			if (s === 'male')        genderCounts.Male++;
			else if (s === 'female') genderCounts.Female++;
			else if (s)              genderCounts.Other++;
		});
		const gTotal = genderCounts.Male + genderCounts.Female + genderCounts.Other;

		// ── Score colour helper (0-4 scale) ────────────────────────────────────
		const scoreColor = score => {
			if (!score || score <= 0) return { bg: '546E7A', text: 'FFFFFF', pill: 'B0BEC5' };
			if (score >= 3.50) return { bg: '1B7A1B', text: 'FFFFFF', pill: 'D1FAE5' };
			if (score >= 2.50) return { bg: '1565C0', text: 'FFFFFF', pill: 'DBEAFE' };
			if (score >= 1.50) return { bg: 'E65100', text: 'FFFFFF', pill: 'FEF3C7' };
			return { bg: 'B71C1C', text: 'FFFFFF', pill: 'FEE2E2' };
		};

		// ── Feedback quality filter ─────────────────────────────────────────────
		const USELESS_RX = /^(yes|no|n\/a|na|none|ok|okay|good|great|fine|noted|thanks|thank\s*you|n\.a\.?)\??\.?$/i;
		const hasAnySavedFbLabel = Object.values(savedFbLabels || {}).some(v => typeof v === 'string' && v.trim());
		const isUseful = text => {
			const t = String(text || '').trim();
			if (t.length < 4) return false;
			if (/^\d+(\.\d+)?$/.test(t)) return false;
			if (USELESS_RX.test(t)) return false;
			return t.split(/\s+/).length >= 2;
		};

		// ── Shared header helper ────────────────────────────────────────────────
		const addStdHeader = (sl, title, sub = '') => {
			// Royal blue header bar
			sl.addShape(pptx.shapes.RECTANGLE, {
				x: 0, y: 0, w: W, h: 0.82,
				fill: { color: C.primary }, line: { color: C.primary }
			});
			// Kelly green accent stripe
			sl.addShape(pptx.shapes.RECTANGLE, {
				x: 0, y: 0.82, w: W, h: 0.06,
				fill: { color: C.green }, line: { color: C.green }
			});
			if (pptSealData) {
				sl.addImage({ data: pptSealData, x: 0.18, y: 0.04, w: 0.72, h: 0.72 });
			}
			sl.addText(title, {
				x: pptSealData ? 1.04 : 0.38, y: 0, w: W - (pptSealData ? 1.50 : 0.80), h: sub ? 0.50 : 0.82,
				fontSize: sub ? 17 : 20, bold: true, color: C.white,
				valign: sub ? 'bottom' : 'middle', fontFace: 'Calibri'
			});
			if (sub) {
				sl.addText(sub, {
					x: pptSealData ? 1.04 : 0.38, y: 0.50, w: W - (pptSealData ? 1.50 : 0.80), h: 0.30,
					fontSize: 10, color: 'A5C4E8', italic: true, valign: 'top', fontFace: 'Calibri'
				});
			}
		};

		const addPageNum = (sl, num) => {
			sl.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
				x: W - 0.60, y: H - 0.38, w: 0.46, h: 0.26,
				fill: { color: 'E2E8F0' }, line: { color: 'CBD5E1' }, rectRadius: 0.05
			});
			sl.addText(String(num), {
				x: W - 0.60, y: H - 0.38, w: 0.46, h: 0.26,
				fontSize: 8, color: C.gray, align: 'center', valign: 'middle', fontFace: 'Calibri'
			});
		};

		// ═══════════════════════════════════════════════════════════════════════
		// SLIDE 1 — EVALUATION DASHBOARD
		// Mirrors the workshop-dashboard.html layout exactly:
		//   ┌─────────────────── HEADER CARD ──────────────────────────┐
		//   │  [Logo] | Title / subtitle / dates+venue  │ Overall Score │
		//   └──────────────────────────────────────────────────────────┘
		//   ┌──── PARTICIPANTS ─────┐  ┌──────── INDICATORS ───────────┐
		//   │  Donut pie  │ gender  │  │  Name label   │ Score badge   │
		//   └──────────────────────┘  └──────────────────────────────-─┘
		//   ┌────────────────── RESOURCE SPEAKERS ROW ──────────────────┐
		//   │  RESOURCE SPEAKERS │  ⬤name  ⬤name … │  RESPONSES  N  │
		//   └──────────────────────────────────────────────────────────┘
		// ═══════════════════════════════════════════════════════════════════════
		let slide = pptx.addSlide();
		slide.background = { color: 'EEF2FF' };   // matches CSS gradient base
		pageNum++;

		// ── Score colour helper that returns the dashboard CSS class palette ──
		// green ≥3.50 | blue 2.50-3.49 | yellow/amber 1.50-2.49 | red <1.50
		const dashScoreColors = sc => {
			if (!sc || sc <= 0) return { label: '546E7A', labelBg: 'ECEFF1', score: '546E7A', scoreBg: '546E7A' };
			if (sc >= 3.26) return { label: '1a3a6b', labelBg: '2456a4', score: 'F5D800', scoreBg: '1E8C1E' };
			if (sc >= 2.51) return { label: '1a3a6b', labelBg: '2456a4', score: 'F5D800', scoreBg: '1565C0' };
			if (sc >= 1.76) return { label: '1a3a6b', labelBg: '2456a4', score: 'F5D800', scoreBg: 'F57F17' };
			return  { label: '1a3a6b', labelBg: '2456a4', score: 'F5D800', scoreBg: 'C62828' };
		};
		// Uses the same getInterpretation() as the HTML report preview so that
		// labels in the PPT always match the rating scale loaded from the DB.
		const dashRatingLabel = sc => {
			if (!sc || sc <= 0) return 'N/A';
			return getInterpretation(sc, 'category');
		};

		// ─────────────────────────────────────────────────────────────────
		// HEADER CARD  (dark-blue gradient card, full width, rounded rect)
		// ─────────────────────────────────────────────────────────────────
		const HDR_X = 0.22, HDR_Y = 0.18, HDR_W = W - 0.44, HDR_H = 1.42;
		const LOGO_W = 1.10; // logo + separator zone width

		// Card background (dark blue)
		slide.addShape(pptx.shapes.RECTANGLE, {
			x: HDR_X, y: HDR_Y, w: HDR_W, h: HDR_H,
			fill: { color: '1a3a6b' }, line: { color: '2456a4', pt: 1.5 }, rectRadius: 0
		});

		// SDO Seal logo on the left inside the card
		if (pptSealData) {
			slide.addImage({ data: pptSealData, x: HDR_X + 0.14, y: HDR_Y + 0.16, w: 1.08, h: 1.08, rounding: true });
		}

		// Separator line after logo
		const SEP_X = HDR_X + LOGO_W + (pptSealData ? 0.32 : 0);
		slide.addShape(pptx.shapes.RECTANGLE, {
			x: SEP_X, y: HDR_Y + 0.12, w: 0.012, h: HDR_H - 0.24,
			fill: { color: 'FFFFFF', transparency: 65 }, line: { type: 'none' }
		});

		// Title text block (program title + sub-info + dates/venue)
		const TEXT_X = SEP_X + 0.18;
		// Overall score box width on right
		const OSB_W = 1.80;
		const TEXT_W = HDR_W - (TEXT_X - HDR_X) - OSB_W - 0.10;

		// Day prefix: for container use the matched import's day_label;
		// for standalone Excel use the selectedDayId string directly (it IS the day label).
		const _selImpLabel = _pptSelImp?.day_label
			|| (isStandalonePPT && selectedDayId && isNaN(parseInt(selectedDayId)) ? selectedDayId : null);
		const _daysPrefix = _selImpLabel ? `(${_selImpLabel}) ` : '';
		const titleText = (_daysPrefix + (p.title || 'WORKSHOP EVALUATION')).toUpperCase();
		const titleFontSize = titleText.length > 90 ? 12 : titleText.length > 60 ? 14 : 16;
		slide.addText(titleText, {
			x: TEXT_X, y: HDR_Y + 0.10, w: TEXT_W, h: 0.54,
			fontSize: titleFontSize, bold: true, color: 'FFFFFF',
			valign: 'middle', wrap: true, fontFace: 'Calibri', margin: 0
		});

		// Sub-line: dates + venue
		const subParts = [];
		if (displayDates) subParts.push(displayDates);
		if (p.venue || p.training_venue) subParts.push(p.venue || p.training_venue);
		if (subParts.length) {
			slide.addText(subParts.join('  |  '), {
				x: TEXT_X, y: HDR_Y + 0.66, w: TEXT_W, h: 0.28,
				fontSize: 9.5, color: 'A5C4E8', valign: 'middle',
				wrap: true, fontFace: 'Calibri', margin: 0
			});
		}

		// Respondents line — only show 'X of N (%)' when total_participants was explicitly set
		// BUG FIX: was showing numPartic (the single-day expected headcount) as the
		// denominator, while responseRatePct above was already correctly computed
		// against totalExpectedPpt (numPartic × number of days for multi-day workshops).
		// That mismatch produced nonsense like "97 of 48 expected responded (100%)" —
		// the percentage used the right multi-day total, but the printed number didn't.
		const _hasRealPartic = parseInt(p.total_participants) > 0;
		const respLine = _hasRealPartic
			? `${uniqueRespondentCount} of ${totalExpectedPpt} expected responded  (${responseRatePct})`
			: `${uniqueRespondentCount} respondent${uniqueRespondentCount !== 1 ? 's' : ''}`;
		slide.addText(respLine, {
			x: TEXT_X, y: HDR_Y + 0.96, w: TEXT_W, h: 0.26,
			fontSize: 9, color: 'C5DAF5', italic: true, valign: 'middle',
			wrap: true, fontFace: 'Calibri', margin: 0
		});

		// ── Overall Score Box (pinned to right of header card) ──────────────
		const OSB_X = HDR_X + HDR_W - OSB_W;
		slide.addShape(pptx.shapes.RECTANGLE, {
			x: OSB_X, y: HDR_Y, w: OSB_W, h: HDR_H,
			fill: { color: '1a5c9e' }, line: { color: '2980D4', pt: 0 }
		});
		// Left separator inside OSB
		slide.addShape(pptx.shapes.RECTANGLE, {
			x: OSB_X, y: HDR_Y + 0.10, w: 0.012, h: HDR_H - 0.20,
			fill: { color: 'FFFFFF', transparency: 70 }, line: { type: 'none' }
		});
		slide.addText('OVER-ALL SCORE', {
			x: OSB_X + 0.06, y: HDR_Y + 0.10, w: OSB_W - 0.12, h: 0.24,
			fontSize: 8.5, bold: true, color: 'C5DAF5',
			align: 'center', charSpacing: 1.5, fontFace: 'Calibri', margin: 0
		});
		// Scale font size so the number always fits — 4-char '4.00' needs smaller than 3-char '—'
		const osbFontSize = overallStr.length <= 1 ? 52 : overallStr.length <= 3 ? 44 : 36;
		slide.addText(overallStr, {
			x: OSB_X + 0.06, y: HDR_Y + 0.28, w: OSB_W - 0.12, h: 0.76,
			fontSize: osbFontSize, bold: true, color: 'FFFFFF',
			align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
		});
		slide.addText(overallDesc.toUpperCase(), {
			x: OSB_X + 0.06, y: HDR_Y + HDR_H - 0.38, w: OSB_W - 0.12, h: 0.30,
			fontSize: 9, bold: true, color: 'F5D800',
			align: 'center', valign: 'middle', charSpacing: 0.5, fontFace: 'Calibri', margin: 0
		});

		// ─────────────────────────────────────────────────────────────────
		// BODY GRID — Participants card (left ~30%) + Indicators column (right ~70%)
		// ─────────────────────────────────────────────────────────────────
		const BODY_Y   = HDR_Y + HDR_H + 0.14;
		const SPK_GAP  = 0.12;
		// Pre-compute speaker section height so BODY_H reserves enough space.
		// For All Days Combined grouped layout, height scales with the number of day groups.
		const _spkListEarly = (speakerAverages || []).filter(s => s && s.speaker_name);
		const _isGrouped = !selectedDayId && p.program_type === 'container' && _spkListEarly.length > 0;
		const _dayKeysEarly = _isGrouped
			? [...new Set(_spkListEarly.map(s => s.day_sheet || 'Day 1'))]
			: [];
		const _hasSpkEarly = _spkListEarly.length > 0;

		// ── ANTI-CRAMP GUARD ────────────────────────────────────────────────
		// With "All Days Combined" selected on a multi-day workshop, the grouped
		// Resource-Speakers strip below used to grow by a full row for every
		// extra day, silently eating into BODY_H until the indicator rows above
		// got squeezed so short their number/label text overflowed and
		// overlapped (visible in exports with 3+ training days). Instead, only
		// let as many day-groups sit inline as keeps indicator rows readable;
		// any remaining day-groups spill onto dedicated continuation slide(s)
		// added right after Slide 1 (see below), where they get the whole page.
		const GROUP_H_EARLY     = 0.22 + 0.72 + 0.22 + 0.10; // day-label + badge + name + gap
		const SPK_PAD_V_EARLY   = 0.16;
		const MIN_IND_ROW_H     = 0.50; // smallest indicator-row height before text starts to overflow/overlap
		const IND_ROW_GAP_EARLY = 0.10;
		const _approxIndCount = Math.max(
			(categories || []).filter(c => !isExcludedReportCategory(c.category_name || c.name)).length,
			1
		);
		const _minBodyH = MIN_IND_ROW_H * _approxIndCount + IND_ROW_GAP_EARLY * (_approxIndCount - 1);
		const _maxSpkHBudget = H - BODY_Y - _minBodyH - SPK_GAP - 0.14;
		const maxInlineDayGroups = _isGrouped
			? Math.max(1, Math.min(_dayKeysEarly.length, Math.floor((_maxSpkHBudget - SPK_PAD_V_EARLY - 0.10) / GROUP_H_EARLY)))
			: _dayKeysEarly.length;
		const inlineDayKeys   = _isGrouped ? _dayKeysEarly.slice(0, maxInlineDayGroups) : _dayKeysEarly;
		const overflowDayKeys = _isGrouped ? _dayKeysEarly.slice(maxInlineDayGroups) : [];
		// Populated inside the Resource Speakers section below; consumed by the
		// continuation-slide block that follows Slide 1.
		let overflowGroups = [];

		const SPK_H = _isGrouped
			? SPK_PAD_V_EARLY + inlineDayKeys.length * GROUP_H_EARLY + 0.10
			: (_hasSpkEarly ? 0.88 : 0.56);  // compact bar when no speakers
		const BODY_H   = H - BODY_Y - SPK_H - SPK_GAP - 0.14;

		// ── Layout: show participants card only when sex data exists ───────────
		const gTotal2 = genderCounts.Male + genderCounts.Female + genderCounts.Other;
		const hasSexData = gTotal2 > 0;

		// When no sex data, indicators expand to full width; otherwise leave room for participants card
		const PART_W = hasSexData ? 2.60 : 0;
		const IND_X  = hasSexData ? HDR_X + PART_W + 0.14 : HDR_X;
		const IND_W  = hasSexData ? HDR_W - PART_W - 0.14 : HDR_W;

		if (hasSexData) {
			// ── PARTICIPANTS CARD ──────────────────────────────────────────
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: HDR_X, y: BODY_Y, w: PART_W, h: BODY_H,
				fill: { color: 'F5F0D8' }, line: { color: 'D4C97A', pt: 1.5 }
			});
			slide.addText('PARTICIPANTS', {
				x: HDR_X + 0.10, y: BODY_Y + 0.10, w: PART_W - 0.20, h: 0.28,
				fontSize: 11, bold: true, color: '1a3a6b',
				align: 'center', charSpacing: 1, fontFace: 'Calibri', margin: 0
			});
			const chartValues = [genderCounts.Male || 0.001, genderCounts.Female || 0.001, genderCounts.Other || 0.001];
			const DONUT_X = HDR_X + (PART_W - 1.60) / 2;
			const DONUT_Y = BODY_Y + 0.42;
			const DONUT_W = 1.60;
			const DONUT_H = 1.60;
			slide.addChart(pptx.charts.DOUGHNUT, [{
				name: 'Gender',
				labels: ['Male', 'Female', 'Prefer not to say'],
				values: chartValues
			}], {
				x: DONUT_X, y: DONUT_Y, w: DONUT_W, h: DONUT_H,
				holeSize: 55,
				chartColors: ['4CAF50', '64B5F6', '9CA3AF'],
				showLegend: false,
				showTitle: false,
				chartArea: { fill: { color: 'F5F0D8' } },
				dataLabelFontSize: 0,
				showValue: false,
			});
			const mPct = Math.round(genderCounts.Male   / gTotal2 * 100);
			const fPct = Math.round(genderCounts.Female / gTotal2 * 100);
			const oPct = 100 - mPct - fPct;
			const labelY = DONUT_Y + DONUT_H + 0.04;
			slide.addText(`MALE\n${mPct}%`, {
				x: HDR_X + 0.06, y: labelY, w: 0.78, h: 0.42,
				fontSize: 9, bold: true, color: '2E7D32',
				align: 'center', fontFace: 'Calibri', margin: 0
			});
			slide.addText(`PREFER NOT\nTO SAY\n${oPct}%`, {
				x: HDR_X + PART_W / 2 - 0.34, y: labelY, w: 0.68, h: 0.42,
				fontSize: 9, bold: true, color: '6B7280',
				align: 'center', fontFace: 'Calibri', margin: 0
			});
			slide.addText(`FEMALE\n${fPct}%`, {
				x: HDR_X + PART_W - 0.82, y: labelY, w: 0.76, h: 0.42,
				fontSize: 9, bold: true, color: '1565C0',
				align: 'center', fontFace: 'Calibri', margin: 0
			});
			// Total participants below gender labels
			slide.addText(`TOTAL PARTICIPANTS — ${gTotal2}`, {
				x: HDR_X + 0.08, y: labelY + 0.46, w: PART_W - 0.16, h: 0.26,
				fontSize: 8.5, bold: true, color: '1a3a6b',
				align: 'center', charSpacing: 0.3, fontFace: 'Calibri', margin: 0
			});
			if (showExpected) {
				slide.addText(`EXPECTED PARTICIPANTS — ${numPartic}`, {
					x: HDR_X + 0.08, y: labelY + 0.72, w: PART_W - 0.16, h: 0.22,
					fontSize: 7.5, bold: true, color: '1a3a6b',
					align: 'center', fontFace: 'Calibri', margin: 0
				});
			}
		} // end hasSexData — no participants card rendered when sex data is absent

		// ── INDICATORS COLUMN ────────────────────────────────────────────
		// One row per SUPER CATEGORY: [Label bar (blue)] [Score box (colored)]
		// Matches .indicator-label + .indicator-score from workshop-dashboard.css
		//
		// BUG FIX (round 2): the previous version only reordered/renamed individual
		// raw categories against a hardcoded 6-name list (getOrderedReportCategoryNames /
		// getCategoryAverageForReport). That fixed row ORDER for the common 1-to-1 case,
		// but never actually implemented QAME super-category MERGING — if a super
		// category groups more than one raw category together (via
		// qame_category_mappings), the dashboard shows ONE averaged row for it
		// (updateSuperCategories() in workshop-dashboard.js), while this export was
		// still emitting one row per underlying raw category, unmerged.
		//
		// This now fetches the same qame_categories.php config the dashboard uses and
		// reproduces its grouping/averaging algorithm directly, so a super category
		// mapping N raw categories together produces exactly one PPT row, scored as
		// the average of its mapped categories — matching the dashboard 1:1.
		let qameSuperCats = [];
		if (getSuperCategoryGroupingPreference()) {
			try {
				const qameRes = await fetch(`${API_URL}/qame_categories.php`, { credentials: 'include' });
				const qameJson = await qameRes.json();
				if (qameJson.success) qameSuperCats = qameJson.data || [];
			} catch (_) { /* falls back to unmerged raw categories below */ }
		}

		// Same normalization the server uses (program_dashboard.php's normCat()) so
		// "Program Management & Operations" (raw import text) still matches
		// "Program Management and Operations" (evaluation_question_categories.name).
		function normCatName(s) {
			return String(s || '')
				.toLowerCase()
				.replace(/&/g, ' and ')
				.replace(/\(.*?\)/g, '')
				.replace(/[^a-z0-9 ]/g, '')
				.replace(/\s+/g, ' ')
				.trim();
		}

		const rawCats = (categories || [])
			.map(c => ({
				name: c.category_name || c.name || '',
				norm: normCatName(c.category_name || c.name),
				score: parseFloat(c.average_score || 0)
			}))
			.filter(c => c.norm && !isExcludedReportCategory(c.name));

		let indCats = [];
		if (qameSuperCats.length > 0) {
			const usedNorms = new Set();

			qameSuperCats
				.slice()
				.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
				.forEach(sc => {
					const mappedNorms = (sc.mapped_categories || []).map(m => normCatName(m.name));
					const matches = rawCats.filter(c => mappedNorms.includes(c.norm) && c.score > 0);
					if (!matches.length) return; // mirrors dashboard: super categories with no data are skipped
					matches.forEach(m => usedNorms.add(m.norm));
					const avgScore = matches.reduce((s, c) => s + c.score, 0) / matches.length;
					indCats.push({ category_name: sc.name, average_score: avgScore });
				});

			// Unmapped raw categories still get their own row, appended after —
			// mirrors the dashboard's "unmappedCategories" fallback so newly
			// imported categories that aren't configured yet don't silently vanish.
			rawCats.forEach(c => {
				if (usedNorms.has(c.norm) || c.score <= 0) return;
				indCats.push({ category_name: c.name, average_score: c.score });
			});
		} else {
			// qame_categories.php unavailable — fall back to the previous
			// reorder-only behavior rather than failing the export entirely.
			indCats = getOrderedReportCategoryNames(categories, columnAverages)
				.map(name => ({
					category_name: name,
					average_score: getCategoryAverageForReport(categories, columnAverages, name)
				}))
				.filter(c => c.average_score !== null && parseFloat(c.average_score || 0) > 0);
		}
		const indCount = Math.max(indCats.length, 1);
		const IND_ROW_GAP = 0.10;
		const IND_ROW_H = (BODY_H - IND_ROW_GAP * (indCount - 1)) / indCount;
		const SCORE_BOX_W = 1.72;  // wider for stacked layout

		indCats.forEach((cat, idx) => {
			const rowY = BODY_Y + idx * (IND_ROW_H + IND_ROW_GAP);
			// BUG FIX: `parseFloat(...).toFixed(2)` alone disagrees with the dashboard
			// on exact rounding ties — e.g. 3.985 → "3.98" via .toFixed(2), but the
			// dashboard's updateSuperCategories() does Math.round(score*100)/100
			// first, which gives 3.99 for that same value. Apply the identical
			// Math.round(x*100)/100 step here so ties round the same way, and use
			// the *rounded* value for color/label too so those stay consistent with
			// the number actually displayed.
			const avg  = Math.round(parseFloat(cat.average_score || 0) * 100) / 100;
			const dc   = dashScoreColors(avg);
			const dlbl = dashRatingLabel(avg);
			const catLabel = (cat.category_name || cat.name || 'CATEGORY').toUpperCase();

			// Label bar
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: IND_X, y: rowY, w: IND_W - SCORE_BOX_W - 0.10, h: IND_ROW_H,
				fill: { color: '2456a4' }, line: { color: '3b7dd8', pt: 1 }
			});
			slide.addText(catLabel, {
				x: IND_X + 0.14, y: rowY, w: IND_W - SCORE_BOX_W - 0.30, h: IND_ROW_H,
				fontSize: IND_ROW_H > 0.7 ? 13 : 10.5, bold: true, color: 'FFFFFF',
				valign: 'middle', wrap: true, fontFace: 'Calibri', margin: 0
			});

			// Score box (colored by rating) — stacked: number top, label bottom
			const scoreBoxX = IND_X + IND_W - SCORE_BOX_W;
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: scoreBoxX, y: rowY, w: SCORE_BOX_W, h: IND_ROW_H,
				fill: { color: dc.scoreBg }, line: { color: dc.scoreBg, pt: 1 }
			});
			const numH  = IND_ROW_H * 0.65;
			const lblH  = IND_ROW_H * 0.35;
			const numFS = IND_ROW_H > 0.70 ? 30 : (IND_ROW_H > 0.50 ? 24 : 18);
			const lblFS = IND_ROW_H > 0.70 ? 8.5 : (IND_ROW_H > 0.50 ? 7.5 : 6.5);
			// Score number — full width, centered
			slide.addText(avg > 0 ? avg.toFixed(2) : '—', {
				x: scoreBoxX + 0.06, y: rowY + 0.04, w: SCORE_BOX_W - 0.12, h: numH - 0.04,
				fontSize: numFS, bold: true, color: dc.score,
				align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
			});
			// Rating label — full width below number, wraps freely
			slide.addText(dlbl.toUpperCase(), {
				x: scoreBoxX + 0.06, y: rowY + numH, w: SCORE_BOX_W - 0.12, h: lblH - 0.04,
				fontSize: lblFS, bold: true, color: 'FFFFFF',
				align: 'center', valign: 'middle', wrap: true, fontFace: 'Calibri', margin: 0
			});
		});

		if (!indCats.length) {
			slide.addText('No indicator data available', {
				x: IND_X + 0.20, y: BODY_Y + BODY_H / 2 - 0.18, w: IND_W - 0.40, h: 0.36,
				fontSize: 12, color: '6B7280', italic: true,
				align: 'center', valign: 'middle', fontFace: 'Calibri'
			});
		}

		// ─────────────────────────────────────────────────────────────────
		// RESOURCE SPEAKERS SECTION (bottom)
		// For All Days Combined: grouped by day with day label header.
		// For single day / standalone: flat single-row strip (original layout).
		// ─────────────────────────────────────────────────────────────────
		const spkList = (speakerAverages || []).filter(s => s && s.speaker_name);
		const isAllDaysCombinedPPT = !selectedDayId && p.program_type === 'container';
		const SPK_LABEL_W   = 1.68;
		const SPK_RESPONSES_W = 1.30;

		if (isAllDaysCombinedPPT && spkList.length > 0) {
			// ── GROUPED BY DAY layout ──────────────────────────────────────
			// Group speakers by day_sheet
			const dayOrder = [];
			const dayMap = {};
			spkList.forEach(spk => {
				const dk = spk.day_sheet || 'Day 1';
				if (!dayMap[dk]) { dayMap[dk] = []; dayOrder.push(dk); }
				dayMap[dk].push(spk);
			});
			const allDayGroups = [];
			dayOrder.forEach(dk => allDayGroups.push({ label: dk, speakers: dayMap[dk] }));
			// Only the groups that fit without cramping the indicators render here;
			// the rest are rendered on continuation slide(s) after Slide 1 (below).
			const dayGroups = allDayGroups.filter(g => inlineDayKeys.includes(g.label));
			overflowGroups  = allDayGroups.filter(g => overflowDayKeys.includes(g.label));

			// Calculate total height needed:
			// Per day group: day-label row (0.22) + badges row (0.72 circle + 0.22 name below) + gap (0.14)
			const DAY_LABEL_H = 0.22;
			const BADGE_D     = 0.72;
			const NAME_H      = 0.22;
			const GROUP_H     = DAY_LABEL_H + BADGE_D + NAME_H + 0.10; // per day group
			const SPK_PAD_V   = 0.16;  // top+bottom padding inside the strip
			const totalSpkH   = SPK_PAD_V + dayGroups.length * GROUP_H + 0.10;

			const SPK_Y = BODY_Y + BODY_H + SPK_GAP;

			// Outer container
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: HDR_X, y: SPK_Y, w: HDR_W, h: totalSpkH,
				fill: { color: '1a3a6b' }, line: { color: '2456a4', pt: 1.5 }
			});

			// "RESOURCE SPEAKERS" label (left column, vertically centred)
			slide.addText('RESOURCE\nSPEAKERS', {
				x: HDR_X + 0.14, y: SPK_Y, w: SPK_LABEL_W, h: totalSpkH,
				fontSize: 11, bold: true, color: 'FFFFFF',
				align: 'center', valign: 'middle', charSpacing: 0.8, fontFace: 'Calibri', margin: 0
			});

			// Separator line
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: HDR_X + SPK_LABEL_W + 0.16, y: SPK_Y + 0.10, w: 0.010, h: totalSpkH - 0.20,
				fill: { color: 'FFFFFF', transparency: 65 }, line: { type: 'none' }
			});

			// Responses badge (right)
			const RES_X = HDR_X + HDR_W - SPK_RESPONSES_W - 0.04;
			slide.addShape(pptx.shapes.RECTANGLE, {
				x: RES_X - 0.010, y: SPK_Y + 0.10, w: 0.010, h: totalSpkH - 0.20,
				fill: { color: 'FFFFFF', transparency: 65 }, line: { type: 'none' }
			});
			slide.addText('RESPONSES', {
				x: RES_X, y: SPK_Y + (totalSpkH / 2) - 0.40, w: SPK_RESPONSES_W, h: 0.26,
				fontSize: 8.5, bold: true, color: 'C5DAF5',
				align: 'center', charSpacing: 1, fontFace: 'Calibri', margin: 0
			});
			slide.addText(String(uniqueRespondentCount), {
				x: RES_X, y: SPK_Y + (totalSpkH / 2) - 0.14, w: SPK_RESPONSES_W, h: 0.56,
				fontSize: 28, bold: true, color: 'FFFFFF',
				align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
			});

			// Content area (between label and responses columns)
			const CONTENT_X   = HDR_X + SPK_LABEL_W + 0.30;
			const CONTENT_W   = HDR_W - SPK_LABEL_W - 0.30 - SPK_RESPONSES_W - 0.30;
			const BADGE_STEP  = BADGE_D + 0.18;

			let groupCursorY = SPK_Y + SPK_PAD_V;

			dayGroups.forEach((grp, gi) => {
				// Day label (e.g. "Day 1")
				slide.addText(grp.label.toUpperCase(), {
					x: CONTENT_X, y: groupCursorY, w: CONTENT_W, h: DAY_LABEL_H,
					fontSize: 7.5, bold: true, color: 'C5DAF5',
					align: 'left', valign: 'middle', charSpacing: 0.5, fontFace: 'Calibri', margin: 0
				});

				// Thin separator under day label
				slide.addShape(pptx.shapes.RECTANGLE, {
					x: CONTENT_X, y: groupCursorY + DAY_LABEL_H - 0.01, w: CONTENT_W * 0.85, h: 0.01,
					fill: { color: 'FFFFFF', transparency: 80 }, line: { type: 'none' }
				});

				const badgeRowY = groupCursorY + DAY_LABEL_H + 0.04;

				grp.speakers.forEach((spk, si) => {
					const bx = CONTENT_X + si * BADGE_STEP;
					const spkScore = Math.round(parseFloat(spk.overall_avg || spk.average_score || spk.avg_score || 0) * 100) / 100;

					// Gold circle
					slide.addShape(pptx.shapes.OVAL, {
						x: bx, y: badgeRowY, w: BADGE_D, h: BADGE_D,
						fill: { color: 'E8A020' }, line: { color: 'FFFFFF', pt: 1.5 }
					});

					// RP label inside top of badge (e.g. "RP 1")
					slide.addText(`RP ${si + 1}`, {
						x: bx, y: badgeRowY + 0.04, w: BADGE_D, h: 0.18,
						fontSize: 6, bold: true, color: '1a3a6b',
						align: 'center', valign: 'top', fontFace: 'Calibri', margin: 0
					});

					// Score (large, centre of badge)
					if (spkScore > 0) {
						slide.addText(spkScore.toFixed(2), {
							x: bx, y: badgeRowY + 0.18, w: BADGE_D, h: BADGE_D - 0.36,
							fontSize: 14, bold: true, color: '1a3a6b',
							align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
						});
					}

					// Speaker name below badge
					const spkLabel = spk.speaker_name || `Speaker ${si + 1}`;
					slide.addText(spkLabel, {
						x: bx - 0.04, y: badgeRowY + BADGE_D + 0.04, w: BADGE_D + 0.08, h: NAME_H,
						fontSize: 5.5, bold: false, color: 'C5DAF5',
						align: 'center', valign: 'top', wrap: true, fontFace: 'Calibri', margin: 0
					});
				});

				groupCursorY += GROUP_H;
			});

		} else {
			// ── FLAT SINGLE-ROW layout (single day or standalone) ──────────
			const SPK_Y = BODY_Y + BODY_H + SPK_GAP;

			if (_hasSpkEarly) {
				// Has speakers — full Resource Speakers bar
				slide.addShape(pptx.shapes.RECTANGLE, {
					x: HDR_X, y: SPK_Y, w: HDR_W, h: SPK_H,
					fill: { color: '1a3a6b' }, line: { color: '2456a4', pt: 1.5 }
				});
				slide.addText('RESOURCE\nSPEAKERS', {
					x: HDR_X + 0.14, y: SPK_Y, w: SPK_LABEL_W, h: SPK_H,
					fontSize: 11, bold: true, color: 'FFFFFF',
					align: 'center', valign: 'middle', charSpacing: 0.8, fontFace: 'Calibri', margin: 0
				});
				slide.addShape(pptx.shapes.RECTANGLE, {
					x: HDR_X + SPK_LABEL_W + 0.16, y: SPK_Y + 0.10, w: 0.010, h: SPK_H - 0.20,
					fill: { color: 'FFFFFF', transparency: 65 }, line: { type: 'none' }
				});
				const SPK_BADGE_D = SPK_H - 0.18;
				const SPK_START_X = HDR_X + SPK_LABEL_W + 0.30;
				const SPK_AVAIL_W = HDR_W - SPK_LABEL_W - 0.30 - SPK_RESPONSES_W - 0.20;
				const maxBadges   = Math.max(1, Math.floor(SPK_AVAIL_W / (SPK_BADGE_D + 0.16)));
				const visibleSpk  = spkList.slice(0, maxBadges);
				visibleSpk.forEach((spk, si) => {
					const bx = SPK_START_X + si * (SPK_BADGE_D + 0.16);
					const by = SPK_Y + 0.09;
					const spkScore = Math.round(parseFloat(spk.overall_avg || spk.average_score || spk.avg_score || 0) * 100) / 100;
					slide.addShape(pptx.shapes.OVAL, {
						x: bx, y: by, w: SPK_BADGE_D, h: SPK_BADGE_D,
						fill: { color: 'E8A020' }, line: { color: 'FFFFFF', pt: 1.5 }
					});
					if (spkScore > 0) {
						slide.addText(spkScore.toFixed(2), {
							x: bx, y: by, w: SPK_BADGE_D, h: SPK_BADGE_D * 0.55,
							fontSize: 13, bold: true, color: '1a3a6b',
							align: 'center', valign: 'bottom', fontFace: 'Calibri', margin: 0
						});
					}
					const spkName = (spk.speaker_name || '').split(' ').slice(-1)[0].toUpperCase();
					slide.addText(spkName, {
						x: bx, y: by + SPK_BADGE_D * 0.52, w: SPK_BADGE_D, h: SPK_BADGE_D * 0.38,
						fontSize: 6.5, bold: true, color: '1a3a6b',
						align: 'center', valign: 'top', wrap: true, fontFace: 'Calibri', margin: 0
					});
				});
				const RES_X = HDR_X + HDR_W - SPK_RESPONSES_W - 0.04;
				slide.addShape(pptx.shapes.RECTANGLE, {
					x: RES_X - 0.010, y: SPK_Y + 0.10, w: 0.010, h: SPK_H - 0.20,
					fill: { color: 'FFFFFF', transparency: 65 }, line: { type: 'none' }
				});
				slide.addText('RESPONSES', {
					x: RES_X, y: SPK_Y + 0.06, w: SPK_RESPONSES_W, h: 0.26,
					fontSize: 8.5, bold: true, color: 'C5DAF5',
					align: 'center', charSpacing: 1, fontFace: 'Calibri', margin: 0
				});
				slide.addText(String(uniqueRespondentCount), {
					x: RES_X, y: SPK_Y + 0.30, w: SPK_RESPONSES_W, h: SPK_H - 0.38,
					fontSize: 28, bold: true, color: 'FFFFFF',
					align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
				});
			} else {
				// No speakers — compact TOTAL RESPONSES bar only
				slide.addShape(pptx.shapes.RECTANGLE, {
					x: HDR_X, y: SPK_Y, w: HDR_W, h: SPK_H,
					fill: { color: '1a3a6b' }, line: { color: '2456a4', pt: 1.5 }
				});
				slide.addText('TOTAL RESPONSES', {
					x: HDR_X + 0.20, y: SPK_Y, w: 2.20, h: SPK_H,
					fontSize: 9.5, bold: true, color: 'C5DAF5',
					align: 'left', valign: 'middle', charSpacing: 1, fontFace: 'Calibri', margin: 0
				});
				slide.addText(String(uniqueRespondentCount), {
					x: HDR_X + 2.50, y: SPK_Y, w: 1.20, h: SPK_H,
					fontSize: 24, bold: true, color: 'FFFFFF',
					align: 'left', valign: 'middle', fontFace: 'Calibri', margin: 0
				});
			}
		}

		addPageNum(slide, pageNum);

		// ═══════════════════════════════════════════════════════════════════════
		// SLIDE 1b, 1c, … — RESOURCE SPEAKERS (CONTINUED)
		// Day-groups that didn't fit inline on the dashboard slide (anti-cramp
		// guard above) get their own slide(s) here instead, with the full page
		// to themselves so badges/names stay comfortably readable. Multiple
		// groups are packed per continuation slide when they fit; extra slides
		// are added automatically if there are more days than one page can hold.
		// ═══════════════════════════════════════════════════════════════════════
		if (overflowGroups.length) {
			const CONT_X = 0.50, CONT_Y = 1.10, CONT_W = W - 1.00;
			const CONT_AVAIL_H = H - CONT_Y - 0.55;
			// These must match the actual geometry used below (title, separator,
			// badge offset/size, name gap/height) — the previous version reused
			// the smaller inline-badge spacing constant here, so each day's block
			// was taller than the slot reserved for it and the next day's title
			// overlapped the previous day's speaker names.
			const CONT_TITLE_H     = 0.28;
			const CONT_BADGE_Y_OFF = 0.42; // title -> badge top
			const CONT_BADGE_D     = 0.95;
			const CONT_NAME_GAP    = 0.05;
			const CONT_NAME_H      = 0.28;
			const CONT_GROUP_PAD   = 0.18; // breathing room before the next day's title
			const CONT_GROUP_H = CONT_BADGE_Y_OFF + CONT_BADGE_D + CONT_NAME_GAP + CONT_NAME_H + CONT_GROUP_PAD;
			const groupsPerContSlide = Math.max(1, Math.floor(CONT_AVAIL_H / CONT_GROUP_H));

			for (let start = 0; start < overflowGroups.length; start += groupsPerContSlide) {
				const pageGroups = overflowGroups.slice(start, start + groupsPerContSlide);
				const contSlide = pptx.addSlide();
				contSlide.background = { color: C.white };
				pageNum++;
				addStdHeader(contSlide, 'RESOURCE SPEAKERS', 'Continued — additional training days');

				let cy = CONT_Y;
				pageGroups.forEach(grp => {
					contSlide.addText(grp.label.toUpperCase(), {
						x: CONT_X, y: cy, w: CONT_W, h: CONT_TITLE_H,
						fontSize: 12, bold: true, color: '1a3a6b',
						align: 'left', valign: 'middle', fontFace: 'Calibri', margin: 0
					});
					contSlide.addShape(pptx.shapes.RECTANGLE, {
						x: CONT_X, y: cy + CONT_TITLE_H + 0.02, w: CONT_W, h: 0.01,
						fill: { color: 'D4C97A' }, line: { type: 'none' }
					});

					const badgeY = cy + CONT_BADGE_Y_OFF;
					grp.speakers.forEach((spk, si) => {
						const bx = CONT_X + si * (CONT_BADGE_D + 0.26);
						const spkScore = Math.round(parseFloat(spk.overall_avg || spk.average_score || spk.avg_score || 0) * 100) / 100;
						contSlide.addShape(pptx.shapes.OVAL, {
							x: bx, y: badgeY, w: CONT_BADGE_D, h: CONT_BADGE_D,
							fill: { color: 'E8A020' }, line: { color: 'FFFFFF', pt: 1.5 }
						});
						contSlide.addText(`RP ${si + 1}`, {
							x: bx, y: badgeY + 0.06, w: CONT_BADGE_D, h: 0.20,
							fontSize: 7.5, bold: true, color: '1a3a6b',
							align: 'center', valign: 'top', fontFace: 'Calibri', margin: 0
						});
						if (spkScore > 0) {
							contSlide.addText(spkScore.toFixed(2), {
								x: bx, y: badgeY + 0.26, w: CONT_BADGE_D, h: CONT_BADGE_D - 0.46,
								fontSize: 17, bold: true, color: '1a3a6b',
								align: 'center', valign: 'middle', fontFace: 'Calibri', margin: 0
							});
						}
						contSlide.addText(spk.speaker_name || `Speaker ${si + 1}`, {
							x: bx - 0.08, y: badgeY + CONT_BADGE_D + CONT_NAME_GAP, w: CONT_BADGE_D + 0.16, h: CONT_NAME_H,
							fontSize: 7.5, bold: false, color: '1a3a6b',
							align: 'center', valign: 'top', wrap: true, fontFace: 'Calibri', margin: 0
						});
					});
					cy += CONT_GROUP_H;
				});

				addPageNum(contSlide, pageNum);
			}
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SLIDE 2 — PARTICIPANT FEEDBACK
		// Horizontal card layout grouped by day
		// ═══════════════════════════════════════════════════════════════════════

		// ── Build the list of feedback questions to show ──────────────────────
		// Use feedback_label from DB; fall back to savedFbLabels then defaults.
		const dbFbLabels = feedbackData.reduce((acc, fb) => {
			Object.entries(fb.labels || {}).forEach(([k, v]) => { if (v && !acc[k]) acc[k] = v; });
			return acc;
		}, {});
		const resolveLabel = (key, fallback) => dbFbLabels[key] || fbLabel(key, fallback);

		// Build feedback questions dynamically from actual data keys — same approach
		// as buildReportHTML so the PPT stays in sync regardless of form changes.
		const FB_SKIP_PPT = new Set(['respondent_id', 'day_sheet', 'day', 'labels', 'id',
			'feedback_expectations', 'feedback_improvements', 'feedback_insights', 'feedback_further',
			'expectations', 'improvements', 'insights', 'further', 'met_expectations', 'additional_training']);
		const normFbKeyPPT = key =>
			String(key || '').replace(/\bfor\s+DAY\s+\d+\b[^.]*\.?/gi, '')
				.replace(/\bDAY\s+\d+\b/gi, '').replace(/\s{2,}/g, ' ').trim();
		const rawByNormPPT = new Map();
		for (const fb of (feedbackData || [])) {
			for (const rawKey of Object.keys(fb)) {
				if (FB_SKIP_PPT.has(rawKey)) continue;
				const norm = rawKey.startsWith('__pos_') ? rawKey : normFbKeyPPT(rawKey);
				if (!rawByNormPPT.has(norm)) rawByNormPPT.set(norm, []);
				if (!rawByNormPPT.get(norm).includes(rawKey)) rawByNormPPT.get(norm).push(rawKey);
			}
		}
		if (!rawByNormPPT.size) {
			[
				['feedback_improvements', 'improvements'],
				['feedback_insights',     'insights'],
				['feedback_further',      'further'],
				['feedback_expectations', 'expectations'],
			].forEach(([a, b]) => {
				if ((feedbackData || []).some(fb => fb[a] || fb[b])) rawByNormPPT.set(a, [a, b]);
			});
		}
		const feedbackQuestions = [...rawByNormPPT.entries()]
			.map(([normKey, rawKeys]) => ({
				key: normKey,
				label: normKey.startsWith('__pos_') ? normKey : normKey,
				_rawKeys: rawKeys,
			}))
			.filter(q => (feedbackData || []).some(fb => q._rawKeys.some(k => (fb[k] || '').trim())));

		// ── Layout constants ──────────────────────────────────────────────────
		const FB_HEADER_H  = 0.88;   // header bar height
		const FB_SUB_Y     = FB_HEADER_H + 0.10;
		const FB_SUB_H     = 0.36;   // sub-heading strip height
		const FB_ANS_Y0    = FB_SUB_Y + FB_SUB_H + 0.20;
		const FB_RH        = 0.62;   // answer row height
		const FB_BOTTOM    = H - 0.44;
		const FB_PER       = Math.max(1, Math.floor((FB_BOTTOM - FB_ANS_Y0) / FB_RH));

		// ── One question per set of slides ────────────────────────────────────
		for (const fq of feedbackQuestions) {

			// Collect answers grouped by day.
			// When a specific day is selected the API already filters rows to that day
			// so day_sheet may be empty — fall back to the resolved day title from p.days.
			const resolvedDayLabel = selectedDayId
				? (p.days?.[0]?.title || String(selectedDayId))
				: null;
			const fbDayGroups = new Map();
			feedbackData.forEach(fb => {
				const dayKey = (fb.day_sheet || fb.day || '').trim() || (resolvedDayLabel || '__all__');
				if (!fbDayGroups.has(dayKey)) fbDayGroups.set(dayKey, []);
				const val = (fq._rawKeys ? fq._rawKeys.map(k => fb[k] || '').find(v => v) || '' : (fb[fq.key] || '')).trim();
				if (isUseful(val)) fbDayGroups.get(dayKey).push(val);
			});

			const isMultiDay = fbDayGroups.size > 1 || !fbDayGroups.has('__all__');
			const sortedFbDays = [...fbDayGroups.keys()].sort((a, b) => {
				if (a === '__all__') return 0;
				const na = parseInt(String(a).match(/\d+/)?.[0] ?? 9999);
				const nb = parseInt(String(b).match(/\d+/)?.[0] ?? 9999);
				return na !== nb ? na - nb : a.localeCompare(b);
			});

			// Deduplicate answers per day
			const flatAnswers = [];
			const dayAnnotated = [];
			sortedFbDays.forEach(dayKey => {
				const raw = fbDayGroups.get(dayKey) || [];
				const seen = new Set();
				const deduped = raw.filter(a => {
					const k = a.toLowerCase().replace(/\s+/g, ' ');
					if (seen.has(k)) return false;
					seen.add(k); return true;
				});
				deduped.forEach(ans => {
					flatAnswers.push(ans);
					dayAnnotated.push({ day: dayKey === '__all__' ? null : dayKey, ans });
				});
			});

			if (!flatAnswers.length) continue;

			// Build interleaved rows (day headers + answers)
			const interleaved = [];
			if (isMultiDay) {
				sortedFbDays.forEach(dayKey => {
					const dayAnswers = (fbDayGroups.get(dayKey) || []).filter(a => isUseful(a));
					if (!dayAnswers.length) return;
					const dayLabel = dayKey === '__all__' ? '' : dayKey;
					if (dayLabel) interleaved.push({ type: 'day', label: dayLabel });
					dayAnswers.forEach(ans => interleaved.push({ type: 'ans', ans }));
				});
			} else {
				flatAnswers.forEach(ans => interleaved.push({ type: 'ans', ans }));
			}

			// Paginate
			const pages = [];
			for (let i = 0; i < interleaved.length; i += FB_PER) {
				pages.push(interleaved.slice(i, i + FB_PER));
			}
			const totalPages = pages.length;

			// ── Render one slide per page ────────────────────────────────────
			pages.forEach((pageItems, pgIdx) => {
				slide = pptx.addSlide();
				slide.background = { color: C.white };

				const headerSub = pgIdx === 0
					? `${flatAnswers.length} response${flatAnswers.length !== 1 ? 's' : ''}  ·  Suggestions, questions, or feedback to improve future sessions`
					: `continued — page ${pgIdx + 1} of ${totalPages}`;

				addStdHeader(slide, 'PARTICIPANT FEEDBACK', headerSub);
				addPageNum(slide, ++pageNum);

				// Question banner
				const QB_Y = FB_HEADER_H + 0.08;
				slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
					x: 0.38, y: QB_Y, w: W - 0.76, h: FB_SUB_H,
					fill: { color: 'EFF4FF' }, line: { color: C.primary, pt: 1.2 }, rectRadius: 0.08
				});
				slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
					x: 0.38, y: QB_Y, w: 0.09, h: FB_SUB_H,
					fill: { color: C.green }, line: { color: C.green }, rectRadius: 0.05
				});
				const qBannerLabel = pgIdx === 0 ? fq.label : `\u21aa  ${fq.label}  (page ${pgIdx + 1} of ${totalPages})`;
				slide.addText(qBannerLabel, {
					x: 0.60, y: QB_Y, w: W - 1.04, h: FB_SUB_H,
					fontSize: pgIdx === 0 ? 13 : 10.5, bold: pgIdx === 0, italic: pgIdx > 0,
					color: C.primary, valign: 'middle', wrap: true, fontFace: 'Calibri'
				});

				// Answer rows
				let rowCursor = FB_ANS_Y0;
				let ansNum = pgIdx * FB_PER;

				pageItems.forEach(item => {
					if (item.type === 'day') {
						// Day header card — royal blue background, white text
						slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
							x: 0.38, y: rowCursor, w: W - 0.76, h: FB_RH - 0.08,
							fill: { color: C.primary }, line: { type: 'none' }, rectRadius: 0.08
						});
						slide.addText(item.label.toUpperCase(), {
							x: 0.56, y: rowCursor, w: W - 1.00, h: FB_RH - 0.08,
							fontSize: 11, bold: true, color: C.white,
							valign: 'middle', charSpacing: 1.5, fontFace: 'Calibri'
						});
						rowCursor += FB_RH;
					} else {
						ansNum++;
						const isEven = ansNum % 2 === 0;
						const rowBg  = isEven ? 'F8FAFC' : C.white;
						const accentCol = ansNum % 3 === 1 ? C.primary : (ansNum % 3 === 2 ? C.green : '2563EB');

						// Row background
						slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
							x: 0.38, y: rowCursor, w: W - 0.76, h: FB_RH - 0.08,
							fill: { color: rowBg }, line: { color: 'E2E8F0', pt: 0.5 }, rectRadius: 0.08
						});
						// Left accent bar
						slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
							x: 0.38, y: rowCursor, w: 0.09, h: FB_RH - 0.08,
							fill: { color: accentCol }, line: { type: 'none' }, rectRadius: 0.06
						});
						// Number badge circle
						const bdY = rowCursor + (FB_RH - 0.08) / 2 - 0.19;
						slide.addShape(pptx.shapes.OVAL, {
							x: 0.56, y: bdY, w: 0.38, h: 0.38,
							fill: { color: accentCol }, line: { type: 'none' }
						});
						slide.addText(String(ansNum), {
							x: 0.56, y: bdY, w: 0.38, h: 0.38,
							fontSize: 9, bold: true, color: C.white,
							align: 'center', valign: 'middle', fontFace: 'Calibri'
						});
						// Answer text
						slide.addText(item.ans, {
							x: 1.06, y: rowCursor + 0.06, w: W - 1.52, h: FB_RH - 0.18,
							fontSize: 11.5, color: '1F2937', valign: 'middle',
							wrap: true, fontFace: 'Calibri'
						});
						rowCursor += FB_RH;
					}
				});
			});
			// next question always starts on a new slide
		}

		// ── Save ────────────────────────────────────────────────────────────────
		const safeName = (p.title || 'QAME').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
		await pptx.writeFile({ fileName: `QAME_Presentation_${safeName}.pptx` });
		showAlert('success', 'PowerPoint presentation exported successfully');

	} catch (e) {
		console.error('PPT Export Error:', e);
		showAlert('error', 'Failed to export PowerPoint presentation');
	}
}

// ─── 21. AI SUMMARY ────────────────────────────────────────────────────────
async function generateAISummary() {
	if (!State.workshopData) { showAlert('error', 'No data available.'); return; }

	let feedbackText = '';
	if (State.responses.length) {
		feedbackText = State.responses
			.map(r => [r.feedback_expectations, r.feedback_improvements, r.feedback_insights, r.feedback_further]
				.filter(Boolean).join(' | '))
			.filter(f => f.trim())
			.join('\n');
	} else if (State.workshopData.feedback) {
		const fb = State.workshopData.feedback;
		feedbackText = [
			...(fb.expectations_met || []),
			...(fb.improvement_suggestions || []),
			...(fb.significant_insights || []),
			...(fb.further_training_interest || [])
		].filter(f => f?.trim()).join('\n');
	}

	if (!feedbackText.trim()) { showAlert('error', 'No feedback data available for AI summary'); return; }

	const summaryContainer = document.getElementById('aiSummaryContainer');
	if (summaryContainer) {
		summaryContainer.innerHTML = '<div style="text-align:center;padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> Generating AI Summary...</div>';
		summaryContainer.style.display = 'block';
	}

	try {
		const formData = new FormData();
		formData.append('feedback', `Program: ${State.workshopData.title}\n\nFeedback:\n${feedbackText}`);
		const res = await fetch(`${API_URL}/feedback_ai.php`, { method: 'POST', body: formData });
		const summary = await res.text();

		if (summaryContainer) {
			summaryContainer.innerHTML = `
        <div style="padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
          <h4 style="margin:0 0 12px 0;color:#1e3a8a;"><i class="fa-solid fa-robot"></i> AI-Generated Summary</h4>
          <div style="white-space:pre-wrap;line-height:1.6;color:#374151;">${escapeHtml(summary)}</div>
        </div>`;
		} else {
			alert('AI Summary:\n\n' + summary);
		}
		showAlert('success', 'AI Summary generated');
	} catch (_) {
		if (summaryContainer) summaryContainer.innerHTML = '<div style="color:#dc2626;padding:16px;">Failed to generate AI summary.</div>';
		showAlert('error', 'Failed to generate AI summary');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//  22. MONITORING TAB
// ═══════════════════════════════════════════════════════════════════════════
async function loadMonitoringData() {
	if (!State.viewingId) return;

	if (State.isRecord) {
		const isContainer = State.workshopData?.program_type === 'container';
		const imports = State.workshopData?.linked_imports || [];

		// ── Container: aggregate monitoring across ALL linked day imports ──────
		if (isContainer && imports.length > 0) {
			try {
				// Fetch monitoring data for every day import in parallel
				const dayResults = await Promise.all(imports.map(async (imp, i) => {
					const res = await fetch(
						`${API_URL}/records_api.php?id=${imp.program_id}&monitoring=1`,
						{ credentials: 'include' }
					);
					const json = await res.json();
					return { imp, i, program: json.success ? json.program : null };
				}));

				// Total participants comes from the container workshop row itself
				const totalPartic = parseInt(State.workshopData?.total_participants) || 0;

				// Build per-day breakdown rows
				const days = dayResults.map(({ imp, i, program }) => ({
					day_number: parseInt(String(imp.day_label || '').match(/\d+/)?.[0]) || (i + 1),
					label:      imp.day_label || `Day ${i + 1}`,
					completed:  parseInt(program?.total_responses) || 0,
					total:      totalPartic,
					respondents: program?.respondents || [],
				}));

				// "Completed" overall = unique participants who responded on ANY day.
				// Deduplicate by email (fallback: name) across all days.
				const allRespondents = dayResults.flatMap(({ program }) => program?.respondents || []);
				const seen = new Set();
				const uniqueRespondents = allRespondents.filter(r => {
					const key = (r.email || r.respondent_name || r.full_name || '').toLowerCase().trim();
					if (!key || seen.has(key)) return false;
					seen.add(key);
					return true;
				});

				const completed = uniqueRespondents.length;
				State.monitoringData = {
					total:       totalPartic,
					completed:   completed,
					pending:     Math.max(0, totalPartic - completed),
					days,
					// Cache for client-side filtering
					_respondents:    uniqueRespondents,
					_dayBreakdown:   days,
					_isRecord:       true,
				};
				renderMonitoringStats();
				// Pass full dayResults so the table can show per-day attendance
				renderMonitoringFromRespondents(uniqueRespondents, days);
			} catch (_) { console.error('Error loading container monitoring data'); }
			return;
		}

		// ── Standalone / linked-excel record (single or multi-day) ──────────────
		// For standalone excel records State.viewingId IS the evaluation_programs.id.
		// For linked excel records State.viewingId is the workshop_id — we stored
		// the eval_program_id on workshopData when we loaded it.
		const evalProgramId = State.workshopData?.eval_program_id || State.viewingId;
		try {
			const res = await fetch(
				`${API_URL}/records_api.php?id=${evalProgramId}&monitoring=1`,
				{ credentials: 'include' }
			);
			const result = await res.json();
			if (result.success) {
				const p = result.program;
				const total = parseInt(p.total_participants) || 0;
				const completed = parseInt(p.total_responses) || 0;
				const allRespondents = p.respondents || [];

				// Build per-day breakdown from day_sheet groups on the respondents
				// so multi-day standalone programs get the same per-day view as containers.
				const dayMap = new Map(); // label → respondent[]
				allRespondents.forEach(r => {
					const label = (r.day_sheet || r.day || '').trim();
					if (!label) return;
					if (!dayMap.has(label)) dayMap.set(label, []);
					dayMap.get(label).push(r);
				});

				// Sort day labels naturally (Day 1, Day 2, …)
				const sortedLabels = [...dayMap.keys()].sort((a, b) => {
					const na = parseInt(a.match(/\d+/)?.[0] || 0);
					const nb = parseInt(b.match(/\d+/)?.[0] || 0);
					return na !== nb ? na - nb : a.localeCompare(b);
				});

				const days = sortedLabels.length > 0
					? sortedLabels.map((label, i) => ({
						day_number:  i + 1,
						label,
						completed:   dayMap.get(label).length,
						total,
						respondents: dayMap.get(label),
					}))
					: (p.days_breakdown || []);

				const dayBreakdownForFilter = days.length > 1 ? days : null;
				State.monitoringData = {
					total,
					completed,
					pending: Math.max(0, total - completed),
					days,
					// Cache for client-side filtering
					_respondents:  allRespondents,
					_dayBreakdown: dayBreakdownForFilter,
					_isRecord:     true,
				};
				renderMonitoringStats();
				// Pass days so multi-day standalone programs show per-day missed info
				renderMonitoringFromRespondents(allRespondents, dayBreakdownForFilter);
			}
		} catch (_) { console.error('Error loading Excel monitoring data'); }
		return;
	}

	// System workshop path
	try {
		const res = await fetch(
			`${API_URL}/evaluation_monitoring.php?action=stats&workshop_id=${State.viewingId}`,
			{ credentials: 'include' }
		);
		const result = await res.json();
		if (result.success) {
			const d = result.data;
			// Normalize PHP response keys to match renderMonitoringStats() expectations
			State.monitoringData = {
				total: d.total_participants ?? 0,
				completed: d.completed_at_least_one ?? 0,
				pending: d.not_started ?? 0,
				days: (d.day_breakdown || []).map(day => ({
					day_number: day.day_number,
					completed: parseInt(day.completed) || 0,
					total: parseInt(day.total_participants) || d.total_participants || 0,
				})),
			};
			renderMonitoringStats();
			loadMonitoringParticipants();
		}
	} catch (_) { console.error('Error loading monitoring data'); }
}

/**
 * Render the monitoring participants table from raw respondents (Excel path).
 * When dayBreakdown is provided (container programs), shows per-day attendance.
 */
function renderMonitoringFromRespondents(respondents, dayBreakdown = null) {
	const tbody = document.getElementById('monitoringTableBody');
	if (!respondents.length) {
		tbody.innerHTML = '<tr><td colspan="4" class="no-data">No participants found</td></tr>';
		return;
	}

	// Build a lookup: email/name → Set of day labels they responded on
	const isMultiDay = dayBreakdown && dayBreakdown.length > 1;
	const attendedDays = new Map(); // key → Set<dayLabel>
	if (isMultiDay) {
		dayBreakdown.forEach(day => {
			(day.respondents || []).forEach(r => {
				const key = (r.email || r.respondent_name || r.full_name || '').toLowerCase().trim();
				if (!key) return;
				if (!attendedDays.has(key)) attendedDays.set(key, new Set());
				attendedDays.get(key).add(day.label);
			});
		});
	}

	const allDayLabels = isMultiDay ? dayBreakdown.map(d => d.label) : [];

	tbody.innerHTML = respondents.map(r => {
		const key = (r.email || r.respondent_name || r.full_name || '').toLowerCase().trim();
		const attended = attendedDays.get(key) || new Set();
		const missedDays = isMultiDay ? allDayLabels.filter(l => !attended.has(l)) : [];
		const attendedAll = missedDays.length === 0;

		// Status badge
		const statusBadge = attendedAll
			? `<span class="status-badge-completed">Attended</span>`
			: `<span class="status-badge-partial">Partial</span>`;

		// Actions column
		const actionCol = attendedAll
			? `<span style="color:#059669;font-size:12px;">✓ All Days</span>`
			: `<span style="color:#d97706;font-size:12px;">
				<i class="fa-solid fa-triangle-exclamation"></i>
				Missed: ${missedDays.map(l => `<span class="missed-day-tag">${escapeHtml(l)}</span>`).join('')}
			   </span>`;

		return `<tr>
		  <td>
			<strong>${escapeHtml(r.respondent_name || r.full_name || '—')}</strong>
			${r.email ? `<br><small style="color:#6b7280">${escapeHtml(r.email)}</small>` : ''}
			${r.designation ? `<br><small style="color:#9ca3af">${escapeHtml(r.designation)}</small>` : ''}
		  </td>
		  <td>${isMultiDay ? statusBadge : '<span class="status-badge-completed">Attended</span>'}</td>
		  <td>${escapeHtml(r.participant_type || '—')}</td>
		  <td>${isMultiDay ? actionCol : '<span style="color:#059669;font-size:12px;">✓ Attended</span>'}</td>
		</tr>`;
	}).join('');
}

function renderMonitoringStats() {
	if (!State.monitoringData) return;
	const d = State.monitoringData;
	const total = d.total || d.total_participants || 0;
	const completed = d.completed || d.completed_count || 0;
	document.getElementById('monitorTotalParticipants').textContent = total;
	document.getElementById('monitorCompleted').textContent = completed;
	document.getElementById('monitorPending').textContent = d.pending ?? (total - completed);
	document.getElementById('monitorCompletionRate').textContent = total > 0 ? Math.round((completed / total) * 100) + '%' : '0%';
	renderDayCompletionBars(d.days || []);
}

function renderDayCompletionBars(days) {
	const container = document.getElementById('dayCompletionBars');
	if (!days.length) {
		container.innerHTML = '<p style="color:#6b7280;font-size:13px;">No day data available</p>';
		return;
	}
	container.innerHTML = days.map(d => {
		const pct = d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
		const label = d.label || `Day ${d.day_number}`;
		return `<div class="day-completion-bar">
      <span class="day-label">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-pct-text">${d.completed}/${d.total > 0 ? d.total : '?'}</span>
      <span class="bar-percent">${pct}%</span>
    </div>`;
	}).join('');
}

async function loadMonitoringParticipants() {
	if (!State.viewingId) return;
	const tbody = document.getElementById('monitoringTableBody');
	tbody.innerHTML = '<tr><td colspan="4" class="no-data"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';

	try {
		const res = await fetch(`${API_URL}/evaluation_monitoring.php?action=participants&workshop_id=${State.viewingId}`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (result.success) {
			const raw = result.data;
			const participants = Array.isArray(raw) ? raw : (raw?.participants || raw?.data || []);
			renderMonitoringTable(participants);
		} else {
			tbody.innerHTML = '<tr><td colspan="4" class="no-data">Failed to load participants</td></tr>';
		}
	} catch (_) {
		tbody.innerHTML = '<tr><td colspan="4" class="no-data">Error loading participants</td></tr>';
	}
}

function renderMonitoringTable(participants) {
	const tbody = document.getElementById('monitoringTableBody');
	if (!participants.length) {
		tbody.innerHTML = '<tr><td colspan="4" class="no-data">No participants found</td></tr>';
		return;
	}
	tbody.innerHTML = participants.map(p => {
		const status = p.attendance_status || p.status || 'registered';
		const isCompleted = status === 'attended' || status === 'completed';
		const statusClass = isCompleted ? 'completed' : (status === 'absent' ? 'pending' : 'partial');
		const statusLabel = isCompleted ? 'Attended' : (status === 'absent' ? 'Absent' : 'Registered');
		return `<tr>
      <td>
        <strong>${escapeHtml(p.full_name || p.name || '—')}</strong>
        ${p.email ? `<br><small style="color:#6b7280">${escapeHtml(p.email)}</small>` : ''}
        ${p.designation ? `<br><small style="color:#9ca3af">${escapeHtml(p.designation)}</small>` : ''}
      </td>
      <td><span class="status-badge-${statusClass}">${statusLabel}</span></td>
      <td>${escapeHtml(p.participant_type || '—')}</td>
      <td>
        ${(!isCompleted && p.email)
				? `<button class="btn-remind-one" onclick="remindParticipant(${p.id},'${escapeAttr(p.email)}')"><i class="fa-solid fa-envelope"></i> Remind</button>`
				: `<span style="color:#059669;font-size:12px;">✓ ${statusLabel}</span>`}
      </td>
    </tr>`;
	}).join('');
}

function filterMonitoringTable() {
	const md = State.monitoringData;

	// Excel / container records: filter the in-memory respondents list
	if (md?._isRecord) {
		const statusFilter = document.getElementById('monitorStatusFilter')?.value || '';
		const searchVal    = (document.getElementById('monitorSearchInput')?.value || '').toLowerCase().trim();

		// Re-compute per-respondent attendance status using the cached day breakdown
		const dayBreakdown = md._dayBreakdown || null;
		const isMultiDay   = dayBreakdown && dayBreakdown.length > 1;
		const allDayLabels = isMultiDay ? dayBreakdown.map(d => d.label) : [];

		const attendedDays = new Map();
		if (isMultiDay) {
			dayBreakdown.forEach(day => {
				(day.respondents || []).forEach(r => {
					const key = (r.email || r.respondent_name || r.full_name || '').toLowerCase().trim();
					if (!key) return;
					if (!attendedDays.has(key)) attendedDays.set(key, new Set());
					attendedDays.get(key).add(day.label);
				});
			});
		}

		let filtered = (md._respondents || []).filter(r => {
			// Search filter
			if (searchVal) {
				const name  = (r.respondent_name || r.full_name || '').toLowerCase();
				const email = (r.email || '').toLowerCase();
				if (!name.includes(searchVal) && !email.includes(searchVal)) return false;
			}
			// Status filter
			if (statusFilter !== '') {
				const key        = (r.email || r.respondent_name || r.full_name || '').toLowerCase().trim();
				const attended   = attendedDays.get(key) || new Set();
				const missedDays = isMultiDay ? allDayLabels.filter(l => !attended.has(l)) : [];
				const status     = !isMultiDay ? 'attended' : (missedDays.length === 0 ? 'attended' : 'partial');
				// HTML dropdown uses 'completed' to mean fully attended
				const normalizedFilter = statusFilter === 'completed' ? 'attended' : statusFilter;
				if (normalizedFilter !== '' && normalizedFilter !== status) return false;
			}
			return true;
		});

		renderMonitoringFromRespondents(filtered, dayBreakdown);
		return;
	}

	// System workshop path: re-fetch with filters from the API
	loadMonitoringParticipants();
}

async function remindParticipant(participantId, email) {
	if (!email) { showAlert('error', 'No email address for this participant'); return; }
	if (!confirm(`Send reminder to ${email}?`)) return;
	try {
		const res = await fetch(`${API_URL}/evaluation_monitoring.php?action=remind`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ participant_ids: [participantId], workshop_id: State.viewingId })
		});
		const result = await res.json();
		if (result.success) showAlert('success', 'Reminder sent');
		else showAlert('error', result.message || 'Failed to send reminder');
	} catch (_) { showAlert('error', 'Error sending reminder'); }
}

async function remindAllIncomplete() {
	if (!State.viewingId) return;
	if (!confirm('Send reminders to all participants who have not completed their evaluation?')) return;
	try {
		const res = await fetch(`${API_URL}/evaluation_monitoring.php?action=remind_all`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ workshop_id: State.viewingId })
		});
		const result = await res.json();
		if (result.success) showAlert('success', `Reminders sent to ${result.count || 0} participants`);
		else showAlert('error', result.message || 'Failed to send reminders');
	} catch (_) { showAlert('error', 'Error sending reminders'); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  23. PAGE-LEVEL TAB SWITCHING — removed (unified list now)
// ═══════════════════════════════════════════════════════════════════════════
// Kept as a no-op so any external callers don't throw.
function switchPageTab(tab) { /* tabs removed — single unified list */ }

// ═══════════════════════════════════════════════════════════════════════════
//  24. RECORDS (EXCEL IMPORTS) — removed separate tab
//  Excel imports now appear inline in the main programs table with a source
//  badge. The functions below are kept as stubs for safety.
// ═══════════════════════════════════════════════════════════════════════════
async function loadRecords() { /* no-op — merged into loadPrograms() */ }
function displayRecords() { /* no-op */ }
function searchRecords() { /* no-op */ }

async function viewRecord(id) {
	State.viewingId = id;
	State.isRecord = true;
	State.containerWorkshopId = null;  // reset so saveRecordEdit doesn't use a stale container ID from a previous view
	try {
		const res = await fetch(`${API_URL}/records_api.php?id=${id}`, {
			credentials: 'include'
		});
		const result = await res.json();
		if (!result.success) { showAlert('error', result.message || 'Failed to load record'); return; }

		const p = result.program;

		// Normalise into the same shape viewProgram uses
		// Convert records_api days ({ day, respondents, categories, speakers })
		// into the shape populateDaySelectors expects ({ id, day_number, title })
		// Also carry respondents count so the report can show real per-day counts
		// instead of incorrectly splitting total respondents evenly across days.
		const recordDays = (p.days || []).map((d, i) => ({
			id: i + 1,
			day_number: i + 1,
			title: d.day || `Day ${i + 1}`,
			respondents: d.respondents ?? null,  // actual per-day count from DB
		}));

		State.workshopData = {
			id: p.id,
			eval_program_id: p.id,          // same for standalone
			title: p.title,
			venue: p.training_venue,
			training_venue: p.training_venue,
			proponents: p.proponents,
			start_date: p.inclusive_dates,
			end_date: null,
			inclusive_dates: p.inclusive_dates,
			qame_associates: p.qame_associates,
			total_participants: p.total_participants,
			total_responses: p.total_responses,
			pct_responses: p.pct_responses,
			overall_average: p.overall_average,
			overall_result: p.overall_result,
			source: 'excel',
			source_type: 'standalone',
			overall_categories: p.overall_categories || [],
			days: recordDays,
			day_participants: p.day_participants || null,
			feedback: p.feedback || {},
			settings_snapshot: p.settings_snapshot || null,
			feedback_labels: p.feedback_labels || null,
			// ── fields needed by buildReportHTML / Word / PPTX export ──────────
			sequence_number: p.sequence_number || null,
			division_memo:   p.division_memo   || null,
			status:          p.status          || null,
			unit:            p.unit            || null,
			nature_of_event: p.nature_of_event || null,
			description:     p.description     || null,
		};

		document.getElementById('viewModalTitle').textContent = p.title;

		const fmt = (n, d = 2) => (n === null || n === undefined || n === '') ? '—' : parseFloat(n).toFixed(d);
		const oc = p.overall_categories || [];
		const catRows = oc.map(c => {
			const avg = parseFloat(c.average_score);
			const result = !isNaN(avg) ? getInterpretation(avg, 'category') : '—';
			return `
      <tr>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(c.category_name)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:#1e3a8a;">${fmt(c.average_score)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(result)}</td>
      </tr>`;
		}).join('');
		const overallAvgNum = parseFloat(p.overall_average);
		const overallResultDynamic = !isNaN(overallAvgNum) ? getInterpretation(overallAvgNum, 'overall') : (p.overall_result || '—');

		document.getElementById('viewProgramContent').innerHTML = `
      <span class="badge-excel-import" style="margin-bottom:12px;display:inline-block;"><i class="fa-solid fa-file-excel"></i> Excel Import</span>
      <p><strong>Title:</strong>               ${escapeHtml(p.title)}</p>
      <p><strong>Venue:</strong>               ${escapeHtml(p.training_venue || '—')}</p>
      <p><strong>Dates:</strong>               ${escapeHtml(p.inclusive_dates || '—')}</p>
      <p><strong>Proponent/s:</strong>         ${escapeHtml(p.proponents || '—')}</p>
      <p><strong>QAME Associates:</strong>     ${escapeHtml(p.qame_associates || '—')}</p>
      <p><strong>Total Participants:</strong>  ${p.total_participants > 0 ? p.total_participants : '—'}</p>
      <p><strong>Total Responses:</strong>     ${p.total_respondents_actual ?? p.total_responses ?? 0}</p>
      <p><strong>Overall Average:</strong>     <span style="font-weight:700;color:#1e3a8a">${fmt(p.overall_average)}</span></p>
      <p><strong>Overall Result:</strong>      ${escapeHtml(overallResultDynamic)}</p>
      ${oc.length ? `<div class="days-list" style="margin-top:16px;">
        <h4 style="margin-bottom:10px;color:#1e3a8a;">Category Averages</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr>
            <th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:left;">Category</th>
            <th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:center;width:120px;">Average</th>
            <th style="border:1px solid #333;padding:8px;background:#111FA2;color:#fff;font-weight:bold;text-align:left;width:180px;">Result</th>
          </tr></thead>
          <tbody>${catRows}</tbody>
        </table>
      </div>` : ''}`;

		populateDaySelectors(recordDays);
		switchViewTab('overview');
		document.getElementById('viewProgramModal').classList.add('active');
		loadWorkshopResponses();
		loadMonitoringData();
	} catch (_) { showAlert('error', 'Failed to load record details'); }
}

// ─── EDIT EXCEL RECORD ────────────────────────────────────────────────────
async function openEditRecordModal(id, title) {
	// Always reset the container ID field at the start so a previously opened
	// container-linked record never bleeds its workshop ID into a standalone save.
	const _existingContainerEl = document.getElementById('erContainerWorkshopId');
	if (_existingContainerEl) _existingContainerEl.value = '';

	try {
		// Load program data and dropdown options in parallel
		const [recordRes, optsRes] = await Promise.all([
			fetch(`${API_URL}/records_api.php?id=${id}`, { credentials: 'include' }),
			fetch(`${API_URL}/programs.php?dropdown_options=1`, { credentials: 'include' })
		]);

		const result = await recordRes.json();
		if (!result.success) { showAlert('error', result.message || 'Failed to load record'); return; }
		const p = result.program;

		// ── Detect container-linked import ───────────────────────────────────────
		// If this import is linked to a container (has workshop_id), the program
		// detail fields (title, memo, dates, venue, etc.) live on the CONTAINER,
		// not on this import record. Fetch and display the container's data instead.
		let detailSource = p;          // the object whose fields populate the form
		let containerWorkshopId = p.workshop_id || null;

		if (containerWorkshopId) {
			try {
				const containerRes = await fetch(`${API_URL}/programs.php?id=${containerWorkshopId}`, { credentials: 'include' });
				const containerJson = await containerRes.json();
				if (containerJson.success && containerJson.data) {
					detailSource = containerJson.data;
					// Keep p.id so save goes to the right record_api row
				}
			} catch (_) { /* non-fatal — fall back to import's own data */ }
		}

		// Populate Unit and Nature of Event dropdowns dynamically from DB
		if (optsRes.ok) {
			const opts = await optsRes.json();
			if (opts.success && opts.data) {
				const { unit = [], nature_of_event = [] } = opts.data;
				populateSelect('erUnit', unit, detailSource.unit || 'SGOD');
				populateSelect('erNatureOfEvent', nature_of_event, detailSource.nature_of_event || 'Training');
			}
		} else {
			// Fallback: hardcoded options if API fails
			populateSelect('erUnit', ['SGOD', 'CID', 'OSDS'], detailSource.unit || 'SGOD');
			populateSelect('erNatureOfEvent', ['Training', 'Seminar', 'Workshop', 'Conference'], detailSource.nature_of_event || 'Training');
		}

		// Populate all fields from detailSource (container or standalone import)
		document.getElementById('erRecordId').value = p.id;  // always the import's own id
		document.getElementById('erTitle').value = detailSource.title || '';
		document.getElementById('erSequenceNumber').value = p.sequence_number || '';
		document.getElementById('erDivisionMemo').value = detailSource.division_memo || '';
		document.getElementById('erStatus').value = detailSource.status || p.status || 'completed';
		document.getElementById('erProponents').value = detailSource.proponents || '';
		document.getElementById('erQameAssociates').value = p.qame_associates || detailSource.qame_associates || '';
		document.getElementById('erVenue').value = detailSource.training_venue || detailSource.venue || '';
		const derivedDates = detailSource.inclusive_dates
			|| (detailSource.start_date
				? formatDate(detailSource.start_date) +
				(detailSource.end_date && detailSource.end_date !== detailSource.start_date
					? ' – ' + formatDate(detailSource.end_date)
					: '')
				: '');
		document.getElementById('erDates').value = derivedDates;
		document.getElementById('erStartDate').value = toDateInputValue(detailSource.start_date);
		document.getElementById('erEndDate').value = toDateInputValue(detailSource.end_date);
		// When linked to a container, load the container's expected count.
		// For standalone, use the import's own value. Allow blank — do not force a number.
		const _totalPartic = containerWorkshopId
			? (detailSource.total_participants ?? p.total_participants ?? '')
			: (p.total_participants ?? '');
		document.getElementById('erTotalParticipants').value = (_totalPartic === null || _totalPartic === undefined) ? '' : _totalPartic;
		document.getElementById('erDescription').value = detailSource.description || '';

		// Store container workshop_id on the hidden field so saveRecordEdit can
		// propagate detail-field changes back to the container program.
		let erContainerIdEl = document.getElementById('erContainerWorkshopId');
		if (!erContainerIdEl) {
			erContainerIdEl = document.createElement('input');
			erContainerIdEl.type = 'hidden';
			erContainerIdEl.id = 'erContainerWorkshopId';
			document.getElementById('erRecordId').parentNode.appendChild(erContainerIdEl);
		}
		erContainerIdEl.value = containerWorkshopId || '';

		// ── Populate speaker name inputs — ALL days across ALL linked imports ────
		const speakersSection   = document.getElementById('erSpeakersSection');
		const speakersContainer = document.getElementById('erSpeakersContainer');
		speakersContainer.innerHTML = '';

		// Collect speakers from a source object's days array.
		// Handles both data shapes:
		//   records_api (speaker_averages): { slot_number, speaker_name, id }
		//   programs.php (resource_speakers): { speaker_number, name, id }
		// sourceTable tells saveRecordEdit which endpoint to PATCH.
		const allSpeakers = [];
		const collectSpeakers = (source, programId, sourceTable) => {
			if (!source.days || !Array.isArray(source.days)) return;
			source.days.forEach(day => {
				if (!day.speakers || !Array.isArray(day.speakers)) return;
				day.speakers.forEach(sp => {
					// Normalise slot and name across both table shapes
					const slot     = sp.slot_number ?? sp.speaker_number;
					const name     = sp.speaker_name ?? sp.name ?? '';
					const dayLabel = day.day ?? day.title ?? `Day ${day.day_number ?? '?'}`;
					if (sp && slot !== undefined) {
						allSpeakers.push({ id: sp.id, day: dayLabel, slot, name, programId, sourceTable });
					}
				});
			});
		};

		// 1. Current excel import → speaker_averages
		collectSpeakers(p, p.id, 'speaker_averages');

		// 2. Container's own workshop_days → resource_speakers (already in detailSource)
		//    These are the speakers created when the container was set up (e.g. "Speaker 1/2/3").
		//    They are stored in resource_speakers and must be updated via programs.php?update_speakers.
		if (containerWorkshopId && detailSource && detailSource.days) {
			collectSpeakers(detailSource, containerWorkshopId, 'resource_speakers');
		}

		// 3. Sibling excel imports linked to the same container → speaker_averages
		if (containerWorkshopId) {
			try {
				const importsRes = await fetch(`${API_URL}/programs.php?program_imports=1&workshop_id=${containerWorkshopId}`, { credentials: 'include' });
				const importsJson = await importsRes.json();
				if (importsJson.success && Array.isArray(importsJson.data)) {
					const siblingFetches = importsJson.data
						.filter(imp => imp.program_id && imp.program_id !== p.id)
						.map(imp => fetch(`${API_URL}/records_api.php?id=${imp.program_id}`, { credentials: 'include' })
							.then(r => r.json())
							.catch(() => null)
						);
					const siblingResults = await Promise.all(siblingFetches);
					siblingResults.forEach(sr => {
						if (sr && sr.success && sr.program) collectSpeakers(sr.program, sr.program.id, 'speaker_averages');
					});
				}
			} catch (_) { /* non-fatal — show what we already collected */ }
		}

		if (allSpeakers.length > 0) {
			speakersSection.style.display = '';
			allSpeakers.forEach(sp => {
				const row = document.createElement('div');
				row.style.cssText = 'display:flex;align-items:center;gap:8px;';
				row.innerHTML = `
					<span style="font-size:12px;color:#64748b;white-space:nowrap;min-width:120px;">
						${sp.day} · Speaker ${sp.slot}
					</span>
					<input type="text"
						data-speaker-id="${sp.id}"
						data-program-id="${sp.programId}"
						data-source-table="${sp.sourceTable}"
						value="${(sp.name || '').replace(/"/g, '&quot;')}"
						placeholder="Enter speaker name"
						style="flex:1;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
				`;
				speakersContainer.appendChild(row);
			});
		} else {
			speakersSection.style.display = 'none';
		}

		// Reset save button in case previous attempt left it disabled
		const saveBtn = document.getElementById('erSaveBtn');
		if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }

		document.getElementById('editRecordModal').classList.add('active');
	} catch (e) {
		showAlert('error', 'Failed to open edit form');
	}
}

function closeEditRecordModal() {
	document.getElementById('editRecordModal').classList.remove('active');
}

async function saveRecordEdit() {
	const id = parseInt(document.getElementById('erRecordId').value);
	const title = document.getElementById('erTitle')?.value.trim();
	if (!title) { showAlert('error', 'Program title is required'); return; }

	const selectedUnit = String(document.getElementById('erUnit')?.value || '').trim();
	const selectedNature = String(document.getElementById('erNatureOfEvent')?.value || '').trim();
	if (selectedUnit === '__add_custom__' || selectedNature === '__add_custom__') {
		showAlert('error', 'Please finish adding custom Unit/Nature before saving.');
		return;
	}

	// Detect if this import is linked to a container
	const containerWorkshopId = parseInt(document.getElementById('erContainerWorkshopId')?.value) || null;

	const detailPayload = {
		title,
		division_memo: document.getElementById('erDivisionMemo')?.value.trim() || null,
		status: document.getElementById('erStatus')?.value || 'completed',
		proponents: document.getElementById('erProponents')?.value.trim() || null,
		unit: selectedUnit || null,
		nature_of_event: selectedNature || null,
		training_venue: document.getElementById('erVenue')?.value.trim() || null,
		inclusive_dates: document.getElementById('erDates')?.value.trim() || null,
		start_date: document.getElementById('erStartDate')?.value || null,
		end_date: document.getElementById('erEndDate')?.value || null,
		description: document.getElementById('erDescription')?.value.trim() || null,
		total_participants: parseInt(document.getElementById('erTotalParticipants')?.value) || null,
	};

	// The import record itself only gets stats-level fields (sequence_number, qame)
	// total_participants goes to detailPayload (→ container) when linked, or to the
	// import record directly when standalone.
	const payload = {
		id,
		sequence_number: document.getElementById('erSequenceNumber')?.value.trim() || null,
		qame_associates: document.getElementById('erQameAssociates')?.value.trim() || null,
		// If NOT linked to a container, also save detail fields to the import record itself
		...(containerWorkshopId ? {} : detailPayload),
		// standalone still needs total_participants on the record
		...(containerWorkshopId ? { total_participants: detailPayload.total_participants } : {}),
	};

	// Collect updated speaker names grouped by owning program + source table.
	//   speaker_averages → PATCH records_api.php        (excel imports)
	//   resource_speakers → PATCH programs.php?update_speakers  (container/live)
	const speakerInputs = document.querySelectorAll('#erSpeakersContainer input[data-speaker-id]');
	const speakerGroups = {};  // keyed as "programId|sourceTable"
	speakerInputs.forEach(inp => {
		const pid   = parseInt(inp.dataset.programId) || id;
		const table = inp.dataset.sourceTable || 'speaker_averages';
		const key   = `${pid}|${table}`;
		if (!speakerGroups[key]) speakerGroups[key] = { pid, table, speakers: [] };
		speakerGroups[key].speakers.push({ id: parseInt(inp.dataset.speakerId), name: inp.value.trim() });
	});
	// Current record's own speakers go into the main payload (sent with the main PATCH below)
	const currentKey = `${id}|speaker_averages`;
	if (speakerGroups[currentKey]) {
		payload.speakers = speakerGroups[currentKey].speakers;
	}

	const saveBtn = document.getElementById('erSaveBtn');
	if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

	try {
		// If linked to a container, update the container program's detail fields first.
		// This is the primary save — await it so we can surface any errors.
		if (containerWorkshopId) {
			const containerPayload = {
				program_id: containerWorkshopId,
				program_type: 'container',  // preserve — PUT would otherwise reset it
				...detailPayload,
			};
			const containerRes = await fetch(`${API_URL}/programs.php`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(containerPayload)
			});
			const containerResult = await containerRes.json();
			if (!containerResult.success) {
				showAlert('error', containerResult.message || 'Failed to update program details');
				if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }
				return;
			}
		}

		const res = await fetch(`${API_URL}/records_api.php`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(payload)
		});
		const result = await res.json();
		if (result.success) {
			// Fire additional PATCHes for speakers not owned by the current record.
			// resource_speakers (container days) → programs.php?update_speakers
			// sibling speaker_averages → records_api.php with the sibling's own id
			const extraSaves = Object.entries(speakerGroups)
				.filter(([key]) => key !== currentKey)
				.map(([, grp]) => {
					if (grp.table === 'resource_speakers') {
						return fetch(`${API_URL}/programs.php?update_speakers`, {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							credentials: 'include',
							body: JSON.stringify({ speakers: grp.speakers })
						});
					} else {
						return fetch(`${API_URL}/records_api.php`, {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							credentials: 'include',
							body: JSON.stringify({ id: grp.pid, speakers: grp.speakers })
						});
					}
				});
			if (extraSaves.length > 0) await Promise.all(extraSaves);
			closeEditRecordModal();
			showAlert('success', 'Record updated successfully');
			loadPrograms();
			// FIX: Refresh State.workshopData so exports immediately reflect saved changes
			// (e.g. updated inclusive_dates) without needing to close and reopen the modal.
			const _refreshId = State.containerWorkshopId || State.viewingId;
			if (_refreshId) {
				fetch(`${API_URL}/programs.php?id=${_refreshId}`, { credentials: 'include' })
					.then(r => r.json())
					.then(j => { if (j.success) State.workshopData = j.data; })
					.catch(() => {});
			}
		} else {
			showAlert('error', result.message || 'Failed to save');
			if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }
		}
	} catch (e) {
		showAlert('error', 'Error saving record');
		if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }
	}
}

async function deleteRecord(id, title) {
	const confirmed = await showConfirm({
		title: 'Delete Record?',
		message: `Delete "${title}"?\n\nThis action cannot be undone.`,
		confirmText: 'Delete',
		confirmColor: '#dc2626',
		iconClass: 'fa-triangle-exclamation',
		iconBg: '#fef2f2',
		iconColor: '#dc2626'
	});
	if (!confirmed) return;
	try {
		const res = await fetch(`${API_URL}/records_api.php?id=${id}`, {
			method: 'DELETE', credentials: 'include'
		});
		const result = await res.json();
		if (result.success) {
			showAlert('success', 'Record deleted');
			loadPrograms(); // refresh unified list
		} else { showAlert('error', result.message || 'Failed to delete'); }
	} catch (_) { showAlert('error', 'Error deleting record'); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  25. SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════
// ─── Custom Confirm Dialog ──────────────────────────────────────────────────
function showConfirm({ title, message, confirmText = 'Confirm', confirmColor = '#dc2626', iconClass = 'fa-triangle-exclamation', iconBg = '#fef2f2', iconColor = '#dc2626' }) {
	return new Promise(resolve => {
		const modal = document.getElementById('customConfirmModal');
		const iconEl = document.getElementById('ccmIcon');
		const titleEl = document.getElementById('ccmTitle');
		const msgEl = document.getElementById('ccmMessage');
		const confirmBtn = document.getElementById('ccmConfirm');
		const cancelBtn = document.getElementById('ccmCancel');

		iconEl.style.background = iconBg;
		iconEl.style.color = iconColor;
		iconEl.innerHTML = `<i class="fas ${iconClass}"></i>`;
		titleEl.textContent = title;
		msgEl.textContent = message;
		confirmBtn.textContent = confirmText;
		confirmBtn.style.background = confirmColor;

		modal.style.display = 'flex';

		const cleanup = (result) => {
			modal.style.display = 'none';
			// { once: true } on the listeners below already self-removes them after firing,
			// so no cloneNode needed here — cloneNode would detach the buttons from the DOM
			// and break subsequent showConfirm calls (closes over stale node refs).
			resolve(result);
		};

		confirmBtn.addEventListener('click', () => cleanup(true), { once: true });
		cancelBtn.addEventListener('click', () => cleanup(false), { once: true });
	});
}

// ─── Toast Notification ─────────────────────────────────────────────────────
function showToast(type, message) {
	const toast = document.getElementById('toastNotif');
	const iconEl = document.getElementById('toastIcon');
	const textEl = document.getElementById('toastText');

	const config = {
		success: { bg: '#16a34a', icon: 'fa-circle-check' },
		error: { bg: '#dc2626', icon: 'fa-circle-xmark' },
		warning: { bg: '#d97706', icon: 'fa-triangle-exclamation' },
		info: { bg: '#2563eb', icon: 'fa-circle-info' },
	};
	const cfg = config[type] || config.info;

	toast.style.background = cfg.bg;
	iconEl.className = `fas ${cfg.icon}`;
	textEl.textContent = message;
	toast.style.opacity = '1';
	toast.style.transform = 'translateY(0)';
	toast.style.pointerEvents = 'auto';

	clearTimeout(toast._hideTimer);
	toast._hideTimer = setTimeout(() => {
		toast.style.opacity = '0';
		toast.style.transform = 'translateY(12px)';
		toast.style.pointerEvents = 'none';
	}, 4000);
}

function showAlert(type, msg) {
	const el = document.getElementById('programsAlert');
	el.className = `alert alert-${type} show`;
	el.textContent = msg;
	setTimeout(() => el.classList.remove('show'), 5000);
}

function showRecordsAlert(type, msg) {
	// Records section removed — fall back to the main programs alert
	showAlert(type, msg);
}

function formatDate(d) {
	if (!d) return 'N/A';
	return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function toDateInputValue(value) {
	if (value === null || value === undefined) return '';

	const raw = String(value).trim();
	if (!raw || raw.toLowerCase() === 'undefined' || raw.toLowerCase() === 'null') return '';

	// Fast path: already in YYYY-MM-DD
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

	// Common DB datetime: YYYY-MM-DD HH:mm:ss
	const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T]/);
	if (m) return m[1];

	const dt = new Date(raw);
	if (Number.isNaN(dt.getTime())) return '';
	return dt.toISOString().slice(0, 10);
}

function escapeHtml(t) {
	if (!t) return '';
	const el = document.createElement('div');
	el.textContent = t;
	return el.innerHTML;
}

/**
 * Safe for use inside HTML attribute values (data-title="…").
 * With event delegation we rarely need this inside onclick strings anymore,
 * but it's still used in a few remaining places.
 */
function escapeAttr(t) {
	if (!t) return '';
	return t.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')	
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// ─── Logout ────────────────────────────────────────────────────────────────
async function logout() {
	try {
		await fetch(`${API_URL}/logout.php`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include'
		});
	} catch (_) { }
	finally {
		clearLocalStorage();
		window.location.replace('login.html');
	}
}

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