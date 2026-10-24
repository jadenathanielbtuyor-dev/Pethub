const { hasValue, trimValue, isUuid } = require('./commonValidator');

// Same limits as the Contact form's maxlength (pages/public/contact.html) and the database checks
// (contact_messages_subject_length, contact_messages_message_length, contact_messages_reply_length)
const CONTACT_LIMITS = Object.freeze({ subject: 120, message: 2000, reply: 2000 });
// Characters that cannot be shown in a message (tabs and new lines are allowed in the message text)
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function contactError(message, field) {
  return { error: { statusCode: 400, body: { success: false, error: message, ...(field ? { field } : {}) } } };
}

function readText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

// POST /contact { subject, message }. The sender is the signed-in account (routes/contact.js runs requireAuth), so any
// name, email or user id in the body is ignored: the service takes them from the account record.
function validateContactRequest(body = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const cleanSubject = readText(input.subject).replace(/\s+/g, ' ');
  const cleanMessage = readText(input.message);

  if (!cleanSubject) return contactError('Enter a subject for your message.', 'subject');
  if (cleanSubject.length > CONTACT_LIMITS.subject) {
    return contactError(`Subject must be ${CONTACT_LIMITS.subject} characters or fewer.`, 'subject');
  }
  if (!cleanMessage) return contactError('Enter your message.', 'message');
  if (cleanMessage.length > CONTACT_LIMITS.message) {
    return contactError(`Message must be ${CONTACT_LIMITS.message.toLocaleString('en-US')} characters or fewer.`, 'message');
  }
  if (CONTROL_CHARACTERS.test(cleanSubject) || CONTROL_CHARACTERS.test(cleanMessage)) {
    return contactError('Your message contains characters that cannot be shown. Remove them and try again.', 'message');
  }

  return { cleanSubject, cleanMessage };
}

// POST /admin/dashboard/contact-messages/:id/reply { reply }
function validateContactReply(params = {}, body = {}) {
  const messageId = trimValue(params.id);
  if (!isUuid(messageId)) return { error: { statusCode: 404, body: { success: false, error: 'Contact message not found.' } } };
  const reply = readText(body && typeof body === 'object' ? body.reply : '');
  if (!reply) return contactError('Write a reply before sending it.', 'reply');
  if (reply.length > CONTACT_LIMITS.reply) {
    return contactError(`Reply must be ${CONTACT_LIMITS.reply.toLocaleString('en-US')} characters or fewer.`, 'reply');
  }
  if (CONTROL_CHARACTERS.test(reply)) return contactError('The reply contains characters that cannot be shown.', 'reply');
  return { messageId, reply };
}

module.exports = {
  CONTACT_LIMITS,
  hasValue,
  validateContactRequest,
  validateContactReply
};
