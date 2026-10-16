const {
  VERIFICATION_CODE_TTL_MINUTES,
  VERIFICATION_EMAIL_SUBJECT
} = require('../../constants/email');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildVerificationEmail({ name, code, purpose = 'registration' }) {
  const displayName = String(name || 'PetHub user').trim();
  const escapedName = escapeHtml(displayName);
  const safeCode = escapeHtml(code);
  const fallbackText = purpose === 'resend'
    ? 'If you did not request this code, please ignore this message.'
    : 'If you did not register for PetHub, please ignore this message.';

  return {
    subject: VERIFICATION_EMAIL_SUBJECT,
    text: [
      `Hello ${displayName},`,
      '',
      `Your PetHub verification code is: ${code}`,
      `It expires in ${VERIFICATION_CODE_TTL_MINUTES} minutes.`,
      '',
      fallbackText
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #f97316;">PetHub Verification Code</h2>
        <p>Hello ${escapedName},</p>
        <p>Your PetHub verification code is:</p>
        <p style="font-size: 24px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${safeCode}</p>
        <p>This code expires in ${VERIFICATION_CODE_TTL_MINUTES} minutes.</p>
        <p>${escapeHtml(fallbackText)}</p>
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `
  };
}

module.exports = {
  buildVerificationEmail
};
