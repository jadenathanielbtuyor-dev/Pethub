// ==================== APPOINTMENT NOTIFICATIONS ====================
// Emails the customer when the clinic approves or cancels an appointment, and confirms an owner's own cancellation.
// Every email is recorded in email_logs (services/emailDeliveryService.js), which allows one email of each type per
// appointment, so a retried request never sends a second copy. A failed email never changes or undoes the status.
// - Clinic decisions (approve / cancel) are sent in the background, so the admin's response is not delayed.
// - The owner's cancellation confirmation is awaited (Brevo requests time out after 15 s), so the owner is told whether
//   it was sent; if it failed, the clinic sees it in Appointment Management and can send it again.

const env = require('../config/env');
const logger = require('../utils/logger');
const usersRepository = require('../repositories/usersRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const { buildAppointmentDecisionEmail, buildAppointmentRescheduledEmail, buildOwnerCancellationEmail } = require('../templates/email/appointmentDecisionEmail');
const { APPOINTMENTS_PAGE_PATH, CONTACT_PAGE_PATH } = require('../constants/email');
const { EMAIL_TYPES, sendLoggedEmail } = require('./emailDeliveryService');
const { getClinicContactDetails } = require('./clinicSettingsService');

// New appointment status -> email type ('Completed' sends nothing)
const DECISION_EMAIL_TYPES = Object.freeze({
  Approved: EMAIL_TYPES.appointmentApproved,
  Cancelled: EMAIL_TYPES.appointmentCancelledByClinic
});

const backgroundTasks = new Set();

function describeError(error) {
  return {
    code: String(error?.code || error?.name || 'unknown').slice(0, 64),
    status: Number.isInteger(error?.status) ? error.status : undefined
  };
}

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

// A frontend page from FRONTEND_URL (https, or http on localhost); left out of the email when unset or invalid
function getFrontendPageUrl(pagePath) {
  let url;
  try {
    url = new URL(String(env.frontendUrl || '').trim());
  } catch (error) {
    return '';
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) return '';
  return new URL(pagePath, url.origin).toString();
}

async function loadCustomer(userId) {
  const { data, error } = await usersRepository.findStatusById(userId);
  if (error) throw error;
  const user = Array.isArray(data) ? data[0] : data;
  return user && user.email ? user : null;
}

async function getEmailLinks() {
  return {
    appointmentsUrl: getFrontendPageUrl(APPOINTMENTS_PAGE_PATH),
    contactPageUrl: getFrontendPageUrl(CONTACT_PAGE_PATH),
    clinic: await getClinicContactDetails()
  };
}

// The other pets' appointments of a multi-pet booking, so the email names every pet (empty for single bookings)
async function loadGroupPets(appointment) {
  if (!appointment?.group_id) return [];
  const { data, error } = await appointmentsRepository.listByGroupIds([appointment.group_id]);
  if (error) {
    logger.warn('appointments.group_email_context_unavailable', { appointment_id: appointment.id, code: error.code || 'unknown' });
    return [];
  }
  return data || [];
}

async function buildDecisionEmail(appointment, customer, { decision, previousStatus }) {
  return buildAppointmentDecisionEmail({
    name: customer.fullname, appointment, decision, previousStatus, groupPets: await loadGroupPets(appointment), ...(await getEmailLinks())
  });
}

function rescheduledEmailType(appointment) {
  return `${EMAIL_TYPES.appointmentRescheduled}:${String(appointment.appointment_date).slice(0, 10)}T${String(appointment.appointment_time).slice(0, 5)}`;
}

async function buildRescheduledEmail(appointment, customer, { previousDate = null, previousTime = null } = {}) {
  return buildAppointmentRescheduledEmail({
    name: customer.fullname, appointment, previousDate, previousTime, groupPets: await loadGroupPets(appointment), ...(await getEmailLinks())
  });
}

/**
 * Called by PUT /admin/appointments/:id/schedule after the new time was stored: emails the owner in the background.
 * The log type includes the new date and time, so moving it again later sends a new email, a retry does not. Never throws.
 */
function notifyAppointmentRescheduled(appointment, { previousDate, previousTime } = {}) {
  if (!appointment) return;
  runInBackground('appointments.reschedule_email_failed', { appointment_id: appointment.id }, async () => {
    const customer = await loadCustomer(appointment.user_id);
    if (!customer) {
      logger.warn('appointments.reschedule_email_skipped', { appointment_id: appointment.id, reason: 'no_customer_email' });
      return 'skipped';
    }
    const email = await buildRescheduledEmail(appointment, customer, { previousDate, previousTime });
    const result = await sendLoggedEmail({ type: rescheduledEmailType(appointment), to: customer.email, email, userId: customer.id, appointmentId: appointment.id });
    return result.status;
  });
}

async function buildOwnerEmail(appointment, customer) {
  return buildOwnerCancellationEmail({ name: customer.fullname, appointment, ...(await getEmailLinks()) });
}

async function sendAppointmentDecision(appointment, { newStatus, previousStatus }) {
  const type = DECISION_EMAIL_TYPES[newStatus];
  const customer = await loadCustomer(appointment.user_id);
  if (!customer) {
    logger.warn('appointments.decision_email_skipped', { appointment_id: appointment.id, email_type: type, reason: 'no_customer_email' });
    return 'skipped';
  }
  const email = await buildDecisionEmail(appointment, customer, { decision: newStatus === 'Approved' ? 'approved' : 'cancelled', previousStatus });
  const result = await sendLoggedEmail({ type, to: customer.email, email, userId: customer.id, appointmentId: appointment.id });
  return result.status;
}

/**
 * Called by PUT /admin/dashboard/appointment-status after a status change was stored. Approving or cancelling emails
 * the customer in the background; other changes send nothing. Never throws.
 */
function notifyAppointmentStatusChanged(appointment, { previousStatus, newStatus } = {}) {
  if (!DECISION_EMAIL_TYPES[newStatus] || !appointment) return;
  runInBackground('appointments.decision_email_failed', { appointment_id: appointment.id, new_status: newStatus }, () => (
    sendAppointmentDecision(appointment, { newStatus, previousStatus })
  ));
}

/**
 * Called by POST /appointments/cancel/:id once the cancellation is stored (only by the request that changed the row).
 * Returns 'sent' | 'failed' | 'skipped' (no email address on the account) | 'duplicate' (already sent). Never throws.
 */
async function confirmOwnerCancellation(appointment) {
  try {
    const customer = await loadCustomer(appointment.user_id);
    if (!customer) {
      logger.warn('appointments.owner_cancellation_email_skipped', { appointment_id: appointment.id, reason: 'no_customer_email' });
      return 'skipped';
    }
    const email = await buildOwnerEmail(appointment, customer);
    const result = await sendLoggedEmail({
      type: EMAIL_TYPES.appointmentCancelledByOwner,
      to: customer.email,
      email,
      userId: customer.id,
      appointmentId: appointment.id
    });
    return result.status;
  } catch (error) {
    logger.error('appointments.owner_cancellation_email_failed', { appointment_id: appointment?.id, ...describeError(error) });
    return 'failed';
  }
}

// For an admin retry of a Failed appointment email (services/emailRetryService.js): the same email, rebuilt from the
// appointment as it is now, or null when it no longer applies (e.g. an approval email for an appointment since cancelled)
async function buildAppointmentEmailForRetry(log) {
  if (!log?.appointment_id) return null;
  const { data: appointment, error } = await appointmentsRepository.findById(log.appointment_id);
  if (error) throw error;
  if (!appointment) return null;

  const customer = await loadCustomer(appointment.user_id);
  if (!customer) return null;

  if (log.email_type === EMAIL_TYPES.appointmentApproved) {
    if (!['Approved', 'Completed'].includes(appointment.status)) return null;
    return { to: customer.email, email: await buildDecisionEmail(appointment, customer, { decision: 'approved' }) };
  }
  if (log.email_type === EMAIL_TYPES.appointmentCancelledByClinic) {
    if (appointment.status !== 'Cancelled') return null;
    return { to: customer.email, email: await buildDecisionEmail(appointment, customer, { decision: 'cancelled' }) };
  }
  if (log.email_type === EMAIL_TYPES.appointmentCancelledByOwner) {
    if (appointment.status !== 'Cancelled') return null;
    return { to: customer.email, email: await buildOwnerEmail(appointment, customer) };
  }
  // A reschedule email still applies only while the appointment is open and at the time the email announced
  if (String(log.email_type).startsWith(`${EMAIL_TYPES.appointmentRescheduled}:`)) {
    if (!['Pending', 'Approved'].includes(appointment.status) || rescheduledEmailType(appointment) !== log.email_type) return null;
    return { to: customer.email, email: await buildRescheduledEmail(appointment, customer) };
  }
  return null;
}

module.exports = {
  notifyAppointmentStatusChanged,
  notifyAppointmentRescheduled,
  confirmOwnerCancellation,
  buildAppointmentEmailForRetry,
  getFrontendPageUrl,
  waitForBackgroundTasks
};
