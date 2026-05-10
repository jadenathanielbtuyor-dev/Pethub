document.addEventListener('DOMContentLoaded', () => {
  setupVerifyForm();
  setupResendButton();
  populateEmailField();
});

let verifyRequestInProgress = false;
let resendRequestInProgress = false;
let resendCooldownActive = false;

function getPendingVerificationEmail() {
  return sessionStorage.getItem('pendingVerificationEmail') || '';
}

function getPendingVerificationCode() {
  return sessionStorage.getItem('pendingVerificationCode') || '';
}

function clearPendingVerificationEmail() {
  sessionStorage.removeItem('pendingVerificationEmail');
}

function clearPendingVerificationCode() {
  sessionStorage.removeItem('pendingVerificationCode');
}

function populateEmailField() {
  const emailInput = document.getElementById('email');
  const codeInput = document.getElementById('verificationCode');
  if (!emailInput) return;

  const pendingEmail = getPendingVerificationEmail();
  if (pendingEmail) {
    emailInput.value = pendingEmail;
  }

  const pendingCode = getPendingVerificationCode();
  if (pendingCode && codeInput) {
    codeInput.value = pendingCode;
    clearPendingVerificationCode();
    const messageContainer = document.getElementById('formMessageContainer');
    if (messageContainer) {
      displayMessage(messageContainer, `Demo code available: ${pendingCode}`, 'success');
    }
  }
}

function setupVerifyForm() {
  const verifyForm = document.getElementById('verifyForm');
  if (!verifyForm) return;

  verifyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (verifyRequestInProgress) {
      return;
    }
    verifyRequestInProgress = true;

    const email = document.getElementById('email').value.trim();
    const code = document.getElementById('verificationCode').value.trim();
    const messageContainer = document.getElementById('formMessageContainer');
    if (!email || !code) {
      displayMessage(messageContainer, 'Enter both email and verification code.', 'error');
      verifyRequestInProgress = false;
      return;
    }

    if (!isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address.', 'error');
      verifyRequestInProgress = false;
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      displayMessage(messageContainer, 'Enter the 6-digit code sent to your email.', 'error');
      verifyRequestInProgress = false;
      return;
    }

    setFormSubmitting(verifyForm, true, 'Verifying...', 'Verify');

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });

      const data = await getJsonFromResponse(response);
      if (!response.ok) {
        throw new Error(data.error || `Verification failed (${response.status})`);
      }

      clearPendingVerificationEmail();
      displayMessage(messageContainer, 'Email verified successfully. Redirecting to login...', 'success');
      setTimeout(() => {
        window.location.replace(PATHS.login);
      }, 1200);
    } catch (error) {
      console.error('Verification failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to verify. Please try again.', 'error');
    } finally {
      verifyRequestInProgress = false;
      setFormSubmitting(verifyForm, false, 'Verifying...', 'Verify');
    }
  });
}

function setupResendButton() {
  const resendButton = document.getElementById('resendCodeButton');
  const messageContainer = document.getElementById('formMessageContainer');
  if (!resendButton) return;

  resendButton.addEventListener('click', async (event) => {
    event.preventDefault();
    if (resendRequestInProgress || resendCooldownActive) {
      return;
    }
    resendRequestInProgress = true;

    const email = document.getElementById('email').value.trim();
    if (!email) {
      displayMessage(messageContainer, 'Enter your email before resending.', 'error');
      resendRequestInProgress = false;
      return;
    }
    if (!isValidEmail(email)) {
      displayMessage(messageContainer, 'Enter a valid email address.', 'error');
      resendRequestInProgress = false;
      return;
    }

    updateButtonState(resendButton, true, 'Sending...', 'Resend Code');

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/resend-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await getJsonFromResponse(response);
      if (!response.ok) {
        throw new Error(data.error || `Resend failed (${response.status})`);
      }

      if (data.devCode) {
        const codeInput = document.getElementById('verificationCode');
        if (codeInput) {
          codeInput.value = data.devCode;
        }
        displayMessage(messageContainer, `Demo code: ${data.devCode}`, 'success');
      } else {
        displayMessage(messageContainer, data.message || 'Verification code resent. Check your inbox.', 'success');
      }
      startResendCooldown(resendButton);
    } catch (error) {
      console.error('Resend code failed:', error);
      displayMessage(messageContainer, error.message || 'Unable to resend. Please try again.', 'error');
      resendRequestInProgress = false;
      updateButtonState(resendButton, false, 'Sending...', 'Resend Code');
    }
  });
}

function startResendCooldown(button) {
  if (!button) return;
  updateButtonState(button, false, 'Sending...', 'Resend Code');
  resendCooldownActive = true;
  resendRequestInProgress = false;
  const cooldown = 60;
  let remaining = cooldown;
  button.disabled = true;
  button.setAttribute('aria-busy', 'false');
  button.textContent = `Resend in ${remaining}s`;

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      resendCooldownActive = false;
      button.disabled = false;
      button.textContent = 'Resend Code';
      return;
    }
    button.textContent = `Resend in ${remaining}s`;
  }, 1000);
}
