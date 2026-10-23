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

// Appointments for one of serviceNames (exact names) dated today..endDate with one of the given statuses
function countUpcomingByServices(serviceNames, today, endDate, statuses) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .in('service_type', serviceNames)
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

// The reviewed database function locks the clinic-local date and checks overlapping active appointments in one
// transaction, so separate Railway instances cannot reserve the same slot concurrently.
function createIfAvailable(appointment, serviceId) {
  return supabase.rpc('create_appointment_if_available', {
    p_service_id: serviceId,
    p_user_id: appointment.user_id,
    p_pet_id: appointment.pet_id,
    p_pet_name: appointment.pet_name,
    p_service_type: appointment.service_type,
    p_estimated_duration_minutes: appointment.estimated_duration_minutes,
    p_appointment_date: appointment.appointment_date,
    p_appointment_time: appointment.appointment_time
  });
}

function findPendingDuplicate(appointment) {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('user_id', appointment.user_id)
    .eq('pet_id', appointment.pet_id)
    .eq('service_type', appointment.service_type)
    .eq('appointment_date', appointment.appointment_date)
    .eq('appointment_time', appointment.appointment_time)
    .eq('status', 'Pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

function updateStatusIfAvailable(appointmentId, status, handledBy, expectedStatus) {
  return supabase.rpc('update_appointment_status_if_available', {
    p_appointment_id: appointmentId,
    p_status: status,
    p_handled_by: handledBy,
    p_expected_status: expectedStatus
  });
}

function listByUserId(userId) {
  return orderNewestFirst(supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('user_id', userId));
}

// One pet's appointments on the owner's account (linked by pet_id, never by pet name), newest first
function listByUserIdAndPetId(userId, petId) {
  return orderNewestFirst(supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('user_id', userId)
    .eq('pet_id', petId));
}

// Older appointments on the owner's account that were saved without a pet_id (they keep only pet_name)
function countUnlinkedByUserId(userId) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('pet_id', null);
}

// Every appointment that points at the pet, whoever booked it
function countByPetId(petId) {
  return supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('pet_id', petId);
}

function listAllAppointments() {
  return orderNewestFirst(supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT));
}

function findById(appointmentId) {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', appointmentId)
    .maybeSingle();
}

function findByIdForUser(appointmentId, userId) {
  return supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', appointmentId)
    .eq('user_id', userId)
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
// A cancellation keeps the row and records when it happened in the existing cancelled_at column.
function updateStatus(appointmentId, status, handledBy, expectedCurrentStatus) {
  const changes = status === 'Cancelled'
    ? { status, handled_by: handledBy, cancelled_at: new Date().toISOString() }
    : { status, handled_by: handledBy };
  let query = supabase
    .from('appointments')
    .update(changes)
    .eq('id', appointmentId);

  if (expectedCurrentStatus) {
    query = query.eq('status', expectedCurrentStatus);
  }

  return query.select(APPOINTMENT_SELECT);
}

function cancelByUser(appointmentId, userId, expectedCurrentStatus) {
  return supabase.rpc('cancel_appointment_for_owner', {
    p_appointment_id: appointmentId,
    p_owner_id: userId,
    p_expected_status: expectedCurrentStatus
  });
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
  countUpcomingByServices,
  countUpcomingBookings,
  listSchedule,
  listScheduleByDate,
  createAppointment,
  createIfAvailable,
  findPendingDuplicate,
  updateStatusIfAvailable,
  listByUserId,
  listByUserIdAndPetId,
  countUnlinkedByUserId,
  countByPetId,
  listAllAppointments,
  findById,
  findByIdForUser,
  findStatusById,
  findForMedicalRecord,
  updateStatus,
  cancelByUser,
  listServiceTypes,
  listAppointmentDatesBetween,
  listUsersByAppointmentIds
};
