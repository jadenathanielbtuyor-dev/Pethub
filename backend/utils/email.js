const sgMail = require('@sendgrid/mail');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || 'PetHub';

if (!SENDGRID_API_KEY) {
  console.error('SendGrid API key is not configured');
}

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

async function sendEmail({ to, subject, text, html }) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid API key is not configured');
  }
  if (!SENDGRID_FROM_EMAIL) {
    throw new Error('SendGrid sender email is not configured');
  }
  if (!to || !subject || (!text && !html)) {
    throw new Error('Missing email parameters');
  }

  const msg = {
    to,
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: SENDGRID_FROM_NAME
    },
    subject,
    text,
    html
  };

  try {
    const [response] = await sgMail.send(msg);
    const statusCode = response && response.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      console.error('SendGrid returned non-success status:', statusCode, response);
      throw new Error(`SendGrid error: ${statusCode}`);
    }

  } catch (error) {
    console.error('SendGrid send error:', error.response ? error.response.body || error.response : error.message || error);
    throw error;
  }
}

module.exports = {
  sendEmail
};
