const usersRepository = require('../repositories/usersRepository');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const { isUserVerified, isAdminVerified } = require('../utils/accountVerification');
const { logAdminActivity } = require('../utils/activityLogger');
const { logUserActivity } = require('../utils/activityLogger');
const { runExclusive } = require('../utils/keyedLock');
const appointmentNotificationsService = require('./appointmentNotificationsService');
const {
  hasValue
} = require('../validators/commonValidator');
const {
  INVALID_APPOINTMENT_DATE_MESSAGE,
  APPOINTMENT_STATUS_CHANGED_MESSAGE,
  APPOINTMENT_CANCELLATION_CUTOFF_HOURS,
  APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE
} = require('../constants/appointments');
const { SERVICE_SPECIES } = require('../constants/services');
const { getService, isServiceAvailableForSpecies, describeSpecies, listServicesForClient } = require('../utils/serviceCatalog');
const {
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  getAppointmentTimeRange,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  validateCreateAppointment,
  validateUserAppointmentsQuery,
  validateUpdateStatusRequest,
  getAppointmentStartTimestamp,
  validateOwnerCancellationRequest
} = require('../validators/appointmentsValidator');

async function getUserPetById(userId, petId) {
  if (!hasValue(userId) || !hasValue(petId)) return null;

  const { data, error } = await petsRepository.findUserPetById(String(userId), String(petId));

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// The customer's Pending appointment for the same pet, service, date and time, if there is one
async function findSamePendingAppointment(appointmentRecord) {
  const { data, error } = await appointmentsRepository.listByUserId(appointmentRecord.user_id);
  if (error) throw error;

  return (data || []).find(appointment => (
    appointment.status === 'Pending' &&
    String(appointment.pet_id) === appointmentRecord.pet_id &&
    appointment.service_type === appointmentRecord.service_type &&
    normalizeAppointmentDate(appointment.appointment_date) === appointmentRecord.appointment_date &&
    normalizeAppointmentTime(appointment.appointment_time) === appointmentRecord.appointment_time
  )) || null;
}

function appointmentRangesOverlap(first, second) {
  if (!first || !second || first.date !== second.date) return false;
  return first.startMs < second.endMs && second.startMs < first.endMs;
}

function formatSuggestedAppointmentTime(timeMs) {
  const totalMinutes = Math.ceil(timeMs / 60000);
  const minutesInDay = 24 * 60;
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0 || totalMinutes >= minutesInDay) {
    return null;
  }

  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getActiveAppointmentRanges(appointments, excludedAppointmentId = '') {
  const excludedId = String(excludedAppointmentId || '').trim();
  return (appointments || [])
    .filter(appointment => {
      const appointmentId = String(appointment?.id || '').trim();
      const status = String(appointment?.status || '').trim().toLowerCase();
      return (!excludedId || appointmentId !== excludedId) && OCCUPIED_APPOINTMENT_STATUSES.has(status);
    })
    .map(appointment => {
      const range = getAppointmentTimeRange(
        appointment.appointment_date,
        appointment.appointment_time,
        appointment.estimated_duration_minutes
      );

      if (!range) {
        console.warn(`Skipping invalid appointment schedule during conflict check: ${appointment.id || 'unknown appointment'}`);
        return null;
      }

      return range;
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
}

function getSuggestedTimeAfterConflict(requestedRange, existingRanges) {
  const conflictingRange = existingRanges.find(existingRange => appointmentRangesOverlap(requestedRange, existingRange));
  if (!conflictingRange) {
    return { hasConflict: false, suggestedTime: null };
  }

  const requestedDurationMs = requestedRange.endMs - requestedRange.startMs;
  let candidateStartMs = conflictingRange.endMs;
  let candidateEndMs = candidateStartMs + requestedDurationMs;

  for (const existingRange of existingRanges) {
    if (existingRange.endMs <= candidateStartMs) continue;
    if (candidateEndMs <= existingRange.startMs) break;

    candidateStartMs = Math.max(candidateStartMs, existingRange.endMs);
    candidateEndMs = candidateStartMs + requestedDurationMs;
  }

  return {
    hasConflict: true,
    suggestedTime: formatSuggestedAppointmentTime(candidateStartMs)
  };
}

async function getScheduleConflict(appointmentDate, appointmentTime, estimatedDurationMinutes, excludedAppointmentId = '') {
  const requestedRange = getAppointmentTimeRange(appointmentDate, appointmentTime, estimatedDurationMinutes);
  if (!requestedRange) return { hasConflict: false, error: '' };

  const { data: appointments, error } = await appointmentsRepository.listScheduleByDate(requestedRange.date);

  if (error) {
    throw error;
  }

  const existingRanges = getActiveAppointmentRanges(appointments, excludedAppointmentId);
  const conflict = getSuggestedTimeAfterConflict(requestedRange, existingRanges);
  if (!conflict.hasConflict) {
    return { hasConflict: false, error: '' };
  }

  return {
    hasConflict: true,
    error: SCHEDULE_CONFLICT_MESSAGE,
    suggested_time: conflict.suggestedTime
  };
}

async function attachHandledByNames(appointments) {
  const list = Array.isArray(appointments) ? appointments : [];
  const handlerIds = [...new Set(list.map(apt => apt && apt.handled_by).filter(Boolean).map(String))];

  if (handlerIds.length === 0) {
    return list.map(apt => ({ ...apt, handled_by_name: null }));
  }

  const { data: admins, error } = await usersRepository.listNamesByIds(handlerIds);

  if (error) {
    console.warn('Unable to load appointment handler names:', error);
    return list.map(apt => ({ ...apt, handled_by_name: null }));
  }

  const adminMap = (admins || []).reduce((map, admin) => {
    if (admin && admin.id != null) {
      map[String(admin.id)] = admin.fullname || null;
    }
    return map;
  }, {});

  return list.map(apt => ({
    ...apt,
    handled_by_name: apt.handled_by ? (adminMap[String(apt.handled_by)] || null) : null
  }));
}

/**
 * Create a new appointment
 */
const createAppointment = async (req) => {
  try {
    const validation = validateCreateAppointment(req.body);
    if (validation.error) return validation.error;

    const {
      normalizedUserId,
      normalizedPetId,
      serviceType,
      estimatedDurationMinutes,
      normalizedAppointmentDate,
      normalizedAppointmentTime
    } = validation;

    const verified = await isUserVerified(normalizedUserId);
    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub appointments.' } };
    }

    const pet = await getUserPetById(normalizedUserId, normalizedPetId);
    if (!pet) {
      return { statusCode: 404, body: { error: 'Selected pet was not found for this user.' } };
    }

    const petName = String(pet.name || '').trim();
    if (!petName) {
      return { statusCode: 400, body: { error: 'Selected pet does not have a valid name.' } };
    }

    // Checked here, not only by hiding options on the booking page
    if (!isServiceAvailableForSpecies(serviceType, pet.species)) {
      return { statusCode: 400, body: { error: `${serviceType} is offered for ${describeSpecies(getService(serviceType).species)} only.` } };
    }

    const conflict = await getScheduleConflict(
      normalizedAppointmentDate,
      normalizedAppointmentTime,
      estimatedDurationMinutes
    );
    if (conflict.hasConflict) {
      return { statusCode: 400, body: {
        error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
        suggested_time: conflict.suggested_time || null
      } };
    }

    const appointmentRecord = {
      user_id: normalizedUserId,
      pet_id: String(pet.id),
      pet_name: petName,
      service_type: serviceType,
      estimated_duration_minutes: estimatedDurationMinutes,
      appointment_date: normalizedAppointmentDate,
      appointment_time: normalizedAppointmentTime,
      status: 'Pending'
    };

    // The same booking can arrive more than once (a double click, a second tab, a refresh after submitting): if the
    // customer already has this exact Pending appointment, it is returned instead of creating a duplicate
    const insertAppointment = async () => {
      const existing = await findSamePendingAppointment(appointmentRecord);
      if (existing) return { existing };
      return appointmentsRepository.createAppointment(appointmentRecord);
    };

    // Copies that arrive at the same moment run one at a time per customer, so a copy finds the first booking
    // instead of creating a second one
    const inserted = await runExclusive(`booking:${normalizedUserId}`, insertAppointment);

    if (inserted.existing) {
      return { statusCode: 200, body: { success: true, appointment: inserted.existing, already_booked: true } };
    }

    const { data, error } = inserted;

    if (error) {
      console.error('Error creating appointment:', error);
      return { statusCode: 500, body: { error: 'Failed to create appointment' } };
    }

    return { statusCode: 201, body: { success: true, appointment: data[0] } };
  } catch (error) {
    console.error('Create appointment error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * The clinic's services for the booking page: name, category, description, species, and the confirmed duration
 * (null, with bookable false, until the clinic confirms it)
 */
const listServices = async () => ({
  statusCode: 200,
  body: { success: true, services: listServicesForClient(), species: [...SERVICE_SPECIES] }
});

/**
 * Get all appointments for a specific user
 */
const getUserAppointments = async (req) => {
  try {
    const validation = validateUserAppointmentsQuery(req.query);
    if (validation.error) return validation.error;

    const { normalizedUserId } = validation;

    const verified = await isUserVerified(normalizedUserId);
    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub appointments.' } };
    }

    const { data: appointments, error } = await appointmentsRepository.listByUserId(normalizedUserId);

    if (error) {
      console.error('Error fetching user appointments:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch appointments' } };
    }

    const appointmentsWithHandlers = await attachHandledByNames(appointments || []);
    return { statusCode: 200, body: { success: true, appointments: appointmentsWithHandlers } };
  } catch (error) {
    console.error('Get user appointments error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

// Owner cancellation is authenticated through requireAuth and scoped to the token owner. The server checks the
// appointment against clinic-local date/time and then calls one database function that rechecks owner, status and the
// exact two-hour cutoff against PostgreSQL's clock in the same conditional UPDATE.
const cancelOwnAppointment = async (req) => {
  const validation = validateOwnerCancellationRequest(req.params, req.authUserId);
  if (validation.error) return validation.error;
  const { normalizedAppointmentId, normalizedUserId } = validation;
  try {
    const verified = await isUserVerified(normalizedUserId);
    if (!verified) return { statusCode: 403, body: { error: 'Please verify your email before changing appointments.' } };

    const { data: appointment, error } = await appointmentsRepository.findByIdForUser(normalizedAppointmentId, normalizedUserId);
    if (error) throw error;
    if (!appointment) return { statusCode: 404, body: { error: 'Appointment not found.' } };
    if (appointment.status === 'Cancelled') {
      return { statusCode: 200, body: { success: true, already_cancelled: true, appointment } };
    }
    if (!['Pending', 'Approved'].includes(appointment.status)) {
      return { statusCode: 409, body: { error: `A ${appointment.status || 'unknown'} appointment cannot be cancelled by its owner.` } };
    }

    const startMs = getAppointmentStartTimestamp(appointment.appointment_date, appointment.appointment_time);
    if (!Number.isFinite(startMs)) {
      return { statusCode: 409, body: { error: 'This appointment has an invalid scheduled date or time. Contact the clinic to change it.' } };
    }
    const cutoffMs = APPOINTMENT_CANCELLATION_CUTOFF_HOURS * 60 * 60 * 1000;
    if (startMs - Date.now() < cutoffMs) {
      return { statusCode: 409, body: {
        error: APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE,
        code: 'APPOINTMENT_CANCELLATION_CUTOFF'
      } };
    }

    const { data: cancelled, error: updateError } = await appointmentsRepository.cancelByUser(
      normalizedAppointmentId, normalizedUserId, appointment.status
    );
    if (updateError) {
      if (['PGRST202', '42883'].includes(updateError.code)) {
        return { statusCode: 503, body: {
          error: 'Secure cancellation is unavailable until the reviewed database rule is installed.',
          code: 'CANCELLATION_DATABASE_RULE_UNAVAILABLE'
        } };
      }
      throw updateError;
    }

    if (cancelled !== true) {
      const { data: latest, error: latestError } = await appointmentsRepository.findByIdForUser(normalizedAppointmentId, normalizedUserId);
      if (latestError) throw latestError;
      if (!latest) return { statusCode: 404, body: { error: 'Appointment not found.' } };
      if (latest.status === 'Cancelled') return { statusCode: 200, body: { success: true, already_cancelled: true, appointment: latest } };
      if (latest.status !== appointment.status) {
        return { statusCode: 409, body: { error: APPOINTMENT_STATUS_CHANGED_MESSAGE } };
      }
      const latestStart = getAppointmentStartTimestamp(latest.appointment_date, latest.appointment_time);
      if (!Number.isFinite(latestStart)) {
        return { statusCode: 409, body: { error: 'This appointment has an invalid scheduled date or time. Contact the clinic to change it.' } };
      }
      if (latestStart - Date.now() < cutoffMs) {
        return { statusCode: 409, body: {
          error: APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE,
          code: 'APPOINTMENT_CANCELLATION_CUTOFF'
        } };
      }
      return { statusCode: 409, body: { error: APPOINTMENT_STATUS_CHANGED_MESSAGE } };
    }

    const { data: refreshedAppointment, error: refreshError } = await appointmentsRepository.findByIdForUser(normalizedAppointmentId, normalizedUserId);
    if (refreshError) console.error('Unable to reload cancelled appointment:', { code: refreshError.code || 'unknown' });
    const cancelledAppointment = refreshedAppointment || { ...appointment, status: 'Cancelled' };
    await logUserActivity(normalizedUserId, 'appointment_cancelled', `Cancelled appointment ${normalizedAppointmentId}`);
    appointmentNotificationsService.notifyOwnerCancelledAppointment(cancelledAppointment);
    return { statusCode: 200, body: { success: true, message: 'Appointment cancelled.', appointment: cancelledAppointment } };
  } catch (error) {
    console.error('Owner cancellation error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { error: 'Could not cancel this appointment. Please try again.' } };
  }
};

/**
 * Get the booked schedule (used by the booking page to show slot availability).
 * Returns schedule fields only so other users' ids, pets, and handlers are not exposed;
 * admins use /admin/dashboard/appointments for full records.
 */
const getAllAppointments = async (req) => {
  try {
    const hasDateFilter = hasValue(req.query?.appointment_date);
    const appointmentDate = hasDateFilter ? normalizeAppointmentDate(req.query.appointment_date) : '';
    if (hasDateFilter && !appointmentDate) {
      return { statusCode: 400, body: { error: INVALID_APPOINTMENT_DATE_MESSAGE } };
    }

    const { data: appointments, error } = appointmentDate
      ? await appointmentsRepository.listScheduleByDate(appointmentDate)
      : await appointmentsRepository.listSchedule();

    if (error) {
      console.error('Error fetching all appointments:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch appointments' } };
    }

    const schedule = (appointments || []).map(appointment => ({
      appointment_date: appointment.appointment_date,
      appointment_time: appointment.appointment_time,
      estimated_duration_minutes: appointment.estimated_duration_minutes,
      status: appointment.status
    }));
    return { statusCode: 200, body: { success: true, appointments: schedule } };
  } catch (error) {
    console.error('Get all appointments error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Update appointment status (admin only)
 */
const updateStatus = async (req) => {
  try {
    const validation = validateUpdateStatusRequest(req.body, req.query, req.headers);
    if (validation.error) return validation.error;

    const { normalizedAppointmentId, normalizedStatus, normalizedAdminId } = validation;

    const adminVerified = await isAdminVerified(normalizedAdminId);
    if (!adminVerified) {
      return { statusCode: 403, body: { error: 'Admin access denied' } };
    }

    const { data: existingAppointment, error: existingError } = await appointmentsRepository.findById(normalizedAppointmentId);

    if (existingError) {
      console.error('Error loading appointment:', existingError);
      return { statusCode: 500, body: { error: 'Failed to load appointment' } };
    }

    if (!existingAppointment) {
      return { statusCode: 404, body: { error: 'Appointment not found' } };
    }

    const currentStatus = existingAppointment.status;
    const allowedTransitions = {
      Pending: ['Approved', 'Cancelled'],
      Approved: ['Completed', 'Cancelled'],
      Completed: [],
      Cancelled: []
    };

    if (currentStatus === normalizedStatus) {
      return { statusCode: 200, body: { success: true, message: 'Status updated', appointment: existingAppointment } };
    }

    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(normalizedStatus)) {
      return { statusCode: 400, body: {
        error: `Cannot change appointment from ${currentStatus || 'unknown'} to ${normalizedStatus}.`
      } };
    }

    const applyStatus = async () => {
      if (normalizedStatus === 'Approved') {
        const conflict = await getScheduleConflict(
          existingAppointment.appointment_date,
          existingAppointment.appointment_time,
          existingAppointment.estimated_duration_minutes,
          normalizedAppointmentId
        );

        if (conflict.hasConflict) {
          return { refused: { statusCode: 409, body: {
            error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
            suggested_time: conflict.suggested_time || null
          } } };
        }
      }

      return appointmentsRepository.updateStatus(normalizedAppointmentId, normalizedStatus, normalizedAdminId, currentStatus);
    };

    // Approvals on the same date run one at a time (same key as adminService.updateAppointmentStatus), so two admins
    // approving overlapping appointments at once cannot both pass the schedule check
    const outcome = normalizedStatus === 'Approved'
      ? await runExclusive(`schedule:${normalizeAppointmentDate(existingAppointment.appointment_date)}`, applyStatus)
      : await applyStatus();
    if (outcome.refused) return outcome.refused;

    const { data, error } = outcome;

    if (error) {
      console.error('Error updating appointment:', error);
      return { statusCode: 500, body: { error: 'Failed to update appointment' } };
    }

    if (!data || data.length === 0) {
      // The update only applies while the status is still currentStatus; tell apart "changed meanwhile" and "gone"
      const { data: latest } = await appointmentsRepository.findStatusById(normalizedAppointmentId);
      return latest
        ? { statusCode: 409, body: { error: APPOINTMENT_STATUS_CHANGED_MESSAGE } }
        : { statusCode: 404, body: { error: 'Appointment not found' } };
    }

    await logAdminActivity(normalizedAdminId, 'appointments', normalizedAppointmentId, `Updated appointment status to ${normalizedStatus}`);

    // Approving or cancelling emails the customer (in the background; a failed email never undoes the change)
    appointmentNotificationsService.notifyAppointmentStatusChanged(existingAppointment, {
      previousStatus: currentStatus,
      newStatus: normalizedStatus
    });

    return { statusCode: 200, body: { success: true, message: 'Status updated', appointment: data[0] } };
  } catch (error) {
    console.error('Update status error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

module.exports = {
  listServices,
  createAppointment,
  getUserAppointments,
  cancelOwnAppointment,
  getAllAppointments,
  updateStatus,
  attachHandledByNames
};
