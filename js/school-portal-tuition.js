/* ═══════════════════════════════════════════════════════════════
   QATALYST — SCHOOL TUITION FEE BUILDER
   ═══════════════════════════════════════════════════════════════ */

const API_BASE = (typeof CONFIG !== 'undefined') ? CONFIG.API_URL : '/api';
const TF_API   = `${API_BASE}/school-portal-tuition.php`;

/* ── State ── */
let tfMode          = null;   // 'increase' | 'no-increase'
let currentStep     = 1;
let currentLevel    = 'kinder';
let docId           = null;
let saveTimer       = null;
let pctComputeTimer = null;
let logoDataUrl     = '';
let _builderLocked  = false;  // true when a submitted doc is open (mirrors calendar)

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
const $    = id  => document.getElementById(id);
const val  = id  => $(id)?.value ?? '';
const num  = id  => parseFloat($(id)?.value) || 0;
const r2   = n   => Math.round(n * 100) / 100;
const setV = (id, v) => { const el = $(id); if (el) el.value = v !== '' ? r2(v) : ''; };
const getPct = () => parseFloat(val('tfIncreasePct')) || 0;
const DEFAULT_PRINCIPAL_POSITION = 'School Principal';
const DEFAULT_REVIEWED_BY_POSITION = 'SDO, EPS In Charge';
const DEFAULT_VALIDATED_BY_POSITION = 'EPS,QAD DepEd RO 3';
const DEFAULT_NOTED_BY_NAME = 'MAY B. ECLAR, PhD, CESO III';
const DEFAULT_NOTED_BY_POSITION = 'Regional Director';
const DEFAULT_SHS_NOTED_BY_NAME     = 'ROWENA T. QUIAMBAO, CESO VI';
const DEFAULT_SHS_NOTED_BY_POSITION = 'Schools Division Superintendent';
const DEFAULT_SHS_NOTED_BY_OFFICE   = 'Office of the Schools Division Superintendent';

function getPrincipalPosition() {
    return val('tfPrincipalPosition').trim() || DEFAULT_PRINCIPAL_POSITION;
}

function getReviewedByPosition() {
    return val('tfReviewedByPosition').trim() || DEFAULT_REVIEWED_BY_POSITION;
}

function getValidatedByPosition() {
    return val('tfValidatedByPosition').trim() || DEFAULT_VALIDATED_BY_POSITION;
}

function getNotedByName() {
    return val('tfNotedBy').trim() || DEFAULT_NOTED_BY_NAME;
}

function getNotedByPosition() {
    return val('tfNotedByPosition').trim() || DEFAULT_NOTED_BY_POSITION;
}

function getSHSNotedByName() {
    return val('tfSHSNotedBy').trim() || DEFAULT_SHS_NOTED_BY_NAME;
}

function getSHSNotedByPosition() {
    return val('tfSHSNotedByPosition').trim() || DEFAULT_SHS_NOTED_BY_POSITION;
}

function getSHSNotedByOffice() {
    return val('tfSHSNotedByOffice').trim() || DEFAULT_SHS_NOTED_BY_OFFICE;
}

function showToast(msg, icon = 'circle-check') {
    const t = getGlobalToastElement();
    t.innerHTML = `<i class="fa-solid fa-${icon}"></i> ${msg}`;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

function fmt(n) {
    return (n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setSaveStatus(status, text) {
    const el = $('tfAutosave2');
    if (!el) return;
    el.className = 'autosave-status ' + status;
    const span = el.querySelector('span');
    if (span) span.textContent = text;
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function getInitials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
}

function normalizeDeptValue(value) {
    if (!value) return '';
    const v = String(value).trim().toLowerCase();
    if (v === 'kinder' || v === 'kindergarten' || v === 'k') return 'Kindergarten';
    if (
        v === 'jhs' || v === 'junior high' || v === 'junior high school' ||
        v.startsWith('grade 7') || v.startsWith('grade 8') ||
        v.startsWith('grade 9') || v.startsWith('grade 10') ||
        v === 'g7' || v === 'g8' || v === 'g9' || v === 'g10'
    ) return 'Junior High School';
    if (
        v === 'shs' || v === 'senior high' || v === 'senior high school' ||
        v.startsWith('grade 11') || v.startsWith('grade 12') ||
        v === 'g11' || v === 'g12'
    ) return 'Senior High School';
    if (v === 'elementary' || v === 'elem' || v === 'primary') return 'Elementary';
    return value.trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function escHtml(v) {
    return String(v || '').replace(/[&<>'"]/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
}

function setPortalAvatars(profilePicture, fullNameValue) {
    const sidebarAvatar = $('sidebarAvatar');
    const fallback = getInitials(fullNameValue);
    if (!sidebarAvatar) return;
    if (profilePicture) {
        sidebarAvatar.innerHTML = `<img src="${profilePicture}" alt="Profile photo">`;
    } else {
        sidebarAvatar.textContent = fallback;
    }
}

/* ── Mobile sidebar ── */
function toggleSidebar() {
    const open = $('sidebar').classList.toggle('mobile-open');
    $('sidebarBackdrop').classList.toggle('open');
    document.body.style.overflow = open ? 'hidden' : '';
}
function closeSidebar() {
    $('sidebar').classList.remove('mobile-open');
    $('sidebarBackdrop').classList.remove('open');
    document.body.style.overflow = '';
}

/* ── Logout ── */
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    ['edu_user_id','edu_email','edu_full_name','edu_role','edu_school_approved','edu_account_type',
     'edu_school_name','edu_district_id','edu_school_id','edu_private_school_id','edu_grade',
     'edu_school_id_no','edu_deped_id','edu_district_name','edu_school_address','edu_school_logo','edu_school_type',
     'edu_elem_principal','edu_elem_contact','edu_jhs_principal','edu_jhs_contact',
     'edu_shs_principal','edu_shs_contact','edu_registrar_name','edu_registrar_contact'].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

/* ── Session guard ── */
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

/* ── Global toast ── */
function getGlobalToastElement() {
    let el = $('globalToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'globalToast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    return el;
}

/* ══════════════════════════════════════════════
   PRE-FILL TUITION FORM FROM SESSION
══════════════════════════════════════════════ */
function prefillTuitionFormFromSession() {
    const schoolName   = localStorage.getItem('edu_school_name')    || '';
    const district     = localStorage.getItem('edu_district_name')  || '';
    const address      = localStorage.getItem('edu_school_address') || '';
    // School ID: prefer deped_id (school_id_no from private_schools), fall back to school_id_no
    const schoolIdNo   = localStorage.getItem('edu_deped_id')       ||
                         localStorage.getItem('edu_school_id_no')   || '';

    const fill = (id, value) => {
        const el = $(id);
        if (el && !el.value.trim() && value && value !== '—') el.value = value;
    };

    fill('tfSchoolName', schoolName);
    fill('tfDivision',   district);
    fill('tfAddress',    address);
    fill('tfSchoolId',   schoolIdNo);

    // ── Principal: pick based on checked levels, fall back down the chain ──
    const hasElem = $('chkElem')?.checked;
    const hasJHS  = $('chkJHS')?.checked;
    const hasSHS  = $('chkSHS')?.checked;

    const elemPrincipal = localStorage.getItem('edu_elem_principal')    || '';
    const elemContact   = localStorage.getItem('edu_elem_contact')      || '';
    const jhsPrincipal  = localStorage.getItem('edu_jhs_principal')     || '';
    const jhsContact    = localStorage.getItem('edu_jhs_contact')       || '';
    const shsPrincipal  = localStorage.getItem('edu_shs_principal')     || '';
    const shsContact    = localStorage.getItem('edu_shs_contact')       || '';
    const regName       = localStorage.getItem('edu_registrar_name')    || '';
    const regContact    = localStorage.getItem('edu_registrar_contact') || '';

    // Priority: elem → jhs → shs → registrar (first non-empty wins)
    const principalCandidates = [
        hasElem ? [elemPrincipal, elemContact] : null,
        hasJHS  ? [jhsPrincipal,  jhsContact]  : null,
        hasSHS  ? [shsPrincipal,  shsContact]  : null,
        [elemPrincipal, elemContact],
        [jhsPrincipal,  jhsContact],
        [shsPrincipal,  shsContact],
        [regName,       regContact],
    ].filter(Boolean).find(([name]) => name.trim());

    if (principalCandidates) {
        fill('tfPrincipal',        principalCandidates[0]);
        fill('tfPrincipalContact', principalCandidates[1]);
    }

    // ── Auto-suggest school years based on current date ──
    // SY runs June–March; if current month is June or later, current SY started this year
    const now       = new Date();
    const yr        = now.getFullYear();
    const month     = now.getMonth() + 1; // 1-indexed
    const syStart   = month >= 6 ? yr : yr - 1;
    const currentSY  = `${syStart}-${syStart + 1}`;
    const proposedSY = `${syStart + 1}-${syStart + 2}`;

    fill('tfCurrentSY',  currentSY);
    fill('tfProposedSY', proposedSY);
}

/* ══════════════════════════════════════════════
   SIDEBAR / PROFILE INIT
══════════════════════════════════════════════ */
function initSidebarProfile() {
    const fullName       = localStorage.getItem('edu_full_name')      || 'Portal User';
    const role           = localStorage.getItem('edu_role')            || 'teacher';
    const profilePicture = localStorage.getItem('edu_profile_picture') || '';
    const schoolName     = localStorage.getItem('edu_school_name')     || '—';
    const schoolLevel    = localStorage.getItem('edu_grade')           || '';
    const district       = localStorage.getItem('edu_district_name')   || '—';
    const schoolAddress  = localStorage.getItem('edu_school_address')  || '';
    const sidebarLine    = schoolAddress || district;

    const nameEl     = $('sidebarName');
    const roleEl     = $('sidebarRole');
    const schoolEl   = $('sidebarSchoolName') || document.querySelector('.school-pill-name');
    const districtEl = $('sidebarDistrict')   || document.querySelector('.school-pill-dist');

    setPortalAvatars(profilePicture, fullName);
    if (nameEl)     nameEl.textContent     = fullName;
    if (roleEl)     roleEl.textContent     = role;
    if (schoolEl)   schoolEl.textContent   = schoolName;
    if (districtEl) districtEl.textContent = sidebarLine;
    const topBarSub = $('tfTopBarSchoolName');
    if (topBarSub) topBarSub.textContent = schoolName !== '—' ? schoolName : '';

    const schoolInput = $('f_school');
    if (schoolInput && !schoolInput.value.trim() && schoolName !== '—') schoolInput.value = schoolName;
    const schoolIdNo  = localStorage.getItem('edu_school_id_no') || '';
    const schoolIdInput = $('f_sid');
    if (schoolIdInput && !schoolIdInput.value.trim() && schoolIdNo) schoolIdInput.value = schoolIdNo;

    applyDeptSelection(schoolLevel);

    if (!logoDataUrl) {
        const savedLogo = localStorage.getItem('edu_school_logo') || '';
        if (savedLogo) { logoDataUrl = savedLogo; applyCalendarLogo(logoDataUrl); }
    }
}

function applyDeptSelection(value) {
    const deptSelect = $('f_dept');
    if (!deptSelect) return;
    const target = normalizeDeptValue(value);
    if (!target) return;
    const hasOption = Array.from(deptSelect.options).some(opt => opt.value === target);
    if (!hasOption) {
        const custom = document.createElement('option');
        custom.value = target;
        custom.textContent = target;
        deptSelect.appendChild(custom);
    }
    deptSelect.value = target;
}

function applyCalendarLogo(dataUrl) {
    // Update the tuition logo upload area preview (tfLogoPreview/tfLogoIcon)
    const tfPreview = $('tfLogoPreview');
    const tfIcon    = $('tfLogoIcon');
    const preview   = $('logoPreview');
    const icon      = $('logoIcon');
    if (!dataUrl) {
        if (tfPreview) tfPreview.style.display = 'none';
        if (tfIcon)    tfIcon.style.display    = 'block';
        if (preview)   preview.style.display   = 'none';
        if (icon)      icon.style.display      = 'block';
        for (let i = 1; i <= 10; i++) {
            const img = $('lhLogo' + i);
            const ph  = $('lhLogoPlaceholder' + i);
            if (img) img.style.display = 'none';
            if (ph)  ph.style.display  = 'flex';
        }
        return;
    }
    if (tfPreview) { tfPreview.src = dataUrl; tfPreview.style.display = 'block'; }
    if (tfIcon)    tfIcon.style.display = 'none';
    if (preview)   { preview.src = dataUrl; preview.style.display = 'block'; }
    if (icon)      icon.style.display = 'none';
    for (let i = 1; i <= 10; i++) {
        const img = $('lhLogo' + i);
        const ph  = $('lhLogoPlaceholder' + i);
        if (img) { img.src = dataUrl; img.style.display = 'block'; }
        if (ph)  ph.style.display = 'none';
    }
}

async function loadDashboard() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) {
            if (res.status === 401) window.location.href = 'school-portal.html';
            return;
        }
        const d = data.data;
        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }
        const addressParts = [d.school?.street_address, d.school?.barangay, d.school?.city].filter(Boolean);
        const schoolAddress = addressParts.join(', ');

        localStorage.setItem('edu_full_name',         d.user.full_name);
        localStorage.setItem('edu_role',              d.user.role || 'teacher');
        localStorage.setItem('edu_profile_picture',   d.user.profile_picture || '');
        localStorage.setItem('edu_school_name',       d.school?.name     || '');
        localStorage.setItem('edu_district_name',     d.school?.district || d.school?.city || '');
        localStorage.setItem('edu_account_type',      d.user.account_type                          || '');
        localStorage.setItem('edu_school_approved', d.user?.school_approved ? '1' : '0');
        localStorage.setItem('edu_school_id',         d.user.school_id         != null ? String(d.user.school_id)         : '');
        localStorage.setItem('edu_private_school_id', d.user.private_school_id != null ? String(d.user.private_school_id) : '');
        localStorage.setItem('edu_school_id_no',      d.school?.school_id_no   || '');
        localStorage.setItem('edu_deped_id',          d.school?.deped_id       || '');
        localStorage.setItem('edu_grade',             d.school?.grade          || '');
        localStorage.setItem('edu_school_address',    schoolAddress);
        localStorage.setItem('edu_school_logo',       d.school?.school_logo    || '');
        localStorage.setItem('edu_school_type',       d.user.school_type       || '');
        // Principal / contact per level (private schools)
        localStorage.setItem('edu_elem_principal',    d.school?.elem_principal    || '');
        localStorage.setItem('edu_elem_contact',      d.school?.elem_contact      || '');
        localStorage.setItem('edu_jhs_principal',     d.school?.jhs_principal     || '');
        localStorage.setItem('edu_jhs_contact',       d.school?.jhs_contact       || '');
        localStorage.setItem('edu_shs_principal',     d.school?.shs_principal     || '');
        localStorage.setItem('edu_shs_contact',       d.school?.shs_contact       || '');
        localStorage.setItem('edu_registrar_name',    d.school?.registrar_name    || '');
        localStorage.setItem('edu_registrar_contact', d.school?.registrar_contact || '');

        initSidebarProfile();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();
        prefillTuitionFormFromSession();

        const badge = $('pendingBadge');
        if (badge) {
            const pending = d.stats?.pending ?? 0;
            badge.textContent   = pending;
            badge.style.display = pending > 0 ? 'inline' : 'none';
        }
    } catch (err) {
        console.error('loadDashboard error:', err);
    }
}

/* ══════════════════════════════════════════════
   STEP NAVIGATION
══════════════════════════════════════════════ */
function goToStep(n) {
    // This page has two UIs:
    // - Legacy step-based sections (tfSectionStep1..4)
    // - Current workspace UI (tfFsCover/tfFsInfo/tfFsSchedule/tfFsReview) driven by tfSwitchPage()
    // The HTML in school-portal-tuition.html uses the workspace UI, so we route steps through tfSwitchPage
    // and avoid null dereferences when legacy IDs are absent.
    currentStep = n;

    const hasWorkspaceUi = !!document.getElementById('tfFsCover');
    if (hasWorkspaceUi && typeof tfSwitchPage === 'function') {
        const stepToPage = { 1: 'cover', 2: 'info', 3: 'breakdown', 4: 'review' };
        tfSwitchPage(stepToPage[n] || 'cover');
        return;
    }

    // Legacy step-section toggling (keep as fallback)
    ['tfSectionStep1','tfSectionStep2','tfSectionStep3','tfSectionStep4']
        .forEach((id, i) => {
            const sec = $(id);
            if (sec) sec.classList.toggle('tf-hidden', i + 1 !== n);
        });

    [1,2,3,4].forEach(i => {
        const el = $('tfStep' + i);
        if (!el) return;
        el.classList.remove('active','done');
        if (i === n) el.classList.add('active');
        if (i <  n) el.classList.add('done');
    });

    if (n === 3) applyModeToStep3();
    if (n === 4) buildReview();

    // Show Final Submit button in top bar only on step 4
    // (legacy fallback path — workspace UI uses tfSwitchPage)
}

/* ══════════════════════════════════════════════
   MODE SELECTION
══════════════════════════════════════════════ */
function selectMode(mode) {
    tfMode = mode;
    $('modeCardIncrease').classList.toggle('selected',   mode === 'increase');
    $('modeCardNoIncrease').classList.toggle('selected', mode === 'no-increase');
    $('btnStep1Next').disabled = false;
    applyPctFieldVisibility();
    scheduleSave();
}

/** FIX UX#3: Show/hide per-grade G11/G12 fee inputs (tuition + all misc/other
 *  items) and update SHS compute accordingly. */
function tfToggleSHSPerGrade() {
    const isPerGrade = document.getElementById('chkSHSPerGrade')?.checked;
    const pairs = [
        ['shsSharedRows',   'shsPerGradeRows'],
        ['shsMiscShared',   'shsMiscPerGrade'],
        ['shsOtherShared',  'shsOtherPerGrade'],
    ];
    pairs.forEach(([sharedId, perGradeId]) => {
        const sharedEl   = document.getElementById(sharedId);
        const perGradeEl = document.getElementById(perGradeId);
        if (sharedEl)   sharedEl.style.display   = isPerGrade ? 'none' : '';
        if (perGradeEl) perGradeEl.style.display = isPerGrade ? '' : 'none';
    });

    // Clear the inactive fields so they don't pollute the total
    const allSuffixes = [
        'tuition',
        ...SHS_MISC_ITEMS.map(([fid]) => fid.slice(2)),
        ...SHS_OTHER_ITEMS.map(([fid]) => fid.slice(2)),
    ];
    allSuffixes.forEach(suffix => {
        if (isPerGrade) {
            const el = document.getElementById(`s_${suffix}_curr`);
            if (el) el.value = '';
        } else {
            ['s11_' + suffix, 's12_' + suffix].forEach(fid => {
                const el = document.getElementById(fid + '_curr');
                if (el) el.value = '';
            });
        }
    });
    computeSHS();
}

function applyPctFieldVisibility() {
    const pctGroup = $('tfPctFieldGroup');
    if (pctGroup) pctGroup.style.display = tfMode === 'increase' ? '' : 'none';
}

/* ══════════════════════════════════════════════
   STEP 2 VALIDATION
══════════════════════════════════════════════ */
function validateStep2() {
    const schoolName = val('tfSchoolName').trim();
    const currentSY  = val('tfCurrentSY').trim();
    const proposedSY = val('tfProposedSY').trim();
    const pct        = getPct();

    if (!schoolName) {
        showToast('Please enter the school name.', 'circle-exclamation');
        $('tfSchoolName').focus(); return false;
    }
    if (!currentSY) {
        showToast('Please enter the current school year.', 'circle-exclamation');
        $('tfCurrentSY').focus(); return false;
    }
    if (!proposedSY) {
        showToast('Please enter the proposed school year.', 'circle-exclamation');
        $('tfProposedSY').focus(); return false;
    }
    if (tfMode === 'increase' && pct <= 0) {
        showToast('Please enter a valid increase percentage greater than 0.', 'circle-exclamation');
        $('tfIncreasePct').focus(); return false;
    }
    if (tfMode === 'increase' && pct > 100) {
        showToast('Increase percentage cannot exceed 100%.', 'circle-exclamation');
        $('tfIncreasePct').focus(); return false;
    }
    const anyChecked = ['chkKinder','chkElem','chkJHS','chkSHS'].some(id => $(id)?.checked);
    if (!anyChecked) {
        showToast('Please select at least one level.', 'circle-exclamation');
        return false;
    }
    return true;
}

function goToStep3FromStep2() {
    if (!validateStep2()) return;
    goToStep(3);
}

/* ══════════════════════════════════════════════
   STEP 3 VALIDATION  (FIX #14)
   Prevent proceeding to Review with all-zero fees.
══════════════════════════════════════════════ */
function validateStep3() {
    const showK = $('chkKinder').checked;
    const showE = $('chkElem').checked;
    const showJ = $('chkJHS').checked;
    const showS = $('chkSHS').checked;

    // Check that at least one active level has a non-zero fee entered
    const levelChecks = [
        { active: showK, fields: KINDER_FIELDS, label: 'Kindergarten' },
        { active: showE, fields: ELEM_FIELDS,   label: 'Elementary' },
        { active: showJ, fields: JHS_FIELDS,    label: 'Junior High School' },
        { active: showS, fields: SHS_FIELDS,    label: 'Senior High School' },
    ];

    for (const { active, fields, label } of levelChecks) {
        if (!active) continue;
        const hasAnyFee = fields.some(f => num(f + '_curr') > 0);
        if (!hasAnyFee) {
            showToast(`Please enter at least one fee for ${label}.`, 'circle-exclamation');
            return false;
        }
    }
    return true;
}

function goToStep4FromStep3() {
    if (!validateStep3()) return;
    goToStep(4);
}

/* ══════════════════════════════════════════════
   APPLY MODE TO STEP 3
══════════════════════════════════════════════ */
function applyModeToStep3() {
    const isInc = tfMode === 'increase';

    $('tfNoIncNotice').classList.toggle('tf-hidden', isInc);

    ['kinderModeTag','elemModeTag','jhsModeTag','shsModeTag'].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.className   = 'tf-mode-tag ' + (isInc ? 'inc' : 'noinc');
        el.textContent = isInc ? `${getPct()}% Increase` : 'No Increase';
    });

    document.querySelectorAll('.hide-on-no-inc').forEach(el => {
        el.style.display = isInc ? '' : 'none';
    });

    document.querySelectorAll('.tf-fee-row').forEach(row => {
        row.style.gridTemplateColumns = isInc
            ? '1.8fr 150px 150px 110px'
            : '1.8fr 150px';
    });

    ['kinderAllocPanel','elemAllocPanel','jhsAllocPanel','shsAllocPanel'].forEach(id => {
        $(id)?.classList.toggle('tf-hidden', !isInc);
    });

    const curr = val('tfCurrentSY')  || '—';
    const prop = val('tfProposedSY') || '—';
    document.querySelectorAll('.sy-curr-label').forEach(e => e.textContent = curr);
    document.querySelectorAll('.sy-prop-label').forEach(e => e.textContent = prop);

    // FIX UX#1: Rename fee header column label for no-increase path to reduce confusion.
    // "Approved" alone implies something may change; for no-increase we clarify it's
    // the existing fee.
    document.querySelectorAll('.tf-fee-col-curr-label').forEach(el => {
        el.textContent = isInc ? 'Approved' : 'Approved Fee (existing)';
    });

    const showK = $('chkKinder').checked;
    const showE = $('chkElem').checked;
    const showJ = $('chkJHS').checked;
    const showS = $('chkSHS').checked;

    $('tabKinder').style.display = showK ? '' : 'none';
    $('tabElem').style.display   = showE ? '' : 'none';
    $('tabJHS').style.display    = showJ ? '' : 'none';
    $('tabSHS').style.display    = showS ? '' : 'none';

    if      (showK) switchLevel('kinder');
    else if (showE) switchLevel('elem');
    else if (showJ) switchLevel('jhs');
    else if (showS) switchLevel('shs');

    computeKinder();
    computeElem();
    computeJHS();
    computeSHS();
}

/* ══════════════════════════════════════════════
   LEVEL TABS
══════════════════════════════════════════════ */
function switchLevel(level) {
    currentLevel = level;
    const panels = { kinder:'tfKinderPanel', elem:'tfElemPanel', jhs:'tfJHSPanel', shs:'tfSHSPanel' };
    const tabs   = { kinder:'tabKinder',     elem:'tabElem',     jhs:'tabJHS',     shs:'tabSHS'     };
    Object.entries(panels).forEach(([lvl, id]) => $(id)?.classList.toggle('tf-hidden', lvl !== level));
    Object.entries(tabs).forEach(([lvl, id])   => $(id)?.classList.toggle('active',    lvl === level));
}

/* ══════════════════════════════════════════════
   FEE FIELD DEFINITIONS
   FIX #7 (Critical): These arrays now exactly match the PHP recomputePayload()
   field lists and the HTML input IDs. Previously the PHP had different field
   names (k_lms, k_av, k_assess etc.) causing silent data loss on every save.
══════════════════════════════════════════════ */
const KINDER_FIELDS = [
    'k_tuition',
    'k_id', 'k_ins', 'k_handbook', 'k_water', 'k_itm', 'k_med',
    'k_reg', 'k_books', 'k_dev'
];

const ELEM_FIELDS = [
    'e_tuition',
    'e_id', 'e_ins', 'e_handbook', 'e_lab', 'e_water', 'e_itm', 'e_med',
    'e_reg', 'e_books', 'e_paces1', 'e_paces2'
];

const JHS_FIELDS = [
    'j_tuition',
    'j_id', 'j_ins', 'j_handbook', 'j_comp', 'j_water', 'j_itm', 'j_med',
    'j_reg', 'j_books', 'j_paces1', 'j_paces2'
];

// SHS fee item catalog — this ONE list now feeds BOTH the "BREAKDOWN OF SCHOOL
// FEES" page and the "Certification of School Fees" page, so a school only
// enters each fee amount once. Every item has a shared field (used when G11/G12
// charge the same amount) plus a per-grade pair (used when "Different fees for
// Grade 11 and Grade 12" is checked) — the same pattern already used for tuition.
const SHS_MISC_ITEMS = [
    ['s_id',       'Identification Card'],
    ['s_ins',      'Student Insurance'],
    ['s_exam',     'Examination Fee'],
    ['s_sports',   'Sports Development / Athletics'],
    ['s_sid',      'Student ID Card (SID)'],
    ['s_handbook', 'Handbook Fee'],
    ['s_comp',     'Computer Laboratory Fee'],
    ['s_water',    'Water Fee'],
    ['s_itm',      'Instructional & Test Mat.'],
    ['s_med',      'Medical Supplies'],
];
const SHS_OTHER_ITEMS = [
    ['s_reg',   'Registration Fee'],
    ['s_books', 'Books'],
    ['s_dev',   'Development Fee'],
];
// Convenience: bare per-grade field ids for a shared field id, e.g. 's_id' -> ['s11_id','s12_id']
const shsPerGradeIds = fid => ['s11_' + fid.slice(2), 's12_' + fid.slice(2)];

const SHS_LEGACY_FIELDS = [
    's_tuition',
    's11_tuition', 's12_tuition',   // FIX UX#3: per-grade tuition (only one active at a time)
    ...SHS_MISC_ITEMS.flatMap(([fid]) => [fid, ...shsPerGradeIds(fid)]),
    ...SHS_OTHER_ITEMS.flatMap(([fid]) => [fid, ...shsPerGradeIds(fid)]),
];

const SHS_FIELDS = [...SHS_LEGACY_FIELDS];

/* ══════════════════════════════════════════════
   SHS CERTIFICATION — SECTION V (voucher concessions/discounts)
   Simple label + Grade-11-amount + Grade-12-amount rows, editable and
   repeatable. Stored as a plain array and saved/restored inside the SHS
   payload (payload_json.shs.discounts).
══════════════════════════════════════════════ */
let shsDiscounts = [];

function shsDefaultDiscounts() {
    return [
        { label: 'Scholarship Discount on Tuition Fee \u2013 Top 1 (100%)', g11: 0, g12: 0 },
        { label: 'Scholarship Discount on Tuition Fee \u2013 Top 2 (50%)',  g11: 0, g12: 0 },
        { label: 'Scholarship Discount on Tuition Fee \u2013 Top 3 (25%)',  g11: 0, g12: 0 },
        { label: 'Loyalty Discount on Tuition Fee',                        g11: 0, g12: 0 },
    ];
}

function renderSHSDiscountInputs() {
    const wrap = $('shsDiscountRows');
    if (!wrap) return;
    wrap.innerHTML = shsDiscounts.map((d, i) => `
        <div class="tf-fee-row tf-discount-row">
            <input class="tf-input tf-discount-label" value="${escHtml(d.label || '')}"
                placeholder="Concession description"
                oninput="updateSHSDiscount(${i},'label',this.value)" />
            <div class="tf-fee-input-wrap">
                <span class="tf-peso-prefix">₱</span>
                <input class="tf-input tf-input-peso" type="number" min="0" step="0.01"
                    placeholder="G11" value="${d.g11 || ''}"
                    oninput="updateSHSDiscount(${i},'g11',this.value)" />
            </div>
            <div class="tf-fee-input-wrap">
                <span class="tf-peso-prefix">₱</span>
                <input class="tf-input tf-input-peso" type="number" min="0" step="0.01"
                    placeholder="G12" value="${d.g12 || ''}"
                    oninput="updateSHSDiscount(${i},'g12',this.value)" />
            </div>
            <button class="tf-custom-btn tf-custom-del-btn" title="Remove this concession"
                onclick="removeSHSDiscountRow(${i})">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>`).join('') + `
        <div class="tf-add-fee-wrap">
            <button class="tf-btn tf-btn-ghost tf-btn-sm" onclick="addSHSDiscountRow()">
                <i class="fa-solid fa-plus"></i> Add Concession
            </button>
        </div>`;
}

function updateSHSDiscount(i, key, value) {
    if (!shsDiscounts[i]) return;
    shsDiscounts[i][key] = key === 'label' ? value : (parseFloat(value) || 0);
    scheduleSave();
    tfLiveUpdate();
}

function addSHSDiscountRow() {
    shsDiscounts.push({ label: '', g11: 0, g12: 0 });
    renderSHSDiscountInputs();
    scheduleSave();
    tfLiveUpdate();
}

function removeSHSDiscountRow(i) {
    shsDiscounts.splice(i, 1);
    renderSHSDiscountInputs();
    scheduleSave();
    tfLiveUpdate();
}

/* ══════════════════════════════════════════════
   COMPUTE
══════════════════════════════════════════════ */
function computeProposed(currId, propId, incId) {
    const isInc = tfMode === 'increase';
    const c     = num(currId);
    const pct   = getPct() / 100;
    if (isInc) {
        setV(propId, c * (1 + pct));
        setV(incId,  c * pct);
    } else {
        setV(propId, c);
        setV(incId,  0);
    }
}

function onPctChange() {
    const pct = getPct();

    // Inline DepEd cap warning — appears while typing, before submit dialog
    let warn = $('tfPctCapWarning');
    if (!warn) {
        warn = document.createElement('div');
        warn.id = 'tfPctCapWarning';
        warn.style.cssText = 'color:#dc2626;font-size:12px;margin-top:4px;font-weight:600;';
        $('tfIncreasePct')?.parentNode?.appendChild(warn);
    }
    warn.textContent = pct > DEPED_MAX_TUITION_INCREASE_PCT
        ? `⚠ Exceeds DepEd DO 13 s. 2023 cap of ${DEPED_MAX_TUITION_INCREASE_PCT}%. This will be blocked on submission.`
        : '';

    ['kinderModeTag','elemModeTag','jhsModeTag','shsModeTag'].forEach(id => {
        const el = $(id);
        if (el && tfMode === 'increase') el.textContent = `${pct}% Increase`;
    });
    // Debounce the four compute passes — each loops over its entire *_FIELDS
    // array, so running all four on every keystroke is wasteful on devices
    // with many custom fees. The warning text and mode tags above remain
    // immediate for responsiveness.
    clearTimeout(pctComputeTimer);
    pctComputeTimer = setTimeout(() => {
        computeKinder(); computeElem(); computeJHS(); computeSHS();
        tfLiveUpdate();
    }, 120);
}

function computeKinder() {
    KINDER_FIELDS.forEach(f => computeProposed(f+'_curr', f+'_prop', f+'_inc'));
    const ct = KINDER_FIELDS.reduce((s,f) => s + num(f+'_curr'), 0);
    const pt = KINDER_FIELDS.reduce((s,f) => s + num(f+'_prop'), 0);
    setV('k_total_curr', ct); setV('k_total_prop', pt); setV('k_total_inc', pt - ct);
}

function computeElem() {
    ELEM_FIELDS.forEach(f => computeProposed(f+'_curr', f+'_prop', f+'_inc'));
    const ct = ELEM_FIELDS.reduce((s,f) => s + num(f+'_curr'), 0);
    const pt = ELEM_FIELDS.reduce((s,f) => s + num(f+'_prop'), 0);
    setV('e_total_curr', ct); setV('e_total_prop', pt); setV('e_total_inc', pt - ct);
}

function computeJHS() {
    JHS_FIELDS.forEach(f => computeProposed(f+'_curr', f+'_prop', f+'_inc'));
    const ct = JHS_FIELDS.reduce((s,f) => s + num(f+'_curr'), 0);
    const pt = JHS_FIELDS.reduce((s,f) => s + num(f+'_prop'), 0);
    setV('j_total_curr', ct); setV('j_total_prop', pt); setV('j_total_inc', pt - ct);
}

function computeSHS() {
    SHS_FIELDS.forEach(f => computeProposed(f+'_curr', f+'_prop', f+'_inc'));
    // Official total (used for dashboard/summary tiles) is still based on the
    // legacy breakdown-form fields only, so existing behavior is unchanged.
    const ct = SHS_LEGACY_FIELDS.reduce((s,f) => s + num(f+'_curr'), 0);
    const pt = SHS_LEGACY_FIELDS.reduce((s,f) => s + num(f+'_prop'), 0);
    setV('s_total_curr', ct); setV('s_total_prop', pt); setV('s_total_inc', pt - ct);
}

/* ══════════════════════════════════════════════
   CUSTOM MISCELLANEOUS FEE CRUD
   — stored in localStorage per level
   — fields injected into the live *_FIELDS arrays
     so compute*, buildPayload, resetFeeInputs,
     and loadSavedDoc all pick them up for free
══════════════════════════════════════════════ */

// Maps a level key → its mutable FIELDS array reference and DOM panel id
const LEVEL_META = {
    kinder : { fields: null, panelId: 'tfKinderPanel', prefix: 'k', computeFn: () => computeKinder() },
    elem   : { fields: null, panelId: 'tfElemPanel',   prefix: 'e', computeFn: () => computeElem()   },
    jhs    : { fields: null, panelId: 'tfJHSPanel',    prefix: 'j', computeFn: () => computeJHS()    },
    shs    : { fields: null, panelId: 'tfSHSPanel',    prefix: 's', computeFn: () => computeSHS()    },
};

// Maps section-header keys → the field IDs that belong to that section.
// Used to auto-hide section header rows (II., III.) in the preview breakdown
// tables and the form panel sub-labels when all their fees have been deleted.
const SECTION_FIELD_MAP = {
    k_misc:  ['k_id','k_ins','k_handbook','k_water','k_itm','k_med'],
    k_other: ['k_reg','k_books','k_dev'],
    e_misc:  ['e_id','e_ins','e_handbook','e_lab','e_water','e_itm','e_med'],
    e_other: ['e_reg','e_books','e_paces1','e_paces2'],
    j_misc:  ['j_id','j_ins','j_handbook','j_comp','j_water','j_itm','j_med'],
    j_other: ['j_reg','j_books','j_paces1','j_paces2'],
    s_misc:  SHS_MISC_ITEMS.flatMap(([fid]) => [fid, ...shsPerGradeIds(fid)]),
    s_other: SHS_OTHER_ITEMS.flatMap(([fid]) => [fid, ...shsPerGradeIds(fid)]),
};

// Called once after KINDER_FIELDS etc. are defined — wires the references
function initLevelMeta() {
    LEVEL_META.kinder.fields = KINDER_FIELDS;
    LEVEL_META.elem.fields   = ELEM_FIELDS;
    LEVEL_META.jhs.fields    = JHS_FIELDS;
    LEVEL_META.shs.fields    = SHS_FIELDS;
}

const CUSTOM_FEES_KEY          = lvl => `tf_custom_fees_${lvl}`;
const DELETED_BUILTIN_FEES_KEY = lvl => `tf_deleted_builtin_fees_${lvl}`;

/** Load saved custom fee definitions for a level from localStorage */
function loadCustomFeesMeta(lvl) {
    try {
        return JSON.parse(localStorage.getItem(CUSTOM_FEES_KEY(lvl)) || '[]');
    } catch { return []; }
}

/** Persist the current custom fee definitions for a level */
function saveCustomFeesMeta(lvl, defs) {
    localStorage.setItem(CUSTOM_FEES_KEY(lvl), JSON.stringify(defs));
}

/** Load the set of deleted built-in fee field IDs for a level */
function loadDeletedBuiltins(lvl) {
    try {
        return new Set(JSON.parse(localStorage.getItem(DELETED_BUILTIN_FEES_KEY(lvl)) || '[]'));
    } catch { return new Set(); }
}

/** Persist the set of deleted built-in fee field IDs for a level */
function saveDeletedBuiltins(lvl, setObj) {
    localStorage.setItem(DELETED_BUILTIN_FEES_KEY(lvl), JSON.stringify([...setObj]));
}

/**
 * Hide or show all [data-field] preview rows based on which fields are
 * currently active in *_FIELDS. Also hides [data-section-header] rows
 * (the I., II., III. header rows in the breakdown tables) when every fee
 * in that section has been deleted, and re-shows them when any remain.
 * Call this after any deletion/addition or on load.
 */
function syncPreviewRowVisibility() {
    const allActive = new Set([...KINDER_FIELDS, ...ELEM_FIELDS, ...JHS_FIELDS, ...SHS_FIELDS]);

    // Show/hide individual fee item rows
    document.querySelectorAll('[data-field]').forEach(row => {
        const fid = row.getAttribute('data-field');
        row.style.display = allActive.has(fid) ? '' : 'none';
    });

    // Show/hide section header rows (II., III.) in the PDF preview breakdown tables
    document.querySelectorAll('[data-section-header]').forEach(row => {
        const sectionKey = row.getAttribute('data-section-header'); // e.g. 'k_misc', 'k_other'
        const fields = SECTION_FIELD_MAP[sectionKey] || [];
        const anyBuiltinVisible = fields.some(fid => allActive.has(fid));
        const [lvlPrefix, sectionCategory] = sectionKey.split('_'); // 'k'/'e'/'j'/'s', 'misc'/'other'
        const lvlName =
            lvlPrefix === 'k' ? 'kinder' :
            lvlPrefix === 'e' ? 'elem'   :
            lvlPrefix === 'j' ? 'jhs'    : 'shs';
        // BUG FIX: previously this showed BOTH the "II." and "III." headers
        // whenever ANY custom fee existed at this level, regardless of which
        // section it was assigned to. So adding a single "II. Miscellaneous"
        // custom fee would also re-show an empty "III. Other Fees" header (and
        // vice versa). Now each header only reappears if a custom fee was
        // actually placed in THAT section.
        const hasMatchingCustomFee = loadCustomFeesMeta(lvlName)
            .some(d => (d.section || 'other') === sectionCategory);
        row.style.display = (anyBuiltinVisible || hasMatchingCustomFee) ? '' : 'none';
    });

    // Also sync the form-panel sub-labels
    syncFormSectionVisibility();
}

/**
 * In the fee input form panels, hide section sub-headers
 * (e.g. the "II. Miscellaneous Fees" divs injected by tfRenderFeeInputs)
 * when all their fee rows have been deleted, and re-show when any remain.
 */
function syncFormSectionVisibility() {
    const allActive = new Set([...KINDER_FIELDS, ...ELEM_FIELDS, ...JHS_FIELDS, ...SHS_FIELDS]);
    Object.entries(SECTION_FIELD_MAP).forEach(([sectionKey, fields]) => {
        const headerEl = document.querySelector(`[data-form-section="${sectionKey}"]`);
        if (!headerEl) return;
        const anyBuiltinVisible = fields.some(fid => allActive.has(fid));
        const [lvlPrefix, sectionCategory] = sectionKey.split('_'); // 'k'/'e'/'j'/'s', 'misc'/'other'
        const lvlName =
            lvlPrefix === 'k' ? 'kinder' :
            lvlPrefix === 'e' ? 'elem'   :
            lvlPrefix === 'j' ? 'jhs'    : 'shs';
        // BUG FIX: previously this showed BOTH the "II." and "III." sub-labels
        // whenever ANY custom fee existed for the level, regardless of which
        // section it was assigned to. So adding a single "II. Miscellaneous"
        // custom fee would also re-show an empty "III. Other Fees" sub-label
        // (and vice versa). Now each sub-label only reappears if a custom fee
        // was actually placed in THAT section.
        const hasMatchingCustomFee = loadCustomFeesMeta(lvlName)
            .some(d => (d.section || 'other') === sectionCategory);
        headerEl.style.display = (anyBuiltinVisible || hasMatchingCustomFee) ? '' : 'none';
    });
}

/**
 * Delete a built-in SHS misc/other fee "item" — removes the shared field
 * (s_X) AND both per-grade variants (s11_X / s12_X) together, so the item
 * stays gone consistently whether or not "Different fees for Grade 11/12"
 * is toggled afterward. lvl is always 'shs' here; suffix is the field id
 * minus its 's_'/'s11_'/'s12_' prefix, e.g. 'id', 'ins', 'reg'.
 */
function deleteShsFeeItem(suffix) {
    if (!confirm('Remove this fee row? The value will be lost.')) return;

    const ids = ['s_' + suffix, 's11_' + suffix, 's12_' + suffix];
    ids.forEach(fieldId => {
        const idx = SHS_FIELDS.indexOf(fieldId);
        if (idx !== -1) SHS_FIELDS.splice(idx, 1);
        $(`tf-builtin-row-${fieldId}`)?.remove();
        document.querySelectorAll(`[data-field="${fieldId}"]`).forEach(row => { row.style.display = 'none'; });
    });

    const deleted = loadDeletedBuiltins('shs');
    ids.forEach(id => deleted.add(id));
    saveDeletedBuiltins('shs', deleted);

    computeSHS();
    scheduleSave();
    tfLiveUpdate();
    showToast('Fee row removed.', 'circle-check');
}

/**
 * Delete a built-in (non-tuition) misc fee row.
 * Removes from DOM, removes from the *_FIELDS array, hides matching preview
 * rows, and persists the deletion so it survives page reload.
 */
function deleteBuiltinFee(lvl, fieldId) {
    if (!confirm('Remove this fee row? The value will be lost.')) return;

    const meta = LEVEL_META[lvl];
    const idx  = meta.fields.indexOf(fieldId);
    if (idx !== -1) meta.fields.splice(idx, 1);

    $(`tf-builtin-row-${fieldId}`)?.remove();

    // Hide matching rows in the HTML preview breakdown tables
    document.querySelectorAll(`[data-field="${fieldId}"]`).forEach(row => {
        row.style.display = 'none';
    });

    const deleted = loadDeletedBuiltins(lvl);
    deleted.add(fieldId);
    saveDeletedBuiltins(lvl, deleted);

    meta.computeFn();
    scheduleSave();
    tfLiveUpdate();
    // Note: tfLiveUpdate → syncPreviewRowVisibility → syncFormSectionVisibility
    // so no separate syncFormSectionVisibility() call needed here.
    showToast('Fee row removed.', 'circle-check');
}

/** Generate a short unique id for a new custom field */
function customFeeId() {
    return Math.random().toString(36).slice(2, 8);
}

/**
 * Inject a custom fee row into a panel's DOM and register its fieldId in
 * the corresponding *_FIELDS array so all downstream functions handle it.
 * Returns the fieldId string.
 */
function injectCustomFeeRow(lvl, fieldId, label, currValue = '', section = 'other') {
    const meta   = LEVEL_META[lvl];
    const panel  = $(meta.panelId);
    if (!panel) return fieldId;

    // Don't double-inject
    if ($(fieldId + '_curr')) return fieldId;

    // Add to fields array if not already present
    if (!meta.fields.includes(fieldId)) {
        // Insert before the implicit total by pushing to the end
        meta.fields.push(fieldId);
    }

    // Roman-numeral badge so a custom fee visually shows which certification
    // section ("II. Miscellaneous Fees" or "III. Other Fees") it belongs to,
    // matching the numbering used by the section sub-labels above.
    const romanNumeral = section === 'misc' ? 'II.' : 'III.';

    // Build the row — same structure as rowHtml() in tfRenderFeeInputs
    const row = document.createElement('div');
    row.className   = 'tf-fee-row tf-custom-fee-row';
    row.id          = `tf-custom-row-${fieldId}`;
    row.dataset.customSection = section;
    row.innerHTML = `
        <div class="tf-fee-label tf-custom-fee-label">
            <span class="tf-sublabel-roman tf-custom-fee-roman">${romanNumeral}</span>
            <span class="tf-custom-fee-name" id="tf-custom-name-${fieldId}">${escHtml(label)}</span>
            <span class="tf-custom-fee-badge">custom</span>
            <button class="tf-custom-btn tf-custom-edit-btn" title="Edit label"
                onclick="editCustomFeeLabel('${lvl}','${fieldId}')">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button class="tf-custom-btn tf-custom-del-btn" title="Delete"
                onclick="deleteCustomFee('${lvl}','${fieldId}')">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
        <input class="tf-input tf-custom-curr" id="${fieldId}_curr"
               type="number" min="0" step="0.01" placeholder="0.00"
               oninput="scheduleSave();tfLiveUpdate()" />
        <input class="tf-input computed hide-on-no-inc" id="${fieldId}_prop"
               type="number" readonly />
        <input class="tf-input computed hide-on-no-inc" id="${fieldId}_inc"
               type="number" readonly />`;

    // Place the row in the section the user picked:
    //  - "misc"  (II. Miscellaneous Fees) → insert right before the
    //    "III. Other Fees" sub-label, i.e. at the end of section II.
    //  - "other" (III. Other Fees, the default) → insert right before the
    //    TOTAL row, i.e. at the end of section III.
    let anchor = null;
    if (section === 'misc') {
        anchor = panel.querySelector('[data-form-section$="_other"]');
    }
    if (!anchor) {
        anchor = panel.querySelector('[id$="_total_curr"]')?.closest('.tf-fee-row');
    }
    if (anchor) {
        panel.insertBefore(row, anchor);
    } else {
        panel.appendChild(row);
    }

    // Set saved value
    if (currValue !== '') {
        const el = $(fieldId + '_curr');
        if (el) el.value = currValue;
    }

    // ── FIX Bug 2: Inject matching rows into PDF preview breakdown tables ──
    // Each level's breakdown tbody has a fixed column structure. We inject a
    // <tr data-field="fieldId"> with a live-updating value cell (or cells).
    _injectCustomFeePreviewRows(lvl, fieldId, label, section);
    // The Certification of School Fees page shares the same fee catalog as
    // the Breakdown page now, so a custom SHS fee needs to show up there too.
    if (lvl === 'shs') _injectCustomFeeCertRows(fieldId, label, section);

    return fieldId;
}

/**
 * Inject custom fee preview rows into all breakdown <tbody> elements for the
 * given level. The value cell gets a class `pv-custom-{fieldId}` so
 * tfLiveUpdate can setText on it just like builtin rows.
 * Called by injectCustomFeeRow and deleteCustomFee (to remove them).
 */
function _injectCustomFeePreviewRows(lvl, fieldId, label, section = 'other') {
    // Find every breakdown table section-header that belongs to this level,
    // then insert our custom row before the TOTAL row in that tbody.
    // We identify tbodies by looking for [data-section-header] belonging to lvl.
    const prefix = lvl === 'kinder' ? 'k' : lvl === 'elem' ? 'e' : lvl === 'jhs' ? 'j' : 's';

    // Build the inner HTML for value cells based on level column layout:
    // kinder → 1 value col;  elem → 6 (grades 1-6);
    // jhs → 4 (grades 7-10); shs → 2 (g11, g12)
    function buildValueCells(fieldId, lvl) {
        if (lvl === 'kinder') {
            return `<td class="pv-custom-${fieldId} pv-custom-kinder"></td>`;
        }
        if (lvl === 'elem') {
            return [1,2,3,4,5,6].map(g =>
                `<td class="pv-custom-${fieldId} pv-custom-elem-${g}"></td>`
            ).join('');
        }
        if (lvl === 'jhs') {
            return [7,8,9,10].map(g =>
                `<td class="pv-custom-${fieldId} pv-custom-jhs-${g}"></td>`
            ).join('');
        }
        if (lvl === 'shs') {
            return [11,12].map(g =>
                `<td class="pv-custom-${fieldId} pv-custom-shs-${g}"></td>`
            ).join('');
        }
        return '';
    }

    // Find all breakdown tbodies that contain a [data-section-header] for this level
    document.querySelectorAll(`[data-section-header="${prefix}_misc"], [data-section-header="${prefix}_other"]`).forEach(headerRow => {
        const tbody = headerRow.closest('tbody');
        if (!tbody) return;
        // Don't double-inject
        if (tbody.querySelector(`[data-field="${fieldId}"]`)) return;

        const tr = document.createElement('tr');
        tr.setAttribute('data-field', fieldId);
        tr.setAttribute('data-custom', 'true');
        tr.setAttribute('data-custom-section', section);
        tr.innerHTML = `<td></td><td class="tf-bd-fee tf-bd-item">${escHtml(label)}</td>${buildValueCells(fieldId, lvl)}`;

        // Place the row in the same section the user chose for the form panel:
        //  - "misc"  (II. Miscellaneous Fees) → insert right before the
        //    "III. Other Fees" header row, i.e. at the end of section II.
        //  - "other" (III. Other Fees, the default) → insert right before the
        //    TOTAL row (the tbody's last row), i.e. at the end of section III.
        let anchor = null;
        if (section === 'misc') {
            anchor = tbody.querySelector(`[data-section-header="${prefix}_other"]`);
        }
        if (!anchor) {
            anchor = tbody.querySelector('tr:last-child'); // TOTAL row
        }
        if (anchor) {
            tbody.insertBefore(tr, anchor);
        } else {
            tbody.appendChild(tr);
        }
    });
}

/**
 * Inject a custom SHS fee row into both Certification of School Fees preview
 * pages (Grade 11 and Grade 12) — the certification page now shares the same
 * fee catalog as the Breakdown page, so custom fees need to appear there too.
 * The value span reuses the same `pv-custom-{fieldId}` class the Breakdown
 * table uses, so the existing tfLiveUpdate sync loop updates it automatically.
 * Rows carry data-field/data-custom so deleteCustomFee's generic cleanup
 * (`[data-field="${fieldId}"][data-custom="true"]`) removes them for free.
 */
function _injectCustomFeeCertRows(fieldId, label, section = 'other') {
    [11, 12].forEach(g => {
        const anchor = document.querySelector(`.pv-s${g}-${section}-customs`);
        if (!anchor) return;
        if (anchor.querySelector(`[data-field="${fieldId}"]`)) return; // don't double-inject
        const row = document.createElement('div');
        row.className = 'cert-row cert-indent';
        row.setAttribute('data-field', fieldId);
        row.setAttribute('data-custom', 'true');
        row.innerHTML = `<span class="cert-custom-label">${escHtml(label)}</span><span class="pv-custom-${fieldId} pv-custom-shs-${g}"></span>`;
        anchor.appendChild(row);
    });
}

/**
 * Restore all custom fee rows for a level from the saved document.
 *
 * BUG FIX (custom fee labels lost after localStorage clear / on a new device):
 * `serverDefs` (from the document's saved payload_json.custom_fees[lvl]) is
 * preferred when present. Older documents saved before this fix won't have a
 * `custom_fees` key in their payload — `serverDefs` will be `undefined` for
 * those, so we fall back to the localStorage copy as before.
 *
 * Called by tfRenderFeeInputs (new docs, serverDefs omitted) and loadSavedDoc
 * (existing docs, serverDefs passed from payload_json).
 */
function restoreCustomFees(lvl, payloadSection, serverDefs) {
    const defs = serverDefs !== undefined ? (serverDefs || []) : loadCustomFeesMeta(lvl);
    // Keep the local copy in sync with the server-stored definitions so this
    // device's localStorage stays correct for future edits/new documents.
    if (serverDefs !== undefined) {
        saveCustomFeesMeta(lvl, defs);
    }
    defs.forEach(def => {
        const savedVal = payloadSection ? (payloadSection[def.fieldId + '_curr'] ?? '') : '';
        // Existing custom fees saved before the "fee category" selector was
        // added won't have a `section` field — default them to "other" (the
        // previous, only behavior) so they keep appearing where they were.
        injectCustomFeeRow(lvl, def.fieldId, def.label, savedVal, def.section || 'other');
    });
}

/** Open an inline "Add custom fee" form at the bottom of the panel */
function showAddCustomFeeForm(lvl) {
    const formId = `tf-add-fee-form-${lvl}`;
    if ($(formId)) { $(formId).querySelector('input')?.focus(); return; } // already open

    const meta  = LEVEL_META[lvl];
    const panel = $(meta.panelId);
    if (!panel) return;

    const form = document.createElement('div');
    form.id          = formId;
    form.className   = 'tf-add-fee-form';
    form.innerHTML   = `
        <div class="tf-custom-fee-notice"><i class="fa-solid fa-circle-info"></i> Custom fee names are saved with this document, so they'll still appear if you open it on another device.</div>
        <label class="tf-add-fee-section-label" style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:4px;">
            Fee category
        </label>
        <select class="tf-input tf-add-fee-section" id="tf-add-fee-section-${lvl}" style="margin-bottom:8px;">
            <option value="misc">II. Miscellaneous Fees</option>
            <option value="other" selected>III. Other Fees</option>
        </select>
        <input class="tf-input tf-add-fee-input" id="tf-add-fee-label-${lvl}"
               type="text" placeholder="Fee name, e.g. Laboratory fee" maxlength="80" />
        <div class="tf-add-fee-actions">
            <button class="tf-btn tf-btn-primary tf-btn-sm"
                    onclick="commitAddCustomFee('${lvl}')">
                <i class="fa-solid fa-plus"></i> Add
            </button>
            <button class="tf-btn tf-btn-secondary tf-btn-sm"
                    onclick="cancelAddCustomFee('${lvl}')">
                Cancel
            </button>
        </div>`;

    // Insert before the TOTAL row
    const totalRow = panel.querySelector('[id$="_total_curr"]')?.closest('.tf-fee-row');
    if (totalRow) {
        panel.insertBefore(form, totalRow);
    } else {
        panel.appendChild(form);
    }

    $(`tf-add-fee-label-${lvl}`)?.focus();
}

function cancelAddCustomFee(lvl) {
    $(`tf-add-fee-form-${lvl}`)?.remove();
}

function commitAddCustomFee(lvl) {
    const labelEl = $(`tf-add-fee-label-${lvl}`);
    const label   = (labelEl?.value || '').trim();
    if (!label) { labelEl?.focus(); showToast('Please enter a fee name.', 'circle-exclamation'); return; }

    // Which roman-numeral section (II. Miscellaneous Fees / III. Other Fees)
    // this custom fee belongs to. Defaults to "other" if no selector found.
    const sectionEl = $(`tf-add-fee-section-${lvl}`);
    const section   = sectionEl?.value === 'misc' ? 'misc' : 'other';

    const fieldId = LEVEL_META[lvl].prefix + '_custom_' + customFeeId();
    const defs    = loadCustomFeesMeta(lvl);
    defs.push({ fieldId, label, section });
    saveCustomFeesMeta(lvl, defs);

    cancelAddCustomFee(lvl);
    injectCustomFeeRow(lvl, fieldId, label, '', section);
    LEVEL_META[lvl].computeFn();
    scheduleSave();
    // BUG FIX: previously only syncFormSectionVisibility() was called, which
    // re-shows the "II./III." labels in the left-side form panel but NOT the
    // matching "II. Miscellaneous Fees" / "III. Other Fees" section header
    // rows in the right-side breakdown-of-fees preview. If all built-in fees
    // in those sections had been deleted earlier (hiding those header rows),
    // the new custom fee row would appear orphaned directly under
    // "I. Tuition Fee" with no section header above it. syncPreviewRowVisibility()
    // updates both the preview headers and the form labels.
    syncPreviewRowVisibility();
    showToast(`"${label}" added.`, 'circle-check');
}

function deleteCustomFee(lvl, fieldId) {
    if (!confirm('Remove this custom fee row? The value will be lost.')) return;

    // Remove from fields array
    const meta = LEVEL_META[lvl];
    const idx  = meta.fields.indexOf(fieldId);
    if (idx !== -1) meta.fields.splice(idx, 1);

    // Remove form panel row
    $(`tf-custom-row-${fieldId}`)?.remove();

    // FIX Bug 2: also remove injected preview rows
    document.querySelectorAll(`[data-field="${fieldId}"][data-custom="true"]`).forEach(r => r.remove());

    // Remove from localStorage
    const defs = loadCustomFeesMeta(lvl).filter(d => d.fieldId !== fieldId);
    saveCustomFeesMeta(lvl, defs);

    meta.computeFn();
    scheduleSave();
    tfLiveUpdate();
    // BUG FIX: same issue as commitAddCustomFee — use syncPreviewRowVisibility()
    // so the breakdown preview's "II./III." section headers are correctly
    // hidden again if this was the last custom fee and no built-in fees
    // remain in that section (tfLiveUpdate already calls
    // syncPreviewRowVisibility, but call it explicitly here too in case this
    // function is ever invoked without a preceding tfLiveUpdate).
    syncPreviewRowVisibility();
    showToast('Custom fee removed.', 'circle-check');
}

function editCustomFeeLabel(lvl, fieldId) {
    const nameEl = $(`tf-custom-name-${fieldId}`);
    if (!nameEl) return;

    const current  = nameEl.textContent.trim();
    const inputId  = `tf-edit-inline-${fieldId}`;

    // Avoid double-editing
    if ($(inputId)) { $(inputId).focus(); return; }

    const input = document.createElement('input');
    input.id        = inputId;
    input.type      = 'text';
    input.value     = current;
    input.maxLength = 80;
    input.className = 'tf-input tf-edit-inline-input';
    input.style.cssText = 'font-size:12.5px;padding:3px 7px;width:140px;';

    input.onblur = () => commitEditCustomFeeLabel(lvl, fieldId, input, nameEl);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.remove(); }
    };

    nameEl.replaceWith(input);
    input.focus();
    input.select();
}

function commitEditCustomFeeLabel(lvl, fieldId, input, nameEl) {
    const newLabel = input.value.trim();
    if (!newLabel) { input.remove(); return; }

    nameEl.textContent = newLabel;
    input.replaceWith(nameEl);

    const defs = loadCustomFeesMeta(lvl).map(d =>
        d.fieldId === fieldId ? { ...d, label: newLabel } : d
    );
    saveCustomFeesMeta(lvl, defs);

    // BUG FIX: renaming a custom fee only updated the form-panel label.
    // The matching label cell injected into the PDF/preview breakdown
    // tables by _injectCustomFeePreviewRows() was never updated, so the
    // preview/PDF kept showing the old name until the page was reloaded.
    document.querySelectorAll(`[data-field="${fieldId}"][data-custom="true"] .tf-bd-item, [data-field="${fieldId}"][data-custom="true"] .cert-custom-label`)
        .forEach(cell => { cell.textContent = newLabel; });

    showToast('Fee name updated.', 'circle-check');
}

/* ══════════════════════════════════════════════
   STEP 3 — Fee input panel injection
══════════════════════════════════════════════ */
function tfRenderFeeInputs() {
    initLevelMeta();

    // Plain row — used for tuition rows only (not deletable)
    const rowHtml = (label, fieldId) => `
        <div class="tf-fee-row">
            <div class="tf-fee-label">${label}</div>
            <div class="tf-fee-input-wrap">
                <span class="tf-peso-prefix">₱</span>
                <input class="tf-input tf-input-peso" id="${fieldId}_curr" type="number" min="0" step="0.01" placeholder="0.00" oninput="scheduleSave();tfLiveUpdate()" />
            </div>
            <input class="tf-input computed hide-on-no-inc" id="${fieldId}_prop" type="number" readonly />
            <input class="tf-input computed hide-on-no-inc" id="${fieldId}_inc" type="number" readonly />
        </div>`;

    // Deletable row — used for all miscellaneous / other fee rows
    // lvl is passed as a string literal so the onclick handler resolves correctly
    const deletableRowHtml = (label, fieldId, lvl) => `
        <div class="tf-fee-row tf-builtin-fee-row" id="tf-builtin-row-${fieldId}">
            <div class="tf-fee-label tf-builtin-fee-label">
                <span>${escHtml(label)}</span>
                <button class="tf-custom-btn tf-custom-del-btn" title="Remove this fee row"
                    onclick="deleteBuiltinFee('${lvl}','${fieldId}')">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            <div class="tf-fee-input-wrap">
                <span class="tf-peso-prefix">₱</span>
                <input class="tf-input tf-input-peso" id="${fieldId}_curr" type="number" min="0" step="0.01" placeholder="0.00" oninput="scheduleSave();tfLiveUpdate()" />
            </div>
            <input class="tf-input computed hide-on-no-inc" id="${fieldId}_prop" type="number" readonly />
            <input class="tf-input computed hide-on-no-inc" id="${fieldId}_inc" type="number" readonly />
        </div>`;

    const headerHtml = `
        <div class="tf-fee-row header-row">
            <div></div>
            <div class="tf-fee-col-curr-label">Approved</div>
            <div class="hide-on-no-inc">Proposed</div>
            <div class="hide-on-no-inc">Increase</div>
        </div>`;

    const totalRowHtml = (prefix) => `
        <div class="tf-fee-row">
            <div class="tf-fee-label" style="font-weight:800;">TOTAL</div>
            <input class="tf-input computed" id="${prefix}_total_curr" type="number" readonly />
            <input class="tf-input computed hide-on-no-inc" id="${prefix}_total_prop" type="number" readonly />
            <input class="tf-input computed hide-on-no-inc" id="${prefix}_total_inc" type="number" readonly />
        </div>`;

    const addBtnHtml = (lvl) => `
        <div class="tf-add-fee-wrap">
            <button class="tf-btn tf-btn-ghost tf-btn-sm tf-add-fee-trigger"
                    onclick="showAddCustomFeeForm('${lvl}')">
                <i class="fa-solid fa-plus"></i> Add Custom Fee
            </button>
        </div>`;

    const panelHtml = (panelId, title, rows, totalPrefix, hidden) => `
        <div id="${panelId}" class="${hidden ? 'tf-hidden' : ''}">
            <div class="tf-fee-section-label">${title}</div>
            ${headerHtml}
            ${rows.join('')}
            ${totalRowHtml(totalPrefix)}
            ${addBtnHtml(panelId === 'tfKinderPanel' ? 'kinder' :
                         panelId === 'tfElemPanel'   ? 'elem'   :
                         panelId === 'tfJHSPanel'    ? 'jhs'    : 'shs')}
        </div>`;

    // FIX: k_id and k_med were in KINDER_FIELDS but had no rendered input rows —
    // values were always 0, silently inflating / deflating the misc total.
    // All non-tuition rows now render with a delete button so schools can remove
    // fees that don't apply to them.
    const kinderDeleted = loadDeletedBuiltins('kinder');
    const kinderMiscBuiltins = [
        ['Identification Card',         'k_id'],
        ['Insurance',                   'k_ins'],
        ['Handbook Fee',                'k_handbook'],
        ['Water Fee',                   'k_water'],
        ['Instructional & Test Mat.',   'k_itm'],
        ['Medical Supplies',            'k_med'],
    ];
    const kinderOtherBuiltins = [
        ['Registration Fee',            'k_reg'],
        ['Books',                       'k_books'],
        ['Development Fee',             'k_dev'],
    ];
    const kinderBuiltins = [...kinderMiscBuiltins, ...kinderOtherBuiltins];
    // Remove deleted built-ins from the KINDER_FIELDS array
    kinderBuiltins.forEach(([, fid]) => {
        if (kinderDeleted.has(fid)) {
            const idx = KINDER_FIELDS.indexOf(fid);
            if (idx !== -1) KINDER_FIELDS.splice(idx, 1);
        }
    });
    const kinderRows = [
        rowHtml('Tuition Fee (annually)', 'k_tuition'),
        `<div class="tf-fee-section-sublabel" data-form-section="k_misc"><span class="tf-sublabel-roman">II.</span> Miscellaneous Fees</div>`,
        ...kinderMiscBuiltins
            .filter(([, fid]) => !kinderDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'kinder')),
        `<div class="tf-fee-section-sublabel" data-form-section="k_other"><span class="tf-sublabel-roman">III.</span> Other Fees</div>`,
        ...kinderOtherBuiltins
            .filter(([, fid]) => !kinderDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'kinder')),
    ];

    // FIX: e_id and e_med were in ELEM_FIELDS but had no rendered input rows.
    const elemDeleted = loadDeletedBuiltins('elem');
    const elemMiscBuiltins = [
        ['Identification Card',         'e_id'],
        ['Insurance',                   'e_ins'],
        ['Handbook Fee',                'e_handbook'],
        ['Laboratory Fee',              'e_lab'],
        ['Water Fee',                   'e_water'],
        ['Instructional & Test Mat.',   'e_itm'],
        ['Medical Supplies',            'e_med'],
    ];
    const elemOtherBuiltins = [
        ['Registration Fee',            'e_reg'],
        ['Books',                       'e_books'],
        ['PACEs 1st Deposit (May)',     'e_paces1'],
        ['PACEs 2nd Deposit (October)', 'e_paces2'],
    ];
    const elemBuiltins = [...elemMiscBuiltins, ...elemOtherBuiltins];
    elemBuiltins.forEach(([, fid]) => {
        if (elemDeleted.has(fid)) {
            const idx = ELEM_FIELDS.indexOf(fid);
            if (idx !== -1) ELEM_FIELDS.splice(idx, 1);
        }
    });
    const elemRows = [
        rowHtml('Tuition Fee (annually)', 'e_tuition'),
        `<div class="tf-fee-section-sublabel" data-form-section="e_misc"><span class="tf-sublabel-roman">II.</span> Miscellaneous Fees</div>`,
        ...elemMiscBuiltins
            .filter(([, fid]) => !elemDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'elem')),
        `<div class="tf-fee-section-sublabel" data-form-section="e_other"><span class="tf-sublabel-roman">III.</span> Other Fees</div>`,
        ...elemOtherBuiltins
            .filter(([, fid]) => !elemDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'elem')),
    ];

    // FIX: j_id, j_ins, j_med were in JHS_FIELDS but had no rendered input rows.
    const jhsDeleted = loadDeletedBuiltins('jhs');
    const jhsMiscBuiltins = [
        ['Identification Card',         'j_id'],
        ['Insurance',                   'j_ins'],
        ['Handbook Fee',                'j_handbook'],
        ['Computer Laboratory Fee',     'j_comp'],
        ['Water Fee',                   'j_water'],
        ['Instructional & Test Mat.',   'j_itm'],
        ['Medical Supplies',            'j_med'],
    ];
    const jhsOtherBuiltins = [
        ['Registration Fee',            'j_reg'],
        ['Books',                       'j_books'],
        ['PACEs 1st Deposit (May)',     'j_paces1'],
        ['PACEs 2nd Deposit (October)', 'j_paces2'],
    ];
    const jhsBuiltins = [...jhsMiscBuiltins, ...jhsOtherBuiltins];
    jhsBuiltins.forEach(([, fid]) => {
        if (jhsDeleted.has(fid)) {
            const idx = JHS_FIELDS.indexOf(fid);
            if (idx !== -1) JHS_FIELDS.splice(idx, 1);
        }
    });
    const jhsRows = [
        rowHtml('Tuition Fee (annually)', 'j_tuition'),
        `<div class="tf-fee-section-sublabel" data-form-section="j_misc"><span class="tf-sublabel-roman">II.</span> Miscellaneous Fees</div>`,
        ...jhsMiscBuiltins
            .filter(([, fid]) => !jhsDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'jhs')),
        `<div class="tf-fee-section-sublabel" data-form-section="j_other"><span class="tf-sublabel-roman">III.</span> Other Fees</div>`,
        ...jhsOtherBuiltins
            .filter(([, fid]) => !jhsDeleted.has(fid))
            .map(([label, fid]) => deletableRowHtml(label, fid, 'jhs')),
    ];

    // FIX: s_med and s_id were in SHS_FIELDS but had no rendered rows.
    // FIX UX#3 + UNIFIED CATALOG: this single item list now feeds BOTH the
    // Breakdown page AND the Certification page. Deleting an item removes its
    // shared field AND both per-grade variants together (deleteShsFeeItem),
    // so it stays gone consistently regardless of the per-grade toggle.
    const shsDeleted = loadDeletedBuiltins('shs');
    const shsMiscBuiltins  = SHS_MISC_ITEMS;
    const shsOtherBuiltins = SHS_OTHER_ITEMS;
    const shsBuiltins = [...shsMiscBuiltins, ...shsOtherBuiltins];
    shsBuiltins.forEach(([fid]) => {
        if (shsDeleted.has(fid)) {
            [fid, ...shsPerGradeIds(fid)].forEach(f => {
                const idx = SHS_FIELDS.indexOf(f);
                if (idx !== -1) SHS_FIELDS.splice(idx, 1);
            });
        }
    });

    // Row renderer for SHS misc/other items — mirrors deletableRowHtml, but
    // the delete button removes the shared field AND both per-grade variants
    // together (via deleteShsFeeItem), regardless of which row (shared/G11/G12)
    // triggered it.
    const shsItemRow = (label, fid, gradeTag = '') => {
        const suffix  = fid.slice(2); // strip 's_'
        const rowId   = gradeTag ? `s${gradeTag}_${suffix}` : fid;
        return `
        <div class="tf-fee-row tf-builtin-fee-row" id="tf-builtin-row-${rowId}">
            <div class="tf-fee-label tf-builtin-fee-label">
                <span>${escHtml(label)}</span>
                <button class="tf-custom-btn tf-custom-del-btn" title="Remove this fee row"
                    onclick="deleteShsFeeItem('${suffix}')">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            <div class="tf-fee-input-wrap">
                <span class="tf-peso-prefix">₱</span>
                <input class="tf-input tf-input-peso" id="${rowId}_curr" type="number" min="0" step="0.01" placeholder="0.00" oninput="scheduleSave();tfLiveUpdate()" />
            </div>
            <input class="tf-input computed hide-on-no-inc" id="${rowId}_prop" type="number" readonly />
            <input class="tf-input computed hide-on-no-inc" id="${rowId}_inc" type="number" readonly />
        </div>`;
    };

    const shsRows = [
        `<div class="tf-shs-grade-toggle">
            <label class="tf-chk-label" style="font-size:12.5px;">
                <input type="checkbox" id="chkSHSPerGrade" onchange="tfToggleSHSPerGrade();scheduleSave();tfLiveUpdate()">
                Different fees for Grade 11 and Grade 12
            </label>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">Leave unchecked if G11 and G12 share the same fees. Applies to Tuition, Miscellaneous, and Other Fees — the same numbers feed both the Breakdown of Fees and the Certification of School Fees.</div>
        </div>`,
        `<div id="shsSharedRows">`,
        rowHtml('Tuition Fee (annually)', 's_tuition'),
        `</div>`,
        `<div id="shsPerGradeRows" style="display:none;">`,
        rowHtml('Tuition Fee — Grade 11 (annually)', 's11_tuition'),
        rowHtml('Tuition Fee — Grade 12 (annually)', 's12_tuition'),
        `</div>`,

        `<div class="tf-fee-section-sublabel" data-form-section="s_misc"><span class="tf-sublabel-roman">II.</span> Miscellaneous Fees</div>`,
        `<div id="shsMiscShared">`,
        ...shsMiscBuiltins.filter(([fid]) => !shsDeleted.has(fid)).map(([fid, label]) => shsItemRow(label, fid)),
        `</div>`,
        `<div id="shsMiscPerGrade" style="display:none;">`,
        ...shsMiscBuiltins.filter(([fid]) => !shsDeleted.has(fid)).flatMap(([fid, label]) => [
            shsItemRow(`${label} — Grade 11`, fid, '11'),
            shsItemRow(`${label} — Grade 12`, fid, '12'),
        ]),
        `</div>`,

        `<div class="tf-fee-section-sublabel" data-form-section="s_other"><span class="tf-sublabel-roman">III.</span> Other Fees</div>`,
        `<div id="shsOtherShared">`,
        ...shsOtherBuiltins.filter(([fid]) => !shsDeleted.has(fid)).map(([fid, label]) => shsItemRow(label, fid)),
        `</div>`,
        `<div id="shsOtherPerGrade" style="display:none;">`,
        ...shsOtherBuiltins.filter(([fid]) => !shsDeleted.has(fid)).flatMap(([fid, label]) => [
            shsItemRow(`${label} — Grade 11`, fid, '11'),
            shsItemRow(`${label} — Grade 12`, fid, '12'),
        ]),
        `</div>`,

        // ── SHS CERTIFICATION DETAILS (Track/Strand, Section V, SDS signatory) ──
        // Note: the Certification's own Tuition/Miscellaneous/Other Fee amounts
        // now come straight from the shared items above — no separate fee
        // entry needed here anymore.
        `<div class="tf-fee-section-sublabel" style="margin-top:14px;border-top:2px solid #cbd5e1;padding-top:10px;">
            <i class="fa-solid fa-file-certificate"></i> SHS Certification Details
        </div>`,
        `<div class="tf-fee-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div class="fg"><label style="font-size:11px;">Track</label><input class="tf-input" id="tfSHSTrack" placeholder="e.g. ACADEMIC" oninput="scheduleSave();tfLiveUpdate()" /></div>
            <div class="fg"><label style="font-size:11px;">Strand</label><input class="tf-input" id="tfSHSStrand" placeholder="e.g. ABM, HUMSS, STEM" oninput="scheduleSave();tfLiveUpdate()" /></div>
        </div>`,
        `<div class="tf-fee-section-sublabel"><span class="tf-sublabel-roman">V.</span> Voucher Program Concessions / Discounts</div>`,
        `<div id="shsDiscountRows"></div>`,
        `<div class="tf-fee-section-sublabel"><span class="tf-sublabel-roman"></span> Certification Signatories</div>`,
        `<div class="tf-fee-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div class="fg"><label style="font-size:11px;">Noted by (Schools Division Superintendent)</label><input class="tf-input" id="tfSHSNotedBy" placeholder="${DEFAULT_SHS_NOTED_BY_NAME}" oninput="scheduleSave();tfLiveUpdate()" /></div>
            <div class="fg"><label style="font-size:11px;">Noted by — Position</label><input class="tf-input" id="tfSHSNotedByPosition" placeholder="${DEFAULT_SHS_NOTED_BY_POSITION}" oninput="scheduleSave();tfLiveUpdate()" /></div>
        </div>`,
        `<div class="tf-fee-row">
            <div class="fg"><label style="font-size:11px;">Noted by — Office</label><input class="tf-input" id="tfSHSNotedByOffice" placeholder="${DEFAULT_SHS_NOTED_BY_OFFICE}" oninput="scheduleSave();tfLiveUpdate()" /></div>
        </div>`,
    ];


    const kinderWrap = $('kinderFeeInputs');
    const elemWrap   = $('elemFeeInputs');
    const jhsWrap    = $('jhsFeeInputs');
    const shsWrap    = $('shsFeeInputs');

    if (kinderWrap) kinderWrap.innerHTML = panelHtml('tfKinderPanel', 'Kindergarten',       kinderRows, 'k', false);
    if (elemWrap)   elemWrap.innerHTML   = panelHtml('tfElemPanel',   'Elementary',          elemRows,   'e', true);
    if (jhsWrap)    jhsWrap.innerHTML    = panelHtml('tfJHSPanel',    'Junior High School',  jhsRows,    'j', true);
    if (shsWrap)    shsWrap.innerHTML    = panelHtml('tfSHSPanel',    'Senior High School',  shsRows,    's', true);

    // Seed and render the SHS Section V discount/concession rows now that
    // #shsDiscountRows exists in the DOM.
    if (!shsDiscounts.length) shsDiscounts = shsDefaultDiscounts();
    renderSHSDiscountInputs();

    // Restore any custom fees saved in localStorage (new doc — no saved payload values yet)
    restoreCustomFees('kinder', null);
    restoreCustomFees('elem',   null);
    restoreCustomFees('jhs',    null);
    restoreCustomFees('shs',    null);

    // Hide preview rows for any fees that were previously deleted
    syncPreviewRowVisibility();
}

/* ══════════════════════════════════════════════
   BUILD PAYLOAD
══════════════════════════════════════════════ */
function buildPayload() {
    const kinderData = {}; KINDER_FIELDS.forEach(f => { kinderData[f+'_curr'] = num(f+'_curr'); });
    const elemData   = {}; ELEM_FIELDS.forEach(f   => { elemData[f+'_curr']   = num(f+'_curr'); });
    const jhsData    = {}; JHS_FIELDS.forEach(f    => { jhsData[f+'_curr']    = num(f+'_curr'); });
    const shsData    = {}; SHS_FIELDS.forEach(f    => { shsData[f+'_curr']    = num(f+'_curr'); });
    // SHS Certification-specific extras (track/strand, Section V concessions,
    // and the SDS "Noted by" signatory).
    shsData.track          = val('tfSHSTrack');
    shsData.strand         = val('tfSHSStrand');
    shsData.discounts      = shsDiscounts;
    shsData.sds_name       = val('tfSHSNotedBy');
    shsData.sds_position   = val('tfSHSNotedByPosition');
    shsData.sds_office     = val('tfSHSNotedByOffice');

    return {
        form: {
            school_name : val('tfSchoolName'),
            division    : val('tfDivision'),
            address     : val('tfAddress'),
            school_id   : val('tfSchoolId'),
            gov_recog   : val('tfGovRecogNo'),
            current_sy  : val('tfCurrentSY'),
            proposed_sy : val('tfProposedSY'),
            increase_pct: getPct(),
            principal   : val('tfPrincipal'),
            principal_contact: val('tfPrincipalContact'),
            principal_position: val('tfPrincipalPosition'),
            reviewed_by : val('tfReviewedBy'),
            reviewed_by_position: val('tfReviewedByPosition'),
            validated_by : val('tfValidatedBy'),
            validated_by_position: val('tfValidatedByPosition'),
            noted_by : val('tfNotedBy'),
            noted_by_position: val('tfNotedByPosition'),
        },
        kinder : kinderData,
        elem   : elemData,
        jhs    : jhsData,
        shs    : shsData,
        // BUG FIX (custom fee labels lost after localStorage clear / on a new
        // device): persist the custom fee definitions (label, fieldId, section)
        // server-side alongside the values, so loadSavedDoc can recreate the
        // custom fee rows even when localStorage has no record of them.
        custom_fees: {
            kinder: loadCustomFeesMeta('kinder'),
            elem  : loadCustomFeesMeta('elem'),
            jhs   : loadCustomFeesMeta('jhs'),
            shs   : loadCustomFeesMeta('shs'),
        },
        // BUG FIX: supporting-docs checklist state was localStorage-only
        // (keyed per-document-id), so it never traveled with the document
        // and accumulated stale keys. Persist it server-side too.
        supporting_docs: loadSupportingDocState(),
    };
}

/* ══════════════════════════════════════════════
   SAVE DRAFT
══════════════════════════════════════════════ */
// FIX #10: saveDraft now returns a boolean indicating success/failure
// so callers (generatePDF, submitDocument) can react appropriately.
async function saveDraft(step) {
    if (_builderLocked) {
        showToast('This document is locked. Request edit approval first.', 'circle-xmark');
        return false;
    }
    if (!tfMode) {
        showToast('Please select a submission type first.', 'circle-exclamation');
        return false;
    }

    setSaveStatus('saving', 'Saving…');
    try {
        const body = {
            action      : 'save',
            id          : docId,
            mode        : tfMode === 'increase' ? 'increase' : 'no_increase',
            increase_pct: getPct(),
            current_sy  : val('tfCurrentSY'),
            proposed_sy : val('tfProposedSY'),
            school_name : val('tfSchoolName'),
            // FIX #13: send has_elem and has_shs so the backend persists them
            has_kinder  : $('chkKinder').checked ? 1 : 0,
            has_elem    : $('chkElem').checked   ? 1 : 0,
            has_jhs     : $('chkJHS').checked    ? 1 : 0,
            has_shs     : $('chkSHS').checked    ? 1 : 0,
            active_step : step || currentStep,
            payload     : buildPayload(),
        };

        const res  = await fetch(TF_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data.success) {
            if (data.data?.document_id) docId = data.data.document_id;
            setSaveStatus('saved', 'Saved ✓');
            showToast('Draft saved!', 'circle-check');
            return true;
        } else {
            setSaveStatus('error', 'Save failed');
            showToast(data.message || 'Save failed', 'circle-xmark');
            return false;
        }
    } catch (e) {
        setSaveStatus('error', 'Save failed');
        showToast('Network error — could not save', 'circle-xmark');
        return false;
    }
}

/* ── Debounced auto-save ── */
function scheduleSave() {
    if (!tfMode) return;
    clearTimeout(saveTimer);
    setSaveStatus('saving', 'Unsaved changes…');
    // FIX UX#10: Flash a subtle "saving…" indicator on the active input so
    // users who tab quickly between fields can see changes are being captured.
    const active = document.activeElement;
    if (active && active.classList.contains('tf-input') && !active.readOnly) {
        active.classList.add('tf-input-saving');
        setTimeout(() => active.classList.remove('tf-input-saving'), 1400);
    }
    saveTimer = setTimeout(() => saveDraft(currentStep), 1500);
}

/* ══════════════════════════════════════════════
   SAVED DOCS VIEW — card-based (mirrors calendar)
══════════════════════════════════════════════ */
let allTuitionDocs = [];
let tuitionDocsSearchTerm = '';
let tuitionDocsStatusFilter = 'all';

function setBuilderModeUi(isBuilderOpen) {
    const ph = $('tfPageHeader');
    if (ph) ph.style.display = isBuilderOpen ? 'none' : '';
}

function openTuitionBuilder(documentId = null) {
    setBuilderModeUi(true);
    $('tfSavedDocsView').style.display = 'none';
    $('tfBuilderShell').style.display  = 'flex';

    // Persist the active doc ID so a page refresh re-opens the same document.
    if (documentId) {
        try { sessionStorage.setItem('tf_active_doc_id', String(documentId)); } catch {}
    } else {
        try { sessionStorage.removeItem('tf_active_doc_id'); } catch {}
    }

    if (!documentId) {
        startNewDoc();
        injectTuitionSubmitButton();
        return Promise.resolve();
    }
    return loadSavedDoc(documentId);
}

function backToTuitionDocs() {
    // Reset builder lock state so the next document opens clean.
    _builderLocked = false;
    unlockBuilder();
    hideReturnedBanner();
    docId = null;
    // Clear persisted doc so refresh lands on the docs list, not the builder.
    try { sessionStorage.removeItem('tf_active_doc_id'); } catch {}
    setBuilderModeUi(false);
    $('tfBuilderShell').style.display  = 'none';
    $('tfSavedDocsView').style.display = 'block';
    loadSavedTuitionDocs();
}

async function loadSavedTuitionDocs() {
    const content = $('tfSavedDocsContent');
    if (!content) return;
    content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading your saved documents...</p></div>`;
    try {
        const res  = await fetch(`${TF_API}?action=list`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            throw new Error(data.message || 'Failed to load saved documents.');
        }
        allTuitionDocs = data.data?.documents ?? (Array.isArray(data.data) ? data.data : []);

        // Merge workflow statuses from submissions API.
        // Fetch both 'tuition' (fee increase) and 'no_tuition' (no increase) submission
        // types so that "No Increase" documents also receive their workflow status.
        // Each response is parsed independently so a server error on one type never
        // throws and blocks the other — the outer catch{} remains the safety net.
        try {
            const [subRes, noSubRes] = await Promise.all([
                fetch(`${API_BASE}/school-portal-submissions.php?type=tuition&limit=100`, { credentials: 'include' }),
                fetch(`${API_BASE}/school-portal-submissions.php?type=no_tuition&limit=100`, { credentials: 'include' }),
            ]);
            const safeJson = async (res) => { try { return await res.json(); } catch { return null; } };
            const [subJson, noSubJson] = await Promise.all([safeJson(subRes), safeJson(noSubRes)]);
            const subs = [
                ...(Array.isArray(subJson?.data?.submissions)   ? subJson.data.submissions   : []),
                ...(Array.isArray(noSubJson?.data?.submissions) ? noSubJson.data.submissions : []),
            ];
            if (subs.length && allTuitionDocs.length) {
                const norm = v => String(v || '').toLowerCase().trim();
                subs.sort((a, b) => new Date(b.updated_at || b.submitted_at || 0) - new Date(a.updated_at || a.submitted_at || 0));
                const claimedSubIds = new Set();
                // First pass: resolve all byId matches and mark those submissions as claimed.
                allTuitionDocs.forEach(doc => {
                    const byId = subs.find(s => s.calendar_document_id && String(s.calendar_document_id) === String(doc.id));
                    if (byId) claimedSubIds.add(byId.id);
                });
                allTuitionDocs.forEach(doc => {
                    // 1. Match by document ID (most reliable — avoids cross-doc status bleed)
                    const byId = subs.find(s => s.calendar_document_id && String(s.calendar_document_id) === String(doc.id));
                    // 2. Title match: fallback for older submissions without calendar_document_id,
                    //    or when the doc was returned (admin resets doc.status back to 'draft').
                    //    Only match submissions not already claimed by a byId match above.
                    const isDocSubmitted = ['submitted','Pending Review','pending_review','pending-review','pending'].includes(String(doc.status || ''));
                    const _isReturnedSub = s => {
                        const st = String(s.status || '').toLowerCase().replace(/[\s-]/g, '_');
                        return st === 'returned_for_correction' || st === 'returned' || st === 'rejected';
                    };
                    const titleMatch = !byId ? subs.find(s => !claimedSubIds.has(s.id) && norm(s.title) === norm(doc.title)) : null;
                    const byTitle = (!byId && titleMatch && (isDocSubmitted || _isReturnedSub(titleMatch))) ? titleMatch : null;
                    const best = byId || byTitle;
                    if (!best) return;
                    if (byTitle) claimedSubIds.add(byTitle.id); // mark as claimed so no other doc can steal it
                    doc.workflow_status      = best.status;
                    doc.workflow_updated_at  = best.updated_at || best.submitted_at || null;
                    doc.admin_remarks        = best.remarks || '';
                });
            }
        } catch { /* keep rendering even if submissions lookup fails */ }

        renderSavedTuitionDocs();
    } catch (err) {
        content.innerHTML = `<div class="saved-docs-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${escHtml(err.message || 'Could not load saved documents.')}</p></div>`;
    }
}

function handleTuitionDocsSearch(value) {
    tuitionDocsSearchTerm = (value || '').toLowerCase().trim();
    renderSavedTuitionDocs();
}

function filterSavedDocs(status) {
    tuitionDocsStatusFilter = status;
    document.querySelectorAll('#tfSavedDocsView .filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tf-f-${status}`)?.classList.add('active');
    renderSavedTuitionDocs();
}

function tuitionStatusCategory(rawStatus, editApproved) {
    if (editApproved) return 'returned';
    switch (rawStatus) {
        case 'draft':                   return 'draft';
        case 'submitted':
        case 'pending-review':
        case 'pending':                 return 'pending';
        case 'review':
        case 'endorsed':
        case 'for-endorsement':         return 'review';
        case 'approved':
        case 'released-to-school':      return 'approved';
        case 'returned':
        case 'returned-for-correction':
        case 'rejected':                return 'returned';
        default:                        return 'draft';
    }
}

function renderSavedTuitionDocs() {
    const content = $('tfSavedDocsContent');
    if (!content) return;

    const getEffectiveStatus = doc => {
        // 'Pending Review' is set directly on the tuition document by the server
        // on final submit. Always honour it over workflow_status (which comes from
        // school_submissions and may still carry the old 'submitted' value).
        const docStatus = String(doc.status || '').trim();
        const effective = docStatus === 'Pending Review' ? docStatus : String(doc.workflow_status || docStatus || 'draft');
        return effective.toLowerCase().trim().replace(/[\s_]+/g, '-');
    };
    const statusMeta = status => {
        switch (status) {
            case 'approved':                return { css: 'sdc-status-approved',           label: '<i class="fa-solid fa-circle-check"></i> Approved' };
            case 'review':                  return { css: 'sdc-status-review',             label: '<i class="fa-solid fa-hourglass-half"></i> Under Review' };
            case 'endorsed':                return { css: 'sdc-status-endorsed',           label: '<i class="fa-solid fa-share"></i> Endorsed' };
            case 'rejected':                return { css: 'sdc-status-rejected',           label: '<i class="fa-solid fa-circle-xmark"></i> Needs Revision' };
            case 'returned-for-correction':
            case 'returned':                return { css: 'sdc-status-returned',           label: '<i class="fa-solid fa-rotate-left"></i> Returned for Correction' };
            case 'for-endorsement':         return { css: 'sdc-status-for-endorsement',    label: '<i class="fa-solid fa-paper-plane"></i> For Endorsement' };
            case 'released-to-school':      return { css: 'sdc-status-released-to-school', label: '<i class="fa-solid fa-box-open"></i> Released to School' };
            case 'pending-review':
            case 'pending':                 return { css: 'sdc-status-pending',            label: '<i class="fa-solid fa-clock"></i> Pending Review' };
            case 'submitted':               return { css: 'sdc-status-submitted',          label: '<i class="fa-solid fa-lock"></i> Submitted' };
            default:                        return { css: 'sdc-status-draft',              label: '<i class="fa-solid fa-file-pen"></i> Draft' };
        }
    };

    let filtered = allTuitionDocs;
    if (tuitionDocsStatusFilter !== 'all') {
        filtered = filtered.filter(d => {
            const editApproved = String(d.edit_request_status || '').toLowerCase() === 'approved';
            return tuitionStatusCategory(getEffectiveStatus(d), editApproved) === tuitionDocsStatusFilter;
        });
    }
    if (tuitionDocsSearchTerm) {
        filtered = filtered.filter(d =>
            (d.title || '').toLowerCase().includes(tuitionDocsSearchTerm) ||
            getEffectiveStatus(d).includes(tuitionDocsSearchTerm)
        );
    }

    if (!filtered.length) {
        content.innerHTML = `<div class="saved-docs-empty">
            <i class="fa-solid fa-folder-open" style="font-size:36px;color:#cbd5e1;margin-bottom:10px;"></i>
            <p>${tuitionDocsSearchTerm ? 'No documents match your search.' : 'No saved documents yet. Click <strong>Create New</strong> to get started.'}</p>
        </div>`;
        return;
    }

    content.innerHTML = `<div class="saved-docs-grid">${filtered.map(doc => {
        const docId  = doc.id;
        const title  = escHtml(doc.title || 'Untitled Document');
        const rawStatus = getEffectiveStatus(doc);
        // The SDO's approve_edit endpoint resets the document row to 'draft'
        // but intentionally leaves school_submissions (and therefore
        // workflow_status) untouched, so rawStatus can still read e.g.
        // "approved" or "released-to-school". edit_request_status === 'approved'
        // always wins so the card lets the school open the builder and edit.
        const editApproved = String(doc.edit_request_status || '').toLowerCase() === 'approved';
        const meta   = editApproved
            ? { css: 'sdc-status-returned', label: '<i class="fa-solid fa-unlock"></i> Edit Approved' }
            : statusMeta(rawStatus);
        const isDraft     = rawStatus === 'draft';
        const isSubmitted = ['submitted','pending','pending-review','review','endorsed','for-endorsement','approved','released-to-school'].includes(rawStatus) && !editApproved;
        const isReturned  = rawStatus === 'returned-for-correction' || rawStatus === 'returned' || rawStatus === 'rejected' || editApproved;
        const dateText    = doc.workflow_updated_at
            ? formatDate(doc.workflow_updated_at)
            : doc.updated_at ? formatDate(doc.updated_at) : '—';

        const adminRemarks = (isReturned && doc.admin_remarks) ? escHtml(doc.admin_remarks) : '';
        const remarksHtml  = adminRemarks
            ? `<div class="sdc-remarks-box"><i class="fa-solid fa-comment-dots"></i><div><strong>Admin Remarks:</strong> ${adminRemarks}</div></div>`
            : '';

        const progressLine = !isDraft
            ? `<div class="sdc-progress-line" style="padding:0 14px 8px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
                <span class="sdc-status-badge ${meta.css}">${meta.label}</span>
                ${doc.workflow_updated_at ? `<span style="font-size:10.5px;color:#9ca3af;"><i class="fa-solid fa-clock" style="margin-right:3px;"></i>Updated ${escHtml(formatDate(doc.workflow_updated_at))}</span>` : ''}
               </div>${remarksHtml}`
            : '';

        const modeTag = doc.mode === 'no_increase'
            ? '<span style="font-size:10.5px;background:#f0fdf4;color:#16a34a;border:1px solid #86efac;border-radius:4px;padding:1px 7px;font-weight:700;">No Increase</span>'
            : doc.mode === 'increase'
            ? `<span style="font-size:10.5px;background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;border-radius:4px;padding:1px 7px;font-weight:700;">With Increase${doc.increase_pct ? ' ('+doc.increase_pct+'%)' : ''}</span>`
            : '';

        const canSubmit = isDraft;
        let submitStyle   = '';
        let submitOnclick = '';
        if (isSubmitted) {
            submitStyle   = 'opacity:0.5;cursor:not-allowed;background:#f1f5f9;color:#9ca3af;border:1px solid #e2e8f0;';
            submitOnclick = '';
        } else if (isReturned) {
            submitStyle   = 'background:#d97706;color:#fff;border-color:#d97706;font-weight:700;';
            submitOnclick = `onclick="openTuitionBuilder(${docId}).then(()=>setTimeout(()=>showTuitionSubmitDialog(),400))"`;
        } else {
            submitStyle   = 'background:#15803d;color:#fff;border:none;cursor:pointer;';
            submitOnclick = `onclick="openTuitionBuilder(${docId}).then(()=>showTuitionSubmitDialog())"`;
        }

        return `<div class="saved-doc-card sdc-enhanced">
            <div class="sdc-header">
                <div class="sdc-icon-wrap" style="width:44px;height:44px;border-radius:10px;background:#eff6ff;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <i class="fa-solid fa-file-invoice-dollar" style="font-size:20px;color:#2456a4;"></i>
                </div>
                <div class="sdc-title-block">
                    <div class="sdc-title">${title}</div>
                    <div style="font-size:10px;color:#94a3b8;margin-bottom:2px;">Doc #${docId}</div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
                        <span class="sdc-status-badge ${meta.css}">${meta.label}</span>
                        ${modeTag}
                    </div>
                </div>
                ${isDraft || isReturned ? `<button class="sdc-dots-btn sdc-trash-btn" onclick="deleteTuitionDocument(${docId})" title="Delete">
                    <i class="fa-solid fa-trash-can"></i>
                </button>` : ''}
            </div>
            <div class="sdc-meta"><i class="fa-solid fa-clock"></i> Last updated: ${dateText}</div>
            ${progressLine}
            <div class="sdc-actions">
                <button class="tba-btn sdc-open-btn" onclick="${isSubmitted && !isReturned
                    ? `window.location.href='school-portal-tuition-submitted.html?document_id=${docId}'`
                    : `openTuitionBuilder(${docId})`}">
                    <i class="fa-solid ${isReturned ? 'fa-pen' : isSubmitted ? 'fa-eye' : 'fa-pen'}"></i>
                    ${isReturned ? 'Open & Edit' : isSubmitted ? 'View' : 'Open Builder'}
                </button>
                <button class="tba-btn" style="${submitStyle}" title="${isSubmitted ? 'Already submitted' : 'Submit to SDO'}" ${submitOnclick} ${!canSubmit && !isReturned ? 'disabled' : ''}>
                    <i class="fa-solid fa-paper-plane"></i> ${isReturned ? 'Resubmit' : 'Final Submit'}
                </button>
            </div>
        </div>`;
    }).join('')}</div>`;
}

async function deleteTuitionDocument(documentId) {
    const id = Number(documentId) || 0;
    if (!id) { showToast('Invalid document.', 'circle-xmark'); return; }
    if (!confirm('Delete this tuition fee document? This cannot be undone.')) return;
    try {
        const res  = await fetch(`${TF_API}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Could not delete.');
        if (docId === id) docId = null;
        // BUG FIX: remove this document's leftover supporting-docs checklist
        // key so deleted documents don't leave stale entries in localStorage.
        try { localStorage.removeItem(`tf_supporting_docs_${id}`); } catch { }
        tfSupportingUploads = {};
        _tfUploadsLoadedForDocId = null;
        showToast('Document deleted.', 'circle-check');
        await loadSavedTuitionDocs();
    } catch (err) { showToast(err.message || 'Could not delete.', 'circle-xmark'); }
}

/* Clear all fee inputs before loading a draft */
function resetFeeInputs() {
    [...KINDER_FIELDS, ...ELEM_FIELDS, ...JHS_FIELDS, ...SHS_FIELDS].forEach(f => {
        ['_curr','_prop','_inc'].forEach(suffix => {
            const el = $(f + suffix);
            if (el) el.value = '';
        });
    });
    ['k_total_curr','k_total_prop','k_total_inc',
     'e_total_curr','e_total_prop','e_total_inc',
     'j_total_curr','j_total_prop','j_total_inc',
     's_total_curr','s_total_prop','s_total_inc'].forEach(id => {
        const el = $(id); if (el) el.value = '';
    });
}

async function loadSavedDoc(id) {
    if (!id) return Promise.resolve();
    try {
        const res  = await fetch(`${TF_API}?action=load&id=${id}`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) { showToast('Could not load document', 'circle-xmark'); return; }

        const d = data.data;
        docId = d.id;

        // Switch to builder shell
        setBuilderModeUi(true);
        $('tfSavedDocsView').style.display = 'none';
        $('tfBuilderShell').style.display  = 'flex';
        injectTuitionSubmitButton();

        // Update top-bar school name
        const schoolName = localStorage.getItem('edu_school_name') || '';
        const topBarSub = $('tfTopBarSchoolName');
        if (topBarSub && schoolName) topBarSub.textContent = schoolName;

        resetFeeInputs();

        tfMode = d.mode === 'no_increase' ? 'no-increase' : 'increase';
        $('modeCardIncrease').classList.toggle('selected',   tfMode === 'increase');
        $('modeCardNoIncrease').classList.toggle('selected', tfMode === 'no-increase');
        $('btnStep1Next').disabled = false;
        applyPctFieldVisibility();

        const f = d.payload_json?.form || {};
        $('tfSchoolName').value       = f.school_name       || localStorage.getItem('edu_school_name')    || '';
        $('tfDivision').value         = f.division          || localStorage.getItem('edu_district_name')  || '';
        $('tfAddress').value          = f.address           || localStorage.getItem('edu_school_address') || '';
        $('tfSchoolId').value         = f.school_id         || localStorage.getItem('edu_deped_id')       || localStorage.getItem('edu_school_id_no') || '';
        $('tfGovRecogNo').value       = f.gov_recog         || '';
        $('tfCurrentSY').value        = f.current_sy        || '';
        $('tfProposedSY').value       = f.proposed_sy       || '';
        $('tfIncreasePct').value      = f.increase_pct      || '';
        $('tfPrincipal').value        = f.principal         || localStorage.getItem('edu_elem_principal') || localStorage.getItem('edu_jhs_principal') || localStorage.getItem('edu_shs_principal') || localStorage.getItem('edu_registrar_name') || '';
        $('tfPrincipalContact').value = f.principal_contact || localStorage.getItem('edu_elem_contact')   || localStorage.getItem('edu_jhs_contact')   || localStorage.getItem('edu_shs_contact')   || localStorage.getItem('edu_registrar_contact') || '';
        if ($('tfPrincipalPosition')) $('tfPrincipalPosition').value = f.principal_position || '';
        if ($('tfReviewedBy')) $('tfReviewedBy').value = f.reviewed_by || '';
        if ($('tfReviewedByPosition')) $('tfReviewedByPosition').value = f.reviewed_by_position || '';
        if ($('tfValidatedBy')) $('tfValidatedBy').value = f.validated_by || '';
        if ($('tfValidatedByPosition')) $('tfValidatedByPosition').value = f.validated_by_position || '';
        if ($('tfNotedBy')) $('tfNotedBy').value = f.noted_by || '';
        if ($('tfNotedByPosition')) $('tfNotedByPosition').value = f.noted_by_position || '';

        // FIX #13: restore has_elem and has_shs from saved doc
        $('chkKinder').checked = !!d.has_kinder;
        $('chkElem').checked   = !!d.has_elem;
        $('chkJHS').checked    = !!d.has_jhs;
        $('chkSHS').checked    = !!d.has_shs;

        const customFeeDefs = d.payload_json?.custom_fees || {};

        const k = d.payload_json?.kinder || {};
        // Restore custom fees first so their input elements exist before we set values
        restoreCustomFees('kinder', k, customFeeDefs.kinder);
        KINDER_FIELDS.forEach(fld => { const el = $(fld+'_curr'); if (el) el.value = k[fld+'_curr'] ?? ''; });

        const e = d.payload_json?.elem || {};
        restoreCustomFees('elem', e, customFeeDefs.elem);
        ELEM_FIELDS.forEach(fld => { const el = $(fld+'_curr'); if (el) el.value = e[fld+'_curr'] ?? ''; });

        const j = d.payload_json?.jhs || {};
        restoreCustomFees('jhs', j, customFeeDefs.jhs);
        JHS_FIELDS.forEach(fld => { const el = $(fld+'_curr'); if (el) el.value = j[fld+'_curr'] ?? ''; });

        const s = d.payload_json?.shs || {};
        restoreCustomFees('shs', s, customFeeDefs.shs);
        SHS_FIELDS.forEach(fld => { const el = $(fld+'_curr'); if (el) el.value = s[fld+'_curr'] ?? ''; });

        // Restore SHS Certification extras (track/strand, Section V, SDS)
        if ($('tfSHSTrack'))  $('tfSHSTrack').value  = s.track  || '';
        if ($('tfSHSStrand')) $('tfSHSStrand').value = s.strand || '';
        if ($('tfSHSNotedBy'))         $('tfSHSNotedBy').value         = s.sds_name     || '';
        if ($('tfSHSNotedByPosition')) $('tfSHSNotedByPosition').value = s.sds_position || '';
        if ($('tfSHSNotedByOffice'))   $('tfSHSNotedByOffice').value   = s.sds_office   || '';
        shsDiscounts = (Array.isArray(s.discounts) && s.discounts.length) ? s.discounts : shsDefaultDiscounts();
        renderSHSDiscountInputs();

        // BUG FIX: the "Different fees for Grade 11 and Grade 12" checkbox was
        // never restored on load. Saved per-grade SHS tuition (s11/s12) was
        // therefore populated into hidden fields while the shared "Tuition Fee
        // (annually)" row appeared empty — and toggling the checkbox afterwards
        // would wipe out whichever set of fields the user couldn't see.
        const chkSHSPerGrade = $('chkSHSPerGrade');
        if (chkSHSPerGrade) {
            const perGradeFieldIds = SHS_FIELDS.filter(f => f.startsWith('s11_') || f.startsWith('s12_'));
            const anyPerGradeValue = perGradeFieldIds.some(f => (parseFloat(s[f + '_curr']) || 0) > 0);
            chkSHSPerGrade.checked = anyPerGradeValue;
            tfToggleSHSPerGrade();
        }

        computeKinder(); computeElem(); computeJHS(); computeSHS();

        goToStep(d.active_step || 1);

        /* ── Apply correct lock / banner state based on workflow status ──
           IMPORTANT: run AFTER goToStep() so that any fee inputs rendered
           dynamically by applyModeToStep3() are included in the lock/unlock
           querySelectorAll scan. ── */
        const trackedDoc  = allTuitionDocs.find(doc => Number(doc.id) === Number(id));
        const effectiveStatus = String(trackedDoc?.workflow_status || d.status || '').toLowerCase().replace(/\s+/g, '_');
        const editApproved = String(trackedDoc?.edit_request_status || d.edit_request_status || '').toLowerCase() === 'approved';
        if (editApproved) {
            unlockBuilder();
            hideReturnedBanner();
            _showEditApprovedBanner();
            showToast('Edit approved — you can now make corrections and re-submit', 'circle-info');
        } else if (_isReturnedStatus(effectiveStatus)) {
            unlockBuilder();
            showReturnedBanner(trackedDoc?.admin_remarks || '');
        } else if (['submitted','pending','pending_review','review','endorsed','for_endorsement','approved','released_to_school'].includes(effectiveStatus)) {
            lockBuilderForSubmitted(d.edit_request_status === 'pending');
            hideReturnedBanner();
            showToast('Document loaded — read-only (submitted)', 'circle-info');
        } else {
            unlockBuilder();
            hideReturnedBanner();
            showToast('Document loaded — resuming draft', 'circle-info');
        }

        // Keep the office-managed "Processed and Evaluated By" signatory current for any
        // document that hasn't been finalized yet — see _tfSyncOfficeReviewedBy().
        await _tfSyncOfficeReviewedBy(effectiveStatus);

        // Submitted/read-only views stub out tfSwitchPage(), so hydrate the
        // preview directly here as a fallback after the inputs are restored.
        // BUG FIX: prefer the supporting-docs checklist state saved in the
        // document's payload_json over localStorage. Older documents saved
        // before this fix won't have a `supporting_docs` key — in that case
        // we keep whatever is already in localStorage (previous behavior).
        // Also reject arrays: PHP's json_encode() turns an empty associative
        // array ({}) into [] on the wire, since PHP can't distinguish an
        // empty object from an empty list. Without this check, a document
        // that was first autosaved before any checklist item was ticked
        // would come back as supporting_docs: [], and restoring that into
        // localStorage as an array silently broke every future checklist
        // click (JSON.stringify drops named properties on arrays).
        const savedSDState = d.payload_json?.supporting_docs;
        if (savedSDState && typeof savedSDState === 'object' && !Array.isArray(savedSDState)) {
            saveSupportingDocState(savedSDState);
        }
        tfLiveUpdate();
        renderSupportingDocsChecklist();
    } catch { showToast('Could not load document', 'circle-xmark'); }
}

function startNewDoc() {
    docId          = null;
    tfMode         = null;
    _builderLocked = false;
    // New doc — clear any persisted doc ID so refresh doesn't re-open an old one.
    try { sessionStorage.removeItem('tf_active_doc_id'); } catch {}
    unlockBuilder();
    hideReturnedBanner();
    // Clear the shared "new document" supporting-docs checklist state so it
    // doesn't leak from a previously discarded draft into this new one.
    try { localStorage.removeItem('tf_supporting_docs_new'); } catch { }
    tfSupportingUploads = {};
    _tfUploadsLoadedForDocId = null;
    $('modeCardIncrease').classList.remove('selected');
    $('modeCardNoIncrease').classList.remove('selected');
    $('btnStep1Next').disabled = true;
    applyPctFieldVisibility();
    resetFeeInputs();
    document.querySelectorAll('.tf-input').forEach(el => { if (!el.readOnly) el.value = ''; });
    if ($('tfPrincipalPosition')) $('tfPrincipalPosition').value = '';
    if ($('tfReviewedByPosition')) $('tfReviewedByPosition').value = '';
    shsDiscounts = shsDefaultDiscounts();
    renderSHSDiscountInputs();
    // Re-apply autofill after reset
    prefillTuitionFormFromSession();
    renderSupportingDocsChecklist();
    goToStep(1);
}

/**
 * Split a level's custom fees into their "II. Miscellaneous Fees" and
 * "III. Other Fees" groups (as [label, fieldId] pairs) for the Step 4
 * review table. Custom fees saved before the "fee category" selector was
 * added have no `section` field — they default to "other", matching their
 * previous behavior (always appended at the end, under Other Fees).
 */
function splitCustomFeesBySection(lvl, activeSet) {
    const defs = loadCustomFeesMeta(lvl).filter(d => activeSet.has(d.fieldId));
    const misc  = defs.filter(d => (d.section || 'other') === 'misc').map(d => [d.label, d.fieldId]);
    const other = defs.filter(d => (d.section || 'other') !== 'misc').map(d => [d.label, d.fieldId]);
    return { misc, other };
}

/* ══════════════════════════════════════════════
   REVIEW — STEP 4
══════════════════════════════════════════════ */
function buildReview() {
    const isInc  = tfMode === 'increase';
    const curr   = val('tfCurrentSY')  || '—';
    const prop   = val('tfProposedSY') || '—';
    const pct    = getPct();
    const showK  = $('chkKinder').checked;
    const showE  = $('chkElem').checked;
    const showJ  = $('chkJHS').checked;
    const showS  = $('chkSHS').checked;
    const school = escHtml(val('tfSchoolName')) || '—';

    $('tfReviewSummary').innerHTML = `
    <div class="tf-summary-grid">
        <div class="tf-summary-tile blue">
            <div class="tf-summary-tile-label">Submission Type</div>
            <div class="tf-summary-tile-val" style="font-size:17px;">${isInc ? '📈 With Increase' : '✅ No Increase'}</div>
            <div class="tf-summary-tile-sub">${isInc ? pct + '% rate applied' : 'Fees unchanged'}</div>
        </div>
        <div class="tf-summary-tile green">
            <div class="tf-summary-tile-label">School Year</div>
            <div class="tf-summary-tile-val" style="font-size:17px;">SY ${escHtml(prop)}</div>
            <div class="tf-summary-tile-sub">${school} &nbsp;|&nbsp; Current: SY ${escHtml(curr)}</div>
        </div>
        ${showK ? `
        <div class="tf-summary-tile orange">
            <div class="tf-summary-tile-label">Kindergarten Total</div>
            <div class="tf-summary-tile-val">₱${fmt(num('k_total_prop'))}</div>
            <div class="tf-summary-tile-sub">Current: ₱${fmt(num('k_total_curr'))}</div>
            <div class="tf-summary-tile-diff ${isInc?'up':'same'}">${isInc?'▲ ₱'+fmt(num('k_total_inc'))+' increase':'— No change'}</div>
        </div>` : ''}
        ${showE ? `
        <div class="tf-summary-tile teal">
            <div class="tf-summary-tile-label">Elementary Total</div>
            <div class="tf-summary-tile-val">₱${fmt(num('e_total_prop'))}</div>
            <div class="tf-summary-tile-sub">Current: ₱${fmt(num('e_total_curr'))}</div>
            <div class="tf-summary-tile-diff ${isInc?'up':'same'}">${isInc?'▲ ₱'+fmt(num('e_total_inc'))+' increase':'— No change'}</div>
        </div>` : ''}
        ${showJ ? `
        <div class="tf-summary-tile purple">
            <div class="tf-summary-tile-label">JHS Total (per grade)</div>
            <div class="tf-summary-tile-val">₱${fmt(num('j_total_prop'))}</div>
            <div class="tf-summary-tile-sub">Current: ₱${fmt(num('j_total_curr'))}</div>
            <div class="tf-summary-tile-diff ${isInc?'up':'same'}">${isInc?'▲ ₱'+fmt(num('j_total_inc'))+' increase':'— No change'}</div>
        </div>` : ''}
        ${showS ? `
        <div class="tf-summary-tile red">
            <div class="tf-summary-tile-label">SHS Total (per grade)</div>
            <div class="tf-summary-tile-val">₱${fmt(num('s_total_prop'))}</div>
            <div class="tf-summary-tile-sub">Current: ₱${fmt(num('s_total_curr'))}</div>
            <div class="tf-summary-tile-diff ${isInc?'up':'same'}">${isInc?'▲ ₱'+fmt(num('s_total_inc'))+' increase':'— No change'}</div>
        </div>` : ''}
    </div>`;

    $('reviewKinderPanel').classList.toggle('tf-hidden', !showK);
    if (showK) {
        const kActive = new Set(KINDER_FIELDS);
        const kCustom = splitCustomFeesBySection('kinder', kActive);
        $('reviewKinderBody').innerHTML = buildReviewTable([
            { section: 'I. Tuition Fee' },
            ['Tuition Fee (annually)',         'k_tuition'],
            { section: 'II. Miscellaneous Fees' },
            ...([
                ['Identification Card',            'k_id'],
                ['Insurance',                      'k_ins'],
                ['Handbook',                       'k_handbook'],
                ['Water & Energy Fee',             'k_water'],
                ['Instructional & Test Materials', 'k_itm'],
                ['Medical Supplies',               'k_med'],
            ].filter(([, fid]) => kActive.has(fid))),
            ...kCustom.misc,
            { section: 'III. Other Fees' },
            ...([
                ['Registration Fee',               'k_reg'],
                ['Books',                          'k_books'],
                ['Developmental Fee',              'k_dev'],
            ].filter(([, fid]) => kActive.has(fid))),
            ...kCustom.other,
        ], 'k', curr, prop, isInc, pct);
    }

    $('reviewElemPanel').classList.toggle('tf-hidden', !showE);
    if (showE) {
        const eActive = new Set(ELEM_FIELDS);
        const eCustom = splitCustomFeesBySection('elem', eActive);
        $('reviewElemBody').innerHTML = buildReviewTable([
            { section: 'I. Tuition Fee' },
            ['Tuition Fee (annually)',         'e_tuition'],
            { section: 'II. Miscellaneous Fees' },
            ...([
                ['Identification Card',            'e_id'],
                ['Insurance',                      'e_ins'],
                ['Handbook',                       'e_handbook'],
                ['Laboratory Fee',                 'e_lab'],
                ['Water & Energy Fee',             'e_water'],
                ['Instructional & Test Materials', 'e_itm'],
                ['Medical Supplies',               'e_med'],
            ].filter(([, fid]) => eActive.has(fid))),
            ...eCustom.misc,
            { section: 'III. Other Fees' },
            ...([
                ['Registration Fee',               'e_reg'],
                ['Books',                          'e_books'],
                ['PACEs 1st Deposit (May)',        'e_paces1'],
                ['PACEs 2nd Deposit (October)',    'e_paces2'],
            ].filter(([, fid]) => eActive.has(fid))),
            ...eCustom.other,
        ], 'e', curr, prop, isInc, pct);
    }

    $('reviewJHSPanel').classList.toggle('tf-hidden', !showJ);
    if (showJ) {
        const jActive = new Set(JHS_FIELDS);
        const jCustom = splitCustomFeesBySection('jhs', jActive);
        $('reviewJHSBody').innerHTML = buildReviewTable([
            { section: 'I. Tuition Fee' },
            ['Tuition Fee (annually)',         'j_tuition'],
            { section: 'II. Miscellaneous Fees' },
            ...([
                ['Identification Card',            'j_id'],
                ['Insurance',                      'j_ins'],
                ['Handbook',                       'j_handbook'],
                ['Computer Laboratory Fee',        'j_comp'],
                ['Water & Energy Fee',             'j_water'],
                ['Instructional & Test Materials', 'j_itm'],
                ['Medical Supplies',               'j_med'],
            ].filter(([, fid]) => jActive.has(fid))),
            ...jCustom.misc,
            { section: 'III. Other Fees' },
            ...([
                ['Registration Fee',               'j_reg'],
                ['Books',                          'j_books'],
                ['PACEs 1st Deposit (May)',        'j_paces1'],
                ['PACEs 2nd Deposit (October)',    'j_paces2'],
            ].filter(([, fid]) => jActive.has(fid))),
            ...jCustom.other,
        ], 'j', curr, prop, isInc, pct);
    }

    $('reviewSHSPanel').classList.toggle('tf-hidden', !showS);
    if (showS) {
        const sActive = new Set(SHS_FIELDS);
        const sCustom = splitCustomFeesBySection('shs', sActive);
        // BUG FIX: when "Different fees for Grade 11 and Grade 12" is enabled,
        // the single 's_tuition' row always showed ₱0 here (since the actual
        // amounts live in s11_tuition / s12_tuition). Show the per-grade rows
        // instead so the Step 4 summary matches what was actually entered.
        const isSHSPerGrade = !!document.getElementById('chkSHSPerGrade')?.checked;
        const shsTuitionRows = isSHSPerGrade
            ? [
                ['Tuition Fee — Grade 11 (annually)', 's11_tuition'],
                ['Tuition Fee — Grade 12 (annually)', 's12_tuition'],
              ]
            : [['Tuition Fee (annually)', 's_tuition']];
        $('reviewSHSBody').innerHTML = buildReviewTable([
            { section: 'I. Tuition Fee' },
            ...shsTuitionRows,
            { section: 'II. Miscellaneous Fees' },
            ...([
                ['Identification Card',            's_id'],
                ['Insurance',                      's_ins'],
                ['Handbook',                       's_handbook'],
                ['Computer Laboratory Fee',        's_comp'],
                ['Water & Energy Fee',             's_water'],
                ['Instructional & Test Materials', 's_itm'],
                ['Medical Supplies',               's_med'],
            ].filter(([, fid]) => sActive.has(fid))),
            ...sCustom.misc,
            { section: 'III. Other Fees' },
            ...([
                ['Registration Fee',               's_reg'],
                ['Books',                          's_books'],
                ['Development Fee',                's_dev'],
            ].filter(([, fid]) => sActive.has(fid))),
            ...sCustom.other,
        ], 's', curr, prop, isInc, pct);
    }

    // Render the supporting documents checklist and update submit button hint
    renderSupportingDocsChecklist();
    updateSubmitButtonHint();
}

function buildReviewTable(rows, pfxChar, curr, prop, isInc, pct) {
    const colSpan = isInc ? 5 : 3;

    let html = `<table class="tf-review-table"><thead><tr>
        <th>Fee Item</th>
        <th>Approved SY ${escHtml(curr)}</th>
        <th>Proposed SY ${escHtml(prop)}</th>
        ${isInc ? '<th>Increase (₱)</th><th>Rate</th>' : ''}
    </tr></thead><tbody>`;

    rows.forEach(row => {
        if (!Array.isArray(row)) {
            html += `<tr><td colspan="${colSpan}" class="tf-review-section-header">${escHtml(row.section)}</td></tr>`;
            return;
        }
        const [label, fid] = row;
        const c = num(fid + '_curr');
        const p = num(fid + '_prop');
        const i = p - c;
        html += `<tr>
            <td class="tf-review-item-label">${escHtml(label)}</td>
            <td class="td-curr">₱${fmt(c)}</td>
            <td class="td-prop">₱${fmt(p)}</td>
            ${isInc ? `<td class="td-inc">₱${fmt(i)}</td><td class="td-inc">${pct}%</td>` : ''}
        </tr>`;
    });

    const tc = num(pfxChar + '_total_curr');
    const tp = num(pfxChar + '_total_prop');
    const ti = tp - tc;
    html += `<tr class="tf-review-total-row">
        <td><strong>GRAND TOTAL</strong></td>
        <td class="td-total-curr">₱${fmt(tc)}</td>
        <td class="td-total-prop">₱${fmt(tp)}</td>
        ${isInc ? `<td class="td-total-inc">₱${fmt(ti)}</td><td class="td-total-inc">${pct}%</td>` : ''}
    </tr></tbody></table>`;

    // FIX UX#4: Disable/enable submit based on whether fees are present
    const showK2 = $('chkKinder')?.checked;
    const showE2 = $('chkElem')?.checked;
    const showJ2 = $('chkJHS')?.checked;
    const showS2 = $('chkSHS')?.checked;
    const hasAnyFee = (
        (showK2 && num('k_total_curr') > 0) ||
        (showE2 && num('e_total_curr') > 0) ||
        (showJ2 && num('j_total_curr') > 0) ||
        (showS2 && num('s_total_curr') > 0)
    );
    const submitBtn = $('btnSubmitReview');
    const finalSubmitBtn = document.getElementById('tfBtnFinalSubmitDrop');
    if (submitBtn) {
        submitBtn.disabled = !hasAnyFee;
        submitBtn.title = hasAnyFee ? '' : 'Please enter at least one fee before submitting.';
    }
    if (finalSubmitBtn) {
        finalSubmitBtn.disabled = !hasAnyFee;
    }

    return html;
}

/* ══════════════════════════════════════════════
   SUBMIT — modal dialog pattern (mirrors school calendar)
══════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   SUPPORTING DOCUMENTS CHECKLIST (Step 4)
══════════════════════════════════════════════ */
/* Items in this array are ALWAYS present in the checklist, no matter what
   the database says — they are not editable/removable from the SDO admin
   side, because they're produced directly by this builder and aren't
   something a school "brings" or uploads separately. If a row with the
   same id also exists in the DB, the DB version is ignored in favor of
   this hardcoded one (see mergeHardcodedDocs below), so deleting the row
   in school_supporting_documents has no effect on this item. */
const TF_HARDCODED_DOCS = [
    {
        id   : 'sd_copies',
        label: '3 printed copies of the Comparative Schedule / Breakdown of School Fees',
        hint : 'Print the PDF exported from this builder — 3 sets, placed in one (1) folder.',
        icon : 'fa-print',
        auto : true,
    },
];

/* Fallback used only if the /supporting_docs API call fails (e.g. table
   not migrated yet, or offline). Once school_supporting_documents has
   rows, the API result below always takes priority — except for the
   hardcoded items above, which always win regardless of DB state. */
const TF_SUPPORTING_DOCS_FALLBACK = [
    ...TF_HARDCODED_DOCS,
    {
        id   : 'sd_minutes',
        label: 'Minutes of consultation with Student Government and parents',
        hint : 'Include the attendance sheet and signatures of participants/attendees.',
        icon : 'fa-users',
    },
    {
        id   : 'sd_alloc',
        label: 'Notarized Allocation Program of Expenditures',
        hint : 'A notarized breakdown of how collected tuition fees will be spent.',
        icon : 'fa-file-contract',
    },
    {
        id   : 'sd_financial',
        label: 'CPA-certified Financial Statement',
        hint : 'Shows the financial status of the school, certified by a Certified Public Accountant.',
        icon : 'fa-file-invoice-dollar',
    },
    {
        id   : 'sd_sec',
        label: 'Latest SEC Certificate of Registration',
        hint : 'Proof that the school is a legitimately registered corporation with the SEC.',
        icon : 'fa-certificate',
    },
];

/* Ensures TF_HARDCODED_DOCS are always present in a checklist array,
   regardless of what came back from the database. If the DB happens to
   have a row with the same id, the hardcoded version replaces it (so
   editing/deleting that row server-side can't turn off auto-fulfillment);
   otherwise the hardcoded item is simply prepended. */
function mergeHardcodedDocs(items) {
    const rest = (items || []).filter(d => !TF_HARDCODED_DOCS.some(hd => hd.id === d.id));
    return [...TF_HARDCODED_DOCS, ...rest];
}

/* Populated from school_supporting_documents (via the API) the first time
   the checklist is rendered. Everything below that previously read the
   hardcoded array keeps working unchanged — it's just a `let` now instead
   of a `const`, and gets swapped out once the fetch resolves. */
let TF_SUPPORTING_DOCS = TF_SUPPORTING_DOCS_FALLBACK;
let _sdFetchedForDocType = null; // avoids re-fetching the same doc_type repeatedly
let tfSupportingUploads = {};
let _tfUploadsLoadedForDocId = null;
const TF_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const TF_UPLOAD_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'];

/**
 * Fetches the checklist items for the current fee mode (doc_type) from
 * school_supporting_documents and re-renders once they arrive. Admins can
 * add/edit/remove rows directly in the database — this just reflects
 * whatever is active there, no code changes needed. TF_HARDCODED_DOCS
 * (see above) are always merged back in regardless of what the DB has.
 */
async function fetchSupportingDocsFromServer() {
    const docType = tfMode === 'increase' ? 'tuition_increase'
                  : tfMode === 'no-increase' ? 'tuition_no_increase'
                  : 'all';

    if (_sdFetchedForDocType === docType) return; // already loaded for this mode

    try {
        const res  = await fetch(`${TF_API}?action=supporting_docs&doc_type=${encodeURIComponent(docType)}`, { credentials: 'include' });
        const data = await res.json();
        if (data.success && Array.isArray(data.data?.items) && data.data.items.length) {
            TF_SUPPORTING_DOCS = mergeHardcodedDocs(data.data.items);
            _sdFetchedForDocType = docType;
            renderSupportingDocsChecklist();
        }
    } catch (err) {
        // Offline / table not migrated yet — keep using TF_SUPPORTING_DOCS_FALLBACK.
        console.warn('Supporting documents fetch failed, using fallback list:', err);
    }
}

function formatSupportingUploadSize(bytes) {
    const n = Number(bytes);
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSupportingUploadDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

async function loadSupportingUploads(force = false) {
    if (!docId) {
        tfSupportingUploads = {};
        _tfUploadsLoadedForDocId = null;
        return;
    }
    if (_tfUploadsLoadedForDocId === docId && !force) return;

    try {
        const res  = await fetch(`${TF_API}?action=get_supporting_uploads&tuition_document_id=${encodeURIComponent(docId)}`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) return;
        tfSupportingUploads = {};
        (data.data?.items || []).forEach(row => {
            tfSupportingUploads[row.slug] = row;
        });
        _tfUploadsLoadedForDocId = docId;
        renderSupportingDocsChecklist();
    } catch (err) {
        console.warn('Could not load supporting document uploads:', err);
    }
}

async function uploadSupportingDocument(slug, file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!TF_UPLOAD_ALLOWED_EXT.includes(ext)) {
        showToast('Unsupported file type. Allowed: PDF, JPG, PNG, DOC, DOCX.', 'circle-exclamation');
        return;
    }
    if (file.size > TF_UPLOAD_MAX_BYTES) {
        showToast('File is too large. Maximum size is 10MB.', 'circle-exclamation');
        return;
    }

    if (!docId) {
        const saved = await saveDraft(currentStep);
        if (!saved || !docId) {
            showToast('Could not save your progress. Please save first before uploading.', 'circle-exclamation');
            return;
        }
    }

    const formData = new FormData();
    formData.append('action', 'upload_supporting_document');
    formData.append('tuition_document_id', docId);
    formData.append('slug', slug);
    formData.append('file', file);

    try {
        const res  = await fetch(TF_API, { method: 'POST', credentials: 'include', body: formData });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Upload failed.');
        tfSupportingUploads[slug] = {
            slug,
            original_filename: data.data?.original_filename || file.name,
            file_size: data.data?.file_size || file.size,
            uploaded_at: data.data?.uploaded_at || new Date().toISOString(),
        };
        _tfUploadsLoadedForDocId = docId;
        renderSupportingDocsChecklist();
        showToast('Document uploaded.', 'circle-check');
    } catch (err) {
        showToast('Could not upload document: ' + (err.message || 'Unknown error'), 'circle-exclamation');
    }
}

async function removeSupportingUpload(slug) {
    if (!docId || !tfSupportingUploads[slug]) return;
    if (!confirm('Remove this uploaded document?')) return;
    try {
        const res  = await fetch(TF_API, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_supporting_upload', tuition_document_id: docId, slug }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Could not remove file.');
        delete tfSupportingUploads[slug];
        renderSupportingDocsChecklist();
        showToast('Document removed.', 'circle-check');
    } catch (err) {
        showToast('Could not remove document: ' + (err.message || 'Unknown error'), 'circle-exclamation');
    }
}

function downloadSupportingUpload(slug) {
    if (!docId) return;
    const url = `${TF_API}?action=download_supporting_upload&tuition_document_id=${encodeURIComponent(docId)}&slug=${encodeURIComponent(slug)}`;
    window.open(url, '_blank');
}

const SD_STORAGE_KEY = () => `tf_supporting_docs_${docId || 'new'}`;

function loadSupportingDocState() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SD_STORAGE_KEY()) || '{}');
        // BUG FIX: PHP's json_encode() turns an empty associative array
        // ({}) into [] because PHP can't tell an empty object from an
        // empty array. When that round-trips back from the server (see
        // loadSavedDoc's payload_json.supporting_docs restore) and gets
        // saved here via saveSupportingDocState([]), `state` becomes a
        // real JS Array. Setting state['sd_copies'] = true on an array
        // works (arrays are objects), but JSON.stringify() on an array
        // only serializes numeric indices — named properties are
        // silently dropped — so every checklist click appeared to do
        // nothing and "saved state" always came back as "[]".
        // Treat arrays (and anything else non-plain-object) as empty.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    } catch {
        return {};
    }
}

function saveSupportingDocState(state) {
    try { localStorage.setItem(SD_STORAGE_KEY(), JSON.stringify(state)); } catch { }
}

/* Hardcoded IDs that are always auto-fulfilled by the builder itself
   (e.g. the 3 printed copies of the Comparative Schedule / Breakdown,
   which this builder's own PDF/Word export produces). Derived from
   TF_HARDCODED_DOCS so there's one single source of truth. */
const TF_AUTO_FULFILLED_IDS = TF_HARDCODED_DOCS.map(d => d.id);
function isAutoFulfilledDoc(doc) {
    return !!doc.auto || TF_AUTO_FULFILLED_IDS.includes(doc.id);
}

function renderSupportingDocsChecklist() {
    const list     = $('tfSupportingDocsList');
    const progress = $('tfSupportingDocsProgress');
    if (!list) return;

    // Kick off (or skip, if already done for this mode) the DB fetch.
    // This call resolves async and re-invokes renderSupportingDocsChecklist()
    // itself once data arrives — the render below still runs synchronously
    // with whatever TF_SUPPORTING_DOCS currently holds (fallback list on
    // first paint, live DB list on the follow-up render).
    fetchSupportingDocsFromServer();
    loadSupportingUploads();

    const state   = loadSupportingDocState();
    const checked = TF_SUPPORTING_DOCS.filter(d => isAutoFulfilledDoc(d) || state[d.id]).length;
    const total   = TF_SUPPORTING_DOCS.length;
    const allDone = checked === total;

    list.innerHTML = TF_SUPPORTING_DOCS.map(doc => {
        const auto = isAutoFulfilledDoc(doc);
        const isChecked = auto || !!state[doc.id];
        const upload = tfSupportingUploads[doc.id];
        let uploadHtml = '';
        if (auto) {
            uploadHtml = `<div style="margin-top:8px;color:#166534;font-size:11px;"><i class="fa-solid fa-circle-check"></i> Automatically included — generated by this builder's PDF/Word export. No upload needed.</div>`;
        } else if (!docId) {
            uploadHtml = `<div style="margin-top:8px;color:#94a3b8;font-size:11px;">Save your draft first to enable uploads.</div>`;
        } else if (upload) {
            uploadHtml = `
                <div style="margin-top:8px;padding:8px 10px;border:1px solid #dcfce7;border-radius:8px;background:#f0fdf4;display:flex;flex-direction:column;gap:4px;">
                    <div style="font-size:11px;color:#166534;font-weight:700;"><i class="fa-solid fa-file-circle-check"></i> Uploaded</div>
                    <div style="font-size:11px;color:#334155;word-break:break-word;">${escHtml(upload.original_filename)}</div>
                    <div style="font-size:10.5px;color:#64748b;">${escHtml(formatSupportingUploadSize(upload.file_size))}${upload.file_size && upload.uploaded_at ? ' · ' : ''}${escHtml(formatSupportingUploadDate(upload.uploaded_at))}</div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
                        <button type="button" style="padding:4px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:11px;" onclick="downloadSupportingUpload('${doc.id}')"><i class="fa-solid fa-download"></i> View</button>
                        <button type="button" style="padding:4px 8px;border-radius:6px;border:1px solid #fecaca;background:#fff1f2;color:#b91c1c;cursor:pointer;font-size:11px;" onclick="removeSupportingUpload('${doc.id}')"><i class="fa-solid fa-trash"></i> Remove</button>
                    </div>
                </div>`;
        } else {
            uploadHtml = `
                <div style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
                    <input type="file" id="tfUpload_${doc.id}" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onchange="uploadSupportingDocument('${doc.id}', this.files[0])" />
                    <button type="button" style="padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:11px;" onclick="document.getElementById('tfUpload_${doc.id}').click()"><i class="fa-solid fa-upload"></i> Upload file</button>
                    <span style="font-size:10.5px;color:#94a3b8;">PDF, JPG, PNG, DOC · max 10MB</span>
                </div>`;
        }
        return `
        <div class="tf-sd-item ${isChecked ? 'tf-sd-done' : ''}" id="tf-sd-row-${doc.id}">
            <label class="tf-sd-label" ${auto ? 'style="cursor:default;"' : ''}>
                <input type="checkbox" class="tf-sd-checkbox" data-sdid="${doc.id}"
                    ${isChecked ? 'checked' : ''}
                    ${auto ? 'disabled' : ''}
                    onchange="onSupportingDocToggle('${doc.id}', this.checked)">
                <span class="tf-sd-check-icon">
                    <i class="fa-solid ${isChecked ? 'fa-circle-check' : 'fa-circle'}"></i>
                </span>
                <span class="tf-sd-text">
                    <span class="tf-sd-main"><i class="fa-solid ${doc.icon}"></i> ${escHtml(doc.label)}${auto ? ' <span style="font-weight:600;color:#166534;">(auto)</span>' : ''}</span>
                    <span class="tf-sd-hint">${escHtml(doc.hint)}</span>
                </span>
            </label>
            ${uploadHtml}
        </div>`;
    }).join('');

    if (progress) {
        const pct = Math.round((checked / total) * 100);
        progress.innerHTML = `
        <div class="tf-sd-progress-wrap">
            <div class="tf-sd-progress-bar-bg">
                <div class="tf-sd-progress-bar ${allDone ? 'tf-sd-progress-complete' : ''}"
                     style="width:${pct}%"></div>
            </div>
            <div class="tf-sd-progress-label ${allDone ? 'tf-sd-progress-label-done' : ''}">
                ${allDone
                    ? '<i class="fa-solid fa-circle-check"></i> All supporting documents prepared!'
                    : `<strong>${checked} of ${total}</strong> documents prepared`}
            </div>
        </div>`;
    }
}

function onSupportingDocToggle(id, checked) {
    // Auto-fulfilled items (e.g. sd_copies) are always considered done and
    // aren't user-togglable — the checkbox is rendered disabled, but guard
    // here too in case this is ever called programmatically.
    const doc = TF_SUPPORTING_DOCS.find(d => d.id === id);
    if (doc && isAutoFulfilledDoc(doc)) return;

    const state  = loadSupportingDocState();
    state[id]    = checked;
    saveSupportingDocState(state);
    renderSupportingDocsChecklist();
    updateSubmitButtonHint();
}

function getSupportingDocsMissingCount() {
    const state = loadSupportingDocState();
    return TF_SUPPORTING_DOCS.filter(d => !isAutoFulfilledDoc(d) && !state[d.id]).length;
}

function updateSubmitButtonHint() {
    const missing = getSupportingDocsMissingCount();
    const btn     = $('btnSubmitReview');
    if (!btn) return;
    if (missing > 0) {
        btn.title = `${missing} supporting document${missing > 1 ? 's' : ''} not yet ticked — you can still submit, but prepare them before visiting the SDO.`;
    } else {
        btn.title = '';
    }
}

/* Inject supporting docs warning into the submit dialog */
function renderSupportingDocsDialogWarning() {
    const missing = getSupportingDocsMissingCount();
    const box     = $('tfSdWarning');
    if (!box) return;
    if (missing === 0) {
        box.innerHTML = `
        <div class="tf-sd-dialog-ok">
            <i class="fa-solid fa-circle-check"></i>
            All supporting documents are marked as prepared.
        </div>`;
    } else {
        const names = TF_SUPPORTING_DOCS
            .filter(d => !isAutoFulfilledDoc(d) && !loadSupportingDocState()[d.id])
            .map(d => `<li>${escHtml(d.label)}</li>`)
            .join('');
        box.innerHTML = `
        <div class="tf-sd-dialog-warn">
            <div class="tf-sd-dialog-warn-head">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <strong>${missing} supporting document${missing > 1 ? 's' : ''} not yet prepared</strong>
            </div>
            <p style="margin:4px 0 6px;font-size:11.5px;color:#92400e;">
                You can still submit digitally, but bring these to the SDO office:
            </p>
            <ul class="tf-sd-dialog-list">${names}</ul>
        </div>`;
    }
}

function showTuitionSubmitDialog() {
    let overlay = $('tfSubmitOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id        = 'tfSubmitOverlay';
        overlay.className = 'cal-modal-overlay';
        overlay.onclick   = (e) => { if (e.target === overlay) closeTuitionSubmitDialog(); };
        document.body.appendChild(overlay);
    }

    const schoolName = val('tfSchoolName') || '—';
    const proposedSY = val('tfProposedSY') || '—';

    overlay.innerHTML = `
        <div class="cal-submit-modal">
            <div class="csm-head">
                <div class="csm-icon-wrap">
                    <i class="fa-solid fa-paper-plane csm-icon"></i>
                </div>
                <div class="csm-head-text">
                    <h3>Final Submission</h3>
                    <div class="csm-head-sub">Submit tuition fee document to the SDO</div>
                </div>
                <button class="csm-close" onclick="closeTuitionSubmitDialog()">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="csm-body">
                <div class="csm-stat-row">
                    <div class="csm-stat csm-stat-ok">
                        <div class="csm-stat-num">${escHtml(schoolName)}</div>
                        <div class="csm-stat-label">School</div>
                    </div>
                    <div class="csm-stat csm-stat-ok">
                        <div class="csm-stat-num">SY ${escHtml(proposedSY)}</div>
                        <div class="csm-stat-label">Proposed School Year</div>
                    </div>
                </div>

                <div id="tfComplianceErrors"></div>

                <div id="tfSdWarning" style="margin-bottom:8px;"></div>

                <div id="tfReadyBox" class="csm-ready-box" style="display:none;">
                    <div class="csm-ready-icon"><i class="fa-solid fa-circle-check"></i></div>
                    <div class="csm-ready-text">
                        <strong>Document is ready to submit</strong>
                        <p>Once submitted, you will <strong>not be able to edit</strong> this document unless an administrator returns it for correction.</p>
                    </div>
                </div>

                <label class="csm-confirm-check">
                    <input type="checkbox" id="tfSubmitAgreeCheck">
                    I understand that submitting is final and edits require admin approval.
                </label>
            </div>

            <div class="csm-footer">
                <button class="csm-btn csm-btn-secondary" onclick="closeTuitionSubmitDialog()">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="csm-btn csm-btn-primary" id="tfSubmitBtn" onclick="confirmTuitionSubmit()">
                    <i class="fa-solid fa-paper-plane"></i> Submit to SDO
                </button>
            </div>
        </div>`;
    overlay.style.display = 'flex';

    // Run compliance pre-flight immediately so issues are visible before the user clicks.
    const initialErrors = runDepEdComplianceChecks();
    renderComplianceErrors(initialErrors);

    // Show supporting documents warning
    renderSupportingDocsDialogWarning();
}

function closeTuitionSubmitDialog() {
    const overlay = $('tfSubmitOverlay');
    if (overlay) overlay.style.display = 'none';
}

// ── DepEd compliance pre-flight (JS-side mirror of PHP validateDepEdCompliance) ──
// This runs in the browser before the network call so the user gets instant,
// field-specific feedback.  The PHP gate enforces the same rules authoritatively.

const DEPED_MAX_TUITION_INCREASE_PCT = 15;   // DO 13 s. 2023 cap
const DEPED_MIN_TUITION_FEE          = 1000; // ₱1,000 / year
const DEPED_MAX_TUITION_FEE          = 150000; // ₱150,000 / year

function runDepEdComplianceChecks() {
    const errors = [];

    // 1. Government Recognition Number
    const govRecog = (val('tfGovRecogNo') || '').trim();
    if (!govRecog) {
        errors.push({
            field: 'tfGovRecogNo',
            msg: 'Government Recognition Number is required. Please fill in the form information tab.',
        });
    }

    // 2. Principal + contact
    const principal = (val('tfPrincipal') || '').trim();
    if (!principal) {
        errors.push({
            field: 'tfPrincipal',
            msg: 'Principal / Head of School name is required.',
        });
    }
    const contact = (val('tfPrincipalContact') || '').trim();
    if (!contact) {
        errors.push({
            field: 'tfPrincipalContact',
            msg: 'Principal contact number is required.',
        });
    }

    // 3. Increase percentage cap (DepEd Order No. 13 s. 2023)
    if (tfMode === 'increase') {
        const pct = getPct();
        if (pct > DEPED_MAX_TUITION_INCREASE_PCT) {
            errors.push({
                field: 'tfIncreasePct',
                msg: `Proposed increase of ${pct}% exceeds the DepEd Order No. 13 s. 2023 cap of ${DEPED_MAX_TUITION_INCREASE_PCT}%.`,
            });
        }
    }

    // 4. Plausible tuition fee range per enabled level
    // BUG FIX: SHS supports a "per-grade" tuition mode (separate G11/G12 tuition
    // via s11_tuition_curr / s12_tuition_curr, with s_tuition_curr left empty).
    // The old check only ever looked at s_tuition_curr, so any school using
    // per-grade SHS tuition was always blocked with a false
    // "tuition fee must be greater than ₱0" error. We now check each relevant
    // field set depending on whether per-grade mode is active.
    const levelMap = [
        { flag: 'chkKinder', fields: ['k_tuition_curr'], label: 'Kindergarten' },
        { flag: 'chkElem',   fields: ['e_tuition_curr'], label: 'Elementary' },
        { flag: 'chkJHS',    fields: ['j_tuition_curr'], label: 'Junior High School' },
    ];

    const isSHSPerGrade = !!document.getElementById('chkSHSPerGrade')?.checked;
    levelMap.push({
        flag: 'chkSHS',
        fields: isSHSPerGrade
            ? [
                { field: 's11_tuition_curr', label: 'Senior High School (Grade 11)' },
                { field: 's12_tuition_curr', label: 'Senior High School (Grade 12)' },
              ]
            : ['s_tuition_curr'],
        label: 'Senior High School',
    });

    levelMap.forEach(({ flag, fields, label }) => {
        if (!$(flag)?.checked) return;
        fields.forEach(f => {
            const field    = typeof f === 'string' ? f : f.field;
            const fldLabel = typeof f === 'string' ? label : f.label;
            const tuition  = num(field);
            if (tuition <= 0) {
                errors.push({ field, msg: `${fldLabel} tuition fee must be greater than ₱0.` });
            } else if (tuition < DEPED_MIN_TUITION_FEE) {
                errors.push({ field, msg: `${fldLabel} tuition fee of ₱${fmt(tuition)} appears unrealistically low (minimum ₱${fmt(DEPED_MIN_TUITION_FEE)}). Please verify.` });
            } else if (tuition > DEPED_MAX_TUITION_FEE) {
                errors.push({ field, msg: `${fldLabel} tuition fee of ₱${fmt(tuition)} exceeds the plausible maximum of ₱${fmt(DEPED_MAX_TUITION_FEE)}. Please verify.` });
            }
        });
    });

    return errors;
}

/** Render compliance errors into the submit modal using the new csm-errors design. */
function renderComplianceErrors(errors) {
    const box      = $('tfComplianceErrors');
    const readyBox = $('tfReadyBox');
    const submitBtn = $('tfSubmitBtn');

    if (!box) return;

    if (!errors.length) {
        box.innerHTML    = '';
        if (readyBox)  readyBox.style.display  = 'flex';
        if (submitBtn) submitBtn.classList.remove('has-errors');
        return;
    }

    if (readyBox)  readyBox.style.display = 'none';
    if (submitBtn) submitBtn.classList.add('has-errors');

    box.innerHTML = `
        <div class="csm-errors">
            <div class="csm-errors-head">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <strong>Fix before submitting</strong>
                <span class="csm-errors-count">${errors.length} issue${errors.length > 1 ? 's' : ''}</span>
            </div>
            <ul class="csm-errors-list">
                ${errors.map(e => `<li>${typeof e === 'string' ? e : e.msg}</li>`).join('')}
            </ul>
        </div>`;
}

async function confirmTuitionSubmit() {
    const agreed = $('tfSubmitAgreeCheck')?.checked;
    if (!agreed) { showToast('Please check the confirmation box first.', 'circle-exclamation'); return; }

    // ── DepEd compliance pre-flight ───────────────────────────────────────────
    const complianceErrors = runDepEdComplianceChecks();
    renderComplianceErrors(complianceErrors);
    if (complianceErrors.length) {
        // Highlight the first offending field and bail — user must correct before proceeding.
        // FIX UX#8: Close dialog first so the user can see and fix the field.
        const firstField = complianceErrors[0].field;
        closeTuitionSubmitDialog();
        setTimeout(() => {
            const firstEl = $(firstField);
            if (firstEl) {
                firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                firstEl.focus();
                firstEl.style.outline = '2px solid #dc2626';
                firstEl.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.15)';
                setTimeout(() => { firstEl.style.outline = ''; firstEl.style.boxShadow = ''; }, 3000);
            }
        }, 150);
        return;
    }

    const btn = $('tfSubmitBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…'; }

    // Save first to make sure latest state is persisted
    if (!docId) {
        const saved = await saveDraft(4);
        if (!saved || !docId) {
            showToast('Please save before submitting.', 'circle-xmark');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
            return;
        }
    } else {
        const saved = await saveDraft(4);
        if (!saved) {
            showToast('Could not save before submitting. Please try again.', 'circle-xmark');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
            return;
        }
    }

    try {
        const res  = await fetch(TF_API, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'submit', id: docId }),
        });
        const data = await res.json();

        if (data.success) {
            closeTuitionSubmitDialog();
            showToast('Successfully submitted to SDO!', 'circle-check');

            // Lock the builder immediately so the user sees the read-only state
            // while the redirect timer counts down — mirrors calendar behaviour.
            lockBuilderForSubmitted();
            hideReturnedBanner();

            // BUG FIX: the supporting-docs checklist state is now saved inside
            // payload_json (see buildPayload), so the per-document localStorage
            // copy is no longer needed and would otherwise persist indefinitely.
            try { localStorage.removeItem(`tf_supporting_docs_${docId}`); } catch { }

            /* ── Notify admin/SDO side of tuition submission ──────────────────
               FIX (Bug 3): Previously used `await fetch(...)` but discarded the
               response, then started a 1200 ms redirect timer. On slow connections
               the page navigated away before the fetch completed, silently dropping
               the notification.
               Now uses navigator.sendBeacon() — the browser guarantees delivery
               even after the page unloads, matching the pattern already used in
               the beforeunload handler. sendBeacon takes a Blob so we can set the
               correct Content-Type for the PHP endpoint to parse JSON.
            ── */
            try {
                const notifPayload = JSON.stringify({
                    action            : 'create',
                    notification_type : 'tuition',
                    document_id       : docId,
                    submission_title  : val('tfSchoolName')
                        ? `Tuition Fee – ${val('tfSchoolName')} SY ${val('tfProposedSY')}`
                        : (data.data?.title || 'Tuition Fee Submission'),
                    school_name       : localStorage.getItem('edu_school_name') || '',
                });
                navigator.sendBeacon(
                    `${API_BASE}/notifications.php`,
                    new Blob([notifPayload], { type: 'application/json' })
                );
            } catch (_) { /* non-critical — submit already succeeded */ }

            const _viewDocId = docId;
            setTimeout(() => {
                window.location.href = _viewDocId
                    ? `school-portal-tuition-submitted.html?document_id=${encodeURIComponent(_viewDocId)}`
                    : 'school-portal-tuition-submitted.html';
            }, 1200);
        } else {
            // If PHP returns compliance errors (e.g. tampered payload), surface them.
            const serverErrors = data.data?.compliance_errors;
            if (Array.isArray(serverErrors) && serverErrors.length) {
                renderComplianceErrors(serverErrors.map(msg => ({ msg })));
            } else {
                showToast(data.message || 'Submission failed', 'circle-xmark');
            }
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
        }
    } catch {
        showToast('Network error — submission failed', 'circle-xmark');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to SDO'; }
    }
}

function injectTuitionSubmitButton() {
    // Final Submit button is now permanently in the top bar HTML (id=tfBtnFinalSubmitDrop).
    // Nothing to inject.
}

/* ══════════════════════════════════════════════════════════════════════════
   BUILDER LOCK — submitted documents are read-only
══════════════════════════════════════════════════════════════════════════ */
function lockBuilderForSubmitted(editRequestPending = false) {
    _builderLocked = true;
    const editApprovedBanner = document.getElementById('tfEditApprovedBanner');
    if (editApprovedBanner) editApprovedBanner.style.display = 'none';
    let banner = document.getElementById('tfLockedBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'tfLockedBanner';
        banner.className = 'tf-locked-banner';
        const topBar = document.querySelector('.top-bar');
        if (topBar) topBar.insertAdjacentElement('afterend', banner);
    }
    // BUG FIX: restore the "Request Pending" state on reload (instead of
    // always showing "Request Edit Approval"), so the button can't be used
    // to fire duplicate edit requests while one is already pending.
    const reqBtnHtml = editRequestPending
        ? `<button class="tlb-req-btn tlb-locked" disabled>
               <i class="fa fa-clock"></i> Request Pending
           </button>`
        : `<button class="tlb-req-btn" onclick="requestEditApproval()">
               <i class="fa-solid fa-pen-to-square"></i> Request Edit Approval
           </button>`;
    banner.innerHTML = `
        <i class="fa-solid fa-lock"></i>
        This document has been <strong>submitted for final approval</strong> and is now read-only.
        ${reqBtnHtml}`;
    banner.style.display = 'flex';
    document.querySelectorAll('#tfWorkspace input, #tfWorkspace select, #tfWorkspace textarea').forEach(el => {
        if (el.classList.contains('tf-sd-checkbox')) return; // supporting-docs checklist is always interactive
        el.disabled = true; el.style.opacity = '0.6'; el.style.cursor = 'not-allowed';
    });
    const saveBtn = document.querySelector('.top-bar-actions .tba-primary');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.5'; }
    const finalBtn = document.getElementById('tfBtnFinalSubmitDrop');
    if (finalBtn) finalBtn.style.display = 'none';
}

function unlockBuilder() {
    _builderLocked = false;
    const banner = document.getElementById('tfLockedBanner');
    if (banner) banner.style.display = 'none';
    const editApprovedBanner = document.getElementById('tfEditApprovedBanner');
    if (editApprovedBanner) editApprovedBanner.style.display = 'none';
    const _applyUnlock = () => {
        document.querySelectorAll('#tfWorkspace input, #tfWorkspace select, #tfWorkspace textarea').forEach(el => {
            el.disabled = false; el.style.opacity = ''; el.style.cursor = '';
        });
    };
    _applyUnlock();
    // Re-run after a tick to catch any inputs rendered dynamically (e.g. by applyModeToStep3)
    setTimeout(_applyUnlock, 50);
    // Re-render supporting-docs checklist after unlock so any previously-disabled
    // checkboxes are replaced with fresh, fully-interactive elements.
    setTimeout(() => { if (typeof renderSupportingDocsChecklist === 'function') renderSupportingDocsChecklist(); }, 60);
    const saveBtn = document.querySelector('.top-bar-actions .tba-primary');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
    // Restore dropdown submit item when unlocking
    const dropItem = document.getElementById('tfBtnFinalSubmitDrop');
    if (dropItem) dropItem.style.removeProperty('display');
    if (typeof syncTuitionFinalSubmitVisibility === 'function') syncTuitionFinalSubmitVisibility();
}

/* ══════════════════════════════════════════════════════════════════════════
   RETURNED-FOR-CORRECTION BANNER
══════════════════════════════════════════════════════════════════════════ */
function _isReturnedStatus(status) {
    if (!status) return false;
    const s = String(status).toLowerCase().replace(/[\s-]/g, '_');
    return s === 'returned_for_correction' || s === 'rejected' || s === 'returned';
}

/**
 * Documents in these states haven't been finalized yet, so it's safe (and
 * desirable) to keep office-managed signatory fields — currently just
 * "Processed and Evaluated By" — in sync with whatever the SDO/SMME office has set as the
 * current default in Settings, even overwriting whatever was previously
 * typed/saved on the document. Once a document moves further down the
 * pipeline (submitted, under review, endorsed, approved, etc.) we stop
 * touching it, since the signatory on record should reflect what was true
 * at submission time, not silently change afterward.
 */
function _tfIsAutoSyncableStatus(effectiveStatus) {
    const s = String(effectiveStatus || '').toLowerCase().replace(/[\s-]/g, '_').trim();
    if (s === '' || s === 'draft') return true;
    if (s === 'pending' || s === 'pending_review') return true;
    if (_isReturnedStatus(s)) return true;
    return false;
}

/**
 * Overwrites the Processed and Evaluated By / Validated By / Noted By fields with the
 * office-managed default from the DB, for documents still in draft /
 * pending review / returned for correction. This exists because those
 * fields are locked (read-only) while a document is "Pending Review", so
 * the school can't open the signatory picker themselves to pick up a
 * changed office default — the builder has to do it automatically on
 * open instead. All three roles are office-managed only (see
 * isOfficeOnlyRoleTuition() / signatoryBuilderType() on the PHP side).
 */
async function _tfSyncOfficeReviewedBy(effectiveStatus) {
    if (!_tfIsAutoSyncableStatus(effectiveStatus)) return;
    try {
        await tfLoadSignatories(true); // force a fresh fetch, not the cached copy
    } catch (e) { return; }
    ['reviewed_by', 'validated_by', 'noted_by'].forEach(role => {
        const rows = _tfSignatories[role] || [];
        const officeDefault = rows.find(s => {
            const isOffice = s.scope === 'office' || s.private_school_id === null || s.private_school_id === undefined;
            return isOffice && String(s.is_default) === '1';
        });
        if (!officeDefault) return; // nothing configured in Settings — leave the field as-is
        const fieldMap = SIG_TF_FIELDS[role] || {};
        Object.entries(fieldMap).forEach(([key, inputId]) => {
            const el = $(inputId);
            if (el && officeDefault[key] !== undefined) el.value = officeDefault[key] || '';
        });
    });
    if (typeof tfLiveUpdate === 'function') tfLiveUpdate();
}

function showReturnedBanner(adminRemarks) {
    const lockedBanner = document.getElementById('tfLockedBanner');
    if (lockedBanner) lockedBanner.style.display = 'none';
    const editApprovedBanner = document.getElementById('tfEditApprovedBanner');
    if (editApprovedBanner) editApprovedBanner.style.display = 'none';
    let banner = document.getElementById('tfReturnedBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'tfReturnedBanner';
        banner.className = 'tf-returned-banner';
        const topBar = document.querySelector('.top-bar');
        if (topBar) topBar.insertAdjacentElement('afterend', banner);
    }
    const remarksHtml = adminRemarks
        ? `<div class="trb-remarks-box">
               <div class="trb-remarks-label"><i class="fa-solid fa-comment-dots"></i> Admin Remarks:</div>
               <div class="trb-remarks-text">${escHtml(adminRemarks)}</div>
           </div>`
        : '';
    banner.innerHTML = `
        <i class="fa-solid fa-rotate-left trb-icon"></i>
        <div class="trb-text">
            This document has been <strong>returned for correction</strong>.
            <span>Please review the admin's feedback, make the necessary corrections, and re-submit.</span>
            ${remarksHtml}
        </div>
        <div class="trb-actions">
            <button class="trb-btn trb-btn-submit" onclick="showTuitionSubmitDialog()">
                <i class="fa-solid fa-paper-plane"></i> Resubmit
            </button>
        </div>`;
    banner.style.display = 'flex';
    _builderLocked = false;
    document.querySelectorAll('#tfWorkspace input, #tfWorkspace select, #tfWorkspace textarea').forEach(el => {
        el.disabled = false; el.style.opacity = ''; el.style.cursor = '';
    });
    const saveBtn = document.querySelector('.top-bar-actions .tba-primary');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
    // Re-render the supporting-docs checklist so checkboxes are guaranteed
    // fresh and enabled — not left over from a prior lockBuilderForSubmitted() call.
    if (typeof renderSupportingDocsChecklist === 'function') renderSupportingDocsChecklist();
}

function hideReturnedBanner() {
    const banner = document.getElementById('tfReturnedBanner');
    if (banner) banner.style.display = 'none';
}

function _showEditApprovedBanner() {
    hideReturnedBanner();
    const lockedBanner = document.getElementById('tfLockedBanner');
    if (lockedBanner) lockedBanner.style.display = 'none';
    const existing = document.getElementById('tfEditApprovedBanner');
    if (existing) { existing.style.display = 'flex'; return; }
    const banner = document.createElement('div');
    banner.id = 'tfEditApprovedBanner';
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;background:#f0fdf4;border-bottom:2px solid #86efac;padding:10px 18px;font-size:12.5px;font-weight:600;color:#14532d;flex-wrap:wrap;font-family:var(--font,sans-serif);position:relative;z-index:9;';
    banner.innerHTML = `
        <i class="fa-solid fa-unlock" style="font-size:16px;color:#16a34a;flex-shrink:0;"></i>
        <div style="flex:1;min-width:180px;line-height:1.5;">
            Your edit request has been <strong>approved by the SDO</strong>.
            <span style="display:block;font-weight:400;font-size:11.5px;color:#166534;margin-top:2px;">
                You can now make your corrections and re-submit when ready.
            </span>
        </div>
        <button class="trb-btn trb-btn-submit" onclick="showTuitionSubmitDialog()">
            <i class="fa-solid fa-paper-plane"></i> Resubmit
        </button>`;
    const topBar = document.querySelector('.top-bar');
    if (topBar) topBar.insertAdjacentElement('afterend', banner);
}

/* ══════════════════════════════════════════════════════════════════════════
   EDIT REQUEST — school requests SDO to allow edits after submission
══════════════════════════════════════════════════════════════════════════ */
async function requestEditApproval() {
    if (!docId) {
        showToast('No submitted document found.', 'circle-exclamation'); return;
    }
    const rawReason = window.prompt('Briefly explain why you need to edit this document (optional):', '');
    if (rawReason === null) return;
    const reason = rawReason.trim();
    const btn = document.querySelector('[onclick="requestEditApproval()"]');
    const originalHTML = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Sending…'; }
    try {
        const response = await fetch(TF_API, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'request_edit', id: docId, reason: reason }),
        });
        const data = await response.json();
        if (data.success) {
            showToast(data.message || 'Edit request submitted to SDO.', 'circle-check');
            if (btn) { btn.innerHTML = '<i class="fa fa-clock"></i> Request Pending'; btn.classList.add('tlb-locked'); }
        } else {
            showToast(data.message || 'Request failed. Please try again.', 'circle-xmark');
            if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
        }
    } catch (err) {
        console.error('[requestEditApproval]', err);
        showToast('Network error. Please check your connection.', 'circle-xmark');
        if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
    }
}

/* ══════════════════════════════════════════════
   GENERATE PDF
══════════════════════════════════════════════ */
async function generatePDF() {
    const btn = $('btnGeneratePDF');

    // FIX #10: Check save success before attempting PDF generation
    if (!docId) {
        const saved = await saveDraft(4);
        if (!saved || !docId) {
            showToast('Please save the document first.', 'circle-xmark');
            return;
        }
    } else {
        const saved = await saveDraft(4);
        if (!saved) {
            showToast('Could not save before generating PDF. Please try again.', 'circle-xmark');
            return;
        }
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';

    try {
        const res = await fetch(`${API_BASE}/school-portal-tuition-pdf.php?id=${docId}`, {
            method: 'GET', credentials: 'include',
        });

        if (!res.ok) {
            const ct = res.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) {
                const err = await res.json();
                showToast(err.message || 'PDF generation failed.', 'circle-xmark');
            } else {
                showToast(`Server error ${res.status} — check PHP error log.`, 'circle-xmark');
            }
            return;
        }

        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `TuitionFee_SY${val('tfProposedSY') || 'draft'}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('PDF downloaded! Now click "Submit to SDO" to officially file your document.', 'circle-check');
    } catch (e) {
        console.error('PDF generation error:', e);
        showToast('Network error — could not generate PDF.', 'circle-xmark');
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-file-pdf" style="color:#dc2626;"></i> Generate PDF';
    }
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    // Ensure Step 3 fee inputs exist before wiring autosave listeners.
    tfRenderFeeInputs();

    setBuilderModeUi(false);
    initSidebarProfile();
    loadDashboard();

    // After loading the docs list (which also fetches workflow statuses), check
    // if the user was in the builder before the refresh and re-open that doc.
    loadSavedTuitionDocs().then(() => {
        try {
            const restoredId = sessionStorage.getItem('tf_active_doc_id');
            if (restoredId) openTuitionBuilder(Number(restoredId));
        } catch {}
    });

    $('tfPctFieldGroup').style.display = 'none';

    ['tfSchoolName','tfDivision','tfAddress','tfSchoolId','tfGovRecogNo','tfCurrentSY','tfProposedSY','tfIncreasePct','tfPrincipal','tfPrincipalContact','tfPrincipalPosition','tfReviewedByPosition']
        .forEach(id => $(id)?.addEventListener('input', scheduleSave));

    ['chkKinder','chkElem','chkJHS','chkSHS']
        .forEach(id => $(id)?.addEventListener('change', () => {
            scheduleSave();
            prefillTuitionFormFromSession();
        }));

    [...KINDER_FIELDS, ...ELEM_FIELDS, ...JHS_FIELDS, ...SHS_FIELDS].forEach(f => {
        $(f + '_curr')?.addEventListener('input', scheduleSave);
    });
});



/* ══════════════════════════════════════════════
   INJECTED STYLES — Saved Docs View + Top Bar
══════════════════════════════════════════════ */


/* ══════════════════════════════════════════════
   WORKSPACE — Left nav + live preview
══════════════════════════════════════════════ */

/** FIX UX#2: Update the step progress dots in the left nav. */
function updateStepProgress(step) {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('tfStepDot' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i === step) el.classList.add('active');
        else if (i < step) el.classList.add('done');
    }
}

/* Switch page in left nav */
const TF_PAGE_MAP = {
    cover:       ['tfPgCover'],
    info:        ['tfPgBreakdown','tfPgComparative','tfPgSHS11','tfPgSHS12'],
    breakdown:   ['tfPgBreakdown'],
    comparative: ['tfPgComparative'],
    shs:         ['tfPgSHS11','tfPgSHS12'],
};

function tfSwitchPage(pageKey) {
    // Keep step state aligned with left-nav navigation (autosave stores active_step).
    const pageToStep = { cover: 1, info: 2, breakdown: 3, comparative: 3, shs: 3, review: 4 };
    currentStep = pageToStep[pageKey] || 1;

    // Update left nav active state
    document.querySelectorAll('.doc-side-nav .dsn-btn').forEach(b => b.classList.remove('active'));
    const navBtn = document.getElementById('tfNav' + pageKey.charAt(0).toUpperCase() + pageKey.slice(1));
    if (navBtn) navBtn.classList.add('active');

    // Show correct form section
    document.querySelectorAll('.tf-form-section').forEach(s => s.classList.add('tf-fs-hidden'));
    const sectionMap = { cover:'tfFsCover', info:'tfFsInfo', breakdown:'tfFsSchedule', comparative:'tfFsSchedule', shs:'tfFsSchedule', review:'tfFsReview' };
    const fsId = sectionMap[pageKey] || 'tfFsCover';
    const fs = document.getElementById(fsId);
    if (fs) fs.classList.remove('tf-fs-hidden');

    // Show correct preview pages
    document.querySelectorAll('.tf-doc-page').forEach(p => p.classList.add('tf-pg-hidden'));
    document.querySelectorAll('.tf-doc-page').forEach(p => p.classList.remove('active'));
    const pages = TF_PAGE_MAP[pageKey] || ['tfPgCover'];
    pages.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.remove('tf-pg-hidden'); el.classList.add('active'); }
    });

    // Show/hide sub-pages by level
    tfUpdatePreviewVisibility();
    tfLiveUpdate();

    // Apply mode-specific UI (hide proposed/increase columns when no-increase).
    // Guard: left-nav allows navigation before selecting a mode.
    if (tfMode && currentStep === 3) applyModeToStep3();
    if (tfMode && currentStep === 4) buildReview();

    // FIX UX#2: Update step progress indicator
    updateStepProgress(currentStep);
}

/* Show/hide per-level breakdown & comparative pages */
function tfUpdatePreviewVisibility() {
    const kinderOn = document.getElementById('chkKinder')?.checked;
    const elemOn   = document.getElementById('chkElem')?.checked;
    const jhsOn    = document.getElementById('chkJHS')?.checked;
    const shsOn    = document.getElementById('chkSHS')?.checked;

    const tog = (id, show) => { const el=document.getElementById(id); if(el) el.classList.toggle('tf-pg-hidden', !show); };
    tog('pvBreakKinder', kinderOn);
    tog('pvBreakElem',   elemOn);
    tog('pvBreakJHS',    jhsOn);
    tog('pvBreakSHS',    shsOn);
    tog('pvSupportingDocs', (kinderOn || elemOn || jhsOn || shsOn));
    tog('pvCompKinder',  kinderOn);
    tog('pvCompElem',    elemOn);
    tog('pvCompJHS',     jhsOn);
    tog('pvSHSPage11',   shsOn);
    tog('tfPgSHS11',     shsOn);
    tog('pvSHSPage12',   shsOn);
    tog('tfPgSHS12',     shsOn);
    // Nav button visibility
    document.getElementById('tfNavSHS')?.style && (document.getElementById('tfNavSHS').style.display = shsOn ? '' : 'none');
}

/* Format number as peso amount */
function pvFmt(val) {
    const n = parseFloat(val);
    if (n == null || isNaN(n)) return '—';
    return '₱' + n.toLocaleString('en-PH', {minimumFractionDigits:2,maximumFractionDigits:2});
}
function pvInc(curr, prop) {
    const c = parseFloat(curr)||0, p = parseFloat(prop)||0;
    const diff = p - c;
    return diff === 0 ? '—' : (diff>0?'+':'') + pvFmt(diff);
}
function pvPct(curr, prop) {
    const c = parseFloat(curr)||0, p = parseFloat(prop)||0;
    if (!c) return '—';
    return ((p-c)/c*100).toFixed(2) + '%';
}

/* Apply logo to all letterhead images */
function tfApplyLogoToAll(src) {
    const logoIds = [
        'pvLogoBreakKinder','pvLogoBreakElem','pvLogoBreakJHS',
        'pvLogoCompKinder','pvLogoCompElem','pvLogoCompJHS'
    ];
    const phIds = [
        'pvLogoPhBreakKinder','pvLogoPhBreakElem','pvLogoPhBreakJHS',
        'pvLogoPhCompKinder','pvLogoPhCompElem','pvLogoPhCompJHS'
    ];
    logoIds.forEach(id => {
        const img = document.getElementById(id);
        if (!img) return;
        if (src) { img.src = src; img.style.display = 'block'; }
        else       { img.style.display = 'none'; }
    });
    phIds.forEach(id => {
        const ph = document.getElementById(id);
        if (ph) ph.style.display = src ? 'none' : '';
    });
}

/* Handle logo upload */
function tfHandleLogo(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        logoDataUrl = e.target.result;
        const preview = document.getElementById('tfLogoPreview');
        const icon    = document.getElementById('tfLogoIcon');
        if (preview) { preview.src = logoDataUrl; preview.style.display = 'block'; }
        if (icon)    icon.style.display = 'none';
        tfApplyLogoToAll(logoDataUrl);
        applyCalendarLogo(logoDataUrl);  // Fix #10: removed unnecessary optional chaining — function is always defined
    };
    reader.readAsDataURL(file);
}

/* Live update — reads form → writes to every .pv-* element */
function tfLiveUpdate() {
    const schoolName  = document.getElementById('tfSchoolName')?.value  || '';
    const address     = document.getElementById('tfAddress')?.value      || '';
    const division    = document.getElementById('tfDivision')?.value     || '';
    const schoolId    = document.getElementById('tfSchoolId')?.value     || '';
    const govRecog    = document.getElementById('tfGovRecogNo')?.value   || '';
    const currSY      = document.getElementById('tfCurrentSY')?.value    || '';
    const propSY      = document.getElementById('tfProposedSY')?.value   || '';
    const principal   = document.getElementById('tfPrincipal')?.value    || '';
    const contact     = document.getElementById('tfPrincipalContact')?.value || '';
    const principalPosition = getPrincipalPosition();
    const reviewedBy  = document.getElementById('tfReviewedBy')?.value   || '';
    const reviewedByPosition = getReviewedByPosition();
    const validatedBy = document.getElementById('tfValidatedBy')?.value || '';
    const validatedByPosition = getValidatedByPosition();
    const notedBy = getNotedByName();
    const notedByPosition = getNotedByPosition();
    const shsNotedByName     = getSHSNotedByName();
    const shsNotedByPosition = getSHSNotedByPosition();
    const shsNotedByOffice   = getSHSNotedByOffice();
    const isIncrease  = tfMode === 'increase';

    // Fill all shared text spans
    document.querySelectorAll('.pv-school-name').forEach(el => el.textContent = schoolName);
    document.querySelectorAll('.pv-address').forEach(el => el.textContent = address);
    document.querySelectorAll('.pv-school-id').forEach(el => el.textContent = schoolId);
    document.querySelectorAll('.pv-proposed-sy').forEach(el => el.textContent = propSY);
    document.querySelectorAll('.pv-curr-sy').forEach(el => el.textContent = currSY);
    document.querySelectorAll('.pv-prop-sy').forEach(el => el.textContent = propSY);
    document.querySelectorAll('.pv-principal').forEach(el => el.textContent = principal);
    document.querySelectorAll('.pv-principal-position').forEach(el => el.textContent = principalPosition);
    document.querySelectorAll('.pv-contact').forEach(el => el.textContent = contact);
    document.querySelectorAll('.pv-reviewed-by').forEach(el => el.textContent = reviewedBy);
    document.querySelectorAll('.pv-reviewed-by').forEach(el => {
        const positionEl = el.nextElementSibling;
        if (positionEl && positionEl.textContent !== undefined) {
            positionEl.textContent = reviewedByPosition;
        }
    });
    document.querySelectorAll('.pv-validated-by').forEach(el => el.textContent = validatedBy);
    document.querySelectorAll('.pv-validated-by-position').forEach(el => el.textContent = validatedByPosition);
    document.querySelectorAll('.pv-noted-by').forEach(el => el.textContent = notedBy);
    document.querySelectorAll('.pv-noted-by-position').forEach(el => el.textContent = notedByPosition);
    document.querySelectorAll('.pv-gov-recog').forEach(el => el.textContent = govRecog);

    // Update top-bar school name
    const topBar = document.getElementById('tfTopBarSchoolName');
    if (topBar && schoolName) topBar.textContent = schoolName;

    // Keep computed fields in sync with inputs.
    if (tfMode) {
        computeKinder();
        computeElem();
        computeJHS();
        computeSHS();
    }

    const setText = (sel, val) => document.querySelectorAll(sel).forEach(el => el.textContent = val);
    // Fix #12: removed local 'fmt' shadow — using pvFmt() directly to avoid future divergence with module-level localFmt()
    const localFmt = (n) => (n && !isNaN(n)) ? pvFmt(n) : '';

    // Fix #13: helper that sums all injected custom fee inputs for a given level prefix
    // (e.g. prefix='k' sweeps all [id^="k_custom_"][id$="_curr"] inputs).
    // This is needed because KINDER_FIELDS / ELEM_FIELDS / JHS_FIELDS / SHS_FIELDS only
    // list built-in field IDs; custom fee IDs are pushed in dynamically by
    // injectCustomFeeRow() and are therefore absent from those arrays when the misc
    // sums below run — causing the Miscellaneous column on the comparative schedule
    // to display blank or 0 for schools that replaced all built-in misc fees with
    // custom ones (e.g. Kinder with k_custom_hgl3cx, k_custom_aw6ar5, etc.).
    const sumCustom = (prefix, suffix) =>
        Array.from(document.querySelectorAll(`[id^="${prefix}_custom_"][id$="${suffix}"]`))
             .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);

    // ── KINDER ──
    const kTuCurr = num('k_tuition_curr');
    const kTuProp = num('k_tuition_prop');
    const kMiscCurr = KINDER_FIELDS.filter(f => f !== 'k_tuition').reduce((s,f) => s + num(f + '_curr'), 0)
                    + sumCustom('k', '_curr');
    const kMiscProp = KINDER_FIELDS.filter(f => f !== 'k_tuition').reduce((s,f) => s + num(f + '_prop'), 0)
                    + sumCustom('k', '_prop');
    const kTotProp  = num('k_total_prop');

    // Kinder — comparative schedule
    setText('.pv-k-tf-curr', localFmt(kTuCurr));
    setText('.pv-k-tf-prop', localFmt(kTuProp));
    setText('.pv-k-tf-inc',  isIncrease ? pvInc(kTuCurr, kTuProp) : '—');
    setText('.pv-k-tf-pct',  isIncrease ? pvPct(kTuCurr, kTuProp) : '—');
    setText('.pv-k-mf-curr', localFmt(kMiscCurr));
    setText('.pv-k-mf-prop', localFmt(kMiscProp));
    setText('.pv-k-mf-inc',  isIncrease ? pvInc(kMiscCurr, kMiscProp) : '—');
    setText('.pv-k-mf-pct',  isIncrease ? pvPct(kMiscCurr, kMiscProp) : '—');

    // Kinder — breakdown (itemized)
    setText('.pv-bd-k-tuition',  localFmt(kTuProp));
    setText('.pv-bd-k-id',       localFmt(num('k_id_prop')));
    setText('.pv-bd-k-ins',      localFmt(num('k_ins_prop')));
    setText('.pv-bd-k-handbook', localFmt(num('k_handbook_prop')));
    setText('.pv-bd-k-water',    localFmt(num('k_water_prop')));
    setText('.pv-bd-k-itm',      localFmt(num('k_itm_prop')));
    setText('.pv-bd-k-med',      localFmt(num('k_med_prop')));
    setText('.pv-bd-k-reg',      localFmt(num('k_reg_prop')));
    setText('.pv-bd-k-books',    localFmt(num('k_books_prop')));
    setText('.pv-bd-k-dev',      localFmt(num('k_dev_prop')));
    setText('.pv-bd-k-total',    localFmt(kTotProp));

    // ── ELEMENTARY (repeat per-grade columns) ──
    const eTuCurr = num('e_tuition_curr');
    const eTuProp = num('e_tuition_prop');
    const eMiscCurr = ELEM_FIELDS.filter(f => f !== 'e_tuition').reduce((s,f) => s + num(f + '_curr'), 0)
                    + sumCustom('e', '_curr');
    const eMiscProp = ELEM_FIELDS.filter(f => f !== 'e_tuition').reduce((s,f) => s + num(f + '_prop'), 0)
                    + sumCustom('e', '_prop');
    const eTotProp  = num('e_total_prop');

    [1,2,3,4,5,6].forEach(g => {
        // Elem — comparative schedule
        setText(`.pv-e${g}-tf-curr`, localFmt(eTuCurr));
        setText(`.pv-e${g}-tf-prop`, localFmt(eTuProp));
        setText(`.pv-e${g}-tf-inc`,  isIncrease ? pvInc(eTuCurr, eTuProp) : '—');
        setText(`.pv-e${g}-tf-pct`,  isIncrease ? pvPct(eTuCurr, eTuProp) : '—');
        setText(`.pv-e${g}-mf-curr`, localFmt(eMiscCurr));
        setText(`.pv-e${g}-mf-prop`, localFmt(eMiscProp));
        setText(`.pv-e${g}-mf-inc`,  isIncrease ? pvInc(eMiscCurr, eMiscProp) : '—');
        setText(`.pv-e${g}-mf-pct`,  isIncrease ? pvPct(eMiscCurr, eMiscProp) : '—');

        // Elem — breakdown (itemized)
        setText(`.pv-bd-e${g}-tuition`, localFmt(eTuProp));
        setText(`.pv-bd-e${g}-id`,      localFmt(num('e_id_prop')));
        setText(`.pv-bd-e${g}-ins`,     localFmt(num('e_ins_prop')));
        setText(`.pv-bd-e${g}-handbook`,localFmt(num('e_handbook_prop')));
        setText(`.pv-bd-e${g}-lab`,     localFmt(num('e_lab_prop')));
        setText(`.pv-bd-e${g}-water`,   localFmt(num('e_water_prop')));
        setText(`.pv-bd-e${g}-itm`,     localFmt(num('e_itm_prop')));
        setText(`.pv-bd-e${g}-med`,     localFmt(num('e_med_prop')));
        setText(`.pv-bd-e${g}-reg`,     localFmt(num('e_reg_prop')));
        setText(`.pv-bd-e${g}-books`,   localFmt(num('e_books_prop')));
        setText(`.pv-bd-e${g}-paces1`,  localFmt(num('e_paces1_prop')));
        setText(`.pv-bd-e${g}-paces2`,  localFmt(num('e_paces2_prop')));
        setText(`.pv-bd-e${g}-total`,   localFmt(eTotProp));
    });

    // ── JHS (repeat per-grade columns) ──
    const jTuCurr = num('j_tuition_curr');
    const jTuProp = num('j_tuition_prop');
    const jMiscCurr = JHS_FIELDS.filter(f => f !== 'j_tuition').reduce((s,f) => s + num(f + '_curr'), 0)
                    + sumCustom('j', '_curr');
    const jMiscProp = JHS_FIELDS.filter(f => f !== 'j_tuition').reduce((s,f) => s + num(f + '_prop'), 0)
                    + sumCustom('j', '_prop');
    const jTotProp  = num('j_total_prop');

    [7,8,9,10].forEach(g => {
        const gk = `${g}`;
        // JHS — comparative schedule
        setText(`.pv-j${gk}-tf-curr`, localFmt(jTuCurr));
        setText(`.pv-j${gk}-tf-prop`, localFmt(jTuProp));
        setText(`.pv-j${gk}-tf-inc`,  isIncrease ? pvInc(jTuCurr, jTuProp) : '—');
        setText(`.pv-j${gk}-tf-pct`,  isIncrease ? pvPct(jTuCurr, jTuProp) : '—');
        setText(`.pv-j${gk}-mf-curr`, localFmt(jMiscCurr));
        setText(`.pv-j${gk}-mf-prop`, localFmt(jMiscProp));
        setText(`.pv-j${gk}-mf-inc`,  isIncrease ? pvInc(jMiscCurr, jMiscProp) : '—');
        setText(`.pv-j${gk}-mf-pct`,  isIncrease ? pvPct(jMiscCurr, jMiscProp) : '—');

        // JHS — breakdown (itemized)
        setText(`.pv-bd-j${gk}-tuition`, localFmt(jTuProp));
        setText(`.pv-bd-j${gk}-id`,      localFmt(num('j_id_prop')));
        setText(`.pv-bd-j${gk}-ins`,     localFmt(num('j_ins_prop')));
        setText(`.pv-bd-j${gk}-handbook`,localFmt(num('j_handbook_prop')));
        setText(`.pv-bd-j${gk}-comp`,    localFmt(num('j_comp_prop')));
        setText(`.pv-bd-j${gk}-water`,   localFmt(num('j_water_prop')));
        setText(`.pv-bd-j${gk}-itm`,     localFmt(num('j_itm_prop')));
        setText(`.pv-bd-j${gk}-med`,     localFmt(num('j_med_prop')));
        setText(`.pv-bd-j${gk}-reg`,     localFmt(num('j_reg_prop')));
        setText(`.pv-bd-j${gk}-books`,   localFmt(num('j_books_prop')));
        setText(`.pv-bd-j${gk}-paces1`,  localFmt(num('j_paces1_prop')));
        setText(`.pv-bd-j${gk}-paces2`,  localFmt(num('j_paces2_prop')));
        setText(`.pv-bd-j${gk}-total`,   localFmt(jTotProp));
    });

    // ── SHS certification + SHS breakdown (UNIFIED fee catalog) ──
    const isPerGrade = document.getElementById('chkSHSPerGrade')?.checked;
    const s11TuProp = isPerGrade ? num('s11_tuition_prop') : num('s_tuition_prop');
    const s12TuProp = isPerGrade ? num('s12_tuition_prop') : num('s_tuition_prop');

    const shsItemProp = (suffix, grade) => isPerGrade ? num(`s${grade}_${suffix}_prop`) : num(`s_${suffix}_prop`);
    const shsMiscSuffixes  = SHS_MISC_ITEMS.map(([fid]) => fid.slice(2));   // 'id','ins','exam',...
    const shsOtherSuffixes = SHS_OTHER_ITEMS.map(([fid]) => fid.slice(2)); // 'reg','books','dev'

    // Custom SHS fees aren't per-grade — the same amount applies to both G11
    // and G12 (same simplification already used for the shared/non-per-grade
    // builtin items). Split by section so the Miscellaneous/Other subtotals
    // stay accurate regardless of which section a custom fee was added to.
    const shsCustomDefs = loadCustomFeesMeta('shs');
    const sumShsCustomBySection = section => shsCustomDefs
        .filter(d => (d.section || 'other') === section)
        .reduce((sum, d) => sum + num(d.fieldId + '_prop'), 0);
    const sCustomMiscProp  = sumShsCustomBySection('misc');
    const sCustomOtherProp = sumShsCustomBySection('other');

    const sMiscProp11  = shsMiscSuffixes.reduce((s,suf) => s + shsItemProp(suf, 11), 0) + sCustomMiscProp;
    const sMiscProp12  = shsMiscSuffixes.reduce((s,suf) => s + shsItemProp(suf, 12), 0) + sCustomMiscProp;
    const sOtherProp11 = shsOtherSuffixes.reduce((s,suf) => s + shsItemProp(suf, 11), 0) + sCustomOtherProp;
    const sOtherProp12 = shsOtherSuffixes.reduce((s,suf) => s + shsItemProp(suf, 12), 0) + sCustomOtherProp;

    const sGrand11 = s11TuProp + sMiscProp11 + sOtherProp11;
    const sGrand12 = s12TuProp + sMiscProp12 + sOtherProp12;

    // SHS — Certification of School Fees (pv-s11-* / pv-s12-*) — same item
    // catalog & amounts as the Breakdown page below, so the two official
    // documents always agree with each other.
    [11, 12].forEach(g => {
        const miscProp  = g === 11 ? sMiscProp11  : sMiscProp12;
        const otherProp = g === 11 ? sOtherProp11 : sOtherProp12;
        const grand     = g === 11 ? sGrand11     : sGrand12;
        setText(`.pv-s${g}-tuition`, localFmt(g === 11 ? s11TuProp : s12TuProp));
        shsMiscSuffixes.forEach(suf  => setText(`.pv-s${g}-${suf}`, localFmt(shsItemProp(suf, g))));
        shsOtherSuffixes.forEach(suf => setText(`.pv-s${g}-${suf}`, localFmt(shsItemProp(suf, g))));
        setText(`.pv-s${g}-misctotal`,  localFmt(miscProp));
        setText(`.pv-s${g}-othertotal`, localFmt(otherProp));
        setText(`.pv-s${g}-grandtotal`, localFmt(grand));
    });

    setText('.pv-shs-track',  val('tfSHSTrack'));
    setText('.pv-shs-strand', val('tfSHSStrand'));
    setText('.pv-shs-noted-by', shsNotedByName);
    setText('.pv-shs-noted-by-position', shsNotedByPosition);
    setText('.pv-shs-noted-by-office', shsNotedByOffice);

    // Section V — concessions/discounts, rendered per-grade
    const shsDiscRowHtml = (grade) => (shsDiscounts || [])
        .filter(d => (d.label || '').trim() || (grade === 11 ? d.g11 : d.g12))
        .map(d => `<div class="cert-row cert-indent"><span>${escHtml(d.label || '')}</span><span>${localFmt(grade === 11 ? (d.g11||0) : (d.g12||0))}</span></div>`)
        .join('') || `<div class="cert-row cert-indent"><span style="color:#94a3b8;">None indicated.</span><span></span></div>`;
    document.querySelectorAll('.pv-s11-discounts').forEach(el => el.innerHTML = shsDiscRowHtml(11));
    document.querySelectorAll('.pv-s12-discounts').forEach(el => el.innerHTML = shsDiscRowHtml(12));

    // SHS — breakdown page (itemized, pv-bd-s11-* / pv-bd-s12-*). A couple of
    // items use a different DOM class suffix than their field suffix (legacy
    // naming in the existing breakdown table markup — left as-is).
    const BD_CLASS = { ins: 'insurance', comp: 'complab' };
    const bdClass = suf => BD_CLASS[suf] || suf;
    [11, 12].forEach(g => {
        const tuProp = g === 11 ? s11TuProp : s12TuProp;
        const grand  = g === 11 ? sGrand11  : sGrand12;
        setText(`.pv-bd-s${g}-tuition`, localFmt(tuProp));
        shsMiscSuffixes.forEach(suf  => setText(`.pv-bd-s${g}-${bdClass(suf)}`, localFmt(shsItemProp(suf, g))));
        shsOtherSuffixes.forEach(suf => setText(`.pv-bd-s${g}-${bdClass(suf)}`, localFmt(shsItemProp(suf, g))));
        setText(`.pv-bd-s${g}-grandtotal`, localFmt(grand));
    });

    // Also update level visibility
    tfUpdatePreviewVisibility();

    // ── FIX Bug 2: Update custom fee values in the injected preview rows ──
    // Each custom fee preview row's value cell has class pv-custom-{fieldId}
    // plus a level-specific class. We use the _prop value (proposed/current)
    // which is computed and set in compute*() above.
    ['kinder','elem','jhs','shs'].forEach(lvl => {
        loadCustomFeesMeta(lvl).forEach(def => {
            const propVal = num(def.fieldId + '_prop');
            document.querySelectorAll(`.pv-custom-${def.fieldId}`).forEach(td => {
                td.textContent = localFmt(propVal);
            });
        });
    });

    // Sync deleted-field rows in the HTML preview breakdown tables
    syncPreviewRowVisibility();
}

/* Hook live update into existing fee inputs */
function tfHookFeeInputs() {
    document.querySelectorAll('.tf-input, .tf-input.computed').forEach(el => {
        if (!el.readOnly) el.addEventListener('input', tfLiveUpdate);
    });
    document.querySelectorAll('#chkKinder,#chkElem,#chkJHS,#chkSHS').forEach(el => {
        el.addEventListener('change', () => { tfUpdatePreviewVisibility(); tfLiveUpdate(); });
    });
}

/* Override selectMode to also update preview nav */
const _origSelectMode = window.selectMode;
window.selectMode = function(mode) {
    _origSelectMode?.(mode);
    tfLiveUpdate();
    // Enable continue button
    document.getElementById('btnStep1Next').disabled = false;
};

/* Init workspace on DOM ready */
document.addEventListener('DOMContentLoaded', () => {
    tfSwitchPage('cover');
    tfUpdatePreviewVisibility();
    setTimeout(tfHookFeeInputs, 500);
});



window.addEventListener('beforeunload', () => {
    clearTimeout(saveTimer);
    if (!docId || !tfMode) return;

    const body = JSON.stringify({
        action      : 'save',
        id          : docId,
        mode        : tfMode === 'increase' ? 'increase' : 'no_increase',
        increase_pct: getPct(),
        current_sy  : val('tfCurrentSY'),
        proposed_sy : val('tfProposedSY'),
        school_name : val('tfSchoolName'),
        has_kinder  : $('chkKinder')?.checked ? 1 : 0,
        has_elem    : $('chkElem')?.checked   ? 1 : 0,
        has_jhs     : $('chkJHS')?.checked    ? 1 : 0,
        has_shs     : $('chkSHS')?.checked    ? 1 : 0,
        active_step : currentStep,
        payload     : buildPayload(),
    });
    navigator.sendBeacon(TF_API, new Blob([body], { type: 'application/json' }));
});

/* ══════════════════════════════════════════════════════════════════════════
   INJECTED STYLES — guaranteed delivery matching calendar builder pattern
   (locked banner, returned banner, dropdown, tour, badges)
══════════════════════════════════════════════════════════════════════════ */
(function injectTuitionStyles() {
    if (document.getElementById('tf-all-merged-styles')) return;
    const style = document.createElement('style');
    style.id = 'tf-all-merged-styles';
    style.textContent = `
/* ── LOCKED BANNER ── */
.tf-locked-banner { display:none; align-items:center; gap:10px; padding:10px 18px; background:#eff6ff; border-bottom:2px solid #93c5fd; font-size:12.5px; font-weight:600; color:#1e40af; flex-wrap:wrap; flex-shrink:0; font-family:var(--font,sans-serif); position:relative; z-index:9; }

/* ── FEE SECTION SUB-LABELS (II. Misc / III. Other) in the form panel ── */
.tf-fee-section-sublabel { font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.6px; padding:8px 0 2px; margin-top:4px; border-top:1px dashed #e2e8f0; display:flex; align-items:center; gap:5px; }
.tf-sublabel-roman { display:inline-block; min-width:18px; color:#94a3b8; font-style:italic; }
.tf-locked-banner i { font-size:16px; color:#2563eb; flex-shrink:0; }
.tlb-req-btn { margin-left:auto; padding:5px 12px; border-radius:6px; border:1.5px solid #2563eb; background:#fff; color:#2563eb; font-size:12px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:5px; transition:background .15s; }
.tlb-req-btn:hover { background:#eff6ff; }
.tlb-req-btn.tlb-locked { opacity:0.6; cursor:not-allowed; }

/* ── RETURNED BANNER ── */
.tf-returned-banner { display:none; align-items:center; gap:10px; padding:10px 18px; background:#fffbeb; border-bottom:2px solid #fcd34d; font-size:12.5px; font-weight:600; color:#92400e; flex-wrap:wrap; flex-shrink:0; font-family:var(--font,sans-serif); position:relative; z-index:9; }
.tf-returned-banner i.trb-icon { font-size:18px; color:#d97706; flex-shrink:0; }
.tf-returned-banner .trb-text { flex:1; min-width:180px; line-height:1.5; }
.tf-returned-banner .trb-text span { display:block; font-weight:400; font-size:11.5px; color:#b45309; margin-top:2px; }
.tf-returned-banner .trb-actions { display:flex; gap:8px; flex-wrap:wrap; }
.trb-btn { padding:5px 14px; border-radius:6px; border:none; font-size:12px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:5px; transition:opacity .15s; }
.trb-btn-submit { background:#d97706; color:#fff; }
.trb-btn-submit:hover { opacity:0.88; }
.trb-remarks-box { margin-top:6px; padding:7px 10px; background:#fef3c7; border-radius:6px; border:1px solid #fde68a; font-size:11.5px; }
.trb-remarks-label { font-weight:700; color:#92400e; margin-bottom:3px; }
.trb-remarks-text { color:#78350f; line-height:1.5; white-space:pre-wrap; }

/* ── TOP BAR DROPDOWN ── */
.tba-more-wrap { position:relative; }
.tba-more-btn { padding:7px 11px; font-size:15px; }
.tba-dropdown { display:none; position:absolute; top:calc(100% + 7px); right:0; background:#1e3a5f; border:1px solid rgba(255,255,255,.15); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.4); min-width:190px; z-index:9999; overflow:hidden; animation:tbaDropIn .14s ease; }
.tba-dropdown.open { display:block; }
@keyframes tbaDropIn { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:translateY(0)} }
.tba-drop-item { display:flex; align-items:center; gap:9px; width:100%; padding:10px 14px; background:none; border:none; color:#e2e8f0; font-size:12.5px; font-weight:600; font-family:var(--font); cursor:pointer; text-align:left; transition:background .12s; }
.tba-drop-item:hover { background:rgba(255,255,255,.1); color:#fff; }
.tba-drop-item i { width:15px; text-align:center; color:#93c5fd; font-size:12px; }
.tba-drop-divider { height:1px; background:rgba(255,255,255,.1); margin:3px 0; }
.tba-drop-item-submit { color:#86efac; }
.tba-drop-item-submit i { color:#86efac; }
.tba-drop-item-submit:hover { background:rgba(22,163,74,.18); color:#bbf7d0; }

/* ── EXPORT SOURCE BADGE ── */
.export-source-badge { position:absolute; right:12px; bottom:12px; display:none; align-items:center; gap:6px; font-size:9px; letter-spacing:.4px; text-transform:uppercase; color:rgba(71,85,105,.75); background:rgba(248,250,252,.7); border:1px solid rgba(148,163,184,.45); border-radius:999px; padding:2px 8px; font-family:var(--font); }
.export-source-badge .export-badge-icon { width:16px; height:16px; border-radius:6px; background:linear-gradient(135deg,rgba(88,124,250,.85),rgba(125,88,255,.85)); color:rgba(255,255,255,.92); font-size:9px; font-weight:800; line-height:1; display:inline-flex; align-items:center; justify-content:center; }
.word-exporting .export-source-badge { display:inline-flex; }

/* ── TOUR MODAL ── */
.cal-tour-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.58); z-index:99999; align-items:center; justify-content:center; }
.cal-tour-modal { background:#fff; border-radius:15px; width:90%; max-width:400px; padding:28px 24px 22px; text-align:center; box-shadow:0 22px 72px rgba(0,0,0,.38); position:relative; font-family:var(--font); }
.ctm-close { position:absolute; top:12px; right:14px; background:none; border:none; cursor:pointer; color:#9ca3af; font-size:17px; }
.ctm-close:hover { color:#374151; }
.ctm-icon-wrap { width:58px; height:58px; border-radius:50%; background:#eff6ff; display:flex; align-items:center; justify-content:center; margin:0 auto 14px; }
.ctm-icon { font-size:24px; color:#2456a4; }
.ctm-step-pills { display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:14px; }
.ctm-pip { width:7px; height:7px; border-radius:50%; background:#e2e8f0; transition:all .2s; }
.ctm-pip-active { background:#2456a4; width:18px; border-radius:4px; }
.ctm-pip-done { background:#22c55e; }
.ctm-title { font-size:16px; font-weight:700; color:#0a1f3d; margin:0 0 9px; }
.ctm-body { font-size:13px; color:#4b5563; line-height:1.64; margin:0 0 18px; }
.ctm-footer { display:flex; align-items:center; justify-content:space-between; gap:9px; }
.ctm-counter { font-size:11.5px; color:#94a3b8; }
.ctm-btn { padding:7px 16px; border-radius:7px; font-size:12.5px; font-weight:600; cursor:pointer; border:none; display:flex; align-items:center; gap:5px; font-family:inherit; }
.ctm-btn-ghost { background:#f1f5f9; color:#374151; border:1px solid #e2e8f0; }
.ctm-btn-ghost:hover { background:#e2e8f0; }
.ctm-btn-primary { background:#2456a4; color:#fff; }
.ctm-btn-primary:hover { background:#1e3a5f; }

/* ── SUPPORTING DOCUMENTS CHECKLIST ── */
.tf-sd-item { display:flex; align-items:flex-start; border-radius:8px; padding:9px 10px; margin-bottom:6px; background:#f8fafc; border:1.5px solid #e2e8f0; transition:border-color .15s, background .15s; }
.tf-sd-item.tf-sd-done { background:#f0fdf4; border-color:#bbf7d0; }
.tf-sd-label { display:flex; align-items:flex-start; gap:10px; cursor:pointer; width:100%; }
.tf-sd-checkbox { display:none; }
.tf-sd-check-icon { flex-shrink:0; margin-top:1px; font-size:16px; color:#cbd5e1; transition:color .15s; }
.tf-sd-done .tf-sd-check-icon { color:#16a34a; }
.tf-sd-text { display:flex; flex-direction:column; gap:2px; }
.tf-sd-main { font-size:12.5px; font-weight:600; color:#1e293b; display:flex; align-items:center; gap:6px; }
.tf-sd-main i { color:#2456a4; font-size:11px; }
.tf-sd-done .tf-sd-main { color:#15803d; text-decoration:line-through; text-decoration-color:#86efac; }
.tf-sd-hint { font-size:11px; color:#64748b; line-height:1.5; }
.tf-sd-progress-wrap { display:flex; flex-direction:column; gap:5px; }
.tf-sd-progress-bar-bg { height:6px; background:#e2e8f0; border-radius:99px; overflow:hidden; }
.tf-sd-progress-bar { height:100%; background:#2456a4; border-radius:99px; transition:width .35s ease; }
.tf-sd-progress-bar.tf-sd-progress-complete { background:#16a34a; }
.tf-sd-progress-label { font-size:11.5px; color:#64748b; font-weight:500; display:flex; align-items:center; gap:5px; }
.tf-sd-progress-label-done { color:#15803d; font-weight:700; }
.tf-sd-dialog-ok { display:flex; align-items:center; gap:8px; padding:9px 12px; background:#f0fdf4; border:1.5px solid #bbf7d0; border-radius:8px; font-size:12.5px; font-weight:600; color:#15803d; }
.tf-sd-dialog-ok i { font-size:14px; }
.tf-sd-dialog-warn { padding:10px 12px; background:#fffbeb; border:1.5px solid #fcd34d; border-radius:8px; font-size:12.5px; }
.tf-sd-dialog-warn-head { display:flex; align-items:center; gap:7px; font-weight:700; color:#92400e; margin-bottom:4px; }
.tf-sd-dialog-warn-head i { color:#d97706; }
.tf-sd-dialog-list { margin:0; padding-left:18px; font-size:11.5px; color:#78350f; line-height:1.7; }
`;
    document.head.appendChild(style);
})();
/* ══════════════════════════════════════════════════════════════════════════
   SIGNATORY PICKER — Tuition Fee Builder
   Same pattern as the calendar builder. Roles: principal, reviewed_by.
══════════════════════════════════════════════════════════════════════════ */

let _tfSignatories     = {};
let _tfSigsLoaded      = false;
let _tfSigPickerOpen   = null;

/** Role → field-id mapping for the tuition builder */
const SIG_TF_FIELDS = {
    principal: {
        full_name: 'tfPrincipal',
        contact:   'tfPrincipalContact',
        position_title: 'tfPrincipalPosition',
    },
    reviewed_by: {
        full_name: 'tfReviewedBy',
        position_title: 'tfReviewedByPosition',
    },
    validated_by: {
        full_name: 'tfValidatedBy',
        position_title: 'tfValidatedByPosition',
    },
    noted_by: {
        full_name: 'tfNotedBy',
        position_title: 'tfNotedByPosition',
    },
    // Schools Division Superintendent — "Noted by" on the SHS Certification
    // of Fees page specifically (distinct from the Regional Director 'noted_by'
    // used on the Comparative Schedule pages, and distinct from the calendar
    // builder's own 'sds' role — see signatoryBuilderType() in the PHP).
    shs_noted_by: {
        full_name: 'tfSHSNotedBy',
        position_title: 'tfSHSNotedByPosition',
    },
};

async function tfLoadSignatories(force = false) {
    if (_tfSigsLoaded && !force) return;
    try {
        const res  = await fetch(`${TF_API}?action=get_signatories`, { credentials: 'include' });
        const json = await res.json();
        if (json.success) {
            _tfSignatories = json.data?.grouped || {};
            _tfSigsLoaded  = true;
            _tfApplyDefaultSignatories();
        }
    } catch (e) {
        console.warn('Could not load tuition signatories:', e);
    }
}

function _tfApplyDefaultSignatories() {
    Object.entries(SIG_TF_FIELDS).forEach(([role, fieldMap]) => {
        const defaults = (_tfSignatories[role] || []).filter(s => String(s.is_default) === '1');
        if (!defaults.length) return;
        const def = defaults[0];
        Object.entries(fieldMap).forEach(([key, inputId]) => {
            const el = document.getElementById(inputId);
            if (el && !el.value.trim() && def[key]) el.value = def[key];
        });
    });
    if (typeof tfLiveUpdate === 'function') tfLiveUpdate();
}

function tfOpenSignatoryPicker(role, label) {
    const bar = document.getElementById('sig-picker-' + role);
    if (!bar) return;
    if (_tfSigPickerOpen === role && bar.style.display !== 'none') {
        bar.style.display = 'none';
        _tfSigPickerOpen  = null;
        return;
    }
    if (_tfSigPickerOpen) {
        const old = document.getElementById('sig-picker-' + _tfSigPickerOpen);
        if (old) old.style.display = 'none';
    }
    _tfSigPickerOpen  = role;
    bar.style.display = 'flex';
    _tfRenderPicker(role, label, bar);
    if (!_tfSigsLoaded) tfLoadSignatories().then(() => _tfRenderPicker(role, label, bar));
}

function _tfRenderPicker(role, label, bar) {
    const rows = _tfSignatories[role] || [];
    const escH = v => String(v||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const escA = v => String(v||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');

    const itemsHtml = rows.length
        ? rows.map(s => {
            const defBadge = String(s.is_default)==='1' ? `<span class="sig-picker-default-badge">Default</span>` : '';
            const isOffice = s.scope === 'office' || (s.private_school_id === null || s.private_school_id === undefined);
            const scopeBadge = `<span class="sig-picker-scope-badge ${isOffice ? 'is-office' : 'is-school'}">${isOffice ? 'Office-managed' : 'School'}</span>`;
            const sub = [s.position_title, s.office, s.city].filter(Boolean).join(' · ');
            // Office-managed rows (created via Settings, private_school_id
            // NULL) can only be deleted from Settings, not from here.
            return `
                <div class="sig-picker-option${String(s.is_default)==='1'?' is-default':''}">
                    <div class="sig-picker-option-info">
                        <div class="sig-picker-name">${escH(s.full_name)} ${defBadge} ${scopeBadge}</div>
                        ${sub?`<div class="sig-picker-sub">${escH(sub)}</div>`:''}
                    </div>
                    <div class="sig-picker-actions">
                        <button class="sig-picker-use-btn" onclick="_tfApplySignatory('${escA(role)}',${Number(s.id)})">
                            <i class="fa-solid fa-check"></i> Use
                        </button>
                        ${!isOffice ? `
                        <button class="sig-picker-del-btn" onclick="_tfDeleteSignatory(${Number(s.id)},'${escA(role)}','${escA(label)}')" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>` : ''}
                    </div>
                </div>`;
        }).join('')
        : `<div class="sig-picker-empty"><i class="fa-solid fa-circle-info"></i> No saved signatories yet for <strong>${escH(label)}</strong>.<br>Fill in the fields below and click <em>Save as Signatory</em>.</div>`;

    bar.innerHTML = `
        <div class="sig-picker-label"><i class="fa-solid fa-address-book"></i> Saved ${escH(label)} Signatories</div>
        <div class="sig-picker-list">${itemsHtml}</div>`;
}

function _tfApplySignatory(role, id) {
    const rows = _tfSignatories[role] || [];
    const sig  = rows.find(s => Number(s.id) === Number(id));
    if (!sig) return;
    const fieldMap = SIG_TF_FIELDS[role] || {};
    Object.entries(fieldMap).forEach(([key, inputId]) => {
        const el = document.getElementById(inputId);
        if (el && sig[key] !== undefined) el.value = sig[key] || '';
    });
    if (typeof tfLiveUpdate === 'function') tfLiveUpdate();
    const bar = document.getElementById('sig-picker-' + role);
    if (bar) bar.style.display = 'none';
    _tfSigPickerOpen = null;
}

async function _tfDeleteSignatory(id, role, label) {
    if (!confirm(`Delete this ${label} signatory?`)) return;
    try {
        const res  = await fetch(TF_API, {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'delete_signatory', id }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message||'Delete failed.');
        if (_tfSignatories[role]) _tfSignatories[role] = _tfSignatories[role].filter(s=>Number(s.id)!==Number(id));
        const bar = document.getElementById('sig-picker-' + role);
        if (bar) _tfRenderPicker(role, label, bar);
    } catch (e) { alert('Could not delete signatory: ' + e.message); }
}

function tfSaveCurrentSignatory(role, label) {
    const fieldMap = SIG_TF_FIELDS[role] || {};
    const current  = {};
    Object.entries(fieldMap).forEach(([key, inputId]) => {
        const el = document.getElementById(inputId);
        current[key] = el ? el.value.trim() : '';
    });
    if (!current.full_name) { alert('Please fill in the name field first.'); return; }

    const escH = v => String(v||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const escA = v => String(v||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');

    const existing = (_tfSignatories[role] || []);
    const dupeCheck = existing.find(s => s.full_name.trim().toLowerCase() === (current.full_name||'').toLowerCase());

    const overlay = document.createElement('div');
    overlay.className = 'sig-modal-overlay';
    overlay.id = 'tfSigModalOverlay';
    overlay.innerHTML = `
        <div class="sig-modal" role="dialog" aria-modal="true">
            <div class="sig-modal-title"><i class="fa-solid fa-floppy-disk"></i> Save ${escH(label)} Signatory</div>
            ${dupeCheck?`<div style="background:#fef9c3;border:1px solid #fde047;border-radius:7px;padding:8px 11px;font-size:12px;color:#713f12;margin-bottom:10px;"><i class="fa-solid fa-triangle-exclamation"></i> A signatory with this name already exists.</div>`:''}
            <div class="fg"><label>Full Name & Credentials</label>
                <input id="tfSigModalName" value="${escA(current.full_name||'')}" /></div>
            <div class="fg"><label>Position / Title <span style="color:#94a3b8">(optional)</span></label>
                <input id="tfSigModalPos" value="" /></div>
            <div class="fg"><label>Office <span style="color:#94a3b8">(optional)</span></label>
                <input id="tfSigModalOfc" value="" /></div>
            <div class="fg"><label>Contact <span style="color:#94a3b8">(optional)</span></label>
                <input id="tfSigModalContact" value="${escA(current.contact||'')}" /></div>
            <label class="sig-modal-check">
                <input type="checkbox" id="tfSigModalDefault" ${!existing.length?'checked':''} />
                Set as default for <strong>${escH(label)}</strong>
            </label>
            <div class="sig-modal-btns">
                <button class="sig-modal-cancel" onclick="document.getElementById('tfSigModalOverlay')?.remove()">Cancel</button>
                <button class="sig-modal-save" id="tfSigModalSaveBtn" onclick="_tfSubmitSigModal('${escA(role)}','${escA(label)}')">
                    <i class="fa-solid fa-floppy-disk"></i> Save
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('tfSigModalName')?.focus();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function _tfSubmitSigModal(role, label) {
    const name    = document.getElementById('tfSigModalName')?.value.trim()    || '';
    const pos     = document.getElementById('tfSigModalPos')?.value.trim()     || '';
    const ofc     = document.getElementById('tfSigModalOfc')?.value.trim()     || '';
    const contact = document.getElementById('tfSigModalContact')?.value.trim() || '';
    const isDef   = document.getElementById('tfSigModalDefault')?.checked ? 1 : 0;
    if (!name) { alert('Full name is required.'); return; }

    const btn = document.getElementById('tfSigModalSaveBtn');
    if (btn) { btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
        const res  = await fetch(TF_API, {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'save_signatory', role, full_name:name, position_title:pos, office:ofc, contact, is_default:isDef }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message||'Save failed.');

        const newRow = { id:json.data?.id, role, full_name:name, position_title:pos, office:ofc, city:'', contact, is_default:isDef };
        if (isDef && _tfSignatories[role]) _tfSignatories[role].forEach(s=>s.is_default=0);
        if (!_tfSignatories[role]) _tfSignatories[role]=[];
        _tfSignatories[role].push(newRow);

        document.getElementById('tfSigModalOverlay')?.remove();

        if (_tfSigPickerOpen === role) {
            const bar = document.getElementById('sig-picker-' + role);
            if (bar) _tfRenderPicker(role, label, bar);
        }
    } catch (e) {
        alert('Could not save signatory: ' + e.message);
        if (btn) { btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-floppy-disk"></i> Save'; }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => tfLoadSignatories(), 600);
});
