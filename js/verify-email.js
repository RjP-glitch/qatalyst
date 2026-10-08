const API_URL = CONFIG.API_URL;

const verificationForm = document.getElementById('verificationForm');
const codeInputs = document.querySelectorAll('.code-input');
const errorMessage = document.getElementById('errorMessage');
const successMessage = document.getElementById('successMessage');
const emailDisplay = document.getElementById('emailDisplay');
const resendBtn = document.getElementById('resendBtn');
const timer = document.getElementById('timer');
const submitBtn = document.getElementById('submitBtn');
const backBtn = document.getElementById('backBtn');

let token = null;
let resendTimer = 0;
let resendInterval = null;

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'your email';
    const [localPart, domain] = email.split('@');
    if (localPart.length <= 2) return `${localPart[0] || '*'}*@${domain}`;
    const maskedLocal = localPart.charAt(0) + '*'.repeat(Math.max(localPart.length - 2, 1)) + localPart.charAt(localPart.length - 1);
    return maskedLocal + '@' + domain;
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('show');
    successMessage.classList.remove('show');
    setTimeout(() => errorMessage.classList.remove('show'), 6000);
}

function showSuccess(message) {
    successMessage.textContent = message;
    successMessage.classList.add('show');
    errorMessage.classList.remove('show');
    setTimeout(() => successMessage.classList.remove('show'), 6000);
}

function clearInputs() {
    codeInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

function highlightErrorInputs() {
    codeInputs.forEach(input => {
        if (!input.value) input.classList.add('error');
    });
}

function startResendTimer(seconds = 60) {
    clearInterval(resendInterval);
    resendTimer = seconds;
    resendBtn.classList.add('disabled');
    timer.textContent = `(${resendTimer}s)`;

    resendInterval = setInterval(() => {
        resendTimer--;
        if (resendTimer <= 0) {
            clearInterval(resendInterval);
            resendBtn.classList.remove('disabled');
            timer.textContent = '';
        } else {
            timer.textContent = `(${resendTimer}s)`;
        }
    }, 1000);
}

async function apiPost(body) {
    const response = await fetch(API_URL + '/verify-email.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data || data.success === false) {
        const msg = data?.message || 'Request failed. Please try again.';
        const err = new Error(msg);
        err.status = response.status;
        throw err;
    }

    return data;
}

async function resendCode(auto = false) {
    if (!token) {
        showError('Missing verification token. Please log in again.');
        return;
    }

    try {
        const data = await apiPost({ token, action: 'resend' });
        showSuccess(data.message || (auto ? 'Verification code sent.' : 'A new code has been sent to your email.'));
        clearInputs();
        codeInputs[0]?.focus();
        startResendTimer(60);
    } catch (e) {
        // 429 from server is common for rate limiting
        if (e.status === 429) {
            showError(e.message || 'Too many resend attempts. Please wait and try again.');
        } else if (e.status === 401 || e.status === 410) {
            showError(e.message || 'Verification link expired. Please log in again.');
            setTimeout(() => window.location.href = 'login.html', 2000);
        } else {
            showError(e.message || 'Could not resend code. Please try again.');
        }
    }
}

function getEnteredCode() {
    return Array.from(codeInputs).map(i => i.value).join('');
}

function setLoading(isLoading) {
    submitBtn.disabled = !!isLoading;
    if (isLoading) submitBtn.classList.add('loading');
    else submitBtn.classList.remove('loading');
}

// ─── Input UX ───────────────────────────────────────────────────────────────-
codeInputs.forEach((input, index) => {
    input.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
        if (this.value.length === 1) {
            this.classList.remove('error');
            this.classList.add('filled');
            if (index < codeInputs.length - 1) codeInputs[index + 1].focus();
        }
    });

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && this.value.length === 0) {
            this.classList.remove('filled');
            if (index > 0) codeInputs[index - 1].focus();
        }
    });

    input.addEventListener('paste', function (e) {
        e.preventDefault();
        const pastedText = (e.clipboardData || window.clipboardData).getData('text');
        const pastedNumbers = pastedText.replace(/[^0-9]/g, '').slice(0, 6);
        pastedNumbers.split('').forEach((char, i) => {
            if (i < codeInputs.length) {
                codeInputs[i].value = char;
                codeInputs[i].classList.add('filled');
            }
        });
        if (pastedNumbers.length === 6) codeInputs[5].focus();
    });

    input.addEventListener('focus', function () { this.select(); });
});

// ─── Form submit ─────────────────────────────────────────────────────────────
verificationForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = getEnteredCode();

    if (!token) {
        showError('Missing verification token. Please log in again.');
        return;
    }

    if (code.length !== 6) {
        showError('Please enter all 6 digits of the verification code.');
        highlightErrorInputs();
        return;
    }

    if (!/^[0-9]{6}$/.test(code)) {
        showError('The code must contain only numbers.');
        highlightErrorInputs();
        return;
    }

    setLoading(true);
    try {
        const data = await apiPost({ token, code });

        // Seed localStorage for UI hints. Auth is still cookie-based.
        const profile = data.data || {};
        if (profile.id) localStorage.setItem('user_id', String(profile.id));
        if (profile.email) localStorage.setItem('email', profile.email);
        if (profile.full_name) localStorage.setItem('full_name', profile.full_name);
        if (profile.role) localStorage.setItem('role', profile.role);
        if (profile.account_type) localStorage.setItem('account_type', profile.account_type);

        showSuccess(data.message || 'Email verified successfully! Redirecting…');
        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 1200);

    } catch (e2) {
        showError(e2.message || 'Invalid or expired verification code. Please try again.');
        clearInputs();
        codeInputs[0]?.focus();
    } finally {
        setLoading(false);
    }
});

// ─── Resend ─────────────────────────────────────────────────────────────────
resendBtn.addEventListener('click', () => {
    if (resendBtn.classList.contains('disabled')) return;
    resendCode(false);
});

backBtn.addEventListener('click', () => {
    window.location.href = 'login.html';
});

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    token = params.get('token');

    const email = localStorage.getItem('email') || '';
    emailDisplay.textContent = maskEmail(email);

    // If we have no token, there is nothing to verify.
    if (!token) {
        showError('Missing verification token. Please log in again.');
        setTimeout(() => window.location.href = 'login.html', 2000);
        return;
    }

    // Automatically send the first code for login-triggered verification flows.
    resendCode(true);

    // Start countdown immediately; resendCode() will reset it on success.
    startResendTimer(60);
    codeInputs[0]?.focus();
});
