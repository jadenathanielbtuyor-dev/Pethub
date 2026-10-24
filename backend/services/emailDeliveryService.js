// ==================== LOGGED EMAIL DELIVERY ====================
// Sends one appointment or contact-reply email through Brevo and records it in email_logs: a Pending row before the
// request, then Sent (Brevo accepted it for delivery; its message id is in the server log, so Brevo's own logs can
// show whether it was delivered) or Failed. The database allows one row per (appointment, email type) and per
// (contact message, email type), so a repeated request is refused at the insert and the email is not sent twice.
// Logging problems never stop an email, and a failed email never undoes the change that caused it. Nothing here throws.

const logger = require('../utils/logger');
const { sendEmail } = require('../utils/email');
const emailLogsRepository = require('../repositories/emailLogsRepository');

const EMAIL_TYPES = Object.freeze({
  appointmentApproved: 'appointment_approved',
  appointmentCancelledByClinic: 'appointment_cancelled_by_clinic',
  appointmentCancelledByOwner: 'appointment_cancelled_by_owner',
  contactReply: 'contact_reply'
});

// Brevo errors from utils/email.js name the status and Brevo's code only; request headers and content are never included
function describeSendError(error) {
  return String(error?.message || 'Email delivery failed').slice(0, 300);
}

// Supabase queries are thenables without .catch, so log updates are awaited inside try
async function updateLog(update, context) {
  try {
    const { error } = await update();
    if (error) logger.warn('email.log_update_failed', { ...context, code: error.code || 'unknown' });
  } catch (error) {
    logger.warn('email.log_update_failed', { ...context, code: error?.code || 'unknown' });
  }
}

async function deliver(logId, { to, email, context }) {
  let accepted;
  try {
    accepted = await sendEmail({ to, ...email });
  } catch (error) {
    logger.error('email.delivery_failed', { ...context, error: describeSendError(error) });
    if (logId) await updateLog(() => emailLogsRepository.markFailed(logId, describeSendError(error)), context);
    return { status: 'failed', logId };
  }

  if (logId) await updateLog(() => emailLogsRepository.markSent(logId), context);
  logger.info('email.accepted', { ...context, brevo_message_id: accepted?.messageId || undefined });
  return { status: 'sent', logId };
}

/**
 * Sends `email` ({ subject, text, html }) to `to` and logs it. Returns { status: 'sent' | 'failed' | 'duplicate', logId }.
 */
async function sendLoggedEmail({ type, to, email, userId = null, appointmentId = null, contactMessageId = null }) {
  const context = { email_type: type, appointment_id: appointmentId || undefined, contact_message_id: contactMessageId || undefined };
  let logId = null;
  try {
    const { data, error } = await emailLogsRepository.createPending({
      email_type: type,
      recipient_email: to,
      subject: email.subject,
      user_id: userId,
      appointment_id: appointmentId,
      contact_message_id: contactMessageId
    });
    if (error && String(error.code) === '23505') {
      logger.warn('email.duplicate_refused', context);
      return { status: 'duplicate', logId: null };
    }
    if (error) logger.warn('email.log_unavailable', { ...context, code: error.code || 'unknown' });
    logId = data?.id || null;
  } catch (error) {
    logger.warn('email.log_unavailable', { ...context, code: error?.code || 'unknown' });
  }

  return deliver(logId, { to, email, context });
}

/**
 * Sends a Failed email again. The row is taken back to Pending only while it is still Failed, so a second retry at the
 * same time does nothing. buildEmail(log) returns { to, email } from the current records, or null when the email no
 * longer applies. Returns { status: 'sent' | 'failed' | 'not_retryable' | 'not_applicable', log }.
 */
async function retryLoggedEmail(logId, buildEmail) {
  const { data: claimed, error } = await emailLogsRepository.claimFailedForRetry(logId);
  if (error) throw error;
  const log = Array.isArray(claimed) ? claimed[0] : null;
  if (!log) return { status: 'not_retryable', log: null };

  const context = { email_type: log.email_type, appointment_id: log.appointment_id || undefined, contact_message_id: log.contact_message_id || undefined, retry: true };
  let built = null;
  try {
    built = await buildEmail(log);
  } catch (buildError) {
    logger.error('email.retry_build_failed', { ...context, code: buildError?.code || 'unknown' });
  }
  if (!built) {
    await updateLog(() => emailLogsRepository.markFailed(log.id, 'This email no longer applies to the current record.'), context);
    return { status: 'not_applicable', log };
  }

  const result = await deliver(log.id, { to: built.to, email: built.email, context });
  return { status: result.status, log };
}

module.exports = {
  EMAIL_TYPES,
  sendLoggedEmail,
  retryLoggedEmail
};
