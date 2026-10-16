// ==================== AUTHENTICATION ====================
// Uses shared utilities from core/utils.js

document.addEventListener('DOMContentLoaded', () => {
  setupPasswordToggles();
  setupRegisterForm();
  setupLoginForm();
});

function setupPasswordToggles() {
  const togglePairs = [
    { fieldId: 'password', buttonId: 'togglePassword' },
    { fieldId: 'confirmPassword', buttonId: 'togglePasswordConfirm' }
  ];

  togglePairs.forEach(({ fieldId, buttonId }) => {
    const field = document.getElementById(fieldId);
    const button = document.getElementById(buttonId);
    if (!field || !button) return;

    button.addEventListener('click', (event) => {
      event.preventDefault();
      const isPassword = field.type === 'password';
      field.type = isPassword ? 'text' : 'password';
      button.innerHTML = isPassword ? '<i class="ri-eye-off-line"></i>' : '<i class="ri-eye-line"></i>';
      button.setAttribute('aria-pressed', String(isPassword));
    });
  });
}

let registerRequestInProgress = false;
let loginRequestInProgress = false;

// Backend messages (services/authService.js) for an account that exists but still needs email verification
const UNVERIFIED_LOGIN_MESSAGE = 'Please verify your email first before logging in.';
const ACCOUNT_CREATED_REGISTRATION_ERRORS = [
  'Registration created, but failed to send verification email.',
  'Email delivery is delayed.',
  'Failed to initialize email verification'
];

function isAccountCreatedRegistrationError(message) {
  return ACCOUNT_CREATED_REGISTRATION_ERRORS.some(prefix => String(message || '').startsWith(prefix));
}

function savePendingVerificationEmail(email) {
  if (!email) return;
  sessionStorage.setItem('pendingVerificationEmail', email);
}

function savePendingVerificationCode(code) {
  if (!code) return;
  sessionStorage.setItem('pendingVerificationCode', code);
}

function clearPendingVerificationEmail() {
  sessionStorage.removeItem('pendingVerificationEmail');
}

function clearPendingVerificationCode() {
  sessionStorage.removeItem('pendingVerificationCode');
}

function setupRegisterForm() {
  const registerForm = document.getElementById('registerForm');
  if (!registerForm) return;

  const passwordInput = document.getElementById('password');
  const passwordHint = document.getElementById('passwordHint');

  if (passwordInput && passwordHint) {
    passwordInput.addEventListener('input', () => {
      const strength = getPasswordStrength(passwordInput.value);
      passwordHint.textContent = strength === 'strong'
        ? 'Strong password' : strength === 'good'
        ? 'Good password, consider adding more characters.' : 'Use at least 8 characters.';
      passwordHint.style.color = strength === 'strong' ? '#16a34a' : '#d97706';
    });
  }

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (registerRequestInProgress) return;
    registerRequestInProgress = true;

    const fullname = document.getElementById('fullname').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const messageContainer = document.getElementById('formMessageContainer');

    clearMessage(messageContainer);
    setFieldError('emailErrorMessage', '');

    if (!fullname || !email || !password || !confirmPassword) {
      displayMessage(messageContainer, 'Please complete every field before continuing.', 'error');
      registerRequestInProgress = false;
      return;
    }

    if (!isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address.', 'error');
      registerRequestInProgress = false;
      return;
    }

    if (password.length < 8) {
      displayMessage(messageContainer, 'Password must be at least 8 characters long.', 'error');
      registerRequestInProgress = false;
      return;
    }

    if (password !== confirmPassword) {
      displayMessage(messageContainer, 'Passwords do not match.', 'error');
      registerRequestInProgress = false;
      return;
    }

    setFormSubmitting(registerForm, true, 'Sending code...', 'Register');
    let redirecting = false;

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullname, email, password })
      });

      const data = await getJsonFromResponse(response);
      if (!response.ok) {
        throw new Error(data.error || `Registration failed (${response.status})`);
      }

      savePendingVerificationEmail(email);
      if (data.devCode) {
        savePendingVerificationCode(data.devCode);
        displayMessage(messageContainer, `Registration successful. Use demo code: ${data.devCode}`, 'success');
      } else {
        displayMessage(messageContainer, 'Registration successful. Check your email for the verification code.', 'success');
      }
      redirecting = true;
      setTimeout(() => {
        window.location.replace(PATHS.verifyEmail || './pages/auth/verify-email.html');
      }, 1100);
    } catch (error) {
      console.error('Registration failed:', error);
      const errorMessage = error.message || 'Unable to register. Please try again.';
      if (errorMessage === 'Email already registered') {
        setFieldError('emailErrorMessage', errorMessage);
      } else if (isAccountCreatedRegistrationError(errorMessage)) {
        // The account exists but the code email failed; the verification page can resend it
        savePendingVerificationEmail(email);
        displayMessage(messageContainer, `${errorMessage} Redirecting to verification...`, 'error');
        redirecting = true;
        setTimeout(() => {
          window.location.replace(PATHS.verifyEmail);
        }, 2500);
      } else {
        displayMessage(messageContainer, errorMessage, 'error');
      }
    } finally {
      // Keep the form locked while redirecting so a second click can't resubmit
      if (!redirecting) {
        registerRequestInProgress = false;
        setFormSubmitting(registerForm, false, 'Sending code...', 'Register');
      }
    }
  });
}

function setupLoginForm() {
  const loginForm = document.getElementById('loginForm');
  if (!loginForm) return;

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (loginRequestInProgress) return;
    loginRequestInProgress = true;

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const messageContainer = document.getElementById('formMessageContainer');

    if (!email || !password) {
      displayMessage(messageContainer, 'Enter your email and password to continue.', 'error');
      loginRequestInProgress = false;
      return;
    }

    if (!isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address.', 'error');
      loginRequestInProgress = false;
      return;
    }

    setFormSubmitting(loginForm, true, 'Logging in...', 'Login');
    let redirecting = false;

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await getJsonFromResponse(response);
      if (!response.ok) {
        throw new Error(data.error || `Login failed (${response.status})`);
      }

      if (!data.token) {
        throw new Error('Login failed: no session was returned. Please try again.');
      }

      setUser(data.user);
      setAuthToken(data.token);
      displayMessage(messageContainer, 'Login successful! Redirecting...', 'success');
      redirecting = true;
      setTimeout(() => {
        redirectToDashboardForRole(String(data.user?.role || 'user').toLowerCase());
      }, 400);
    } catch (error) {
      console.error('Login failed:', error);
      const errorMessage = error.message || 'Unable to login. Please try again.';
      if (errorMessage === UNVERIFIED_LOGIN_MESSAGE) {
        // Unverified accounts can only finish setup on the verification page
        savePendingVerificationEmail(email);
        displayMessage(messageContainer, `${errorMessage} Redirecting to verification...`, 'error');
        redirecting = true;
        setTimeout(() => {
          window.location.replace(PATHS.verifyEmail);
        }, 2000);
      } else {
        displayMessage(messageContainer, errorMessage, 'error');
      }
    } finally {
      // Keep the form locked while redirecting so a second click can't resubmit
      if (!redirecting) {
        loginRequestInProgress = false;
        setFormSubmitting(loginForm, false, 'Logging in...', 'Login');
      }
    }
  });
}
