function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === 'panel-' + tab);
    });
    // Scroll form panel to top on tab switch (better mobile UX)
    const formPanel = document.querySelector('.form-panel');
    if (formPanel) formPanel.scrollTop = 0;
}


function togglePwd(id, iconEl) {
    const input = document.getElementById(id);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    iconEl.innerHTML = hidden
        ? '<i class="fa-solid fa-eye"></i>'
        : '<i class="fa-solid fa-eye-slash"></i>';
}

function checkStrength(val) {
    const bar = document.getElementById('strengthBar');
    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    const colors = ['#EF4444', '#F97316', '#EAB308', '#22C55E'];
    const widths = ['25%', '50%', '75%', '100%'];
    bar.style.width = val.length ? (widths[score - 1] || '10%') : '0%';
    bar.style.background = val.length ? (colors[score - 1] || '#EF4444') : 'transparent';
}

// ─── School type toggle (Public / Private) ────────────────────────────────────
const API_BASE = CONFIG.API_URL;
let currentSchoolType = 'public'; // 'public' | 'private'

function onSchoolTypeChange(type) {
    currentSchoolType = type;

    // Toggle button active states
    document.getElementById('typeBtnPublic').classList.toggle('active', type === 'public');
    document.getElementById('typeBtnPrivate').classList.toggle('active', type === 'private');

    // Show/hide sections
    const districtGroup     = document.getElementById('districtGroup');
    const publicSchoolGroup = document.getElementById('publicSchoolGroup');
    const privateSchoolGroup = document.getElementById('privateSchoolGroup');
    
    if (type !== 'public') {
        const hint = document.getElementById('supervisorHint');
        if (hint) hint.style.display = 'none';
    }
    if (type === 'public') {
        districtGroup.style.display      = '';
        publicSchoolGroup.style.display  = '';
        privateSchoolGroup.style.display = 'none';
    } else {
        districtGroup.style.display      = 'none';
        publicSchoolGroup.style.display  = 'none';
        privateSchoolGroup.style.display = '';
        loadPrivateSchools();
    }

    clearCustomSchool();
}

// ─── Cascading District → School dropdowns (public) ──────────────────────────
async function loadDistricts() {
    const sel = document.getElementById('regDistrict');
    try {
        const res = await fetch(`${API_BASE}/get-districts.php`, { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.data.length) {
            data.data.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = d.name;
                opt.dataset.supervisor = d.supervisor ?? ''; // ← add this
                sel.appendChild(opt);
            });
        } else {
            sel.innerHTML = '<option value="">Districts unavailable — contact SDO or try again.</option>';
        }
    } catch {
        sel.innerHTML = '<option value="">Unable to load districts — please try again.</option>';
    }
}

async function onDistrictChange(sel) {
    const schoolSel = document.getElementById('regSchoolSelect');
    const districtId = sel.value;

    // ── Supervisor hint ──────────────────────────────────────────
    const hint = document.getElementById('supervisorHint');
    if (!districtId) {
        hint.style.display = 'none';
    } else {
        const supervisor = sel.options[sel.selectedIndex]?.dataset.supervisor;
        if (supervisor) {
            hint.textContent = `District Supervisor: ${supervisor}`;
            hint.style.display = 'flex';
        } else {
            hint.style.display = 'none';
        }
    }
    // ─────────────────────────────────────────────────────────────

    schoolSel.innerHTML = '<option value="">Loading schools...</option>';
    schoolSel.disabled = true;
    clearCustomSchool();

    if (!districtId) {
        schoolSel.innerHTML = '<option value="">Select district first...</option>';
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/get-public-schools.php?district_id=${districtId}`, { credentials: 'include' });
        const data = await res.json();

        schoolSel.innerHTML = '<option value="">Select school...</option>';

        if (data.success && data.data.length) {
            data.data.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.dataset.name = s.name;
                opt.dataset.depedId = s.deped_school_id ?? '';
                opt.dataset.levels = s.levels ?? '';
                opt.textContent = s.name;
                schoolSel.appendChild(opt);
            });
        }
    } catch {
        schoolSel.innerHTML = '<option value="">Could not load schools</option>';
    }


    schoolSel.disabled = false;
}

// ─── Auto-check Department/Level boxes from a school's `levels` JSON ─────────
function applyLevelCheckboxes(levelsJson) {
    let levels = [];
    if (levelsJson) {
        try {
            const parsed = JSON.parse(levelsJson);
            if (Array.isArray(parsed)) levels = parsed;
        } catch {
            levels = [];
        }
    }
    document.querySelectorAll('#regLevelsGroup input[name="regLevel"]').forEach(cb => {
        cb.checked = levels.includes(cb.value);
    });
}

function onSchoolChange(sel) {
    applyLevelCheckboxes(sel.options[sel.selectedIndex]?.dataset.levels);
    showSelectedSchoolId(sel);
}
function showSelectedSchoolId(sel) {
    const hint = document.getElementById('schoolIdHint');
    const id = sel.options[sel.selectedIndex]?.dataset.depedId || '';
    hint.textContent = id ? `Selected school DepEd ID: ${id}` : '';
    hint.style.display = id ? 'flex' : 'none';
}

// ─── Private school flat list ─────────────────────────────────────────────────
let _privateSchoolsLoaded = false;

async function loadPrivateSchools() {
    if (_privateSchoolsLoaded) return;
    const sel = document.getElementById('regPrivateSchoolSelect');
    sel.innerHTML = '<option value="">Loading...</option>';
    sel.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/get-private-schools.php`, { credentials: 'include' });
        const data = await res.json();

        sel.innerHTML = '<option value="">Select school...</option>';

        if (data.success && data.data.length) {
            data.data.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.dataset.name = s.name;
                opt.dataset.depedId = s.school_id_no ?? '';
                opt.dataset.levels = s.levels ?? '';
                opt.textContent = s.name;
                sel.appendChild(opt);
            });
            _privateSchoolsLoaded = true;
        }
    } catch {
        // Fallback on network error
        sel.innerHTML = '<option value="">Could not load schools</option>';
    }


    sel.disabled = false;
}

function onPrivateSchoolChange(sel) {
    applyLevelCheckboxes(sel.options[sel.selectedIndex]?.dataset.levels);
    showSelectedSchoolId(sel);
}
function clearCustomSchool() {
    document.getElementById('schoolIdHint').style.display = 'none';
    applyLevelCheckboxes(null);
}
function getSchoolValue() {
    const sel = document.getElementById(currentSchoolType === 'private' ? 'regPrivateSchoolSelect' : 'regSchoolSelect');
    return { school_id: sel.value || null, school_name: sel.value ? (sel.options[sel.selectedIndex]?.dataset.name || '') : '' };
}
// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('edu_remembered_email');
    if (saved) {
        document.getElementById('loginEmail').value = saved;
        document.getElementById('rememberMe').checked = true;
    }
    loadDistricts();
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showMsg(id, msg, type = 'error') {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
    if (type === 'error') setTimeout(() => el.classList.remove('show'), 5000);
}

function setLoading(btnId, loading, defaultText) {
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.innerHTML = loading
        ? `Processing<span class="loading"></span><span class="loading"></span><span class="loading"></span>`
        : defaultText;
}

// ─── Login ────────────────────────────────────────────────────────────────────
let loginAttempts = 0, lockoutUntil = null;
const MAX_ATTEMPTS = 5, LOCKOUT_MS = 15 * 60 * 1000;

async function handleLogin(e) {
    e.preventDefault();

    if (lockoutUntil && Date.now() < lockoutUntil) {
        const mins = Math.ceil((lockoutUntil - Date.now()) / 60000);
        showMsg('loginError', `Too many attempts. Wait ${mins} min(s) and try again.`);
        return;
    }

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) { showMsg('loginError', 'Please fill in all fields.'); return; }
    if (email.length > 255 || password.length > 1024) { showMsg('loginError', 'Invalid input.'); return; }

    setLoading('loginBtn', true, 'Sign In to Dashboard');

    try {
        // ── Now points to the dedicated school portal login endpoint ──────────
        const res = await fetch(`${API_BASE}/school-login.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password })
        });

        // ── Rate limit ────────────────────────────────────────────────────────
        if (res.status === 429) {
            lockoutUntil = Date.now() + LOCKOUT_MS;
            showMsg('loginError', 'Too many attempts. Please wait 15 minutes.');
            return;
        }

        // ── Wrong portal (SDO account trying to use school portal) ────────────
        if (res.status === 403) {
            const errData = await res.json().catch(() => ({}));
            showMsg('loginError', errData.message || 'Access denied. Please contact support.');
            return;
        }

        const data = await res.json();

        if (data.success) {
            loginAttempts = 0;
            lockoutUntil = null;

            if (document.getElementById('rememberMe').checked) {
                localStorage.setItem('edu_remembered_email', email);
            } else {
                localStorage.removeItem('edu_remembered_email');
            }

            localStorage.setItem('edu_school_approved', '0');
            localStorage.setItem('edu_user_id', String(data.data.user_id));
            localStorage.setItem('edu_email', data.data.email);
            localStorage.setItem('edu_full_name', data.data.full_name);
            localStorage.setItem('edu_role', data.data.role || 'teacher');
            localStorage.setItem('edu_account_type', data.data.account_type || 'portal_user');

            if (data.data.email_verified) {
                window.location.href = 'school-portal-dashboard.html';
            } else {
                const params = new URLSearchParams({
                    token: data.data.verify_token,
                    email: data.data.email,
                    email_sent: data.data.verification_email_sent === false ? '0' : '1'
                });
                window.location.href = 'school-portal-verify.html?' + params.toString();
            }

        } else {
            document.getElementById('loginPassword').value = '';

            // 401 = wrong credentials → count against attempt limit
            // anything else → show server message as-is, don't penalise counter
            if (res.status === 401) {
                loginAttempts++;
                if (loginAttempts >= MAX_ATTEMPTS) {
                    lockoutUntil = Date.now() + LOCKOUT_MS;
                    showMsg('loginError', 'Too many failed attempts. Try again in 15 minutes.');
                } else {
                    const left = MAX_ATTEMPTS - loginAttempts;
                    showMsg('loginError', `Invalid email or password. (${left} attempt${left !== 1 ? 's' : ''} left)`);
                }
            } else {
                showMsg('loginError', data.message || 'Sign-in failed. Please try again.');
            }
        }

    } catch (err) {
        console.error(err);
        showMsg('loginError', 'Connection error. Check your internet and try again.');
    } finally {
        setLoading('loginBtn', false, 'Sign In to Dashboard');
    }
}

// ─── Register ─────────────────────────────────────────────────────────────────
async function handleRegister(e) {
    e.preventDefault();

    const role = 'teacher';
    const firstName = document.getElementById('regFirstName').value.trim();
    const lastName = document.getElementById('regLastName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const sex = document.getElementById('regSex')?.value || 'Prefer not to say';
    const districtId = document.getElementById('regDistrict').value;
    const { school_id, school_name } = getSchoolValue();
    const grade = JSON.stringify(
        [...document.querySelectorAll('input[name="regLevel"]:checked')]
            .map(cb => cb.value)
    );
    const schoolId = document.getElementById('regSchoolId').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirm').value;

    document.getElementById('regError').classList.remove('show');
    document.getElementById('regSuccess').classList.remove('show');

    if (!firstName || !lastName || !email || !school_id || !school_name || !password || !confirm) {
        showMsg('regError', 'Please fill in all required fields.'); return;
    }
    if (currentSchoolType === 'public' && !districtId) {
        showMsg('regError', 'Please select a district.'); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMsg('regError', 'Please enter a valid email address.'); return;
    }
    if (password.length < 8) {
        showMsg('regError', 'Password must be at least 8 characters.'); return;
    }
    if (password !== confirm) {
        showMsg('regError', 'Passwords do not match.'); return;
    }

    setLoading('regBtn', true, 'Create My Account');

    try {
        const res = await fetch(`${API_BASE}/school-portal-register.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                role,
                sex,
                first_name: firstName,
                last_name: lastName,
                email,
                school_type: currentSchoolType,
                district_id: currentSchoolType === 'public' ? districtId : null,
                school_id,
                school: school_name,
                grade,
                school_id_no: schoolId,
                password
            })
        });

        const data = await res.json();

        if (data.success) {
            localStorage.setItem('edu_school_approved', '0');
            localStorage.setItem('edu_school_name', school_name);
            localStorage.setItem('edu_district_id', districtId);
            localStorage.setItem('edu_school_id', school_id || '');
            localStorage.setItem('edu_grade', grade || '');
            localStorage.setItem('edu_school_id_no', schoolId || '');

            const districtOpt = document.getElementById('regDistrict');
            const districtText = districtOpt.options[districtOpt.selectedIndex]?.textContent || '';
            localStorage.setItem('edu_district_name', districtText);

            showMsg('regSuccess', data.message || 'Account created. Redirecting to email verification...', 'success');
            setTimeout(() => {
                const params = new URLSearchParams({
                    token: data.data.verify_token,
                    email: data.data.email,
                    email_sent: data.data.verification_email_sent === false ? '0' : '1'
                });
                window.location.href = 'school-portal-verify.html?' + params.toString();
            }, 1500);

        } else {
            showMsg('regError', data.message || 'Registration failed. Please try again.');
        }

    } catch (err) {
        console.error(err);
        showMsg('regError', 'Connection error. Check your internet and try again.');
    } finally {
        setLoading('regBtn', false, 'Create My Account');
    }
}
