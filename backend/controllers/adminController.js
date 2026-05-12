// ==================== ADMIN CONTROLLER ====================

const supabase = require('../config/supabase');

const APPOINTMENT_SELECT = 'id, user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status, handled_by, created_at';
const MEDICAL_RECORD_SELECT = 'id, pet_id, record_date, created_at, created_by, weight, vaccination_status, treatment, medical_notes';
const MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION = 'Created medical record for completed appointment';

function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function getVerifiedTotals(users) {
  const verifiedIds = new Set();
  const allUsers = Array.isArray(users) ? users : [];

  allUsers.forEach(user => {
    if (user && user.id != null && isVerifiedValue(user.is_verified)) {
      verifiedIds.add(String(user.id));
    }
  });

  const { data: verifiedRows, error: verifiedError } = await supabase
    .from('email_verifications')
    .select('user_id')
    .eq('is_verified', true);

  if (!verifiedError && Array.isArray(verifiedRows)) {
    verifiedRows.forEach(row => {
      if (row && row.user_id != null) {
        verifiedIds.add(String(row.user_id));
      }
    });
  }

  const verifiedUsers = verifiedIds.size;
  const unverifiedUsers = allUsers.filter(user => !verifiedIds.has(String(user.id))).length;
  return { verifiedUsers, unverifiedUsers };
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

function getSystemActionLabel(action, details) {
  const actionKey = String(action || '').trim();
  const labels = {
    user_logged_in: 'signed in',
    user_registered: 'registered an account',
    email_verified: 'verified email',
    pet_created: 'added a pet profile',
    pet_updated: 'updated a pet profile',
    appointment_booked: 'booked an appointment',
    appointment_completed: 'completed an appointment',
    appointment_cancelled: 'cancelled an appointment',
    profile_updated: 'updated profile',
    contact_message: 'submitted a contact message'
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
    handled_by_name: apt.handled_by ? (names[String(apt.handled_by)] || null) : null
  }));
}

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

function getAppointmentIdFromMedicalRecordAction(action) {
  const match = String(action || '').match(/completed appointment\s+([^\s]+)/i);
  return match ? match[1].replace(/[.,;:]+$/, '') : '';
}

function getMedicalRecordCompletedAppointmentAction(appointmentId) {
  return `${MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION} ${String(appointmentId || '').trim()}`;
}

async function getCompletedMedicalRecordAppointmentState(appointmentIds = []) {
  const requestedIds = new Set((Array.isArray(appointmentIds) ? appointmentIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean));

  try {
    const { data: logs, error } = await supabase
      .from('activity_logs')
      .select('id, target_id, action, created_at')
      .eq('target_table', 'medical_records')
      .ilike('action', `${MEDICAL_RECORD_COMPLETED_APPOINTMENT_ACTION}%`)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (error) {
      console.warn('Unable to load completed medical record action state:', error);
      return {};
    }

    return (logs || []).reduce((state, log) => {
      const appointmentId = getAppointmentIdFromMedicalRecordAction(log.action);
      if (!appointmentId || (requestedIds.size && !requestedIds.has(appointmentId))) {
        return state;
      }

      if (!state[appointmentId]) {
        state[appointmentId] = {
          has_medical_record: true,
          medical_record_action_completed: true,
          medical_record_id: log.target_id || null,
          medical_record_log_id: log.id || null
        };
      }
      return state;
    }, {});
  } catch (error) {
    console.warn('Unable to load completed medical record action state:', error);
    return {};
  }
}

function applyMedicalRecordStateToAppointments(appointments, medicalRecordState = {}) {
  return (Array.isArray(appointments) ? appointments : []).map(appointment => {
    const state = medicalRecordState[String(appointment?.id || '').trim()];
    return state ? { ...appointment, ...state } : appointment;
  });
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

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getLocalDateValue() {
  const now = new Date();
  const timezoneOffsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

function normalizeRecordDateValue(value) {
  if (!hasValue(value)) return getLocalDateValue();

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

function getAdminActorId(req) {
  return req.query?.user_id || req.headers['x-user-id'] || req.body?.user_id;
}

async function logAdminActivity(req, targetTable, targetId, action) {
  const adminId = getAdminActorId(req);
  if (!hasValue(adminId) || !hasValue(targetTable) || !hasValue(targetId) || !hasValue(action)) {
    console.warn(`Skipping activity log for ${action}: missing admin user id.`);
    return;
  }

  try {
    const { error } = await supabase
      .from('activity_logs')
      .insert([{
        actor_id: String(adminId).trim(),
        user_id: String(adminId).trim(),
        target_table: String(targetTable).trim(),
        target_id: String(targetId).trim(),
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
 * Get dashboard statistics
 * Returns: { totalUsers, totalPets, totalAppointments, pendingAppointments }
 */
const getDashboardStats = async (req, res) => {
  try {
    // Get all users with verification status (without head: true to get actual data)
    const { data: usersData, error: usersError, count: totalUsers } = await supabase
      .from('users')
      .select('id, is_verified', { count: 'exact' });

    if (usersError) throw usersError;

    // Get total pets count
    const { count: totalPets, error: petsError } = await supabase
      .from('pets')
      .select('id', { count: 'exact', head: true });

    if (petsError) throw petsError;

    // Get total appointments count
    const { count: totalAppointments, error: appointmentsError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true });

    if (appointmentsError) throw appointmentsError;

    // Get pending appointments count and additional admin metrics from Supabase
    const [
      pendingResult,
      completedResult,
      pendingVerificationsResult,
      activityLogsResult,
      medicalRecordsResult
    ] = await Promise.all([
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Pending'),
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Completed'),
      supabase
        .from('email_verifications')
        .select('id', { count: 'exact', head: true })
        .eq('is_verified', false),
      supabase
        .from('activity_logs')
        .select('id', { count: 'exact', head: true }),
      supabase
        .from('medical_records')
        .select('id', { count: 'exact', head: true })
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
    const totalMedicalRecords = medicalRecordsResult.count || 0;

    const today = new Date().toISOString().split('T')[0];
    const { count: vaccinationsDueSoon, error: vaccinationsError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .ilike('service_type', '%Vaccination%')
      .gte('appointment_date', today)
      .neq('status', 'Cancelled');

    if (vaccinationsError) throw vaccinationsError;

    const { count: upcomingBookings, error: upcomingError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .gte('appointment_date', today)
      .neq('status', 'Cancelled');

    if (upcomingError) throw upcomingError;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round(((completedAppointments || 0) / totalAppointments) * 100)
      : 0;

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        totalMedicalRecords: totalMedicalRecords || 0
      },
      summary: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        completedAppointments: completedAppointments || 0,
        vaccinationsDueSoon: vaccinationsDueSoon || 0,
        upcomingBookings: upcomingBookings || 0,
        completedAppointmentPercentage,
        verifiedUsers: verifiedUsers || 0,
        unverifiedUsers: unverifiedUsers || 0,
        pendingVerifications: pendingVerifications || 0,
        activityLogCount: activityLogCount || 0,
        totalMedicalRecords: totalMedicalRecords || 0
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
};

/**
 * Get analytics summary values for dashboard cards
 */
const getAnalyticsSummary = async (req, res) => {
  try {
    const { data: usersData, error: usersError, count: totalUsers } = await supabase
      .from('users')
      .select('id, is_verified', { count: 'exact' });

    if (usersError) throw usersError;

    const { count: totalPets, error: petsError } = await supabase
      .from('pets')
      .select('id', { count: 'exact', head: true });

    if (petsError) throw petsError;

    const { count: totalAppointments, error: appointmentsError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true });

    if (appointmentsError) throw appointmentsError;

    const { count: pendingAppointments, error: pendingError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'Pending');

    if (pendingError) throw pendingError;

    const { count: completedAppointments, error: completedError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'Completed');

    if (completedError) throw completedError;

    const today = new Date().toISOString().split('T')[0];
    const { count: vaccinationsDueSoon, error: vaccinationsError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .ilike('service_type', '%Vaccination%')
      .gte('appointment_date', today)
      .neq('status', 'Cancelled');

    if (vaccinationsError) throw vaccinationsError;

    const [upcomingBookingsResult, pendingVerificationsResult, activityLogsResult, medicalRecordsResult] = await Promise.all([
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .gte('appointment_date', today)
        .neq('status', 'Cancelled'),
      supabase
        .from('email_verifications')
        .select('id', { count: 'exact', head: true })
        .eq('is_verified', false),
      supabase
        .from('activity_logs')
        .select('id', { count: 'exact', head: true }),
      supabase
        .from('medical_records')
        .select('id', { count: 'exact', head: true })
    ]);

    if (upcomingBookingsResult.error) throw upcomingBookingsResult.error;
    if (pendingVerificationsResult.error) throw pendingVerificationsResult.error;
    if (activityLogsResult.error) throw activityLogsResult.error;
    if (medicalRecordsResult.error) console.warn('Unable to load medical records count:', medicalRecordsResult.error);

    const upcomingBookings = upcomingBookingsResult.count;
    const { verifiedUsers, unverifiedUsers } = await getVerifiedTotals(usersData);
    const pendingVerifications = pendingVerificationsResult.count;
    const activityLogCount = activityLogsResult.count;
    const totalMedicalRecords = medicalRecordsResult.count || 0;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round(((completedAppointments || 0) / totalAppointments) * 100)
      : 0;

    res.json({
      success: true,
      summary: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalAppointments: totalAppointments || 0,
        pendingAppointments: pendingAppointments || 0,
        completedAppointments: completedAppointments || 0,
        vaccinationsDueSoon: vaccinationsDueSoon || 0,
        upcomingBookings: upcomingBookings || 0,
        completedAppointmentPercentage,
        verifiedUsers: verifiedUsers || 0,
        unverifiedUsers: unverifiedUsers || 0,
        pendingVerifications: pendingVerifications || 0,
        activityLogCount: activityLogCount || 0,
        totalMedicalRecords: totalMedicalRecords || 0
      }
    });
  } catch (error) {
    console.error('Error fetching analytics summary:', error);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
};

/**
 * Get full dashboard overview in a single request
 */
const getDashboardOverview = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [usersResult, petsResult, appointmentsResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, fullname, email, role, is_verified, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('pets')
        .select('id, user_id, name, species, breed, age, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('appointments')
        .select(APPOINTMENT_SELECT)
        .order('appointment_date', { ascending: true })
    ]);

    if (usersResult.error) throw usersResult.error;
    if (petsResult.error) throw petsResult.error;
    if (appointmentsResult.error) throw appointmentsResult.error;

    const users = usersResult.data || [];
    const pets = petsResult.data || [];
    const appointments = appointmentsResult.data || [];

    const { data: medicalRecords, error: medicalRecordsError } = await supabase
      .from('medical_records')
      .select(MEDICAL_RECORD_SELECT)
      .order('record_date', { ascending: false });

    if (medicalRecordsError) {
      console.warn('Unable to load medical records for dashboard overview:', medicalRecordsError);
    }

    const userMap = buildUserNameMap(users);

    // Get pet names for medical records
    const petIds = [...new Set((medicalRecords || []).map(r => String(r.pet_id)).filter(Boolean))];
    let petNameMap = {};
    if (petIds.length > 0) {
      const { data: petsList } = await supabase
        .from('pets')
        .select('id, name')
        .in('id', petIds);
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
        medical_record_count: recordCountsByPet[String(pet.id)] || 0,
        latest_medical_record_summary: getMedicalRecordSummary(latestRecord),
        latest_medical_record_date: latestRecord?.record_date || latestRecord?.created_at || null
      };
    });

    const appointmentMedicalRecordState = await getCompletedMedicalRecordAppointmentState(
      appointments.map(appointment => appointment.id)
    );
    const normalizedAppointments = applyMedicalRecordStateToAppointments(
      normalizeAppointmentNames(appointments, userMap),
      appointmentMedicalRecordState
    );

    const totalUsers = users.length;
    const totalPets = pets.length;
    const totalAppointments = appointments.length;
    const pendingAppointments = appointments.filter(apt => apt.status === 'Pending').length;
    const completedAppointments = appointments.filter(apt => apt.status === 'Completed').length;
    const { verifiedUsers, unverifiedUsers } = await getVerifiedTotals(users);

    const [pendingVerificationsResult, activityLogsResult] = await Promise.all([
      supabase
        .from('email_verifications')
        .select('id', { count: 'exact', head: true })
        .eq('is_verified', false),
      supabase
        .from('activity_logs')
        .select('id', { count: 'exact', head: true })
    ]);

    if (pendingVerificationsResult.error) throw pendingVerificationsResult.error;
    if (activityLogsResult.error) throw activityLogsResult.error;

    const pendingVerifications = pendingVerificationsResult.count;
    const activityLogCount = activityLogsResult.count;

    const vaccinationsDueSoon = appointments.filter(apt => {
      const service = (apt.service_type || '').toString().toLowerCase();
      return service.includes('vaccination') && apt.appointment_date && apt.status !== 'Cancelled' && apt.appointment_date >= today;
    }).length;
    const upcomingBookings = appointments.filter(apt => apt.appointment_date && apt.status !== 'Cancelled' && apt.appointment_date >= today).length;

    const completedAppointmentPercentage = totalAppointments > 0
      ? Math.round((completedAppointments / totalAppointments) * 100)
      : 0;

    const petTypeCounts = {
      Dog: 0,
      Cat: 0,
      Rabbit: 0,
      Bird: 0,
      Other: 0
    };

    normalizedPets.forEach(pet => {
      const species = (pet.species || 'Other').toString().trim().toLowerCase();
      if (species.includes('dog')) petTypeCounts.Dog += 1;
      else if (species.includes('cat')) petTypeCounts.Cat += 1;
      else if (species.includes('rabbit')) petTypeCounts.Rabbit += 1;
      else if (species.includes('bird')) petTypeCounts.Bird += 1;
      else petTypeCounts.Other += 1;
    });

    const serviceCounts = {
      Checkup: 0,
      Vaccination: 0,
      Grooming: 0,
      'Dental Cleaning': 0,
      Surgery: 0,
      Other: 0
    };

    normalizedAppointments.forEach(apt => {
      const service = (apt.service_type || 'Other').toString().trim().toLowerCase();
      if (service.includes('checkup')) serviceCounts.Checkup += 1;
      else if (service.includes('vaccination')) serviceCounts.Vaccination += 1;
      else if (service.includes('groom')) serviceCounts.Grooming += 1;
      else if (service.includes('dental')) serviceCounts['Dental Cleaning'] += 1;
      else if (service.includes('surgery')) serviceCounts.Surgery += 1;
      else serviceCounts.Other += 1;
    });

    const currentDate = new Date();
    const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(currentDate);
      date.setDate(currentDate.getDate() - (6 - index));
      return date;
    });

    const trendLabels = lastSevenDays.map(date => date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }));

    const trendKeys = lastSevenDays.map(date => date.toISOString().split('T')[0]);
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

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalPets,
        totalAppointments,
        pendingAppointments,
        totalMedicalRecords: (medicalRecords || []).length
      },
      summary: {
        totalUsers,
        totalPets,
        totalAppointments,
        pendingAppointments,
        completedAppointments,
        vaccinationsDueSoon,
        upcomingBookings,
        completedAppointmentPercentage,
        verifiedUsers,
        unverifiedUsers,
        pendingVerifications,
        activityLogCount,
        totalMedicalRecords: (medicalRecords || []).length
      },
      users,
      pets: normalizedPets,
      appointments: normalizedAppointments,
      medicalRecords: normalizedMedicalRecords,
      petTypes: {
        labels: Object.keys(petTypeCounts),
        values: Object.values(petTypeCounts)
      },
      services: {
        labels: Object.keys(serviceCounts),
        values: Object.values(serviceCounts)
      },
      appointmentsTrend
    });
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard overview' });
  }
};

/**
 * Get pet type distribution data for charts
 */
const getAnalyticsPetTypes = async (req, res) => {
  try {
    const { data: pets, error } = await supabase
      .from('pets')
      .select('species');

    if (error) throw error;

    const petTypeCounts = {
      Dog: 0,
      Cat: 0,
      Rabbit: 0,
      Bird: 0,
      Other: 0
    };

    (pets || []).forEach(pet => {
      const species = (pet.species || 'Other').toString().trim().toLowerCase();
      if (species.includes('dog')) petTypeCounts.Dog += 1;
      else if (species.includes('cat')) petTypeCounts.Cat += 1;
      else if (species.includes('rabbit')) petTypeCounts.Rabbit += 1;
      else if (species.includes('bird')) petTypeCounts.Bird += 1;
      else petTypeCounts.Other += 1;
    });

    res.json({
      success: true,
      labels: Object.keys(petTypeCounts),
      values: Object.values(petTypeCounts)
    });
  } catch (error) {
    console.error('Error fetching pet types analytics:', error);
    res.status(500).json({ error: 'Failed to fetch pet types analytics' });
  }
};

/**
 * Get service usage totals for charts
 */
const getAnalyticsServices = async (req, res) => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('service_type');

    if (error) throw error;

    const serviceCounts = {
      'Checkup': 0,
      'Vaccination': 0,
      'Grooming': 0,
      'Dental Cleaning': 0,
      'Surgery': 0,
      'Other': 0
    };

    (appointments || []).forEach(apt => {
      const service = (apt.service_type || 'Other').toString().trim().toLowerCase();
      if (service.includes('checkup')) serviceCounts['Checkup'] += 1;
      else if (service.includes('vaccination')) serviceCounts['Vaccination'] += 1;
      else if (service.includes('groom')) serviceCounts['Grooming'] += 1;
      else if (service.includes('dental')) serviceCounts['Dental Cleaning'] += 1;
      else if (service.includes('surgery')) serviceCounts['Surgery'] += 1;
      else serviceCounts['Other'] += 1;
    });

    res.json({
      success: true,
      labels: Object.keys(serviceCounts),
      values: Object.values(serviceCounts)
    });
  } catch (error) {
    console.error('Error fetching service usage analytics:', error);
    res.status(500).json({ error: 'Failed to fetch service usage analytics' });
  }
};

/**
 * Get appointment trend data for recent days
 */
const getAnalyticsAppointmentsTrend = async (req, res) => {
  try {
    const today = new Date();
    const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      return date;
    });

    const labels = lastSevenDays.map(date => date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }));

    const dateKeys = lastSevenDays.map(date => date.toISOString().split('T')[0]);
    const counts = dateKeys.reduce((acc, dateKey) => {
      acc[dateKey] = 0;
      return acc;
    }, {});

    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('appointment_date')
      .gte('appointment_date', dateKeys[0])
      .lte('appointment_date', dateKeys[dateKeys.length - 1]);

    if (error) throw error;

    (appointments || []).forEach(apt => {
      const rawDate = apt.appointment_date ? apt.appointment_date.toString().split('T')[0] : null;
      if (rawDate && counts.hasOwnProperty(rawDate)) {
        counts[rawDate] += 1;
      }
    });

    res.json({
      success: true,
      labels,
      values: dateKeys.map(dateKey => counts[dateKey] || 0)
    });
  } catch (error) {
    console.error('Error fetching appointment trend analytics:', error);
    res.status(500).json({ error: 'Failed to fetch appointment trend analytics' });
  }
};

/**
 * Get all users
 */
const getAllUsers = async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, fullname, email, role, created_at, is_verified')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching users:', error);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    res.json({ success: true, users: users || [] });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update user role
 * Body: { id, role }
 */
const updateUserRole = async (req, res) => {
  try {
    const { id, role } = req.body || {};
    const normalizedUserId = hasValue(id) ? String(id).trim() : '';

    if (!normalizedUserId) {
      return res.status(400).json({ success: false, error: 'User id is required' });
    }

    if (!role || typeof role !== 'string' || !role.trim()) {
      return res.status(400).json({ success: false, error: 'Role is required' });
    }

    const normalizedRole = role.trim().toLowerCase();
    const allowedRoles = ['user', 'admin'];
    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        error: `Invalid role. Allowed values are: ${allowedRoles.join(', ')}`
      });
    }

    const { data: existingUser, error: existingError } = await supabase
      .from('users')
      .select('id, fullname, email, role, is_verified, created_at')
      .eq('id', normalizedUserId)
      .maybeSingle();

    if (existingError) {
      console.error('Error loading user for role update:', existingError);
      return res.status(500).json({ success: false, error: 'Failed to load user' });
    }

    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (String(existingUser.role || '').toLowerCase() === normalizedRole) {
      return res.json({
        success: true,
        message: 'User role updated successfully',
        user: existingUser
      });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ role: normalizedRole })
      .eq('id', normalizedUserId)
      .select('id, fullname, email, role, is_verified, created_at')
      .maybeSingle();

    if (error) {
      console.error('Error updating user role:', error);
      return res.status(500).json({ success: false, error: 'Failed to update user role' });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await logAdminActivity(
      req,
      'users',
      normalizedUserId,
      `Changed user role from ${existingUser.role || 'unknown'} to ${normalizedRole}`
    );

    res.json({
      success: true,
      message: 'User role updated successfully',
      user: data
    });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

/**
 * Get all pets
 */
const getAllPets = async (req, res) => {
  try {
    const { data: pets, error } = await supabase
      .from('pets')
      .select('id, user_id, name, species, breed, age, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching pets:', error);
      return res.status(500).json({ error: 'Failed to fetch pets' });
    }

    const petsList = pets || [];
    const userIds = [...new Set(petsList.map(pet => pet.user_id).filter(Boolean))];
    let userMap = {};

    let recordCounts = {};
    let latestRecordsByPet = {};
    if (petsList.length > 0) {
      const petIds = [...new Set(petsList.map(pet => pet.id).filter(Boolean))];
      const { data: records, error: recordsError } = await supabase
        .from('medical_records')
        .select('id, pet_id, record_date, created_at, medical_notes, treatment, vaccination_status')
        .in('pet_id', petIds);

      if (!recordsError) {
        const recordContext = buildMedicalRecordContext(records || []);
        recordCounts = recordContext.counts;
        latestRecordsByPet = recordContext.latestByPet;
      } else {
        console.warn('Unable to load medical record counts for pets:', recordsError);
      }
    }

    if (userIds.length > 0) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, fullname')
        .in('id', userIds);

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

    res.json({ success: true, pets: normalizedPets });
  } catch (error) {
    console.error('Get all pets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all appointments
 */
const getAllAppointments = async (req, res) => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .order('appointment_date', { ascending: true });

    if (error) {
      console.error('Error fetching appointments:', error);
      return res.status(500).json({ error: 'Failed to fetch appointments' });
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
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, fullname')
        .in('id', userIds);

      if (usersError) {
        console.error('Error fetching appointment owners:', usersError);
      } else {
        userMap = buildUserNameMap(users);
      }
    }

    const appointmentMedicalRecordState = await getCompletedMedicalRecordAppointmentState(
      appointmentsList.map(appointment => appointment.id)
    );
    const normalizedAppointments = applyMedicalRecordStateToAppointments(
      normalizeAppointmentNames(appointmentsList, userMap),
      appointmentMedicalRecordState
    );

    res.json({ success: true, appointments: normalizedAppointments });
  } catch (error) {
    console.error('Get all appointments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get recent system activity logs
 */
const getSystemLogs = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const { data: logs, error } = await supabase
      .from('activity_logs')
      .select('id, actor_id, user_id, target_table, target_id, action, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching system logs:', error);
      return res.status(500).json({ error: 'Failed to fetch system logs' });
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
      const { data: appointments, error: appointmentsError } = await supabase
        .from('appointments')
        .select('id, user_id')
        .in('id', appointmentIds);

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
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, fullname')
        .in('id', userIds);

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

    res.json({ success: true, logs: formattedLogs });
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all contact messages
 */
const getContactMessages = async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('contact_messages')
      .select('id, fullname, email, message, status, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching contact messages:', error);
      return res.status(500).json({ error: 'Failed to fetch contact messages' });
    }

    res.json({ success: true, messages: messages || [] });
  } catch (error) {
    console.error('Get contact messages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update contact message status
 * Body: { id, status }
 */
const updateContactMessageStatus = async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const normalizedMessageId = hasValue(id) ? String(id).trim() : '';
    const normalizedStatus = hasValue(status) ? String(status).trim() : '';

    if (!normalizedMessageId || !normalizedStatus) {
      return res.status(400).json({ success: false, error: 'id and status are required' });
    }

    if (normalizedStatus !== 'Read') {
      return res.status(400).json({
        success: false,
        error: 'Contact messages can only be marked as Read.'
      });
    }

    const { data: existingMessage, error: existingError } = await supabase
      .from('contact_messages')
      .select('id, status')
      .eq('id', normalizedMessageId)
      .maybeSingle();

    if (existingError) {
      console.error('Error loading contact message:', existingError);
      return res.status(500).json({ success: false, error: 'Failed to load contact message' });
    }

    if (!existingMessage) {
      return res.status(404).json({ success: false, error: 'Contact message not found' });
    }

    if (existingMessage.status === normalizedStatus) {
      return res.json({ success: true, message: existingMessage });
    }

    const { data, error } = await supabase
      .from('contact_messages')
      .update({ status: normalizedStatus })
      .eq('id', normalizedMessageId)
      .select('id, fullname, email, message, status, created_at')
      .maybeSingle();

    if (error) {
      console.error('Error updating contact message status:', error);
      return res.status(500).json({ success: false, error: 'Failed to update contact message status' });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: 'Contact message not found' });
    }

    await logAdminActivity(
      req,
      'contact_messages',
      normalizedMessageId,
      `Updated contact message status from ${existingMessage.status} to ${normalizedStatus}`
    );

    res.json({ success: true, message: data });
  } catch (error) {
    console.error('Update contact message status error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

/**
 * Update appointment status
 * Body: { id, status }
 */
const updateAppointmentStatus = async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const adminUserId = getAdminActorId(req);
    const normalizedAppointmentId = hasValue(id) ? String(id).trim() : '';
    const normalizedStatus = hasValue(status) ? String(status).trim() : '';
    const normalizedAdminUserId = hasValue(adminUserId) ? String(adminUserId).trim() : '';

    if (!normalizedAppointmentId || !normalizedStatus) {
      return res.status(400).json({ error: 'id and status are required' });
    }

    const validStatus = ['Pending', 'Approved', 'Completed', 'Cancelled'];
    if (!validStatus.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatus.join(', ')}`
      });
    }

    if (!normalizedAdminUserId) {
      return res.status(400).json({ error: 'Admin user ID is required' });
    }

    const { data: existingData, error: existingError } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('id', normalizedAppointmentId)
      .maybeSingle();

    if (existingError) {
      console.error('Error loading appointment:', existingError);
      return res.status(500).json({ error: 'Failed to load appointment' });
    }

    if (!existingData) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const currentStatus = existingData.status;
    const allowedTransitions = {
      Pending: ['Approved', 'Cancelled'],
      Approved: ['Completed', 'Cancelled'],
      Completed: [],
      Cancelled: []
    };

    if (currentStatus === normalizedStatus) {
      return res.json({ success: true, appointment: existingData });
    }

    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Cannot change appointment from ${currentStatus || 'unknown'} to ${normalizedStatus}.`
      });
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ status: normalizedStatus, handled_by: normalizedAdminUserId })
      .eq('id', normalizedAppointmentId)
      .select(APPOINTMENT_SELECT);

    if (error) {
      console.error('Error updating appointment:', error);
      return res.status(500).json({ error: 'Failed to update appointment' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await logAdminActivity(
      req,
      'appointments',
      normalizedAppointmentId,
      `Updated appointment status from ${currentStatus} to ${normalizedStatus}`
    );

    res.json({ success: true, appointment: data[0] });
  } catch (error) {
    console.error('Update appointment status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const createMedicalRecord = async (req, res) => {
  try {
    const adminUserId = getAdminActorId(req);
    const {
      appointment_id,
      user_id,
      pet_id,
      record_date,
      weight,
      vaccination_status,
      treatment,
      medical_notes,
      created_by
    } = req.body || {};

    if (!hasValue(adminUserId)) {
      return res.status(400).json({ success: false, error: 'Admin user ID is required' });
    }

    const normalizedAdminId = String(adminUserId).trim();
    const normalizedBodyUserId = hasValue(user_id) ? String(user_id).trim() : '';
    const normalizedCreatedBy = hasValue(created_by) ? String(created_by).trim() : normalizedAdminId;
    const normalizedPetId = hasValue(pet_id) ? String(pet_id).trim() : '';
    const normalizedRecordDate = hasValue(record_date) ? normalizeRecordDateValue(record_date) : null;

    if (normalizedBodyUserId && normalizedBodyUserId !== normalizedAdminId) {
      return res.status(400).json({ success: false, error: 'Current admin user ID does not match the request.' });
    }

    if (normalizedCreatedBy !== normalizedAdminId) {
      return res.status(400).json({ success: false, error: 'created_by must match the current admin user.' });
    }

    if (!hasValue(normalizedPetId)) {
      return res.status(400).json({ success: false, error: 'Select a real pet before saving a medical record.' });
    }

    if (!hasValue(record_date)) {
      return res.status(400).json({ success: false, error: 'record_date is required' });
    }

    if (!normalizedRecordDate) {
      return res.status(400).json({ success: false, error: 'record_date must be a valid date' });
    }

    const { data: selectedPet, error: petError } = await supabase
      .from('pets')
      .select('id, user_id')
      .eq('id', normalizedPetId)
      .maybeSingle();

    if (petError) {
      console.error('Error validating pet for medical record:', petError);
      return res.status(500).json({ success: false, error: 'Failed to validate selected pet' });
    }

    if (!selectedPet) {
      return res.status(404).json({ success: false, error: 'Pet not found' });
    }

    let normalizedAppointmentId = '';
    if (hasValue(appointment_id)) {
      normalizedAppointmentId = String(appointment_id).trim();
      const { data: appointment, error: appointmentError } = await supabase
        .from('appointments')
        .select('id, user_id, status, pet_id')
        .eq('id', normalizedAppointmentId)
        .maybeSingle();

      if (appointmentError) {
        console.error('Error loading appointment for medical record:', appointmentError);
        return res.status(500).json({ success: false, error: 'Failed to load appointment' });
      }

      if (!appointment) {
        return res.status(404).json({ success: false, error: 'Appointment not found' });
      }

      if (String(appointment.status || '').toLowerCase() !== 'completed') {
        return res.status(400).json({
          success: false,
          error: 'Medical records can only be added after an appointment is completed.'
        });
      }

      if (String(appointment.user_id || '').trim() !== String(selectedPet.user_id || '').trim()) {
        return res.status(400).json({ success: false, error: 'Selected pet does not belong to the appointment owner.' });
      }

      if (hasValue(appointment.pet_id) && String(appointment.pet_id).trim() !== normalizedPetId) {
        return res.status(400).json({ success: false, error: 'Selected pet does not match the appointment pet.' });
      }

      const existingMedicalRecordState = await getCompletedMedicalRecordAppointmentState([normalizedAppointmentId]);
      if (existingMedicalRecordState[normalizedAppointmentId]?.has_medical_record) {
        return res.status(409).json({
          success: false,
          error: 'A medical record has already been added for this appointment.'
        });
      }
    }

    const payload = {
      pet_id: normalizedPetId,
      record_date: normalizedRecordDate,
      created_by: normalizedCreatedBy
    };

    if (hasValue(weight)) {
      const numericWeight = Number(weight);
      if (!Number.isFinite(numericWeight) || numericWeight < 0) {
        return res.status(400).json({ success: false, error: 'weight must be a valid non-negative number' });
      }
      payload.weight = numericWeight;
    }

    if (hasValue(vaccination_status)) {
      payload.vaccination_status = String(vaccination_status).trim();
    }

    if (hasValue(treatment)) {
      payload.treatment = String(treatment).trim();
    }

    if (hasValue(medical_notes)) {
      payload.medical_notes = String(medical_notes).trim();
    }

    const { data, error } = await supabase
      .from('medical_records')
      .insert([payload])
      .select(MEDICAL_RECORD_SELECT);

    if (error) {
      console.error('Failed to create admin medical record:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create medical record. Please try again.'
      });
    }

    const record = Array.isArray(data) ? data[0] : null;

    await logAdminActivity(
      req,
      'medical_records',
      record?.id || normalizedPetId,
      normalizedAppointmentId
        ? getMedicalRecordCompletedAppointmentAction(normalizedAppointmentId)
        : `Created medical record for pet ${normalizedPetId}`
    );

    const responseRecord = record && normalizedAppointmentId
      ? {
          ...record,
          appointment_id: normalizedAppointmentId,
          has_medical_record: true,
          medical_record_action_completed: true
        }
      : record;

    res.status(201).json({
      success: true,
      message: 'Medical record created successfully',
      record: responseRecord
    });
  } catch (error) {
    console.error('Create admin medical record error:', error);
    res.status(500).json({ success: false, error: 'Server error while creating medical record' });
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
  getContactMessages,
  updateContactMessageStatus,
  getAllUsers,
  getAllPets,
  getAllAppointments,
  createMedicalRecord,
  updateAppointmentStatus,
  updateUserRole
};
