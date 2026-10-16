const { MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION } = require('../constants/activityActions');

function getRecordTime(record) {
  const date = new Date(record?.record_date || record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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
  getMedicalRecordSummary,
  buildMedicalRecordContext,
  getAppointmentIdFromMedicalRecordAction,
  getMedicalRecordCompletedAppointmentAction,
  applyMedicalRecordStateToAppointments
};
