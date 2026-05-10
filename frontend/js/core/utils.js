// ==================== SHARED UTILITIES ====================
// Consolidated utility functions to eliminate code duplication
// All modules should use these functions

function getApiBaseUrl() {
  return window.API_BASE_URL || 'http://localhost:5000';
}

/**
 * Format date string to readable format
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date (e.g., "Jan 15, 2024")
 */
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (error) {
    console.error('Date formatting error:', error);
    return 'Invalid date';
  }
}

/**
 * Format date with time
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date and time (e.g., "Jan 15, 2024 at 2:30 PM")
 */
function formatDateTime(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    const dateFormatted = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const timeFormatted = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${dateFormatted} at ${timeFormatted}`;
  } catch (error) {
    console.error('DateTime formatting error:', error);
    return 'Invalid date';
  }
}

/**
 * Get emoji representation of animal species
 * @param {string} species - Animal species name
 * @returns {string} Emoji character
 */
function getAnimalEmoji(species) {
  const speciesLower = String(species || '').toLowerCase().trim();
  const emojiMap = {
    'dog': '🐕',
    'cat': '🐈',
    'bird': '🦜',
    'rabbit': '🐰',
    'hamster': '🐹',
    'guinea pig': '🐹',
    'fish': '🐠',
    'reptile': '🦎',
    'snake': '🐍',
    'horse': '🐴',
    'ferret': '🦡',
    'other': '🐾'
  };
  return emojiMap[speciesLower] || '🐾';
}

/**
 * Check if a value represents verified/true status
 * @param {*} value - Value to check
 * @returns {boolean} True if value represents verified/true
 */
function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if email format is valid
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

/**
 * Display message with styling (success or error)
 * @param {HTMLElement} container - DOM element to display message in
 * @param {string} message - Message text
 * @param {string} type - Message type ('success' or 'error')
 */
function displayMessage(container, message, type) {
  if (!container) return;
  container.textContent = message;
  container.setAttribute('role', type === 'error' ? 'alert' : 'status');
  container.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  container.style.color = type === 'success' ? '#16a34a' : '#dc2626';
  container.style.backgroundColor = type === 'success' ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';
  container.style.border = type === 'success' ? '1px solid rgba(22, 163, 74, 0.2)' : '1px solid rgba(220, 38, 38, 0.2)';
  container.style.padding = '0.9rem 1rem';
  container.style.borderRadius = '0.75rem';
  container.classList.add('is-visible');
}

/**
 * Clear message display
 * @param {HTMLElement} container - DOM element to clear
 */
function clearMessage(container) {
  if (!container) return;
  container.textContent = '';
  container.removeAttribute('role');
  container.removeAttribute('aria-live');
  container.style.backgroundColor = '';
  container.style.border = '';
  container.style.color = '';
  container.style.padding = '';
  container.classList.remove('is-visible');
}

/**
 * Set field error message
 * @param {string} fieldId - ID of error message element
 * @param {string} message - Error message text
 */
function setFieldError(fieldId, message) {
  const fieldElement = document.getElementById(fieldId);
  if (!fieldElement) return;
  fieldElement.textContent = message || '';
  fieldElement.style.color = message ? '#dc2626' : '';
}

/**
 * Update button state during loading
 * @param {HTMLElement} button - Button element
 * @param {boolean} isLoading - Loading state
 * @param {string} loadingText - Text to show while loading
 * @param {string} defaultText - Default button text
 */
function updateButtonState(button, isLoading, loadingText, defaultText) {
  if (!button) return;

  if (isLoading) {
    if (!button.dataset.defaultHtml) {
      button.dataset.defaultHtml = button.innerHTML;
    }

    button.disabled = true;
    button.dataset.loading = 'true';
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-loading');
    button.innerHTML = `
      <span class="button-loading-content">
        <span class="button-loading-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(loadingText || 'Loading...')}</span>
      </span>
    `;
    return;
  }

  button.disabled = isLoading;
  button.dataset.loading = 'false';
  button.removeAttribute('aria-busy');
  button.classList.remove('is-loading');
  button.style.opacity = '';

  if (button.dataset.defaultHtml) {
    button.innerHTML = button.dataset.defaultHtml;
    delete button.dataset.defaultHtml;
    return;
  }

  button.textContent = defaultText || button.textContent;
}

function resetTwoClickConfirmation(button) {
  if (!button) return;

  const timeoutId = Number(button.dataset.confirmTimeoutId || 0);
  if (timeoutId) {
    window.clearTimeout(timeoutId);
  }

  button.dataset.confirmPending = 'false';
  delete button.dataset.confirmKey;
  delete button.dataset.confirmTimeoutId;
  button.classList.remove('is-confirm-pending');

  if (button.dataset.confirmDefaultHtml) {
    button.innerHTML = button.dataset.confirmDefaultHtml;
    delete button.dataset.confirmDefaultHtml;
  }
}

function requireSecondClick(button, options = {}) {
  if (!button || button.dataset.loading === 'true') return false;

  const confirmationKey = String(options.key || '');
  const message = options.message || 'Click again to confirm';
  const timeout = Number(options.timeout || 5000);
  const isPendingConfirmation = button.dataset.confirmPending === 'true'
    && button.dataset.confirmKey === confirmationKey;

  if (isPendingConfirmation) {
    resetTwoClickConfirmation(button);
    return true;
  }

  const actionButtons = Array.from(button.closest('div')?.querySelectorAll('button') || []);
  actionButtons.forEach(actionButton => {
    if (actionButton !== button) resetTwoClickConfirmation(actionButton);
  });

  if (!button.dataset.confirmDefaultHtml) {
    button.dataset.confirmDefaultHtml = button.innerHTML;
  }

  button.dataset.confirmPending = 'true';
  button.dataset.confirmKey = confirmationKey;
  button.classList.add('is-confirm-pending');
  button.textContent = message;

  const timeoutId = window.setTimeout(() => {
    if (button.dataset.confirmPending === 'true' && button.dataset.confirmKey === confirmationKey) {
      resetTwoClickConfirmation(button);
    }
  }, timeout);

  button.dataset.confirmTimeoutId = String(timeoutId);
  return false;
}

/**
 * Track form submission state and prevent duplicate submit attempts.
 * @param {HTMLFormElement} form - Form being submitted
 * @param {boolean} isSubmitting - Submission state
 * @param {string} loadingText - Loading text for the submit button
 * @param {string} defaultText - Fallback text if no original button HTML exists
 */
function setFormSubmitting(form, isSubmitting, loadingText, defaultText) {
  if (!form) return;
  form.dataset.submitting = isSubmitting ? 'true' : 'false';
  form.setAttribute('aria-busy', String(isSubmitting));
  updateButtonState(form.querySelector('button[type="submit"]'), isSubmitting, loadingText, defaultText);
}

function isFormSubmitting(form) {
  return form?.dataset?.submitting === 'true';
}

/**
 * Parse JSON response from fetch, handling empty responses
 * @param {Response} response - Fetch response object
 * @returns {Promise<Object>} Parsed JSON data
 * @throws {Error} If response is invalid
 */
async function getJsonFromResponse(response) {
  const text = await response.text();
  if (!text || text.trim() === '') {
    throw new Error(`Empty response from server (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid server response: ${text.substring(0, 100)}`);
  }
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML display
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Get password strength rating
 * @param {string} password - Password to evaluate
 * @returns {string} Strength level ('weak', 'good', 'strong')
 */
function getPasswordStrength(password) {
  if (password.length >= 12) return 'strong';
  if (password.length >= 8) return 'good';
  return 'weak';
}

/**
 * Calculate days until a target date
 * @param {string} dateString - Target date (ISO format)
 * @returns {number} Number of days until date (negative if past)
 */
function getDaysUntil(dateString) {
  if (!dateString) return -1;
  try {
    const targetDate = new Date(dateString);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    targetDate.setHours(0, 0, 0, 0);
    const diffTime = targetDate - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  } catch (error) {
    console.error('Days until calculation error:', error);
    return -1;
  }
}

/**
 * Get next appointment from list
 * @param {Array} appointments - Array of appointment objects
 * @returns {Object|null} Next upcoming appointment or null
 */
function getNextAppointment(appointments) {
  if (!Array.isArray(appointments) || appointments.length === 0) return null;
  
  const upcoming = appointments
    .filter(apt => apt && apt.appointment_date)
    .sort((a, b) => new Date(a.appointment_date) - new Date(b.appointment_date));
  
  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * Validate form input (non-empty, min length, max length)
 * @param {string} value - Input value
 * @param {string} fieldName - Field name for error messages
 * @param {number} minLength - Minimum length required
 * @param {number} maxLength - Maximum length allowed
 * @returns {Object} { valid: boolean, error: string }
 */
function validateInput(value, fieldName, minLength = 1, maxLength = 255) {
  if (!value || String(value).trim().length === 0) {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (String(value).length < minLength) {
    return { valid: false, error: `${fieldName} must be at least ${minLength} characters` };
  }
  if (String(value).length > maxLength) {
    return { valid: false, error: `${fieldName} must be less than ${maxLength} characters` };
  }
  return { valid: true, error: '' };
}

/**
 * Validate pet age (non-negative number)
 * @param {*} age - Age value to validate
 * @returns {Object} { valid: boolean, error: string }
 */
function validateAge(age) {
  if (age === null || age === undefined || age === '') return { valid: true, error: '' };
  const ageNum = Number(age);
  if (isNaN(ageNum)) return { valid: false, error: 'Age must be a number' };
  if (ageNum < 0) return { valid: false, error: 'Age cannot be negative' };
  if (ageNum > 100) return { valid: false, error: 'Age must be less than 100 years' };
  return { valid: true, error: '' };
}

/**
 * Validate appointment date (not in the past)
 * @param {string} dateString - Date to validate (ISO format)
 * @returns {Object} { valid: boolean, error: string }
 */
function validateAppointmentDate(dateString) {
  if (!dateString) return { valid: false, error: 'Appointment date is required' };
  
  const appointmentDate = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (appointmentDate < today) {
    return { valid: false, error: 'Appointment date cannot be in the past' };
  }
  
  return { valid: true, error: '' };
}

/**
 * Show error notification with styling
 * @param {string} message - Error message
 * @param {number} duration - Duration to show in milliseconds (default 4000)
 */
function showError(message, duration = 4000) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'fixed top-4 right-4 bg-red-500 text-white px-6 py-3 rounded-lg shadow-lg z-50';
  errorDiv.textContent = message;
  document.body.appendChild(errorDiv);
  
  setTimeout(() => {
    errorDiv.remove();
  }, duration);
}

/**
 * Show success notification with styling
 * @param {string} message - Success message
 * @param {number} duration - Duration to show in milliseconds (default 4000)
 */
function showSuccess(message, duration = 4000) {
  const successDiv = document.createElement('div');
  successDiv.className = 'fixed top-4 right-4 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg z-50';
  successDiv.textContent = message;
  document.body.appendChild(successDiv);
  
  setTimeout(() => {
    successDiv.remove();
  }, duration);
}

