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

// ==================== REGISTRATION ====================
// pages/auth/register.html. The rules below match backend validators/authValidator.js (constants/userProfile.js);
// they give immediate messages beside each field, and the server checks everything again.
const REGISTER_PASSWORD_MIN_LENGTH = 8;
const REGISTER_PASSWORD_MAX_LENGTH = 128;
const REGISTER_EARLIEST_DATE_OF_BIRTH = '1900-01-01';
const REGISTER_GENDER_OPTIONS = ['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say'];
const REGISTER_ADDRESS_LIMITS = {
  address_line: { label: 'House/Unit/Street', max: 150 },
  barangay: { label: 'Barangay', max: 100 },
  city_municipality: { label: 'City/Municipality', max: 100 },
  province: { label: 'Province', max: 100 }
};

// Input id -> field name sent to POST /auth/register (and returned as `field` in its errors). Error elements are `${id}Error`.
const REGISTER_FIELDS = [
  { id: 'fullname', name: 'fullname' },
  { id: 'email', name: 'email' },
  { id: 'password', name: 'password' },
  { id: 'confirmPassword', name: 'confirm_password' },
  { id: 'dateOfBirth', name: 'date_of_birth' },
  { id: 'gender', name: 'gender' },
  { id: 'phoneNumber', name: 'phone_number' },
  { id: 'addressLine', name: 'address_line' },
  { id: 'barangay', name: 'barangay' },
  { id: 'cityMunicipality', name: 'city_municipality' },
  { id: 'province', name: 'province' },
  { id: 'postalCode', name: 'postal_code' }
];
const REGISTER_OPTIONAL_FIELDS = ['date_of_birth', 'gender', 'phone_number', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'];
const EMAIL_ALREADY_REGISTERED_MESSAGE = 'Email already registered';

function getLocalDateInputValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isCalendarDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isPhilippineMobileNumber(value) {
  return value.length <= 20 && /^(?:\+?63|0)9\d{9}$/.test(value.replace(/[\s().-]/g, ''));
}

function readRegisterValues() {
  const read = id => document.getElementById(id)?.value ?? '';
  const text = id => read(id).trim().replace(/\s+/g, ' ');
  // A date the browser could not understand reads as '' with validity.badInput set
  const dateInput = document.getElementById('dateOfBirth');
  return {
    fullname: text('fullname'),
    email: read('email').trim(),
    password: read('password'),
    confirm_password: read('confirmPassword'),
    date_of_birth: dateInput?.validity?.badInput ? 'invalid' : read('dateOfBirth').trim(),
    gender: read('gender'),
    phone_number: read('phoneNumber').trim(),
    address_line: text('addressLine'),
    barangay: text('barangay'),
    city_municipality: text('cityMunicipality'),
    province: text('province'),
    postal_code: read('postalCode').trim()
  };
}

// The message to show beside a field, or '' when its value is acceptable
function getRegisterFieldError(name, values) {
  const value = values[name] || '';

  if (name === 'fullname') {
    if (!value) return 'Enter your full name.';
    if (value.length > 100) return 'Full name must be 100 characters or fewer.';
    return /\p{L}/u.test(value) ? '' : 'Enter your full name using letters.';
  }
  if (name === 'email') {
    if (!value) return 'Enter your email address.';
    return value.length <= 254 && isValidEmail(value) ? '' : 'Enter a valid email address, such as name@example.com.';
  }
  if (name === 'password') {
    if (!value.trim()) return 'Create a password.';
    if (value.length < REGISTER_PASSWORD_MIN_LENGTH) return `Use at least ${REGISTER_PASSWORD_MIN_LENGTH} characters.`;
    return value.length <= REGISTER_PASSWORD_MAX_LENGTH ? '' : `Use ${REGISTER_PASSWORD_MAX_LENGTH} characters or fewer.`;
  }
  if (name === 'confirm_password') {
    if (!value) return 'Type your password again.';
    return value === values.password ? '' : 'Passwords do not match.';
  }
  if (name === 'date_of_birth') {
    if (!value) return '';
    if (!isCalendarDateValue(value)) return 'Enter a valid date of birth.';
    if (value > getLocalDateInputValue()) return 'Date of birth cannot be in the future.';
    return value >= REGISTER_EARLIEST_DATE_OF_BIRTH ? '' : 'Enter a date of birth from 1900 onwards.';
  }
  if (name === 'gender') {
    return !value || REGISTER_GENDER_OPTIONS.includes(value) ? '' : 'Choose one of the listed options.';
  }
  if (name === 'phone_number') {
    return !value || isPhilippineMobileNumber(value) ? '' : 'Enter a Philippine mobile number, such as 0917 123 4567.';
  }
  if (name === 'postal_code') {
    return !value || /^\d{4}$/.test(value) ? '' : 'Enter a 4-digit postal code.';
  }
  const address = REGISTER_ADDRESS_LIMITS[name];
  if (address && value.length > address.max) return `${address.label} must be ${address.max} characters or fewer.`;
  return '';
}

function setRegisterFieldError(field, message) {
  const input = document.getElementById(field.id);
  const error = document.getElementById(`${field.id}Error`);
  if (input) {
    input.classList.toggle('is-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
}

// Returns true when the field has a problem (and shows it)
function validateRegisterField(field, values = readRegisterValues()) {
  const message = getRegisterFieldError(field.name, values);
  setRegisterFieldError(field, message);
  return Boolean(message);
}

// Optional fields sit in a collapsible section, so it is opened before focusing one of them
function focusRegisterField(field) {
  const input = document.getElementById(field.id);
  if (!input) return;
  const section = input.closest('details');
  if (section && !section.open) section.open = true;
  input.focus();
}

function updatePasswordGuidance() {
  const password = document.getElementById('password')?.value || '';
  const rule = document.getElementById('passwordLengthRule');
  const strength = document.getElementById('passwordStrength');
  const lengthMet = password.length >= REGISTER_PASSWORD_MIN_LENGTH && password.length <= REGISTER_PASSWORD_MAX_LENGTH;

  if (rule) {
    rule.dataset.met = String(lengthMet);
    const icon = rule.querySelector('i');
    if (icon) icon.className = lengthMet ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line';
  }

  if (!strength) return;
  const level = !password ? '' : getPasswordStrength(password);
  strength.dataset.strength = level;
  strength.textContent = {
    '': '',
    weak: `Too short: ${REGISTER_PASSWORD_MIN_LENGTH - password.length} more character${REGISTER_PASSWORD_MIN_LENGTH - password.length === 1 ? '' : 's'} needed.`,
    good: 'Strength: good. More characters make it stronger.',
    strong: 'Strength: strong.'
  }[level];
}

// Passwords are never kept after a failed attempt: both fields are emptied and hidden again
function clearRegisterPasswords() {
  [['password', 'togglePassword'], ['confirmPassword', 'togglePasswordConfirm']].forEach(([inputId, buttonId]) => {
    const input = document.getElementById(inputId);
    const button = document.getElementById(buttonId);
    if (input) {
      input.value = '';
      input.type = 'password';
    }
    if (button) {
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = '<i class="ri-eye-line" aria-hidden="true"></i>';
    }
  });
  REGISTER_FIELDS.filter(field => field.name === 'password' || field.name === 'confirm_password')
    .forEach(field => setRegisterFieldError(field, ''));
  updatePasswordGuidance();
}

// Only the expected fields are sent; optional details only when filled in
function buildRegisterPayload(values) {
  const payload = {
    fullname: values.fullname,
    email: values.email,
    password: values.password,
    confirm_password: values.confirm_password
  };
  REGISTER_OPTIONAL_FIELDS.forEach(name => {
    if (values[name]) payload[name] = values[name];
  });
  return payload;
}

// variant: 'sent' (code emailed) | 'delayed' | 'not_sent' (account created, code still to be sent from the verification page)
function showRegisterSuccess(email, variant) {
  const form = document.getElementById('registerForm');
  const formView = document.getElementById('registerFormView');
  const panel = document.getElementById('registerSuccess');
  const title = document.getElementById('registerSuccessTitle');
  const message = document.getElementById('registerSuccessMessage');
  const icon = document.querySelector('#registerSuccessIcon i');

  if (!formView || !panel || !title || !message) {
    window.location.replace(PATHS.verifyEmail);
    return;
  }

  const emailText = document.createElement('strong');
  emailText.textContent = email;

  if (variant === 'sent') {
    title.textContent = 'Check your email';
    message.replaceChildren('Your account was created. We sent a 6-digit verification code to ', emailText, '. Enter it on the next page to activate your account.');
  } else if (variant === 'delayed') {
    title.textContent = 'Account created';
    message.replaceChildren('Your account was created. Email delivery is delayed, so the code for ', emailText, ' may take a few minutes. If it does not arrive, choose "Resend Code" on the next page.');
  } else {
    title.textContent = 'Account created';
    message.replaceChildren('Your account was created, but we could not send the verification code to ', emailText, ' yet. Continue to the next page and choose "Resend Code".');
  }
  panel.dataset.variant = variant === 'sent' ? 'success' : 'warning';
  if (icon) icon.className = variant === 'sent' ? 'ri-mail-send-line' : 'ri-mail-close-line';

  // The entered details are not needed any more
  if (form) form.reset();
  REGISTER_FIELDS.forEach(field => setRegisterFieldError(field, ''));
  updatePasswordGuidance();

  formView.hidden = true;
  panel.hidden = false;
  title.focus();
}

function getRegisterServerFieldMessage(field, errorMessage) {
  if (errorMessage === EMAIL_ALREADY_REGISTERED_MESSAGE) {
    return 'An account with this email already exists. Log in, or use Forgot Password on the login page.';
  }
  return errorMessage;
}

function setupRegisterForm() {
  const registerForm = document.getElementById('registerForm');
  if (!registerForm) return;

  const dateOfBirthInput = document.getElementById('dateOfBirth');
  if (dateOfBirthInput) dateOfBirthInput.max = getLocalDateInputValue();

  const continueLink = document.getElementById('registerContinueLink');
  if (continueLink && typeof PATHS !== 'undefined' && PATHS.verifyEmail) continueLink.href = PATHS.verifyEmail;

  // Fields are checked when the customer leaves them, and re-checked while typing once they show a message
  REGISTER_FIELDS.forEach(field => {
    const input = document.getElementById(field.id);
    if (!input) return;

    input.addEventListener('blur', () => {
      if (input.value || input.dataset.touched === 'true' || input.validity?.badInput) {
        input.dataset.touched = 'true';
        validateRegisterField(field);
      }
    });

    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (input.getAttribute('aria-invalid') === 'true') validateRegisterField(field);
      if (field.name === 'password') {
        updatePasswordGuidance();
        const confirmation = document.getElementById('confirmPassword');
        const confirmField = REGISTER_FIELDS.find(entry => entry.name === 'confirm_password');
        if (confirmation && confirmation.dataset.touched === 'true' && confirmation.value) validateRegisterField(confirmField);
      }
    });
  });
  updatePasswordGuidance();

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (registerRequestInProgress || isFormSubmitting(registerForm)) return;

    const messageContainer = document.getElementById('formMessageContainer');
    clearMessage(messageContainer);

    const values = readRegisterValues();
    const invalidFields = REGISTER_FIELDS.filter(field => validateRegisterField(field, values));
    if (invalidFields.length > 0) {
      displayMessage(messageContainer, invalidFields.length === 1
        ? 'Please fix the highlighted field.'
        : `Please fix the ${invalidFields.length} highlighted fields.`, 'error');
      focusRegisterField(invalidFields[0]);
      return;
    }

    registerRequestInProgress = true;
    setFormSubmitting(registerForm, true, 'Creating account...', 'Create Account');
    let finished = false;

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRegisterPayload(values))
      });
      const data = await getJsonFromResponse(response);

      if (response.ok && data.success !== false) {
        const registeredEmail = data.email || values.email.toLowerCase();
        savePendingVerificationEmail(registeredEmail);
        showRegisterSuccess(registeredEmail, 'sent');
        finished = true;
        return;
      }

      const errorMessage = data.error || `Registration failed (${response.status}). Please try again.`;

      // The account exists but its code email failed; the verification page can resend it
      if (isAccountCreatedRegistrationError(errorMessage)) {
        const registeredEmail = values.email.toLowerCase();
        savePendingVerificationEmail(registeredEmail);
        showRegisterSuccess(registeredEmail, errorMessage.startsWith('Email delivery is delayed.') ? 'delayed' : 'not_sent');
        finished = true;
        return;
      }

      clearRegisterPasswords();
      const fieldName = data.field || (errorMessage === EMAIL_ALREADY_REGISTERED_MESSAGE ? 'email' : '');
      const field = REGISTER_FIELDS.find(entry => entry.name === fieldName);
      if (field) {
        setRegisterFieldError(field, getRegisterServerFieldMessage(field, errorMessage));
        displayMessage(messageContainer, 'Please check the highlighted field, then enter your password again.', 'error');
        focusRegisterField(field);
      } else {
        displayMessage(messageContainer, `${errorMessage} Please enter your password again before retrying.`, 'error');
      }
    } catch (error) {
      console.error('Registration failed:', error.message);
      clearRegisterPasswords();
      displayMessage(messageContainer, 'We could not create your account right now. Check your connection, enter your password again, and try once more.', 'error');
    } finally {
      // After success the form stays locked, so nothing can be sent twice
      if (!finished) {
        registerRequestInProgress = false;
        setFormSubmitting(registerForm, false, 'Creating account...', 'Create Account');
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
