// ==================== CLINIC RESCHEDULING ====================
// PUT /admin/appointments/:id/schedule { appointment_date, appointment_time, expected_status, expected_date, expected_time }
// Moves ONE Pending or Approved appointment (one pet, also inside a multi-pet booking) to a new start time that is free.
// The status stays as it was. The expected_* values are what the admin's screen showed: if another admin changed the
// appointment meanwhile, nothing changes (409). The slot is checked under the same per-date locks as bookings
// (reschedule_appointment_if_available). The owner is emailed the new time; a failed email never undoes the change.

const appointmentsRepository = require('../repositories/appointmentsRepository');
const { logAdminActivity } = require('../utils/activityLogger');
const { isUuid, trimValue } = require('../validators/commonValidator');
const {
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  getAppointmentDateTimeValidationError
} = require('../validators/appointmentsValidator');
const { APPOINTMENT_STATUS_CHANGED_MESSAGE, SCHEDULE_CONFLICT_MESSAGE } = require('../constants/appointments');
const appointmentNotificationsService = require('./appointmentNotificationsService');

function refusal(statusCode, error, extra = {}) {
  return { statusCode, body: { success: false, error, ...extra } };
}

const rescheduleAppointment = async (req) => {
  const appointmentId = trimValue(req.params?.id);
  const adminId = trimValue(req.authUserId);
  const body = req.body || {};
  if (!isUuid(appointmentId)) return refusal(404, 'Appointment not found.');

  const newDate = normalizeAppointmentDate(body.appointment_date);
  const newTime = normalizeAppointmentTime(body.appointment_time);
  const dateTimeError = getAppointmentDateTimeValidationError(body.appointment_date, body.appointment_time);
  if (!newDate || !newTime || dateTimeError) {
    return refusal(400, dateTimeError || 'Enter a valid new date and time.', { field: !newDate ? 'appointment_date' : 'appointment_time' });
  }
  const expectedStatus = trimValue(body.expected_status);
  const expectedDate = normalizeAppointmentDate(body.expected_date);
  const expectedTime = normalizeAppointmentTime(body.expected_time);
  if (!['Pending', 'Approved'].includes(expectedStatus) || !expectedDate || !expectedTime) {
    return refusal(400, 'Reload the appointment list before rescheduling.');
  }

  try {
    const { data: existing, error: findError } = await appointmentsRepository.findById(appointmentId);
    if (findError) throw findError;
    if (!existing) return refusal(404, 'Appointment not found.');
    if (!['Pending', 'Approved'].includes(existing.status)) {
      return refusal(409, `Only Pending or Approved appointments can be rescheduled; this one is ${existing.status}.`);
    }
    if (String(existing.appointment_date).slice(0, 10) === newDate && String(existing.appointment_time).slice(0, 5) === newTime.slice(0, 5)) {
      return refusal(400, 'Choose a different date or time to reschedule.');
    }

    const { data, error } = await appointmentsRepository.rescheduleIfAvailable({
      appointmentId, newDate, newTime, handledBy: adminId, expectedStatus, expectedDate, expectedTime
    });
    if (error) {
      if (['PGRST202', '42883'].includes(String(error.code || ''))) {
        return refusal(503, 'Rescheduling is unavailable until the clinic finishes an update.');
      }
      if (String(error.code || '') === '22023') return refusal(400, 'The reschedule request is invalid. Reload the list and try again.');
      throw error;
    }
    if (data?.outcome === 'not_found') return refusal(404, 'Appointment not found.');
    if (data?.outcome === 'stale') return refusal(409, APPOINTMENT_STATUS_CHANGED_MESSAGE);
    if (data?.outcome === 'conflict') {
      const { getScheduleConflict } = require('./appointmentsService');
      const conflict = await getScheduleConflict(newDate, newTime, existing.estimated_duration_minutes, appointmentId);
      return refusal(409, `${SCHEDULE_CONFLICT_MESSAGE} Another appointment overlaps that time.`, { suggested_time: conflict.suggested_time || null });
    }
    if (data?.outcome === 'past_end_of_day') return refusal(400, 'The appointment would run past midnight. Choose an earlier time.');
    if (data?.outcome === 'invalid_duration') return refusal(409, 'This appointment has no valid duration recorded, so it cannot be moved online. Contact the owner to book again.');
    if (data?.outcome !== 'updated') {
      console.error('Reschedule returned an unexpected result.');
      return refusal(500, 'Could not reschedule this appointment.');
    }

    const { data: updated, error: reloadError } = await appointmentsRepository.findById(appointmentId);
    if (reloadError || !updated) throw reloadError || new Error('Rescheduled appointment could not be loaded');

    await logAdminActivity(adminId, 'appointments', appointmentId,
      `Rescheduled appointment from ${String(existing.appointment_date).slice(0, 10)} ${String(existing.appointment_time).slice(0, 5)} to ${newDate} ${newTime.slice(0, 5)}`);
    appointmentNotificationsService.notifyAppointmentRescheduled(updated, {
      previousDate: existing.appointment_date,
      previousTime: existing.appointment_time
    });

    return { statusCode: 200, body: { success: true, appointment: updated } };
  } catch (error) {
    console.error('Reschedule error:', { code: error?.code || 'unknown' });
    return refusal(500, 'Could not reschedule this appointment.');
  }
};

module.exports = {
  rescheduleAppointment
};
