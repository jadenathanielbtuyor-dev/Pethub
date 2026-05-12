const supabase = require('../config/supabase');

const APPOINTMENT_SELECT = 'id, user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status, handled_by, created_at';
const SERVICE_DURATIONS_MINUTES = Object.freeze({
  Checkup: 45,
  Vaccination: 30,
  Grooming: 240,
  'Dental Cleaning': 60,
  Surgery: 180,
  Other: 30
});
const INVALID_APPOINTMENT_DATE_MESSAGE = 'Enter a valid appointment date.';
const INVALID_APPOINTMENT_TIME_MESSAGE = 'Enter a valid appointment time.';
const PAST_APPOINTMENT_DATE_MESSAGE = 'Appointment date cannot be in the past.';
const PAST_APPOINTMENT_TIME_MESSAGE = 'Appointment time must be later than the current time when booking for today.';
const SCHEDULE_CONFLICT_MESSAGE = 'Selected time is unavailable.';
const OCCUPIED_APPOINTMENT_STATUSES = new Set(['approved', 'completed']);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function isUserVerified(userId) {
  if (!hasValue(userId)) return false;

  const { data, error } = await supabase
    .from('email_verifications')
    .select('id')
    .eq('user_id', String(userId))
    .eq('is_verified', true)
    .limit(1);

  if (error) {
    throw error;
  }
  return Array.isArray(data) && data.length > 0;
}

async function isAdminVerified(adminId) {
  if (!hasValue(adminId)) return false;

  const normalizedAdminId = String(adminId).trim();
  const { data: users, error } = await supabase
    .from('users')
    .select('id, role, is_verified')
    .eq('id', normalizedAdminId)
    .limit(1);

  if (error) {
    throw error;
  }

  if (!Array.isArray(users) || users.length === 0) return false;

  const admin = users[0];
  if (String(admin.role || '').toLowerCase() !== 'admin') return false;
  if (isVerifiedValue(admin.is_verified)) return true;

  const { data: verifiedRows, error: verificationError } = await supabase
    .from('email_verifications')
    .select('id')
    .eq('user_id', normalizedAdminId)
    .eq('is_verified', true)
    .limit(1);

  if (verificationError) {
    throw verificationError;
  }

  return Array.isArray(verifiedRows) && verifiedRows.length > 0;
}

async function getUserPetById(userId, petId) {
  if (!hasValue(userId) || !hasValue(petId)) return null;

  const { data, error } = await supabase
    .from('pets')
    .select('id, user_id, name')
    .eq('id', String(petId))
    .eq('user_id', String(userId))
    .limit(1);

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function getLocalDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

function getAppointmentTimeRange(appointmentDate, appointmentTime, estimatedDurationMinutes) {
  const normalizedDate = normalizeAppointmentDate(appointmentDate);
  const parsedTime = parseAppointmentTime(appointmentTime);
  const durationMinutes = normalizeDurationMinutes(estimatedDurationMinutes);
  if (!normalizedDate || !parsedTime || !durationMinutes) return null;

  const startMs = ((parsedTime.hours * 60 + parsedTime.minutes) * 60 + parsedTime.seconds) * 1000;
  const endMs = startMs + durationMinutes * 60000;
  return { date: normalizedDate, startMs, endMs };
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

  const { data: appointments, error } = await supabase
    .from('appointments')
    .select('id, appointment_date, appointment_time, estimated_duration_minutes, status')
    .eq('appointment_date', requestedRange.date);

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

async function attachHandledByNames(appointments) {
  const list = Array.isArray(appointments) ? appointments : [];
  const handlerIds = [...new Set(list.map(apt => apt && apt.handled_by).filter(Boolean).map(String))];

  if (handlerIds.length === 0) {
    return list.map(apt => ({ ...apt, handled_by_name: null }));
  }

  const { data: admins, error } = await supabase
    .from('users')
    .select('id, fullname')
    .in('id', handlerIds);

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

async function logAdminActivity(adminId, targetTable, targetId, action) {
  if (!hasValue(adminId) || !hasValue(targetTable) || !hasValue(targetId) || !hasValue(action)) {
    console.warn(`Skipping activity log for ${action}: missing admin user id.`);
    return;
  }

  try {
    const { error } = await supabase
      .from('activity_logs')
      .insert([{
        actor_id: String(adminId),
        user_id: String(adminId),
        target_table: String(targetTable).trim(),
        target_id: String(targetId),
        action: String(action).trim()
      }]);

    if (error) {
      console.warn(`Failed to store activity log for ${action}:`, error);
    }
  } catch (error) {
    console.warn(`Failed to store activity log for ${action}:`, error);
  }
}

/**
 * Create a new appointment
 */
const createAppointment = async (req, res) => {
  try {
    const { user_id, pet_id, service_type, appointment_date, appointment_time } = req.body || {};
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';
    const normalizedPetId = hasValue(pet_id) ? String(pet_id).trim() : '';
    const serviceType = hasValue(service_type) ? String(service_type).trim() : '';

    if (!normalizedUserId || !normalizedPetId || !serviceType || !hasValue(appointment_date) || !hasValue(appointment_time)) {
      return res.status(400).json({ error: 'All appointment fields are required' });
    }

    const estimatedDurationMinutes = getExactServiceDurationMinutes(serviceType);
    if (!Number.isFinite(estimatedDurationMinutes)) {
      return res.status(400).json({ error: 'Select a valid service type.' });
    }

    const appointmentDateTimeError = getAppointmentDateTimeValidationError(appointment_date, appointment_time);
    if (appointmentDateTimeError) {
      return res.status(400).json({ error: appointmentDateTimeError });
    }

    const normalizedAppointmentDate = normalizeAppointmentDate(appointment_date);
    const normalizedAppointmentTime = normalizeAppointmentTime(appointment_time);

    const verified = await isUserVerified(normalizedUserId);
    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing PetHub appointments.' });
    }

    const pet = await getUserPetById(normalizedUserId, normalizedPetId);
    if (!pet) {
      return res.status(404).json({ error: 'Selected pet was not found for this user.' });
    }

    const petName = String(pet.name || '').trim();
    if (!petName) {
      return res.status(400).json({ error: 'Selected pet does not have a valid name.' });
    }

    const conflict = await getScheduleConflict(
      normalizedAppointmentDate,
      normalizedAppointmentTime,
      estimatedDurationMinutes
    );
    if (conflict.hasConflict) {
      return res.status(400).json({
        error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
        suggested_time: conflict.suggested_time || null
      });
    }

    const { data, error } = await supabase
      .from('appointments')
      .insert([{
        user_id: normalizedUserId,
        pet_id: String(pet.id),
        pet_name: petName,
        service_type: serviceType,
        estimated_duration_minutes: estimatedDurationMinutes,
        appointment_date: normalizedAppointmentDate,
        appointment_time: normalizedAppointmentTime,
        status: 'Pending'
      }])
      .select(APPOINTMENT_SELECT);

    if (error) {
      console.error('Error creating appointment:', error);
      return res.status(500).json({ error: 'Failed to create appointment' });
    }

    res.status(201).json({ success: true, appointment: data[0] });
  } catch (error) {
    console.error('Create appointment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all appointments for a specific user
 */
const getUserAppointments = async (req, res) => {
  try {
    const { user_id } = req.query;
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';

    if (!normalizedUserId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const verified = await isUserVerified(normalizedUserId);
    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing PetHub appointments.' });
    }

    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('user_id', normalizedUserId)
      .order('appointment_date', { ascending: true });

    if (error) {
      console.error('Error fetching user appointments:', error);
      return res.status(500).json({ error: 'Failed to fetch appointments' });
    }

    const appointmentsWithHandlers = await attachHandledByNames(appointments || []);
    res.json({ success: true, appointments: appointmentsWithHandlers });
  } catch (error) {
    console.error('Get user appointments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all appointments (admin only)
 */
const getAllAppointments = async (req, res) => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .order('appointment_date', { ascending: true });

    if (error) {
      console.error('Error fetching all appointments:', error);
      return res.status(500).json({ error: 'Failed to fetch appointments' });
    }

    const appointmentsWithHandlers = await attachHandledByNames(appointments || []);
    res.json({ success: true, appointments: appointmentsWithHandlers });
  } catch (error) {
    console.error('Get all appointments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update appointment status (admin only)
 */
const updateStatus = async (req, res) => {
  try {
    const { id, status, user_id } = req.body || {};
    const normalizedAppointmentId = hasValue(id) ? String(id).trim() : '';
    const normalizedStatus = hasValue(status) ? String(status).trim() : '';
    const admin_id = hasValue(user_id) ? user_id : (req.headers['x-user-id'] || req.query?.user_id);
    const normalizedAdminId = hasValue(admin_id) ? String(admin_id).trim() : '';

    if (!normalizedAppointmentId || !normalizedStatus) {
      return res.status(400).json({ error: 'id and status are required' });
    }

    const validStatus = ['Pending', 'Approved', 'Completed', 'Cancelled'];
    if (!validStatus.includes(normalizedStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (!normalizedAdminId) {
      return res.status(400).json({ error: 'Admin user ID is required' });
    }

    const adminVerified = await isAdminVerified(normalizedAdminId);
    if (!adminVerified) {
      return res.status(403).json({ error: 'Admin access denied' });
    }

    const { data: existingAppointment, error: existingError } = await supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', normalizedAppointmentId)
      .maybeSingle();

    if (existingError) {
      console.error('Error loading appointment:', existingError);
      return res.status(500).json({ error: 'Failed to load appointment' });
    }

    if (!existingAppointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const currentStatus = existingAppointment.status;
    const allowedTransitions = {
      Pending: ['Approved', 'Cancelled'],
      Approved: ['Completed', 'Cancelled'],
      Completed: [],
      Cancelled: []
    };

    if (currentStatus === normalizedStatus) {
      return res.json({ success: true, message: 'Status updated', appointment: existingAppointment });
    }

    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Cannot change appointment from ${currentStatus || 'unknown'} to ${normalizedStatus}.`
      });
    }

    if (normalizedStatus === 'Approved') {
      const conflict = await getScheduleConflict(
        existingAppointment.appointment_date,
        existingAppointment.appointment_time,
        existingAppointment.estimated_duration_minutes,
        normalizedAppointmentId
      );

      if (conflict.hasConflict) {
        return res.status(409).json({
          error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
          suggested_time: conflict.suggested_time || null
        });
      }
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ status: normalizedStatus, handled_by: normalizedAdminId })
      .eq('id', normalizedAppointmentId)
      .select(APPOINTMENT_SELECT);

    if (error) {
      console.error('Error updating appointment:', error);
      return res.status(500).json({ error: 'Failed to update appointment' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await logAdminActivity(normalizedAdminId, 'appointments', normalizedAppointmentId, `Updated appointment status to ${normalizedStatus}`);

    res.json({ success: true, message: 'Status updated', appointment: data[0] });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { createAppointment, getUserAppointments, getAllAppointments, updateStatus };
