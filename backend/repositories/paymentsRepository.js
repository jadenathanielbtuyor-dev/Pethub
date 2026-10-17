const { getSupabaseAdmin, isSupabaseAdminConfigured } = require('../config/supabaseAdmin');
const { PAYMENT_STATUSES } = require('../constants/payments');

// Payment rows are read and written only with the server-side service-role client (config/supabaseAdmin.js).
// provider_checkout_session_id, provider_payment_id and expires_at come from
// database/migrations/2026-10-17_paymongo_deposits.sql.
const PAYMENT_SELECT = 'id, appointment_id, user_id, amount, payment_method, payment_status, paid_at, created_at, provider_checkout_session_id, provider_payment_id, expires_at';

function isConfigured() {
  return isSupabaseAdminConfigured();
}

function insertPayment(payment) {
  return getSupabaseAdmin()
    .from('payments')
    .insert([payment])
    .select(PAYMENT_SELECT);
}

function findById(paymentId) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('id', paymentId)
    .maybeSingle();
}

function findByCheckoutSessionId(sessionId) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('provider_checkout_session_id', sessionId)
    .maybeSingle();
}

function findByProviderPaymentId(providerPaymentId) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('provider_payment_id', providerPaymentId)
    .maybeSingle();
}

function listByAppointmentIds(appointmentIds) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .in('appointment_id', appointmentIds)
    .order('created_at', { ascending: false });
}

function listAll() {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .order('created_at', { ascending: false });
}

function listOverduePending(nowIso, limit) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('payment_status', PAYMENT_STATUSES.PENDING)
    .lt('expires_at', nowIso)
    .order('expires_at', { ascending: true })
    .limit(limit);
}

// Saves the PayMongo session id only on the Pending row that does not have one yet
function attachCheckoutSession(paymentId, sessionId) {
  return getSupabaseAdmin()
    .from('payments')
    .update({ provider_checkout_session_id: sessionId })
    .eq('id', paymentId)
    .eq('payment_status', PAYMENT_STATUSES.PENDING)
    .is('provider_checkout_session_id', null)
    .select('id');
}

// Conditional status change: only rows still in one of fromStatuses are updated, so retries,
// duplicate webhooks and late responses can never move a payment backwards.
function updateStatusFrom(paymentId, fromStatuses, values) {
  return getSupabaseAdmin()
    .from('payments')
    .update(values)
    .eq('id', paymentId)
    .in('payment_status', fromStatuses)
    .select(PAYMENT_SELECT);
}

// receipt_email_sent_at (same migration) records that the deposit confirmation email was handed to Brevo.
// It is claimed before sending, so only one request, webhook delivery or sweep sends the email for a payment;
// a send that fails releases the claim again (only while it still holds the same timestamp) so it can be retried.
function claimReceiptEmail(paymentId, claimedAt) {
  return getSupabaseAdmin()
    .from('payments')
    .update({ receipt_email_sent_at: claimedAt })
    .eq('id', paymentId)
    .eq('payment_status', PAYMENT_STATUSES.PAID)
    .is('receipt_email_sent_at', null)
    .select('id');
}

function releaseReceiptEmail(paymentId, claimedAt) {
  return getSupabaseAdmin()
    .from('payments')
    .update({ receipt_email_sent_at: null })
    .eq('id', paymentId)
    .eq('receipt_email_sent_at', claimedAt)
    .select('id');
}

function listPaidWithoutReceipt(paidSinceIso, limit) {
  return getSupabaseAdmin()
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('payment_status', PAYMENT_STATUSES.PAID)
    .is('receipt_email_sent_at', null)
    .gte('paid_at', paidSinceIso)
    .order('paid_at', { ascending: true })
    .limit(limit);
}

// Closes a Pending row whose checkout session was never saved (its URL never reached the customer)
function markUnlinkedFailed(paymentId) {
  return getSupabaseAdmin()
    .from('payments')
    .update({ payment_status: PAYMENT_STATUSES.FAILED })
    .eq('id', paymentId)
    .eq('payment_status', PAYMENT_STATUSES.PENDING)
    .is('provider_checkout_session_id', null)
    .select(PAYMENT_SELECT);
}

module.exports = {
  PAYMENT_SELECT,
  isConfigured,
  insertPayment,
  findById,
  findByCheckoutSessionId,
  findByProviderPaymentId,
  listByAppointmentIds,
  listAll,
  listOverduePending,
  attachCheckoutSession,
  updateStatusFrom,
  claimReceiptEmail,
  releaseReceiptEmail,
  listPaidWithoutReceipt,
  markUnlinkedFailed
};
