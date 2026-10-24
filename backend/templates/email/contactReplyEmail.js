const { CONTACT_REPLY_EMAIL_SUBJECT } = require('../../constants/email');
const { escapeHtml, formatClinicTimestamp, getClinicHelp, helpText, helpHtml } = require('./appointmentEmailParts');

function paragraphsHtml(text) {
  return String(text || '').split(/\n{2,}/).map(block => `<p style="margin: 0 0 10px;">${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`).join('');
}

// The clinic's reply to a contact message, sent to the address of the account that wrote it. The customer also sees the
// reply on the Contact page (contactPageUrl) while signed in. Answers go through a new message, never by replying to
// this email (it comes from the PetHub sender address).
function buildContactReplyEmail({ name, message, clinic = {}, contactPageUrl = '' }) {
  const displayName = String(name || 'PetHub user').trim() || 'PetHub user';
  const subjectLine = String(message?.subject || '').trim() || 'Your message';
  const sentOn = formatClinicTimestamp(message?.created_at);
  const help = getClinicHelp(clinic, contactPageUrl);
  const followUp = contactPageUrl
    ? `To answer, sign in to PetHub and send a new message from the Contact page: ${contactPageUrl}`
    : 'To answer, sign in to PetHub and send a new message from the Contact page.';

  return {
    subject: CONTACT_REPLY_EMAIL_SUBJECT,
    text: [
      `Hello ${displayName},`,
      '',
      `The clinic replied to your message "${subjectLine}" (sent ${sentOn}).`,
      '',
      'Reply from the clinic:',
      String(message?.reply_message || ''),
      '',
      'Your message:',
      String(message?.message || ''),
      '',
      followUp,
      '',
      ...(help.lines.length ? helpText(help) : []),
      'Thank you,',
      'The PetHub Team'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #f97316;">The clinic replied to your message</h2>
        <p>Hello ${escapeHtml(displayName)},</p>
        <p>The clinic replied to your message <strong>${escapeHtml(subjectLine)}</strong> (sent ${escapeHtml(sentOn)}).</p>
        <div style="border-left: 4px solid #f97316; padding: 8px 12px; margin: 16px 0; background: #fff7ed;">
          <p style="margin: 0 0 6px; font-weight: 600;">Reply from the clinic</p>
          ${paragraphsHtml(message?.reply_message)}
        </div>
        <div style="border-left: 4px solid #d1d5db; padding: 8px 12px; margin: 16px 0; color: #4b5563;">
          <p style="margin: 0 0 6px; font-weight: 600;">Your message</p>
          ${paragraphsHtml(message?.message)}
        </div>
        <p>${contactPageUrl
          ? `To answer, sign in to PetHub and send a new message from the <a href="${escapeHtml(contactPageUrl)}" style="color: #f97316;">Contact page</a>.`
          : 'To answer, sign in to PetHub and send a new message from the Contact page.'}</p>
        ${help.lines.length ? helpHtml(help) : ''}
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `
  };
}

module.exports = {
  buildContactReplyEmail
};
