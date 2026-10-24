// ==================== ADMIN SERVICE ====================

const {
  hasValue
} = require('../validators/commonValidator');
const {
  SCHEDULE_CONFLICT_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  getAppointmentTimeRange,
  getClinicDateValue,
  getAppointmentStartTimestamp,
  validateAdminAppointmentStatusRequest
} = require('../validators/appointmentsValidator');
const { runExclusive } = require('../utils/keyedLock');
const { validateAdminMedicalRecord } = require('../validators/medicalRecordsValidator');
const { getVerifiedTotals } = require('../utils/accountVerification');
const {
  getAdminActorId,
  logAdminActivity: storeAdminActivity
} = require('../utils/activityLogger');
const {
  buildMedicalRecordContext,
  getMedicalRecordSummary,
  getAppointmentIdFromMedicalRecordAction,
  applyMedicalRecordStateToAppointments
} = require('../utils/medicalRecords');
const { MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION } = require('../constants/activityActions');
const usersRepository = require('../repositories/usersRepository');
const emailVerificationsRepository = require('../repositories/emailVerificationsRepository');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const medicalRecordsRepository = require('../repositories/medicalRecordsRepository');
const activityLogsRepository = require('../repositories/activityLogsRepository');
const emailLogsRepository = require('../repositories/emailLogsRepository');
const appointmentNotificationsService = require('./appointmentNotificationsService');
const careRecommendationService = require('./careRecommendationService');
const { APPOINTMENT_STATUS_CHANGED_MESSAGE } = require('../constants/appointments');
const { countServicesForAnalytics, isCheckupService, normalizeSpecies, isServiceBookable } = require('../utils/serviceCatalog');
const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');

// "Upcoming check-ups" = Pending or Approved check-up appointments (constants/services.js CHECKUP_SERVICE_NAMES) from
// today through today + 7 days (inclusive). Counted from appointments only: medical records describe past visits.
const UPCOMING_CHECKUPS_WINDOW_DAYS = 7;
const UPCOMING_CHECKUPS_STATUSES = ['Pending', 'Approved'];
// GET /admin/system-logs?limit= is capped so one request cannot ask for the whole activity log
const SYSTEM_LOG_MAX_LIMIT = 200;
// ?exclude=sign_ins leaves these out of the activity log view
const SIGN_IN_ACTIONS = Object.freeze(['user_logged_in', 'user_logged_out']);

function getUpcomingCheckupsEndDate(today) {
  const endDate = new Date(`${today}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + UPCOMING_CHECKUPS_WINDOW_DAYS);
  return endDate.toISOString().split('T')[0];
}

// The last `days` clinic (Asia/Manila) dates ending today, oldest first, with chart labels such as "Oct 23".
// Appointment dates are clinic dates, so the server's own timezone must not decide which day "today" is.
function getRecentClinicDates(days) {
  const [year, month, day] = getClinicDateValue().split('-').map(Number);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - (days - 1 - index)));
    return {
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    };
  });
}

async function loadConfiguredServices() {
  const { data, error } = await serviceCatalogRepository.listAll();
  if (error) {
    if (['42P01', 'PGRST205'].includes(String(error.code || ''))) return [];
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

function getCheckupNames(services) {
  return [...new Set([
    ...(services || []).filter(service => service.service_key === 'dog-cat-full-check-up').map(service => service.name),
    'Checkup' // historical appointment label retained for older records
  ])];
}

// Pets per species for the charts: Dog and Cat (the species the clinic serves), and Other for any earlier pet profile
function countPetTypes(pets) {
  const counts = { Dog: 0, Cat: 0, Other: 0 };
  (pets || []).forEach(pet => {
    const species = normalizeSpecies(pet?.species);
    counts[species || 'Other'] += 1;
  });
  return counts;
}

function buildUserNameMap(users) {
  return (Array.isArray(users) ? users : []).reduce((map, user) => {
    if (user && user.id != null) {
      map[String(user.id)] = user.fullname || null;
    }
    return map;
  }, {});
}

function getAppointmentStatusVerb(action) {
  const value = String(action || '').toLowerCase();
  if (value.includes('approved')) return 'approved';
  if (value.includes('cancelled')) return 'cancelled';
  if (value.includes('completed')) return 'completed';
  if (value.includes('pending')) return 'updated';
  return 'updated';
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

function getActiveAppointmentRanges(appointments, excludedAppointmentId = '', includePending = true) {
  const excludedId = String(excludedAppointmentId || '').trim();
  return (appointments || [])
    .filter(appointment => {
      const appointmentId = String(appointment?.id || '').trim();
      const status = String(appointment?.status || '').trim().toLowerCase();
      const occupiesSchedule = OCCUPIED_APPOINTMENT_STATUSES.has(status) && (includePending || status !== 'pending');
      return (!excludedId || appointmentId !== excludedId) && occupiesSchedule;
    })
    .map(appointment => getAppointmentTimeRange(
      appointment.appointment_date,
      appointment.appointment_time,
      appointment.estimated_duration_minutes
    ))
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

async function getAppointmentApprovalConflict(appointment, excludedAppointmentId = '') {
  const requestedRange = getAppointmentTimeRange(
    appointment?.appointment_date,
    appointment?.appointment_time,
    appointment?.estimated_duration_minutes
  );
  if (!requestedRange) return { hasConflict: false };

  const { data: appointments, error } = await appointmentsRepository.listScheduleByDate(requestedRange.date);
  if (error) throw error;

  const conflict = getSuggestedTimeAfterConflict(
    requestedRange,
    getActiveAppointmentRanges(appointments, excludedAppointmentId, false)
  );

  return {
    hasConflict: conflict.hasConflict,
    error: conflict.hasConflict ? SCHEDULE_CONFLICT_MESSAGE : '',
    suggested_time: conflict.suggestedTime
  };
}

function getSystemActionLabel(action, details) {
  const actionKey = String(action || '').trim();
  const labels = {
    user_logged_in: 'signed in',
    user_logged_out: 'signed out',
    user_registered: 'registered an account',
    email_verified: 'verified email',
    pet_created: 'added a pet profile',
    pet_updated: 'updated a pet profile',
    appointment_booked: 'requested an appointment',
    appointment_completed: 'completed an appointment',
    appointment_cancelled: 'cancelled their appointment',
    profile_updated: 'updated profile',
    contact_message: 'sent the clinic a message',
    owner_weight_reported: 'reported a pet weight',
    password_reset_completed: 'reset their password'
  };

  if (labels[actionKey]) return labels[actionKey];
  if (actionKey) return actionKey.replace(/_/g, ' ');
  return String(details || '').trim() || 'system activity recorded';
}

function formatSystemLogDisplayText(log, actorName, affectedUserName) {
  const action = String(log?.action || '').trim();
  const details = String(log?.details || '').trim();
  const actionText = getSystemActionLabel(action, details);
  const actorLabel = actorName ? `Admin ${actorName}` : '';

  if (actorLabel && String(log?.target_table || '').toLowerCase() === 'appointments') {
    const targetText = affectedUserName ? ` for ${affectedUserName}` : '';
    return `${actorLabel} ${getAppointmentStatusVerb(action || details)} appointment${targetText}`;
  }

  if (actorLabel && String(log?.target_table || '').toLowerCase() === 'users') {
    const targetText = affectedUserName ? ` for ${affectedUserName}` : '';
    return `${actorLabel} updated user role${targetText}`;
  }

  if (actorLabel) {
    return `${actorLabel}: ${actionText}`;
  }

  if (affectedUserName) {
    return `${affectedUserName} ${actionText}`;
  }

  return actionText;
}

function normalizeAppointmentNames(appointments, userMap) {
  const names = userMap || {};
  return (Array.isArray(appointments) ? appointments : []).map(apt => ({
    ...apt,
    owner_fullname: names[String(apt.user_id)] || 'Unknown',
    handled_by_name: apt.handled_by ? (names[String(apt.handled_by)] || null) : null,
    // Cancelled by the owner (POST /appointments/cancel/:id) or by the clinic; null when not cancelled or not recorded
    cancelled_by_owner: apt.status === 'Cancelled' && apt.cancelled_by ? String(apt.cancelled_by) === String(apt.user_id) : null,
    cancelled_by_name: apt.cancelled_by ? (names[String(apt.cancelled_by)] || null) : null
  }));
}

// The appointment emails recorded in email_logs, per appointment id: [{ log_id, type, status, sent_at, error }]. A Failed
// one can be sent again from Appointment Management (POST /admin/email-logs/:id/retry). Empty when the log is unreadable.
async function loadAppointmentEmails(appointmentIds) {
  if (!appointmentIds.length) return {};
  const { data, error } = await emailLogsRepository.listByAppointmentIds(appointmentIds);
  if (error) {
    console.warn('Unable to load appointment email deliveries:', { code: error.code || 'unknown' });
    return {};
  }
  return (data || []).reduce((map, log) => {
    const key = String(log.appointment_id);
    (map[key] = map[key] || []).push({
      log_id: log.id,
      type: log.email_type,
      status: log.status,
      sent_at: log.sent_at || null,
      created_at: log.created_at,
      error: log.status === 'Failed' ? log.error_message || null : null
    });
    return map;
  }, {});
}

// records is null when the medical records could not be read: completed appointments are then marked 'unavailable'
// instead of 'none', so the dashboard never offers to add a record that may already exist
function applyMedicalRecordAssociationState(appointments = [], records = [], logs = []) {
  const recordsByAppointment = new Map();
  const unlinkedPetIds = new Set();
  const loggedAppointmentIds = new Set();

  (Array.isArray(records) ? records : []).forEach(record => {
    const appointmentId = String(record?.appointment_id || '').trim();
    const petId = String(record?.pet_id || '').trim();
    if (appointmentId) recordsByAppointment.set(appointmentId, record);
    else if (petId) unlinkedPetIds.add(petId);
  });

  (Array.isArray(logs) ? logs : []).forEach(log => {
    const appointmentId = getAppointmentIdFromMedicalRecordAction(log?.action);
    if (appointmentId) loggedAppointmentIds.add(appointmentId);
  });

  const state = {};
  (Array.isArray(appointments) ? appointments : []).forEach(appointment => {
    if (String(appointment?.status || '').toLowerCase() !== 'completed') return;
    const id = String(appointment.id || '').trim();
    if (!Array.isArray(records)) {
      state[id] = { has_medical_record: false, medical_record_link_status: 'unavailable' };
      return;
    }
    const linkedRecord = recordsByAppointment.get(id);
    if (linkedRecord) {
      state[id] = {
        has_medical_record: true,
        medical_record_link_status: 'linked',
        medical_record_id: linkedRecord.id || null
      };
      return;
    }

    const petId = String(appointment.pet_id || '').trim();
    const unresolved = !Array.isArray(logs) || !petId || unlinkedPetIds.has(petId) || loggedAppointmentIds.has(id);
    state[id] = {
      has_medical_record: false,
      medical_record_link_status: unresolved ? 'unresolved' : 'none'
    };
  });
  return applyMedicalRecordStateToAppointments(appointments, state);
}

async function logAdminActivity(req, targetTable, targetId, action) {
  const adminId = getAdminActorId(req);
  await storeAdminActivity(adminId, targetTable, targetId, action);
}

/**
 * Get dashboard statistics
 * Returns: { totalUsers, totalPets, totalAppointments, pendingAppointments }
 */
const getDashboardStats = async (req) => {
  try {
    // Get all users with verification status (without head: true to get actual data)
    const { data: usersData, error: usersError, count: totalUsers } = await usersRepository.listVerificationStatusesWithCount();

    if (usersError) throw usersError;

    // Get total pets count
    const { count: totalPets, error: petsError } = await petsRepository.countAll();

    if (petsError) throw petsError;

    // Get total appointments count
    const { count: totalAppointments, error: appointmentsError } = await appointmentsRepository.countAll();

    if (appointmentsError) throw appointmentsError;

    // Get pending appointments count and additional admin metrics from Supabase
    const [
      pendingResult,
      completedResult,
      pendingVerificationsResult,
      activityLogsResult,
      medicalRecordsResult
    ] = await Promise.all([
      appointmentsRepository.countByStatus('Pending'),
      appointmentsRepository.countByStatus('Completed'),
      emailVerificationsRepository.countPending(),
      activityLogsRepository.countAll(),
      medicalRecordsRepository.countAll()
    ]);

    if (pendingResult.error) throw pendingResult.error;
    if (completedResult.error) throw completedResult.error;
    if (pendingVerificationsResult.error) throw pendingVerificationsResult.error;
    if (activityLogsResult.error) throw activityLogsResult.error;
    if (medicalRecordsResult.error) console.warn('Unable to load medical records count:', medicalRecordsResult.error);

    const pendingAppointments = pendingResult.count;
    const completedAppointments = completedResult.count;
    const { verifiedUsers, unverifiedUsers } = await getVerifiedTotals(usersData);
    const pendingVerifications = pendingVerificationsResult.count;
    const activityLogCount = activityLogsResult.count;
    const totalMedicalRecords = medicalRecordsResult.error ? null : medicalRecordsResult.count || 0;

    const today = getClinicDateValue();
    const configuredServices = await loadConfiguredServices();
    const { count: upcomingCheckups, error: checkupsError } = await appointmentsRepository.countUpcomingByServices(
      getCheckupNames(configuredServices),
      today,
      getUpcomingCheckupsEndDate(today),
      UPCOMING_CHECKUPS_STATUSES
    );

    if (checkupsError) throw checkupsError;

    const { count: upcomingBookings, error: upcomingError } = await appointmentsRepository.countUpcomingBookings(today);

    if (upcomingError) throw upcomingError;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round(((completedAppointments || 0) / totalAppointments) * 100)
      : 0;

    return { statusCode: 200, body: {
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        totalMedicalRecords
      },
      summary: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        completedAppointments: completedAppointments || 0,
        upcomingCheckups: upcomingCheckups || 0,
        upcomingBookings: upcomingBookings || 0,
        completedAppointmentPercentage,
        verifiedUsers: verifiedUsers || 0,
        unverifiedUsers: unverifiedUsers || 0,
        pendingVerifications: pendingVerifications || 0,
        activityLogCount: activityLogCount || 0,
        totalMedicalRecords
      }
    } };
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch dashboard statistics' } };
  }
};

/**
 * Get analytics summary values for dashboard cards
 */
const getAnalyticsSummary = async (req) => {
  try {
    const { data: usersData, error: usersError, count: totalUsers } = await usersRepository.listVerificationStatusesWithCount();

    if (usersError) throw usersError;

    const { count: totalPets, error: petsError } = await petsRepository.countAll();

    if (petsError) throw petsError;

    const { count: totalAppointments, error: appointmentsError } = await appointmentsRepository.countAll();

    if (appointmentsError) throw appointmentsError;

    const { count: pendingAppointments, error: pendingError } = await appointmentsRepository.countByStatus('Pending');

    if (pendingError) throw pendingError;

    const { count: completedAppointments, error: completedError } = await appointmentsRepository.countByStatus('Completed');

    if (completedError) throw completedError;

    const today = getClinicDateValue();
    const configuredServices = await loadConfiguredServices();
    const { count: upcomingCheckups, error: checkupsError } = await appointmentsRepository.countUpcomingByServices(
      getCheckupNames(configuredServices),
      today,
      getUpcomingCheckupsEndDate(today),
      UPCOMING_CHECKUPS_STATUSES
    );

    if (checkupsError) throw checkupsError;

    const [upcomingBookingsResult, pendingVerificationsResult, activityLogsResult, medicalRecordsResult] = await Promise.all([
      appointmentsRepository.countUpcomingBookings(today),
      emailVerificationsRepository.countPending(),
      activityLogsRepository.countAll(),
      medicalRecordsRepository.countAll()
    ]);

    if (upcomingBookingsResult.error) throw upcomingBookingsResult.error;
    if (pendingVerificationsResult.error) throw pendingVerificationsResult.error;
    if (activityLogsResult.error) throw activityLogsResult.error;
    if (medicalRecordsResult.error) console.warn('Unable to load medical records count:', medicalRecordsResult.error);

    const upcomingBookings = upcomingBookingsResult.count;
    const { verifiedUsers, unverifiedUsers } = await getVerifiedTotals(usersData);
    const pendingVerifications = pendingVerificationsResult.count;
    const activityLogCount = activityLogsResult.count;
    const totalMedicalRecords = medicalRecordsResult.error ? null : medicalRecordsResult.count || 0;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round(((completedAppointments || 0) / totalAppointments) * 100)
      : 0;

    return { statusCode: 200, body: {
      success: true,
      summary: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        completedAppointments: completedAppointments || 0,
        upcomingCheckups: upcomingCheckups || 0,
        upcomingBookings: upcomingBookings || 0,
        completedAppointmentPercentage,
        verifiedUsers: verifiedUsers || 0,
        unverifiedUsers: unverifiedUsers || 0,
        pendingVerifications: pendingVerifications || 0,
        activityLogCount: activityLogCount || 0,
        totalMedicalRecords
      }
    } };
  } catch (error) {
    console.error('Error fetching analytics summary:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch analytics summary' } };
  }
};

/**
 * Get full dashboard overview in a single request
 */
const getDashboardOverview = async (req) => {
  try {
    const today = getClinicDateValue();

    const [usersResult, petsResult, appointmentsResult, servicesResult] = await Promise.all([
      usersRepository.listForDashboardOverview(),
      petsRepository.listAllPets(),
      appointmentsRepository.listAllAppointments(),
      loadConfiguredServices()
    ]);

    if (usersResult.error) throw usersResult.error;
    if (petsResult.error) throw petsResult.error;
    if (appointmentsResult.error) throw appointmentsResult.error;

    const users = usersResult.data || [];
    const pets = petsResult.data || [];
    const appointments = appointmentsResult.data || [];
    const configuredServices = servicesResult || [];

    const { data: medicalRecords, error: medicalRecordsError } = await medicalRecordsRepository.listAllRecords();

    // The rest of the dashboard still loads, but records that could not be read are reported as unavailable, never as zero
    const medicalRecordsAvailable = !medicalRecordsError;
    if (medicalRecordsError) {
      console.warn('Unable to load medical records for dashboard overview:', medicalRecordsError);
    }

    const userMap = buildUserNameMap(users);

    // Get pet names for medical records
    const petIds = [...new Set((medicalRecords || []).map(r => String(r.pet_id)).filter(Boolean))];
    let petNameMap = {};
    if (petIds.length > 0) {
      const { data: petsList } = await petsRepository.listNamesByIds(petIds);
      if (Array.isArray(petsList)) {
        petNameMap = petsList.reduce((map, pet) => {
          map[String(pet.id)] = pet.name || 'Unknown Pet';
          return map;
        }, {});
      }
    }

    const medicalRecordContext = buildMedicalRecordContext(medicalRecords || []);
    const recordCountsByPet = medicalRecordContext.counts;

    const normalizedMedicalRecords = (medicalRecords || []).map(record => ({
      ...record,
      pet_name: petNameMap[String(record.pet_id)] || 'Unknown Pet',
      created_by_name: record.created_by ? userMap[String(record.created_by)] || null : null,
      recorded_by_name: record.created_by ? userMap[String(record.created_by)] || null : null,
      summary: record.medical_notes || '',
      pet_id: record.pet_id,
      record_date: record.record_date
    }));

    const normalizedPets = pets.map(pet => {
      const latestRecord = medicalRecordContext.latestByPet[String(pet.id)];
      return {
        ...pet,
        owner_name: userMap[String(pet.user_id)] || 'Unknown',
        medical_record_count: medicalRecordsAvailable ? recordCountsByPet[String(pet.id)] || 0 : null,
        latest_medical_record_summary: getMedicalRecordSummary(latestRecord),
        latest_medical_record_date: latestRecord?.record_date || latestRecord?.created_at || null
      };
    });

    const { data: legacyMedicalRecordLogs, error: legacyLogsError } = await activityLogsRepository.listCompletedMedicalRecordActions(
      MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION,
      5000
    );
    const normalizedAppointments = applyMedicalRecordAssociationState(
      normalizeAppointmentNames(appointments, userMap),
      medicalRecordsAvailable ? medicalRecords || [] : null,
      legacyLogsError ? null : legacyMedicalRecordLogs || []
    );

    const appointmentEmails = await loadAppointmentEmails(appointments.map(apt => String(apt.id)));

    const totalUsers = users.length;
    const totalPets = pets.length;
    const totalAppointments = appointments.length;
    const pendingAppointments = appointments.filter(apt => apt.status === 'Pending').length;
    const completedAppointments = appointments.filter(apt => apt.status === 'Completed').length;
    const { verifiedUsers, unverifiedUsers } = await getVerifiedTotals(users);

    const [pendingVerificationsResult, activityLogsResult] = await Promise.all([
      emailVerificationsRepository.countPending(),
      activityLogsRepository.countAll()
    ]);

    if (pendingVerificationsResult.error) throw pendingVerificationsResult.error;
    if (activityLogsResult.error) throw activityLogsResult.error;

    const pendingVerifications = pendingVerificationsResult.count;
    const activityLogCount = activityLogsResult.count;

    const upcomingCheckupsEndDate = getUpcomingCheckupsEndDate(today);
    const upcomingCheckups = appointments.filter(apt => {
      const dateKey = apt.appointment_date ? apt.appointment_date.toString().split('T')[0] : null;
      return isCheckupService(apt.service_type, configuredServices) && dateKey && UPCOMING_CHECKUPS_STATUSES.includes(apt.status) &&
        dateKey >= today && dateKey <= upcomingCheckupsEndDate;
    }).length;
    const upcomingBookings = appointments.filter(apt => apt.appointment_date && apt.status !== 'Cancelled' && apt.appointment_date >= today).length;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round((completedAppointments / totalAppointments) * 100)
      : 0;

    const petTypeCounts = countPetTypes(normalizedPets);
    const serviceCounts = countServicesForAnalytics(normalizedAppointments.map(apt => apt.service_type), configuredServices);

    const lastSevenDays = getRecentClinicDates(7);
    const trendLabels = lastSevenDays.map(day => day.label);
    const trendKeys = lastSevenDays.map(day => day.key);
    const trendCounts = trendKeys.reduce((acc, dateKey) => {
      acc[dateKey] = 0;
      return acc;
    }, {});

    normalizedAppointments.forEach(apt => {
      const rawDate = apt.appointment_date ? apt.appointment_date.toString().split('T')[0] : null;
      if (rawDate && trendCounts.hasOwnProperty(rawDate)) {
        trendCounts[rawDate] += 1;
      }
    });

    const appointmentsTrend = {
      labels: trendLabels,
      values: trendKeys.map(dateKey => trendCounts[dateKey] || 0)
    };

    return { statusCode: 200, body: {
      success: true,
      stats: {
        totalUsers,
        totalPets,
        totalAppointments,
        pendingAppointments,
        totalMedicalRecords: medicalRecordsAvailable ? (medicalRecords || []).length : null
      },
      summary: {
        totalUsers,
        totalPets,
        totalAppointments,
        pendingAppointments,
        completedAppointments,
        upcomingCheckups,
        upcomingBookings,
        completedAppointmentPercentage,
        verifiedUsers,
        unverifiedUsers,
        pendingVerifications,
        activityLogCount,
        totalMedicalRecords: medicalRecordsAvailable ? (medicalRecords || []).length : null,
        // Services customers can book online right now, out of the whole catalog (System Management > Services & booking)
        bookableServices: configuredServices.filter(isServiceBookable).length,
        totalServices: configuredServices.length
      },
      users,
      pets: normalizedPets,
      appointments: normalizedAppointments.map(apt => ({ ...apt, emails: appointmentEmails[String(apt.id)] || [] })),
      medicalRecords: normalizedMedicalRecords,
      medicalRecordsAvailable,
      petTypes: {
        labels: Object.keys(petTypeCounts),
        values: Object.values(petTypeCounts)
      },
      services: serviceCounts,
      appointmentsTrend
    } };
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch dashboard overview' } };
  }
};

/**
 * Get pet type distribution data for charts
 */
const getAnalyticsPetTypes = async (req) => {
  try {
    const { data: pets, error } = await petsRepository.listSpecies();

    if (error) throw error;

    const petTypeCounts = countPetTypes(pets);

    return { statusCode: 200, body: {
      success: true,
      labels: Object.keys(petTypeCounts),
      values: Object.values(petTypeCounts)
    } };
  } catch (error) {
    console.error('Error fetching pet types analytics:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch pet types analytics' } };
  }
};

/**
 * Get service usage totals for charts
 */
const getAnalyticsServices = async (req) => {
  try {
    const [{ data: appointments, error }, configuredServices] = await Promise.all([
      appointmentsRepository.listServiceTypes(),
      loadConfiguredServices()
    ]);

    if (error) throw error;

    const { labels, values } = countServicesForAnalytics((appointments || []).map(apt => apt.service_type), configuredServices);

    return { statusCode: 200, body: {
      success: true,
      labels,
      values
    } };
  } catch (error) {
    console.error('Error fetching service usage analytics:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch service usage analytics' } };
  }
};

/**
 * Get appointment trend data for recent days
 */
const getAnalyticsAppointmentsTrend = async (req) => {
  try {
    const lastSevenDays = getRecentClinicDates(7);
    const labels = lastSevenDays.map(day => day.label);
    const dateKeys = lastSevenDays.map(day => day.key);
    const counts = dateKeys.reduce((acc, dateKey) => {
      acc[dateKey] = 0;
      return acc;
    }, {});

    const { data: appointments, error } = await appointmentsRepository.listAppointmentDatesBetween(
      dateKeys[0],
      dateKeys[dateKeys.length - 1]
    );

    if (error) throw error;

    (appointments || []).forEach(apt => {
      const rawDate = apt.appointment_date ? apt.appointment_date.toString().split('T')[0] : null;
      if (rawDate && counts.hasOwnProperty(rawDate)) {
        counts[rawDate] += 1;
      }
    });

    return { statusCode: 200, body: {
      success: true,
      labels,
      values: dateKeys.map(dateKey => counts[dateKey] || 0)
    } };
  } catch (error) {
    console.error('Error fetching appointment trend analytics:', error);
    return { statusCode: 500, body: { error: 'Failed to fetch appointment trend analytics' } };
  }
};

/**
 * Get all users
 */
const getAllUsers = async (req) => {
  try {
    const { data: users, error } = await usersRepository.listAdminUsers();

    if (error) {
      console.error('Error fetching users:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch users' } };
    }

    return { statusCode: 200, body: { success: true, users: users || [] } };
  } catch (error) {
    console.error('Get all users error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Update user role
 * Body: { id, role }
 */
const updateUserRole = async (req) => {
  try {
    const { id, role } = req.body || {};
    const normalizedUserId = hasValue(id) ? String(id).trim() : '';

    if (!normalizedUserId) {
      return { statusCode: 400, body: { success: false, error: 'User id is required' } };
    }

    if (!role || typeof role !== 'string' || !role.trim()) {
      return { statusCode: 400, body: { success: false, error: 'Role is required' } };
    }

    const normalizedRole = role.trim().toLowerCase();
    const allowedRoles = ['user', 'admin'];
    if (!allowedRoles.includes(normalizedRole)) {
      return { statusCode: 400, body: {
        success: false,
        error: `Invalid role. Allowed values are: ${allowedRoles.join(', ')}`
      } };
    }

    // Role changes run one at a time (in this process), so two admins demoting each other at once cannot both pass the
    // last-administrator check below
    const outcome = await runExclusive('user-roles', async () => {
      const { data: existingUser, error: existingError } = await usersRepository.findForRoleUpdate(normalizedUserId);

      if (existingError) {
        console.error('Error loading user for role update:', existingError);
        return { refused: { statusCode: 500, body: { success: false, error: 'Failed to load user' } } };
      }

      if (!existingUser) {
        return { refused: { statusCode: 404, body: { success: false, error: 'User not found' } } };
      }

      if (String(existingUser.role || '').toLowerCase() === normalizedRole) {
        return { refused: { statusCode: 200, body: {
          success: true,
          message: 'User role updated successfully',
          user: existingUser
        } } };
      }

      // PetHub must keep an administrator: demoting the last one (including yourself) would leave nobody able to open
      // the Admin Dashboard, and only a manual database change could undo it
      if (String(existingUser.role || '').toLowerCase() === 'admin') {
        const { count: adminCount, error: countError } = await usersRepository.countByRole('admin');
        if (countError) {
          console.error('Error counting administrators:', countError);
          return { refused: { statusCode: 500, body: { success: false, error: 'Failed to update user role' } } };
        }
        if ((adminCount || 0) <= 1) {
          return { refused: { statusCode: 409, body: {
            success: false,
            error: 'PetHub needs at least one administrator. Make another account an administrator before changing this one.'
          } } };
        }
      }

      const { data, error } = await usersRepository.updateRole(normalizedUserId, normalizedRole);
      return { existingUser, data, error };
    });

    if (outcome.refused) return outcome.refused;

    const { existingUser, data, error } = outcome;

    if (error) {
      console.error('Error updating user role:', error);
      return { statusCode: 500, body: { success: false, error: 'Failed to update user role' } };
    }

    if (!data) {
      return { statusCode: 404, body: { success: false, error: 'User not found' } };
    }

    await logAdminActivity(
      req,
      'users',
      normalizedUserId,
      `Changed user role from ${existingUser.role || 'unknown'} to ${normalizedRole}`
    );

    return { statusCode: 200, body: {
      success: true,
      message: 'User role updated successfully',
      user: data
    } };
  } catch (error) {
    console.error('Update user role error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error' } };
  }
};

/**
 * Get all pets
 */
const getAllPets = async (req) => {
  try {
    const { data: pets, error } = await petsRepository.listAllPets();

    if (error) {
      console.error('Error fetching pets:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch pets' } };
    }

    const petsList = pets || [];
    const userIds = [...new Set(petsList.map(pet => pet.user_id).filter(Boolean))];
    let userMap = {};

    let recordCounts = {};
    let latestRecordsByPet = {};
    if (petsList.length > 0) {
      const petIds = [...new Set(petsList.map(pet => pet.id).filter(Boolean))];
      const { data: records, error: recordsError } = await medicalRecordsRepository.listSummariesByPetIds(petIds);

      if (!recordsError) {
        const recordContext = buildMedicalRecordContext(records || []);
        recordCounts = recordContext.counts;
        latestRecordsByPet = recordContext.latestByPet;
      } else {
        console.warn('Unable to load medical record counts for pets:', recordsError);
      }
    }

    if (userIds.length > 0) {
      const { data: users, error: usersError } = await usersRepository.listNamesByIds(userIds);

      if (usersError) {
        console.error('Error fetching pet owners:', usersError);
      } else {
        userMap = users.reduce((map, user) => {
          map[String(user.id)] = user.fullname || 'Unknown';
          return map;
        }, {});
      }
    }

    const normalizedPets = petsList.map(pet => {
      const latestRecord = latestRecordsByPet[String(pet.id)];
      return {
        ...pet,
        owner_name: userMap[String(pet.user_id)] || null,
        medical_record_count: recordCounts[String(pet.id)] || 0,
        latest_medical_record_summary: getMedicalRecordSummary(latestRecord),
        latest_medical_record_date: latestRecord?.record_date || latestRecord?.created_at || null
      };
    });

    return { statusCode: 200, body: { success: true, pets: normalizedPets } };
  } catch (error) {
    console.error('Get all pets error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Get all appointments
 */
const getAllAppointments = async (req) => {
  try {
    const { data: appointments, error } = await appointmentsRepository.listAllAppointments();

    if (error) {
      console.error('Error fetching appointments:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch appointments' } };
    }

    const appointmentsList = appointments || [];
    const userIds = [
      ...new Set(
        appointmentsList
          .flatMap(apt => [apt.user_id, apt.handled_by])
          .filter(Boolean)
          .map(String)
      )
    ];

    let userMap = {};
    if (userIds.length > 0) {
      const { data: users, error: usersError } = await usersRepository.listNamesByIds(userIds);

      if (usersError) {
        console.error('Error fetching appointment owners:', usersError);
      } else {
        userMap = buildUserNameMap(users);
      }
    }

    const [recordLinks, legacyLogs] = await Promise.all([
      medicalRecordsRepository.listAppointmentLinks(),
      activityLogsRepository.listCompletedMedicalRecordActions(MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION, 5000)
    ]);
    if (recordLinks.error) {
      console.error('Error fetching medical record associations:', recordLinks.error);
      return { statusCode: 500, body: { error: 'Failed to fetch medical record associations' } };
    }
    const normalizedAppointments = applyMedicalRecordAssociationState(
      normalizeAppointmentNames(appointmentsList, userMap),
      recordLinks.data || [],
      legacyLogs.error ? null : legacyLogs.data || []
    );

    return { statusCode: 200, body: { success: true, appointments: normalizedAppointments } };
  } catch (error) {
    console.error('Get all appointments error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Get recent system activity logs
 */
const getSystemLogs = async (req) => {
  try {
    // 20 by default, never more than SYSTEM_LOG_MAX_LIMIT entries per request
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, SYSTEM_LOG_MAX_LIMIT) : 20;
    const excludeActions = String(req.query.exclude || '') === 'sign_ins' ? [...SIGN_IN_ACTIONS] : [];
    const { data: logs, error } = await activityLogsRepository.listRecentSystemLogs(limit, { excludeActions });

    if (error) {
      console.error('Error fetching system logs:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch system logs' } };
    }

    const logsList = logs || [];
    const appointmentIds = [
      ...new Set(
        logsList
          .filter(log => String(log.target_table || '').toLowerCase() === 'appointments' && log.target_id)
          .map(log => String(log.target_id))
      )
    ];
    const targetUserIds = logsList
      .filter(log => String(log.target_table || '').toLowerCase() === 'users' && log.target_id)
      .map(log => String(log.target_id));

    let appointmentUserMap = {};
    if (appointmentIds.length > 0) {
      const { data: appointments, error: appointmentsError } = await appointmentsRepository.listUsersByAppointmentIds(appointmentIds);

      if (appointmentsError) {
        console.warn('Unable to load appointment users for system logs:', appointmentsError);
      } else {
        appointmentUserMap = (appointments || []).reduce((map, appointment) => {
          if (appointment && appointment.id != null && appointment.user_id != null) {
            map[String(appointment.id)] = String(appointment.user_id);
          }
          return map;
        }, {});
      }
    }

    const userIds = [
      ...new Set(
        [
          ...logsList.flatMap(log => [log.actor_id, log.user_id]).filter(Boolean).map(String),
          ...targetUserIds,
          ...Object.values(appointmentUserMap)
        ]
      )
    ];

    let userMap = {};
    if (userIds.length > 0) {
      const { data: users, error: usersError } = await usersRepository.listNamesByIds(userIds);

      if (usersError) {
        console.warn('Unable to load user names for system logs:', usersError);
      } else {
        userMap = buildUserNameMap(users);
      }
    }

    const formattedLogs = logsList.map(log => {
      const targetTable = String(log.target_table || '').toLowerCase();
      const appointmentUserId = targetTable === 'appointments' ? appointmentUserMap[String(log.target_id)] : null;
      const targetUserId = targetTable === 'users' && log.target_id ? String(log.target_id) : null;
      const affectedUserId = appointmentUserId || targetUserId || (log.user_id ? String(log.user_id) : null);
      const actorName = log.actor_id ? userMap[String(log.actor_id)] || null : null;
      const affectedUserName = affectedUserId ? userMap[String(affectedUserId)] || null : null;
      const displayText = formatSystemLogDisplayText(log, actorName, affectedUserName);

      return {
        id: log.id,
        actor_id: log.actor_id || null,
        actor_name: actorName,
        user_id: log.user_id || null,
        user_name: log.user_id ? userMap[String(log.user_id)] || null : null,
        affected_user_id: affectedUserId,
        affected_user_name: affectedUserName,
        target_table: log.target_table || null,
        target_id: log.target_id || null,
        action: log.action,
        details: log.details,
        text: `${log.action}${log.details ? ` - ${log.details}` : ''}`,
        display_text: displayText,
        created_at: log.created_at
      };
    });

    return { statusCode: 200, body: { success: true, logs: formattedLogs } };
  } catch (error) {
    console.error('Get system logs error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Update appointment status
 * Body: { id, status }
 */
const updateAppointmentStatus = async (req) => {
  try {
    const adminUserId = getAdminActorId(req);
    const validation = validateAdminAppointmentStatusRequest(req.body, adminUserId);
    if (validation.error) return validation.error;

    const { normalizedAppointmentId, normalizedStatus, normalizedAdminUserId } = validation;

    const { data: existingData, error: existingError } = await appointmentsRepository.findById(normalizedAppointmentId);

    if (existingError) {
      console.error('Error loading appointment:', existingError);
      return { statusCode: 500, body: { error: 'Failed to load appointment' } };
    }

    if (!existingData) {
      return { statusCode: 404, body: { error: 'Appointment not found' } };
    }

    const currentStatus = existingData.status;
    const allowedTransitions = {
      Pending: ['Approved', 'Cancelled'],
      Approved: ['Completed', 'Cancelled'],
      Completed: [],
      Cancelled: []
    };

    if (currentStatus === normalizedStatus) {
      return { statusCode: 200, body: { success: true, appointment: existingData } };
    }

    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(normalizedStatus)) {
      return { statusCode: 400, body: {
        error: `Cannot change appointment from ${currentStatus || 'unknown'} to ${normalizedStatus}.`
      } };
    }

    // Clinic time decides what makes sense: a request is approved only before it starts (the owner would otherwise be
    // emailed an approval for a time already gone) and marked Completed only once its start time has passed. Earlier
    // appointments whose date or time cannot be read are not blocked.
    const startMs = getAppointmentStartTimestamp(existingData.appointment_date, existingData.appointment_time);
    if (Number.isFinite(startMs) && normalizedStatus === 'Approved' && startMs <= Date.now()) {
      return { statusCode: 409, body: {
        error: 'The start time of this appointment has already passed, so it can no longer be approved. Cancel it, or ask the owner to book a new time.',
        code: 'APPOINTMENT_START_PASSED'
      } };
    }
    if (Number.isFinite(startMs) && normalizedStatus === 'Completed' && startMs > Date.now()) {
      return { statusCode: 409, body: {
        error: 'An appointment can be marked Completed only after its scheduled start time.',
        code: 'APPOINTMENT_NOT_STARTED'
      } };
    }

    const applyStatus = async () => {
      if (normalizedStatus === 'Approved') {
        const conflict = await getAppointmentApprovalConflict(existingData, normalizedAppointmentId);
        if (conflict.hasConflict) {
          return { refused: { statusCode: 409, body: {
            error: conflict.error || SCHEDULE_CONFLICT_MESSAGE,
            suggested_time: conflict.suggested_time || null
          } } };
        }

        const reserved = await appointmentsRepository.updateStatusIfAvailable(
          normalizedAppointmentId,
          normalizedStatus,
          normalizedAdminUserId,
          currentStatus
        );
        if (reserved.error) {
          if (['PGRST202', '42883'].includes(String(reserved.error.code || ''))) {
            return { refused: { statusCode: 503, body: { error: 'Secure approval is unavailable until the reviewed database rule is installed.' } } };
          }
          return reserved;
        }
        if (reserved.data?.outcome === 'conflict') {
          return { refused: { statusCode: 409, body: { error: SCHEDULE_CONFLICT_MESSAGE, suggested_time: null } } };
        }
        if (!['updated', 'stale', 'not_found'].includes(reserved.data?.outcome)) {
          return { error: { code: 'PETHUB_UNEXPECTED_APPOINTMENT_STATUS_RESULT' } };
        }
        if (reserved.data.outcome !== 'updated') return { data: [], error: null };

        const updated = await appointmentsRepository.findById(normalizedAppointmentId);
        return { data: updated.data ? [updated.data] : [], error: updated.error };
      }

      return appointmentsRepository.updateStatus(
        normalizedAppointmentId,
        normalizedStatus,
        normalizedAdminUserId,
        currentStatus
      );
    };

    // The database approval function shares the same per-date advisory lock as owner bookings across all instances.
    const outcome = await applyStatus();
    if (outcome.refused) return outcome.refused;

    const { data, error } = outcome;

    if (error) {
      console.error('Error updating appointment:', error);
      return { statusCode: 500, body: { error: 'Failed to update appointment' } };
    }

    if (!data || data.length === 0) {
      // The update only applies while the status is still currentStatus; tell apart "changed meanwhile" and "gone"
      const { data: latest } = await appointmentsRepository.findStatusById(normalizedAppointmentId);
      return latest
        ? { statusCode: 409, body: { error: APPOINTMENT_STATUS_CHANGED_MESSAGE } }
        : { statusCode: 404, body: { error: 'Appointment not found' } };
    }

    await logAdminActivity(
      req,
      'appointments',
      normalizedAppointmentId,
      `Updated appointment status from ${currentStatus} to ${normalizedStatus}`
    );

    // Approving or cancelling emails the customer (in the background; a failed email never undoes the change)
    appointmentNotificationsService.notifyAppointmentStatusChanged(existingData, {
      previousStatus: currentStatus,
      newStatus: normalizedStatus
    });

    // A completed visit records the pet's next-care suggestion (services/careRecommendationService.js); a problem there
    // is logged and never changes the completed status
    const careRecommendation = normalizedStatus === 'Completed'
      ? (await careRecommendationService.recordForCompletedAppointment(data[0])).status
      : null;

    return { statusCode: 200, body: { success: true, appointment: data[0], ...(careRecommendation ? { care_recommendation: careRecommendation } : {}) } };
  } catch (error) {
    console.error('Update appointment status error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

const createMedicalRecord = async (req) => {
  try {
    const adminUserId = getAdminActorId(req);
    const validation = validateAdminMedicalRecord(req.body, adminUserId);
    if (validation.error) return validation.error;

    const {
      normalizedPetId,
      normalizedAppointmentId,
      payload
    } = validation;

    const { data: selectedPet, error: petError } = await petsRepository.findOwnerById(normalizedPetId);

    if (petError) {
      console.error('Error validating pet for medical record:', petError);
      return { statusCode: 500, body: { success: false, error: 'Failed to validate selected pet' } };
    }

    if (!selectedPet) {
      return { statusCode: 404, body: { success: false, error: 'Pet not found' } };
    }

    if (hasValue(normalizedAppointmentId)) {
      const { data: appointment, error: appointmentError } = await appointmentsRepository.findForMedicalRecord(normalizedAppointmentId);

      if (appointmentError) {
        console.error('Error loading appointment for medical record:', appointmentError);
        return { statusCode: 500, body: { success: false, error: 'Failed to load appointment' } };
      }

      if (!appointment) {
        return { statusCode: 404, body: { success: false, error: 'Appointment not found' } };
      }

      if (String(appointment.status || '').toLowerCase() !== 'completed') {
        return { statusCode: 400, body: {
          success: false,
          error: 'Medical records can only be added after an appointment is completed.'
        } };
      }

      if (String(appointment.user_id || '').trim() !== String(selectedPet.user_id || '').trim()) {
        return { statusCode: 400, body: { success: false, error: 'Selected pet does not belong to the appointment owner.' } };
      }

      if (!hasValue(appointment.pet_id)) {
        return { statusCode: 409, body: {
          success: false,
          error: 'This appointment is not linked to a pet profile. Review the appointment and pet records before associating them.'
        } };
      }

      if (String(appointment.pet_id).trim() !== normalizedPetId) {
        return { statusCode: 400, body: { success: false, error: 'Selected pet does not match the appointment pet.' } };
      }

      const { data: petRecords, error: petRecordsError } = await medicalRecordsRepository.listByPetIds([normalizedPetId]);
      if (petRecordsError) {
        console.error('Error checking existing medical records:', petRecordsError);
        return { statusCode: 500, body: { success: false, error: 'Failed to verify existing medical records' } };
      }

      const { data: actionLogs, error: actionLogsError } = await activityLogsRepository.listCompletedMedicalRecordActions(
        MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION,
        5000
      );
      if (actionLogsError) {
        return { statusCode: 503, body: {
          success: false,
          error: 'Historical medical-record links cannot be checked right now. Try again later.'
        } };
      }

      const existingAppointmentRecord = (petRecords || []).some(record => String(record.appointment_id || '') === normalizedAppointmentId);
      if (existingAppointmentRecord) {
        return { statusCode: 409, body: {
          success: false,
          error: 'A medical record has already been added for this appointment.'
        } };
      }

      const unresolvedLegacyRecord = (petRecords || []).some(record => !record.appointment_id)
        || (actionLogs || []).some(log => getAppointmentIdFromMedicalRecordAction(log.action) === normalizedAppointmentId);
      if (unresolvedLegacyRecord) {
        return { statusCode: 409, body: {
          success: false,
          code: 'MEDICAL_RECORD_LINK_UNRESOLVED',
          error: 'This pet has an existing unlinked medical record or a historical association that needs clinic review before a new appointment link can be saved.'
        } };
      }
    }

    const { data, error } = await medicalRecordsRepository.createMedicalRecord(payload);

    if (error) {
      if (error.code === '23505' && normalizedAppointmentId) {
        return { statusCode: 409, body: {
          success: false,
          error: 'A medical record has already been linked to this appointment.'
        } };
      }
      console.error('Failed to create admin medical record:', error);
      return { statusCode: 500, body: {
        success: false,
        error: 'Failed to create medical record. Please try again.'
      } };
    }

    const record = Array.isArray(data) ? data[0] : null;

    await logAdminActivity(
      req,
      'medical_records',
      record?.id || normalizedPetId,
      `Created official medical record for pet ${normalizedPetId}${normalizedAppointmentId ? ` linked to appointment ${normalizedAppointmentId}` : ''}`
    );

    return { statusCode: 201, body: {
      success: true,
      message: 'Medical record created successfully',
      record
    } };
  } catch (error) {
    console.error('Create admin medical record error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error while creating medical record' } };
  }
};

module.exports = {
  getDashboardStats,
  getDashboardOverview,
  getAnalyticsSummary,
  getAnalyticsPetTypes,
  getAnalyticsServices,
  getAnalyticsAppointmentsTrend,
  getSystemLogs,
  getAllUsers,
  getAllPets,
  getAllAppointments,
  createMedicalRecord,
  updateAppointmentStatus,
  updateUserRole
};
