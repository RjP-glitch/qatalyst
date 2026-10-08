const API_BASE = CONFIG.API_URL;

let pendingSchoolLogoDataUrl = '';
let pendingProfilePhotoDataUrl = '';
let hasSelectedNewSchoolLogo = false;
let hasSelectedNewProfilePhoto = false;
const PACKET_SAFE_IMAGE_BYTES = 700 * 1024;

let currentSchoolMode = 'public'; // 'public' | 'private'
let schoolApproved = false;

function isPrivateType(raw) {
    return String(raw || '').toLowerCase().includes('private');
}

function normalizeDateForInput(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return '';
    return new Date(t).toISOString().slice(0, 10);
}

async function ensureDistrictOptions(selectEl) {
    if (!selectEl || selectEl.dataset.loaded === '1') return;
    selectEl.dataset.loaded = '1';

    const addOption = (district) => {
        const opt = document.createElement('option');
        opt.value = String(district.id);
        opt.textContent = district.name;
        selectEl.appendChild(opt);
    };

    try {
        const res = await fetch(`${API_BASE}/get-districts.php`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success || !Array.isArray(data.data)) throw new Error('Bad response');
        data.data.filter(d => d.id && d.name).forEach(addOption);
    } catch {
        selectEl.dataset.loaded = '';
        showProfileSettingsMsg('error', 'Could not load districts. Please reload before saving school settings.');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getInitials(name) {
    return (name || '?').split(' ').map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildSchoolAddress(street, barangay, city) {
    return [street, barangay, city].filter(part => part && String(part).trim() !== '').join(', ');
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

// Like setEl, but for optional fields: shows a muted "Not specified" instead
// of a bare "—" when there's genuinely no data (as opposed to still loading).
function setElOrEmpty(id, val, emptyText) {
    const el = document.getElementById(id);
    if (!el) return;
    const has = val !== null && val !== undefined && String(val).trim() !== '';
    el.textContent = has ? val : (emptyText || 'Not specified');
    el.classList.toggle('is-empty', !has);
}

function setInput(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
}

function setSelectValue(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val || '';
}

// ── Avatar ────────────────────────────────────────────────────────────────────
function applyProfilePhoto(dataUrl, initials) {
    const fallback = initials || getInitials(localStorage.getItem('edu_full_name') || '');
    ['sidebarAvatar', 'profileAvatar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (dataUrl) {
            el.innerHTML = `<img src="${dataUrl}" alt="Profile photo">`;
        } else {
            el.textContent = fallback;
        }
    });
}

// ── Populate levels checkboxes ────────────────────────────────────────────────
function populateLevels(rawLevels) {
    let arr = [];
    try { arr = Array.isArray(rawLevels) ? rawLevels : JSON.parse(rawLevels || '[]'); } catch { arr = []; }
    ['pre', 'elem', 'jhs', 'shs'].forEach(key => {
        const cb = document.getElementById('lvl' + key.charAt(0).toUpperCase() + key.slice(1));
        if (cb) cb.checked = arr.includes(key);
    });
}

function getSelectedLevels() {
    return ['Pre', 'Elem', 'Jhs', 'Shs']
        .map(k => document.getElementById('lvl' + k))
        .filter(cb => cb && cb.checked)
        .map(cb => cb.value);
}

// ── Populate sidebar/profile from localStorage ────────────────────────────────
function initUI() {
    const _fullName     = localStorage.getItem('edu_full_name')      || '—';
    const _userEmail    = localStorage.getItem('edu_email')           || '—';
    const _role         = localStorage.getItem('edu_role')            || '—';
    const _schoolName   = localStorage.getItem('edu_school_name')     || '—';
    const _schoolAddress = localStorage.getItem('edu_school_address') || '';
    const _districtName = localStorage.getItem('edu_district_name')   || '—';
    const _sidebarLine   = _schoolAddress || _districtName;
    const _photo        = localStorage.getItem('edu_profile_picture') || '';

    pendingProfilePhotoDataUrl = _photo;
    applyProfilePhoto(_photo, getInitials(_fullName));

    setEl('sidebarName',       _fullName || _userEmail);
    setEl('sidebarRole',       _role);
    setEl('sidebarSchoolName', _schoolName);
    setEl('sidebarDistrict',   _sidebarLine);
    setEl('profileName',       _fullName);
    setEl('profileRoleBadge',  _role);
    setEl('profileEmail',      _userEmail);
    setEl('pFullName',         _fullName);
    setEl('pEmail',            _userEmail);
    setEl('pRole',             _role);

    const _verifiedIcon = document.getElementById('pEmailVerifiedIcon');
    if (_verifiedIcon) _verifiedIcon.style.display = localStorage.getItem('edu_email_verified') === '1' ? '' : 'none';

    setInput('editSchoolIdNo', localStorage.getItem('edu_school_id_no'));

    const savedLogo = localStorage.getItem('edu_school_logo') || '';
    pendingSchoolLogoDataUrl = savedLogo;
    hasSelectedNewSchoolLogo = false;
    hasSelectedNewProfilePhoto = false;
    renderSchoolLogoPreview(savedLogo);
}

async function applyDirectoryModeAndPopulate(d) {
    const linkedType = d?.user?.school_type || localStorage.getItem('edu_school_type') || d?.school?.type || '';
    currentSchoolMode = isPrivateType(linkedType) ? 'private' : 'public';
    try {
        const typeToStore = String(d?.user?.school_type || '').trim() || String(d?.school?.type || '').trim();
        localStorage.setItem('edu_school_type', typeToStore);
    } catch (_) {}
    try {
        // Use private_school_id for private users so the correct ID is stored.
        const isPriv = isPrivateType(d?.user?.school_type || d?.school?.type || '');
        const idToStore = isPriv
            ? (String(d?.user?.private_school_id || '').trim() || String(d?.school?.id || '').trim())
            : (String(d?.user?.school_id || '').trim()         || String(d?.school?.id || '').trim());
        localStorage.setItem('edu_school_id', idToStore);
    } catch (_) {}

    const pubWrap  = document.getElementById('publicDirectoryFields');
    const privWrap = document.getElementById('privateDirectoryFields');
    if (pubWrap)  pubWrap.style.display  = currentSchoolMode === 'public'  ? 'block' : 'none';
    if (privWrap) privWrap.style.display = currentSchoolMode === 'private' ? 'block' : 'none';

    if (currentSchoolMode === 'public') {
        setInput('editPubHeadName',     d?.school?.public_head_name);
        setInput('editPubPosition',     d?.school?.public_position);
        setInput('editPubSchoolId',     d?.school?.public_school_id);
        setInput('editPubSchoolName',   d?.school?.public_school_name || d?.school?.name);
        setInput('editPubContact',      d?.school?.public_contact_number);
        setInput('editPubEmail',        d?.school?.public_email);
        setInput('editPubBirthdate',    normalizeDateForInput(d?.school?.public_birthdate));
        setInput('editPubFirstDay',     normalizeDateForInput(d?.school?.public_first_day_station));

        const distEl = document.getElementById('editPubDistrict');
        await ensureDistrictOptions(distEl);
        setSelectValue('editPubDistrict', String(d?.user?.district_id || ''));
    } else {
        setInput('editPrivSchoolName',       d?.school?.name);
        setSelectValue('editPrivStatus',     d?.school?.status);
        setInput('editPrivElemAdmin',        d?.school?.elem_principal);
        setInput('editPrivElemContact',      d?.school?.elem_contact);
        setInput('editPrivJhsAdmin',         d?.school?.jhs_principal);
        setInput('editPrivJhsContact',       d?.school?.jhs_contact);
        setInput('editPrivShsAdmin',         d?.school?.shs_principal);
        setInput('editPrivShsContact',       d?.school?.shs_contact);
        setInput('editPrivRegistrarName',    d?.school?.registrar_name);
        setInput('editPrivRegistrarContact', d?.school?.registrar_contact);
        // Address fields
        setInput('editPrivStreet',           d?.school?.street_address);
        setInput('editPrivBarangay',         d?.school?.barangay);
        setInput('editPrivCity',             d?.school?.city);
        // Levels checkboxes
        populateLevels(d?.school?.levels);
    }
}

// ── Pending badge + session check ─────────────────────────────────────────────
async function loadPendingBadge() {
    try {
        const res  = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        const data = await res.json();

        if (!data.success) {
            if (res.status === 401) { window.location.href = 'school-portal.html'; return; }
            return;
        }

        const d = data.data;
        schoolApproved = d.user?.school_approved === true;
        localStorage.setItem('edu_school_approved', schoolApproved ? '1' : '0');

        // SDO personnel guard
        if (d.user?.account_type === 'sdo_personnel') {
            window.location.href = 'school-portal.html'; return;
        }

        // Seed localStorage from API response
        localStorage.setItem('edu_user_id',         d.user.id                      || '');
        localStorage.setItem('edu_email',           d.user.email                   || '');
        localStorage.setItem('edu_full_name',       d.user.full_name               || '');
        localStorage.setItem('edu_role',            d.user.role                    || 'teacher');
        localStorage.setItem('edu_account_type',    d.user.account_type            || 'portal_user');
        localStorage.setItem('edu_profile_picture', d.user.profile_picture         || '');
        localStorage.setItem('edu_email_verified',  d.user.email_verified ? '1' : '0');
        localStorage.setItem('edu_school_name',     d.school?.name                 || '');
        localStorage.setItem('edu_district_name',   d.school?.district             || '');
        localStorage.setItem('edu_school_address',  buildSchoolAddress(d.school?.street_address, d.school?.barangay, d.school?.city));
        localStorage.setItem('edu_grade',           d.school?.grade                || '');
        localStorage.setItem('edu_school_id_no',    d.school?.school_id_no         || '');
        localStorage.setItem('edu_school_logo',     d.school?.school_logo          || '');
        localStorage.setItem('edu_school_id',        d.user?.school_id              || d.school?.id   || '');
        localStorage.setItem('edu_school_type',      d.user?.school_type            || d.school?.type || '');

        // Refresh UI with fresh data
        initUI();
        if (typeof initPortalPermissions === 'function') initPortalPermissions();

        // ── Read-only info fields ─────────────────────────────────────────────
        setElOrEmpty('pType',       d.school?.type);
        setElOrEmpty('pDepedId',    d.school?.deped_id);
        setElOrEmpty('pSchoolIdNo', d.school?.school_id_no || localStorage.getItem('edu_school_id_no'));
        setEl('pStatTotal',    d.stats?.total    ?? '—');
        setEl('pStatApproved', d.stats?.approved ?? '—');
        setElOrEmpty('pSchool',   d.school?.name, 'Not on file');
        setElOrEmpty('pDistrict', d.school?.district);

        // Email verification is now tracked via users.email_verified.
        const verifiedIcon = document.getElementById('pEmailVerifiedIcon');
        if (verifiedIcon) verifiedIcon.style.display = d.user?.email_verified ? '' : 'none';

        // ── Populate editable directory fields ───────────────────────────────
        await applyDirectoryModeAndPopulate(d);
        document.querySelectorAll('#publicDirectoryFields input, #publicDirectoryFields select, #privateDirectoryFields input, #privateDirectoryFields select, #editSchoolLogoFile')
            .forEach(el => { el.disabled = !schoolApproved; });

        // ── Pending badge ─────────────────────────────────────────────────────
        const pending = Number(d.stats?.pending ?? 0);
        const badge = document.getElementById('pendingBadge');
        if (badge) {
            badge.textContent = pending;
            badge.style.display = pending > 0 ? 'inline-flex' : 'none';
        }

    } catch (err) {
        console.error('loadPendingBadge error:', err);
    } finally {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }
}

// ── Session check (bfcache + tab restore) ─────────────────────────────────────
async function checkSession() {
    try {
        const res = await fetch(`${API_BASE}/school-portal-dashboard.php`, { credentials: 'include' });
        if (res.status === 401) window.location.href = 'school-portal.html';
    } catch { }
}

// ── Image helpers ─────────────────────────────────────────────────────────────
function dataUrlByteSize(dataUrl) {
    const base64 = String(dataUrl || '').split(',')[1] || '';
    if (!base64) return 0;
    const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(String(ev.target?.result || ''));
        reader.onerror = () => reject(new Error('Could not read image file.'));
        reader.readAsDataURL(file);
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not process image.'));
        img.src = src;
    });
}

async function compressImageForUpload(file, maxDecodedBytes) {
    const rawDataUrl = await readFileAsDataUrl(file);
    if (dataUrlByteSize(rawDataUrl) <= maxDecodedBytes) return rawDataUrl;

    const img = await loadImage(rawDataUrl);
    let width  = img.naturalWidth  || img.width;
    let height = img.naturalHeight || img.height;
    const maxSide = 1400;

    if (width > maxSide || height > maxSide) {
        const scale = Math.min(maxSide / width, maxSide / height);
        width  = Math.max(1, Math.round(width  * scale));
        height = Math.max(1, Math.round(height * scale));
    }

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize image processor.');

    let result = rawDataUrl;
    for (let attempt = 0; attempt < 8; attempt++) {
        canvas.width  = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.9;
        result = canvas.toDataURL('image/webp', quality);
        while (dataUrlByteSize(result) > maxDecodedBytes && quality > 0.46) {
            quality -= 0.08;
            result = canvas.toDataURL('image/webp', quality);
        }

        if (dataUrlByteSize(result) <= maxDecodedBytes) return result;

        width  = Math.max(320, Math.round(width  * 0.85));
        height = Math.max(320, Math.round(height * 0.85));
    }

    throw new Error('Image is still too large after compression. Please choose a smaller image.');
}

// ── Profile photo upload ──────────────────────────────────────────────────────
async function handleProfilePhotoUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;

    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        showProfileSettingsMsg('error', 'Please upload PNG, JPG, or WEBP image.');
        event.target.value = ''; return;
    }

    if (file.size > 1.5 * 1024 * 1024) {
        showProfileSettingsMsg('error', 'Profile photo is too large. Maximum size is 1.5MB.');
        event.target.value = ''; return;
    }

    try {
        const compressed = await compressImageForUpload(file, PACKET_SAFE_IMAGE_BYTES);
        pendingProfilePhotoDataUrl = compressed;
        hasSelectedNewProfilePhoto = true;
        applyProfilePhoto(pendingProfilePhotoDataUrl);
        showProfileSettingsMsg('info', 'Saving profile photo...');
        await saveSchoolSettings({ saveProfileOnly: true });
    } catch (err) {
        showProfileSettingsMsg('error', err.message || 'Could not process image.');
        event.target.value = '';
    }
}

// ── School logo upload ────────────────────────────────────────────────────────
function renderSchoolLogoPreview(dataUrl) {
    const img         = document.getElementById('editSchoolLogoPreview');
    const placeholder = document.getElementById('editSchoolLogoPlaceholder');
    const coverLogo   = document.getElementById('profileCoverLogo');

    if (coverLogo) {
        if (dataUrl) {
            coverLogo.src = dataUrl;
            coverLogo.style.display = 'block';
        } else {
            coverLogo.style.display = 'none';
        }
    }

    if (!img || !placeholder) return;

    if (dataUrl) {
        img.src = dataUrl;
        img.style.display = 'block';
        placeholder.style.display = 'none';
    } else {
        img.style.display = 'none';
        placeholder.style.display = 'flex';
    }
}

async function handleSchoolLogoUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;

    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        showProfileSettingsMsg('error', 'Please upload PNG, JPG, or WEBP image.');
        event.target.value = ''; return;
    }

    if (file.size > 3 * 1024 * 1024) {
        showProfileSettingsMsg('error', 'Logo is too large. Maximum size is 3MB.');
        event.target.value = ''; return;
    }

    try {
        const compressed = await compressImageForUpload(file, PACKET_SAFE_IMAGE_BYTES);
        pendingSchoolLogoDataUrl  = compressed;
        hasSelectedNewSchoolLogo  = true;
        renderSchoolLogoPreview(pendingSchoolLogoDataUrl);
        showProfileSettingsMsg('info', 'Logo selected. Click Save Settings to apply it.');
    } catch (err) {
        showProfileSettingsMsg('error', err.message || 'Could not process image.');
        event.target.value = '';
    }
}

// ── Save settings ─────────────────────────────────────────────────────────────
function showProfileSettingsMsg(type, text) {
    const el = document.getElementById('profileSettingsMsg');
    if (!el) return;
    el.className    = `profile-settings-msg ${type || 'info'}`;
    el.textContent  = text;
    el.style.display = 'block';
}

function gv(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

async function saveSchoolSettings(options = {}) {
    const saveProfileOnly = !!options.saveProfileOnly;
    const schoolIdNoEl    = document.getElementById('editSchoolIdNo');
    if (!schoolIdNoEl) return;
    const schoolIdNo = schoolIdNoEl.value.trim();

    showProfileSettingsMsg('info', saveProfileOnly ? 'Saving profile photo...' : 'Saving school settings...');

    try {
        const requestBody = {};

        // User-level school id no (optional)
        if (!saveProfileOnly) {
            requestBody.school_id_no = schoolIdNo;
        }

        // Directory-aligned school updates
        if (!saveProfileOnly && schoolApproved) {
            const linkedType = localStorage.getItem('edu_school_type') || '';
            currentSchoolMode = isPrivateType(linkedType) ? 'private' : 'public';

            if (currentSchoolMode === 'public') {
                const name = gv('editPubHeadName');
                const pos  = gv('editPubPosition');
                if (!name) throw new Error('Name is required.');
                if (!pos)  throw new Error('Position is required.');

                requestBody.name              = name;
                requestBody.position          = pos;
                requestBody.district_id       = (document.getElementById('editPubDistrict')?.value || '').trim();
                requestBody.school_id         = gv('editPubSchoolId');
                requestBody.school_name       = gv('editPubSchoolName');
                requestBody.birthdate         = (document.getElementById('editPubBirthdate')?.value || '').trim();
                requestBody.contact_number    = gv('editPubContact');
                requestBody.email             = gv('editPubEmail');
                requestBody.first_day_station = (document.getElementById('editPubFirstDay')?.value || '').trim();
            } else {
                const sName = gv('editPrivSchoolName');
                if (!sName) throw new Error('School name is required.');
                requestBody.name              = sName;
                requestBody.status            = (document.getElementById('editPrivStatus')?.value || '').trim();
                requestBody.elem_admin        = gv('editPrivElemAdmin');
                requestBody.elem_contact      = gv('editPrivElemContact');
                requestBody.jhs_admin         = gv('editPrivJhsAdmin');
                requestBody.jhs_contact       = gv('editPrivJhsContact');
                requestBody.shs_admin         = gv('editPrivShsAdmin');
                requestBody.shs_contact       = gv('editPrivShsContact');
                requestBody.registrar_name    = gv('editPrivRegistrarName');
                requestBody.registrar_contact = gv('editPrivRegistrarContact');
                // Address + levels
                requestBody.street_address    = gv('editPrivStreet');
                requestBody.barangay          = gv('editPrivBarangay');
                requestBody.city              = gv('editPrivCity') || 'City of Baliwag';
                requestBody.levels            = getSelectedLevels();
            }
        }

        if (saveProfileOnly || hasSelectedNewProfilePhoto) {
            requestBody.profile_picture = pendingProfilePhotoDataUrl || null;
        }
        if (!saveProfileOnly && schoolApproved && hasSelectedNewSchoolLogo) {
            requestBody.school_logo = pendingSchoolLogoDataUrl || null;
        }

        const res  = await fetch(`${API_BASE}/school-portal-profile-update.php`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        const data = await res.json();

        if (!data.success) throw new Error(data.message || 'Failed to save profile settings.');

        // Persist to localStorage
        localStorage.setItem('edu_school_id_no', data.data?.school_id_no || '');
        localStorage.setItem('edu_school_logo',     data.data?.school_logo     || pendingSchoolLogoDataUrl  || '');
        localStorage.setItem('edu_profile_picture', data.data?.profile_picture || pendingProfilePhotoDataUrl || '');
        if (!saveProfileOnly && currentSchoolMode === 'private') {
            const savedAddress = buildSchoolAddress(
                data.data?.street_address ?? requestBody.street_address,
                data.data?.barangay       ?? requestBody.barangay,
                data.data?.city           ?? requestBody.city
            );
            localStorage.setItem('edu_school_address', savedAddress);
            setEl('sidebarDistrict', savedAddress || localStorage.getItem('edu_district_name') || '—');
        }

        pendingSchoolLogoDataUrl   = data.data?.school_logo     || pendingSchoolLogoDataUrl  || '';
        pendingProfilePhotoDataUrl = data.data?.profile_picture || pendingProfilePhotoDataUrl || '';
        hasSelectedNewSchoolLogo   = false;
        hasSelectedNewProfilePhoto = false;

        renderSchoolLogoPreview(pendingSchoolLogoDataUrl);
        applyProfilePhoto(pendingProfilePhotoDataUrl);

        // Reflect saved school_id_no in the read-only card
        setElOrEmpty('pSchoolIdNo', data.data?.school_id_no);

        await loadPendingBadge();

        showProfileSettingsMsg('success', saveProfileOnly ? 'Profile photo updated successfully.' : (schoolApproved ? 'Settings saved. The SDO directory will reflect these changes.' : 'Personal details saved. School access is awaiting SDO approval.'));
    } catch (err) {
        showProfileSettingsMsg('error', err.message || 'Could not save settings.');
    }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout() {
    try { await fetch(`${API_BASE}/logout.php?portal=school`, { method: 'POST', credentials: 'include' }); } catch { }
    [
        'edu_user_id','edu_email','edu_full_name','edu_role','edu_school_approved','edu_account_type',
        'edu_school_name','edu_district_id','edu_school_id','edu_grade',
        'edu_school_type',
        'edu_school_id_no','edu_district_name','edu_school_address','edu_profile_picture','edu_school_logo',
        'edu_email_verified',
    ].forEach(k => localStorage.removeItem(k));
    window.location.replace('school-portal.html');
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ── Session guard (bfcache + tab restore) ─────────────────────────────────────
window.addEventListener('pageshow', (e) => {
    if (e.persisted) checkSession();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkSession();
});

// ── Init ──────────────────────────────────────────────────────────────────────
initUI();
if (typeof initPortalPermissions === 'function') initPortalPermissions();
loadPendingBadge();
