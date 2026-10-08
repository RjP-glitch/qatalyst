const API_URL = CONFIG.API_URL;

// ─── SECURITY: Auto-redirect if already authenticated ─────────────────────────
(async function checkExistingSession() {
    try {
        // GET /main-settings.php (no action param) returns profile if authenticated
        const response = await fetch(API_URL + '/main-settings.php', {
            method: 'GET',
            credentials: 'include'
        });
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
                const profile = data.data;

                // ── SECURITY: Block portal_user accounts from the SDO system ──
                // School portal users may have a valid session cookie but must
                // never be auto-redirected into the main SDO dashboard.
                if (profile.account_type === 'portal_user') {
                    return; // Stay on login page silently
                }

                // Rehydrate local session hints from server-side session.
                if (profile.id) localStorage.setItem('user_id', String(profile.id));
                if (profile.email) localStorage.setItem('email', profile.email);
                if (profile.full_name) localStorage.setItem('full_name', profile.full_name);
                if (profile.role) localStorage.setItem('role', profile.role);
                if (profile.account_type) localStorage.setItem('account_type', profile.account_type);
                if (Array.isArray(profile.permissions)) {
                    localStorage.setItem('permissions', JSON.stringify(profile.permissions));
                }

                window.location.href = 'dashboard.html';
            }
        }
        // 401 is expected for non-authenticated users - stay on login page
    } catch (e) {
        // Network error - stay on login page
    }
})();

// ─── SECURITY: Track login attempts client-side to reduce unnecessary requests ─
const MAX_CLIENT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
let clientAttempts = 0;
let lockoutUntil = null;

// ─── Toggle password visibility ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
    const passwordInput  = document.getElementById('password');
    const togglePassword = document.getElementById('togglePassword');

    if (passwordInput && togglePassword) {
        togglePassword.addEventListener('click', function () {
            const isPassword = passwordInput.type === 'password';
            passwordInput.type = isPassword ? 'text' : 'password';
            togglePassword.innerHTML = isPassword ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        });
    }

    // ─── Remember Me: pre-fill saved email ───────────────────────────
    const savedEmail = localStorage.getItem('remembered_email');
    if (savedEmail) {
        document.getElementById('email').value = savedEmail;
        document.getElementById('rememberMe').checked = true;
    }
});

// ─── Form elements ────────────────────────────────────────────────────────────
const loginForm    = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const loginBtn     = document.getElementById('loginBtn');

loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    // ─── SECURITY: Client-side lockout check ──────────────────────────────────
    if (lockoutUntil && Date.now() < lockoutUntil) {
        const remaining = Math.ceil((lockoutUntil - Date.now()) / 60000);
        showError(`Too many attempts. Please wait ${remaining} minute(s) before trying again.`);
        return;
    }

    const email    = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // ─── Basic validation ─────────────────────────────────────────────────────
    if (!email || !password) {
        showError('Please fill in all fields');
        return;
    }

    if (!isValidEmail(email)) {
        showError('Please enter a valid email address');
        return;
    }

    // ─── SECURITY: Sanity-check input length before sending ───────────────────
    if (email.length > 255 || password.length > 1024) {
        showError('Invalid input length');
        return;
    }

    setLoading(true);

    try {
        const response = await fetch(API_URL + '/login.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // SECURITY: credentials: 'include' ensures the HttpOnly session
            // cookie set by the server is sent/received automatically
            credentials: 'include',
            body: JSON.stringify({ email, password, portal: 'sdo' })
        });

        // ─── SECURITY: Handle unexpected HTTP status codes ────────────────────
        if (response.status === 429) {
            showError('Too many login attempts. Please wait 15 minutes and try again.');
            lockoutUntil = Date.now() + LOCKOUT_MS;
            return;
        }

        if (response.status === 403) {
            const errData = await response.json().catch(() => ({}));
            // Detect portal_user accounts trying to use the main system login
            if (errData.message && errData.message.includes('School Portal')) {
                showPortalRedirect();
            } else {
                showError(errData.message || 'Access denied. Please contact support.');
            }
            return;
        }

        if (response.status === 500) {
            showError('Server error. Please try again later.');
            return;
        }

        const data = await response.json();

        if (data.success) {
            // Reset client-side attempt counter on success
            clientAttempts = 0;
            lockoutUntil   = null;

            // ─── Remember Me: save or clear email ────────────────────────────
            const rememberMe = document.getElementById('rememberMe').checked;
            if (rememberMe) {
                localStorage.setItem('remembered_email', email);
            } else {
                localStorage.removeItem('remembered_email');
            }

            // ─── 2FA CHECK ────────────────────────────────────────────────────
            // If 2FA is enabled, redirect to verification page
            if (data.data.requires_2fa) {
                // Store temp info for 2FA page
                sessionStorage.setItem('2fa_temp_token', data.data.temp_token);
                sessionStorage.setItem('2fa_email', data.data.email);
                sessionStorage.setItem('2fa_full_name', data.data.full_name);
                window.location.href = 'verify-2fa.html?token=' + encodeURIComponent(data.data.temp_token);
                return;
            }

            // ─── SECURITY: Only store non-sensitive display info ──────────────
            // session_token is NOT in the response — it lives exclusively in the
            // HttpOnly cookie set by the server, which the browser manages
            // automatically and JS can never read.
            localStorage.setItem('user_id',      String(data.data.user_id));
            localStorage.setItem('email',        data.data.email);
            localStorage.setItem('full_name',    data.data.full_name);
            localStorage.setItem('role',         data.data.role || 'viewer');
            localStorage.setItem('account_type', data.data.account_type || 'sdo_personnel');

            // Store default permissions based on role for client-side UI hiding
            // Note: Actual authorization is always validated server-side
            const rolePermissions = {
                admin: ['dashboard', 'certificates', 'programs', 'speakers', 'checklist', 'users', 'settings'],
                facilitator: ['dashboard', 'certificates', 'programs', 'speakers', 'checklist'],
                evaluator: ['dashboard', 'checklist'],
                viewer: ['dashboard']
            };
            const role = data.data.role || 'viewer';
            const perms = data.data.permissions || rolePermissions[role] || rolePermissions.viewer;
            localStorage.setItem('permissions', JSON.stringify(perms));

            if (data.data.email_verified) {
                // Redirect to the first page the user has access to
                const storedPerms = JSON.parse(localStorage.getItem('permissions') || '[]');
                const isAdmin = (data.data.role || 'viewer') === 'admin';

                const permRoutes = [
                    { perm: 'dashboard',     url: 'dashboard.html' },
                    { perm: 'certificates',  url: 'certificate.html' },
                    { perm: 'programs',      url: 'programs.html' },
                    { perm: 'speakers',      url: 'speaker-roster.html' },
                    { perm: 'checklist',     url: 'checklist.html' },
                    { perm: 'users',         url: 'user-management.html' },
                    { perm: 'settings',      url: 'main-settings.html' },
                ];

                const target = isAdmin
                    ? 'dashboard.html'
                    : (permRoutes.find(r => storedPerms.includes(r.perm))?.url || 'main-settings.html');

                window.location.href = target;
            } else {
                // SECURITY: Use short-lived verify_token in URL instead of user_id
                window.location.href = 'verify-email.html?token=' + encodeURIComponent(data.data.verify_token);
            }

        } else {
            // ─── SECURITY: Increment attempt counter on failure ───────────────
            clientAttempts++;
            if (clientAttempts >= MAX_CLIENT_ATTEMPTS) {
                lockoutUntil = Date.now() + LOCKOUT_MS;
                showError('Too many failed attempts. Please wait 15 minutes before trying again.');
            } else {
                const remaining = MAX_CLIENT_ATTEMPTS - clientAttempts;
                showError(
                    (data.message || 'Invalid email or password') +
                    ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)`
                );
            }

            // ─── SECURITY: Clear password field on failed attempt ─────────────
            document.getElementById('password').value = '';
        }

    } catch (error) {
        // SECURITY: Never expose raw error details to the user
        console.error('Login error:', error);
        showError('Connection error. Please check your internet and try again.');
    } finally {
        setLoading(false);
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('show');
    setTimeout(() => errorMessage.classList.remove('show'), 5000);
}

/**
 * Shows a styled, persistent notice when a portal_user tries to log in here.
 * Replaces the generic error box with a friendlier message + redirect link.
 */
function showPortalRedirect() {
    errorMessage.innerHTML = `
        <span style="display:flex;align-items:flex-start;gap:10px;">
            <i class="fa-solid fa-circle-info" style="margin-top:2px;flex-shrink:0;"></i>
            <span>
                This account was registered through the <strong>School Portal</strong>.
                Please sign in at the
                <a href="school-portal.html"
                   style="color:inherit;font-weight:700;text-decoration:underline;">
                    School Portal page
                </a> instead.
            </span>
        </span>`;
    errorMessage.classList.add('show');
    // Keep it visible longer — user needs time to read and click the link
    setTimeout(() => errorMessage.classList.remove('show'), 12000);
}

function setLoading(isLoading) {
    loginBtn.disabled = isLoading;
    loginBtn.innerHTML = isLoading
        ? 'Signing in<span class="loading"></span><span class="loading"></span><span class="loading"></span>'
        : 'Sign In to Dashboard';
}