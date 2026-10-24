// POST /admin/email-logs/:id/retry: sends a Failed appointment or reply email again, rebuilt from the current record.
// Only a Failed row can be retried, and only once at a time (emailDeliveryService.retryLoggedEmail).
const emailLogsRepository = require('../repositories/emailLogsRepository');
const { isUuid, trimValue } = require('../validators/commonValidator');
const { logAdminActivity } = require('../utils/activityLogger');
const { EMAIL_TYPES, retryLoggedEmail } = require('./emailDeliveryService');
const { buildAppointmentEmailForRetry } = require('./appointmentNotificationsService');
const { buildReplyEmailForRetry } = require('./contactService');

const APPOINTMENT_EMAIL_TYPES = new Set([
  EMAIL_TYPES.appointmentApproved,
  EMAIL_TYPES.appointmentCancelledByClinic,
  EMAIL_TYPES.appointmentCancelledByOwner
]);

function buildForRetry(log) {
  if (APPOINTMENT_EMAIL_TYPES.has(log.email_type) || String(log.email_type).startsWith(`${EMAIL_TYPES.appointmentRescheduled}:`)) {
    return buildAppointmentEmailForRetry(log);
  }
  if (log.email_type === EMAIL_TYPES.contactReply) return buildReplyEmailForRetry(log);
  return null;
}

const retryEmail = async (req) => {
  const logId = trimValue(req.params?.id);
  if (!isUuid(logId)) return { statusCode: 404, body: { success: false, error: 'Email record not found.' } };

  try {
    const { data: existing, error } = await emailLogsRepository.findById(logId);
    if (error) throw error;
    if (!existing) return { statusCode: 404, body: { success: false, error: 'Email record not found.' } };
    if (existing.status !== 'Failed') {
      return { statusCode: 409, body: { success: false, error: existing.status === 'Sent'
        ? 'This email was already sent (the email service accepted it).'
        : 'This email is being sent right now. Refresh in a moment.' } };
    }

    const result = await retryLoggedEmail(logId, buildForRetry);
    if (result.status === 'not_retryable') {
      return { statusCode: 409, body: { success: false, error: 'This email was retried in another session. Refresh to see its status.' } };
    }
    if (result.status === 'not_applicable') {
      return { statusCode: 409, body: { success: false, error: 'This email no longer matches the record (for example, the appointment changed since), so it was not sent.' } };
    }

    const targetTable = existing.appointment_id ? 'appointments' : 'contact_messages';
    const targetId = existing.appointment_id || existing.contact_message_id;
    if (targetId) await logAdminActivity(req.authUserId, targetTable, targetId, `Resent the ${existing.email_type.split(':')[0].replace(/_/g, ' ')} email`);

    return result.status === 'sent'
      ? { statusCode: 200, body: { success: true, email_status: 'sent', message: 'Email sent.' } }
      : { statusCode: 502, body: { success: false, email_status: 'failed', error: 'The email service did not accept the email again. Check the email service, then try later.' } };
  } catch (error) {
    console.error('Email retry error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not retry this email.' } };
  }
};

module.exports = {
  retryEmail
};
