// ==================== PAYMENTS SERVICE ====================
// Appointment deposits through PayMongo Checkout (test mode only).
// - The deposit amount is a server constant; the browser only names the appointment.
// - A payment is marked Paid only from a signature-verified webhook or a server-side PayMongo lookup,
//   never from the checkout redirect.
// - Payment state is derived from the payments table; appointments.payment_status only mirrors it (Paid / Refunded).
// - Paying never approves an appointment; an admin still approves it, and only admin approval reserves the slot.
// - Emails (deposit confirmation, admin decision) go out after the state change and never change payment or appointment state.

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const paymongo = require('../utils/paymongoClient');
const { sendEmail } = require('../utils/email');
const paymentsRepository = require('../repositories/paymentsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const usersRepository = require('../repositories/usersRepository');
const { buildDepositReceiptEmail } = require('../templates/email/depositReceiptEmail');
const { buildAppointmentDecisionEmail } = require('../templates/email/appointmentDecisionEmail');
const { isUserVerified } = require('../utils/accountVerification');
const { getAppointmentTimeRange } = require('../validators/appointmentsValidator');
const { validateCheckoutRequest, validatePaymentStatusRequest } = require('../validators/paymentsValidator');
const { OCCUPIED_APPOINTMENT_STATUSES } = require('../constants/appointments');
const {
  DEPOSIT_AMOUNT_PHP,
  DEPOSIT_AMOUNT_CENTAVOS,
  DEPOSIT_CURRENCY,
  CHECKOUT_WINDOW_MINUTES,
  PAYMENT_STATUSES,
  CHECKOUT_PAYMENT_METHOD_TYPES,
  PAYMENT_METHODS_CACHE_MS,
  PAYMENT_METHODS_RETRY_MS,
  CHECKOUT_LINE_ITEM_NAME,
  CHECKOUT_DESCRIPTION,
  CHECKOUT_RETURN_PATH,
  CHECKOUT_METADATA_PAYMENT_ID,
  CHECKOUT_METADATA_APPOINTMENT_ID,
  PAYMENT_EXPIRY_SWEEP_INTERVAL_MS,
  PAYMENT_EXPIRY_SWEEP_FIRST_RUN_MS,
  PAYMENT_EXPIRY_SWEEP_BATCH_SIZE,
  UNLINKED_CHECKOUT_FAILURE_AFTER_MS,
  PROVIDER_RECHECK_INTERVAL_MS,
  UNMATCHED_REFUND_RETRY_WINDOW_MS,
  RECEIPT_EMAIL_RETRY_WINDOW_MS,
  RECEIPT_EMAIL_RETRY_BATCH_SIZE,
  PAYMENTS_UNAVAILABLE_MESSAGE,
  DEPOSIT_STATUS_UNAVAILABLE_MESSAGE,
  DEPOSIT_NOT_REQUIRED_MESSAGE,
  DEPOSIT_ALREADY_PAID_MESSAGE,
  DEPOSIT_APPOINTMENT_NOT_PENDING_MESSAGE,
  DEPOSIT_APPOINTMENT_STARTED_MESSAGE,
  DEPOSIT_SLOT_TAKEN_MESSAGE,
  CHECKOUT_IN_PROGRESS_MESSAGE,
  CHECKOUT_BUSY_MESSAGE,
  PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE,
  DEPOSIT_UNPAID_APPROVAL_MESSAGE,
  DEPOSIT_REFUND_REQUIRED_MESSAGE
} = require('../constants/payments');

const { PENDING, PAID, EXPIRED, FAILED, REFUNDED } = PAYMENT_STATUSES;
const PAYMENT_ROW_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SCHEMA_WARNING_INTERVAL_MS = 5 * 60 * 1000;
const SCHEMA_ERROR_TEXT_MAX_LENGTH = 200;
const SWEEP_GLOBAL_KEY = Symbol.for('pethub.payments.expirySweep');

// ==================== CONFIGURATION ====================

// PAYMENTS_ENABLED is the deposit policy switch for NEW bookings: while it is on they need a deposit and customers can
// open checkouts. Appointments already marked deposit_required keep their deposit rules whatever the flag: approval
// needs a verified payment, lists show the deposit, cancelling settles open checkouts, and webhooks are recorded.
function isDepositPolicyEnabled() {
  return env.payments.enabled;
}

function getSecretKeyMode() {
  return paymongo.getSecretKeyMode(env.payments.paymongoSecretKey);
}

// Problem codes only, never values
function getConfigurationProblems() {
  const problems = [];
  const keyMode = getSecretKeyMode();
  if (keyMode === 'missing') problems.push('paymongo_secret_key_missing');
  if (keyMode === 'live') problems.push('paymongo_live_key_refused');
  if (keyMode === 'unknown') problems.push('paymongo_secret_key_unrecognized');
  if (!env.payments.paymongoWebhookSecret) problems.push('paymongo_webhook_secret_missing');
  if (!paymentsRepository.isConfigured()) problems.push('supabase_service_key_missing');
  return problems;
}

let providerClient = null;

// PayMongo is contacted only with a test secret key (sk_test_) and a working service-role database client
function getProviderClient() {
  if (getSecretKeyMode() !== 'test' || !paymentsRepository.isConfigured()) return null;
  if (!providerClient) {
    providerClient = paymongo.createPayMongoClient({ secretKey: env.payments.paymongoSecretKey });
  }
  return providerClient;
}

function isCheckoutAvailable() {
  return isDepositPolicyEnabled() && Boolean(getProviderClient());
}

const startupProblems = getConfigurationProblems();
if (env.payments.enabledSetting === 'unrecognized') {
  logger.warn('payments.flag_unrecognized', { reason: 'PAYMENTS_ENABLED must be "true" or "false"; any other value keeps deposits off' });
}
if (startupProblems.includes('paymongo_live_key_refused')) {
  logger.warn('payments.live_key_refused', { reason: 'PAYMONGO_SECRET_KEY is a live key; this version only runs PayMongo in test mode' });
}
if (isDepositPolicyEnabled() && startupProblems.length > 0) {
  logger.warn('payments.config_incomplete', { problems: startupProblems });
}

// ==================== HELPERS ====================

// 42703: column does not exist (reads); PGRST204: column missing from PostgREST's schema cache (writes)
function isMissingColumnError(error) {
  return Boolean(error) && (error.code === '42703' || error.code === 'PGRST204');
}

function isInvalidIdError(error) {
  return Boolean(error) && error.code === '22P02';
}

function isUniqueViolation(error) {
  return Boolean(error) && error.code === '23505';
}

function describeError(error) {
  return {
    code: String(error?.code || error?.name || 'unknown').slice(0, 64),
    status: Number.isInteger(error?.status) ? error.status : undefined
  };
}

function logDatabaseError(event, error, details = {}) {
  logger.error(event, {
    ...details,
    code: String(error?.code || 'unknown').slice(0, 64),
    error: String(error?.message || '').slice(0, 200)
  });
}

// Database error text names tables and columns. It is still cut short, and anything shaped like an email address,
// key, token or long id is masked, because it ends up in the server logs.
function toSafeLogText(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\s@'"]+@[^\s@'"]+/g, '[email]')
    .replace(/\b(?:sk|pk|rk|whsk|sb_secret|sb_publishable)_[A-Za-z0-9_]+|\bxkeysib-[A-Za-z0-9-]+|\bAIza[A-Za-z0-9_-]+/g, '[key]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g, '[token]')
    .replace(/[A-Za-z0-9+/=-]{32,}/g, '[redacted]')
    .slice(0, SCHEMA_ERROR_TEXT_MAX_LENGTH);
}

// "table.column" from PostgreSQL 42703 ("column payments.expires_at does not exist")
// or PostgREST PGRST204 ("Could not find the 'expires_at' column of 'payments' in the schema cache")
function findMissingColumn(error) {
  const message = String(error?.message || '');
  const undefinedColumn = /column "?([A-Za-z0-9_.]{1,128})"? does not exist/.exec(message);
  if (undefinedColumn) return undefinedColumn[1];
  const notInCache = /Could not find the '([A-Za-z0-9_]{1,64})' column of '([A-Za-z0-9_]{1,64})'/.exec(message);
  return notInCache ? `${notInCache[2]}.${notInCache[1]}` : undefined;
}

// The project id from SUPABASE_URL (https://<project>.supabase.co, the same id as in the Supabase Dashboard URL),
// so a schema error can be matched to the project where the columns were checked. Never the URL or a key.
function getSupabaseProjectRef() {
  try {
    const match = /^([a-z0-9]{1,40})\.supabase\.co$/.exec(new URL(env.supabase.url).hostname);
    return match ? match[1] : 'not_a_supabase_co_host';
  } catch (error) {
    return 'missing_or_invalid_url';
  }
}

// Throttled per source and error code, so one failing query never hides another
const lastSchemaWarningAt = new Map();

function reportMissingSchema(source, error) {
  const code = String(error?.code || 'unknown').slice(0, 64);
  const key = `${source}:${code}`;
  const now = Date.now();
  if (now - (lastSchemaWarningAt.get(key) || 0) < SCHEMA_WARNING_INTERVAL_MS) return;
  lastSchemaWarningAt.set(key, now);

  const details = {
    source,
    code,
    missing_column: findMissingColumn(error),
    db_message: toSafeLogText(error?.message),
    db_details: toSafeLogText(error?.details),
    db_hint: toSafeLogText(error?.hint),
    supabase_project: getSupabaseProjectRef(),
    hint: 'A column this query needs is missing in the Supabase project above. Check that it is the project where backend/database/migrations/2026-10-17_paymongo_deposits.sql was applied before changing any schema.'
  };
  Object.keys(details).forEach(name => {
    if (details[name] === undefined) delete details[name];
  });
  logger.error('payments.schema_missing', details);
}

// A missing deposit_required column only matters while deposits are on: with the flag off and no column,
// no appointment can need a deposit, so the old behaviour continues without a report
function reportMissingDepositFlag(error) {
  if (isDepositPolicyEnabled()) reportMissingSchema('appointments.deposit_required', error);
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sortNewestFirst(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((first, second) => (Date.parse(second?.created_at) || 0) - (Date.parse(first?.created_at) || 0));
}

function isLatePayment(row) {
  const paidAt = Date.parse(row?.paid_at);
  const expiresAt = Date.parse(row?.expires_at);
  return Number.isFinite(paidAt) && Number.isFinite(expiresAt) && paidAt > expiresAt;
}

function replaceRow(rows, updatedRow) {
  return rows.map(row => (String(row.id) === String(updatedRow.id) ? updatedRow : row));
}

function appointmentNotFound() {
  return { statusCode: 404, body: { error: 'Appointment not found' } };
}

function conflict(message, extra = {}) {
  return { statusCode: 409, body: { error: message, ...extra } };
}

function serviceUnavailable(message) {
  return { statusCode: 503, body: { error: message } };
}

function databaseFailure(event, error, details = {}) {
  logDatabaseError(event, error, details);
  return { statusCode: 500, body: { error: 'Server error' } };
}

function providerOrDatabaseFailure(event, error, details = {}) {
  if (error instanceof paymongo.PayMongoError) {
    logger.warn(event, { ...details, ...describeError(error) });
    return { statusCode: 502, body: { error: PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE } };
  }
  return databaseFailure(event, error, details);
}

// ==================== SCHEDULE ====================

const manilaClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function getManilaNow(date = new Date()) {
  const parts = Object.fromEntries(manilaClock.formatToParts(date).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    ms: ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000
  };
}

function getAppointmentRange(appointment) {
  return getAppointmentTimeRange(
    appointment?.appointment_date,
    appointment?.appointment_time,
    appointment?.estimated_duration_minutes
  );
}

// Appointment dates and times are clinic (Asia/Manila) wall-clock values
function hasAppointmentStarted(appointment, date = new Date()) {
  const range = getAppointmentTimeRange(
    appointment?.appointment_date,
    appointment?.appointment_time,
    appointment?.estimated_duration_minutes || 1
  );
  if (!range) return false;

  const now = getManilaNow(date);
  return range.date < now.date || (range.date === now.date && range.startMs <= now.ms);
}

function getOccupiedRanges(appointments) {
  return (appointments || [])
    .filter(appointment => OCCUPIED_APPOINTMENT_STATUSES.has(String(appointment?.status || '').trim().toLowerCase()))
    .map(appointment => ({ id: String(appointment.id || ''), range: getAppointmentRange(appointment) }))
    .filter(entry => entry.range);
}

function overlapsOccupiedRange(appointment, occupiedRanges) {
  const range = getAppointmentRange(appointment);
  if (!range) return false;

  const ownId = String(appointment?.id || '');
  return occupiedRanges.some(entry => (
    entry.id !== ownId &&
    entry.range.date === range.date &&
    range.startMs < entry.range.endMs &&
    entry.range.startMs < range.endMs
  ));
}

// Same rule as the booking and approval checks: only Approved and Completed appointments hold a slot
async function isSlotTaken(appointment) {
  const range = getAppointmentRange(appointment);
  if (!range) return false;

  const { data, error } = await appointmentsRepository.listScheduleByDate(range.date);
  if (error) throw error;
  return overlapsOccupiedRange(appointment, getOccupiedRanges(data));
}

// ==================== DEPOSIT SUMMARY ====================

function createDepositSummary(fields = {}) {
  return {
    required: false,
    status: 'not_required',
    amount: DEPOSIT_AMOUNT_PHP,
    currency: DEPOSIT_CURRENCY,
    last_checkout_status: null,
    checkout_expires_at: null,
    paid_at: null,
    payment_method: null,
    late_payment: false,
    duplicate_payment: false,
    refund_required: false,
    slot_conflict: false,
    can_pay: false,
    ...fields
  };
}

// status: not_required | unpaid | pending | paid | refunded | unavailable
function summarizeDeposit(appointment, depositRequired, paymentRows, { audience = 'user', slotConflict = false } = {}) {
  if (!depositRequired) return createDepositSummary();

  const rows = sortNewestFirst(paymentRows);
  const appointmentStatus = String(appointment?.status || '');
  const isAdmin = audience === 'admin';
  const pendingSlotConflict = isAdmin && slotConflict && appointmentStatus === 'Pending';
  const paidRows = rows.filter(row => row.payment_status === PAID);

  if (paidRows.length > 0) {
    // The first payment received is the deposit; any later one is a duplicate that needs a refund
    const deposit = paidRows[paidRows.length - 1];
    const duplicatePayment = paidRows.length > 1;
    return createDepositSummary({
      required: true,
      status: 'paid',
      paid_at: toIso(deposit.paid_at),
      payment_method: deposit.payment_method || null,
      late_payment: paidRows.some(isLatePayment),
      duplicate_payment: duplicatePayment,
      refund_required: appointmentStatus === 'Cancelled' || duplicatePayment || pendingSlotConflict,
      slot_conflict: pendingSlotConflict
    });
  }

  const canPay = !isAdmin && appointmentStatus === 'Pending' && isCheckoutAvailable() && !hasAppointmentStarted(appointment);
  const openRow = rows.find(row => row.payment_status === PENDING);
  if (openRow) {
    return createDepositSummary({
      required: true,
      status: 'pending',
      checkout_expires_at: toIso(openRow.expires_at),
      slot_conflict: pendingSlotConflict,
      can_pay: canPay
    });
  }

  const latest = rows[0];
  if (latest && latest.payment_status === REFUNDED) {
    return createDepositSummary({ required: true, status: 'refunded', slot_conflict: pendingSlotConflict, can_pay: canPay });
  }

  let lastCheckoutStatus = null;
  if (latest && latest.payment_status === EXPIRED) lastCheckoutStatus = 'expired';
  if (latest && latest.payment_status === FAILED) lastCheckoutStatus = 'failed';

  return createDepositSummary({
    required: true,
    status: 'unpaid',
    last_checkout_status: lastCheckoutStatus,
    slot_conflict: pendingSlotConflict,
    can_pay: canPay
  });
}

async function loadDepositRequiredIds(appointments, audience) {
  if (audience === 'admin') {
    const { data, error } = await appointmentsRepository.listDepositRequiredIds();
    if (error) throw error;
    return new Set((data || []).map(row => String(row.id)));
  }

  const ids = [...new Set(appointments.map(appointment => appointment?.id).filter(Boolean).map(String))];
  if (ids.length === 0) return new Set();

  const { data, error } = await appointmentsRepository.listDepositFlagsByIds(ids);
  if (error) throw error;
  return new Set((data || []).filter(row => row.deposit_required === true).map(row => String(row.id)));
}

/**
 * Adds a `deposit` summary to each appointment for the user and admin lists.
 * Uses two reads (deposit flags, then payment rows); a failure only marks deposits as unavailable.
 */
async function attachDepositSummaries(appointments, { audience = 'user' } = {}) {
  const list = Array.isArray(appointments) ? appointments : [];
  if (list.length === 0) return list;
  // While deposits are off, only appointments that already need one get a summary; every other one stays as before
  const policyEnabled = isDepositPolicyEnabled();

  let requiredIds;
  try {
    requiredIds = await loadDepositRequiredIds(list, audience);
  } catch (error) {
    if (!policyEnabled) {
      if (!isMissingColumnError(error)) logDatabaseError('payments.summary_flags_failed', error);
      return list;
    }
    if (isMissingColumnError(error)) {
      // Before the migration no appointment can require a deposit
      reportMissingSchema('appointments.deposit_required', error);
      return list.map(appointment => ({ ...appointment, deposit: createDepositSummary() }));
    }
    logDatabaseError('payments.summary_flags_failed', error);
    return list.map(appointment => ({ ...appointment, deposit: createDepositSummary({ required: null, status: 'unavailable' }) }));
  }

  if (requiredIds.size === 0) {
    return policyEnabled ? list.map(appointment => ({ ...appointment, deposit: createDepositSummary() })) : list;
  }

  let rowsByAppointment = null;
  if (paymentsRepository.isConfigured()) {
    try {
      const { data, error } = audience === 'admin'
        ? await paymentsRepository.listAll()
        : await paymentsRepository.listByAppointmentIds([...requiredIds]);
      if (error) throw error;

      rowsByAppointment = new Map();
      (data || []).forEach(row => {
        const appointmentId = String(row?.appointment_id || '');
        if (!requiredIds.has(appointmentId)) return;
        if (!rowsByAppointment.has(appointmentId)) rowsByAppointment.set(appointmentId, []);
        rowsByAppointment.get(appointmentId).push(row);
      });
    } catch (error) {
      if (isMissingColumnError(error)) reportMissingSchema('payments', error);
      else logDatabaseError('payments.summary_rows_failed', error);
      rowsByAppointment = null;
    }
  }

  const occupiedRanges = audience === 'admin' ? getOccupiedRanges(list) : [];
  return list.map(appointment => {
    const appointmentId = String(appointment?.id || '');
    if (!requiredIds.has(appointmentId)) {
      return policyEnabled ? { ...appointment, deposit: createDepositSummary() } : appointment;
    }
    if (!rowsByAppointment) {
      return { ...appointment, deposit: createDepositSummary({ required: true, status: 'unavailable' }) };
    }

    const slotConflict = audience === 'admin' && overlapsOccupiedRange(appointment, occupiedRanges);
    return {
      ...appointment,
      deposit: summarizeDeposit(appointment, true, rowsByAppointment.get(appointmentId) || [], { audience, slotConflict })
    };
  });
}

function getNewAppointmentDepositFields() {
  return isDepositPolicyEnabled() ? { deposit_required: true } : {};
}

function getNewAppointmentDepositNotice() {
  return createDepositSummary({ required: true, status: 'unpaid', can_pay: isCheckoutAvailable() });
}

// Added to the user's appointment list so the booking form can show the deposit before submitting ({} while deposits are off)
function getDepositPolicy() {
  if (!isDepositPolicyEnabled()) return {};
  return {
    deposit_policy: {
      required: true,
      amount: DEPOSIT_AMOUNT_PHP,
      currency: DEPOSIT_CURRENCY,
      checkout_available: isCheckoutAvailable()
    }
  };
}

// ==================== EMAIL NOTIFICATIONS ====================
// Emails run in the background after the payment or appointment change is stored, so a slow or failing
// Brevo request never delays a webhook answer and never changes payment or appointment state.

const backgroundTasks = new Set();

function runInBackground(event, details, task) {
  const promise = Promise.resolve()
    .then(task)
    .catch(error => logger.error(event, { ...details, ...describeError(error) }))
    .finally(() => backgroundTasks.delete(promise));
  backgroundTasks.add(promise);
}

// Resolves once every email started so far has finished (used by the automated tests)
async function waitForBackgroundTasks() {
  while (backgroundTasks.size > 0) {
    await Promise.allSettled([...backgroundTasks]);
  }
}

function getAppointmentsPageUrl() {
  const base = toReturnOrigin(env.payments.frontendUrl);
  return base ? new URL(CHECKOUT_RETURN_PATH, base).toString() : '';
}

async function loadCustomer(userId) {
  const { data, error } = await usersRepository.findStatusById(userId);
  if (error) throw error;
  const user = Array.isArray(data) ? data[0] : data;
  return user && user.email ? user : null;
}

// Another Paid row created earlier means this payment is a duplicate (the first payment is the deposit)
function isDuplicatePayment(row, rows) {
  const createdAt = Date.parse(row.created_at) || 0;
  return rows.some(other => (
    String(other.id) !== String(row.id) &&
    other.payment_status === PAID &&
    (Date.parse(other.created_at) || 0) < createdAt
  ));
}

/**
 * Sends the "deposit payment confirmed" email at most once per payment row: receipt_email_sent_at is claimed first,
 * so duplicate webhooks, status checks and the sweep cannot send it twice. A failed send releases the claim, and the
 * expiry sweep retries it (RECEIPT_EMAIL_RETRY_WINDOW_MS). Returns 'sent' | 'already_sent' | 'skipped' | 'failed'.
 */
async function sendDepositReceipt(row) {
  if (!row || row.payment_status !== PAID) return 'skipped';

  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await paymentsRepository.claimReceiptEmail(row.id, claimedAt);
  if (claimError) {
    if (isMissingColumnError(claimError)) {
      reportMissingSchema('payments.receipt_email_sent_at', claimError);
      return 'skipped';
    }
    throw claimError;
  }
  if (!Array.isArray(claimed) || claimed.length === 0) return 'already_sent';

  const context = { payment_row_id: row.id, appointment_id: row.appointment_id };
  try {
    const { data: appointment, error: appointmentError } = await appointmentsRepository.findById(row.appointment_id);
    if (appointmentError) throw appointmentError;
    const customer = appointment ? await loadCustomer(appointment.user_id) : null;
    if (!appointment || !customer) {
      // Nothing can ever be sent, so the claim stays and the sweep does not retry it
      logger.error('payments.receipt_email_skipped', { ...context, reason: appointment ? 'no_customer_email' : 'appointment_missing' });
      return 'skipped';
    }

    const rows = await loadPaymentRows(row.appointment_id);
    const email = buildDepositReceiptEmail({
      name: customer.fullname,
      appointment,
      payment: row,
      refundDue: appointment.status === 'Cancelled' || isDuplicatePayment(row, rows),
      appointmentsUrl: getAppointmentsPageUrl()
    });
    await sendEmail({ to: customer.email, ...email });
    logger.info('payments.receipt_email_sent', context);
    return 'sent';
  } catch (error) {
    const { error: releaseError } = await paymentsRepository.releaseReceiptEmail(row.id, claimedAt);
    if (releaseError) logDatabaseError('payments.receipt_email_release_failed', releaseError, context);
    logger.warn('payments.receipt_email_failed', { ...context, ...describeError(error) });
    return 'failed';
  }
}

// Retries confirmation emails that could not be sent (called by the expiry sweep)
async function retryReceiptEmails(now = Date.now()) {
  if (!paymentsRepository.isConfigured()) return 0;

  const paidSince = new Date(now - RECEIPT_EMAIL_RETRY_WINDOW_MS).toISOString();
  const { data, error } = await paymentsRepository.listPaidWithoutReceipt(paidSince, RECEIPT_EMAIL_RETRY_BATCH_SIZE);
  if (error) {
    if (isMissingColumnError(error)) reportMissingSchema('payments.receipt_email_sent_at', error);
    else logDatabaseError('payments.receipt_email_retry_failed', error);
    return 0;
  }

  let sent = 0;
  for (const row of data || []) {
    if ((await sendDepositReceipt(row)) === 'sent') sent += 1;
  }
  return sent;
}

// decision: 'approved' | 'cancelled'; depositStatus: 'paid' | 'refunded' | 'none'
async function sendAppointmentDecision(appointment, { decision, previousStatus, depositStatus }) {
  const context = { appointment_id: appointment.id, decision };
  const customer = await loadCustomer(appointment.user_id);
  if (!customer) {
    logger.warn('appointments.decision_email_skipped', { ...context, reason: 'no_customer_email' });
    return 'skipped';
  }

  const email = buildAppointmentDecisionEmail({
    name: customer.fullname,
    appointment,
    decision,
    previousStatus,
    depositStatus,
    appointmentsUrl: getAppointmentsPageUrl()
  });
  await sendEmail({ to: customer.email, ...email });
  logger.info('appointments.decision_email_sent', context);
  return 'sent';
}

// Status changes are conditional updates, so each decision is stored, and therefore emailed, only once
function queueDecisionEmail(appointment, options) {
  runInBackground('appointments.decision_email_failed', { appointment_id: appointment.id, decision: options.decision }, () => (
    sendAppointmentDecision(appointment, options)
  ));
}

// ==================== PAYMONGO RECONCILIATION ====================

async function reloadPayment(row) {
  const { data, error } = await paymentsRepository.findById(row.id);
  if (error) throw error;
  return data || row;
}

async function moveStatus(row, fromStatuses, toStatus, event) {
  const { data, error } = await paymentsRepository.updateStatusFrom(row.id, fromStatuses, { payment_status: toStatus });
  if (error) throw error;

  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) return reloadPayment(row);

  logger.info(event, { payment_row_id: updated.id, appointment_id: updated.appointment_id });
  return updated;
}

// Checks a PayMongo checkout session against the PetHub payment row before anything is recorded
function evaluateSessionPayment(session, row) {
  const paidPayments = (session?.payments || []).filter(payment => payment.status === 'paid');
  if (paidPayments.length === 0) return { state: 'unpaid' };

  const payment = paidPayments[0];
  const problems = [];
  if (session.livemode === true || payment.livemode === true) problems.push('livemode');
  if (payment.amount !== DEPOSIT_AMOUNT_CENTAVOS) problems.push('amount');
  if (payment.currency !== DEPOSIT_CURRENCY) problems.push('currency');
  if (!paymongo.isPaymentId(payment.id)) problems.push('payment_id');
  if (session.metadata[CHECKOUT_METADATA_PAYMENT_ID] !== String(row.id)) problems.push('metadata_payment_id');
  if (session.metadata[CHECKOUT_METADATA_APPOINTMENT_ID] !== String(row.appointment_id)) problems.push('metadata_appointment_id');
  if (session.referenceNumber && session.referenceNumber !== String(row.id)) problems.push('reference_number');
  if (row.provider_checkout_session_id && row.provider_checkout_session_id !== session.id) problems.push('checkout_session_id');
  if (paidPayments.length > 1) problems.push('multiple_paid_payments');

  return problems.length > 0 ? { state: 'mismatch', problems } : { state: 'paid', payment };
}

const REFERENCE_PROBLEMS = new Set(['metadata_payment_id', 'metadata_appointment_id', 'reference_number', 'checkout_session_id']);

// Log category for a mismatch: the session points at another PetHub payment, or its payment details are wrong
function describeMismatch(problems) {
  return problems.some(problem => REFERENCE_PROBLEMS.has(problem)) ? 'inconsistent_reference' : 'payment_details_mismatch';
}

// appointments.payment_status follows the verified deposit ('Paid', or 'Refunded' once no paid payment remains), so the
// appointment row agrees with the payments table, which stays the source of truth. Best effort: a database refusal
// is logged and never undoes or blocks the payment change.
async function syncAppointmentPaymentStatus(appointmentId) {
  try {
    const rows = await loadPaymentRows(appointmentId);
    let paymentStatus = null;
    if (rows.some(row => row.payment_status === PAID)) paymentStatus = PAID;
    else if (rows.some(row => row.payment_status === REFUNDED)) paymentStatus = REFUNDED;
    if (!paymentStatus) return;

    const { error } = await appointmentsRepository.updatePaymentStatus(appointmentId, paymentStatus);
    if (error) logDatabaseError('payments.appointment_payment_status_sync_failed', error, { appointment_id: appointmentId });
  } catch (error) {
    logDatabaseError('payments.appointment_payment_status_sync_failed', error, { appointment_id: appointmentId });
  }
}

// Pending, Expired and Failed rows can become Paid: a payment PayMongo confirms is always recorded, even late
async function recordPaid(row, payment, { sessionId, source }) {
  const values = {
    payment_status: PAID,
    provider_payment_id: payment.id,
    payment_method: payment.methodType,
    paid_at: payment.paidAt || new Date().toISOString()
  };
  if (!row.provider_checkout_session_id && sessionId) {
    values.provider_checkout_session_id = sessionId;
  }

  const { data, error } = await paymentsRepository.updateStatusFrom(row.id, [PENDING, EXPIRED, FAILED], values);
  if (error) {
    if (isUniqueViolation(error)) {
      logger.error('payments.provider_payment_already_recorded', { payment_row_id: row.id, source });
      return reloadPayment(row);
    }
    throw error;
  }

  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) {
    // Already moved on by a duplicate event or a parallel check
    return reloadPayment(row);
  }

  logger.info('payments.paid', { payment_row_id: updated.id, appointment_id: updated.appointment_id, source });
  if (row.payment_status !== PENDING) {
    logger.warn('payments.late_payment_recorded', { payment_row_id: updated.id, previous_status: row.payment_status, source });
  } else if (isLatePayment(updated)) {
    logger.warn('payments.paid_after_window', { payment_row_id: updated.id, source });
  }
  await syncAppointmentPaymentStatus(updated.appointment_id);

  // Only the request that moved the row to Paid gets here, so duplicate deliveries never queue a second email
  runInBackground('payments.receipt_email_failed', { payment_row_id: updated.id }, () => sendDepositReceipt(updated));
  return updated;
}

// Returns the updated row when the session is final (paid or expired), or null when it is still open
async function applySessionState(row, session) {
  const evaluation = evaluateSessionPayment(session, row);
  if (evaluation.state === 'paid') {
    return recordPaid(row, evaluation.payment, { sessionId: session.id, source: 'provider_check' });
  }
  if (evaluation.state === 'mismatch') {
    // Never marked Paid or Expired automatically; the row stays Pending for a person to review
    logger.error('payments.provider_payment_mismatch', { payment_row_id: row.id, reason: describeMismatch(evaluation.problems), problems: evaluation.problems });
    return row;
  }
  if (session.status === 'expired') {
    return moveStatus(row, [PENDING], EXPIRED, 'payments.checkout_expired');
  }
  return null;
}

/**
 * Brings one PetHub Pending checkout in line with PayMongo and returns { row, session }.
 * A row is closed as Expired only after PayMongo confirms the session is expired or does not exist,
 * so a real payment is never discarded; it is marked Paid only after its details are verified.
 */
async function settlePendingPayment(row, { forceExpire = false, now = Date.now() } = {}) {
  const client = getProviderClient();
  if (!client || !row || row.payment_status !== PENDING || !row.expires_at) {
    return { row, session: null };
  }

  const sessionId = row.provider_checkout_session_id;
  if (!sessionId) {
    const createdAt = Date.parse(row.created_at);
    const abandoned = forceExpire || !Number.isFinite(createdAt) || now - createdAt >= UNLINKED_CHECKOUT_FAILURE_AFTER_MS;
    if (!abandoned) return { row, session: null };

    const { data, error } = await paymentsRepository.markUnlinkedFailed(row.id);
    if (error) throw error;
    const updated = Array.isArray(data) && data[0] ? data[0] : await reloadPayment(row);
    return { row: updated, session: null };
  }

  let session = await client.retrieveCheckoutSession(sessionId);
  const finalRow = await applySessionState(row, session);
  if (finalRow) return { row: finalRow, session };

  const windowElapsed = Date.parse(row.expires_at) <= now;
  if (!windowElapsed && !forceExpire) return { row, session };

  try {
    session = await client.expireCheckoutSession(sessionId);
    return { row: await moveStatus(row, [PENDING], EXPIRED, 'payments.checkout_expired'), session };
  } catch (error) {
    if (!(error instanceof paymongo.PayMongoError)) throw error;

    if (error.status === 404) {
      logger.warn('payments.checkout_session_missing', { payment_row_id: row.id });
      return { row: await moveStatus(row, [PENDING], EXPIRED, 'payments.checkout_expired'), session: null };
    }
    if (error.status !== 400) throw error;

    // 400 = already expired, already paid, or a payment is still in progress: look again before deciding
    session = await client.retrieveCheckoutSession(sessionId);
    const settledRow = await applySessionState(row, session);
    return { row: settledRow || row, session };
  }
}

const recentProviderChecks = new Map();

// Limits how often status requests for the same payment reach PayMongo
function shouldAskProvider(paymentRowId, now = Date.now()) {
  const lastCheckedAt = recentProviderChecks.get(paymentRowId) || 0;
  if (now - lastCheckedAt < PROVIDER_RECHECK_INTERVAL_MS) return false;
  if (recentProviderChecks.size > 500) recentProviderChecks.clear();
  recentProviderChecks.set(paymentRowId, now);
  return true;
}

// ==================== PAYMENT METHODS ====================

let paymentMethodsCache = { methods: null, expiresAt: 0 };

/**
 * The methods a new checkout requests: PetHub's list, limited to the ones PayMongo reports as configured on the
 * account. An empty list means none of them can be used. If PayMongo cannot be asked, the last known list is used
 * (or PetHub's full list, which PayMongo then filters), so a failed lookup alone never blocks checkout.
 */
async function getCheckoutPaymentMethodTypes(client, now = Date.now()) {
  if (paymentMethodsCache.methods && now < paymentMethodsCache.expiresAt) return paymentMethodsCache.methods;

  try {
    const configured = await client.listPaymentMethodCapabilities();
    const methods = CHECKOUT_PAYMENT_METHOD_TYPES.filter(type => configured.includes(type));
    paymentMethodsCache = { methods, expiresAt: now + PAYMENT_METHODS_CACHE_MS };
    if (methods.length === 0) {
      logger.error('payments.no_supported_payment_methods', { configured: configured.slice(0, 20) });
    }
    return methods;
  } catch (error) {
    const methods = paymentMethodsCache.methods || [...CHECKOUT_PAYMENT_METHOD_TYPES];
    paymentMethodsCache = { methods, expiresAt: now + PAYMENT_METHODS_RETRY_MS };
    logger.warn('payments.payment_methods_check_failed', describeError(error));
    return methods;
  }
}

function clearPaymentMethodsCache() {
  paymentMethodsCache = { methods: null, expiresAt: 0 };
}

// ==================== CHECKOUT ====================

function toReturnOrigin(value, { fromRequest = false } = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (error) {
    return '';
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) return '';

  // A request Origin is used only when it is one of the frontends the API already serves (same rule as CORS)
  if (fromRequest && !isLocalhost && !env.cors.allowedOrigins.includes(url.origin) && !url.hostname.endsWith('.vercel.app')) {
    return '';
  }
  return url.origin;
}

function buildReturnUrls(originHeader, appointmentId) {
  const base = toReturnOrigin(env.payments.frontendUrl) || toReturnOrigin(originHeader, { fromRequest: true });
  if (!base) return null;

  // The query only tells the page which appointment to re-check; it never counts as proof of payment
  const buildUrl = outcome => {
    const url = new URL(CHECKOUT_RETURN_PATH, base);
    url.searchParams.set('payment', outcome);
    url.searchParams.set('appointment_id', String(appointmentId));
    return url.toString();
  };

  return { successUrl: buildUrl('return'), cancelUrl: buildUrl('cancelled') };
}

function checkoutResponse(row, checkoutUrl) {
  return {
    success: true,
    checkout_url: checkoutUrl,
    payment_id: row.id,
    appointment_id: row.appointment_id,
    status: 'pending',
    expires_at: toIso(row.expires_at),
    amount: DEPOSIT_AMOUNT_PHP,
    currency: DEPOSIT_CURRENCY
  };
}

async function loadOwnedAppointment(appointmentId, userId) {
  const { data, error } = await appointmentsRepository.findForDeposit(appointmentId);
  if (error) {
    if (isInvalidIdError(error)) return { result: appointmentNotFound() };
    if (isMissingColumnError(error)) {
      reportMissingDepositFlag(error);
      return { result: serviceUnavailable(PAYMENTS_UNAVAILABLE_MESSAGE) };
    }
    return { result: databaseFailure('payments.appointment_load_failed', error) };
  }

  // Someone else's appointment gets the same answer as a missing one
  if (!data || String(data.user_id || '').trim() !== String(userId || '').trim()) {
    return { result: appointmentNotFound() };
  }

  return { appointment: data };
}

async function loadPaymentRows(appointmentId) {
  const { data, error } = await paymentsRepository.listByAppointmentIds([appointmentId]);
  if (error) throw error;
  return data || [];
}

async function getSlotTakenResult(appointment) {
  try {
    return (await isSlotTaken(appointment)) ? conflict(DEPOSIT_SLOT_TAKEN_MESSAGE) : null;
  } catch (error) {
    return databaseFailure('payments.slot_check_failed', error, { appointment_id: appointment.id });
  }
}

function depositAlreadyPaid(appointment, rows) {
  return conflict(DEPOSIT_ALREADY_PAID_MESSAGE, {
    deposit: summarizeDeposit(appointment, true, rows, { audience: 'user' })
  });
}

async function closeUnusedCheckout(paymentRowId, sessionId) {
  if (sessionId) {
    try {
      await getProviderClient().expireCheckoutSession(sessionId);
    } catch (error) {
      logger.warn('payments.unused_session_expire_failed', { payment_row_id: paymentRowId, ...describeError(error) });
    }
  }

  const { error } = await paymentsRepository.updateStatusFrom(paymentRowId, [PENDING], { payment_status: FAILED });
  if (error) logDatabaseError('payments.unused_checkout_close_failed', error, { payment_row_id: paymentRowId });
}

async function startCheckout(appointment, userId, originHeader) {
  const returnUrls = buildReturnUrls(originHeader, appointment.id);
  if (!returnUrls) {
    logger.error('payments.return_url_unavailable', { hint: 'Set FRONTEND_URL to the frontend origin' });
    return serviceUnavailable(PAYMENTS_UNAVAILABLE_MESSAGE);
  }

  const paymentMethodTypes = await getCheckoutPaymentMethodTypes(getProviderClient());
  if (paymentMethodTypes.length === 0) return serviceUnavailable(PAYMENTS_UNAVAILABLE_MESSAGE);

  const createdAt = new Date();
  const paymentRow = {
    id: crypto.randomUUID(),
    appointment_id: appointment.id,
    user_id: userId,
    amount: DEPOSIT_AMOUNT_PHP,
    payment_status: PENDING,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + CHECKOUT_WINDOW_MINUTES * 60 * 1000).toISOString()
  };

  const { error: insertError } = await paymentsRepository.insertPayment(paymentRow);
  if (insertError) {
    // The one-open-checkout-per-appointment index stops a second checkout opened at the same moment
    if (isUniqueViolation(insertError)) return conflict(CHECKOUT_BUSY_MESSAGE);
    if (isMissingColumnError(insertError)) {
      reportMissingSchema('payments', insertError);
      return serviceUnavailable(PAYMENTS_UNAVAILABLE_MESSAGE);
    }
    return databaseFailure('payments.checkout_insert_failed', insertError, { appointment_id: appointment.id });
  }

  let session;
  try {
    session = await getProviderClient().createCheckoutSession({
      amountCentavos: DEPOSIT_AMOUNT_CENTAVOS,
      currency: DEPOSIT_CURRENCY,
      lineItemName: CHECKOUT_LINE_ITEM_NAME,
      description: CHECKOUT_DESCRIPTION,
      paymentMethodTypes,
      referenceNumber: paymentRow.id,
      metadata: {
        [CHECKOUT_METADATA_PAYMENT_ID]: paymentRow.id,
        [CHECKOUT_METADATA_APPOINTMENT_ID]: String(appointment.id)
      },
      successUrl: returnUrls.successUrl,
      cancelUrl: returnUrls.cancelUrl,
      // Sent for the record only: PayMongo does not document Idempotency-Key for checkout sessions, and a replay in the
      // test sandbox created a second session. So a create is never retried; a failed or unanswered create closes this
      // row as Failed, and the URL of any session PayMongo did create never reaches the customer.
      idempotencyKey: paymentRow.id
    });
  } catch (error) {
    await closeUnusedCheckout(paymentRow.id, null);
    return providerOrDatabaseFailure('payments.checkout_create_failed', error, { payment_row_id: paymentRow.id });
  }

  // The checkout URL is only handed out once its session id is saved, so every webhook can be matched
  const { data: linked, error: linkError } = await paymentsRepository.attachCheckoutSession(paymentRow.id, session.id);
  if (linkError || !Array.isArray(linked) || linked.length === 0) {
    if (linkError) logDatabaseError('payments.checkout_link_failed', linkError, { payment_row_id: paymentRow.id });
    else logger.warn('payments.checkout_link_skipped', { payment_row_id: paymentRow.id });
    await closeUnusedCheckout(paymentRow.id, session.id);
    return { statusCode: 500, body: { error: 'Server error' } };
  }

  logger.info('payments.checkout_created', { payment_row_id: paymentRow.id, appointment_id: appointment.id });
  return {
    statusCode: 201,
    body: checkoutResponse({ ...paymentRow, provider_checkout_session_id: session.id }, session.checkoutUrl)
  };
}

/**
 * POST /payments/checkout  { appointment_id }
 * Starts (or resumes) the ₱100 deposit checkout for the signed-in user's own Pending appointment.
 */
const createCheckout = async (req) => {
  const validation = validateCheckoutRequest(req.body);
  if (validation.error) return validation.error;

  const userId = String(req.authUserId || '').trim();
  if (!isCheckoutAvailable()) return serviceUnavailable(PAYMENTS_UNAVAILABLE_MESSAGE);

  const verified = await isUserVerified(userId);
  if (!verified) {
    return { statusCode: 403, body: { error: 'Please verify your email first before paying a deposit.' } };
  }

  const loaded = await loadOwnedAppointment(validation.appointmentId, userId);
  if (loaded.result) return loaded.result;
  const { appointment } = loaded;

  if (appointment.deposit_required !== true) return conflict(DEPOSIT_NOT_REQUIRED_MESSAGE);
  if (appointment.status !== 'Pending') return conflict(DEPOSIT_APPOINTMENT_NOT_PENDING_MESSAGE);
  if (hasAppointmentStarted(appointment)) return conflict(DEPOSIT_APPOINTMENT_STARTED_MESSAGE);

  let rows;
  try {
    rows = await loadPaymentRows(appointment.id);
  } catch (error) {
    return databaseFailure('payments.checkout_rows_failed', error, { appointment_id: appointment.id });
  }

  if (rows.some(row => row.payment_status === PAID)) return depositAlreadyPaid(appointment, rows);

  const openRow = rows.find(row => row.payment_status === PENDING);
  if (openRow) {
    let settled;
    try {
      settled = await settlePendingPayment(openRow);
    } catch (error) {
      return providerOrDatabaseFailure('payments.checkout_settle_failed', error, { payment_row_id: openRow.id });
    }

    const settledRow = settled.row;
    if (settledRow.payment_status === PAID) return depositAlreadyPaid(appointment, replaceRow(rows, settledRow));

    if (settledRow.payment_status === PENDING) {
      if (!settledRow.provider_checkout_session_id) return conflict(CHECKOUT_BUSY_MESSAGE);

      const session = settled.session;
      const windowOpen = Date.parse(settledRow.expires_at) > Date.now();
      // A session that already holds a payment PetHub could not verify is left for review, never handed out again
      const hasUnverifiedPayment = Boolean(session) && session.payments.some(payment => payment.status === 'paid');
      if (!windowOpen || !session || session.status !== 'active' || hasUnverifiedPayment || !paymongo.isPayMongoCheckoutUrl(session.checkoutUrl)) {
        return conflict(CHECKOUT_IN_PROGRESS_MESSAGE);
      }

      const slotTaken = await getSlotTakenResult(appointment);
      if (slotTaken) return slotTaken;

      // Repeated requests resume the same session instead of creating another one
      return { statusCode: 200, body: checkoutResponse(settledRow, session.checkoutUrl) };
    }
    // Expired or Failed: a new checkout starts below
  }

  const slotTaken = await getSlotTakenResult(appointment);
  if (slotTaken) return slotTaken;

  return startCheckout(appointment, userId, req.headers?.origin);
};

/**
 * GET /payments/appointment/:appointmentId
 * Deposit state for the signed-in user's own appointment, rechecked with PayMongo while a checkout is open.
 * Answers whatever PAYMENTS_ENABLED says: an appointment marked deposit_required keeps its deposit, and a customer
 * coming back from PayMongo (or pressing "Check payment status") must still see it. Opening a checkout stays off.
 */
const getAppointmentPaymentStatus = async (req) => {
  const validation = validatePaymentStatusRequest(req.params);
  if (validation.error) return validation.error;

  const userId = String(req.authUserId || '').trim();

  const verified = await isUserVerified(userId);
  if (!verified) {
    return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub appointments.' } };
  }

  const loaded = await loadOwnedAppointment(validation.appointmentId, userId);
  if (loaded.result) return loaded.result;
  const { appointment } = loaded;

  const respond = deposit => ({
    statusCode: 200,
    body: { success: true, appointment_id: appointment.id, appointment_status: appointment.status, deposit }
  });

  if (appointment.deposit_required !== true) return respond(createDepositSummary());
  if (!paymentsRepository.isConfigured()) return serviceUnavailable(DEPOSIT_STATUS_UNAVAILABLE_MESSAGE);

  let rows;
  try {
    rows = await loadPaymentRows(appointment.id);
  } catch (error) {
    return databaseFailure('payments.status_rows_failed', error, { appointment_id: appointment.id });
  }

  const openRow = rows.find(row => row.payment_status === PENDING);
  if (openRow && shouldAskProvider(String(openRow.id))) {
    try {
      const settled = await settlePendingPayment(openRow);
      rows = replaceRow(rows, settled.row);
    } catch (error) {
      // The stored state is still returned; the next request or the expiry sweep tries again
      logger.warn('payments.status_check_failed', { payment_row_id: openRow.id, ...describeError(error) });
    }
  }

  return respond(summarizeDeposit(appointment, true, rows, { audience: 'user' }));
};

// ==================== APPOINTMENT STATUS INTEGRATION ====================

function approvalBlocked(statusCode, body) {
  return { allowed: false, depositPaid: false, result: { statusCode, body } };
}

/**
 * Used by both admin status endpoints before approving. Returns { allowed, depositPaid, result? }.
 * Fails closed: if a required deposit cannot be checked, approval waits.
 */
// Checked whatever PAYMENTS_ENABLED says: switching deposits off never makes an unpaid deposit appointment approvable
async function checkDepositForApproval(appointment) {
  const appointmentId = String(appointment?.id || '');
  const { data: depositInfo, error: flagError } = await appointmentsRepository.findForDeposit(appointmentId);
  if (flagError) {
    if (isMissingColumnError(flagError)) {
      // Before the migration no appointment can require a deposit
      reportMissingDepositFlag(flagError);
      return { allowed: true, depositPaid: false };
    }
    logDatabaseError('payments.approval_check_failed', flagError, { appointment_id: appointmentId });
    return approvalBlocked(503, { error: DEPOSIT_STATUS_UNAVAILABLE_MESSAGE });
  }

  if (!depositInfo || depositInfo.deposit_required !== true) return { allowed: true, depositPaid: false };

  if (!paymentsRepository.isConfigured()) {
    logger.error('payments.approval_check_unavailable', { problems: ['supabase_service_key_missing'] });
    return approvalBlocked(503, { error: DEPOSIT_STATUS_UNAVAILABLE_MESSAGE });
  }

  let rows;
  try {
    rows = await loadPaymentRows(appointmentId);
  } catch (error) {
    logDatabaseError('payments.approval_check_failed', error, { appointment_id: appointmentId });
    return approvalBlocked(503, { error: DEPOSIT_STATUS_UNAVAILABLE_MESSAGE });
  }

  // The customer may have just paid before the webhook arrived: confirm an open checkout with PayMongo first
  const openRow = rows.find(row => row.payment_status === PENDING);
  if (openRow && !rows.some(row => row.payment_status === PAID)) {
    try {
      const settled = await settlePendingPayment(openRow);
      rows = replaceRow(rows, settled.row);
    } catch (error) {
      logger.warn('payments.approval_provider_check_failed', { payment_row_id: openRow.id, ...describeError(error) });
    }
  }

  const deposit = summarizeDeposit(appointment, true, rows, { audience: 'admin' });
  if (deposit.status === 'paid') return { allowed: true, depositPaid: true };

  return approvalBlocked(409, {
    error: DEPOSIT_UNPAID_APPROVAL_MESSAGE,
    deposit_required: true,
    deposit_status: deposit.status
  });
}

// A paid appointment whose slot is taken cannot be approved; its deposit needs a refund
function addRefundRequiredToConflict(conflictBody, depositCheck) {
  if (!depositCheck || !depositCheck.depositPaid) return conflictBody;
  return {
    ...conflictBody,
    error: `${conflictBody.error} ${DEPOSIT_REFUND_REQUIRED_MESSAGE}`,
    refund_required: true,
    deposit_status: 'paid'
  };
}

/**
 * After an admin cancels an appointment: closes any open checkout at PayMongo so it can no longer be paid,
 * and reports whether a paid deposit now needs a refund. It never undoes or blocks the cancellation.
 * Returns { notice, depositRequired, depositStatus: 'paid' | 'refunded' | 'none' }.
 */
async function settleCancelledAppointment(appointment) {
  const exempt = { notice: {}, depositRequired: false, depositStatus: 'none' };
  if (!paymentsRepository.isConfigured()) return exempt;

  const appointmentId = String(appointment?.id || '');
  try {
    const { data: depositInfo, error: flagError } = await appointmentsRepository.findForDeposit(appointmentId);
    if (flagError) throw flagError;
    if (!depositInfo || depositInfo.deposit_required !== true) return exempt;

    let rows = await loadPaymentRows(appointmentId);
    for (const row of rows.filter(item => item.payment_status === PENDING)) {
      try {
        const settled = await settlePendingPayment(row, { forceExpire: true });
        rows = replaceRow(rows, settled.row);
      } catch (error) {
        logger.warn('payments.cancel_expire_failed', { payment_row_id: row.id, ...describeError(error) });
      }
    }

    const paid = rows.some(row => row.payment_status === PAID);
    return {
      notice: paid ? { refund_required: true, deposit_status: 'paid' } : {},
      depositRequired: true,
      depositStatus: paid ? 'paid' : rows.some(row => row.payment_status === REFUNDED) ? 'refunded' : 'none'
    };
  } catch (error) {
    if (isMissingColumnError(error)) reportMissingDepositFlag(error);
    else logDatabaseError('payments.cancel_check_failed', error, { appointment_id: appointmentId });
    return exempt;
  }
}

/**
 * Called by both admin status endpoints after a status change was stored. For appointments that need a deposit it
 * settles open checkouts on cancellation and emails the customer the decision (approved / declined / cancelled).
 * Returns extra response fields: {} or { refund_required, deposit_status }. It never undoes or blocks the change.
 * Appointments booked before deposits were switched on (exempt) get no email, exactly as before.
 */
async function handleAppointmentStatusChanged(appointment, { previousStatus, newStatus, depositCheck } = {}) {
  if (newStatus === 'Approved') {
    // depositPaid is only true for an appointment that needs a deposit and has a verified payment
    if (depositCheck && depositCheck.depositPaid) {
      queueDecisionEmail(appointment, { decision: 'approved', previousStatus, depositStatus: 'paid' });
    }
    return {};
  }

  if (newStatus !== 'Cancelled') return {};

  const { notice, depositRequired, depositStatus } = await settleCancelledAppointment(appointment);
  if (depositRequired) {
    queueDecisionEmail(appointment, { decision: 'cancelled', previousStatus, depositStatus });
  }
  return notice;
}

// ==================== WEBHOOK ====================

function acknowledged() {
  return { statusCode: 200, body: { received: true } };
}

function retryLater() {
  return { statusCode: 503, body: { received: false } };
}

async function findPaymentForSession(session) {
  const paymentRowId = session.metadata[CHECKOUT_METADATA_PAYMENT_ID];
  if (paymentRowId && PAYMENT_ROW_ID_PATTERN.test(paymentRowId)) {
    const { data, error } = await paymentsRepository.findById(paymentRowId);
    if (error && !isInvalidIdError(error)) throw error;
    if (data) return data;
  }

  const { data, error } = await paymentsRepository.findByCheckoutSessionId(session.id);
  if (error) throw error;
  return data || null;
}

// Why a paid checkout matched no payment row. PayMongo's own test events and checkouts made outside PetHub carry no
// PetHub metadata; PetHub metadata without a row here points at another deployment or database (compare
// supabase_project). Logs only provider and PetHub ids, never customer data.
function describeUnmatchedSession(session) {
  const referencedRowId = session.metadata[CHECKOUT_METADATA_PAYMENT_ID] || '';
  const hasPetHubMetadata = Boolean(referencedRowId || session.metadata[CHECKOUT_METADATA_APPOINTMENT_ID]);
  const validReference = PAYMENT_ROW_ID_PATTERN.test(referencedRowId);

  let reason = 'not_created_by_pethub';
  if (hasPetHubMetadata) reason = validReference ? 'payment_row_not_found' : 'invalid_pethub_reference';
  return {
    reason,
    checkout_session_id: session.id.slice(0, 64),
    pethub_metadata: hasPetHubMetadata,
    ...(reason === 'payment_row_not_found' ? { referenced_row_id: referencedRowId } : {}),
    supabase_project: getSupabaseProjectRef()
  };
}

async function processCheckoutPaid(event, context) {
  const session = paymongo.normalizeCheckoutSession(event.resource);
  if (!session) {
    logger.warn('payments.webhook_ignored', { ...context, reason: 'malformed_checkout_session' });
    return acknowledged();
  }

  const row = await findPaymentForSession(session);
  if (!row) {
    // Not a checkout created by this PetHub database: nothing is marked paid
    logger.warn('payments.webhook_unmatched', { ...context, ...describeUnmatchedSession(session) });
    return acknowledged();
  }

  const rowContext = { ...context, payment_row_id: row.id };
  if (row.payment_status === REFUNDED) {
    logger.info('payments.webhook_duplicate', rowContext);
    return acknowledged();
  }

  const evaluation = evaluateSessionPayment(session, row);
  if (evaluation.state === 'unpaid') {
    logger.warn('payments.webhook_ignored', { ...rowContext, reason: 'no_paid_payment' });
    return acknowledged();
  }
  if (evaluation.state === 'mismatch') {
    logger.error('payments.webhook_mismatch', { ...rowContext, reason: describeMismatch(evaluation.problems), problems: evaluation.problems });
    return acknowledged();
  }

  if (row.payment_status === PAID) {
    if (row.provider_payment_id === evaluation.payment.id) logger.info('payments.webhook_duplicate', rowContext);
    else logger.error('payments.webhook_conflicting_payment', rowContext);
    return acknowledged();
  }

  await recordPaid(row, evaluation.payment, { sessionId: session.id, source: 'webhook' });
  return acknowledged();
}

function isRecentEvent(event, now = Date.now()) {
  const createdAt = Date.parse(event.createdAt);
  return !Number.isFinite(createdAt) || now - createdAt < UNMATCHED_REFUND_RETRY_WINDOW_MS;
}

// payment.refunded / payment.refund.updated (PayMongo's webhook event list) carry the payment with its refunds;
// refund.succeeded (mentioned only in PayMongo's go-live checklist) carries a refund resource. Both are read, and
// nothing changes unless a succeeded refund for the full deposit is present.
async function processRefundEvent(event, context, resourceKind) {
  let providerPaymentId = '';
  let refunds = [];
  if (resourceKind === 'refund') {
    const refund = paymongo.normalizeRefund(event.resource);
    if (refund) {
      providerPaymentId = refund.paymentId;
      refunds = [refund];
    }
  } else {
    const payment = paymongo.normalizePayment(event.resource);
    if (payment) {
      providerPaymentId = payment.id;
      refunds = payment.refunds;
    }
  }

  if (!paymongo.isPaymentId(providerPaymentId)) {
    logger.warn('payments.webhook_ignored', { ...context, reason: 'malformed_refund' });
    return acknowledged();
  }

  const refundedCentavos = refunds
    .filter(refund => (
      refund.status === 'succeeded' &&
      refund.livemode !== true &&
      (!refund.currency || refund.currency === DEPOSIT_CURRENCY) &&
      (!refund.paymentId || refund.paymentId === providerPaymentId)
    ))
    .reduce((total, refund) => total + (refund.amount || 0), 0);

  const { data: row, error } = await paymentsRepository.findByProviderPaymentId(providerPaymentId);
  if (error) throw error;

  if (!row) {
    // The PayMongo payment id is stored when the payment is confirmed; a refund event that arrives first is retried
    const retry = isRecentEvent(event);
    logger.warn('payments.webhook_refund_unmatched', { ...context, reason: 'payment_not_recorded', retry });
    return retry ? retryLater() : acknowledged();
  }

  const rowContext = { ...context, payment_row_id: row.id };
  if (row.payment_status === REFUNDED) {
    logger.info('payments.webhook_duplicate', rowContext);
    return acknowledged();
  }
  if (refundedCentavos < DEPOSIT_AMOUNT_CENTAVOS) {
    logger.info('payments.refund_not_complete', { ...rowContext, refunded_centavos: refundedCentavos });
    return acknowledged();
  }
  if (row.payment_status !== PAID) {
    logger.warn('payments.webhook_ignored', { ...rowContext, reason: 'refund_for_unpaid_row' });
    return acknowledged();
  }

  await moveStatus(row, [PAID], REFUNDED, 'payments.refunded');
  await syncAppointmentPaymentStatus(row.appointment_id);
  return acknowledged();
}

/**
 * POST /payments/webhook (no PetHub login; mounted before express.json() so req.body is the raw Buffer)
 * 2xx = processed, duplicate or deliberately ignored; 400 = rejected; 5xx = PayMongo should retry.
 */
const handleWebhook = async (req) => {
  const webhookSecret = env.payments.paymongoWebhookSecret;
  if (!webhookSecret || !paymentsRepository.isConfigured()) {
    logger.error('payments.webhook_not_configured', {
      problems: getConfigurationProblems().filter(problem => problem === 'paymongo_webhook_secret_missing' || problem === 'supabase_service_key_missing')
    });
    return retryLater();
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  const signatureValid = Boolean(rawBody && rawBody.length > 0) && paymongo.verifyWebhookSignature({
    rawBody,
    signatureHeader: req.headers?.['paymongo-signature'],
    webhookSecret
  });
  if (!signatureValid) {
    logger.warn('payments.webhook_rejected', { reason: 'invalid_signature' });
    return { statusCode: 400, body: { received: false } };
  }

  let event = null;
  try {
    event = paymongo.parseWebhookEvent(JSON.parse(rawBody.toString('utf8')));
  } catch (error) {
    event = null;
  }
  if (!event) {
    logger.warn('payments.webhook_rejected', { reason: 'malformed_event' });
    return { statusCode: 400, body: { received: false } };
  }

  const context = { event_id: event.id.slice(0, 64), event_type: event.type.slice(0, 64) };
  if (event.livemode !== false) {
    logger.warn('payments.webhook_ignored', { ...context, reason: 'not_test_mode' });
    return acknowledged();
  }

  try {
    switch (event.type) {
      case 'checkout_session.payment.paid':
        return await processCheckoutPaid(event, context);
      case 'refund.succeeded':
        return await processRefundEvent(event, context, 'refund');
      case 'payment.refunded':
      case 'payment.refund.updated':
        return await processRefundEvent(event, context, 'payment');
      default:
        logger.info('payments.webhook_ignored', { ...context, reason: 'unhandled_type' });
        return acknowledged();
    }
  } catch (error) {
    // Not stored durably, so PayMongo should deliver it again. Database errors carry a code; anything else is a bug.
    if (isMissingColumnError(error)) reportMissingSchema('payments', error);
    const isDatabaseError = Boolean(error) && !(error instanceof paymongo.PayMongoError) &&
      Object.prototype.hasOwnProperty.call(error, 'code');
    logDatabaseError('payments.webhook_failed', error, { ...context, reason: isDatabaseError ? 'database_error' : 'processing_error' });
    return { statusCode: 500, body: { received: false } };
  }
};

// ==================== EXPIRY SWEEP ====================

let sweepRunning = false;

// Closes checkouts whose 30-minute window has passed (PayMongo sessions never expire on their own)
async function runExpirySweep(now = Date.now()) {
  if (sweepRunning || !getProviderClient()) return { checked: 0, failed: 0, receiptsSent: 0 };

  sweepRunning = true;
  let checked = 0;
  let failed = 0;
  let receiptsSent = 0;
  try {
    const { data, error } = await paymentsRepository.listOverduePending(new Date(now).toISOString(), PAYMENT_EXPIRY_SWEEP_BATCH_SIZE);
    if (error) {
      if (isMissingColumnError(error)) reportMissingSchema('payments', error);
      else logDatabaseError('payments.sweep_failed', error);
      return { checked, failed, receiptsSent };
    }

    for (const row of data || []) {
      checked += 1;
      try {
        await settlePendingPayment(row, { now });
      } catch (error) {
        failed += 1;
        logger.warn('payments.sweep_item_failed', { payment_row_id: row.id, ...describeError(error) });
      }
    }

    // Confirmation emails that could not be sent earlier
    try {
      receiptsSent = await retryReceiptEmails(now);
    } catch (error) {
      logger.warn('payments.receipt_email_retry_failed', describeError(error));
    }
  } finally {
    sweepRunning = false;
  }

  if (checked > 0 || receiptsSent > 0) logger.info('payments.sweep_completed', { checked, failed, receipts_sent: receiptsSent });
  return { checked, failed, receiptsSent };
}

// Called once by server.js after the server starts; the global marker stops a second timer if this module is loaded again
function startExpirySweep() {
  if (globalThis[SWEEP_GLOBAL_KEY] || !getProviderClient()) return false;

  const run = () => {
    runExpirySweep().catch(error => logger.warn('payments.sweep_failed', describeError(error)));
  };
  const firstRun = setTimeout(run, PAYMENT_EXPIRY_SWEEP_FIRST_RUN_MS);
  const interval = setInterval(run, PAYMENT_EXPIRY_SWEEP_INTERVAL_MS);
  firstRun.unref();
  interval.unref();
  globalThis[SWEEP_GLOBAL_KEY] = { firstRun, interval };

  logger.info('payments.sweep_started', { interval_minutes: PAYMENT_EXPIRY_SWEEP_INTERVAL_MS / 60000 });
  return true;
}

function stopExpirySweep() {
  const timers = globalThis[SWEEP_GLOBAL_KEY];
  if (!timers) return;
  clearTimeout(timers.firstRun);
  clearInterval(timers.interval);
  delete globalThis[SWEEP_GLOBAL_KEY];
}

module.exports = {
  isDepositPolicyEnabled,
  isCheckoutAvailable,
  isMissingColumnError,
  reportMissingSchema,
  getNewAppointmentDepositFields,
  getNewAppointmentDepositNotice,
  getDepositPolicy,
  attachDepositSummaries,
  createCheckout,
  getAppointmentPaymentStatus,
  handleWebhook,
  checkDepositForApproval,
  addRefundRequiredToConflict,
  handleAppointmentStatusChanged,
  runExpirySweep,
  startExpirySweep,
  stopExpirySweep,
  waitForBackgroundTasks,
  clearPaymentMethodsCache
};
