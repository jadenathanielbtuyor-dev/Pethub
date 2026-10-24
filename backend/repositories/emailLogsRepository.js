const supabase = require('../config/supabase');

// One row per appointment or reply email: Pending while it is being sent, then Sent or Failed. The database allows
// one row per (appointment, email type) and per (contact message, email type), so the same email is never logged twice.
const EMAIL_LOG_SELECT = 'id, user_id, email_type, recipient_email, subject, status, error_message, sent_at, created_at, appointment_id, contact_message_id';

function createPending(entry) {
  return supabase
    .from('email_logs')
    .insert([{ ...entry, status: 'Pending' }])
    .select(EMAIL_LOG_SELECT)
    .maybeSingle();
}

function markSent(id) {
  return supabase
    .from('email_logs')
    .update({ status: 'Sent', sent_at: new Date().toISOString(), error_message: null })
    .eq('id', id);
}

function markFailed(id, errorMessage) {
  return supabase
    .from('email_logs')
    .update({ status: 'Failed', error_message: String(errorMessage || 'Email delivery failed').slice(0, 300) })
    .eq('id', id);
}

function findById(id) {
  return supabase
    .from('email_logs')
    .select(EMAIL_LOG_SELECT)
    .eq('id', id)
    .maybeSingle();
}

// A retry takes the row back to Pending only if it is still Failed, so two admins retrying at once send it once
function claimFailedForRetry(id) {
  return supabase
    .from('email_logs')
    .update({ status: 'Pending', error_message: null })
    .eq('id', id)
    .eq('status', 'Failed')
    .select(EMAIL_LOG_SELECT);
}

function listByAppointmentIds(appointmentIds) {
  return supabase
    .from('email_logs')
    .select(EMAIL_LOG_SELECT)
    .in('appointment_id', appointmentIds);
}

function listByContactMessageIds(messageIds) {
  return supabase
    .from('email_logs')
    .select(EMAIL_LOG_SELECT)
    .in('contact_message_id', messageIds);
}

module.exports = {
  createPending,
  markSent,
  markFailed,
  findById,
  claimFailedForRetry,
  listByAppointmentIds,
  listByContactMessageIds
};
