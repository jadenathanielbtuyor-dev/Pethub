const supabase = require('../config/supabase');

const APPOINTMENT_SELECT = 'id, user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status, handled_by, created_at';

function countAll() {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true });
}

function countByStatus(status) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('status', status);
}

function countVaccinationsDueSoon(today, endDate, statuses) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .ilike('service_type', '%Vaccination%')
    .gte('appointment_date', today)
    .lte('appointment_date', endDate)
    .in('status', statuses);
}

function countUpcomingBookings(today) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .gte('appointment_date', today)
    .neq('status', 'Cancelled');
}

function listSchedule() {
  return supabase
    .from('appointments')
    .select('id, appointment_date, appointment_time, estimated_duration_minutes, status');
}

function listScheduleByDate(appointmentDate) {
  return supabase
    .from('appointments')
    .select('id, appointment_date, appointment_time, estimated_duration_minutes, status')
    .eq('appointment_date', appointmentDate);
}

function createAppointment(appointment) {
  return supabase
    .from('appointments')
    .insert([appointment])
    .select(APPOINTMENT_SELECT);
}

function listByUserId(userId) {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('user_id', userId)
    .order('appointment_date', { ascending: true });
}

function listAllAppointments() {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .order('appointment_date', { ascending: true });
}

function findById(appointmentId) {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', appointmentId)
    .maybeSingle();
}

function findStatusById(appointmentId) {
  return supabase
    .from('appointments')
    .select('id, status')
    .eq('id', appointmentId)
    .maybeSingle();
}

function findForMedicalRecord(appointmentId) {
  return supabase
    .from('appointments')
    .select('id, user_id, status, pet_id')
    .eq('id', appointmentId)
    .maybeSingle();
}

function updateStatus(appointmentId, status, handledBy) {
  return supabase
    .from('appointments')
    .update({ status, handled_by: handledBy })
    .eq('id', appointmentId)
    .select(APPOINTMENT_SELECT);
}

function listServiceTypes() {
  return supabase
    .from('appointments')
    .select('service_type');
}

function listAppointmentDatesBetween(startDate, endDate) {
  return supabase
    .from('appointments')
    .select('appointment_date')
    .gte('appointment_date', startDate)
    .lte('appointment_date', endDate);
}

function listUsersByAppointmentIds(appointmentIds) {
  return supabase
    .from('appointments')
    .select('id, user_id')
    .in('id', appointmentIds);
}

module.exports = {
  APPOINTMENT_SELECT,
  countAll,
  countByStatus,
  countVaccinationsDueSoon,
  countUpcomingBookings,
  listSchedule,
  listScheduleByDate,
  createAppointment,
  listByUserId,
  listAllAppointments,
  findById,
  findStatusById,
  findForMedicalRecord,
  updateStatus,
  listServiceTypes,
  listAppointmentDatesBetween,
  listUsersByAppointmentIds
};
