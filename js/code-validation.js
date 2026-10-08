const verificationForm = document.getElementById('verificationForm');
const codeInputs = document.querySelectorAll('.code-input');
const errorMessage = document.getElementById('errorMessage');
const successMessage = document.getElementById('successMessage');
const emailDisplay = document.getElementById('emailDisplay');
const resendBtn = document.getElementById('resendBtn');
const timer = document.getElementById('timer');
const submitBtn = document.getElementById('submitBtn');

let resendTimer = 0;
let verificationCode = '123456';
let userEmail = 'user@example.com';

document.addEventListener('DOMContentLoaded', function () {
    const urlParams = new URLSearchParams(window.location.search);
    userEmail = urlParams.get('email') || userEmail;
    emailDisplay.textContent = maskEmail(userEmail);
    verificationCode = generateCode();
    startResendTimer();
    codeInputs[0].focus();
});

verificationForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const enteredCode = Array.from(codeInputs).map(input => input.value).join('');

    if (enteredCode.length !== 6) {
        showError('Please enter all 6 digits of the verification code.');
        highlightErrorInputs();
        return;
    }

    if (!enteredCode.match(/^\d{6}$/)) {
        showError('The code must contain only numbers.');
        highlightErrorInputs();
        return;
    }

    if (enteredCode === verificationCode) {
        submitBtn.disabled = true;
        showSuccess('✓ Code verified! Redirecting to your dashboard...');
        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 1800);
    } else {
        showError('Invalid verification code. Please check and try again.');
        highlightErrorInputs();
        clearInputs();
    }
});

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

resendBtn.addEventListener('click', function () {
    if (!this.classList.contains('disabled')) {
        verificationCode = generateCode();
        showSuccess('✓ New code sent to ' + maskEmail(userEmail));
        clearInputs();
        codeInputs[0].focus();
        startResendTimer();
    }
});

function maskEmail(email) {
    const [localPart, domain] = email.split('@');
    const maskedLocal = localPart.charAt(0) + '*'.repeat(Math.max(localPart.length - 2, 1)) + localPart.charAt(localPart.length - 1);
    return maskedLocal + '@' + domain;
}

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function showError(message) {
    errorMessage.textContent = '❌ ' + message;
    errorMessage.classList.add('show');
    successMessage.classList.remove('show');
    setTimeout(() => errorMessage.classList.remove('show'), 5000);
}

function showSuccess(message) {
    successMessage.textContent = message;
    successMessage.classList.add('show');
    errorMessage.classList.remove('show');
    setTimeout(() => successMessage.classList.remove('show'), 5000);
}

function highlightErrorInputs() {
    codeInputs.forEach(input => {
        if (!input.value) input.classList.add('error');
    });
}

function clearInputs() {
    codeInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

function startResendTimer() {
    resendTimer = 60;
    resendBtn.classList.add('disabled');
    const interval = setInterval(() => {
        resendTimer--;
        timer.textContent = `(${resendTimer}s)`;
        if (resendTimer === 0) {
            clearInterval(interval);
            resendBtn.classList.remove('disabled');
            timer.textContent = '';
        }
    }, 1000);
}

function goBack() {
    window.history.back();
}