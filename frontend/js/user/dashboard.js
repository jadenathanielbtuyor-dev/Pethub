// PetHub User Dashboard

// Connection retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY = 500; // milliseconds

document.addEventListener('DOMContentLoaded', () => {
  initializeUserDashboard();
});

const userDashboardData = {
  pets: [],
  medicalRecords: [],
  medicalRecordsLoaded: false
};

async function initializeUserDashboard() {
  if (!isLoggedIn()) {
    redirectToLogin();
    return;
  }

  renderUserDashboardLoadingStates();
  let userData = getUser();

  try {
    userData = await refreshCurrentUser();
  } catch (error) {
    console.error('User refresh failed:', error);
    if (!userData || !isRecoverableUserRefreshError(error)) {
      logout();
      return;
    }
    console.warn('Using cached user data after a temporary refresh failure.');
  }

  if (!isVerified()) {
    logout();
    return;
  }

  // Load all dashboard data in parallel with proper error isolation
  userData = getUser();
  
  if (!userData) {
    console.error('User data not available after verification');
    logout();
    return;
  }

  // Display user info immediately
  displayWelcome(userData);
  displayUserHeaderInfo();

  // Load dashboard data in parallel - use Promise.allSettled to prevent one failure from blocking all
  const results = await Promise.allSettled([
    loadUserPets(),
    loadUserAppointments(),
    loadUserMedicalRecords(),
    loadUserActivityLogs()
  ]);

  // Log any failures but continue
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const section = ['Pets', 'Appointments', 'Medical Records', 'Recent Activity'][index];
      console.warn(`Failed to load ${section}:`, result.reason);
    }
  });
}

/**
 * Retry wrapper for API calls with exponential backoff
 * @param {Function} fetchFn - Async function that makes the API call
 * @param {number} retries - Number of retries remaining
 * @returns {Promise} API response
 */
async function fetchWithRetry(fetchFn, retries = MAX_RETRIES) {
  try {
    return await fetchFn();
  } catch (error) {
    const errorMessage = String(error?.message || '');
    if (retries > 0 && (errorMessage.includes('Failed to fetch') || errorMessage.includes('Network'))) {
      console.warn(`Connection error, retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(fetchFn, retries - 1);
    }
    throw error;
  }
}

function isRecoverableUserRefreshError(error) {
  const status = Number(error?.status || 0);
  return !status || status >= 500;
}

function getFriendlyDashboardErrorMessage(sectionName) {
  return `We couldn't load ${sectionName} right now. Please refresh the page or try again later.`;
}

function renderUserSectionError(containerId, sectionName, actionHref, actionLabel, iconClass = 'ri-alert-line') {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="empty-state text-center py-8">
      <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-100 text-red-600">
        <i class="${iconClass} text-2xl"></i>
      </div>
      <p class="font-medium text-gray-700">Unable to load ${escapeHtml(sectionName)}</p>
      <p class="text-sm text-gray-500 mt-2">${escapeHtml(getFriendlyDashboardErrorMessage(sectionName))}</p>
      ${actionHref && actionLabel ? `<p class="text-sm text-gray-500 mt-2"><a href="${actionHref}" class="text-orange-500 hover:underline">${escapeHtml(actionLabel)}</a></p>` : ''}
    </div>
  `;
}

function getDashboardSectionLoadingHtml(sectionName, rowCount = 2) {
  const rows = Array.from({ length: rowCount }, () => `
    <div class="dashboard-skeleton-row" aria-hidden="true">
      <div class="dashboard-skeleton-icon"></div>
      <div class="dashboard-skeleton-lines">
        <div class="dashboard-skeleton-line medium"></div>
        <div class="dashboard-skeleton-line long"></div>
        <div class="dashboard-skeleton-line short"></div>
      </div>
    </div>
  `).join('');

  return `
    <div class="dashboard-loading-state" role="status" aria-live="polite" aria-label="Loading ${escapeHtml(sectionName)}">
      <div class="dashboard-loading-spinner" aria-hidden="true"></div>
      <div>
        <p class="dashboard-loading-title">Loading ${escapeHtml(sectionName)}...</p>
        <p class="dashboard-loading-copy">Fetching the latest PetHub records.</p>
      </div>
    </div>
    <div class="dashboard-skeleton-list">${rows}</div>
  `;
}

function renderUserDashboardLoadingStates() {
  const loaders = [
    ['recentPetsContainer', 'pets', 2],
    ['recentAppointmentsContainer', 'appointments', 2],
    ['recentRecordsContainer', 'medical records', 2],
    ['recentActivityContainer', 'activity logs', 2]
  ];

  loaders.forEach(([containerId, sectionName, rowCount]) => {
    const container = document.getElementById(containerId);
    if (container) {
      container.innerHTML = getDashboardSectionLoadingHtml(sectionName, rowCount);
    }
  });
}

function displayWelcome(userData) {
  const welcomeMessage = document.getElementById('welcomeMessage');
  if (welcomeMessage && userData) {
    const firstName = userData.fullname ? userData.fullname.split(' ')[0] : '';
    welcomeMessage.textContent = firstName ? `Welcome back, ${firstName}!` : 'Welcome back';
  }
}

function displayUserHeaderInfo() {
  const userData = getUser();
  const userBadge = document.getElementById('userBadge');
  if (!userData || !userBadge) return;
  const firstName = userData.fullname ? userData.fullname.split(' ')[0] : '';
  userBadge.textContent = firstName || 'Name not recorded';
}

function loadUserPets() {
  const userData = getUser();
  if (!userData) {
    displayPets([]);
    return Promise.resolve([]);
  }

  return fetchWithRetry(() => fetch(`${window.API_BASE_URL}/pets/userPets?user_id=${userData.id}`))
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => {
          throw new Error(data.error || `Failed to load pets (${res.status})`);
        });
      }
      return res.json();
    })
    .then(response => {
      const pets = Array.isArray(response.pets) ? response.pets : [];
      userDashboardData.pets = pets;
      displayPets(pets);
      if (userDashboardData.medicalRecordsLoaded) {
        displayRecentMedicalRecords(userDashboardData.medicalRecords);
      }
      return pets;
    })
    .catch(error => {
      console.error('Error loading pets:', error);
      renderUserSectionError('recentPetsContainer', 'pets', 'pets.html', 'Manage pets');
      return [];
    });
}

function displayPets(pets) {
  const petsContainer = document.getElementById('recentPetsContainer');
  if (!petsContainer) return;
  const petList = Array.isArray(pets) ? pets : [];

  if (petList.length === 0) {
    petsContainer.innerHTML = `
      <div class="empty-state text-center py-8">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-orange-100 text-orange-600">
          <i class="ri-paw-line text-2xl"></i>
        </div>
        <p class="font-medium text-gray-700">No pets added yet</p>
        <p class="text-sm text-gray-500 mt-2">Pet profiles you add will appear here and help connect appointments and records to the right pet.</p>
        <p class="text-sm text-gray-500 mt-2"><a href="pets.html" class="text-orange-500 hover:underline">Add your first pet</a></p>
      </div>
    `;
    return;
  }

  petsContainer.innerHTML = petList.map(pet => `
    <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
      <div class="flex items-center gap-4 flex-1">
        <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-100 text-orange-600">
          <i class="${getPetSpeciesIconClass(pet.species)} text-2xl"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-gray-900">${escapeHtml(pet.name || 'Unnamed pet')}</p>
          <p class="text-sm text-gray-600">${escapeHtml(getPetSummary(pet))}</p>
        </div>
      </div>
      <div class="flex gap-2">
        <a href="pets.html" class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-50 text-orange-600 text-sm font-semibold hover:bg-orange-100 transition-all">
          <i class="ri-arrow-right-line"></i>Open
        </a>
      </div>
    </div>
  `).join('');
}

function getPetSummary(pet) {
  const details = [
    pet.species || 'Species not recorded',
    pet.breed || 'Breed not recorded',
    pet.age || pet.age === 0 ? `${pet.age} year${Number(pet.age) === 1 ? '' : 's'} old` : 'Age not recorded'
  ];
  return details.join(' | ');
}

function getPetSpeciesIconClass(species) {
  const normalizedSpecies = String(species || '').toLowerCase().trim();
  const iconMap = {
    dog: 'ri-paw-line',
    cat: 'ri-paw-line',
    bird: 'ri-paw-line',
    fish: 'ri-paw-line',
    rabbit: 'ri-paw-line',
    hamster: 'ri-paw-line',
    reptile: 'ri-paw-line',
    snake: 'ri-paw-line',
    horse: 'ri-paw-line',
    other: 'ri-paw-line'
  };

  return iconMap[normalizedSpecies] || 'ri-paw-line';
}

function hasRecordedValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getUserPetById(petId) {
  if (!hasRecordedValue(petId)) return null;
  const id = String(petId);
  return userDashboardData.pets.find(pet => String(pet.id) === id) || null;
}

function getMedicalRecordPetLabel(record) {
  const pet = getUserPetById(record?.pet_id);
  if (hasRecordedValue(pet?.name)) return String(pet.name);
  if (hasRecordedValue(record?.pet_name)) return String(record.pet_name);
  if (hasRecordedValue(record?.pet_id)) return `Pet ID: ${record.pet_id}`;
  return 'Pet profile unavailable';
}

function getMedicalRecordRecorderLabel(record) {
  if (!hasRecordedValue(record?.created_by)) return 'Not specified';
  if (hasRecordedValue(record?.created_by_name)) return String(record.created_by_name);
  if (hasRecordedValue(record?.recorded_by_name)) return String(record.recorded_by_name);
  return 'Not specified';
}

function getMedicalRecordDisplayValue(value) {
  return hasRecordedValue(value) ? String(value) : 'Not recorded';
}

function getMedicalRecordWeightDisplay(record) {
  const weight = getMedicalRecordDisplayValue(record?.weight);
  return weight === 'Not recorded' ? weight : `${weight} kg`;
}

function getAppointmentDurationMinutes(appointment) {
  const duration = Number(appointment?.estimated_duration_minutes);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function getAppointmentDurationLabel(appointment) {
  const minutes = getAppointmentDurationMinutes(appointment);
  if (!Number.isFinite(minutes)) return 'N/A';

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  return `${minutes} minutes`;
}

function parseAppointmentDateTime(dateValue, timeValue) {
  const dateMatch = String(dateValue || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  const timeMatch = String(timeValue || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;

  const appointmentDate = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] || 0),
    0
  );

  return Number.isNaN(appointmentDate.getTime()) ? null : appointmentDate;
}

function getAppointmentTimeRangeDisplay(appointment) {
  const durationMinutes = getAppointmentDurationMinutes(appointment);
  const startTime = parseAppointmentDateTime(appointment?.appointment_date, appointment?.appointment_time);
  if (!Number.isFinite(durationMinutes) || !startTime) return 'N/A';

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const formatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${startTime.toLocaleTimeString('en-US', formatOptions)} - ${endTime.toLocaleTimeString('en-US', formatOptions)}`;
}

function loadUserAppointments() {
  const userData = getUser();
  if (!userData) {
    displayAppointments([]);
    return Promise.resolve([]);
  }

  return fetchWithRetry(() => fetch(`${window.API_BASE_URL}/appointments/userAppointments?user_id=${userData.id}`))
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => {
          throw new Error(data.error || `Failed to load appointments (${res.status})`);
        });
      }
      return res.json();
    })
    .then(response => {
      const appointments = Array.isArray(response.appointments) ? response.appointments : [];
      displayAppointments(appointments);
      return appointments;
    })
    .catch(error => {
      console.error('Error loading appointments:', error);
      renderUserSectionError('recentAppointmentsContainer', 'appointments', 'appointments.html', 'Manage appointments', 'ri-calendar-event-line');
      return [];
    });
}

async function loadUserMedicalRecords() {
  const userData = getUser();
  if (!userData) {
    displayRecentMedicalRecords([]);
    return Promise.resolve([]);
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/pets/medical-records?user_id=${userData.id}`));
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to load medical records (${response.status})`);
    }

    const data = await response.json();
    const records = Array.isArray(data.records) ? data.records : [];
    userDashboardData.medicalRecords = records;
    userDashboardData.medicalRecordsLoaded = true;
    displayRecentMedicalRecords(records);
    return records;
  } catch (error) {
    console.error('Error loading medical records:', error);
    renderUserSectionError('recentRecordsContainer', 'medical records', 'pets.html#medicalRecordsList', 'View records', 'ri-file-medical-line');
    return [];
  }
}

async function loadUserActivityLogs() {
  const userData = getUser();
  if (!userData) {
    displayRecentActivity([]);
    return Promise.resolve([]);
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/auth/activity-logs?user_id=${userData.id}`));
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to load recent activity (${response.status})`);
    }

    const data = await response.json();
    const logs = Array.isArray(data.logs) ? data.logs : [];
    displayRecentActivity(logs);
    return logs;
  } catch (error) {
    console.error('Error loading recent activity:', error);
    renderUserSectionError('recentActivityContainer', 'recent activity', '', '', 'ri-history-line');
    return [];
  }
}

function displayAppointments(appointments) {
  const appointmentsContainer = document.getElementById('recentAppointmentsContainer');
  if (!appointmentsContainer) return;
  const appointmentList = Array.isArray(appointments) ? appointments : [];

  if (appointmentList.length === 0) {
    appointmentsContainer.innerHTML = `
      <div class="empty-state text-center py-8">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-500">
          <i class="ri-calendar-event-line text-2xl"></i>
        </div>
        <p class="font-medium text-gray-700">No appointments yet</p>
        <p class="text-sm text-gray-500 mt-2">Appointments you book will appear here with their clinic approval status.</p>
        <p class="text-sm text-gray-500 mt-2"><a href="appointments.html" class="text-blue-500 hover:underline">Book an appointment</a></p>
      </div>
    `;
    return;
  }

  appointmentsContainer.innerHTML = appointmentList.map(apt => {
    const handledBy = getHandledByLabel(apt);
    const status = getAppointmentStatusLabel(apt.status);
    const handledByRow = handledBy
      ? `<p><span class="font-semibold text-slate-500">Handled by:</span> ${escapeHtml(handledBy)}</p>`
      : '';
    return `
      <div class="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-start gap-4">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-500">
            <i class="ri-calendar-check-line text-2xl"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="grid grid-cols-1 gap-x-5 gap-y-2 text-sm text-gray-600 sm:grid-cols-2">
              <p><span class="font-semibold text-slate-500">Pet:</span> ${escapeHtml(hasRecordedValue(apt.pet_name) ? apt.pet_name : 'N/A')}</p>
              <p><span class="font-semibold text-slate-500">Service:</span> ${escapeHtml(hasRecordedValue(apt.service_type) ? apt.service_type : 'N/A')}</p>
              <p><span class="font-semibold text-slate-500">Duration:</span> ${escapeHtml(getAppointmentDurationLabel(apt))}</p>
              <p><span class="font-semibold text-slate-500">Date:</span> ${escapeHtml(formatAppointmentDate(apt.appointment_date))}</p>
              <p><span class="font-semibold text-slate-500">Time range:</span> ${escapeHtml(getAppointmentTimeRangeDisplay(apt))}</p>
              <p>
                <span class="font-semibold text-slate-500">Status:</span>
                <span class="ml-1 inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${getStatusBadgeClasses(status)}">
                  ${escapeHtml(status)}
                </span>
              </p>
              ${handledByRow}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function getHandledByLabel(appointment) {
  if (!appointment || !appointment.handled_by || !appointment.handled_by_name) return '';
  return appointment.handled_by_name;
}

function getAppointmentStatusLabel(status) {
  if (!hasRecordedValue(status)) return 'Status not recorded';
  const normalizedStatus = String(status).toLowerCase();
  const statusMap = {
    pending: 'Pending',
    approved: 'Approved',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };
  return statusMap[normalizedStatus] || String(status);
}

function getStatusBadgeClasses(status) {
  const classes = {
    'Pending': 'bg-yellow-50 text-yellow-600',
    'Approved': 'bg-blue-50 text-blue-600',
    'Completed': 'bg-green-50 text-green-600',
    'Cancelled': 'bg-red-50 text-red-700'
  };
  return classes[status] || 'bg-slate-100 text-slate-700';
}

function formatAppointmentDate(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 'N/A';

  const appointmentDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(appointmentDate.getTime())) return 'N/A';
  return appointmentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

async function refreshCurrentUser() {
  const userData = getUser();
  if (!userData) {
    throw new Error('No user data available');
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/auth/user-status?user_id=${userData.id}`));
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const refreshError = new Error(data.error || 'Unable to refresh user status');
      refreshError.status = response.status;
      throw refreshError;
    }

    const data = await response.json();
    if (!data.success || !data.user) {
      throw new Error(data.error || 'Invalid user status response');
    }

    setUser(data.user);
    return data.user;
  } catch (error) {
    console.error('Error refreshing user status:', error);
    throw error;
  }
}

function displayRecentMedicalRecords(records) {
  const recordsContainer = document.getElementById('recentRecordsContainer');
  if (!recordsContainer) {
    return;
  }
  const recordList = Array.isArray(records) ? records : [];

  if (recordList.length === 0) {
    recordsContainer.innerHTML = `
      <div class="text-center py-8">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-green-100 text-green-500">
          <i class="ri-file-medical-line text-2xl"></i>
        </div>
        <p class="text-gray-600 font-medium">No medical records yet</p>
        <p class="text-sm text-gray-500 mt-2">Official records are added by clinic staff after completed services, so nothing has been recorded here yet.</p>
        <p class="text-sm text-gray-500 mt-2"><a href="appointments.html" class="text-blue-500 hover:underline">Book a consultation</a></p>
      </div>
    `;
    return;
  }

  const sortedRecords = [...recordList]
    .sort((a, b) => new Date(b.record_date || b.created_at || 0) - new Date(a.record_date || a.created_at || 0));

  recordsContainer.innerHTML = sortedRecords.map(record => {
    const petName = getMedicalRecordPetLabel(record);
    const date = record.record_date ? formatDate(record.record_date) : 'Date not recorded';
    const recordedBy = getMedicalRecordRecorderLabel(record);
    
    return `
      <div class="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex justify-between items-start mb-3">
          <div>
            <p class="text-xs text-gray-500 font-semibold uppercase tracking-wide">Record date: ${escapeHtml(date)}</p>
            <p class="font-semibold text-gray-900 mt-1">${escapeHtml(petName)}</p>
          </div>
        </div>
        <dl class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="font-semibold text-gray-500">Weight</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordWeightDisplay(record))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Vaccination status</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.vaccination_status))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Treatment</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.treatment))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Recorded by</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(`Recorded by: ${recordedBy}`)}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="font-semibold text-gray-500">Notes</dt>
            <dd class="mt-1 whitespace-pre-line text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.medical_notes))}</dd>
          </div>
        </dl>
      </div>
    `;
  }).join('');
}

function displayRecentActivity(logs) {
  const activityContainer = document.getElementById('recentActivityContainer');
  if (!activityContainer) return;
  const activityLogs = Array.isArray(logs) ? logs : [];

  if (activityLogs.length === 0) {
    activityContainer.innerHTML = `
      <div class="text-center py-6">
        <p class="text-gray-600 font-medium">No recent activity yet</p>
        <p class="text-sm text-gray-500 mt-2">Activity appears here after account actions like adding a pet or booking an appointment.</p>
        <p class="text-sm text-gray-500 mt-2"><a href="pets.html" class="text-orange-500 hover:underline">Add a pet</a></p>
      </div>
    `;
    return;
  }

  activityContainer.innerHTML = activityLogs.slice(0, 5).map(log => {
    const action = formatActivityAction(log.action);
    const details = log.details ? String(log.details) : '';
    const date = log.created_at ? formatDate(log.created_at) : 'Date not recorded';

    return `
      <div class="flex items-start gap-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <div class="mt-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
          <i class="ri-history-line"></i>
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-gray-900">${escapeHtml(action)}</p>
          ${details ? `<p class="mt-1 text-sm text-gray-600">${escapeHtml(details)}</p>` : ''}
          <p class="mt-2 text-xs text-gray-500">${escapeHtml(date)}</p>
        </div>
      </div>
    `;
  }).join('');
}

function formatActivityAction(action) {
  if (!action) return 'Action not recorded';
  return String(action)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

// Logout functionality handled by main.js
