const API_URL = CONFIG.API_URL;

// Get temp token from URL or sessionStorage
const urlParams = new URLSearchParams(window.location.search);
let tempToken = urlParams.get('token') || sessionStorage.getItem('2fa_temp_token');
const userEmail = sessionStorage.getItem('2fa_email') || '';
const userName = sessionStorage.getItem('2fa_full_name') || 'User';

// If no token, redirect to login
if (!tempToken) {
    window.location.href = 'login.html';
}

// Display masked email
document.getElementById('userEmail').textContent = maskEmail(userEmail);

function maskEmail(email) {
    if (!email) return 'your email';
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const maskedLocal = local.length > 2 
        ? local[0] + '***' + local[local.length - 1] 
        : local[0] + '***';
    return maskedLocal + '@' + domain;
}

// Code input handling
const codeInputs = document.querySelectorAll('.code-input');
codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        const value = e.target.value.replace(/\D/g, '');
        e.target.value = value;
        
        if (value && index < codeInputs.length - 1) {
            codeInputs[index + 1].focus();
        }
        
        // Auto-submit when all digits entered
        if (getCode().length === 6) {
            document.getElementById('verifyForm').dispatchEvent(new Event('submit'));
        }
    });
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && index > 0) {
            codeInputs[index - 1].focus();
        }
    });
    
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pastedData = (e.clipboardData || window.clipboardData).getData('text');
        const digits = pastedData.replace(/\D/g, '').slice(0, 6);
        
        digits.split('').forEach((digit, i) => {
            if (codeInputs[i]) {
                codeInputs[i].value = digit;
            }
        });
        
        if (digits.length === 6) {
            document.getElementById('verifyForm').dispatchEvent(new Event('submit'));
        } else if (digits.length > 0) {
            codeInputs[Math.min(digits.length, 5)].focus();
        }
    });
});

// Focus first input on load
codeInputs[0].focus();

function getCode() {
    return Array.from(codeInputs).map(input => input.value).join('');
}

function clearCode() {
    codeInputs.forEach(input => input.value = '');
    codeInputs[0].focus();
}

// Timer for resend
let resendTimer = 60;
let timerInterval;

function startResendTimer() {
    const resendBtn = document.getElementById('resendBtn');
    const timerEl = document.getElementById('timer');
    
    resendBtn.disabled = true;
    resendTimer = 60;
    
    timerInterval = setInterval(() => {
        resendTimer--;
        timerEl.textContent = `Resend available in ${resendTimer}s`;
        
        if (resendTimer <= 0) {
            clearInterval(timerInterval);
            resendBtn.disabled = false;
            timerEl.textContent = '';
        }
    }, 1000);
}

startResendTimer();

// Show/hide messages
function showError(message) {
    const errorEl = document.getElementById('errorMessage');
    const successEl = document.getElementById('successMessage');
    successEl.style.display = 'none';
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function showSuccess(message) {
    const errorEl = document.getElementById('errorMessage');
    const successEl = document.getElementById('successMessage');
    errorEl.style.display = 'none';
    successEl.textContent = message;
    successEl.style.display = 'block';
}

function hideMessages() {
    document.getElementById('errorMessage').style.display = 'none';
    document.getElementById('successMessage').style.display = 'none';
}

function setLoading(loading) {
    const btn = document.getElementById('verifyBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnSpinner = btn.querySelector('.btn-spinner');
    
    btn.disabled = loading;
    btnText.textContent = loading ? 'Verifying...' : 'Verify Code';
    btnSpinner.style.display = loading ? 'inline-block' : 'none';
}

// Form submission
document.getElementById('verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const code = getCode();
    if (code.length !== 6) {
        showError('Please enter all 6 digits');
        return;
    }
    
    hideMessages();
    setLoading(true);
    
    try {
        const response = await fetch(API_URL + '/verify-2fa.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                temp_token: tempToken,
                code: code
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Clear session storage
            sessionStorage.removeItem('2fa_temp_token');
            sessionStorage.removeItem('2fa_email');
            sessionStorage.removeItem('2fa_full_name');
            
            // Store user info
            localStorage.setItem('user_id', String(data.data.user_id));
            localStorage.setItem('email', data.data.email);
            localStorage.setItem('full_name', data.data.full_name);
            localStorage.setItem('role', data.data.role || 'viewer');
            
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
            
            showSuccess('Verification successful! Redirecting...');
            
            setTimeout(() => {
                if (data.data.email_verified) {
                    window.location.href = 'dashboard.html';
                } else {
                        const token = data.data.verify_token;
                        window.location.href = token
                            ? ('verify-email.html?token=' + encodeURIComponent(token))
                            : 'verify-email.html';
                }
            }, 1000);
        } else {
            showError(data.message || 'Invalid verification code');
            clearCode();
        }
    } catch (error) {
        console.error('Verification error:', error);
        showError('Connection error. Please try again.');
        clearCode();
    } finally {
        setLoading(false);
    }
});

// Resend code
document.getElementById('resendBtn').addEventListener('click', async () => {
    hideMessages();
    
    try {
        const response = await fetch(API_URL + '/verify-2fa.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                temp_token: tempToken,
                code: '',
                action: 'resend'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess(data.message || 'A new code has been sent to your email');
            startResendTimer();
            clearCode();
        } else {
            showError(data.message || 'Failed to resend code');
            if (data.message && data.message.includes('log in again')) {
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 2000);
            }
        }
    } catch (error) {
        console.error('Resend error:', error);
        showError('Connection error. Please try again.');
    }
});
