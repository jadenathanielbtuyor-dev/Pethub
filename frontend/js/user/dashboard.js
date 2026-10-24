// PetHub Pet Owner Dashboard: Overview (pages/user/dashboard.html)
//
// Section 1 of the Pet Owner Dashboard (Overview, My Pets, Appointments, Pet Health & AI Assistant). Everything here is
// read for the signed-in owner only:
// - GET /auth/user-status?include=profile  -> greeting, "Your details" and the "Complete your details" banner
// - GET /pets/userPets                     -> the pet count and the "Your pets" preview
// - GET /appointments/userAppointments     -> upcoming appointments, their clinic statuses and the two counts
// - GET /auth/activity-logs                -> recent activity on the account
// Authorization: core/api.js attaches the session token; backend/middleware/requireAuth.js refuses (403) any request
// whose user_id is not the token's account, so changing user_id in the browser cannot load another owner's records.
// Failures: each section shows its own error and its figure says "Unavailable", never a misleading 0; the other
// sections still load (Promise.allSettled).
// Medical records are shown on Pet Health & AI Assistant (health.html), not here.

// Connection retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY = 500; // milliseconds
const DASHBOARD_PET_PREVIEW_LIMIT = 3;
const DASHBOARD_MORE_UPCOMING_LIMIT = 3;
// Pending and Approved bookings can still take place; Completed and Cancelled ones cannot
const UPCOMING_APPOINTMENT_STATUSES = ['Pending', 'Approved'];

document.addEventListener('DOMContentLoaded', () => {
  initializeUserDashboard();
});

const userDashboardData = {
  pets: [],
  // Personal details (GET /auth/user-status?include=profile; edited through PUT /auth/profile). Kept in memory only,
  // never in sessionStorage; null when they could not be loaded.
  profile: null
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
  displayAccountDetails(userData, userDashboardData.profile);
  setupAccountDetailsEditing();

  // Load dashboard data in parallel - use Promise.allSettled to prevent one failure from blocking all
  const results = await Promise.allSettled([
    loadUserPets(),
    loadUserAppointments(),
    loadUserActivityLogs()
  ]);

  // Log any failures but continue
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const section = ['Pets', 'Appointments', 'Recent Activity'][index];
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

function renderUserSectionError(containerId, sectionName) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="ph-dash-error" role="alert">
      <p class="ph-dash-error-title">Unable to load ${escapeHtml(sectionName)}</p>
      <p class="ph-dash-error-text">${escapeHtml(getFriendlyDashboardErrorMessage(sectionName))}</p>
    </div>
  `;
}

function getEmptyStateHtml(title, text, actionHref = '', actionLabel = '') {
  return `
    <div class="ph-dash-empty">
      <p class="ph-dash-empty-title">${escapeHtml(title)}</p>
      <p class="ph-dash-empty-text">${escapeHtml(text)}</p>
      ${actionHref && actionLabel ? `<a href="${actionHref}" class="ph-dash-link">${escapeHtml(actionLabel)} <i class="ri-arrow-right-line" aria-hidden="true"></i></a>` : ''}
    </div>
  `;
}

// A figure in the "At a glance" row: a count once loaded, "Unavailable" when its request failed
function setOwnerStat(elementId, value) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const isCount = Number.isInteger(value) && value >= 0;
  element.textContent = isCount ? String(value) : 'Unavailable';
  element.classList.toggle('is-muted', !isCount);
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
    ['recentActivityContainer', 'activity logs', 2],
    ['accountDetailsContainer', 'your details', 1]
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

// "Your details": the account name and email, and the personal details the clinic asks for. Accounts created before
// those details were required show "Not provided" and a "Complete your details" banner until they are added.
function displayAccountDetails(userData, profile) {
  const container = document.getElementById('accountDetailsContainer');
  if (!container || !userData) return;

  const fields = window.PetHubProfileFields;
  const notProvided = '<span class="text-gray-500">Not provided</span>';
  const show = value => (hasRecordedValue(value) ? escapeHtml(String(value)) : notProvided);
  const details = profile || {};
  const address = ['address_line', 'barangay', 'city_municipality', 'province', 'postal_code']
    .map(key => details[key])
    .filter(hasRecordedValue)
    .join(', ');

  const rows = [
    ['Full legal name', show(userData.fullname)],
    ['Email', show(userData.email)],
    ['Member since', userData.created_at ? escapeHtml(formatDate(userData.created_at)) : notProvided]
  ];
  if (profile) {
    rows.push(
      ['Contact number', hasRecordedValue(details.phone_number) ? escapeHtml(fields.formatContactNumber(details.phone_number)) : notProvided],
      ['Date of birth', hasRecordedValue(details.date_of_birth) ? escapeHtml(formatDate(details.date_of_birth)) : notProvided],
      ['Gender', show(details.gender)],
      ['Home address', show(address), 'sm:col-span-2']
    );
  }

  container.innerHTML = `
    <dl class="grid gap-4 sm:grid-cols-2">
      ${rows.map(([label, value, extraClass]) => `
        <div class="min-w-0 ${extraClass || ''}">
          <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">${label}</dt>
          <dd class="mt-1 break-words text-sm font-medium text-gray-900">${value}</dd>
        </div>
      `).join('')}
    </dl>
    ${profile ? '' : '<p class="mt-4 text-xs text-gray-500">Your personal details could not be loaded right now. Please refresh the page to try again.</p>'}
  `;

  // Details can only be edited once they have been loaded, so a save never blanks out what could not be read
  const editButton = document.getElementById('editAccountDetailsButton');
  const form = document.getElementById('accountDetailsForm');
  if (editButton) editButton.hidden = !profile || Boolean(form && !form.hidden);
  updateProfileCompletionBanner(userData, profile);
}

function updateProfileCompletionBanner(userData, profile) {
  const banner = document.getElementById('profileCompletionBanner');
  if (!banner) return;
  const isCustomer = String(userData?.role || 'user').toLowerCase() === 'user';
  banner.hidden = !(isCustomer && profile && !window.PetHubProfileFields.isProfileComplete(profile));
}

// Form input id -> field name sent to PUT /auth/profile (and returned as `field` in its errors); errors are `${id}Error`
const ACCOUNT_DETAILS_FIELDS = [
  { id: 'profileFullname', name: 'fullname' },
  { id: 'profileDateOfBirth', name: 'date_of_birth' },
  { id: 'profileGender', name: 'gender' },
  { id: 'profilePhoneNumber', name: 'phone_number' },
  { id: 'profileAddressLine', name: 'address_line' },
  { id: 'profileBarangay', name: 'barangay' },
  { id: 'profileCityMunicipality', name: 'city_municipality' },
  { id: 'profileProvince', name: 'province' },
  { id: 'profilePostalCode', name: 'postal_code' }
];
let accountDetailsSaveInProgress = false;

function readAccountDetailsValues() {
  return Object.fromEntries(ACCOUNT_DETAILS_FIELDS.map(({ id, name }) => {
    const input = document.getElementById(id);
    // A date the browser could not understand reads as '' with validity.badInput set
    if (name === 'date_of_birth' && input?.validity?.badInput) return [name, 'invalid'];
    const value = input ? input.value : '';
    return [name, name === 'gender' ? value : value.trim().replace(/\s+/g, ' ')];
  }));
}

function getAccountDetailsFieldError(name, values) {
  const fields = window.PetHubProfileFields;
  return name === 'fullname' ? fields.getFullNameError(values.fullname) : fields.getProfileFieldError(name, values[name]);
}

function setAccountDetailsFieldError(field, message) {
  const input = document.getElementById(field.id);
  const error = document.getElementById(`${field.id}Error`);
  if (input) {
    input.classList.toggle('is-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
}

// A message from the server stays until the value it was about changes (leaving the field unchanged must not clear it)
function validateAccountDetailsField(field, values = readAccountDetailsValues()) {
  const input = document.getElementById(field.id);
  if (input && input.dataset.serverValue !== undefined) {
    if (input.value === input.dataset.serverValue) return true;
    delete input.dataset.serverValue;
  }
  const message = getAccountDetailsFieldError(field.name, values);
  setAccountDetailsFieldError(field, message);
  return Boolean(message);
}

function setAccountDetailsStatus(message) {
  const status = document.getElementById('accountDetailsMessage');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('is-visible', Boolean(message));
}

function openAccountDetailsForm() {
  const form = document.getElementById('accountDetailsForm');
  const view = document.getElementById('accountDetailsContainer');
  const editButton = document.getElementById('editAccountDetailsButton');
  if (!form || !userDashboardData.profile) return;

  const user = getUser() || {};
  const profile = userDashboardData.profile;
  const fields = window.PetHubProfileFields;
  const saved = {
    fullname: user.fullname || '',
    ...Object.fromEntries(fields.PROFILE_FIELDS.map(name => [name, profile[name] || '']))
  };
  saved.phone_number = saved.phone_number ? fields.formatContactNumber(saved.phone_number) : '';

  ACCOUNT_DETAILS_FIELDS.forEach(field => {
    const input = document.getElementById(field.id);
    if (input) {
      input.value = saved[field.name] || '';
      delete input.dataset.touched;
      delete input.dataset.serverValue;
    }
    setAccountDetailsFieldError(field, '');
  });
  const dateInput = document.getElementById('profileDateOfBirth');
  if (dateInput) dateInput.max = fields.getClinicDate();
  clearMessage(document.getElementById('accountDetailsFormMessage'));
  setAccountDetailsStatus('');

  form.hidden = false;
  if (view) view.hidden = true;
  if (editButton) {
    editButton.hidden = true;
    editButton.setAttribute('aria-expanded', 'true');
  }
  // Start at the first missing detail, or at the name
  const firstMissing = ACCOUNT_DETAILS_FIELDS.find(field => !saved[field.name]) || ACCOUNT_DETAILS_FIELDS[0];
  document.getElementById(firstMissing.id)?.focus();
}

function closeAccountDetailsForm() {
  const form = document.getElementById('accountDetailsForm');
  const view = document.getElementById('accountDetailsContainer');
  const editButton = document.getElementById('editAccountDetailsButton');
  if (form) form.hidden = true;
  if (view) view.hidden = false;
  if (editButton) {
    editButton.hidden = !userDashboardData.profile;
    editButton.setAttribute('aria-expanded', 'false');
  }
}

async function saveAccountDetails(form) {
  if (accountDetailsSaveInProgress || isFormSubmitting(form)) return;
  const messageContainer = document.getElementById('accountDetailsFormMessage');
  clearMessage(messageContainer);

  const values = readAccountDetailsValues();
  const invalidFields = ACCOUNT_DETAILS_FIELDS.filter(field => validateAccountDetailsField(field, values));
  if (invalidFields.length > 0) {
    displayMessage(messageContainer, invalidFields.length === 1
      ? 'Please fix the highlighted field.'
      : `Please fix the ${invalidFields.length} highlighted fields.`, 'error');
    document.getElementById(invalidFields[0].id)?.focus();
    return;
  }

  accountDetailsSaveInProgress = true;
  setFormSubmitting(form, true, 'Saving...', 'Save details');
  try {
    const response = await fetch(`${window.API_BASE_URL}/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    });
    const data = await getJsonFromResponse(response);

    if (!response.ok || data.success === false) {
      const field = ACCOUNT_DETAILS_FIELDS.find(entry => entry.name === data.field);
      if (field) {
        const input = document.getElementById(field.id);
        if (input) input.dataset.serverValue = input.value;
        setAccountDetailsFieldError(field, data.error);
        displayMessage(messageContainer, 'Please check the highlighted field.', 'error');
        document.getElementById(field.id)?.focus();
      } else {
        displayMessage(messageContainer, data.error || `Your details could not be saved (${response.status}). Please try again.`, 'error');
      }
      return;
    }

    userDashboardData.profile = data.profile;
    // Only the name changes in the stored session user; the personal details stay in memory
    const current = getUser();
    if (current && data.user?.fullname) setUser({ ...current, fullname: data.user.fullname });

    const userData = getUser() || current;
    closeAccountDetailsForm();
    displayWelcome(userData);
    displayUserHeaderInfo();
    displayAccountDetails(userData, userDashboardData.profile);
    setAccountDetailsStatus('Your details were saved.');
    document.getElementById('accountDetailsTitle')?.focus();
  } catch (error) {
    console.error('Saving details failed:', error.message);
    displayMessage(messageContainer, 'We could not save your details right now. Check your connection and try again.', 'error');
  } finally {
    accountDetailsSaveInProgress = false;
    setFormSubmitting(form, false, 'Saving...', 'Save details');
  }
}

function setupAccountDetailsEditing() {
  const form = document.getElementById('accountDetailsForm');
  if (!form || form.dataset.ready === 'true') return;
  form.dataset.ready = 'true';

  document.getElementById('editAccountDetailsButton')?.addEventListener('click', openAccountDetailsForm);
  document.getElementById('completeDetailsButton')?.addEventListener('click', () => {
    document.getElementById('accountDetails')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    openAccountDetailsForm();
  });
  document.getElementById('cancelAccountDetailsButton')?.addEventListener('click', () => {
    closeAccountDetailsForm();
    document.getElementById('editAccountDetailsButton')?.focus();
  });

  // Fields are checked when the customer leaves them, and re-checked while typing once they show a message
  ACCOUNT_DETAILS_FIELDS.forEach(field => {
    const input = document.getElementById(field.id);
    if (!input) return;
    input.addEventListener('blur', () => {
      if (input.value || input.dataset.touched === 'true' || input.validity?.badInput) {
        input.dataset.touched = 'true';
        validateAccountDetailsField(field);
      }
    });
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (input.getAttribute('aria-invalid') === 'true') validateAccountDetailsField(field);
    });
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    saveAccountDetails(form);
  });
}

// The signed-in name in the dashboard navigation (js/shared/dashboard-shell.js), also after the name is edited
function displayUserHeaderInfo() {
  const userData = getUser();
  if (!userData || !window.PetHubDashboardShell) return;
  window.PetHubDashboardShell.setAccountName(userData.fullname || 'Name not recorded');
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
      setOwnerStat('ownerStatPets', pets.length);
      displayPets(pets);
      return pets;
    })
    .catch(error => {
      console.error('Error loading pets:', error);
      setOwnerStat('ownerStatPets', null);
      renderUserSectionError('recentPetsContainer', 'pets');
      return [];
    });
}

function displayPets(pets) {
  const petsContainer = document.getElementById('recentPetsContainer');
  if (!petsContainer) return;
  const petList = Array.isArray(pets) ? pets : [];

  if (petList.length === 0) {
    petsContainer.innerHTML = getEmptyStateHtml(
      'No pets added yet',
      'Pet profiles you add will appear here and help connect appointments and records to the right pet.',
      'pets.html',
      'Add your first pet'
    );
    return;
  }

  const previewPets = petList.slice(0, DASHBOARD_PET_PREVIEW_LIMIT);
  petsContainer.innerHTML = `
    <ul class="ph-dash-list">
      ${previewPets.map(pet => `
        <li class="ph-dash-list-item">
          <div class="ph-dash-list-main">
            <p class="ph-dash-list-title">${escapeHtml(pet.name || 'Unnamed pet')}</p>
            <p class="ph-dash-list-meta">${escapeHtml(getPetSummary(pet))}</p>
          </div>
          <a href="pets.html?pet=${encodeURIComponent(String(pet.id || ''))}" class="ph-dash-link">Open<span class="sr-only"> ${escapeHtml(pet.name || 'pet')}</span> <i class="ri-arrow-right-line" aria-hidden="true"></i></a>
        </li>
      `).join('')}
    </ul>
    ${getPreviewFooterHtml(previewPets.length, petList.length, 'pets', 'pets.html', 'View all pets')}
  `;
}

function getPreviewFooterHtml(shownCount, totalCount, noun, href, linkLabel) {
  if (totalCount <= shownCount) return '';
  return `<p class="ph-dash-note mt-3">Showing ${shownCount} of ${totalCount} ${noun}. <a href="${href}" class="ph-dash-link">${escapeHtml(linkLabel)}</a></p>`;
}

function getPetSummary(pet) {
  const details = [
    pet.species || 'Species not recorded',
    pet.breed || 'Breed not recorded',
    pet.age || pet.age === 0 ? `${pet.age} year${Number(pet.age) === 1 ? '' : 's'} old` : 'Age not recorded'
  ];
  return details.join(' | ');
}

function hasRecordedValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
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

// Next relevant appointments: Pending or Approved and not yet finished (start + duration, browser-local time like the
// times shown on this page), soonest first. The API lists the newest appointments first, so the soonest are picked here.
function getUpcomingAppointments(appointments, now = new Date()) {
  return appointments
    .map(appointment => ({
      appointment,
      startTime: parseAppointmentDateTime(appointment?.appointment_date, appointment?.appointment_time)
    }))
    .filter(({ appointment, startTime }) => {
      if (!startTime || !UPCOMING_APPOINTMENT_STATUSES.includes(getAppointmentStatusLabel(appointment.status))) return false;
      const durationMinutes = getAppointmentDurationMinutes(appointment);
      const endTime = Number.isFinite(durationMinutes) ? new Date(startTime.getTime() + durationMinutes * 60000) : startTime;
      return endTime > now;
    })
    .sort((a, b) => a.startTime - b.startTime)
    .map(({ appointment }) => appointment);
}

// Same short reference as the Appointments page (the stored appointment_reference is empty)
function getAppointmentReference(appointment) {
  const compactId = String(appointment?.id || '').replace(/[^A-Za-z0-9]/g, '');
  return compactId ? `PH-${compactId.slice(0, 8).toUpperCase()}` : 'N/A';
}

function getAppointmentStatusNote(status) {
  if (status === 'Pending') return 'Awaiting clinic approval';
  if (status === 'Approved') return 'Approved by the clinic';
  return '';
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
      const upcoming = getUpcomingAppointments(appointments);
      setOwnerStat('ownerStatUpcoming', upcoming.length);
      setOwnerStat('ownerStatPending', upcoming.filter(apt => getAppointmentStatusLabel(apt.status) === 'Pending').length);
      displayAppointments(appointments);
      return appointments;
    })
    .catch(error => {
      console.error('Error loading appointments:', error);
      setOwnerStat('ownerStatUpcoming', null);
      setOwnerStat('ownerStatPending', null);
      renderUserSectionError('recentAppointmentsContainer', 'appointments');
      return [];
    });
}

async function loadUserActivityLogs() {
  const userData = getUser();
  if (!userData) {
    displayRecentActivity([]);
    return Promise.resolve([]);
  }

  try {
    // Sign-ins and sign-outs are left out: they would fill the list and hide bookings, cancellations and messages
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/auth/activity-logs?user_id=${userData.id}&exclude=sign_ins`));
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
    renderUserSectionError('recentActivityContainer', 'recent activity');
    return [];
  }
}

function displayAppointments(appointments) {
  const appointmentsContainer = document.getElementById('recentAppointmentsContainer');
  if (!appointmentsContainer) return;
  const appointmentList = Array.isArray(appointments) ? appointments : [];

  if (appointmentList.length === 0) {
    appointmentsContainer.innerHTML = getEmptyStateHtml(
      'No appointments yet',
      'Appointments you book will appear here with their clinic approval status.',
      'appointments.html',
      'Go to Appointments'
    );
    return;
  }

  const upcomingAppointments = getUpcomingAppointments(appointmentList);
  if (upcomingAppointments.length === 0) {
    appointmentsContainer.innerHTML = getEmptyStateHtml(
      'No upcoming appointments',
      'Past, completed, and cancelled appointments are listed on the Appointments page.',
      'appointments.html',
      'See your appointment history'
    );
    return;
  }

  const apt = upcomingAppointments[0];
  const handledBy = getHandledByLabel(apt);
  const status = getAppointmentStatusLabel(apt.status);
  const handledByRow = handledBy ? getFactHtml('Handled by', handledBy) : '';
  const moreUpcoming = upcomingAppointments.slice(1);
  const moreUpcomingHtml = moreUpcoming.length > 0
    ? `
      <p class="ph-dash-note mt-4">You have ${moreUpcoming.length} more upcoming appointment${moreUpcoming.length === 1 ? '' : 's'}:</p>
      <ul class="ph-dash-list mt-2">
        ${moreUpcoming.slice(0, DASHBOARD_MORE_UPCOMING_LIMIT).map(next => {
          const nextStatus = getAppointmentStatusLabel(next.status);
          return `
            <li class="ph-dash-list-item">
              <div class="ph-dash-list-main">
                <p class="ph-dash-list-title">${escapeHtml(hasRecordedValue(next.pet_name) ? next.pet_name : 'N/A')} &middot; ${escapeHtml(hasRecordedValue(next.service_type) ? next.service_type : 'N/A')}</p>
                <p class="ph-dash-list-meta">${escapeHtml(formatAppointmentDate(next.appointment_date))}, ${escapeHtml(getAppointmentTimeRangeDisplay(next))}</p>
              </div>
              <span class="${getStatusBadgeClasses(nextStatus)} px-2 py-1 text-xs">${escapeHtml(nextStatus)}</span>
            </li>
          `;
        }).join('')}
      </ul>
      ${moreUpcoming.length > DASHBOARD_MORE_UPCOMING_LIMIT ? `<p class="ph-dash-note mt-2">More are listed on the <a href="appointments.html" class="ph-dash-link">Appointments page</a>.</p>` : ''}
    `
    : '';

  appointmentsContainer.innerHTML = `
    <article class="ph-dash-card" aria-label="Next appointment">
      <div class="ph-dash-card-head">
        <div>
          <p class="ph-dash-eyebrow">Next appointment</p>
          <p class="ph-dash-card-title">${escapeHtml(formatAppointmentDate(apt.appointment_date))}</p>
          <p class="ph-dash-list-meta">${escapeHtml(getAppointmentTimeRangeDisplay(apt))}</p>
        </div>
        <div>
          <span class="${getStatusBadgeClasses(status)} px-2 py-1 text-xs">${escapeHtml(status)}</span>
          <p class="ph-dash-note mt-1">${escapeHtml(getAppointmentStatusNote(status))}</p>
        </div>
      </div>
      <dl class="ph-dash-facts">
        ${getFactHtml('Pet', hasRecordedValue(apt.pet_name) ? apt.pet_name : 'N/A')}
        ${getFactHtml('Service', hasRecordedValue(apt.service_type) ? apt.service_type : 'N/A')}
        ${getFactHtml('Duration', getAppointmentDurationLabel(apt))}
        ${getFactHtml('Reference', getAppointmentReference(apt))}
        ${handledByRow}
      </dl>
    </article>
    ${moreUpcomingHtml}
  `;
}

// One label and value of a details list; the visually hidden colon keeps "Label: value" when read or copied as text
function getFactHtml(label, value) {
  return `<div><dt>${escapeHtml(label)}<span class="sr-only">:</span></dt> <dd>${escapeHtml(value)}</dd></div>`;
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

// Status badge colours (assets/css/input.css .ph-status-*), readable in both themes; the same as the booking page's
function getStatusBadgeClasses(status) {
  const classes = {
    'Pending': 'ph-status ph-status-pending',
    'Approved': 'ph-status ph-status-approved',
    'Completed': 'ph-status ph-status-completed',
    'Cancelled': 'ph-status ph-status-cancelled'
  };
  return classes[status] || 'ph-status ph-status-other';
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
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/auth/user-status?user_id=${encodeURIComponent(userData.id)}&include=profile`));
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
    // The profile stays out of setUser(), which writes to sessionStorage
    userDashboardData.profile = data.profile && typeof data.profile === 'object' ? data.profile : null;
    return data.user;
  } catch (error) {
    console.error('Error refreshing user status:', error);
    throw error;
  }
}

function displayRecentActivity(logs) {
  const activityContainer = document.getElementById('recentActivityContainer');
  if (!activityContainer) return;
  const activityLogs = Array.isArray(logs) ? logs : [];

  if (activityLogs.length === 0) {
    activityContainer.innerHTML = getEmptyStateHtml(
      'No recent activity yet',
      'Appointment requests, cancellations, profile changes and messages to the clinic appear here.'
    );
    return;
  }

  activityContainer.innerHTML = `
    <ul class="ph-dash-list">
      ${activityLogs.slice(0, 5).map(log => {
        const action = formatActivityAction(log.action);
        const details = log.details ? String(log.details) : '';
        const date = log.created_at ? formatDateTime(log.created_at) : 'Date not recorded';

        return `
          <li class="ph-dash-list-item">
            <span class="ph-dash-stat-icon"><i class="${getUserActivityIconClass(log.action)}" aria-hidden="true"></i></span>
            <div class="ph-dash-list-main">
              <p class="ph-dash-list-title">${escapeHtml(action)}</p>
              ${details ? `<p class="ph-dash-list-meta">${escapeHtml(details)}</p>` : ''}
              <p class="ph-dash-list-meta">${escapeHtml(date)}</p>
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

// Same icons as the admin activity log (admin/dashboard.js getActivityIcon) where the actions overlap;
// actions without a mapping keep the generic history icon
function getUserActivityIconClass(action) {
  const iconMap = {
    user_logged_in: 'ri-login-circle-line',
    user_logged_out: 'ri-logout-circle-line',
    user_registered: 'ri-user-add-line',
    email_verified: 'ri-mail-check-line',
    verification_code_resent: 'ri-mail-send-line',
    registration_email_failed: 'ri-mail-close-line',
    verification_email_failed: 'ri-mail-close-line',
    password_reset_requested: 'ri-lock-password-line',
    password_reset_code_failed: 'ri-lock-password-line',
    password_reset_completed: 'ri-lock-password-line',
    password_reset_failed: 'ri-lock-password-line',
    password_reset_email_failed: 'ri-mail-close-line',
    profile_updated: 'ri-user-settings-line',
    contact_message: 'ri-chat-3-line',
    appointment_booked: 'ri-calendar-check-line',
    appointment_cancelled: 'ri-calendar-close-line',
    owner_weight_reported: 'ri-scales-3-line'
  };
  return Object.prototype.hasOwnProperty.call(iconMap, action) ? iconMap[action] : 'ri-history-line';
}

const USER_ACTIVITY_LABELS = {
  appointment_booked: 'Appointment requested',
  appointment_cancelled: 'Appointment cancelled',
  contact_message: 'Message sent to the clinic',
  owner_weight_reported: 'Pet weight reported',
  user_registered: 'Account created'
};

function formatActivityAction(action) {
  if (!action) return 'Action not recorded';
  if (USER_ACTIVITY_LABELS[action]) return USER_ACTIVITY_LABELS[action];
  return String(action)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

// Logout functionality handled by main.js
