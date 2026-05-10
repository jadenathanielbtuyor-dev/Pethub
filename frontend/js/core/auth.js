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
    });
  });
}

let registerRequestInProgress = false;
let loginRequestInProgress = false;

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
      setTimeout(() => {
        window.location.replace(PATHS.verifyEmail || './pages/auth/verify-email.html');
      }, 1100);
    } catch (error) {
      console.error('Registration failed:', error);
      const errorMessage = error.message || 'Unable to register. Please try again.';
      if (errorMessage === 'Email is already registered') {
        setFieldError('emailErrorMessage', errorMessage);
      } else {
        displayMessage(messageContainer, errorMessage, 'error');
      }
    } finally {
      registerRequestInProgress = false;
      setFormSubmitting(registerForm, false, 'Sending code...', 'Register');
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

      setUser(data.user);
      displayMessage(messageContainer, 'Login successful! Redirecting...', 'success');
      setTimeout(() => {
        redirectToDashboardForRole(String(data.user?.role || 'user').toLowerCase());
      }, 400);
    } catch (error) {
      console.error('Login failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to login. Please try again.', 'error');
    } finally {
      loginRequestInProgress = false;
      setFormSubmitting(loginForm, false, 'Logging in...', 'Login');
    }
  });
}
