// ===== CONFIG =====
const API_URL = CONFIG.API_URL;
// ===================================================

let currentStep = 1;
let userEmail = '';
let resetToken = '';
let resendTimer = 0;

// ===== STEP 1: EMAIL FORM SUBMISSION =====
document.getElementById('emailForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    userEmail = document.getElementById('email').value;
    const emailSubmitBtn = document.getElementById('emailSubmitBtn');

    if (!isValidEmail(userEmail)) {
        showError('Please enter a valid email address');
        return;
    }

    emailSubmitBtn.disabled = true;
    emailSubmitBtn.innerHTML = 'Sending<span class="loading"></span><span class="loading"></span><span class="loading"></span>';

    try {
        const response = await fetch(API_URL + '/forgot-password.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: userEmail })
        });

        const data = await response.json();

        if (data.success) {
            resetToken = data.data.token;
            showSuccess('Verification code sent to ' + userEmail);
            setTimeout(() => nextStep(), 1500);
        } else {
            showError(data.message);
        }
    } catch (error) {
        showError('Connection error. Please try again.');
    } finally {
        emailSubmitBtn.disabled = false;
        emailSubmitBtn.innerHTML = 'Send Verification Code';
    }
});

// ===== STEP 2: CODE VERIFICATION =====
document.getElementById('codeForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const codeInputs = document.querySelectorAll('.code-input');
    const enteredCode = Array.from(codeInputs).map(input => input.value).join('');
    const codeSubmitBtn = document.getElementById('codeSubmitBtn');

    // FIX: was 4, now correctly 6
    if (enteredCode.length !== 6) {
        showError('Please enter all 6 digits');
        highlightEmptyInputs();
        return;
    }

    if (!enteredCode.match(/^\d{6}$/)) {
        showError('Code must contain only numbers');
        return;
    }

    codeSubmitBtn.disabled = true;
    codeSubmitBtn.innerHTML = 'Verifying<span class="loading"></span><span class="loading"></span><span class="loading"></span>';

    try {
        const response = await fetch(API_URL + '/verify-reset-code.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resetToken, code: enteredCode })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Code verified successfully!');
            setTimeout(() => nextStep(), 1500);
        } else {
            showError(data.message || 'Invalid verification code');
            clearCodeInputs();
        }
    } catch (error) {
        showError('Connection error. Please try again.');
    } finally {
        codeSubmitBtn.disabled = false;
        codeSubmitBtn.innerHTML = 'Verify Code';
    }
});

// ===== STEP 3: PASSWORD RESET =====
document.getElementById('resetForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const resetSubmitBtn = document.getElementById('resetSubmitBtn');

    if (newPassword !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }

    if (!validatePassword(newPassword)) {
        showError('Password does not meet requirements');
        return;
    }

    resetSubmitBtn.disabled = true;
    resetSubmitBtn.innerHTML = 'Resetting<span class="loading"></span><span class="loading"></span><span class="loading"></span>';

    try {
        // FIX: collect 6 digits for reset payload too
        const codeInputs = document.querySelectorAll('.code-input');
        const code = Array.from(codeInputs).map(input => input.value).join('');

        // Validate that we still have the code from step 2
        if (!code || code.length !== 6) {
            showError('Session expired. Please start the password reset process again.');
            setTimeout(() => { window.location.href = 'forgot-password.html'; }, 2000);
            return;
        }

        // Validate that we have the token
        if (!resetToken) {
            showError('Session expired. Please start the password reset process again.');
            setTimeout(() => { window.location.href = 'forgot-password.html'; }, 2000);
            return;
        }

        const response = await fetch(API_URL + '/reset-password.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: resetToken,
                code: code,
                password: newPassword,
                password_confirm: confirmPassword
            })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Password reset successfully! Redirecting...');
            setTimeout(() => { window.location.href = 'login.html'; }, 2000);
        } else {
            showError(data.message || 'Failed to reset password');
        }
    } catch (error) {
        console.error('Reset password error:', error);
        showError('Connection error. Please try again.');
    } finally {
        resetSubmitBtn.disabled = false;
        resetSubmitBtn.innerHTML = 'Reset Password';
    }
});

// ===== CODE INPUT AUTO-FOCUS & STYLING =====
// NOTE: querySelectorAll runs at page load and gets the 6 inputs from the DOM
const codeInputs = document.querySelectorAll('.code-input');
codeInputs.forEach((input, index) => {
    input.addEventListener('input', function() {
        // Only allow digits
        this.value = this.value.replace(/[^0-9]/g, '');

        if (this.value.length === 1) {
            this.classList.add('filled');
            this.classList.remove('error');
            if (index < codeInputs.length - 1) {
                codeInputs[index + 1].focus();
            }
        }
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Backspace' && this.value.length === 0) {
            this.classList.remove('filled');
            if (index > 0) {
                codeInputs[index - 1].focus();
            }
        }
    });

    input.addEventListener('paste', function(e) {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text');
        const digits = pasted.replace(/[^0-9]/g, '').slice(0, 6);
        digits.split('').forEach((char, i) => {
            if (i < codeInputs.length) {
                codeInputs[i].value = char;
                codeInputs[i].classList.add('filled');
            }
        });
        const nextEmpty = digits.length < 6 ? digits.length : 5;
        codeInputs[nextEmpty].focus();
    });

    input.addEventListener('focus', function() { this.select(); });
});

// ===== PASSWORD STRENGTH VALIDATION =====
document.getElementById('newPassword').addEventListener('input', function() {
    validatePasswordStrength(this.value);
});

// ===== RESEND CODE BUTTON =====
document.getElementById('resendBtn').addEventListener('click', async function() {
    if (resendTimer === 0 && !this.classList.contains('disabled')) {
        const resendBtn = this;
        resendBtn.classList.add('disabled');

        try {
            const response = await fetch(API_URL + '/forgot-password.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userEmail })
            });

            const data = await response.json();

            if (data.success) {
                resetToken = data.data.token;
                showSuccess('New code sent to ' + userEmail);
                clearCodeInputs();
                startResendTimer();
            } else {
                showError(data.message);
                resendBtn.classList.remove('disabled');
            }
        } catch (error) {
            showError('Connection error. Please try again.');
            resendBtn.classList.remove('disabled');
        }
    }
});

// ===== NAVIGATION =====
function nextStep() {
    currentStep++;
    updateSteps();
    updateStepContent();
}

function goBackStep() {
    currentStep--;
    updateSteps();
    updateStepContent();
}

function updateSteps() {
    // Update side panel circles
    for (let i = 1; i <= 3; i++) {
        const circle = document.getElementById(`sideCircle${i}`);
        const label = document.getElementById(`sideLabel${i}`);

        circle.classList.remove('completed', 'active', 'pending');
        label.classList.remove('pending');

        if (i < currentStep) {
            circle.classList.add('completed');
            circle.textContent = '✓';
        } else if (i === currentStep) {
            circle.classList.add('active');
            circle.textContent = i;
        } else {
            circle.classList.add('pending');
            circle.textContent = i;
            label.classList.add('pending');
        }
    }

    // Update eyebrow label
    document.getElementById('formEyebrow').textContent = `Step ${currentStep} of 3`;
}

function updateStepContent() {
    document.getElementById('stepOne').classList.toggle('hidden', currentStep !== 1);
    document.getElementById('stepTwo').classList.toggle('hidden', currentStep !== 2);
    document.getElementById('stepThree').classList.toggle('hidden', currentStep !== 3);

    if (currentStep === 2) {
        // Show masked email
        document.getElementById('emailDisplay').textContent = maskEmail(userEmail);
        setTimeout(() => {
            const firstInput = document.querySelector('.code-input');
            if (firstInput) firstInput.focus();
        }, 100);
        startResendTimer();
    }
}

// ===== HELPER FUNCTIONS =====
function maskEmail(email) {
    const [localPart, domain] = email.split('@');
    if (!domain) return email;
    const maskedLocal = localPart.charAt(0) + '*'.repeat(Math.max(localPart.length - 2, 1)) + localPart.charAt(localPart.length - 1);
    return maskedLocal + '@' + domain;
}

function validatePassword(password) {
    return password.length >= 8
        && /[A-Z]/.test(password)
        && /[a-z]/.test(password)
        && /\d/.test(password);
}

function validatePasswordStrength(password) {
    const requirements = {
        length: password.length >= 8,
        uppercase: /[A-Z]/.test(password),
        lowercase: /[a-z]/.test(password),
        number: /\d/.test(password)
    };

    Object.keys(requirements).forEach(key => {
        const el = document.getElementById(`req-${key}`);
        if (el) el.classList.toggle('met', requirements[key]);
    });
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(message) {
    const el = document.getElementById('errorMessage');
    el.textContent = '❌ ' + message;
    el.classList.add('show');
    document.getElementById('successMessage').classList.remove('show');
    setTimeout(() => el.classList.remove('show'), 5000);
}

function showSuccess(message) {
    const el = document.getElementById('successMessage');
    el.textContent = '✓ ' + message;
    el.classList.add('show');
    document.getElementById('errorMessage').classList.remove('show');
    setTimeout(() => el.classList.remove('show'), 5000);
}

function clearCodeInputs() {
    document.querySelectorAll('.code-input').forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

function highlightEmptyInputs() {
    document.querySelectorAll('.code-input').forEach(input => {
        if (!input.value) input.classList.add('error');
    });
}

function startResendTimer() {
    resendTimer = 60;
    const resendBtn = document.getElementById('resendBtn');
    const timerSpan = document.getElementById('timer');

    resendBtn.classList.add('disabled');
    timerSpan.classList.remove('hidden');

    const interval = setInterval(() => {
        resendTimer--;
        timerSpan.textContent = `(${resendTimer}s)`;

        if (resendTimer === 0) {
            clearInterval(interval);
            resendBtn.classList.remove('disabled');
            timerSpan.classList.add('hidden');
        }
    }, 1000);
}