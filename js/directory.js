const API_URL = CONFIG.API_URL;
let expandedMenus      = {};
let allPersonnel       = [];
let allPrivateSchools  = [];
let allPublicSchools   = [];   // ← NEW: loaded from public_schools.php
let allDistricts       = [];   // ← NEW: loaded for district dropdown
let currentDivision    = 'all';
let editingId          = null;
let editingPsId        = null;
let editingPubSchoolId = null; // ← NEW

// ─── Bootstrap ────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function () {
    checkAuthentication();
    // Close modals on backdrop click
    ['personnelModal','deleteModal','psModal','psDeleteModal',
     'pubSchoolModal','pubSchoolDeleteModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('open');
        });
    });
    document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);
});

// ─── Auth ─────────────────────────────────────────────────────────────
async function checkAuthentication() {
    let fullName = localStorage.getItem('full_name');
    let email    = localStorage.getItem('email');
    const cachedUserId = localStorage.getItem('user_id');

    try {
        const res  = await fetch(`${API_URL}/main-settings.php`, { credentials: 'include' });
        if (!res.ok) { clearSessionAndRedirect(); return false; }
        const json = await res.json();
        if (!json.success || !json.data?.id) { clearSessionAndRedirect(); return false; }

        if (json.data.id)           localStorage.setItem('user_id', String(json.data.id));
        if (json.data.full_name)  { fullName = json.data.full_name;  localStorage.setItem('full_name', json.data.full_name); }
        if (json.data.email)      { email    = json.data.email;      localStorage.setItem('email',     json.data.email); }
        if (json.data.role)         localStorage.setItem('role', json.data.role);
        if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
        if (Array.isArray(json.data.permissions))
            localStorage.setItem('permissions', JSON.stringify(json.data.permissions));

        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return;
        }
        if (json.data.profile_picture) {
            const av = document.getElementById('sidebarAvatar');
            if (av) av.innerHTML = `<img src="${json.data.profile_picture}"
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        }
        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('directory')) return false;
            Permissions.applyNavPermissions();
        }
        loadUserInfo(fullName, email);
        loadDirectoryData();
        return true;
    } catch (e) {
        if (!cachedUserId) { clearSessionAndRedirect(); return false; }
        if (typeof Permissions !== 'undefined') {
            if (!Permissions.check('directory')) return false;
            Permissions.applyNavPermissions();
        }
        loadUserInfo(fullName, email);
        loadDirectoryData();
        return true;
    }
}
function loadUserInfo(fullName, email) {
    const av = document.getElementById('sidebarAvatar');
    if (av && !av.querySelector('img')) av.textContent = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    const el = id => document.getElementById(id);
    if (el('sidebarUserName'))  el('sidebarUserName').textContent  = fullName || 'User';
    if (el('sidebarUserEmail')) el('sidebarUserEmail').textContent = email    || '';
}
function clearSessionAndRedirect() {
    ['user_id','email','full_name','role','permissions','account_type'].forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}
async function logout() {
    try { await fetch(`${API_URL}/logout.php`, { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include' }); }
    catch(e) {}
    finally { clearSessionAndRedirect(); }
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
function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}
function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ─── Division Metadata ────────────────────────────────────────────────
const DIV_META = {
    CID:    { label:'Curriculum Implementation Division',            icon:'fa-book-open',        color:'blue'   },
    OSDS:   { label:'Office of the Schools Division Superintendent', icon:'fa-building-columns', color:'green'  },
    SGOD:   { label:'School Governance and Operations Division',     icon:'fa-shield-halved',    color:'purple' },
    LSB:    { label:'OSDS-LSB Funded Personnel',                     icon:'fa-briefcase',        color:'amber'  },
};
const DISTRICT_ORDER = [
    'DISTRICT 1','DISTRICT 2','DISTRICT 3','DISTRICT 4','DISTRICT 5',
    'DISTRICT 6','DISTRICT 7','DISTRICT 8','DISTRICT 9','DISTRICT 10'
];

// Normalize any district string (handles legacy Roman numerals, mixed case,
// extra spaces, etc.) to the canonical "DISTRICT N" format stored in the DB.
const ROMAN_TO_ARABIC = {
    'I':1,'II':2,'III':3,'IV':4,'V':5,
    'VI':6,'VII':7,'VIII':8,'IX':9,'X':10
};
function normalizeDistrict(raw) {
    if (!raw) return raw;
    const s = raw.trim().toUpperCase();
    // Already canonical: "DISTRICT 1" … "DISTRICT 10"
    if (/^DISTRICT\s+\d+$/.test(s)) return s.replace(/\s+/, ' ');
    // Roman numeral form: "DISTRICT I" … "DISTRICT X"
    const m = s.match(/^DISTRICT\s+([IVXLCDM]+)$/);
    if (m && ROMAN_TO_ARABIC[m[1]] !== undefined) {
        return 'DISTRICT ' + ROMAN_TO_ARABIC[m[1]];
    }
    return raw.trim(); // unknown format — return cleaned original
}

// ─── Seed Data (SDO personnel — no School rows) ───────────────────────
const SEED_DATA = [
    {id:-1,  division:'CID',  name:'Arnel S. Usman',                      position:'Chief',                                              unit:'CID',                                           email:'',                                        district:'', school_id:'', admin_support:''},
    {id:-2,  division:'CID',  name:'Maricel N. Valdez, PhD',               position:'Education Program Supervisor',                       unit:'SCIENCE',                                       email:'maricel.valdez002@deped.gov.ph',          district:'', school_id:'', admin_support:''},
    {id:-3,  division:'CID',  name:'Marilyn P. Samson',                    position:'Education Program Supervisor',                       unit:'Inclusive Ed',                                  email:'marilyn.samson@deped.gov.ph',             district:'', school_id:'', admin_support:''},
    {id:-4,  division:'CID',  name:'Edelberto R. Ramos',                   position:'Education Program Supervisor',                       unit:'ARALING PANLIPUNAN',                            email:'edelberto.ramos@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-5,  division:'CID',  name:'Rosalie S. Santos',                    position:'Education Program Supervisor',                       unit:'LRMDS',                                         email:'rosalie.santos004@deped.gov.ph',          district:'', school_id:'', admin_support:''},
    {id:-6,  division:'CID',  name:'Maria Rowena C. Cababa',               position:'Education Program Supervisor',                       unit:'CID GMRC/VE',                                   email:'maria.cababa@deped.gov.ph',               district:'', school_id:'', admin_support:''},
    {id:-7,  division:'CID',  name:'Myrisa I. Balondo, EdD',               position:'Education Program Supervisor',                       unit:'EPP/TLE/TVL',                                   email:'myrisa.balondo@deped.gov.ph',             district:'', school_id:'', admin_support:''},
    {id:-8,  division:'CID',  name:'Maria Divina Amor C. Medina, PhD',     position:'Education Program Supervisor',                       unit:'MATHEMATICS',                                   email:'maria.medina003@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-9,  division:'CID',  name:'Jeorge Ryan L. Postrado, PhD',         position:'EPS - MAPEH',                                        unit:'MAPEH',                                         email:'jeorgeryan.postrado@deped.gov.ph',        district:'', school_id:'', admin_support:''},
    {id:-10, division:'CID',  name:'Imelda S.P. Golez',                    position:'Education Program Supervisor',                       unit:'FILIPINO',                                      email:'imelda.golez001@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-11, division:'CID',  name:'Marnick S. Gutierrez',                 position:'Education Program Supervisor',                       unit:'ENGLISH',                                       email:'',                                        district:'', school_id:'', admin_support:''},
    {id:-12, division:'CID',  name:'Donna Andrea G. Lopez',                position:'Education Program Specialist II',                    unit:'Alternative Learning System',                   email:'donnaandrea.lopez@deped.gov.ph',          district:'', school_id:'', admin_support:''},
    {id:-13, division:'CID',  name:'Julie-Ann C. Cruz',                    position:'Education Program Specialist II',                    unit:'Alternative Learning System',                   email:'julieann.cruz@deped.gov.ph',              district:'', school_id:'', admin_support:''},
    {id:-14, division:'CID',  name:'Jenifer Caballero',                    position:'Librarian II',                                       unit:'LRMDS',                                         email:'jenifer.caballero@deped.gov.ph',          district:'', school_id:'', admin_support:''},
    {id:-15, division:'CID',  name:'Melwin C. San Pedro',                  position:'Project Development Officer II',                     unit:'LRMDS',                                         email:'melwin.sanpedro@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-16, division:'CID',  name:'Carmina F. Torres',                    position:'Administrative Aide VI-Clerk III',                   unit:'CID',                                           email:'carminatorres088@gmail.com',              district:'', school_id:'', admin_support:''},
    {id:-17, division:'OSDS', name:'Rowena T. Quiambao, CESO VI',          position:'Schools Division Superintendent',                    unit:'OFFICE OF THE SCHOOLS DIVISION SUPERINTENDENT', email:'rowena.quiambao001@deped.gov.ph',         district:'', school_id:'', admin_support:''},
    {id:-18, division:'OSDS', name:'Erwin John F. Santos, CESE',           position:'Assistant Schools Division Superintendent',          unit:'OFFICE OF THE ASST. SDS',                       email:'erwin.santos@deped.gov.ph',               district:'', school_id:'', admin_support:''},
    {id:-19, division:'OSDS', name:'Alvin G. Garcia',                      position:'Administrative Officer V',                          unit:'ADMINISTRATIVE UNIT',                           email:'alvin.garcia@deped.gov.ph',               district:'', school_id:'', admin_support:''},
    {id:-20, division:'OSDS', name:'Dolores P. Santos',                    position:'Administrative Officer V',                          unit:'BUDGET',                                        email:'dolores.psantos@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-21, division:'OSDS', name:'Lucia B. Pascual',                     position:'Accountant III',                                    unit:'ACCOUNTING',                                    email:'luchiebpascual@deped.gov.ph',             district:'', school_id:'', admin_support:''},
    {id:-22, division:'OSDS', name:'Atty. Jomarco L. Santos',              position:'Attorney III',                                      unit:'LEGAL',                                         email:'jomarco.santos@deped.gov.ph',             district:'', school_id:'', admin_support:''},
    {id:-23, division:'OSDS', name:'Richard C. Biglete',                   position:'Information Technology Officer I',                  unit:'ICT Unit',                                      email:'richard.biglete@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-24, division:'SGOD', name:'Ma. Aurea Rhodora DC. Geronimo',       position:'Chief Education Program Supervisor',                 unit:'SGOD',                                          email:'maaurearhodora.geronimo@deped.gov.ph',    district:'', school_id:'', admin_support:''},
    {id:-25, division:'SGOD', name:'Ryan R. Bautista',                     position:'Education Program Supervisor',                      unit:'SGOD',                                          email:'ryan.bautista001@deped.gov.ph',           district:'', school_id:'', admin_support:''},
    {id:-26, division:'SGOD', name:'Cecille E. Cruz',                      position:'SEPS-SMME',                                         unit:'SMME',                                          email:'cecille.cruz@deped.gov.ph',               district:'', school_id:'', admin_support:''},
    {id:-27, division:'SGOD', name:'Michael M. Yumul',                     position:'EPS II-SMN',                                        unit:'SMN',                                           email:'michael.yumul@deped.gov.ph',              district:'', school_id:'', admin_support:''},
    {id:-28, division:'SGOD', name:'Ma. Bella S. Fajardo',                 position:'SEPS-HRDS',                                         unit:'HRD',                                           email:'bhelle.fajardo@deped.gov.ph',             district:'', school_id:'', admin_support:''},
    {id:-29, division:'SGOD', name:'Tiffany Joy P. Gonzales',              position:'EPS II-SMME',                                       unit:'SMME',                                          email:'tiffanyjoy.gonzales@deped.gov.ph',        district:'', school_id:'', admin_support:''},
    {id:-30, division:'SGOD', name:'Alvin J. Hernandez',                   position:'SEPS-SMN',                                          unit:'Soc-Mob',                                       email:'alvin.hernandez@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-31, division:'SGOD', name:'Jayvee N. Maglonzo',                   position:'EPS II - HRDS',                                     unit:'HRD',                                           email:'jayvee.maglonzo@deped.gov.ph',            district:'', school_id:'', admin_support:''},
    {id:-32, division:'SGOD', name:'Ma. Clariza F. Mempin',                position:'Medical Officer III',                               unit:'Health Unit',                                   email:'maclariza.mempin@deped.gov.ph',           district:'', school_id:'', admin_support:''},
    {id:-33, division:'LSB',  name:'Robin M. Cruz',                        position:'Administrative Aide - LSB',                         unit:'OFFICE OF THE ASST. SDS',                       email:'robincruz042590@gmail.com',               district:'', school_id:'', admin_support:''},
    {id:-34, division:'LSB',  name:'Ervielyn SJ. Gatbonton',               position:'Administrative Aide - LSB',                         unit:'OFFICE OF THE SDS',                             email:'ervielyn.gatbonton@deped.gov.ph',         district:'', school_id:'', admin_support:''},
    {id:-35, division:'LSB',  name:'Marvin D. Murillo',                    position:'Security Guard',                                    unit:'OSDS',                                          email:'RHAINKAIZERP@GMAIL.COM',                  district:'', school_id:'', admin_support:''},
    {id:-36, division:'LSB',  name:'Edmondo M. Villanueva',                position:'Driver',                                            unit:'OSDS',                                          email:'edmonvillanueva06@gmail.com',              district:'', school_id:'', admin_support:''},
];

// ─── Load all data ────────────────────────────────────────────────────
async function loadDirectoryData() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';

    // 1. Personnel (SDO staff — no School rows after migration)
    try {
        const res  = await fetch(`${API_URL}/directory.php`, { credentials: 'include' });
        if (res.ok) {
            const json = await res.json();
            allPersonnel = (json.success && json.data?.length)
                ? json.data.filter(p => p.division !== 'School')
                : SEED_DATA.map(p => ({...p}));
        } else {
            allPersonnel = SEED_DATA.map(p => ({...p}));
        }
    } catch (e) {
        allPersonnel = SEED_DATA.map(p => ({...p}));
    }

    // 2. Private schools
    try {
        const res  = await fetch(`${API_URL}/private_schools.php`, { credentials: 'include' });
        if (res.ok) {
            const json = await res.json();
            allPrivateSchools = (json.success && Array.isArray(json.data))
                ? json.data.map((s, i) => ({
                    id:             s.id,
                    no:             i + 1,
                    name:           s.name           || '',
                    school_id_no:   s.school_id_no   || '',
                    street_address: s.street_address || '',
                    barangay:       s.barangay        || '',
                    levels:         (() => { try { return JSON.parse(s.levels || '[]'); } catch(e) { return []; } })(),
                    status:         s.status         || '',
                    elem:      { admin: s.elem_admin || '', contact: s.elem_contact || '' },
                    jhs:       { admin: s.jhs_admin  || '', contact: s.jhs_contact  || '' },
                    shs:       { admin: s.shs_admin  || '', contact: s.shs_contact  || '' },
                    registrar: { admin: s.registrar_name || '', contact: s.registrar_contact || '' },
                }))
                : [];
        }
    } catch (e) { allPrivateSchools = []; }

    // 3. Public schools
    try {
        const res  = await fetch(`${API_URL}/public_schools.php`, { credentials: 'include' });
        if (res.ok) {
            const json = await res.json();
            allPublicSchools = (json.success && Array.isArray(json.data))
                ? json.data.map((s, i) => ({
                    id:                s.id,
                    no:                i + 1,
                    name:              s.name              || '',
                    position:          s.position          || '',
                    school_id:         s.school_id         || '',
                    district:          normalizeDistrict(s.district || ''),
                    school_name:       s.school_name       || '',
                    birthdate:         s.birthdate         || '',
                    contact_number:    s.contact_number    || '',
                    email:             s.email             || '',
                    first_day_station: s.first_day_station || '',
                }))
                : [];
        }
    } catch (e) { allPublicSchools = []; }

    // 4. Districts list for modal dropdown ← NEW
    try {
        const res  = await fetch(`${API_URL}/get-districts.php`, { credentials: 'include' });
        if (res.ok) {
            const json = await res.json();
            allDistricts = (json.success && Array.isArray(json.data)) ? json.data : [];
        }
    } catch (e) { allDistricts = []; }
    // Fallback: derive from loaded public schools
    if (!allDistricts.length) {
        const seen = new Set();
        allPublicSchools.forEach(s => {
            if (s.district_id && s.district && !seen.has(s.district_id)) {
                seen.add(s.district_id);
                allDistricts.push({ id: s.district_id, name: s.district });
            }
        });
        allDistricts.sort((a, b) => a.name.localeCompare(b.name));
    }
    _populateDistrictDropdown();

    renderAll();
    if (overlay) overlay.style.display = 'none';
}

function _populateDistrictDropdown() {
    const sel = document.getElementById('pubDistrict');
    if (!sel) return;

    const extra = Array.from(
        new Set(
            (allPublicSchools || [])
                .map(s => normalizeDistrict((s.district || '').trim()))
                .filter(Boolean)
        )
    ).filter(d => !DISTRICT_ORDER.includes(d)).sort((a, b) => a.localeCompare(b));

    const options = [...DISTRICT_ORDER, ...extra];
    const currentValue = sel.value;

    sel.innerHTML = '<option value="">— Select District —</option>' +
        options.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

    // Restore selection if possible
    if (currentValue) sel.value = currentValue;
}

function renderAll() {
    renderStats();
    const q = document.getElementById('globalSearch')?.value || '';
    if      (currentDivision === 'PrivateSchools') renderPrivateSchools(q);
    else if (currentDivision === 'PublicSchools')  renderPublicSchools(q);
    else                                            renderSections(currentDivision, q);
}

// ─── Stats ────────────────────────────────────────────────────────────
function renderStats() {
    const el = document.getElementById('dirStats');
    if (!el) return;
    const counts = {};
    Object.keys(DIV_META).forEach(d => counts[d] = 0);
    allPersonnel.forEach(p => { if (counts[p.division] !== undefined) counts[p.division]++; });
    el.innerHTML = `
        <div class="dir-stat-card">
            <div class="dir-stat-icon all"><i class="fa-solid fa-users"></i></div>
            <div><div class="dir-stat-num">${allPersonnel.length}</div><div class="dir-stat-label">Total Number of SDO Personnel</div></div>
        </div>
        ${Object.entries(counts).map(([div, n]) => `
        <div class="dir-stat-card">
            <div class="dir-stat-icon ${DIV_META[div].color}"><i class="fa-solid ${DIV_META[div].icon}"></i></div>
            <div><div class="dir-stat-num">${n}</div><div class="dir-stat-label">${div}</div></div>
        </div>`).join('')}
        <div class="dir-stat-card">
            <div class="dir-stat-icon blue"><i class="fa-solid fa-school"></i></div>
            <div><div class="dir-stat-num">${allPublicSchools.length}</div><div class="dir-stat-label">Public Schools</div></div>
        </div>
        <div class="dir-stat-card">
            <div class="dir-stat-icon rose"><i class="fa-solid fa-school-flag"></i></div>
            <div><div class="dir-stat-num">${allPrivateSchools.length}</div><div class="dir-stat-label">Private Schools</div></div>
        </div>`;
}

// ─── Render SDO Sections ───────────────────────────────────────────────
function formatDisplayDate(value) {
    const v = (value || '').toString().trim();
    if (!v) return '';

    // Prefer stable parsing for common ISO-ish formats to avoid timezone shifts.
    let y, m, d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        [y, m, d] = v.split('-').map(n => parseInt(n, 10));
    } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(v)) {
        [y, m, d] = v.split('/').map(n => parseInt(n, 10));
    }

    if (y && m && d) {
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
        });
    }

    const dt = new Date(v);
    if (Number.isNaN(dt.getTime())) return v;
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderSections(division, query) {
    const container = document.getElementById('directorySections');
    if (!container) return;
    const q = (query || '').toLowerCase().trim();
    const divisions = division === 'all' ? Object.keys(DIV_META) : [division];
    let html = '';

    divisions.forEach(divKey => {
        const meta = DIV_META[divKey];
        let rows = allPersonnel.filter(p => p.division === divKey);
        if (q) rows = rows.filter(p =>
            (p.name     ||'').toLowerCase().includes(q) ||
            (p.position ||'').toLowerCase().includes(q) ||
            (p.unit     ||'').toLowerCase().includes(q) ||
            (p.email    ||'').toLowerCase().includes(q) ||
            (p.birthdate ||'').toLowerCase().includes(q) ||
            (p.contact_number ||'').toLowerCase().includes(q)
        );
        if (q && rows.length === 0) return;

        const tbody = rows.map((p, i) => `<tr>
            <td class="col-no">${i+1}</td>
            <td class="col-name"><strong>${escapeHtml(p.name)}</strong></td>
            <td class="col-pos">${escapeHtml(p.position)}</td>
            <td class="col-unit"><span class="unit-badge ${meta.color}">${escapeHtml(p.unit)}</span></td>
            <td class="col-birthdate">${p.birthdate ? escapeHtml(formatDisplayDate(p.birthdate)) : '<span class="no-email">—</span>'}</td>
            <td class="col-contact">${p.contact_number
                ? `<div class="ps-contact"><i class="fa-solid fa-phone"></i> ${escapeHtml(p.contact_number)}</div>`
                : '<span class="no-email">—</span>'}</td>
            <td class="col-email">${p.email
                ? `<a href="mailto:${escapeHtml(p.email)}" class="email-link"><i class="fa-solid fa-envelope"></i> ${escapeHtml(p.email)}</a>`
                : '<span class="no-email">—</span>'}</td>
            <td class="col-actions">
                <button class="action-btn edit-btn"   onclick="openEditModal(${p.id})"   title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn delete-btn" onclick="confirmDelete(${p.id})"   title="Delete"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`).join('');

        html += `
        <div class="dir-section" id="section-${divKey}">
            <div class="dir-section-header ${meta.color}">
                <div class="dir-section-title">
                    <i class="fa-solid ${meta.icon}"></i>
                    <div>
                        <span class="dir-section-abbr">${divKey}</span>
                        <span class="dir-section-full">${meta.label}</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span class="dir-section-count">${rows.length} personnel</span>
                    <button class="add-personnel-btn" onclick="openAddModal('${divKey}')">
                        <i class="fa-solid fa-plus"></i> Add
                    </button>
                </div>
            </div>
            <div class="dir-table-wrap">
                ${rows.length === 0
                    ? `<div class="empty-state" style="padding:40px;">
                        <i class="fa-solid fa-users-slash"></i>
                        <p>No personnel yet. <a href="#" onclick="openAddModal('${divKey}');return false;">Add one now.</a></p>
                       </div>`
                    : `<table class="dir-table">
                        <thead><tr>
                            <th class="col-no">No.</th>
                            <th class="col-name">Name</th>
                            <th class="col-pos">Position</th>
                            <th class="col-unit">Unit</th>
                            <th class="col-birthdate">Birthdate</th>
                            <th class="col-contact">Contact Number</th>
                            <th class="col-email">E-mail</th>
                            <th class="col-actions">Actions</th>
                        </tr></thead>
                        <tbody>${tbody}</tbody>
                       </table>`}
            </div>
        </div>`;
    });

    if (!html) html = `<div class="empty-state" style="padding:80px;text-align:center;">
        <i class="fa-solid fa-magnifying-glass" style="font-size:2rem;margin-bottom:12px;opacity:.4;"></i>
        <p>No results for "<strong>${escapeHtml(q)}</strong>"</p></div>`;
    container.innerHTML = html;
}

// ─── Render Public Schools ─────────────────────────────────────────────
function renderPublicSchools(query) {
    const container = document.getElementById('directorySections');
    if (!container) return;
    const q = (query || '').toLowerCase().trim();

    let schools = allPublicSchools;
    if (q) schools = schools.filter(s =>
        (s.name              ||'').toLowerCase().includes(q) ||
        (s.position          ||'').toLowerCase().includes(q) ||
        (s.district          ||'').toLowerCase().includes(q) ||
        (s.school_id         ||'').toLowerCase().includes(q) ||
        (s.school_name       ||'').toLowerCase().includes(q) ||
        (s.email             ||'').toLowerCase().includes(q) ||
        (s.contact_number    ||'').toLowerCase().includes(q)
    );

    // Group by district
    const dMap = {};
    schools.forEach(s => {
        const d = s.district || 'No District';
        (dMap[d] = dMap[d] || []).push(s);
    });
    const districtKeys = [
        ...DISTRICT_ORDER.filter(d => dMap[d]),
        ...Object.keys(dMap).filter(d => !DISTRICT_ORDER.includes(d))
    ];

    let tbody = '';
    let rowNum = 0;
    districtKeys.forEach(dist => {
        tbody += `<tr class="district-header-row"><td colspan="10">
            <span class="district-label"><i class="fa-solid fa-map-pin"></i> ${escapeHtml(dist)}</span>
        </td></tr>`;
        dMap[dist].forEach(s => {
            rowNum++;
            tbody += `<tr>
                <td class="col-no">${rowNum}</td>
                <td class="col-name"><strong>${escapeHtml(s.name)}</strong></td>
                <td>${escapeHtml(s.position) || '<span class="no-email">—</span>'}</td>
                <td class="col-school-id">${s.school_id ? escapeHtml(s.school_id) : '<span class="no-email">—</span>'}</td>
                <td>${s.school_name ? escapeHtml(s.school_name) : '<span class="no-email">—</span>'}</td>
                <td>${s.birthdate ? escapeHtml(formatDisplayDate(s.birthdate)) : '<span class="no-email">—</span>'}</td>
                <td>${s.contact_number
                    ? `<div class="ps-contact"><i class="fa-solid fa-phone"></i> ${escapeHtml(s.contact_number)}</div>`
                    : '<span class="no-email">—</span>'}</td>
                <td class="col-email">${s.email
                    ? `<a href="mailto:${escapeHtml(s.email)}" class="email-link"><i class="fa-solid fa-envelope"></i> ${escapeHtml(s.email)}</a>`
                    : '<span class="no-email">—</span>'}</td>
                <td>${s.first_day_station ? escapeHtml(formatDisplayDate(s.first_day_station)) : '<span class="no-email">—</span>'}</td>
                <td class="col-actions">
                    <button class="action-btn edit-btn"   onclick="openPubSchoolEditModal(${s.id})" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn delete-btn" onclick="confirmPubSchoolDelete(${s.id})" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`;
        });
    });

    const html = schools.length === 0
        ? `<div class="empty-state" style="padding:80px;text-align:center;">
            <i class="fa-solid fa-magnifying-glass" style="font-size:2rem;margin-bottom:12px;opacity:.4;"></i>
            <p>${q ? `No results for "<strong>${escapeHtml(q)}</strong>"` : 'No public school records found.'}</p>
           </div>`
        : `<div class="dir-section" id="section-PublicSchools">
            <div class="dir-section-header blue">
                <div class="dir-section-title">
                    <i class="fa-solid fa-school"></i>
                    <div>
                        <span class="dir-section-abbr">Public Schools</span>
                        <span class="dir-section-full">Official List of Public Schools and School Heads</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span class="dir-section-count">${schools.length} school heads</span>
                    <button class="add-personnel-btn" style="background:#1d4ed8;" onclick="openPubSchoolAddModal()">
                        <i class="fa-solid fa-plus"></i> Add School Head
                    </button>
                </div>
            </div>
            <div class="dir-table-wrap">
                <table class="dir-table ps-table">
                    <thead><tr>
                        <th class="col-no">No.</th>
                        <th class="col-name">Name</th>
                        <th>Position</th>
                        <th class="col-school-id">School ID</th>
                        <th>District / School</th>
                        <th>Birthdate</th>
                        <th>Contact Number</th>
                        <th class="col-email">E-mail Address</th>
                        <th>First Day at Station</th>
                        <th class="col-actions">Actions</th>
                    </tr></thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
           </div>`;

    container.innerHTML = html;
}

// ─── Render Private Schools ────────────────────────────────────────────
function renderPrivateSchools(query) {
    const container = document.getElementById('directorySections');
    if (!container) return;
    const q = (query || '').toLowerCase().trim();

    let schools = allPrivateSchools;
    if (q) schools = schools.filter(s =>
        (s.name ||'').toLowerCase().includes(q) ||
        (s.elem.admin||'').toLowerCase().includes(q) ||
        (s.jhs.admin ||'').toLowerCase().includes(q) ||
        (s.shs.admin ||'').toLowerCase().includes(q) ||
        (s.registrar?.admin||'').toLowerCase().includes(q) ||
        (s.elem.contact||'').toLowerCase().includes(q) ||
        (s.jhs.contact ||'').toLowerCase().includes(q) ||
        (s.shs.contact ||'').toLowerCase().includes(q)
    );

    const adminCell = (admin, contact) => {
        if (!admin || admin === '—') return `<span class="no-email">—</span>`;
        return `<div class="ps-admin-name">${escapeHtml(admin)}</div>
                ${contact && contact !== 'N/A' && contact !== '—'
                    ? `<div class="ps-contact"><i class="fa-solid fa-phone"></i> ${escapeHtml(contact)}</div>` : ''}`;
    };

    const rows = schools.map(s => {
        const statusBadge = s.status ? `<span class="ps-status-badge">${escapeHtml(s.status)}</span>` : '';
        return `<tr class="${s.status ? 'ps-row-closed' : ''}">
            <td class="col-no">${s.no}</td>
            <td class="col-name"><strong>${escapeHtml(s.name)}</strong>${statusBadge}</td>
            <td class="ps-col-admin">${adminCell(s.elem.admin, s.elem.contact)}</td>
            <td class="ps-col-admin">${adminCell(s.jhs.admin,  s.jhs.contact)}</td>
            <td class="ps-col-admin">${adminCell(s.shs.admin,  s.shs.contact)}</td>
            <td class="ps-col-admin">${adminCell(s.registrar?.admin||'', s.registrar?.contact||'')}</td>
            <td class="col-actions">
                <button class="action-btn edit-btn"   onclick="openPsEditModal(${s.id})"   title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn delete-btn" onclick="confirmPsDelete(${s.id})"   title="Delete"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`;
    }).join('');

    const html = schools.length === 0
        ? `<div class="empty-state" style="padding:80px;text-align:center;">
            <i class="fa-solid fa-magnifying-glass" style="font-size:2rem;margin-bottom:12px;opacity:.4;"></i>
            <p>No private schools match "<strong>${escapeHtml(q)}</strong>"</p></div>`
        : `<div class="dir-section" id="section-PrivateSchools">
            <div class="dir-section-header rose">
                <div class="dir-section-title">
                    <i class="fa-solid fa-school-flag"></i>
                    <div>
                        <span class="dir-section-abbr">Private Schools</span>
                        <span class="dir-section-full">Official List of Private Schools and Administrators</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span class="dir-section-count">${schools.length} schools</span>
                    <button class="add-personnel-btn add-ps-btn" onclick="openPsAddModal()">
                        <i class="fa-solid fa-plus"></i> Add School
                    </button>
                </div>
            </div>
            <div class="dir-table-wrap">
                <table class="dir-table ps-table">
                    <thead><tr>
                        <th class="col-no">No.</th>
                        <th class="col-name">School Name</th>
                        <th class="ps-col-admin"><i class="fa-solid fa-child-reaching"></i> Elem Admin</th>
                        <th class="ps-col-admin"><i class="fa-solid fa-graduation-cap"></i> JHS Admin</th>
                        <th class="ps-col-admin"><i class="fa-solid fa-user-graduate"></i> SHS Admin</th>
                        <th class="ps-col-admin"><i class="fa-solid fa-address-card"></i> Registrar</th>
                        <th class="col-actions">Actions</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
           </div>`;
    container.innerHTML = html;
}

// ─── SDO Personnel Modal ───────────────────────────────────────────────
function _toDateInputValue(value) {
    const v = (value || '').toString().trim();
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(v)) return v.replaceAll('/', '-');
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function openAddModal(division) {
    editingId = null;
    document.getElementById('modalTitle').textContent = `Add Personnel — ${division}`;
    document.getElementById('fDivision').value = division;
    ['fName','fPosition','fUnit','fEmail','fBirthdate','fContactNumber']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('modalError').textContent = '';
    document.getElementById('personnelModal').classList.add('open');
}
function openEditModal(id) {
    const p = allPersonnel.find(r => r.id === id);
    if (!p) return;
    editingId = id;
    document.getElementById('modalTitle').textContent = 'Edit Personnel';
    document.getElementById('fDivision').value  = p.division;
    document.getElementById('fName').value      = p.name     || '';
    document.getElementById('fPosition').value  = p.position || '';
    document.getElementById('fUnit').value      = p.unit     || '';
    document.getElementById('fEmail').value     = p.email    || '';
    const bEl = document.getElementById('fBirthdate');
    if (bEl) bEl.value = _toDateInputValue(p.birthdate);
    const cEl = document.getElementById('fContactNumber');
    if (cEl) cEl.value = p.contact_number || '';
    document.getElementById('modalError').textContent = '';
    document.getElementById('personnelModal').classList.add('open');
}
function openModal()  { document.getElementById('personnelModal').classList.add('open'); }
function closeModal() { document.getElementById('personnelModal').classList.remove('open'); }

async function savePersonnel() {
    const get = id => document.getElementById(id)?.value.trim() || '';
    const name = get('fName'), position = get('fPosition'), division = get('fDivision');
    const errEl = document.getElementById('modalError');
    if (!name || !position || !division) { errEl.textContent = 'Name, Position, and Division are required.'; return; }
    const payload = {
        name,
        position,
        division,
        unit: get('fUnit'),
        email: get('fEmail'),
        birthdate: get('fBirthdate'),
        contact_number: get('fContactNumber'),
    };
    const isNew = !editingId || editingId < 0;
    try {
        if (!isNew) payload.id = editingId;
        const res  = await fetch(`${API_URL}/directory.php`, {
            method: isNew ? 'POST' : 'PUT',
            headers: {'Content-Type':'application/json'},
            credentials: 'include', body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            await loadDirectoryData(); closeModal();
            showToast(isNew ? 'Personnel added.' : 'Personnel updated.', 'success'); return;
        }
        errEl.textContent = json.message || 'Server error.';
    } catch(e) {
        if (isNew) {
            const minId = Math.min(0, ...allPersonnel.map(r => r.id)) - 1;
            allPersonnel.push({id: minId, ...payload});
        } else {
            const idx = allPersonnel.findIndex(r => r.id === editingId);
            if (idx !== -1) allPersonnel[idx] = {...allPersonnel[idx], ...payload};
        }
        renderAll(); closeModal();
        showToast(isNew ? 'Personnel added.' : 'Personnel updated.', 'success');
    }
}

function confirmDelete(id) {
    const p = allPersonnel.find(r => r.id === id);
    if (!p) return;
    document.getElementById('deletePersonnelName').textContent = p.name;
    document.getElementById('deleteModal').dataset.deleteId    = id;
    document.getElementById('deleteError').textContent         = '';
    document.getElementById('deleteModal').classList.add('open');
}
function closeDeleteModal() { document.getElementById('deleteModal').classList.remove('open'); }

async function executeDelete() {
    const id    = parseInt(document.getElementById('deleteModal').dataset.deleteId);
    const errEl = document.getElementById('deleteError');
    if (id > 0) {
        try {
            const res  = await fetch(`${API_URL}/directory.php`, {
                method: 'DELETE', headers: {'Content-Type':'application/json'},
                credentials: 'include', body: JSON.stringify({id})
            });
            const json = await res.json();
            if (!json.success) { errEl.textContent = json.message || 'Delete failed.'; return; }
            await loadDirectoryData(); closeDeleteModal();
            showToast('Personnel deleted.', 'danger'); return;
        } catch(e) {}
    }
    allPersonnel = allPersonnel.filter(r => r.id !== id);
    renderAll(); closeDeleteModal();
    showToast('Personnel deleted.', 'danger');
}

// ─── Public Schools Modal ──────────────────────────────────────────────
function openPubSchoolAddModal() {
    editingPubSchoolId = null;
    document.getElementById('pubSchoolModalTitle').innerHTML =
        '<i class="fa-solid fa-school"></i> Add School Head';
    ['pubName','pubPosition','pubSchoolId','pubSchoolName',
     'pubBirthdate','pubContactNumber','pubEmail','pubFirstDayStation']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const distEl = document.getElementById('pubDistrict');
    if (distEl) distEl.value = '';
    document.getElementById('pubSchoolModalError').textContent = '';
    document.getElementById('pubSchoolModal').classList.add('open');
}

function openPubSchoolEditModal(id) {
    const s = allPublicSchools.find(s => s.id === id);
    if (!s) return;
    editingPubSchoolId = id;
    document.getElementById('pubSchoolModalTitle').innerHTML =
        '<i class="fa-solid fa-school"></i> Edit School Head';
    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
    set('pubName',             s.name);
    set('pubPosition',         s.position);
    set('pubSchoolId',         s.school_id);
    set('pubSchoolName',       s.school_name);
    set('pubBirthdate',        s.birthdate);
    set('pubContactNumber',    s.contact_number);
    set('pubEmail',            s.email);
    set('pubFirstDayStation',  s.first_day_station);
    const distEl = document.getElementById('pubDistrict');
    if (distEl) distEl.value = s.district || '';
    document.getElementById('pubSchoolModalError').textContent = '';
    document.getElementById('pubSchoolModal').classList.add('open');
}

function closePubSchoolModal() { document.getElementById('pubSchoolModal').classList.remove('open'); }

async function savePubSchool() {
    const get   = id => document.getElementById(id)?.value.trim() || '';
    const name  = get('pubName');
    const errEl = document.getElementById('pubSchoolModalError');
    if (!name)            { errEl.textContent = 'Name is required.';     return; }
    if (!get('pubPosition')) { errEl.textContent = 'Position is required.'; return; }

    const payload = {
        name,
        position:          get('pubPosition'),
        district:          normalizeDistrict(get('pubDistrict')),
        school_id:         get('pubSchoolId'),
        school_name:       get('pubSchoolName'),
        birthdate:         get('pubBirthdate'),
        contact_number:    get('pubContactNumber'),
        email:             get('pubEmail'),
        first_day_station: get('pubFirstDayStation'),
    };

    const isNew = !editingPubSchoolId;
    try {
        if (!isNew) payload.id = editingPubSchoolId;
        const res  = await fetch(`${API_URL}/public_schools.php`, {
            method: isNew ? 'POST' : 'PUT',
            headers: {'Content-Type':'application/json'},
            credentials: 'include', body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            await loadDirectoryData(); closePubSchoolModal();
            showToast(isNew ? 'School added successfully.' : 'School updated.', 'success'); return;
        }
        errEl.textContent = json.message || 'Server error.';
    } catch(e) {
        errEl.textContent = 'Could not reach server. Check your connection.';
    }
}

function confirmPubSchoolDelete(id) {
    const s = allPublicSchools.find(s => s.id === id);
    if (!s) return;
    document.getElementById('pubSchoolDeleteName').textContent          = s.name;
    document.getElementById('pubSchoolDeleteModal').dataset.deleteId    = id;
    document.getElementById('pubSchoolDeleteError').textContent         = '';
    document.getElementById('pubSchoolDeleteModal').classList.add('open');
}
function closePubSchoolDeleteModal() { document.getElementById('pubSchoolDeleteModal').classList.remove('open'); }

async function executePubSchoolDelete() {
    const id    = parseInt(document.getElementById('pubSchoolDeleteModal').dataset.deleteId);
    const errEl = document.getElementById('pubSchoolDeleteError');
    try {
        const res  = await fetch(`${API_URL}/public_schools.php`, {
            method: 'DELETE', headers: {'Content-Type':'application/json'},
            credentials: 'include', body: JSON.stringify({id})
        });
        const json = await res.json();
        if (!json.success) { errEl.textContent = json.message || 'Delete failed.'; return; }
        await loadDirectoryData(); closePubSchoolDeleteModal();
        showToast('School removed.', 'danger');
    } catch(e) {
        errEl.textContent = 'Could not reach server.';
    }
}

// ─── Private Schools Modal ────────────────────────────────────────────
function openPsAddModal() {
    editingPsId = null;
    document.getElementById('psModalTitle').textContent = 'Add Private School';
    ['psName','psSchoolIdNo','psStatus','psStreetAddress','psBarangay',
     'psElemAdmin','psElemContact','psJhsAdmin','psJhsContact',
     'psShsAdmin','psShsContact','psRegistrarName','psRegistrarContact']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['psLevelPre','psLevelElem','psLevelJhs','psLevelShs']
        .forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
    document.getElementById('psModalError').textContent = '';
    document.getElementById('psModal').classList.add('open');
}
function openPsEditModal(id) {
    const s = allPrivateSchools.find(s => s.id === id);
    if (!s) return;
    editingPsId = id;
    document.getElementById('psModalTitle').textContent    = 'Edit Private School';
    document.getElementById('psName').value                = s.name             || '';
    document.getElementById('psSchoolIdNo').value          = s.school_id_no     || '';
    document.getElementById('psStatus').value              = s.status           || '';
    document.getElementById('psStreetAddress').value       = s.street_address   || '';
    document.getElementById('psBarangay').value            = s.barangay         || '';
    const levels = Array.isArray(s.levels) ? s.levels : [];
    document.getElementById('psLevelPre').checked          = levels.includes('pre');
    document.getElementById('psLevelElem').checked         = levels.includes('elem');
    document.getElementById('psLevelJhs').checked          = levels.includes('jhs');
    document.getElementById('psLevelShs').checked          = levels.includes('shs');
    document.getElementById('psElemAdmin').value           = s.elem.admin       || '';
    document.getElementById('psElemContact').value         = s.elem.contact     || '';
    document.getElementById('psJhsAdmin').value            = s.jhs.admin        || '';
    document.getElementById('psJhsContact').value          = s.jhs.contact      || '';
    document.getElementById('psShsAdmin').value            = s.shs.admin        || '';
    document.getElementById('psShsContact').value          = s.shs.contact      || '';
    document.getElementById('psRegistrarName').value       = s.registrar?.admin   || '';
    document.getElementById('psRegistrarContact').value    = s.registrar?.contact || '';
    document.getElementById('psModalError').textContent    = '';
    document.getElementById('psModal').classList.add('open');
}
function closePsModal() { document.getElementById('psModal').classList.remove('open'); }

async function savePsSchool() {
    const get  = id => document.getElementById(id).value.trim();
    const name = get('psName');
    const errEl = document.getElementById('psModalError');
    if (!name) { errEl.textContent = 'School name is required.'; return; }
    const levels = ['pre','elem','jhs','shs']
        .filter(lv => document.getElementById('psLevel' + lv.charAt(0).toUpperCase() + lv.slice(1))?.checked);
    const payload = {
        name,
        school_id_no:   get('psSchoolIdNo'),
        status:         get('psStatus'),
        street_address: get('psStreetAddress'),
        barangay:       get('psBarangay'),
        levels:         JSON.stringify(levels),
        elem_admin: get('psElemAdmin'),   elem_contact: get('psElemContact'),
        jhs_admin:  get('psJhsAdmin'),    jhs_contact:  get('psJhsContact'),
        shs_admin:  get('psShsAdmin'),    shs_contact:  get('psShsContact'),
        registrar_name: get('psRegistrarName'), registrar_contact: get('psRegistrarContact'),
    };
    const isNew = !editingPsId || editingPsId < 0;
    try {
        if (!isNew) payload.id = editingPsId;
        const res  = await fetch(`${API_URL}/private_schools.php`, {
            method: isNew ? 'POST' : 'PUT',
            headers: {'Content-Type':'application/json'},
            credentials: 'include', body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            await loadDirectoryData(); closePsModal();
            showToast(isNew ? 'School added.' : 'School updated.', 'success'); return;
        }
        errEl.textContent = json.message || 'Server error.';
    } catch(e) {
        const school = {
            id: isNew ? (Math.min(0,...allPrivateSchools.map(s=>s.id))-1) : editingPsId,
            no: isNew ? allPrivateSchools.length+1 : allPrivateSchools.find(s=>s.id===editingPsId)?.no,
            name: payload.name, school_id_no: payload.school_id_no,
            street_address: payload.street_address, barangay: payload.barangay,
            levels, status: payload.status,
            elem: {admin: payload.elem_admin, contact: payload.elem_contact},
            jhs:  {admin: payload.jhs_admin,  contact: payload.jhs_contact},
            shs:  {admin: payload.shs_admin,  contact: payload.shs_contact},
            registrar: {admin: payload.registrar_name, contact: payload.registrar_contact},
        };
        if (isNew) allPrivateSchools.push(school);
        else { const idx = allPrivateSchools.findIndex(s=>s.id===editingPsId); if (idx!==-1) allPrivateSchools[idx]=school; }
        renderAll(); closePsModal();
        showToast(isNew ? 'School added.' : 'School updated.', 'success');
    }
}
function confirmPsDelete(id) {
    const s = allPrivateSchools.find(s => s.id === id);
    if (!s) return;
    document.getElementById('psDeleteName').textContent            = s.name;
    document.getElementById('psDeleteModal').dataset.deleteId      = id;
    document.getElementById('psDeleteError').textContent           = '';
    document.getElementById('psDeleteModal').classList.add('open');
}
function closePsDeleteModal() { document.getElementById('psDeleteModal').classList.remove('open'); }

async function executePsDelete() {
    const id    = parseInt(document.getElementById('psDeleteModal').dataset.deleteId);
    const errEl = document.getElementById('psDeleteError');
    if (id > 0) {
        try {
            const res  = await fetch(`${API_URL}/private_schools.php`, {
                method: 'DELETE', headers: {'Content-Type':'application/json'},
                credentials: 'include', body: JSON.stringify({id})
            });
            const json = await res.json();
            if (!json.success) { errEl.textContent = json.message || 'Delete failed.'; return; }
            await loadDirectoryData(); closePsDeleteModal();
            showToast('School deleted.', 'danger'); return;
        } catch(e) {}
    }
    allPrivateSchools = allPrivateSchools.filter(s => s.id !== id);
    allPrivateSchools.forEach((s, i) => s.no = i + 1);
    renderAll(); closePsDeleteModal();
    showToast('School deleted.', 'danger');
}

// ─── Search & Tabs ────────────────────────────────────────────────────
function handleSearch(value) {
    if      (currentDivision === 'PrivateSchools') renderPrivateSchools(value);
    else if (currentDivision === 'PublicSchools')  renderPublicSchools(value);
    else                                            renderSections(currentDivision, value);
}
function switchTab(btn, division) {
    document.querySelectorAll('.dir-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    currentDivision = division;
    const q = document.getElementById('globalSearch')?.value || '';
    if      (division === 'PrivateSchools') renderPrivateSchools(q);
    else if (division === 'PublicSchools')  renderPublicSchools(q);
    else                                    renderSections(division, q);
}

// ─── Excel Export (xlsx-js-style@1.2.0) ──────────────────────────────
function sanitizeSheetName(name) {
    return (String(name||'Sheet').replace(/[\\/*?:\[\]]/g,'').trim()||'Sheet').slice(0,31);
}

function _formatExportDate(value) {
    const v = (value || '').toString().trim();
    if (!v || v === '—') return '';
    if (/^\d+(\.\d+)?$/.test(v)) {
        const serial = parseFloat(v);
        if (serial > 1000 && serial < 80000) {
            const d = new Date(new Date(Date.UTC(1899,11,30)).getTime() + serial * 86400000);
            return d.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric', timeZone:'UTC' });
        }
    }
    return formatDisplayDate(v) || v;
}

// xlsx-js-style requires: font.color.rgb, fill.fgColor.rgb — all 6-char hex, no alpha prefix
// Border sides: { style, color: { rgb } }
function _s(fontColor, bgColor, bold, sz, hAlign, vAlign, wrap, borderColor) {
    const side = borderColor
        ? { style:'thin', color:{ rgb: borderColor } } : undefined;
    return {
        font:      { name:'Arial', sz: sz||9, bold:!!bold, color:{ rgb: fontColor||'1E293B' } },
        fill:      { patternType:'solid', fgColor:{ rgb: bgColor||'FFFFFF' } },
        alignment: { horizontal: hAlign||'left', vertical: vAlign||'center', wrapText:!!wrap },
        border:    side ? { top:side, bottom:side, left:side, right:side } : undefined,
    };
}

// Preset styles — all using 6-char RGB
const S = {
    // Titles
    titleNavy:    _s('FFFFFF','1E3A5F', true, 13,'center','center',false,'1E3A5F'),
    titleRose:    _s('FFFFFF','9D174D', true, 13,'center','center',false,'9D174D'),
    // Sub-headers by division
    subBlue:      _s('FFFFFF','2563EB', true, 10,'center','center',false,'2563EB'),
    subGreen:     _s('FFFFFF','15803D', true, 10,'center','center',false,'15803D'),
    subPurple:    _s('FFFFFF','7C3AED', true, 10,'center','center',false,'7C3AED'),
    subAmber:     _s('FFFFFF','B45309', true, 10,'center','center',false,'B45309'),
    subRose:      _s('FFFFFF','BE185D', true, 10,'center','center',false,'BE185D'),
    // Column headers by division
    hdrBlue:      _s('1E3A5F','DBEAFE', true,  9,'center','center',true, '93C5FD'),
    hdrGreen:     _s('14532D','DCFCE7', true,  9,'center','center',true, '86EFAC'),
    hdrPurple:    _s('3B0764','EDE9FE', true,  9,'center','center',true, 'C4B5FD'),
    hdrAmber:     _s('451A03','FEF3C7', true,  9,'center','center',true, 'FCD34D'),
    hdrRose:      _s('4C0519','FFE4E6', true,  9,'center','center',true, 'FECDD3'),
    // District row
    distGreen:    _s('FFFFFF','16A34A', true,  9,'left',  'center',false,'16A34A'),
    // Data rows — even/odd pairs per division theme
    dataEvenBlue:  _s('1E293B','EFF6FF', false, 9,'left','center',true,'BFDBFE'),
    dataOddBlue:   _s('1E293B','FFFFFF', false, 9,'left','center',true,'DBEAFE'),
    dataEvenGreen: _s('1E293B','F0FDF4', false, 9,'left','center',true,'BBF7D0'),
    dataOddGreen:  _s('1E293B','FFFFFF', false, 9,'left','center',true,'DCFCE7'),
    dataEvenPurple:_s('1E293B','F5F3FF', false, 9,'left','center',true,'DDD6FE'),
    dataOddPurple: _s('1E293B','FFFFFF', false, 9,'left','center',true,'EDE9FE'),
    dataEvenAmber: _s('1E293B','FFFBEB', false, 9,'left','center',true,'FDE68A'),
    dataOddAmber:  _s('1E293B','FFFFFF', false, 9,'left','center',true,'FEF3C7'),
    dataEvenRose:  _s('1E293B','FFF1F2', false, 9,'left','center',true,'FECDD3'),
    dataOddRose:   _s('1E293B','FFFFFF', false, 9,'left','center',true,'FFE4E6'),
    // No. column (centered version of data)
    noEvenBlue:    _s('1E293B','EFF6FF', false, 9,'center','center',false,'BFDBFE'),
    noOddBlue:     _s('1E293B','FFFFFF', false, 9,'center','center',false,'DBEAFE'),
    noEvenGreen:   _s('1E293B','F0FDF4', false, 9,'center','center',false,'BBF7D0'),
    noOddGreen:    _s('1E293B','FFFFFF', false, 9,'center','center',false,'DCFCE7'),
    noEvenPurple:  _s('1E293B','F5F3FF', false, 9,'center','center',false,'DDD6FE'),
    noOddPurple:   _s('1E293B','FFFFFF', false, 9,'center','center',false,'EDE9FE'),
    noEvenAmber:   _s('1E293B','FFFBEB', false, 9,'center','center',false,'FDE68A'),
    noOddAmber:    _s('1E293B','FFFFFF', false, 9,'center','center',false,'FEF3C7'),
    noEvenRose:    _s('1E293B','FFF1F2', false, 9,'center','center',false,'FECDD3'),
    noOddRose:     _s('1E293B','FFFFFF', false, 9,'center','center',false,'FFE4E6'),
};

// Column letter from 0-based index
function _col(i) {
    let s = '';
    for (let n = i+1; n > 0; n = Math.floor((n-1)/26))
        s = String.fromCharCode(65 + (n-1)%26) + s;
    return s;
}

function _c(ws, row, col, value, style) {
    const ref = _col(col) + row;
    const v   = (value === null || value === undefined) ? '' : value;
    ws[ref]   = { v, t: typeof v === 'number' ? 'n' : 's', s: style };
    const cur = ws['!ref'] ? ws['!ref'].split(':')[1] : null;
    ws['!ref'] = `A1:${ref}`;
    if (cur) {
        // keep the furthest ref
        const curCol = cur.replace(/\d+/,''), curRow = parseInt(cur.replace(/[A-Z]+/,''));
        const newCol = _col(col), newRow = row;
        const maxCol = newCol > curCol ? newCol : curCol;
        const maxRow = newRow > curRow ? newRow : curRow;
        ws['!ref'] = `A1:${maxCol}${maxRow}`;
    }
}

function _mergeRow(ws, row, c1, c2, value, style) {
    for (let c = c1; c <= c2; c++) _c(ws, row, c, c === c1 ? value : '', style);
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s:{ r:row-1, c:c1 }, e:{ r:row-1, c:c2 } });
}

function _makeSheet(title, subTitle, headers, colWidths, titleStyle, subStyle, hdrStyle,
                    dataEvenStyle, dataOddStyle, noEvenStyle, noOddStyle) {
    const ws = {};
    const n  = headers.length;
    _mergeRow(ws, 1, 0, n-1, title,    titleStyle);
    _mergeRow(ws, 2, 0, n-1, subTitle, subStyle);
    headers.forEach((h, c) => _c(ws, 3, c, h, hdrStyle));
    ws['!cols'] = colWidths.map(wch => ({ wch }));
    ws['!rows'] = [{ hpx:26 }, { hpx:20 }, { hpx:18 }];
    ws['!ref']  = `A1:${_col(n-1)}3`;
    return { ws, n,
             addDataRow(r, values, isEven) {
                 const ds = isEven ? dataEvenStyle : dataOddStyle;
                 const ns = isEven ? noEvenStyle   : noOddStyle;
                 values.forEach((v, c) => _c(ws, r, c, v, c === 0 ? ns : ds));
                 ws['!rows'][r-1] = { hpx:17 };
             }
           };
}

// ── Division theme map ────────────────────────────────────────────────
const _DIV_THEME = {
    CID:  { sub: S.subBlue,   hdr: S.hdrBlue,   de: S.dataEvenBlue,   do_: S.dataOddBlue,   ne: S.noEvenBlue,   no_: S.noOddBlue   },
    OSDS: { sub: S.subGreen,  hdr: S.hdrGreen,  de: S.dataEvenGreen,  do_: S.dataOddGreen,  ne: S.noEvenGreen,  no_: S.noOddGreen  },
    SGOD: { sub: S.subPurple, hdr: S.hdrPurple, de: S.dataEvenPurple, do_: S.dataOddPurple, ne: S.noEvenPurple, no_: S.noOddPurple },
    LSB:  { sub: S.subAmber,  hdr: S.hdrAmber,  de: S.dataEvenAmber,  do_: S.dataOddAmber,  ne: S.noEvenAmber,  no_: S.noOddAmber  },
};

// ── Personnel sheet ───────────────────────────────────────────────────
function _buildPersonnelSheet(personnel, divLabel, divAbbr) {
    const t   = _DIV_THEME[divAbbr] || _DIV_THEME['CID'];
    const sh  = _makeSheet(
        `SDO CITY OF BALIUAG  —  ${divAbbr} PERSONNEL DIRECTORY`,
        divLabel,
        ['No.','Name','Position','Unit','Birthdate','Contact Number','E-mail Address'],
        [5, 36, 40, 32, 22, 18, 40],
        S.titleNavy, t.sub, t.hdr, t.de, t.do_, t.ne, t.no_
    );
    personnel.forEach((p, i) => {
        sh.addDataRow(i+4, [
            i+1,
            p.name           || '',
            p.position        || '',
            p.unit            || '',
            _formatExportDate(p.birthdate),
            p.contact_number  || '',
            p.email           || '',
        ], i%2===0);
    });
    sh.ws['!ref'] = `A1:${_col(sh.n-1)}${personnel.length + 3}`;
    return sh.ws;
}

// ── Public Schools sheet ──────────────────────────────────────────────
function _buildPublicSchoolsSheet(schools) {
    const sh = _makeSheet(
        'SDO CITY OF BALIUAG  —  OFFICIAL LIST OF PUBLIC SCHOOL HEADS',
        'Elementary and Secondary School Heads / Officers-in-Charge',
        ['No.','Name','Position','School ID','School Name','Birthdate','Contact Number','E-mail Address','First Day at Station'],
        [5, 36, 34, 12, 44, 22, 18, 38, 24],
        S.titleNavy, S.subBlue, S.hdrBlue,
        S.dataEvenGreen, S.dataOddGreen, S.noEvenGreen, S.noOddGreen
    );
    const dMap = {};
    schools.forEach(s => { const d = s.district||'No District'; (dMap[d]=dMap[d]||[]).push(s); });
    const keys = [...DISTRICT_ORDER.filter(d=>dMap[d]), ...Object.keys(dMap).filter(d=>!DISTRICT_ORDER.includes(d))];

    let row = 4, rowNum = 0;
    keys.forEach(dist => {
        _mergeRow(sh.ws, row, 0, sh.n-1, `  ${dist}`, S.distGreen);
        sh.ws['!rows'][row-1] = { hpx:18 };
        row++;
        dMap[dist].forEach((s, i) => {
            rowNum++;
            sh.addDataRow(row, [
                rowNum,
                s.name              || '',
                s.position          || '',
                s.school_id         || '',
                s.school_name       || '',
                _formatExportDate(s.birthdate),
                s.contact_number    || '',
                s.email             || '',
                _formatExportDate(s.first_day_station),
            ], rowNum%2===0);
            row++;
        });
    });
    sh.ws['!ref'] = `A1:${_col(sh.n-1)}${row-1}`;
    return sh.ws;
}

// ── Private Schools sheet ─────────────────────────────────────────────
function _buildPrivateSchoolsSheet(schools) {
    const sh = _makeSheet(
        'SDO CITY OF BALIUAG  —  OFFICIAL LIST OF PRIVATE SCHOOLS',
        'Private Schools and Administrators',
        ['No.','School Name','Status','Elem Admin','Elem Contact','JHS Admin','JHS Contact','SHS Admin','SHS Contact','Registrar','Registrar Contact'],
        [5, 44, 14, 28, 18, 28, 18, 28, 18, 28, 20],
        S.titleRose, S.subRose, S.hdrRose,
        S.dataEvenRose, S.dataOddRose, S.noEvenRose, S.noOddRose
    );
    schools.forEach((s, i) => {
        sh.addDataRow(i+4, [
            i+1,
            s.name                 || '',
            s.status               || '',
            s.elem?.admin          || '',
            s.elem?.contact        || '',
            s.jhs?.admin           || '',
            s.jhs?.contact         || '',
            s.shs?.admin           || '',
            s.shs?.contact         || '',
            s.registrar?.admin     || '',
            s.registrar?.contact   || '',
        ], i%2===0);
    });
    sh.ws['!ref'] = `A1:${_col(sh.n-1)}${schools.length + 3}`;
    return sh.ws;
}

function exportDirectoryExcel() {
    if (typeof XLSX === 'undefined') { showToast('Excel library unavailable.', 'danger'); return; }
    const q  = (document.getElementById('globalSearch')?.value || '').toLowerCase().trim();
    const wb = XLSX.utils.book_new();
    let sheetCount = 0;
    const matchQ = strs => !q || strs.some(s => (s||'').toLowerCase().includes(q));

    if (currentDivision === 'PublicSchools') {
        const schools = allPublicSchools.filter(s => matchQ([s.name, s.district, s.school_name]));
        if (!schools.length) { showToast('No public school records to export.', 'danger'); return; }
        XLSX.utils.book_append_sheet(wb, _buildPublicSchoolsSheet(schools), 'Public Schools');
        sheetCount++;
    } else if (currentDivision === 'PrivateSchools') {
        const schools = allPrivateSchools.filter(s => matchQ([s.name]));
        if (!schools.length) { showToast('No private school records to export.', 'danger'); return; }
        XLSX.utils.book_append_sheet(wb, _buildPrivateSchoolsSheet(schools), 'Private Schools');
        sheetCount++;
    } else {
        const divs = currentDivision === 'all' ? Object.keys(DIV_META) : [currentDivision];
        divs.forEach(div => {
            const rows = allPersonnel.filter(p => p.division === div && matchQ([p.name, p.position, p.unit]));
            if (!rows.length) return;
            XLSX.utils.book_append_sheet(wb, _buildPersonnelSheet(rows, DIV_META[div].label, div), sanitizeSheetName(div));
            sheetCount++;
        });
        if (!sheetCount) { showToast('No data to export.', 'danger'); return; }
    }
    const scope = currentDivision === 'all' ? 'all' : currentDivision.toLowerCase();
    XLSX.writeFile(wb, `directory_${scope}_${new Date().toISOString().slice(0,10)}.xlsx`);
    showToast('Exported successfully.', 'success');
}

async function exportAllExcel() {
    if (typeof XLSX === 'undefined') { showToast('Excel library unavailable.', 'danger'); return; }

    // If school data hasn't loaded yet, fetch it now before exporting
    if (!allPublicSchools.length || !allPrivateSchools.length) {
        showToast('Loading all data before export…', 'success');
        await loadDirectoryData();
    }

    const wb = XLSX.utils.book_new();
    let sheetCount = 0;

    // SDO Personnel — one sheet per division
    Object.keys(DIV_META).forEach(div => {
        const rows = allPersonnel.filter(p => p.division === div);
        if (!rows.length) return;
        XLSX.utils.book_append_sheet(wb, _buildPersonnelSheet(rows, DIV_META[div].label, div), sanitizeSheetName(div));
        sheetCount++;
    });

    // Public Schools
    if (allPublicSchools.length) {
        XLSX.utils.book_append_sheet(wb, _buildPublicSchoolsSheet(allPublicSchools), 'Public Schools');
        sheetCount++;
    }

    // Private Schools
    if (allPrivateSchools.length) {
        XLSX.utils.book_append_sheet(wb, _buildPrivateSchoolsSheet(allPrivateSchools), 'Private Schools');
        sheetCount++;
    }

    if (!sheetCount) { showToast('No data to export.', 'danger'); return; }
    const filename = `directory_complete_${new Date().toISOString().slice(0,10)}.xlsx`;
    try {
        XLSX.writeFile(wb, filename, { bookSST:false, type:'binary', cellStyles:true });
        showToast(`Exported all ${sheetCount} sheets successfully.`, 'success');
    } catch(err) {
        try { XLSX.writeFile(wb, filename); showToast(`Exported ${sheetCount} sheets.`, 'success'); }
        catch(e2) { showToast('Export failed.', 'danger'); }
    }
}

// ─── Toast ────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
    const t = document.getElementById('dirToast');
    if (!t) return;
    t.textContent = msg;
    t.className = `dir-toast show ${type}`;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ─── Util ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

// ─── bfcache guard ────────────────────────────────────────────────────
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
            .then(r => {
                if (!r.ok) { window.location.replace('login.html'); return; }
                if (!document.querySelector('.dir-modal-overlay.open')) loadDirectoryData();
            })
            .catch(() => {});
    }
});
