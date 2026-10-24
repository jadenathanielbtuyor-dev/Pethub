// ==================== MULTI-PET BOOKINGS ====================
// POST /appointments/group: one booking for 2-6 of the owner's pets, each with its own service. The pets are seen one
// after another from the chosen start time (the clinic schedule allows one appointment at a time). Every pet and
// service is checked here and again inside create_appointment_group_if_available, which saves the booking and all of
// its pet appointments in one transaction: either everything is saved or nothing is. Each pet keeps its own
// appointments row, so approving, cancelling, completing, emails and history stay per pet.
// POST /admin/appointment-groups/:id/cancel: the clinic cancels every still-open pet appointment of one booking.

const crypto = require('crypto');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');
const { isUserVerified } = require('../utils/accountVerification');
const { logUserActivity, logAdminActivity } = require('../utils/activityLogger');
const { isServiceBookable, isServiceAvailableForSpecies, describeSpecies } = require('../utils/serviceCatalog');
const { isUuid, trimValue } = require('../validators/commonValidator');
const {
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  parseAppointmentTime,
  getAppointmentDateTimeValidationError,
  getAppointmentTimeRange
} = require('../validators/appointmentsValidator');
const { GROUP_BOOKING_LIMITS, GROUP_SCHEDULING_NOTE, SCHEDULE_CONFLICT_MESSAGE } = require('../constants/appointments');
const appointmentNotificationsService = require('./appointmentNotificationsService');

const DAY_MINUTES = 24 * 60;

function clockText(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}:00`;
}

function displayClock(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

function badRequest(error, extra = {}) {
  return { statusCode: 400, body: { success: false, error, ...extra } };
}

// The same booking request always gets the same key, so a double click or retry finds the booking already made
function buildRequestKey(userId, date, time, items) {
  const text = `${userId}|${date}|${time}|${items.map(item => `${item.pet_id}:${item.service_id}`).join(',')}`;
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseItems(rawItems) {
  if (!Array.isArray(rawItems)) return { error: badRequest('Choose at least two of your pets for one booking.', { field: 'items' }) };
  if (rawItems.length < GROUP_BOOKING_LIMITS.minPets) {
    return { error: badRequest('Choose at least two of your pets for one booking. For one pet, use the single-pet booking form.', { field: 'items' }) };
  }
  if (rawItems.length > GROUP_BOOKING_LIMITS.maxPets) {
    return { error: badRequest(`One booking can include up to ${GROUP_BOOKING_LIMITS.maxPets} pets. Book the others separately.`, { field: 'items' }) };
  }
  const items = rawItems.map(item => ({ pet_id: trimValue(item?.pet_id), service_id: trimValue(item?.service_id) }));
  const itemErrors = [];
  const seenPets = new Set();
  items.forEach((item, index) => {
    if (!isUuid(item.pet_id)) itemErrors.push({ position: index + 1, field: 'pet_id', error: 'Choose one of your registered pets.' });
    else if (seenPets.has(item.pet_id)) itemErrors.push({ position: index + 1, pet_id: item.pet_id, field: 'pet_id', error: 'This pet is already in the booking. Each pet can be booked once per booking.' });
    seenPets.add(item.pet_id);
    if (!isUuid(item.service_id)) itemErrors.push({ position: index + 1, pet_id: item.pet_id, field: 'service_id', error: 'Choose a service for this pet.' });
  });
  if (itemErrors.length) return { error: badRequest('Some pets need attention before this booking can be sent.', { item_errors: itemErrors }) };
  return { items };
}

// Owner-facing form of a booking: each pet's appointment plus the booking's schedule
function describeGroup(appointments, groupId) {
  const rows = (appointments || []).filter(row => String(row.group_id) === String(groupId))
    .sort((first, second) => first.group_position - second.group_position);
  const first = rows[0];
  const total = rows.reduce((sum, row) => sum + (Number(row.estimated_duration_minutes) || 0), 0);
  return {
    id: groupId,
    appointment_date: first?.appointment_date || null,
    start_time: first?.appointment_time || null,
    scheduling: 'sequential',
    scheduling_note: GROUP_SCHEDULING_NOTE,
    pet_count: rows.length,
    total_duration_minutes: total
  };
}

async function loadGroupForOwner(groupId, userId) {
  const { data, error } = await appointmentsRepository.listByGroupIds([groupId]);
  if (error) throw error;
  const rows = (data || []).filter(row => String(row.user_id) === String(userId));
  const { mapAppointmentForOwner } = require('./appointmentsService');
  return { group: describeGroup(rows, groupId), appointments: rows.map(mapAppointmentForOwner) };
}

// The earliest start (from the requested one) at which the whole booking fits, or null if none that day
async function suggestGroupStart(date, startMinutes, totalMinutes) {
  const { data, error } = await appointmentsRepository.listScheduleByDate(date);
  if (error) return null;
  const busy = (data || [])
    .filter(row => ['pending', 'approved', 'completed'].includes(String(row.status || '').toLowerCase()))
    .map(row => getAppointmentTimeRange(row.appointment_date, row.appointment_time, row.estimated_duration_minutes))
    .filter(Boolean)
    .map(range => ({ start: range.startMs / 60000, end: range.endMs / 60000 }))
    .sort((first, second) => first.start - second.start);
  let candidate = startMinutes;
  for (const slot of busy) {
    if (slot.end <= candidate) continue;
    if (candidate + totalMinutes <= slot.start) break;
    candidate = Math.max(candidate, Math.ceil(slot.end));
  }
  return candidate + totalMinutes <= DAY_MINUTES ? clockText(candidate).slice(0, 5) : null;
}

const createAppointmentGroup = async (req) => {
  try {
    const body = req.body || {};
    const userId = trimValue(req.authUserId);
    if (!userId) return { statusCode: 401, body: { success: false, error: 'Authentication required. Please log in again.' } };

    const parsed = parseItems(body.items);
    if (parsed.error) return parsed.error;
    const { items } = parsed;

    const appointmentDate = normalizeAppointmentDate(body.appointment_date);
    const appointmentTime = normalizeAppointmentTime(body.appointment_time);
    const dateTimeError = getAppointmentDateTimeValidationError(body.appointment_date, body.appointment_time);
    if (!appointmentDate || !appointmentTime || dateTimeError) {
      return badRequest(dateTimeError || 'Enter a valid date and start time.', { field: !appointmentDate ? 'appointment_date' : 'appointment_time' });
    }

    if (!(await isUserVerified(userId))) {
      return { statusCode: 403, body: { success: false, error: 'Please verify your email first before accessing PetHub appointments.' } };
    }

    const [petsResult, catalogResult] = await Promise.all([
      petsRepository.listByUserId(userId),
      serviceCatalogRepository.listAll()
    ]);
    if (petsResult.error) throw petsResult.error;
    if (catalogResult.error) throw catalogResult.error;
    const pets = new Map((petsResult.data || []).map(pet => [String(pet.id), pet]));
    const services = new Map((catalogResult.data || []).map(service => [String(service.id), service]));

    // Every pet is checked, so the owner sees all the problems at once and keeps the choices that were fine
    const itemErrors = [];
    const resolved = items.map((item, index) => {
      const position = index + 1;
      const pet = pets.get(item.pet_id);
      const service = services.get(item.service_id);
      if (!pet) {
        itemErrors.push({ position, pet_id: item.pet_id, field: 'pet_id', error: 'This pet is not on your account.' });
        return null;
      }
      const petName = String(pet.name || '').trim() || 'This pet';
      if (!service) {
        itemErrors.push({ position, pet_id: pet.id, pet_name: petName, field: 'service_id', error: `The service chosen for ${petName} is no longer in the clinic's list. Choose another service.` });
        return null;
      }
      if (!isServiceBookable(service)) {
        itemErrors.push({ position, pet_id: pet.id, pet_name: petName, field: 'service_id', error: `${service.name} is temporarily unavailable for online booking. Choose another service for ${petName}.` });
        return null;
      }
      if (!isServiceAvailableForSpecies(service, pet.species)) {
        const offered = describeSpecies(service.species || []);
        itemErrors.push({ position, pet_id: pet.id, pet_name: petName, field: 'service_id', error: offered
          ? `${service.name} is offered for ${offered} only. Choose another service for ${petName}.`
          : `The clinic has not confirmed which pets ${service.name} is for. Choose another service for ${petName}.` });
        return null;
      }
      return { pet, service, petName };
    });
    if (itemErrors.length) {
      return badRequest(itemErrors.length === 1 ? itemErrors[0].error : 'Some pets need a different service before this booking can be sent.', { item_errors: itemErrors });
    }

    const startMinutes = parseAppointmentTime(appointmentTime).hours * 60 + parseAppointmentTime(appointmentTime).minutes;
    const totalMinutes = resolved.reduce((sum, entry) => sum + entry.service.duration_minutes, 0);
    if (startMinutes + totalMinutes > DAY_MINUTES) {
      return badRequest(`These services take ${totalMinutes} minutes in total, which would run past midnight. Choose an earlier start time or book fewer pets.`, { field: 'appointment_time' });
    }

    const rpcItems = resolved.map(entry => ({
      pet_id: String(entry.pet.id),
      service_id: String(entry.service.id),
      service_type: entry.service.name,
      duration_minutes: entry.service.duration_minutes
    }));
    const { data, error } = await appointmentsRepository.createGroupIfAvailable({
      userId,
      appointmentDate,
      startTime: appointmentTime,
      requestKey: buildRequestKey(userId, appointmentDate, appointmentTime, items),
      items: rpcItems
    });

    if (error) {
      if (['PGRST202', '42883'].includes(String(error.code || ''))) {
        return { statusCode: 503, body: { success: false, error: 'Booking several pets at once is unavailable until the clinic finishes an update. Please book each pet separately for now.' } };
      }
      if (String(error.code || '') === '22023') return badRequest('The booking request is invalid. Refresh the page and try again.');
      throw error;
    }

    const position = Number(data?.position) || null;
    const affected = position ? resolved[position - 1] : null;
    if (data?.outcome === 'conflict') {
      const slotStart = startMinutes + resolved.slice(0, position - 1).reduce((sum, entry) => sum + entry.service.duration_minutes, 0);
      return { statusCode: 409, body: {
        success: false,
        error: `${SCHEDULE_CONFLICT_MESSAGE} ${affected.petName}'s ${affected.service.name} (from ${displayClock(slotStart)}) overlaps another appointment. Choose another start time; your pets and services are kept.`,
        position,
        pet_id: String(affected.pet.id),
        suggested_time: await suggestGroupStart(appointmentDate, startMinutes, totalMinutes)
      } };
    }
    if (['service_changed', 'species_not_offered', 'pet_not_found'].includes(data?.outcome)) {
      const message = data.outcome === 'pet_not_found'
        ? 'This pet is not on your account.'
        : `${affected.service.name} changed or is no longer available for ${affected.petName}. Choose another service for ${affected.petName}.`;
      return { statusCode: 409, body: { success: false, error: message, item_errors: [{
        position, pet_id: String(affected.pet.id), pet_name: affected.petName, field: data.outcome === 'pet_not_found' ? 'pet_id' : 'service_id', error: message
      }] } };
    }
    if (data?.outcome === 'past_end_of_day') {
      return badRequest('This booking would run past midnight. Choose an earlier start time.', { field: 'appointment_time' });
    }
    if (!['created', 'existing'].includes(data?.outcome) || !data.group_id) {
      console.error('Group booking returned an unexpected result.');
      return { statusCode: 500, body: { success: false, error: 'Failed to create the booking.' } };
    }

    const booking = await loadGroupForOwner(data.group_id, userId);
    if (data.outcome === 'existing') {
      return { statusCode: 200, body: { success: true, already_booked: true, ...booking } };
    }
    await logUserActivity(userId, 'appointment_booked',
      `Requested one booking for ${resolved.length} pets: ${resolved.map(entry => `${entry.service.name} for ${entry.petName}`).join(', ')}`);
    return { statusCode: 201, body: { success: true, ...booking } };
  } catch (error) {
    console.error('Create group booking error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Server error' } };
  }
};

// POST /admin/appointment-groups/:id/cancel: every Pending or Approved pet appointment of the booking becomes Cancelled
// (by the clinic) in one transaction; Completed and already-cancelled pets are left as they are. Each cancelled pet's
// owner email is sent and logged per appointment, as for a single cancellation.
const cancelAppointmentGroup = async (req) => {
  const groupId = trimValue(req.params?.id);
  const adminId = trimValue(req.authUserId);
  if (!isUuid(groupId)) return { statusCode: 404, body: { success: false, error: 'Booking not found.' } };

  try {
    const before = await appointmentsRepository.listByGroupIds([groupId]);
    if (before.error) throw before.error;
    const previous = new Map((before.data || []).map(row => [String(row.id), row]));

    const { data, error } = await appointmentsRepository.cancelGroupByClinic(groupId, adminId);
    if (error) {
      if (['PGRST202', '42883'].includes(String(error.code || ''))) {
        return { statusCode: 503, body: { success: false, error: 'Cancelling a whole booking is unavailable until the clinic finishes an update.' } };
      }
      throw error;
    }
    if (data?.outcome === 'not_found') return { statusCode: 404, body: { success: false, error: 'Booking not found.' } };
    if (data?.outcome === 'nothing_to_cancel') {
      return { statusCode: 409, body: { success: false, error: 'Every pet in this booking is already completed or cancelled, so nothing was changed.' } };
    }
    const cancelledIds = (Array.isArray(data?.appointment_ids) ? data.appointment_ids : []).map(String);

    for (const id of cancelledIds) {
      const row = previous.get(id);
      await logAdminActivity(adminId, 'appointments', id,
        `Updated appointment status from ${row?.status || 'Pending'} to Cancelled (whole booking cancelled)`);
      if (row) appointmentNotificationsService.notifyAppointmentStatusChanged(row, { previousStatus: row.status, newStatus: 'Cancelled' });
    }

    const after = await appointmentsRepository.listByGroupIds([groupId]);
    const rows = after.error ? [] : after.data || [];
    return { statusCode: 200, body: {
      success: true,
      cancelled_appointment_ids: cancelledIds,
      unchanged: rows.filter(row => !cancelledIds.includes(String(row.id))).map(row => ({ id: row.id, pet_name: row.pet_name, status: row.status })),
      appointments: rows
    } };
  } catch (error) {
    console.error('Cancel group booking error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not cancel this booking.' } };
  }
};

module.exports = {
  createAppointmentGroup,
  cancelAppointmentGroup,
  buildRequestKey,
  describeGroup
};
