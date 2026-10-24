// ==================== CONTACT MESSAGES ====================
// Customers write to the clinic from the Contact page while signed in; the clinic reads and answers in System
// Management > Contact messages.
// - POST /contact (requireAuth): the sender is the token's account. Its name and email are copied from the account
//   record, so a request cannot send a message as someone else. A repeat of the same subject and text within
//   DUPLICATE_WINDOW_MINUTES returns the first message instead of storing a second one.
// - GET /contact/mine: the signed-in customer's own messages and the clinic's replies.
// - Admin: list, mark read (Unread -> Read), and one reply per message. A reply is stored first (the customer sees it on
//   the Contact page) and then emailed to the sender's address; a failed email never removes the reply.

const contactRepository = require('../repositories/contactRepository');
const usersRepository = require('../repositories/usersRepository');
const emailLogsRepository = require('../repositories/emailLogsRepository');
const { isUserVerified } = require('../utils/accountVerification');
const { logUserActivity, logAdminActivity } = require('../utils/activityLogger');
const { validateContactRequest, validateContactReply } = require('../validators/contactValidator');
const { isUuid, trimValue } = require('../validators/commonValidator');
const { buildContactReplyEmail } = require('../templates/email/contactReplyEmail');
const { CONTACT_PAGE_PATH } = require('../constants/email');
const { EMAIL_TYPES, sendLoggedEmail } = require('./emailDeliveryService');
const { getClinicContactDetails } = require('./clinicSettingsService');
const { getFrontendPageUrl } = require('./appointmentNotificationsService');

const DUPLICATE_WINDOW_MINUTES = 10;
const OWNER_MESSAGE_LIMIT = 20;
// What the sender sees for each status
const OWNER_STATUS_LABELS = Object.freeze({ Unread: 'Sent', Read: 'Seen by the clinic', Replied: 'Answered' });

function mapMessageForOwner(message) {
  return {
    id: message.id,
    subject: message.subject || '',
    message: message.message,
    status: message.status,
    status_label: OWNER_STATUS_LABELS[message.status] || 'Sent',
    created_at: message.created_at,
    reply_message: message.reply_message || null,
    replied_at: message.replied_at || null
  };
}

async function loadAccount(userId) {
  const { data, error } = await usersRepository.findStatusById(userId);
  if (error) throw error;
  const user = Array.isArray(data) ? data[0] : data;
  return user || null;
}

const submitContactRequest = async (req) => {
  const validation = validateContactRequest(req.body);
  if (validation.error) return validation.error;
  const { cleanSubject, cleanMessage } = validation;
  const userId = trimValue(req.authUserId);

  try {
    const account = await loadAccount(userId);
    if (!account || !account.email) {
      return { statusCode: 403, body: { success: false, error: 'Your account could not be found. Please log in again.' } };
    }
    if (!(await isUserVerified(userId))) {
      return { statusCode: 403, body: { success: false, error: 'Please verify your email before sending the clinic a message.' } };
    }

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000).toISOString();
    const duplicate = await contactRepository.findRecentDuplicate(userId, cleanSubject, cleanMessage, since);
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) {
      return { statusCode: 200, body: {
        success: true,
        duplicate: true,
        message: 'This message was already sent to the clinic.',
        contact_message: mapMessageForOwner(duplicate.data)
      } };
    }

    const { data: stored, error } = await contactRepository.createContactMessage({
      user_id: userId,
      fullname: String(account.fullname || '').trim() || account.email,
      email: account.email,
      subject: cleanSubject,
      message: cleanMessage,
      status: 'Unread'
    });
    if (error || !stored) {
      console.error('Failed to store contact message:', { code: error?.code || 'no_row' });
      return { statusCode: 500, body: { success: false, error: 'Your message could not be sent. Please try again.' } };
    }

    // The activity log records that a message arrived, not its content or the sender's details
    await logUserActivity(userId, 'contact_message', 'Sent a message to the clinic');

    return { statusCode: 201, body: {
      success: true,
      message: 'Message sent to the clinic.',
      contact_message: mapMessageForOwner(stored)
    } };
  } catch (error) {
    console.error('Contact request error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Your message could not be sent. Please try again.' } };
  }
};

const listMyMessages = async (req) => {
  try {
    const { data, error } = await contactRepository.listByUserId(trimValue(req.authUserId), OWNER_MESSAGE_LIMIT);
    if (error) throw error;
    return { statusCode: 200, body: { success: true, messages: (data || []).map(mapMessageForOwner) } };
  } catch (error) {
    console.error('List own contact messages error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not load your messages.' } };
  }
};

// ---------- Admin ----------

function latestByKey(rows, key) {
  return (rows || []).reduce((map, row) => {
    const id = row && row[key] ? String(row[key]) : '';
    if (id && (!map[id] || String(row.created_at) > String(map[id].created_at))) map[id] = row;
    return map;
  }, {});
}

function emailDeliveryFor(log) {
  return log ? { log_id: log.id, status: log.status, sent_at: log.sent_at || null, error: log.status === 'Failed' ? log.error_message || null : null } : null;
}

const getContactMessages = async () => {
  try {
    const { data: messages, error } = await contactRepository.listMessages();
    if (error) throw error;
    const list = messages || [];

    const handlerIds = [...new Set(list.map(message => message.handled_by).filter(Boolean).map(String))];
    const messageIds = list.map(message => String(message.id));
    const [handlers, logs] = await Promise.all([
      handlerIds.length ? usersRepository.listNamesByIds(handlerIds) : Promise.resolve({ data: [] }),
      messageIds.length ? emailLogsRepository.listByContactMessageIds(messageIds) : Promise.resolve({ data: [] })
    ]);
    const handlerNames = Object.fromEntries((handlers.data || []).map(user => [String(user.id), user.fullname || null]));
    const replyLogs = latestByKey(logs.error ? [] : logs.data, 'contact_message_id');

    return { statusCode: 200, body: {
      success: true,
      messages: list.map(message => ({
        ...message,
        has_account: Boolean(message.user_id),
        handled_by_name: message.handled_by ? handlerNames[String(message.handled_by)] || null : null,
        reply_email: emailDeliveryFor(replyLogs[String(message.id)])
      }))
    } };
  } catch (error) {
    console.error('Error fetching contact messages:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Failed to fetch contact messages' } };
  }
};

// PUT /admin/dashboard/contact-message-status { id, status: 'Read' }: Unread -> Read; read or answered messages keep their status
const updateContactMessageStatus = async (req) => {
  const { id, status } = req.body || {};
  const messageId = trimValue(id);
  const newStatus = trimValue(status);
  if (!messageId || !newStatus) return { statusCode: 400, body: { success: false, error: 'id and status are required' } };
  if (newStatus !== 'Read') return { statusCode: 400, body: { success: false, error: 'Contact messages can only be marked as Read.' } };
  if (!isUuid(messageId)) return { statusCode: 404, body: { success: false, error: 'Contact message not found' } };

  try {
    const { data: updated, error } = await contactRepository.markRead(messageId, trimValue(req.authUserId));
    if (error) throw error;
    if (updated) {
      await logAdminActivity(req.authUserId, 'contact_messages', messageId, 'Marked a contact message as read');
      return { statusCode: 200, body: { success: true, message: updated } };
    }
    const { data: existing, error: findError } = await contactRepository.findById(messageId);
    if (findError) throw findError;
    if (!existing) return { statusCode: 404, body: { success: false, error: 'Contact message not found' } };
    return { statusCode: 200, body: { success: true, message: existing, unchanged: true } };
  } catch (error) {
    console.error('Update contact message status error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Failed to update contact message status' } };
  }
};

async function buildReplyEmail(message) {
  const recipient = String(message?.email || '').trim();
  if (!recipient || !message?.reply_message) return null;
  return {
    to: recipient,
    email: buildContactReplyEmail({
      name: message.fullname,
      message,
      clinic: await getClinicContactDetails(),
      contactPageUrl: getFrontendPageUrl(CONTACT_PAGE_PATH)
    })
  };
}

// POST /admin/dashboard/contact-messages/:id/reply { reply }
const replyToContactMessage = async (req) => {
  const validation = validateContactReply(req.params, req.body);
  if (validation.error) return validation.error;
  const { messageId, reply } = validation;
  const adminId = trimValue(req.authUserId);

  try {
    const { data: saved, error } = await contactRepository.saveReply(messageId, reply, adminId);
    if (error) throw error;
    if (!saved) {
      const { data: existing, error: findError } = await contactRepository.findById(messageId);
      if (findError) throw findError;
      if (!existing) return { statusCode: 404, body: { success: false, error: 'Contact message not found.' } };
      return { statusCode: 409, body: { success: false, error: 'This message has already been answered. Refresh the list to see the reply.' } };
    }

    await logAdminActivity(adminId, 'contact_messages', messageId, 'Replied to a contact message');

    const built = await buildReplyEmail(saved);
    const email = built
      ? await sendLoggedEmail({ type: EMAIL_TYPES.contactReply, to: built.to, email: built.email, userId: saved.user_id || null, contactMessageId: saved.id })
      : { status: 'skipped' };

    return { statusCode: 200, body: { success: true, message: saved, email_status: email.status } };
  } catch (error) {
    console.error('Contact reply error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'The reply could not be saved. Please try again.' } };
  }
};

// For an admin retry of a Failed reply email (services/emailRetryService.js)
async function buildReplyEmailForRetry(log) {
  if (!log?.contact_message_id) return null;
  const { data: message, error } = await contactRepository.findById(log.contact_message_id);
  if (error) throw error;
  if (!message || message.status !== 'Replied') return null;
  return buildReplyEmail(message);
}

module.exports = {
  DUPLICATE_WINDOW_MINUTES,
  submitContactRequest,
  listMyMessages,
  getContactMessages,
  updateContactMessageStatus,
  replyToContactMessage,
  buildReplyEmailForRetry
};
