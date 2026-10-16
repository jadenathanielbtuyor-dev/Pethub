const {
  PASSWORD_RESET_CODE_TTL_MINUTES,
  PASSWORD_RESET_EMAIL_SUBJECT
} = require('../../constants/email');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPasswordResetEmail({ name, code }) {
  const displayName = String(name || 'PetHub user').trim();
  const escapedName = escapeHtml(displayName);
  const safeCode = escapeHtml(code);
  const ignoreText = 'If you did not ask to reset your password, you can ignore this message. Your password will not change.';

  return {
    subject: PASSWORD_RESET_EMAIL_SUBJECT,
    text: [
      `Hello ${displayName},`,
      '',
      `Your PetHub password reset code is: ${code}`,
      `It expires in ${PASSWORD_RESET_CODE_TTL_MINUTES} minutes.`,
      '',
      ignoreText
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #f97316;">PetHub Password Reset Code</h2>
        <p>Hello ${escapedName},</p>
        <p>Your PetHub password reset code is:</p>
        <p style="font-size: 24px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${safeCode}</p>
        <p>This code expires in ${PASSWORD_RESET_CODE_TTL_MINUTES} minutes.</p>
        <p>${escapeHtml(ignoreText)}</p>
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `
  };
}

module.exports = {
  buildPasswordResetEmail
};
