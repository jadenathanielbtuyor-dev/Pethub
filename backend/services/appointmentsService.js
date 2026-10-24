const usersRepository = require('../repositories/usersRepository');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');
const { isUserVerified } = require('../utils/accountVerification');
const { logUserActivity } = require('../utils/activityLogger');
const appointmentNotificationsService = require('./appointmentNotificationsService');
const {
  hasValue,
  isUuid
} = require('../validators/commonValidator');
const {
  INVALID_APPOINTMENT_DATE_MESSAGE,
  APPOINTMENT_STATUS_CHANGED_MESSAGE,
  APPOINTMENT_CANCELLATION_CUTOFF_HOURS,
  APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE,
  SERVICE_TEMPORARILY_UNAVAILABLE_MESSAGE
} = require('../constants/appointments');
const { SERVICE_SPECIES } = require('../constants/services');
const { isServiceAvailableForSpecies, describeSpecies } = require('../utils/serviceCatalog');
const {
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  getAppointmentTimeRange,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  validateCreateAppointment,
  validateUserAppointmentsQuery,
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

function getActiveAppointmentRanges(appointments, excludedAppointmentId = '', includePending = true) {
  const excludedId = String(excludedAppointmentId || '').trim();
  return (appointments || [])
    .filter(appointment => {
      const appointmentId = String(appointment?.id || '').trim();
      const status = String(appointment?.status || '').trim().toLowerCase();
      const occupiesSchedule = OCCUPIED_APPOINTMENT_STATUSES.has(status) && (includePending || status !== 'pending');
      return (!excludedId || appointmentId !== excludedId) && occupiesSchedule;
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

async function getScheduleConflict(appointmentDate, appointmentTime, estimatedDurationMinutes, excludedAppointmentId = '', includePending = true) {
  const requestedRange = getAppointmentTimeRange(appointmentDate, appointmentTime, estimatedDurationMinutes);
  if (!requestedRange) return { hasConflict: false, error: '' };

  const { data: appointments, error } = await appointmentsRepository.listScheduleByDate(requestedRange.date);

  if (error) {
    throw error;
  }

  const existingRanges = getActiveAppointmentRanges(appointments, excludedAppointmentId, includePending);
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
    const body = req.body || {};
    const serviceId = String(body.service_id || '').trim();
    const serviceName = String(body.service_type || '').trim();
    if (!serviceId && !serviceName) {
      const validation = validateCreateAppointment(body, null);
      return validation.error;
    }
    if (serviceId && !isUuid(serviceId)) {
      return { statusCode: 400, body: { error: 'Select a valid service type.' } };
    }

    const serviceResult = serviceId
      ? await serviceCatalogRepository.findById(serviceId)
      : await serviceCatalogRepository.findByName(serviceName);
    if (serviceResult.error) {
      if (['42P01', 'PGRST205'].includes(String(serviceResult.error.code || ''))) {
        return { statusCode: 503, body: { error: 'Service configuration is unavailable until the reviewed database migration is applied.' } };
      }
      throw serviceResult.error;
    }

    const validation = validateCreateAppointment(body, serviceResult.data);
    if (validation.error) return validation.error;

    const {
      normalizedUserId,
      normalizedPetId,
      service,
      serviceType,
      estimatedDurationMinutes,
      normalizedAppointmentDate,
      normalizedAppointmentTime
    } = validation;
    const catalogServiceId = validation.serviceId;

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
    if (!isServiceAvailableForSpecies(service, pet.species)) {
      const offeredSpecies = describeSpecies(service.species || []);
      return { statusCode: 400, body: { error: offeredSpecies
        ? `${serviceType} is offered for ${offeredSpecies} only.`
        : 'The clinic has not confirmed which species this service is for yet.' } };
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

    const duplicate = await appointmentsRepository.findPendingDuplicate(appointmentRecord);
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) {
      return { statusCode: 200, body: { success: true, appointment: mapAppointmentForOwner(duplicate.data), already_booked: true } };
    }

    // The database function serializes reservations for a date, checks overlap, and returns an existing identical
    // Pending request idempotently. A process-local lock cannot protect other Railway instances.
    const inserted = await appointmentsRepository.createIfAvailable(appointmentRecord, catalogServiceId);
    const { data, error } = inserted;

    if (error) {
      if (['PGRST202', '42883'].includes(String(error.code || ''))) {
        return { statusCode: 503, body: { error: 'Secure booking is unavailable until the reviewed database rule is installed.' } };
      }
      if (String(error.code || '') === 'P0001') {
        // The database re-checked the service under a lock: say so plainly if the clinic switched it off meanwhile
        const latest = await serviceCatalogRepository.findById(catalogServiceId);
        if (!latest.error && latest.data?.online_booking_enabled !== true) {
          return { statusCode: 409, body: { error: SERVICE_TEMPORARILY_UNAVAILABLE_MESSAGE } };
        }
        return { statusCode: 409, body: { error: 'The service or pet details changed. Refresh the service list and try again.' } };
      }
      if (String(error.code || '') === '22023') {
        return { statusCode: 400, body: { error: 'The appointment request is invalid. Refresh the page and try again.' } };
      }
      console.error('Error creating appointment:', error);
      return { statusCode: 500, body: { error: 'Failed to create appointment' } };
    }

    if (data?.outcome === 'conflict') {
      const conflict = await getScheduleConflict(
        normalizedAppointmentDate,
        normalizedAppointmentTime,
        estimatedDurationMinutes
      );
      return { statusCode: 409, body: {
        error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
        suggested_time: conflict.suggested_time || null
      } };
    }
    if (data?.outcome === 'existing') {
      const existing = await appointmentsRepository.findByIdForUser(data.appointment_id, normalizedUserId);
      if (existing.error || !existing.data) throw existing.error || new Error('Reserved appointment could not be loaded');
      return { statusCode: 200, body: { success: true, appointment: mapAppointmentForOwner(existing.data), already_booked: true } };
    }
    if (data?.outcome !== 'created' || !data.appointment_id) {
      console.error('Appointment reservation returned an unexpected result.');
      return { statusCode: 500, body: { error: 'Failed to create appointment' } };
    }

    const created = await appointmentsRepository.findByIdForUser(data.appointment_id, normalizedUserId);
    if (created.error || !created.data) throw created.error || new Error('Reserved appointment could not be loaded');
    await logUserActivity(normalizedUserId, 'appointment_booked', `Requested ${serviceType} for ${petName}`);
    return { statusCode: 201, body: { success: true, appointment: mapAppointmentForOwner(created.data) } };
  } catch (error) {
    console.error('Create appointment error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * The clinic's services for the booking page: name, category, description, species, and the confirmed duration
 * (null, with bookable false, until the clinic confirms it)
 */
const listServices = async () => require('./serviceCatalogService').listServices();

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
    return { statusCode: 200, body: { success: true, appointments: appointmentsWithHandlers.map(mapAppointmentForOwner) } };
  } catch (error) {
    console.error('Get user appointments error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

// The owner sees whether they or the clinic cancelled, not the id of the admin who did
function mapAppointmentForOwner(appointment) {
  if (!appointment) return appointment;
  const { cancelled_by: cancelledBy, ...rest } = appointment;
  return {
    ...rest,
    cancelled_by_owner: appointment.status === 'Cancelled' && cancelledBy ? String(cancelledBy) === String(appointment.user_id) : null
  };
}

// What the owner is told after cancelling, depending on the confirmation email (appointmentNotificationsService)
const OWNER_CANCELLATION_MESSAGES = Object.freeze({
  sent: 'Appointment cancelled. A confirmation email is on its way to you.',
  failed: 'Appointment cancelled. We could not confirm that the confirmation email was delivered; the cancellation is saved and shown below, and the clinic can see that the email needs to be resent.',
  skipped: 'Appointment cancelled. No confirmation email was sent because your account has no email address on file.',
  duplicate: 'Appointment cancelled. A confirmation email was already sent for it.'
});

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
      return { statusCode: 200, body: { success: true, already_cancelled: true, appointment: mapAppointmentForOwner(appointment) } };
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
      if (latest.status === 'Cancelled') return { statusCode: 200, body: { success: true, already_cancelled: true, appointment: mapAppointmentForOwner(latest) } };
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
    const cancelledAppointment = refreshedAppointment
      || { ...appointment, status: 'Cancelled', cancelled_at: new Date().toISOString(), cancelled_by: normalizedUserId };
    await logUserActivity(normalizedUserId, 'appointment_cancelled', `Cancelled ${cancelledAppointment.service_type || 'an appointment'} for ${cancelledAppointment.pet_name || 'a pet'}`);
    // Only this request changed the row (the database function returns true once), so the confirmation is sent once.
    // A failed email leaves the cancellation in place; the owner is told and the clinic can resend it.
    const emailStatus = await appointmentNotificationsService.confirmOwnerCancellation(cancelledAppointment);
    return { statusCode: 200, body: {
      success: true,
      message: OWNER_CANCELLATION_MESSAGES[emailStatus] || OWNER_CANCELLATION_MESSAGES.failed,
      email_status: emailStatus,
      appointment: mapAppointmentForOwner(cancelledAppointment)
    } };
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

module.exports = {
  listServices,
  createAppointment,
  getUserAppointments,
  cancelOwnAppointment,
  getAllAppointments,
  attachHandledByNames
};
