const supabase = require('../config/supabase');

const APPOINTMENT_SELECT = 'id, user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status, handled_by, created_at';

// Newest first: latest appointment date, then latest time that day, then the most recently booked. Rows missing a
// value go last (PostgreSQL would otherwise put NULLs first when sorting descending).
function orderNewestFirst(query) {
  return query
    .order('appointment_date', { ascending: false, nullsFirst: false })
    .order('appointment_time', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false, nullsFirst: false });
}

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
  return orderNewestFirst(supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('user_id', userId));
}

function listAllAppointments() {
  return orderNewestFirst(supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT));
}

// appointments.payment_status mirrors the verified deposit; the payments table stays the source of truth
function updatePaymentStatus(appointmentId, paymentStatus) {
  return supabase
    .from('appointments')
    .update({ payment_status: paymentStatus })
    .eq('id', appointmentId)
    .select('id');
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

// With expectedCurrentStatus, the row only changes if its status is still the one the caller checked,
// so two admins acting at once cannot overwrite each other (0 rows returned = it changed meanwhile).
function updateStatus(appointmentId, status, handledBy, expectedCurrentStatus) {
  let query = supabase
    .from('appointments')
    .update({ status, handled_by: handledBy })
    .eq('id', appointmentId);

  if (expectedCurrentStatus) {
    query = query.eq('status', expectedCurrentStatus);
  }

  return query.select(APPOINTMENT_SELECT);
}

// deposit_required comes from database/migrations/2026-10-17_paymongo_deposits.sql. These reads run whatever
// PAYMENTS_ENABLED says (services/paymentsService.js); before the migration they fail with 42703, which the service
// treats as "no appointment needs a deposit" for lists and approvals.
function findForDeposit(appointmentId) {
  return supabase
    .from('appointments')
    .select('id, user_id, status, appointment_date, appointment_time, estimated_duration_minutes, deposit_required')
    .eq('id', appointmentId)
    .maybeSingle();
}

function listDepositFlagsByIds(appointmentIds) {
  return supabase
    .from('appointments')
    .select('id, deposit_required')
    .in('id', appointmentIds);
}

function listDepositRequiredIds() {
  return supabase
    .from('appointments')
    .select('id')
    .eq('deposit_required', true);
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
  updatePaymentStatus,
  findById,
  findStatusById,
  findForMedicalRecord,
  updateStatus,
  findForDeposit,
  listDepositFlagsByIds,
  listDepositRequiredIds,
  listServiceTypes,
  listAppointmentDatesBetween,
  listUsersByAppointmentIds
};
