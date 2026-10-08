console.log('[school-portal-permit.js] build v6 — dynamic checklist from backend loaded');

const API_BASE    = CONFIG.API_URL;
const PERMIT_API  = `${API_BASE}/school-portal-permit.php`;
const userId      = localStorage.getItem('edu_user_id');
const userEmail   = localStorage.getItem('edu_email');
const fullName    = localStorage.getItem('edu_full_name');
const role        = localStorage.getItem('edu_role')         || 'teacher';
const accountType = localStorage.getItem('edu_account_type') || 'portal_user';

let allApplications   = [];
let appsSearchTerm     = '';
let appsStatusFilter   = 'all';

// ── Avatar / init helpers (shared boilerplate) ──────────────────────────────────
function setPortalAvatars(profilePicture, fullNameValue) {
    const fallback = getInitials(fullNameValue);
    ['sidebarAvatar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = profilePicture ? `<img src="${profilePicture}" alt="Profile photo">` : '';
        if (!profilePicture) el.textContent = fallback;
    });
}

function getInitials(name) {
    return (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function initUI() {
    const _fullName     = localStorage.getItem('edu_full_name')      || fullName  || '—';
    const _userEmail    = localStorage.getItem('edu_email')           || userEmail || '—';
    const _role         = localStorage.getItem('edu_role')            || role      || '—';
    const _schoolName   = (localStorage.getItem('edu_school_name')   || '').trim() || '—';
    const _schoolAddress = (localStorage.getItem('edu_school_address') || '').trim();
    const _districtName = (localStorage.getItem('edu_district_name') || '').trim() || '—';
    const _sidebarLine   = _schoolAddress || _districtName;
    const _photo        = localStorage.getItem('edu_profile_picture') || '';

    setPortalAvatars(_photo, _fullName);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('sidebarName',       _fullName || _userEmail);
    set('sidebarRole',       _role);
    set('sidebarSchoolName', _schoolName);
    set('sidebarDistrict',   _sidebarLine);
}

async function loadDashboard() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message);
        }

        const d = data.data;
        if (d.user?.account_type === 'sdo_personnel') { window.location.href = 'school-portal.html'; return; }

        const prevSchoolName   = (localStorage.getItem('edu_school_name')   || '').trim();
        const prevDistrictName = (localStorage.getItem('edu_district_name') || '').trim();
        const prevSchoolAddress = (localStorage.getItem('edu_school_address') || '').trim();

        const nextSchoolName   = String(d.school?.name     || '').trim() || prevSchoolName;
        const nextDistrictName = String(d.school?.district || '').trim() || prevDistrictName;
        const nextSchoolAddress = buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city) || prevSchoolAddress;

        localStorage.setItem('edu_user_id',         d.user.id);
        localStorage.setItem('edu_email',           d.user.email);
        localStorage.setItem('edu_full_name',       d.user.full_name);
        localStorage.setItem('edu_role',            d.user.role            || 'teacher');
        localStorage.setItem('edu_account_type',    d.user.account_type    || 'portal_user');
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',     nextSchoolName);
        localStorage.setItem('edu_district_name',   nextDistrictName);
        localStorage.setItem('edu_school_address',  nextSchoolAddress);

        initUI();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();
        return d;
    } catch (err) {
        console.error('loadDashboard error:', err);
    }
}

// ── Level label helpers (used to auto-fill course / curriculum year) ───────────
const LEVEL_LABELS = {
    pre:  'Pre-Elementary',
    elem: 'Elementary',
    jhs:  'Junior High School',
    shs:  'Senior High School',
};
const LEVEL_CURRICULUM = {
    pre:  'Nursery – Kindergarten',
    elem: 'Grade 1 – Grade 6',
    jhs:  'Grade 7 – Grade 10',
    shs:  'Grade 11 – Grade 12',
};
function parseLevels(raw) {
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        return arr.filter(Boolean);
    } catch { return []; }
}

function populateSchoolYears(selectId = 'w-school-year', selectedValue = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const normalizedSelected = String(selectedValue || '').replace(/-/g, '–').trim();
    const currentYear = new Date().getFullYear();
    select.innerHTML  = '<option value="">— Select School Year —</option>';
    for (let y = currentYear - 1; y <= currentYear + 1; y++) {
        const label = `${y}–${y + 1}`;
        const opt   = document.createElement('option');
        opt.value       = label;
        opt.textContent = label;
        if (normalizedSelected) {
            opt.selected = label === normalizedSelected;
        } else if (y === currentYear) {
            opt.selected = true;
        }
        select.appendChild(opt);
    }
    if (normalizedSelected && !Array.from(select.options).some(o => o.value === normalizedSelected)) {
        const opt = document.createElement('option');
        opt.value = normalizedSelected;
        opt.textContent = normalizedSelected;
        opt.selected = true;
        select.appendChild(opt);
    }
}

// ── GPR-3 checklist definition (section → items) ────────────────────────────────
// This used to be the ONLY copy of the checklist (hardcoded here, and duplicated
// again in school-portal-permit.php — the two would silently drift apart).
// Now the backend is the single source of truth: `GPR3_CHECKLIST` starts out
// pointing at this fallback list so the UI never breaks, but gets overwritten
// with whatever `checklist_definition` the API returns (see loadApplications()),
// which is generated from the `permit_checklist_items` database table. Admins
// can add/edit/remove requirements there without touching any code.
const GPR3_CHECKLIST_FALLBACK = [
    {
        section: 'For All Applicants',
        always: true,
        items: [
            { id: 'board_resolution',          label: 'Board Resolution — certified by the Corporate Secretary' },
            { id: 'stmt_philosophy',           label: 'Statement of Philosophy and Goals of the course' },
            { id: 'stmt_demand',               label: 'Statement on demand for graduates' },
            { id: 'stmt_students',             label: 'Statement on prospective students' },
            { id: 'stmt_existing_schools',     label: 'Statement on existing schools offering the same course within the province/city' },
            { id: 'admin_list',                label: 'List of school administrators (president, VP, deans, dept. heads) — educationally qualified, full-time, salaries per standard' },
            { id: 'non_teaching_list',         label: 'List of academic non-teaching personnel (registrar, librarian, guidance counselor, researcher) — qualified with valid contracts' },
            { id: 'athletics_list',            label: 'List of athletic facilities, equipment, supplies and materials (certified by school head)' },
            { id: 'school_bond',               label: 'School Bond documents properly submitted (Pre-Elem ₱200 / Elem ₱500)' },
            { id: 'proposed_budget',           label: 'Proposed budget for the succeeding school year — approved by Board of Trustees/Directors' },
        ],
    },
    {
        section: 'For New Schools or Schools with Recent Changes',
        always: false,
        appTypes: ['new_school', 'recognition'],
        items: [
            { id: 'articles_of_inc',           label: 'Articles of Incorporation & By-Laws — in school\'s name, SEC-registered, stock/non-stock indicated' },
            { id: 'tct',                        label: 'Transfer Certificate of Title (TCT) — in school\'s name, total area adequate' },
            { id: 'lease_or_affidavit',         label: 'Contract of Lease or Affidavit of Ownership' },
            { id: 'location_desc',              label: 'Location description — far from noise, unpleasant odor, and dust' },
            { id: 'campus_plan',                label: 'Campus development & landscaping plans — sketch/plan, implementation status noted' },
            { id: 'building_ownership',         label: 'Document(s) of Ownership of school building(s) — in school\'s name, total floor area adequate, with Tax Declaration No.' },
            { id: 'cert_occupancy',             label: 'Certificate of Occupancy — signed by proper city/municipal authorities' },
            { id: 'school_pictures',            label: 'Pictures of classrooms, labs, library, medical/dental, canteen — adequate and clean' },
        ],
    },
    {
        section: 'For New Courses / Programs',
        always: false,
        appTypes: ['new_course'],
        items: [
            { id: 'retirement_plan',            label: 'Copy of Retirement Plan — registered with the Securities and Exchange Commission' },
            { id: 'financial_statement',        label: 'Latest Financial Statement — certified by independent CPA, complete' },
            { id: 'proposed_curriculum',        label: 'Proposed Curriculum — in accordance with DepEd standards (DO #31 / DO #32 s. 2012); approved by DepEd' },
            { id: 'tuition_fees',               label: 'Proposed tuition and other school fees — approved by DECS / DepEd guidelines' },
            { id: 'new_teaching_staff',         label: 'List of new teaching/academic staff — educationally qualified, subject assignments per qualifications, valid contracts, full-time/part-time ratio per DECS policy' },
            { id: 'lab_facilities',             label: 'List of laboratory facilities, equipment, furniture, supplies and materials — classified by subject area, certified by school head, compliant with standards' },
            { id: 'library_holdings',           label: 'List of library holdings — certified by school head, compliant by classification' },
            { id: 'inspection_fee',             label: 'Inspection and Application Fees paid — ₱2,020.00 (O.R. No., Place, and Date of Issuance on file)' },
        ],
    },
];

// Live checklist definition — defaults to the fallback above, replaced with the
// server-driven definition as soon as loadApplications() resolves.
let GPR3_CHECKLIST = GPR3_CHECKLIST_FALLBACK;

function buildChecklist() {
    const appType   = (document.getElementById('w-app-type')?.value || '').trim();
    const container = document.getElementById('gpr3-checklist');
    if (!container) return;

    container.innerHTML = GPR3_CHECKLIST.map(group => {
        const show = group.always || (appType && group.appTypes?.includes(appType));
        if (!show) return '';
        const items = group.items.map(item => `
            <label class="checklist-item">
                <input type="checkbox" class="gpr3-check" id="chk-${item.id}" value="${item.id}">
                <span class="checklist-label">${item.label}</span>
            </label>
        `).join('');
        return `
            <div class="checklist-group">
                <div class="checklist-group-title">${group.section}</div>
                ${items}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.gpr3-check').forEach(cb => cb.addEventListener('change', updateChecklistProgress));
    updateChecklistProgress();
}

function updateChecklistProgress() {
    const total   = document.querySelectorAll('.gpr3-check').length;
    const checked = document.querySelectorAll('.gpr3-check:checked').length;
    const el      = document.getElementById('checklist-progress');
    if (el) {
        el.innerHTML = `<span style="color:${checked === total ? '#16a34a' : '#d97706'};font-weight:700;">${checked}/${total}</span> ready`;
    }
}

function getChecklistData() {
    const result = {};
    document.querySelectorAll('.gpr3-check').forEach(cb => { result[cb.value] = cb.checked; });
    return result;
}

// ── Submission mode (single combined file vs multiple files) ───────────────────
let submissionMode  = 'multiple'; // 'multiple' | 'single'
let selectedFiles   = [];          // [{file, label}]
let editingBatchId  = null;        // set when editing an existing application

function setSubmissionMode(mode) {
    submissionMode = mode;
    document.getElementById('modeMultipleBtn')?.classList.toggle('mode-active', mode === 'multiple');
    document.getElementById('modeSingleBtn')?.classList.toggle('mode-active', mode === 'single');
    document.getElementById('multiFileZone')?.classList.toggle('hidden', mode !== 'multiple');
    document.getElementById('singleFileZone')?.classList.toggle('hidden', mode !== 'single');
    selectedFiles = [];
    renderSelectedFiles();
    const singleInput = document.getElementById('file-permit-single');
    if (singleInput) singleInput.value = '';
}

function handleMultiFileSelect(input) {
    const files = Array.from(input.files || []);
    for (const file of files) {
        if (file.size > 10 * 1024 * 1024) {
            showWizardMsg('error', `"${file.name}" is too large. Maximum size is 10MB per file.`);
            continue;
        }
        if (selectedFiles.length >= 20) {
            showWizardMsg('error', 'Maximum of 20 files per application.');
            break;
        }
        selectedFiles.push({ file, label: '' });
    }
    input.value = '';
    renderSelectedFiles();
}

function handleSingleFileSelect(input) {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        showWizardMsg('error', 'File is too large. Maximum size is 10MB.');
        input.value = '';
        return;
    }
    selectedFiles = [{ file, label: '' }];
    renderSelectedFiles();
}

function removeSelectedFile(index) {
    selectedFiles.splice(index, 1);
    renderSelectedFiles();
    if (submissionMode === 'single') {
        const singleInput = document.getElementById('file-permit-single');
        if (singleInput) singleInput.value = '';
    }
}

function updateFileLabel(index, value) {
    if (selectedFiles[index]) selectedFiles[index].label = value;
}

function renderSelectedFiles() {
    const container = document.getElementById('selected-files-list');
    if (!container) return;

    if (selectedFiles.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    container.innerHTML = selectedFiles.map((entry, i) => `
        <div class="selected-file-row">
            <i class="fa-solid fa-file-check" style="color:#16a34a;"></i>
            <div class="selected-file-info">
                <div class="selected-file-name">${escHtml(entry.file.name)}</div>
                <div class="selected-file-size">${(entry.file.size / 1024).toFixed(1)} KB</div>
            </div>
            ${submissionMode === 'multiple' ? `
                <input type="text" class="selected-file-label-input" placeholder="Label (e.g. Board Resolution)"
                    value="${escHtml(entry.label)}" oninput="updateFileLabel(${i}, this.value)">
            ` : ''}
            <button class="btn btn-outline selected-file-remove" onclick="removeSelectedFile(${i})" title="Remove">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `).join('');
}

// ── Wizard navigation ────────────────────────────────────────────────────────────
function wizardGoTo(step) {
    [1,2,3,4].forEach(n => {
        document.getElementById(`wpanel-${n}`)?.classList.toggle('active', n === step);
        const s = document.getElementById(`wstep-${n}`);
        if (s) s.className = n < step ? 'wstep done' : n === step ? 'wstep active' : 'wstep inactive';
    });
    const msgEl = document.getElementById('wizardMsg');
    if (msgEl) msgEl.style.display = 'none';
}

function wizardNext(fromStep) {
    if (fromStep === 1) {
        const required = [
            ['w-school-name',     'School name is required.'],
            ['w-school-address',  'School address is required.'],
            ['w-course',          'Course / program is required.'],
            ['w-curriculum-year', 'Curriculum year is required.'],
            ['w-app-type',        'Please select an application type.'],
            ['w-school-year',     'Please select a school year.'],
        ];
        for (const [id, msg] of required) {
            const el = document.getElementById(id);
            if (!el?.value.trim()) { showWizardMsg('error', msg); return; }
        }
        buildChecklist();
        wizardGoTo(2);
    } else if (fromStep === 2) {
        const total   = document.querySelectorAll('.gpr3-check').length;
        const checked = document.querySelectorAll('.gpr3-check:checked').length;
        if (total > 0 && checked === 0) {
            showWizardMsg('error', 'Please check at least one requirement before proceeding.');
            return;
        }
        wizardGoTo(3);
    } else if (fromStep === 3) {
        if (selectedFiles.length === 0) {
            showWizardMsg('error', submissionMode === 'single'
                ? 'Please select your combined file to upload.'
                : 'Please select at least one file to upload.');
            return;
        }
        buildReviewSummary();
        wizardGoTo(4);
    }
}

function wizardBack(fromStep) { wizardGoTo(fromStep - 1); }

function showWizardMsg(type, html) {
    const el = document.getElementById('wizardMsg');
    if (!el) return;
    el.className     = type;
    el.innerHTML     = html;
    el.style.display = 'block';
    if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// ── Review summary ──────────────────────────────────────────────────────────────
function buildReviewSummary() {
    const schoolName  = document.getElementById('w-school-name')?.value   || '—';
    const address     = document.getElementById('w-school-address')?.value || '—';
    const course      = document.getElementById('w-course')?.value          || '—';
    const currYear    = document.getElementById('w-curriculum-year')?.value || '—';
    const appTypeEl   = document.getElementById('w-app-type');
    const appType     = appTypeEl?.options[appTypeEl.selectedIndex]?.text   || '—';
    const schoolYear  = document.getElementById('w-school-year')?.value     || '—';
    const govAuth     = document.getElementById('w-gov-authority')?.value   || '—';
    const checkData   = getChecklistData();
    const total       = Object.keys(checkData).length;
    const ready       = Object.values(checkData).filter(Boolean).length;
    const missing     = total - ready;

    const container = document.getElementById('review-summary');
    if (!container) return;

    const filesList = selectedFiles.map(entry => `
        <div class="review-file-row">
            <i class="fa-solid fa-file"></i>
            <span>${escHtml(entry.file.name)}</span>
            ${entry.label ? `<span class="review-file-label-tag">${escHtml(entry.label)}</span>` : ''}
            <span class="review-file-size">${(entry.file.size/1024).toFixed(1)} KB</span>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="review-row"><span class="review-key">School Name</span><span class="review-val">${escHtml(schoolName)}</span></div>
        <div class="review-row"><span class="review-key">Address</span><span class="review-val">${escHtml(address)}</span></div>
        <div class="review-row"><span class="review-key">Course / Program</span><span class="review-val">${escHtml(course)}</span></div>
        <div class="review-row"><span class="review-key">Curriculum Year(s)</span><span class="review-val">${escHtml(currYear)}</span></div>
        <div class="review-row"><span class="review-key">Application Type</span><span class="review-val">${escHtml(appType)}</span></div>
        <div class="review-row"><span class="review-key">School Year</span><span class="review-val">${escHtml(schoolYear)}</span></div>
        <div class="review-row"><span class="review-key">Gov. Authority Granted</span><span class="review-val">${escHtml(govAuth)}</span></div>
        <div class="review-row">
            <span class="review-key">Checklist</span>
            <span class="review-val">
                <span style="color:#16a34a;font-weight:700;">${ready} ready</span>
                ${missing > 0 ? `<span style="color:#d97706;font-weight:600;margin-left:8px;">${missing} not yet prepared</span>` : ''}
            </span>
        </div>
        <div class="review-row">
            <span class="review-key">${submissionMode === 'single' ? 'Combined File' : `Files (${selectedFiles.length})`}</span>
            <span class="review-val"><div class="review-files-list">${filesList}</div></span>
        </div>
    `;
}

// ── Final submit ─────────────────────────────────────────────────────────────────
async function submitPermitWizard() {
    if (selectedFiles.length === 0) { showWizardMsg('error', 'No file selected.'); return; }
    const schoolYear = document.getElementById('w-school-year')?.value || '';
    if (!schoolYear) { showWizardMsg('error', 'School year is missing.'); return; }

    const btn = document.getElementById('submitPermitBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…'; }
    showWizardMsg('info', '<i class="fa-solid fa-spinner fa-spin"></i> Submitting your permit application…');

    const appTypeEl   = document.getElementById('w-app-type');
    const appTypeText = appTypeEl?.options[appTypeEl.selectedIndex]?.text || '';

    const metadata = {
        school_name:     document.getElementById('w-school-name')?.value   || '',
        address:         document.getElementById('w-school-address')?.value || '',
        course:          document.getElementById('w-course')?.value          || '',
        curriculum_year: document.getElementById('w-curriculum-year')?.value || '',
        app_type:        appTypeEl?.value || '',
        app_type_label:  appTypeText,
        gov_authority:   document.getElementById('w-gov-authority')?.value  || '',
        checklist:       getChecklistData(),
    };

    const fd = new FormData();
    if (submissionMode === 'single') {
        fd.append('file', selectedFiles[0].file);
    } else {
        selectedFiles.forEach(entry => fd.append('files[]', entry.file));
        fd.append('file_labels', JSON.stringify(selectedFiles.map(e => e.label || '')));
    }
    fd.append('school_year', schoolYear);
    fd.append('permit_meta', JSON.stringify(metadata));

    try {
        const res  = await fetch(`${PERMIT_API}?action=upload`, {
            method: 'POST', credentials: 'include', body: fd,
        });
        const data = await res.json();

        if (!data.success) {
            showWizardMsg('error', data.message || 'Submission failed. Please try again.');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
            return;
        }

        showWizardMsg('success', '<i class="fa-solid fa-check-circle"></i> School Permit application submitted successfully!');
        setTimeout(() => {
            resetWizard();
            showAppsView();
            loadApplications();
        }, 1800);

    } catch {
        showWizardMsg('error', 'Connection error. Please check your internet and try again.');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
    }
}

function resetWizard() {
    editingBatchId = null;
    selectedFiles  = [];
    submissionMode = 'multiple';
    ['w-school-name','w-school-address','w-course','w-curriculum-year','w-gov-authority'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const appTypeEl = document.getElementById('w-app-type');
    if (appTypeEl) appTypeEl.value = '';
    const existingBox = document.getElementById('existingFilesBox');
    if (existingBox) { existingBox.innerHTML = ''; existingBox.classList.add('hidden'); }
    renderSelectedFiles();
    setSubmissionMode('multiple');
    wizardGoTo(1);
    const submitBtn = document.getElementById('submitPermitBtn');
    if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO';
}

// ── View switching: applications list ↔ wizard ──────────────────────────────────
function showAppsView() {
    document.getElementById('appsView')?.classList.add('active');
    document.getElementById('wizardView')?.classList.remove('active');
}

async function showWizardView() {
    document.getElementById('appsView')?.classList.remove('active');
    document.getElementById('wizardView')?.classList.add('active');
    if (!editingBatchId) {
        resetWizard();
        await autoFillFromDashboard();
        populateSchoolYears('w-school-year');
    }
}

async function autoFillFromDashboard() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.data) {
            const school = data.data.school || {};
            const nameEl = document.getElementById('w-school-name');
            if (nameEl && school.name) nameEl.value = school.name;

            const addrEl    = document.getElementById('w-school-address');
            const addrParts = [school.street_address, school.barangay, school.city].filter(p => p && String(p).trim());
            if (addrEl && addrParts.length) addrEl.value = addrParts.join(', ');

            const courseEl = document.getElementById('w-course');
            const levels   = parseLevels(school.levels || school.grade);
            if (courseEl && levels.length) courseEl.value = levels.map(l => LEVEL_LABELS[l] || l).join(', ');

            const currEl = document.getElementById('w-curriculum-year');
            if (currEl && levels.length) currEl.value = levels.map(l => LEVEL_CURRICULUM[l] || l).join('; ');

            const appTypeEl = document.getElementById('w-app-type');
            if (appTypeEl) appTypeEl.value = 'recognition';
        }
    } catch { /* Non-fatal — user can fill manually */ }
}

// ── My Permit Applications: load + render ───────────────────────────────────────
async function loadApplications() {
    const content = document.getElementById('appsContent');
    if (content) content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading your applications…</p></div>`;
    try {
        const res  = await fetch(PERMIT_API, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message || 'Failed to load applications.');
        }
        allApplications = Array.isArray(data.data?.applications) ? data.data.applications : [];
        const remoteChecklist = data.data?.checklist_definition;
        if (Array.isArray(remoteChecklist) && remoteChecklist.length) {
            GPR3_CHECKLIST = remoteChecklist;
            if (document.getElementById('wizardView')?.classList.contains('active')) buildChecklist();
        }
        renderApplications();
        syncCreateNewButtonState();
    } catch (err) {
        if (content) content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${escHtml(err.message || 'Could not load applications.')}</p></div>`;
    } finally {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function handleAppsSearch(value) {
    appsSearchTerm = (value || '').toLowerCase().trim();
    renderApplications();
}

function filterApps(status) {
    appsStatusFilter = status;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`f-${status}`)?.classList.add('active');
    renderApplications();
}

function appStatusMeta(status) {
    switch (status) {
        case 'approved':  return { css: 'badge-approved',  label: '<i class="fa-solid fa-circle-check"></i> Approved' };
        case 'endorsed':  return { css: 'badge-endorsed',  label: '<i class="fa-solid fa-share"></i> Endorsed' };
        case 'review':    return { css: 'badge-review',    label: '<i class="fa-solid fa-hourglass-half"></i> Under Review' };
        case 'rejected':  return { css: 'badge-rejected',  label: '<i class="fa-solid fa-circle-xmark"></i> Rejected' };
        case 'returned':  return { css: 'badge-returned',  label: '<i class="fa-solid fa-rotate-left"></i> Returned' };
        default:          return { css: 'badge-pending',   label: '<i class="fa-solid fa-clock"></i> Pending' };
    }
}

function renderApplications() {
    const content = document.getElementById('appsContent');
    if (!content) return;

    let apps = allApplications;
    if (appsStatusFilter !== 'all') apps = apps.filter(a => a.status === appsStatusFilter);
    if (appsSearchTerm) {
        apps = apps.filter(a =>
            (a.school_name || '').toLowerCase().includes(appsSearchTerm) ||
            (a.app_type_label || '').toLowerCase().includes(appsSearchTerm) ||
            (a.school_year || '').toLowerCase().includes(appsSearchTerm)
        );
    }

    if (apps.length === 0) {
        content.innerHTML = `<div class="saved-docs-empty">
            <i class="fa-solid fa-file-shield"></i>
            <p>${allApplications.length === 0 ? 'No permit applications yet. Click "New Permit Application" to get started.' : 'No applications match your search/filter.'}</p>
        </div>`;
        return;
    }

    content.innerHTML = `<div class="saved-docs-list">${apps.map(app => {
        const meta = appStatusMeta(app.status);
        const canEdit   = ['pending', 'review', 'returned'].includes(app.status);
        const fileCount = app.files.length;
        const modeLabel = app.submission_mode === 'single' ? 'Combined file' : `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

        return `
            <div class="sdc-enhanced">
                <div class="sdc-header">
                    <div class="sdc-logo-placeholder"><i class="fa-solid fa-file-shield"></i></div>
                    <div class="sdc-title-block">
                        <div class="sdc-title">${escHtml(app.school_name || 'School Permit Application')}</div>
                        <div class="sdc-meta">
                            ${escHtml(app.app_type_label || 'Permit Application')} ${app.school_year ? '· ' + escHtml(app.school_year) : ''} · ${modeLabel}
                        </div>
                    </div>
                    <span class="status-badge ${meta.css}">${meta.label}</span>
                </div>

                <div class="permit-files-row">
                    ${app.files.map(f => `
                        <a class="permit-file-chip" href="${API_BASE}/school-portal-permit-view.php?id=${f.id}" target="_blank" rel="noopener" title="${escHtml(f.file_name)}">
                            <i class="fa-solid fa-file-lines"></i>
                            <span>${escHtml(f.requirement_label || f.file_name)}</span>
                        </a>
                    `).join('')}
                </div>

                ${app.remarks ? `<div class="permit-remarks"><i class="fa-solid fa-comment-dots"></i> ${escHtml(app.remarks)}</div>` : ''}

                <div class="sdc-actions">
                    <span class="sub-date"><i class="fa-regular fa-clock"></i> Submitted ${formatDate(app.submitted_at)}</span>
                    <div style="margin-left:auto;display:flex;gap:8px;">
                        ${canEdit ? `
                            <button class="btn btn-outline" style="padding:6px 12px;font-size:12px;" onclick="openManageModal('${app.batch_id}')">
                                <i class="fa-solid fa-pen"></i> Manage
                            </button>
                            <button class="btn" style="padding:6px 12px;font-size:12px;background:#fef2f2;color:#dc2626;" onclick="openDeleteApp('${app.batch_id}', '${escHtml(app.school_name || 'this application')}')">
                                <i class="fa-solid fa-trash"></i> Delete
                            </button>
                        ` : `
                            <span style="font-size:12px;color:#9ca3af;">Locked — already ${escHtml(app.status)}</span>
                        `}
                    </div>
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

function syncCreateNewButtonState() {
    const btn = document.getElementById('btnNewApplication');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; }
}

// ── Manage Application modal ────────────────────────────────────────────────────
let manageBatchId      = null;
let manageNewFiles      = []; // [{file, label}] — new files queued to add on Save

function buildManageChecklist(appType, selected = {}) {
    const container = document.getElementById('m-gpr3-checklist');
    if (!container) return;

    container.innerHTML = GPR3_CHECKLIST.map(group => {
        const show = group.always || (appType && group.appTypes?.includes(appType));
        if (!show) return '';
        const items = group.items.map(item => `
            <label class="checklist-item">
                <input type="checkbox" class="m-gpr3-check" id="m-chk-${item.id}" value="${item.id}" ${selected[item.id] ? 'checked' : ''}>
                <span class="checklist-label">${item.label}</span>
            </label>
        `).join('');
        return `
            <div class="checklist-group">
                <div class="checklist-group-title">${group.section}</div>
                ${items}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.m-gpr3-check').forEach(cb => cb.addEventListener('change', updateManageChecklistProgress));
    updateManageChecklistProgress();
}

function updateManageChecklistProgress() {
    const total   = document.querySelectorAll('.m-gpr3-check').length;
    const checked = document.querySelectorAll('.m-gpr3-check:checked').length;
    const el      = document.getElementById('m-checklist-progress');
    if (el) {
        el.innerHTML = total
            ? `<span style="color:${checked === total ? '#16a34a' : '#d97706'};font-weight:700;">${checked}/${total}</span> ready`
            : '';
    }
}

function getManageChecklistData() {
    const result = {};
    document.querySelectorAll('.m-gpr3-check').forEach(cb => { result[cb.value] = cb.checked; });
    return result;
}

function renderManageExistingFiles(app) {
    const box = document.getElementById('manageExistingFiles');
    if (!box) return;
    if (!app.files.length) {
        box.innerHTML = `<p style="font-size:12px;color:#9ca3af;margin:0;">No files on this application yet.</p>`;
        return;
    }
    box.innerHTML = app.files.map(f => `
        <div class="existing-file-row">
            <i class="fa-solid fa-file-circle-check" style="color:#2456a4;"></i>
            <a href="${API_BASE}/school-portal-permit-view.php?id=${f.id}" target="_blank" rel="noopener">${escHtml(f.file_name)}</a>
            ${f.requirement_label ? `<span class="review-file-label-tag">${escHtml(f.requirement_label)}</span>` : ''}
            <button class="btn btn-outline" style="margin-left:auto;padding:3px 9px;font-size:11px;" onclick="deleteExistingFile(${f.id})">
                <i class="fa-solid fa-xmark"></i> Remove
            </button>
        </div>
    `).join('');
}

function renderManageNewFiles() {
    const container = document.getElementById('manageNewFilesList');
    if (!container) return;
    if (manageNewFiles.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    container.innerHTML = manageNewFiles.map((entry, i) => `
        <div class="selected-file-row">
            <i class="fa-solid fa-file-circle-plus" style="color:#2456a4;"></i>
            <div class="selected-file-info">
                <div class="selected-file-name">${escHtml(entry.file.name)}</div>
                <div class="selected-file-size">${(entry.file.size / 1024).toFixed(1)} KB · will be added on save</div>
            </div>
            <input type="text" class="selected-file-label-input" placeholder="Label (optional)"
                value="${escHtml(entry.label)}" oninput="manageNewFiles[${i}].label = this.value">
            <button class="btn btn-outline selected-file-remove" onclick="removeManageNewFile(${i})" title="Remove">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `).join('');
}

function handleManageAddFiles(input) {
    const files = Array.from(input.files || []);
    for (const file of files) {
        if (file.size > 10 * 1024 * 1024) {
            showManageMsg('error', `"${file.name}" is too large. Maximum size is 10MB per file.`);
            continue;
        }
        manageNewFiles.push({ file, label: '' });
    }
    input.value = '';
    renderManageNewFiles();
}

function removeManageNewFile(index) {
    manageNewFiles.splice(index, 1);
    renderManageNewFiles();
}

function showManageMsg(type, html) {
    const el = document.getElementById('manageMsg');
    if (!el) return;
    el.className     = type;
    el.innerHTML     = html;
    el.style.display = 'block';
    if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function openManageModal(batchId) {
    const app = allApplications.find(a => a.batch_id === batchId);
    if (!app) return;

    manageBatchId  = batchId;
    manageNewFiles = [];

    const remarksBanner = document.getElementById('manageRemarksBanner');
    if (remarksBanner) {
        if (app.status === 'returned' && app.remarks) {
            remarksBanner.classList.remove('hidden');
            remarksBanner.innerHTML = `
                <div class="permit-remarks" style="margin:0;">
                    <i class="fa-solid fa-circle-exclamation"></i>
                    <div>
                        <strong>Returned for correction:</strong> ${escHtml(app.remarks)}
                        <div style="font-size:11px;color:#92400e;margin-top:2px;">Make the needed changes below, then save to resubmit for review.</div>
                    </div>
                </div>
            `;
        } else {
            remarksBanner.classList.add('hidden');
            remarksBanner.innerHTML = '';
        }
    }

    document.getElementById('m-school-name').value     = app.school_name || '';
    document.getElementById('m-school-address').value  = app.address || '';
    document.getElementById('m-course').value           = app.course || '';
    document.getElementById('m-curriculum-year').value  = app.curriculum_year || '';
    document.getElementById('m-app-type').value         = app.app_type || '';
    document.getElementById('m-gov-authority').value    = app.gov_authority || '';
    populateSchoolYears('m-school-year', app.school_year || '');

    buildManageChecklist(app.app_type, app.checklist || {});

    const appTypeSelect = document.getElementById('m-app-type');
    if (appTypeSelect) {
        appTypeSelect.onchange = () => {
            const current = { ...(app.checklist || {}), ...getManageChecklistData() };
            buildManageChecklist(appTypeSelect.value, current);
        };
    }

    renderManageExistingFiles(app);
    renderManageNewFiles();

    const msg = document.getElementById('manageMsg');
    if (msg) msg.style.display = 'none';
    const saveBtn = document.getElementById('manageSaveBtn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }

    document.getElementById('manageModalOverlay')?.classList.add('open');
}

function closeManageModal(event) {
    if (event && event.target.id !== 'manageModalOverlay') return;
    document.getElementById('manageModalOverlay')?.classList.remove('open');
    manageBatchId  = null;
    manageNewFiles = [];
}

async function saveManageModal() {
    if (!manageBatchId) return;

    const schoolName = document.getElementById('m-school-name').value.trim();
    const address     = document.getElementById('m-school-address').value.trim();
    const course      = document.getElementById('m-course').value.trim();
    const currYear    = document.getElementById('m-curriculum-year').value.trim();
    const appTypeEl   = document.getElementById('m-app-type');
    const appType     = appTypeEl.value.trim();
    const appTypeLabel = appTypeEl.options[appTypeEl.selectedIndex]?.text || '';
    const schoolYear  = document.getElementById('m-school-year').value.trim();
    const govAuth     = document.getElementById('m-gov-authority').value.trim();

    if (!schoolName || !address || !course || !currYear || !appType || !schoolYear) {
        showManageMsg('error', 'Please complete all required fields before saving.');
        return;
    }

    const saveBtn = document.getElementById('manageSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
    showManageMsg('info', '<i class="fa-solid fa-spinner fa-spin"></i> Saving changes…');

    const metadata = {
        school_name: schoolName,
        address,
        course,
        curriculum_year: currYear,
        app_type: appType,
        app_type_label: appTypeLabel,
        gov_authority: govAuth,
        checklist: getManageChecklistData(),
    };

    const fd = new FormData();
    fd.append('batch_id', manageBatchId);
    fd.append('school_year', schoolYear);
    fd.append('permit_meta', JSON.stringify(metadata));
    if (manageNewFiles.length > 0) {
        manageNewFiles.forEach(entry => fd.append('files[]', entry.file));
        fd.append('file_labels', JSON.stringify(manageNewFiles.map(e => e.label || '')));
    }

    try {
        const res  = await fetch(`${PERMIT_API}?action=edit`, { method: 'POST', credentials: 'include', body: fd });
        const data = await res.json();

        if (!data.success) {
            showManageMsg('error', data.message || 'Failed to save changes.');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }
            return;
        }

        showManageMsg('success', '<i class="fa-solid fa-check-circle"></i> Changes saved successfully!');
        await loadApplications();
        setTimeout(() => { closeManageModal(); }, 900);

    } catch {
        showManageMsg('error', 'Connection error. Please try again.');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; }
    }
}

async function deleteExistingFile(fileId) {
    if (!confirm('Remove this file from the application?')) return;
    try {
        const res  = await fetch(`${PERMIT_API}?action=delete_file`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: fileId }),
        });
        const data = await res.json();
        if (!data.success) { alert(data.message || 'Failed to remove file.'); return; }
        await loadApplications();
        if (manageBatchId) openManageModal(manageBatchId); // Re-render modal with the refreshed file list
    } catch {
        alert('Connection error. Please try again.');
    }
}


// ── Delete an entire application ────────────────────────────────────────────────
let deletingBatchId = null;

function openDeleteApp(batchId, title) {
    deletingBatchId = batchId;
    const titleEl = document.getElementById('deleteAppTitle');
    if (titleEl) titleEl.textContent = title;
    document.getElementById('deleteModalOverlay')?.classList.add('open');
}

function closeDeleteModal(event) {
    if (event && event.target.id !== 'deleteModalOverlay') return;
    document.getElementById('deleteModalOverlay')?.classList.remove('open');
    deletingBatchId = null;
}

async function confirmDeleteApp() {
    if (!deletingBatchId) return;
    try {
        const res  = await fetch(`${PERMIT_API}?action=delete`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch_id: deletingBatchId }),
        });
        const data = await res.json();
        if (!data.success) { alert(data.message || 'Failed to delete application.'); return; }
        closeDeleteModal();
        loadApplications();
    } catch {
        alert('Connection error. Please try again.');
    }
}

// ── Logout / sidebar (shared boilerplate) ───────────────────────────────────────
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    [
        'edu_user_id','edu_email','edu_full_name','edu_role','edu_school_approved','edu_account_type',
        'edu_school_name','edu_district_id','edu_school_id','edu_grade',
        'edu_school_id_no','edu_district_name','edu_school_address','edu_profile_picture',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const manage = document.getElementById('manageModalOverlay');
    if (manage && manage.classList.contains('open')) { closeManageModal(); return; }
    const del = document.getElementById('deleteModalOverlay');
    if (del && del.classList.contains('open')) closeDeleteModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────────
initUI();
Promise.all([loadDashboard(), loadApplications()]);

window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.href = 'school-portal.html'; })
            .catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' })
            .then(r => { if (r.status === 401) window.location.href = 'school-portal.html'; })
            .catch(() => {});
    }
});
