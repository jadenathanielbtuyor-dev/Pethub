const env = require('../config/env');
const logger = require('./logger');

const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_REQUEST_TIMEOUT_MS = 15000;

const { apiKey, fromEmail, fromName } = env.brevo;

if (!apiKey) {
  logger.warn('email.brevo_api_key_missing');
}

if (!fromEmail) {
  logger.warn('email.from_email_missing');
}

async function sendEmail({ to, subject, text, html }) {
  if (!apiKey) {
    throw new Error('Brevo API key is not configured');
  }
  if (!fromEmail) {
    throw new Error('Email sender address is not configured');
  }
  if (!to || !subject || (!text && !html)) {
    throw new Error('Missing email parameters');
  }

  const payload = {
    sender: {
      email: fromEmail,
      name: fromName
    },
    to: (Array.isArray(to) ? to : [to]).map(recipient => (typeof recipient === 'string' ? { email: recipient } : recipient)),
    subject
  };
  if (text) payload.textContent = text;
  if (html) payload.htmlContent = html;

  let response;
  try {
    response = await fetch(BREVO_SEND_EMAIL_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BREVO_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
    logger.error('email.brevo_request_failed', { reason, error: error && error.message });
    throw new Error(`Brevo request failed: ${reason}`);
  }

  if (!response.ok) {
    // Brevo error bodies are { code, message }; request headers and email content are never logged
    const details = await response.json().catch(() => ({}));
    const isRateLimited = response.status === 429;
    logger.error('email.brevo_non_success_status', {
      statusCode: response.status,
      code: details.code,
      message: typeof details.message === 'string' ? details.message.slice(0, 200) : undefined
    });
    // "rate limited" keeps authService's existing delayed-delivery message for throttled sends
    throw new Error(`Brevo error: ${response.status} (${isRateLimited ? 'rate limited' : details.code || 'request rejected'})`);
  }
}

module.exports = {
  sendEmail
};
