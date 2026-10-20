// ==================== APPOINTMENT NOTIFICATIONS ====================
// Emails the customer when the clinic approves or cancels an appointment (called by both status endpoints after the
// change is stored). Emails go out in the background, so a slow or failing Brevo request never delays the response
// and never changes or undoes the appointment status. Status changes are conditional updates, so each change is
// stored, and therefore emailed, only once.

const env = require('../config/env');
const logger = require('../utils/logger');
const { sendEmail } = require('../utils/email');
const usersRepository = require('../repositories/usersRepository');
const { buildAppointmentDecisionEmail } = require('../templates/email/appointmentDecisionEmail');
const { APPOINTMENTS_PAGE_PATH } = require('../constants/email');

// New appointment status -> email sent ('Completed' sends nothing)
const DECISIONS = Object.freeze({
  Approved: 'approved',
  Cancelled: 'cancelled'
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

// Link to My Appointments from FRONTEND_URL (https, or http on localhost); left out of the email when unset or invalid
function getAppointmentsPageUrl() {
  let url;
  try {
    url = new URL(String(env.frontendUrl || '').trim());
  } catch (error) {
    return '';
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) return '';
  return new URL(APPOINTMENTS_PAGE_PATH, url.origin).toString();
}

async function loadCustomer(userId) {
  const { data, error } = await usersRepository.findStatusById(userId);
  if (error) throw error;
  const user = Array.isArray(data) ? data[0] : data;
  return user && user.email ? user : null;
}

// decision: 'approved' | 'cancelled'
async function sendAppointmentDecision(appointment, { decision, previousStatus }) {
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
    appointmentsUrl: getAppointmentsPageUrl()
  });
  await sendEmail({ to: customer.email, ...email });
  logger.info('appointments.decision_email_sent', context);
  return 'sent';
}

/**
 * Called by PUT /admin/dashboard/appointment-status and PUT /appointments/updateStatus after a status change was
 * stored. Approving or cancelling emails the customer; other changes send nothing. Never throws.
 */
function notifyAppointmentStatusChanged(appointment, { previousStatus, newStatus } = {}) {
  const decision = DECISIONS[newStatus];
  if (!decision || !appointment) return;

  runInBackground('appointments.decision_email_failed', { appointment_id: appointment.id, decision }, () => (
    sendAppointmentDecision(appointment, { decision, previousStatus })
  ));
}

module.exports = {
  notifyAppointmentStatusChanged,
  waitForBackgroundTasks
};
