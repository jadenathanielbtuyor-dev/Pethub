const {
  hasValue,
  trimValue
} = require('./commonValidator');

function normalizeRecordDateValue(value) {
  if (!hasValue(value)) return null;

  const rawValue = String(value).trim();
  const dateOnlyMatch = rawValue.match(/^\d{4}-\d{2}-\d{2}/);
  if (dateOnlyMatch) {
    const dateKey = dateOnlyMatch[0];
    const [year, month, day] = dateKey.split('-').map(Number);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    const isValidDate = parsedDate.getUTCFullYear() === year
      && parsedDate.getUTCMonth() === month - 1
      && parsedDate.getUTCDate() === day;
    return isValidDate ? dateKey : null;
  }

  const parsedDate = new Date(rawValue);
  if (Number.isNaN(parsedDate.getTime())) return null;
  return parsedDate.toISOString().slice(0, 10);
}

function validateAdminMedicalRecord(body = {}, adminUserId) {
  if (!hasValue(adminUserId)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Admin user ID is required' } }
    };
  }

  const normalizedAdminId = trimValue(adminUserId);
  const normalizedBodyUserId = hasValue(body.user_id) ? trimValue(body.user_id) : '';
  const normalizedCreatedBy = hasValue(body.created_by) ? trimValue(body.created_by) : normalizedAdminId;
  const normalizedPetId = trimValue(body.pet_id);
  const normalizedRecordDate = hasValue(body.record_date) ? normalizeRecordDateValue(body.record_date) : null;
  const normalizedAppointmentId = hasValue(body.appointment_id) ? trimValue(body.appointment_id) : '';

  if (normalizedBodyUserId && normalizedBodyUserId !== normalizedAdminId) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Current admin user ID does not match the request.' } }
    };
  }

  if (normalizedCreatedBy !== normalizedAdminId) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'created_by must match the current admin user.' } }
    };
  }

  if (!hasValue(normalizedPetId)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Select a real pet before saving a medical record.' } }
    };
  }

  if (!hasValue(body.record_date)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'record_date is required' } }
    };
  }

  if (!normalizedRecordDate) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'record_date must be a valid date' } }
    };
  }

  const payload = {
    pet_id: normalizedPetId,
    record_date: normalizedRecordDate,
    created_by: normalizedCreatedBy
  };

  if (normalizedAppointmentId) payload.appointment_id = normalizedAppointmentId;

  if (hasValue(body.weight)) {
    const numericWeight = Number(body.weight);
    if (!Number.isFinite(numericWeight) || numericWeight < 0) {
      return {
        error: { statusCode: 400, body: { success: false, error: 'weight must be a valid non-negative number' } }
      };
    }
    payload.weight = numericWeight;
  }

  if (hasValue(body.vaccination_status)) {
    payload.vaccination_status = trimValue(body.vaccination_status);
  }

  if (hasValue(body.treatment)) {
    payload.treatment = trimValue(body.treatment);
  }

  if (hasValue(body.medical_notes)) {
    payload.medical_notes = trimValue(body.medical_notes);
  }

  return {
    normalizedAdminId,
    normalizedBodyUserId,
    normalizedCreatedBy,
    normalizedPetId,
    normalizedRecordDate,
    normalizedAppointmentId,
    payload
  };
}

module.exports = {
  normalizeRecordDateValue,
  validateAdminMedicalRecord
};
