const {
  hasValue,
  trimValue,
  getLocalDateValue
} = require('./commonValidator');
const {
  getServiceUnavailableReason,
  MIN_SERVICE_DURATION_MINUTES,
  MAX_SERVICE_DURATION_MINUTES
} = require('../utils/serviceCatalog');
const {
  INVALID_APPOINTMENT_DATE_MESSAGE,
  INVALID_APPOINTMENT_TIME_MESSAGE,
  PAST_APPOINTMENT_DATE_MESSAGE,
  PAST_APPOINTMENT_TIME_MESSAGE,
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  VALID_APPOINTMENT_STATUSES,
  CLINIC_TIME_ZONE
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

function normalizeDurationMinutes(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

// Interpret the database's date and time as clinic wall-clock time, independent of the Railway host timezone.
// The conversion round-trips through Intl so timezone rules (including DST where applicable) are honored.
function getAppointmentStartTimestamp(appointmentDate, appointmentTime, timeZone = CLINIC_TIME_ZONE) {
  const date = normalizeAppointmentDate(appointmentDate);
  const time = parseAppointmentTime(appointmentTime);
  if (!date || !time) return null;
  const [year, month, day] = date.split('-').map(Number);
  const targetWallMs = Date.UTC(year, month - 1, day, time.hours, time.minutes, time.seconds);
  let candidateMs = targetWallMs;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidateMs)).map(part => [part.type, part.value]));
    const representedWallMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    const correction = targetWallMs - representedWallMs;
    candidateMs += correction;
    if (correction === 0) break;
  }

  const finalParts = Object.fromEntries(formatter.formatToParts(new Date(candidateMs)).map(part => [part.type, part.value]));
  const matches = Number(finalParts.year) === year && Number(finalParts.month) === month &&
    Number(finalParts.day) === day && Number(finalParts.hour) === time.hours &&
    Number(finalParts.minute) === time.minutes && Number(finalParts.second) === time.seconds;
  return matches ? candidateMs : null;
}

// The date (YYYY-MM-DD) on the clinic's wall clock, whatever timezone the server runs in
function getClinicDateValue(date = new Date(), timeZone = CLINIC_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function validateOwnerCancellationRequest(params = {}, authenticatedUserId) {
  const normalizedAppointmentId = trimValue(params.id);
  const normalizedUserId = trimValue(authenticatedUserId);
  if (!normalizedAppointmentId || !normalizedUserId) {
    return { error: { statusCode: 400, body: { error: 'Appointment ID and authenticated owner are required.' } } };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedAppointmentId)) {
    return { error: { statusCode: 404, body: { error: 'Appointment not found.' } } };
  }
  return { normalizedAppointmentId, normalizedUserId };
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
  if (!normalizedDate) return INVALID_APPOINTMENT_DATE_MESSAGE;

  const parsedTime = parseAppointmentTime(appointmentTime);
  if (!parsedTime) return INVALID_APPOINTMENT_TIME_MESSAGE;

  const clinicNow = new Date();
  const today = getClinicDateValue(clinicNow);
  if (normalizedDate < today) return PAST_APPOINTMENT_DATE_MESSAGE;
  if (normalizedDate > today) return '';

  const selectedDateTime = getAppointmentStartTimestamp(normalizedDate, appointmentTime);
  if (!Number.isFinite(selectedDateTime)) {
    return INVALID_APPOINTMENT_DATE_MESSAGE;
  }

  return selectedDateTime > clinicNow.getTime() ? '' : PAST_APPOINTMENT_TIME_MESSAGE;
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

function validateCreateAppointment(body = {}, service = null) {
  const normalizedUserId = trimValue(body.user_id);
  const normalizedPetId = trimValue(body.pet_id);
  const requestedServiceId = trimValue(body.service_id);
  const requestedServiceType = trimValue(body.service_type);

  if (
    !normalizedUserId ||
    !normalizedPetId ||
    (!requestedServiceId && !requestedServiceType) ||
    !hasValue(body.appointment_date) ||
    !hasValue(body.appointment_time)
  ) {
    return {
      error: { statusCode: 400, body: { error: 'All appointment fields are required' } }
    };
  }

  if (!service) {
    return {
      error: { statusCode: 400, body: { error: 'Select a valid service type.' } }
    };
  }

  const serviceType = String(service.name || '').trim();
  if (requestedServiceType && requestedServiceType !== serviceType) {
    return {
      error: { statusCode: 409, body: { error: 'The service configuration changed. Refresh the service list and try again.' } }
    };
  }

  const unavailableReason = getServiceUnavailableReason(service);
  const estimatedDurationMinutes = Number(service.duration_minutes);
  if (unavailableReason || !Number.isInteger(estimatedDurationMinutes)
      || estimatedDurationMinutes < MIN_SERVICE_DURATION_MINUTES
      || estimatedDurationMinutes > MAX_SERVICE_DURATION_MINUTES) {
    return {
      error: { statusCode: 409, body: { error: unavailableReason || 'This service has no valid clinic-confirmed duration.' } }
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
    serviceId: String(service.id),
    service,
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
  getClinicDateValue,
  getAppointmentStartTimestamp,
  validateOwnerCancellationRequest,
  getAppointmentTimeRange,
  validateCreateAppointment,
  validateUserAppointmentsQuery,
  validateUpdateStatusRequest,
  validateAdminAppointmentStatusRequest
};
