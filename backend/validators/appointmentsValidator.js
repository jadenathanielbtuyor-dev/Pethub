const {
  hasValue,
  trimValue,
  getLocalDateValue
} = require('./commonValidator');
const {
  SERVICE_DURATIONS_MINUTES,
  INVALID_APPOINTMENT_DATE_MESSAGE,
  INVALID_APPOINTMENT_TIME_MESSAGE,
  PAST_APPOINTMENT_DATE_MESSAGE,
  PAST_APPOINTMENT_TIME_MESSAGE,
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  VALID_APPOINTMENT_STATUSES
} = require('../constants/appointments');

function normalizeAppointmentDate(value) {
  const rawValue = String(value || '').trim();
  const dateMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const parsedDate = new Date(0);
    parsedDate.setFullYear(year, month - 1, day);
    parsedDate.setHours(0, 0, 0, 0);

    if (
      parsedDate.getFullYear() !== year ||
      parsedDate.getMonth() !== month - 1 ||
      parsedDate.getDate() !== day
    ) {
      return '';
    }

    return getLocalDateValue(parsedDate);
  }

  const parsedDate = new Date(rawValue);
  if (Number.isNaN(parsedDate.getTime())) return '';
  return getLocalDateValue(parsedDate);
}

function parseAppointmentTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }

  return { hours, minutes, seconds };
}

function normalizeAppointmentTime(value) {
  const parsedTime = parseAppointmentTime(value);
  if (!parsedTime) return '';

  const hours = String(parsedTime.hours).padStart(2, '0');
  const minutes = String(parsedTime.minutes).padStart(2, '0');
  const seconds = String(parsedTime.seconds).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function getExactServiceDurationMinutes(serviceType) {
  const serviceName = String(serviceType || '').trim();
  return Object.prototype.hasOwnProperty.call(SERVICE_DURATIONS_MINUTES, serviceName)
    ? SERVICE_DURATIONS_MINUTES[serviceName]
    : null;
}

function normalizeDurationMinutes(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function buildAppointmentDateTime(normalizedDate, parsedTime) {
  const dateParts = String(normalizedDate || '').split('-').map(Number);
  if (dateParts.length !== 3 || !parsedTime) return null;

  const [year, month, day] = dateParts;
  const dateTime = new Date(0);
  dateTime.setFullYear(year, month - 1, day);
  dateTime.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
  return dateTime;
}

function getAppointmentDateTimeValidationError(appointmentDate, appointmentTime) {
  const normalizedDate = normalizeAppointmentDate(appointmentDate);
  const today = getLocalDateValue();
  if (!normalizedDate) return INVALID_APPOINTMENT_DATE_MESSAGE;

  const parsedTime = parseAppointmentTime(appointmentTime);
  if (!parsedTime) return INVALID_APPOINTMENT_TIME_MESSAGE;

  if (normalizedDate < today) return PAST_APPOINTMENT_DATE_MESSAGE;
  if (normalizedDate > today) return '';

  const selectedDateTime = buildAppointmentDateTime(normalizedDate, parsedTime);
  if (!selectedDateTime || Number.isNaN(selectedDateTime.getTime())) {
    return INVALID_APPOINTMENT_DATE_MESSAGE;
  }

  return selectedDateTime > new Date() ? '' : PAST_APPOINTMENT_TIME_MESSAGE;
}

function getAppointmentTimeRange(appointmentDate, appointmentTime, estimatedDurationMinutes) {
  const normalizedDate = normalizeAppointmentDate(appointmentDate);
  const parsedTime = parseAppointmentTime(appointmentTime);
  const durationMinutes = normalizeDurationMinutes(estimatedDurationMinutes);
  if (!normalizedDate || !parsedTime || !durationMinutes) return null;

  const startMs = ((parsedTime.hours * 60 + parsedTime.minutes) * 60 + parsedTime.seconds) * 1000;
  const endMs = startMs + durationMinutes * 60000;
  return { date: normalizedDate, startMs, endMs };
}

function validateCreateAppointment(body = {}) {
  const normalizedUserId = trimValue(body.user_id);
  const normalizedPetId = trimValue(body.pet_id);
  const serviceType = trimValue(body.service_type);

  if (
    !normalizedUserId ||
    !normalizedPetId ||
    !serviceType ||
    !hasValue(body.appointment_date) ||
    !hasValue(body.appointment_time)
  ) {
    return {
      error: { statusCode: 400, body: { error: 'All appointment fields are required' } }
    };
  }

  const estimatedDurationMinutes = getExactServiceDurationMinutes(serviceType);
  if (!Number.isFinite(estimatedDurationMinutes)) {
    return {
      error: { statusCode: 400, body: { error: 'Select a valid service type.' } }
    };
  }

  const appointmentDateTimeError = getAppointmentDateTimeValidationError(body.appointment_date, body.appointment_time);
  if (appointmentDateTimeError) {
    return {
      error: { statusCode: 400, body: { error: appointmentDateTimeError } }
    };
  }

  return {
    normalizedUserId,
    normalizedPetId,
    serviceType,
    estimatedDurationMinutes,
    normalizedAppointmentDate: normalizeAppointmentDate(body.appointment_date),
    normalizedAppointmentTime: normalizeAppointmentTime(body.appointment_time)
  };
}

function validateUserAppointmentsQuery(query = {}) {
  const normalizedUserId = trimValue(query.user_id);
  if (!normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'user_id is required' } }
    };
  }

  return { normalizedUserId };
}

function validateUpdateStatusRequest(body = {}, query = {}, headers = {}) {
  const normalizedAppointmentId = trimValue(body.id);
  const normalizedStatus = trimValue(body.status);
  const adminId = hasValue(body.user_id) ? body.user_id : (headers['x-user-id'] || query?.user_id);
  const normalizedAdminId = trimValue(adminId);

  if (!normalizedAppointmentId || !normalizedStatus) {
    return {
      error: { statusCode: 400, body: { error: 'id and status are required' } }
    };
  }

  if (!VALID_APPOINTMENT_STATUSES.includes(normalizedStatus)) {
    return {
      error: { statusCode: 400, body: { error: 'Invalid status' } }
    };
  }

  if (!normalizedAdminId) {
    return {
      error: { statusCode: 400, body: { error: 'Admin user ID is required' } }
    };
  }

  return { normalizedAppointmentId, normalizedStatus, normalizedAdminId };
}

function validateAdminAppointmentStatusRequest(body = {}, adminUserId) {
  const normalizedAppointmentId = trimValue(body.id);
  const normalizedStatus = trimValue(body.status);
  const normalizedAdminUserId = trimValue(adminUserId);

  if (!normalizedAppointmentId || !normalizedStatus) {
    return {
      error: { statusCode: 400, body: { error: 'id and status are required' } }
    };
  }

  if (!VALID_APPOINTMENT_STATUSES.includes(normalizedStatus)) {
    return {
      error: {
        statusCode: 400,
        body: { error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` }
      }
    };
  }

  if (!normalizedAdminUserId) {
    return {
      error: { statusCode: 400, body: { error: 'Admin user ID is required' } }
    };
  }

  return { normalizedAppointmentId, normalizedStatus, normalizedAdminUserId };
}

module.exports = {
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  VALID_APPOINTMENT_STATUSES,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  parseAppointmentTime,
  normalizeDurationMinutes,
  getAppointmentTimeRange,
  validateCreateAppointment,
  validateUserAppointmentsQuery,
  validateUpdateStatusRequest,
  validateAdminAppointmentStatusRequest
};
