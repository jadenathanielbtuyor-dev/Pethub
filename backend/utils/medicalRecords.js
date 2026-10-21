const { MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION } = require('../constants/activityActions');
const { RECORDED_WEIGHT_UNIT } = require('../constants/pets');

function getRecordTime(record) {
  const date = new Date(record?.record_date || record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getCreatedTime(record) {
  const date = new Date(record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

// Newest first by record date, then by when the record was saved
function compareRecordsNewestFirst(first, second) {
  return (getRecordTime(second) - getRecordTime(first)) || (getCreatedTime(second) - getCreatedTime(first));
}

function hasRecordedWeight(record) {
  const weight = record?.weight;
  if (weight === null || weight === undefined || String(weight).trim() === '') return false;
  return Number.isFinite(Number(weight));
}

/**
 * The weight from the newest official record that has one (records saved without a weight are skipped), with the
 * date it was recorded; null when no record has a weight. Never estimated or defaulted.
 */
function getLatestRecordedWeight(records) {
  const latest = (Array.isArray(records) ? records : []).filter(hasRecordedWeight).sort(compareRecordsNewestFirst)[0];
  if (!latest) return null;
  return {
    value: Number(latest.weight),
    unit: RECORDED_WEIGHT_UNIT,
    record_date: latest.record_date || null,
    record_id: latest.id || null
  };
}

function getMedicalRecordSummary(record) {
  if (!record) return null;

  const parts = [
    record.medical_notes,
    record.treatment ? `Treatment: ${record.treatment}` : '',
    record.vaccination_status ? `Vaccination: ${record.vaccination_status}` : ''
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  return parts.length ? parts[0] : 'Medical record available';
}

function buildMedicalRecordContext(records) {
  const counts = {};
  const latestByPet = {};

  (records || []).forEach(record => {
    if (!record || record.pet_id == null) return;

    const petId = String(record.pet_id);
    counts[petId] = (counts[petId] || 0) + 1;

    if (!latestByPet[petId] || getRecordTime(record) > getRecordTime(latestByPet[petId])) {
      latestByPet[petId] = record;
    }
  });

  return { counts, latestByPet };
}

function getAppointmentIdFromMedicalRecordAction(action) {
  const match = String(action || '').match(/completed appointment\s+([^\s]+)/i);
  return match ? match[1].replace(/[.,;:]+$/, '') : '';
}

function getMedicalRecordCompletedAppointmentAction(appointmentId) {
  return `${MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION} ${String(appointmentId || '').trim()}`;
}

function applyMedicalRecordStateToAppointments(appointments, medicalRecordState = {}) {
  return (Array.isArray(appointments) ? appointments : []).map(appointment => {
    const state = medicalRecordState[String(appointment?.id || '').trim()];
    return state ? { ...appointment, ...state } : appointment;
  });
}

module.exports = {
  getRecordTime,
  compareRecordsNewestFirst,
  getLatestRecordedWeight,
  getMedicalRecordSummary,
  buildMedicalRecordContext,
  getAppointmentIdFromMedicalRecordAction,
  getMedicalRecordCompletedAppointmentAction,
  applyMedicalRecordStateToAppointments
};
