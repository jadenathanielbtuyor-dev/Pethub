const sgMail = require('@sendgrid/mail');
const env = require('../config/env');
const logger = require('./logger');

const { apiKey, fromEmail, fromName } = env.sendgrid;

if (!apiKey) {
  logger.warn('email.sendgrid_api_key_missing');
}

if (apiKey) {
  sgMail.setApiKey(apiKey);
}

async function sendEmail({ to, subject, text, html }) {
  if (!apiKey) {
    throw new Error('SendGrid API key is not configured');
  }
  if (!fromEmail) {
    throw new Error('SendGrid sender email is not configured');
  }
  if (!to || !subject || (!text && !html)) {
    throw new Error('Missing email parameters');
  }

  const msg = {
    to,
    from: {
      email: fromEmail,
      name: fromName
    },
    subject,
    text,
    html
  };

  try {
    const [response] = await sgMail.send(msg);
    const statusCode = response && response.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      logger.error('email.sendgrid_non_success_status', { statusCode, response });
      throw new Error(`SendGrid error: ${statusCode}`);
    }

  } catch (error) {
    logger.error('email.sendgrid_send_error', {
      error: error.response ? error.response.body || error.response : error.message || error
    });
    throw error;
  }
}

module.exports = {
  sendEmail
};
