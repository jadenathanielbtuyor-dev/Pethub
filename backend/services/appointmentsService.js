const usersRepository = require('../repositories/usersRepository');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const { isUserVerified, isAdminVerified } = require('../utils/accountVerification');
const { logAdminActivity } = require('../utils/activityLogger');
const paymentsService = require('./paymentsService');
const {
  hasValue
} = require('../validators/commonValidator');
const { INVALID_APPOINTMENT_DATE_MESSAGE, APPOINTMENT_STATUS_CHANGED_MESSAGE } = require('../constants/appointments');
const {
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  getAppointmentTimeRange,
  normalizeAppointmentDate,
  validateCreateAppointment,
  validateUserAppointmentsQuery,
  validateUpdateStatusRequest
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

    // While deposits are on, new bookings are marked deposit_required; older appointments stay exempt
    const depositFields = paymentsService.getNewAppointmentDepositFields();
    let depositRequired = Object.keys(depositFields).length > 0;
    let { data, error } = await appointmentsRepository.createAppointment({ ...appointmentRecord, ...depositFields });

    if (error && depositRequired && paymentsService.isMissingColumnError(error)) {
      // PAYMENTS_ENABLED is on but the deposit migration has not been applied yet: keep booking working without a deposit
      paymentsService.reportMissingSchema('appointments.deposit_required', error);
      depositRequired = false;
      ({ data, error } = await appointmentsRepository.createAppointment(appointmentRecord));
    }

    if (error) {
      console.error('Error creating appointment:', error);
      return { statusCode: 500, body: { error: 'Failed to create appointment' } };
    }

    return { statusCode: 201, body: {
      success: true,
      appointment: data[0],
      ...(depositRequired ? { deposit: paymentsService.getNewAppointmentDepositNotice() } : {})
    } };
  } catch (error) {
    console.error('Create appointment error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

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
    const appointmentsWithDeposits = await paymentsService.attachDepositSummaries(appointmentsWithHandlers, { audience: 'user' });
    return { statusCode: 200, body: { success: true, appointments: appointmentsWithDeposits } };
  } catch (error) {
    console.error('Get user appointments error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
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

    if (normalizedStatus === 'Approved') {
      // Same deposit check as PUT /admin/dashboard/appointment-status, so this legacy route cannot bypass it
      const depositCheck = await paymentsService.checkDepositForApproval(existingAppointment);
      if (!depositCheck.allowed) return depositCheck.result;

      const conflict = await getScheduleConflict(
        existingAppointment.appointment_date,
        existingAppointment.appointment_time,
        existingAppointment.estimated_duration_minutes,
        normalizedAppointmentId
      );

      if (conflict.hasConflict) {
        return { statusCode: 409, body: paymentsService.addRefundRequiredToConflict({
          error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
          suggested_time: conflict.suggested_time || null
        }, depositCheck) };
      }
    }

    const { data, error } = await appointmentsRepository.updateStatus(normalizedAppointmentId, normalizedStatus, normalizedAdminId, currentStatus);

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

    // Cancelling closes any open deposit checkout and reports a paid deposit that now needs a refund
    const depositNotice = normalizedStatus === 'Cancelled'
      ? await paymentsService.handleAppointmentCancelled(existingAppointment)
      : {};

    return { statusCode: 200, body: { success: true, message: 'Status updated', appointment: data[0], ...depositNotice } };
  } catch (error) {
    console.error('Update status error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

module.exports = {
  createAppointment,
  getUserAppointments,
  getAllAppointments,
  updateStatus
};
