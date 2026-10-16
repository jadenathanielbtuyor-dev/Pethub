// ==================== PASSWORD RESET ====================
// Forgot-password flow: request a 6-digit code by email, then choose a new password with it.
// Codes and passwords are only sent in POST bodies and are never stored in the browser.
// Uses shared utilities from core/utils.js; password show/hide buttons come from core/auth.js.

document.addEventListener('DOMContentLoaded', () => {
  setupRequestResetForm();
  setupResetPasswordForm();
  setupResendResetCodeButton();
  setupHaveCodeButton();
});

const RESET_CODE_RESEND_COOLDOWN_SECONDS = 60;
let resetCodeRequestInProgress = false;
let resetPasswordRequestInProgress = false;
let resetCodeCooldownActive = false;

async function postPasswordResetRequest(path, payload) {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await getJsonFromResponse(response);
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function showResetPasswordStep(email) {
  const resetEmail = document.getElementById('resetEmail');
  document.getElementById('requestResetForm')?.classList.add('hidden');
  document.getElementById('haveCodeWrapper')?.classList.add('hidden');
  document.getElementById('resetPasswordForm')?.classList.remove('hidden');
  document.getElementById('resendResetCodeWrapper')?.classList.remove('hidden');

  const intro = document.getElementById('resetIntro');
  if (intro) intro.textContent = 'Enter the 6-digit code from your email and choose a new password.';

  if (resetEmail && email) resetEmail.value = email;
  (resetEmail && !resetEmail.value ? resetEmail : document.getElementById('resetCode'))?.focus();
}

function setupRequestResetForm() {
  const requestForm = document.getElementById('requestResetForm');
  if (!requestForm) return;

  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (resetCodeRequestInProgress) return;
    resetCodeRequestInProgress = true;

    const email = document.getElementById('requestEmail').value.trim();
    const messageContainer = document.getElementById('requestMessageContainer');
    clearMessage(messageContainer);

    if (!email || !isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address.', 'error');
      resetCodeRequestInProgress = false;
      return;
    }

    setFormSubmitting(requestForm, true, 'Sending code...', 'Send Reset Code');

    try {
      const data = await postPasswordResetRequest('/auth/forgot-password', { email });
      showResetPasswordStep(email);
      displayMessage(document.getElementById('formMessageContainer'), data.message || 'If an account exists for that email, a reset code has been sent.', 'success');
      startResetCodeCooldown(document.getElementById('resendResetCodeButton'));
    } catch (error) {
      console.error('Password reset request failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to send a reset code. Please try again.', 'error');
    } finally {
      resetCodeRequestInProgress = false;
      setFormSubmitting(requestForm, false, 'Sending code...', 'Send Reset Code');
    }
  });
}

function setupResetPasswordForm() {
  const resetForm = document.getElementById('resetPasswordForm');
  if (!resetForm) return;

  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (resetPasswordRequestInProgress) return;
    resetPasswordRequestInProgress = true;

    const email = document.getElementById('resetEmail').value.trim();
    const code = document.getElementById('resetCode').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const messageContainer = document.getElementById('formMessageContainer');
    clearMessage(messageContainer);

    const formError = !email || !code || !password || !confirmPassword ? 'Please complete every field before continuing.'
      : !isValidEmail(email) ? 'Enter a valid email address.'
      : !/^\d{6}$/.test(code) ? 'Enter the 6-digit code sent to your email.'
      : password.length < 8 ? 'Password must be at least 8 characters long.'
      : password !== confirmPassword ? 'Passwords do not match.'
      : '';
    if (formError) {
      displayMessage(messageContainer, formError, 'error');
      resetPasswordRequestInProgress = false;
      return;
    }

    setFormSubmitting(resetForm, true, 'Resetting...', 'Reset Password');
    let redirecting = false;

    try {
      const data = await postPasswordResetRequest('/auth/reset-password', { email, code, password });
      document.getElementById('resetCode').value = '';
      document.getElementById('password').value = '';
      document.getElementById('confirmPassword').value = '';
      displayMessage(messageContainer, `${data.message || 'Your password has been reset.'} Redirecting to login...`, 'success');
      redirecting = true;
      setTimeout(() => {
        window.location.replace(PATHS.login);
      }, 1500);
    } catch (error) {
      console.error('Password reset failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to reset your password. Please try again.', 'error');
    } finally {
      // Keep the form locked while redirecting so a second click can't resubmit
      if (!redirecting) {
        resetPasswordRequestInProgress = false;
        setFormSubmitting(resetForm, false, 'Resetting...', 'Reset Password');
      }
    }
  });
}

function setupResendResetCodeButton() {
  const resendButton = document.getElementById('resendResetCodeButton');
  if (!resendButton) return;

  resendButton.addEventListener('click', async (event) => {
    event.preventDefault();
    if (resetCodeRequestInProgress || resetCodeCooldownActive) return;
    resetCodeRequestInProgress = true;

    const email = document.getElementById('resetEmail').value.trim();
    const messageContainer = document.getElementById('formMessageContainer');
    if (!email || !isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address before resending.', 'error');
      resetCodeRequestInProgress = false;
      return;
    }

    updateButtonState(resendButton, true, 'Sending...', 'Resend code');

    try {
      const data = await postPasswordResetRequest('/auth/forgot-password', { email });
      displayMessage(messageContainer, data.message || 'If an account exists for that email, a new reset code has been sent.', 'success');
      startResetCodeCooldown(resendButton);
    } catch (error) {
      console.error('Resend reset code failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to resend the code. Please try again.', 'error');
      updateButtonState(resendButton, false, 'Sending...', 'Resend code');
    } finally {
      resetCodeRequestInProgress = false;
    }
  });
}

function setupHaveCodeButton() {
  const haveCodeButton = document.getElementById('haveCodeButton');
  if (!haveCodeButton) return;

  haveCodeButton.addEventListener('click', (event) => {
    event.preventDefault();
    showResetPasswordStep(document.getElementById('requestEmail').value.trim());
  });
}

function startResetCodeCooldown(button) {
  if (!button) return;
  updateButtonState(button, false, 'Sending...', 'Resend code');
  resetCodeCooldownActive = true;
  let remaining = RESET_CODE_RESEND_COOLDOWN_SECONDS;
  button.disabled = true;
  button.textContent = `Resend in ${remaining}s`;

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      resetCodeCooldownActive = false;
      button.disabled = false;
      button.textContent = 'Resend code';
      return;
    }
    button.textContent = `Resend in ${remaining}s`;
  }, 1000);
}
