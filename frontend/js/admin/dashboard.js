// ==================== ADMIN DASHBOARD ====================
// pages/admin/dashboard.html: four sections on one page, chosen from the address hash and the dashboard navigation
// (js/shared/dashboard-shell.js calls window.showAdminView):
//   #overview      Real totals, pending requests, today's and upcoming approved appointments, recent administrative
//                  activity, shortcuts and clinic charts.
//   #appointments  Appointment Management: every appointment, searchable and filterable by pet/owner/reference,
//                  status, service and date; approve, complete or cancel.
//   #records       Pet & Medical Records: pets with their owners, each pet's official records, and adding a record for
//                  a completed appointment.
//   #system        System Management: users and roles, contact messages, activity logs, service catalog and booking.
//
// Data (all real PetHub records; nothing here is a placeholder figure):
//   GET /admin/dashboard/overview          users, pets, appointments (with owner and handler names), medical records
//   GET /admin/system-logs                 the activity log (newest first)
//   GET /admin/dashboard/contact-messages  contact form messages (if the overview does not include them)
//   GET /appointments/services             the clinic's nine services and whether each can be booked online
// Changes:
//   PUT  /admin/dashboard/appointment-status          { id, status }
//   POST /admin/dashboard/medical-records/create      { pet_id, appointment_id, record_date, weight, ... }
//   PUT  /admin/dashboard/user-role                   { id, role }
//   PUT  /admin/dashboard/contact-message-status      { id, status: 'Read' }
// Authorization: every request carries the session token (core/api.js). backend/routes/admin.js runs requireAuth (the
// token must match the user_id sent) and validateAdminAccess (the account's admin role is re-read from the database)
// before any /admin handler; a non-admin gets 403 whatever this page shows. The role check below only redirects
// non-admins to their own dashboard.
// Every change is shown as done only after the server confirms it; the dashboard then reloads its data from the
// server, so what is displayed is always the server's state. Failures show the server's message and change nothing.

// Connection retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY = 500; // milliseconds
const NEW_USER_WINDOW_DAYS = 7;
// "Upcoming check-ups": Pending or Approved check-up appointments in the next 7 days (same rule as backend/services/adminService.js)
const UPCOMING_CHECKUPS_WINDOW_DAYS = 7;
const UPCOMING_CHECKUPS_STATUSES = ['Pending', 'Approved'];
const CHECKUP_SERVICE_NAMES = ['Dog & Cat Full Check Up', 'Checkup'];
const CONTACT_MESSAGE_ACTIONABLE_STATUS = 'Unread';
const CONTACT_MESSAGE_READ_STATUS = 'Read';
const ADMIN_SYSTEM_TAB_STORAGE_KEY = 'pethubAdminDashboardSystemTab';
const ADMIN_APPOINTMENT_STATUS_STORAGE_KEY = 'pethubAdminDashboardAppointmentStatusFilter';
const ADMIN_VIEWS = ['overview', 'appointments', 'records', 'system'];
const SYSTEM_TABS = ['users', 'messages', 'activity', 'services'];
const APPOINTMENT_STATUSES = ['Pending', 'Approved', 'Completed', 'Cancelled'];
const OVERVIEW_LIST_LIMIT = 5;
const SYSTEM_LOG_LIMIT = 50;
// Earlier addresses of these sections (the previous dashboard views and the retired Users, Pets and Appointments pages)
const LEGACY_ADMIN_HASHES = {
  dashboard: { view: 'overview' },
  dashboardOverview: { view: 'overview' },
  analytics: { view: 'overview' },
  analyticsSummary: { view: 'overview' },
  management: { view: 'appointments' },
  medicalRecords: { view: 'records' },
  medicalRecordsSection: { view: 'records' },
  pets: { view: 'records' },
  users: { view: 'system', tab: 'users' },
  messages: { view: 'system', tab: 'messages' },
  activityLogs: { view: 'system', tab: 'activity' },
  systemLogs: { view: 'system', tab: 'activity' },
  services: { view: 'system', tab: 'services' }
};

document.addEventListener('DOMContentLoaded', () => {
  initializeAdminDashboard();
});

let petTypeChart = null;
let serviceUsageChart = null;
let appointmentTrendChart = null;
let currentAdminView = 'overview';
let currentSystemTab = 'users';
let selectedAdminPetId = '';
let dashboardOverviewLoadPromise = null;
let adminDashboardInteractionsBound = false;
let adminStatusTimeoutId = null;
let dashboardRefreshInProgress = false;
let adminDashboardData = {
  isLoading: false,
  isLoaded: false,
  users: [],
  pets: [],
  appointments: [],
  medicalRecords: [],
  activityLogs: [],
  activityLogsLoaded: false,
  activityLogsLoading: false,
  activityLogsError: '',
  messages: [],
  messagesLoaded: false,
  messagesLoading: false,
  messagesError: '',
  overviewError: '',
  stats: {},
  summary: {},
  // The clinic's service catalog (GET /appointments/services)
  serviceCatalog: [],
  serviceCatalogLoaded: false,
  serviceCatalogError: '',
  petTypes: { labels: [], values: [] },
  serviceUsage: { labels: [], values: [] },
  appointmentsTrend: { labels: [], values: [] }
};

function getActivityIcon(action) {
  const iconMap = {
    user_logged_in: 'ri-login-circle-line text-blue-500',
    user_registered: 'ri-user-add-line text-green-500',
    email_verified: 'ri-mail-check-line text-teal-500',
    profile_updated: 'ri-user-settings-line text-orange-500',
    pet_created: 'ri-bear-smile-line text-orange-500',
    appointment_booked: 'ri-calendar-check-line text-purple-500',
    appointment_completed: 'ri-check-double-line text-green-500',
    appointment_cancelled: 'ri-close-circle-line text-red-500'
  };
  return iconMap[action] || 'ri-history-line text-gray-500';
}

function formatActivityMessage(action, details) {
  const messageMap = {
    user_logged_in: 'Signed in to your account',
    user_registered: 'Created a new account',
    email_verified: 'Verified an email address',
    profile_updated: 'Updated personal details',
    pet_created: 'Added a new pet profile',
    appointment_booked: 'Booked a new appointment',
    appointment_completed: 'Completed an appointment',
    appointment_cancelled: 'Cancelled an appointment'
  };
  if (messageMap[action]) return messageMap[action];
  if (details) return details;
  if (action) return String(action).replace(/_/g, ' ');
  return 'Action not recorded';
}

/**
 * Initialize admin dashboard
 */
async function initializeAdminDashboard() {
  // Check authentication and admin role
  const user = getUser();

  if (!isLoggedIn() || !user || String(user.role || '').toLowerCase() !== 'admin') {
    // Signed-in non-admins go to their own dashboard; everyone else signs in first
    if (isLoggedIn() && user) redirectToDashboardForRole(user.role); else redirectToLogin();
    return;
  }

  let adminUser = user;
  try {
    adminUser = await refreshCurrentUser();
  } catch (error) {
    console.error('Admin user refresh failed:', error);
    if (!adminUser || !isRecoverableUserRefreshError(error)) {
      logout();
      return;
    }
    console.warn('Using cached admin data after a temporary refresh failure.');
  }

  adminUser = getUser();

  if (!adminUser || String(adminUser.role || '').toLowerCase() !== 'admin' || !isVerified()) {
    logout();
    return;
  }

  adminDashboardData.isLoading = true;
  adminDashboardData.messagesLoading = true;
  adminDashboardData.activityLogsLoading = true;

  displayAdminHeaderInfo();
  currentSystemTab = getStoredSystemTab();
  setupAdminDashboardInteractions();

  const initial = resolveAdminLocation(window.location.hash);
  showAdminView(initial.view, { systemTab: initial.tab });
  // Back/forward and typed addresses; other hashes (none are used on this page) are ignored
  window.addEventListener('hashchange', () => {
    const location = resolveAdminLocation(window.location.hash, false);
    if (location) showAdminView(location.view, { systemTab: location.tab });
  });

  await Promise.all([loadDashboardOverview(), loadServiceCatalog()]);
}

function displayAdminHeaderInfo() {
  const adminDate = document.getElementById('adminDate');
  const adminRoleBadge = document.getElementById('adminRoleBadge');
  const userData = getUser();

  if (adminDate) {
    adminDate.textContent = getAdminAccountLabel(userData);
  }

  if (adminRoleBadge) {
    adminRoleBadge.textContent = formatRoleLabel(userData?.role);
  }

  if (window.PetHubDashboardShell && userData) {
    window.PetHubDashboardShell.setAccountName(userData.fullname || userData.email || 'Admin');
  }
}

// "#appointments" -> { view: 'appointments' }; earlier hashes map to the section that replaced them. With
// fallback=false an unknown hash gives null instead of the Overview.
function resolveAdminLocation(hash, fallback = true) {
  const value = String(hash || '').replace(/^#/, '').trim();
  if (ADMIN_VIEWS.includes(value)) return { view: value };
  if (LEGACY_ADMIN_HASHES[value]) return LEGACY_ADMIN_HASHES[value];
  return fallback ? { view: 'overview' } : null;
}

function normalizeSystemTab(tab) {
  return SYSTEM_TABS.includes(tab) ? tab : 'users';
}

function getStoredSystemTab() {
  try {
    return normalizeSystemTab(sessionStorage.getItem(ADMIN_SYSTEM_TAB_STORAGE_KEY));
  } catch (error) {
    return 'users';
  }
}

function setStoredSystemTab(tab) {
  currentSystemTab = normalizeSystemTab(tab);
  try {
    sessionStorage.setItem(ADMIN_SYSTEM_TAB_STORAGE_KEY, currentSystemTab);
  } catch (error) {
    // Ignore storage failures; the visible tab still updates for this page session.
  }
}

function getStoredAdminAppointmentStatusFilter() {
  try {
    const status = sessionStorage.getItem(ADMIN_APPOINTMENT_STATUS_STORAGE_KEY);
    return ['all', ...APPOINTMENT_STATUSES].includes(status) ? status : 'all';
  } catch (error) {
    return 'all';
  }
}

function setStoredAdminAppointmentStatusFilter(status) {
  const normalizedStatus = ['all', ...APPOINTMENT_STATUSES].includes(status) ? status : 'all';
  try {
    sessionStorage.setItem(ADMIN_APPOINTMENT_STATUS_STORAGE_KEY, normalizedStatus);
  } catch (error) {
    // Ignore storage failures; the selected filter still stays active in the DOM.
  }
}

// Shows one of the four sections; options.systemTab opens a System Management tab, options.focusHeading moves keyboard
// focus to the section's heading (used when the section is chosen from the navigation)
function showAdminView(viewName, options = {}) {
  const view = ADMIN_VIEWS.includes(viewName) ? viewName : 'overview';
  currentAdminView = view;
  const views = {
    overview: document.getElementById('adminViewOverview'),
    appointments: document.getElementById('adminViewAppointments'),
    records: document.getElementById('adminViewRecords'),
    system: document.getElementById('adminViewSystem')
  };

  Object.entries(views).forEach(([name, element]) => {
    if (element) element.hidden = name !== view;
  });

  if (view === 'system' && options.systemTab) setStoredSystemTab(options.systemTab);
  if (window.PetHubDashboardShell) window.PetHubDashboardShell.setActive(view);
  updateAdminViewHash(view);
  renderCurrentAdminView();

  if (options.focusHeading) {
    const heading = views[view]?.querySelector('h1');
    if (heading) {
      heading.focus();
      window.scrollTo({ top: 0 });
    }
  }
}

window.showAdminView = showAdminView;

function updateAdminViewHash(viewName) {
  if (window.location.hash.replace(/^#/, '') === viewName) return;
  history.replaceState(null, '', `#${viewName}`);
}

function markInteractionFeedback(element) {
  if (!element) return;
  element.classList.remove('is-pressed');
  void element.offsetWidth;
  element.classList.add('is-pressed');
  window.setTimeout(() => {
    element.classList.remove('is-pressed');
  }, 180);
}

function getFriendlyAdminErrorMessage(sectionName) {
  return `We couldn't load ${sectionName} right now. Please refresh the page or try again later.`;
}

function getAdminErrorBlock(title, sectionName) {
  return `
    <div class="ph-dash-error" role="alert">
      <p class="ph-dash-error-title">${escapeHtml(title)}</p>
      <p class="ph-dash-error-text">${escapeHtml(getFriendlyAdminErrorMessage(sectionName))}</p>
    </div>
  `;
}

function getAdminEmptyBlock(title, text) {
  return `
    <div class="ph-dash-empty">
      <p class="ph-dash-empty-title">${escapeHtml(title)}</p>
      ${text ? `<p class="ph-dash-empty-text">${escapeHtml(text)}</p>` : ''}
    </div>
  `;
}

function getAdminTableErrorRow(colspan, title, sectionName) {
  return `
    <tr>
      <td colspan="${colspan}">${getAdminErrorBlock(title, sectionName)}</td>
    </tr>
  `;
}

function getAdminTableEmptyRow(colspan, title, text) {
  return `
    <tr>
      <td colspan="${colspan}">${getAdminEmptyBlock(title, text)}</td>
    </tr>
  `;
}

function getDashboardInlineLoadingHtml(label = 'Loading') {
  return `
    <span class="dashboard-inline-loading" role="status" aria-live="polite">
      <span class="dashboard-inline-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(label)}</span>
    </span>
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

function getAdminTableLoadingRow(colspan, sectionName) {
  return `
    <tr>
      <td colspan="${colspan}" class="dashboard-table-loading">
        ${getDashboardSectionLoadingHtml(sectionName, 1)}
      </td>
    </tr>
  `;
}

function setElementLoading(elementId, label = 'Loading') {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = getDashboardInlineLoadingHtml(label);
  }
}

function showChartLoadingState(chartId, messageId, sectionName) {
  const chartEl = document.getElementById(chartId);
  const messageEl = document.getElementById(messageId);
  if (chartEl) chartEl.classList.add('hidden');
  if (messageEl) {
    messageEl.classList.remove('hidden');
    messageEl.innerHTML = getDashboardSectionLoadingHtml(sectionName, 1);
  }
}

function showAdminAnalyticsLoadingStates() {
  showChartLoadingState('petTypeChart', 'petTypeNoData', 'pet type data');
  showChartLoadingState('serviceUsageChart', 'serviceUsageNoData', 'service data');
  showChartLoadingState('appointmentTrendChart', 'appointmentTrendNoData', 'appointment trends');
  ['insightPetType', 'insightService', 'insightBookings', 'insightCompletion', 'analyticsUpcomingCheckups'].forEach(id => {
    setElementLoading(id, 'Loading');
  });
}

function showAdminDashboardLoadingStates() {
  [
    'statPetOwners',
    'statPets',
    'statAppointments',
    'statPending',
    'alertPendingAppointments',
    'alertUnreadMessages',
    'alertNewUsers',
    'alertMedicalRecords'
  ].forEach(id => setElementLoading(id, 'Loading'));

  ['overviewPendingList', 'overviewUpcomingList', 'overviewAdminActivity'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.innerHTML = getDashboardSectionLoadingHtml('records', 1);
  });

  showAdminAnalyticsLoadingStates();
}

function renderCurrentAdminView() {
  if (currentAdminView === 'appointments') return renderAppointmentsView();
  if (currentAdminView === 'records') return renderRecordsView();
  if (currentAdminView === 'system') return renderSystemView();
  return renderOverview();
}

function isOverviewLoading() {
  return adminDashboardData.isLoading && !adminDashboardData.isLoaded;
}

function renderOverview() {
  if (isOverviewLoading()) {
    showAdminDashboardLoadingStates();
    return;
  }
  displayOverviewStats(adminDashboardData.summary || {});
  displayDashboardAlerts(adminDashboardData.summary || {});
  renderOverviewPendingList();
  renderOverviewUpcomingList();
  renderOverviewAdminActivity();
  displayAnalyticsInsights();
  // Charts are drawn while the Overview is visible so Chart.js can measure the canvases
  renderPetTypeChart(adminDashboardData.petTypes.labels, adminDashboardData.petTypes.values);
  renderServiceUsageChart(adminDashboardData.serviceUsage.labels, adminDashboardData.serviceUsage.values);
  renderAppointmentTrendChart(adminDashboardData.appointmentsTrend.labels, adminDashboardData.appointmentsTrend.values);
}

function renderAppointmentsView() {
  const statusSelect = document.getElementById('appointmentStatusFilter');
  if (statusSelect && !statusSelect.dataset.ready) {
    statusSelect.value = getStoredAdminAppointmentStatusFilter();
    statusSelect.dataset.ready = 'true';
  }
  if (isOverviewLoading()) {
    const table = document.getElementById('appointmentsTable');
    if (table) table.innerHTML = getAdminTableLoadingRow(9, 'appointments');
    return;
  }
  populateAppointmentServiceFilter();
  applyAppointmentFilters();
}

function renderRecordsView() {
  if (isOverviewLoading()) {
    const petsTable = document.getElementById('petsTable');
    const recordsContainer = document.getElementById('recentMedicalRecordsContainer');
    if (petsTable) petsTable.innerHTML = getAdminTableLoadingRow(7, 'pets');
    if (recordsContainer) recordsContainer.innerHTML = getDashboardSectionLoadingHtml('medical records', 2);
    return;
  }
  applyPetSearch();
  displayMedicalRecordsSection(adminDashboardData.medicalRecords);
  renderAdminPetDetail();
}

function renderSystemView() {
  switchSystemTab(currentSystemTab, { render: false });
  if (isOverviewLoading()) {
    const usersTable = document.getElementById('usersTable');
    if (usersTable) usersTable.innerHTML = getAdminTableLoadingRow(5, 'users');
  } else {
    applyUserSearch();
  }
  renderMessages();
  renderSystemLogs();
  renderServiceCatalog();
  updateUnreadMessagesCount();
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
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(fetchFn, retries - 1);
    }
    throw error;
  }
}

async function refreshCurrentUser() {
  const userData = getUser();
  if (!userData) {
    throw new Error('No user data available');
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/auth/user-status?user_id=${userData.id}`));
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const refreshError = new Error(errorData.error || 'Unable to refresh user status');
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

function isRecoverableUserRefreshError(error) {
  const status = Number(error?.status || 0);
  return !status || status >= 500;
}

function getAdminUserIdQuery() {
  const userData = getUser();
  return userData && userData.id ? `?user_id=${encodeURIComponent(userData.id)}` : '';
}

function getCurrentAdminUserId() {
  const userData = getUser();
  return userData && userData.id ? String(userData.id) : '';
}

function getAdminActionButtonClass(type) {
  const classes = {
    danger: 'ph-btn ph-btn-ghost ph-btn-sm',
    success: 'ph-btn ph-btn-primary ph-btn-sm',
    neutral: 'ph-btn ph-btn-secondary ph-btn-sm'
  };

  return classes[type] || classes.neutral;
}

function setActionButtonGroupLoading(button, isLoading, loadingText, defaultText) {
  if (!button) return;

  const actionButtons = Array.from(button.closest('div')?.querySelectorAll('button') || [button]);
  actionButtons.forEach(actionButton => {
    if (actionButton === button) {
      updateButtonState(actionButton, isLoading, loadingText, defaultText);
    } else {
      actionButton.disabled = isLoading;
      actionButton.classList.toggle('is-peer-disabled', isLoading);
    }
  });
}

async function loadSystemLogs(shouldRender = true) {
  const userData = getUser();
  adminDashboardData.activityLogsLoading = true;
  adminDashboardData.activityLogsError = '';
  if (shouldRender) renderSystemLogs();

  if (!userData) {
    adminDashboardData.activityLogs = [];
    adminDashboardData.activityLogsLoaded = true;
    adminDashboardData.activityLogsLoading = false;
    if (shouldRender) renderSystemLogs();
    return [];
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/system-logs${getAdminUserIdQuery()}&limit=${SYSTEM_LOG_LIMIT}`));
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load system logs (${response.status})`);
    }

    const data = await response.json().catch(() => ({}));
    adminDashboardData.activityLogs = Array.isArray(data.logs) ? data.logs : [];
    adminDashboardData.activityLogsLoaded = true;
    adminDashboardData.activityLogsLoading = false;
    adminDashboardData.activityLogsError = '';
    if (shouldRender) renderSystemLogs();
    return adminDashboardData.activityLogs;
  } catch (error) {
    console.error('Error loading system logs:', error);
    adminDashboardData.activityLogs = [];
    adminDashboardData.activityLogsLoaded = true;
    adminDashboardData.activityLogsLoading = false;
    adminDashboardData.activityLogsError = error.message || 'Unable to load system logs.';
    if (shouldRender) renderSystemLogs();
    return [];
  } finally {
    adminDashboardData.activityLogsLoading = false;
  }
}

// The clinic's service catalog for System Management, the service filter and the "earlier service" labels
async function loadServiceCatalog() {
  adminDashboardData.serviceCatalogLoaded = false;
  adminDashboardData.serviceCatalogError = '';
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/appointments/services`));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false || !Array.isArray(data.services)) {
      throw new Error(data.error || `Failed to load services (${response.status})`);
    }
    adminDashboardData.serviceCatalog = data.services;
  } catch (error) {
    console.error('Error loading the service catalog:', error);
    adminDashboardData.serviceCatalog = [];
    adminDashboardData.serviceCatalogError = error.message || 'Unable to load services.';
  } finally {
    adminDashboardData.serviceCatalogLoaded = true;
    renderServiceCatalog();
    if (currentAdminView === 'appointments' && adminDashboardData.isLoaded) renderAppointmentsView();
  }
}

/**
 * Display dashboard statistics
 */

function formatDashboardValue(value) {
  if (value === null || value === undefined || value === 'Loading...') return '-';
  if (Number.isInteger(value) && value >= 0) return String(value);
  const numericValue = Number(value);
  if (!Number.isNaN(numericValue) && Number.isInteger(numericValue) && numericValue >= 0) {
    return String(numericValue);
  }
  return '-';
}

function formatDashboardDataValue(value, unavailable = false) {
  return unavailable ? 'Unavailable' : formatDashboardValue(value);
}

function hasRecordedValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getUserById(userId) {
  if (!hasRecordedValue(userId)) return null;
  const id = String(userId);
  return adminDashboardData.users.find(user => String(user.id) === id) || null;
}

function getUserNameById(userId) {
  const user = getUserById(userId);
  return hasRecordedValue(user?.fullname) ? String(user.fullname) : '';
}

function getPetById(petId) {
  if (!hasRecordedValue(petId)) return null;
  const id = String(petId);
  return adminDashboardData.pets.find(pet => String(pet.id) === id) || null;
}

function getPetNameById(petId) {
  const pet = getPetById(petId);
  return hasRecordedValue(pet?.name) ? String(pet.name) : '';
}

function getAppointmentPetLabel(appointment) {
  if (hasRecordedValue(appointment?.pet_name)) return String(appointment.pet_name);
  const petName = getPetNameById(appointment?.pet_id);
  if (petName) return petName;
  if (hasRecordedValue(appointment?.pet_id)) return `Pet ID: ${appointment.pet_id}`;
  return 'Pet not listed';
}

function getAppointmentOwnerLabel(appointment) {
  if (hasRecordedValue(appointment?.owner_fullname) && appointment.owner_fullname !== 'Unknown') return String(appointment.owner_fullname);
  return getUserNameById(appointment?.user_id) || 'Owner not recorded';
}

// Same short reference the owner sees (the stored appointment_reference is empty)
function getAppointmentReference(appointment) {
  const compactId = String(appointment?.id || '').replace(/[^A-Za-z0-9]/g, '');
  return compactId ? `PH-${compactId.slice(0, 8).toUpperCase()}` : 'N/A';
}

function getRecordDateTime(record) {
  const date = new Date(record?.record_date || record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getMedicalRecordsForPet(petId) {
  if (!hasRecordedValue(petId)) return [];
  const id = String(petId);
  return asArray(adminDashboardData.medicalRecords)
    .filter(record => String(record.pet_id) === id)
    .sort((a, b) => getRecordDateTime(b) - getRecordDateTime(a));
}

function getMedicalRecordPetLabel(record) {
  const petName = getPetNameById(record?.pet_id);
  if (petName) return petName;
  if (hasRecordedValue(record?.pet_id)) return `Pet ID: ${record.pet_id}`;
  return 'Pet profile unavailable';
}

function getMedicalRecordRecorderLabel(record) {
  if (!hasRecordedValue(record?.created_by)) return 'Not specified';
  if (hasRecordedValue(record?.created_by_name)) return String(record.created_by_name);
  if (hasRecordedValue(record?.recorded_by_name)) return String(record.recorded_by_name);
  const creatorName = getUserNameById(record.created_by);
  if (hasRecordedValue(creatorName)) return creatorName;
  return 'Not specified';
}

function normalizeDashboardDateValue(value) {
  if (!hasRecordedValue(value)) return '';
  const rawValue = String(value).trim();
  const dateOnlyMatch = rawValue.match(/^\d{4}-\d{2}-\d{2}/);
  if (dateOnlyMatch) return dateOnlyMatch[0];
  const parsedDate = new Date(rawValue);
  return Number.isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString().slice(0, 10);
}

function getTodayDateKey() {
  const now = new Date();
  const timezoneOffsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

// Sort key for date and time: "2026-10-21 10:00"
function getAppointmentSortKey(appointment) {
  return `${normalizeDashboardDateValue(appointment?.appointment_date) || '9999-12-31'} ${String(appointment?.appointment_time || '').slice(0, 8)}`;
}

function countAppointmentsByStatus(status) {
  return asArray(adminDashboardData.appointments)
    .filter(appointment => getAppointmentStatus(appointment.status) === status)
    .length;
}

function countUpcomingBookings() {
  const today = getTodayDateKey();
  return asArray(adminDashboardData.appointments).filter(appointment => {
    const dateKey = normalizeDashboardDateValue(appointment.appointment_date);
    return dateKey && dateKey >= today && getAppointmentStatus(appointment.status) !== 'Cancelled';
  }).length;
}

function countUpcomingCheckups() {
  const today = getTodayDateKey();
  const windowEndDate = new Date();
  windowEndDate.setDate(windowEndDate.getDate() + UPCOMING_CHECKUPS_WINDOW_DAYS);
  const windowEnd = new Date(windowEndDate.getTime() - windowEndDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return asArray(adminDashboardData.appointments).filter(appointment => {
    const service = String(appointment.service_type || '').trim();
    const dateKey = normalizeDashboardDateValue(appointment.appointment_date);
    return CHECKUP_SERVICE_NAMES.includes(service) && dateKey && dateKey >= today && dateKey <= windowEnd &&
      UPCOMING_CHECKUPS_STATUSES.includes(getAppointmentStatus(appointment.status));
  }).length;
}

function countVerifiedUsersFromRecords() {
  return asArray(adminDashboardData.users).filter(user => isVerifiedValue(user.is_verified)).length;
}

// Pet owners are customer accounts: role "user" (accounts without a role are treated as customers everywhere in PetHub)
function countPetOwners() {
  return asArray(adminDashboardData.users)
    .filter(user => String(user.role || 'user').trim().toLowerCase() === 'user')
    .length;
}

function buildRealDashboardSummary(summary = {}) {
  if (adminDashboardData.overviewError) {
    return summary || {};
  }

  const users = asArray(adminDashboardData.users);
  const pets = asArray(adminDashboardData.pets);
  const appointments = asArray(adminDashboardData.appointments);
  const medicalRecords = asArray(adminDashboardData.medicalRecords);
  const completedAppointments = countAppointmentsByStatus('Completed');
  const totalAppointments = appointments.length;
  const verifiedSummaryCount = getDashboardCount(summary?.verifiedUsers);
  const unverifiedSummaryCount = getDashboardCount(summary?.unverifiedUsers);
  const pendingVerificationsCount = getDashboardCount(summary?.pendingVerifications);
  const activityLogCount = getDashboardCount(summary?.activityLogCount);
  const upcomingCheckupsSummaryCount = getDashboardCount(summary?.upcomingCheckups);

  return {
    ...summary,
    totalUsers: users.length,
    petOwners: countPetOwners(),
    totalPets: pets.length,
    totalAppointments,
    pendingAppointments: countAppointmentsByStatus('Pending'),
    completedAppointments,
    upcomingCheckups: upcomingCheckupsSummaryCount !== null ? upcomingCheckupsSummaryCount : countUpcomingCheckups(),
    upcomingBookings: countUpcomingBookings(),
    completedAppointmentPercentage: totalAppointments > 0
      ? Math.round((completedAppointments / totalAppointments) * 100)
      : 0,
    verifiedUsers: verifiedSummaryCount !== null ? verifiedSummaryCount : countVerifiedUsersFromRecords(),
    unverifiedUsers: unverifiedSummaryCount !== null ? unverifiedSummaryCount : Math.max(users.length - countVerifiedUsersFromRecords(), 0),
    pendingVerifications: pendingVerificationsCount !== null ? pendingVerificationsCount : undefined,
    activityLogCount: activityLogCount !== null ? activityLogCount : undefined,
    totalMedicalRecords: medicalRecords.length
  };
}

function formatDatasetLabel(value, fallback) {
  if (!hasRecordedValue(value)) return fallback;
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function buildCountDataset(records, getLabel) {
  const counts = {};
  asArray(records).forEach(record => {
    const label = getLabel(record);
    if (!hasRecordedValue(label)) return;
    counts[label] = (counts[label] || 0) + 1;
  });

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    labels: entries.map(([label]) => label),
    values: entries.map(([, value]) => value)
  };
}

function buildPetTypeDataset() {
  return buildCountDataset(adminDashboardData.pets, pet => formatDatasetLabel(pet.species, 'Species not recorded'));
}

function buildServiceUsageDataset() {
  return buildCountDataset(adminDashboardData.appointments, appointment => formatDatasetLabel(appointment.service_type, 'Service not recorded'));
}

function buildAppointmentTrendDataset() {
  const currentDate = new Date();
  const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(currentDate);
    date.setDate(currentDate.getDate() - (6 - index));
    return date;
  });
  const labels = lastSevenDays.map(date => date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  }));
  const keys = lastSevenDays.map(date => {
    const timezoneOffsetMs = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
  });
  const counts = keys.reduce((acc, dateKey) => {
    acc[dateKey] = 0;
    return acc;
  }, {});

  asArray(adminDashboardData.appointments).forEach(appointment => {
    const dateKey = normalizeDashboardDateValue(appointment.appointment_date);
    if (dateKey && Object.prototype.hasOwnProperty.call(counts, dateKey)) {
      counts[dateKey] += 1;
    }
  });

  return {
    labels,
    values: keys.map(dateKey => counts[dateKey] || 0)
  };
}

function refreshDerivedDashboardData(rawSummary = adminDashboardData.summary || {}) {
  adminDashboardData.summary = buildRealDashboardSummary(rawSummary);
  adminDashboardData.petTypes = buildPetTypeDataset();
  adminDashboardData.serviceUsage = buildServiceUsageDataset();
  adminDashboardData.appointmentsTrend = buildAppointmentTrendDataset();
}

// A figure on the Overview: the count, or "Unavailable" (muted) when the overview could not be loaded
function setOverviewFigure(elementId, value, unavailable) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const text = formatDashboardDataValue(value, unavailable);
  element.textContent = text;
  element.classList.toggle('is-muted', text === 'Unavailable' || text === '-');
}

function displayOverviewStats(summary) {
  const summaryData = buildRealDashboardSummary(summary || {});
  const unavailable = Boolean(adminDashboardData.overviewError);

  setOverviewFigure('statPetOwners', summaryData.petOwners, unavailable);
  setOverviewFigure('statPets', summaryData.totalPets, unavailable);
  setOverviewFigure('statAppointments', summaryData.totalAppointments, unavailable);
  setOverviewFigure('statPending', summaryData.pendingAppointments, unavailable);
  setOverviewFigure('analyticsUpcomingCheckups', summaryData.upcomingCheckups, unavailable);

  adminDashboardData.summary = summaryData;
}

function getDashboardCount(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

function getPendingAppointmentsAlertCount(summary) {
  if (adminDashboardData.overviewError) return 'Unavailable';
  const summaryCount = getDashboardCount(summary?.pendingAppointments);
  if (summaryCount !== null) return summaryCount;
  return adminDashboardData.appointments.filter(appointment => getAppointmentStatus(appointment.status) === 'Pending').length;
}

function getUnreadMessagesAlertValue() {
  if (adminDashboardData.messagesError) return 'Unavailable';
  if (!adminDashboardData.messagesLoaded && adminDashboardData.messagesLoading) return 'Loading...';

  const messages = Array.isArray(adminDashboardData.messages) ? adminDashboardData.messages : [];
  return messages.filter(message => String(message.status || '').toLowerCase() === 'unread').length;
}

function getNewUsersAlertValue() {
  const users = Array.isArray(adminDashboardData.users) ? adminDashboardData.users : [];
  if (adminDashboardData.overviewError) return 'Unavailable';
  const now = Date.now();
  const cutoff = now - (NEW_USER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return users.filter(user => {
    const createdAt = new Date(user.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now;
  }).length;
}

function displayDashboardAlerts(summary = adminDashboardData.summary || {}) {
  const pendingAppointments = document.getElementById('alertPendingAppointments');
  const unreadMessages = document.getElementById('alertUnreadMessages');
  const newUsers = document.getElementById('alertNewUsers');
  const medicalRecords = document.getElementById('alertMedicalRecords');

  if (pendingAppointments) pendingAppointments.textContent = String(getPendingAppointmentsAlertCount(summary));
  if (unreadMessages) {
    const unreadMessagesValue = getUnreadMessagesAlertValue();
    if (unreadMessagesValue === 'Loading...') {
      unreadMessages.innerHTML = getDashboardInlineLoadingHtml('Loading');
    } else {
      unreadMessages.textContent = String(unreadMessagesValue);
    }
  }
  if (newUsers) newUsers.textContent = String(getNewUsersAlertValue());
  if (medicalRecords) {
    medicalRecords.textContent = adminDashboardData.overviewError
      ? 'Unavailable'
      : String(asArray(adminDashboardData.medicalRecords).length);
  }
  updateUnreadMessagesCount();
}

function updateUnreadMessagesCount() {
  const badge = document.getElementById('systemUnreadCount');
  if (!badge) return;
  const unread = getUnreadMessagesAlertValue();
  badge.hidden = !(Number.isInteger(unread) && unread > 0);
  badge.textContent = Number.isInteger(unread) ? String(unread) : '';
  badge.setAttribute('aria-label', `${unread} unread`);
}

// ==================== OVERVIEW LISTS ====================

function getAppointmentListItemHtml(appointment, { showStatus = true, note = '' } = {}) {
  const status = getAppointmentStatus(appointment.status);
  return `
    <li class="ph-dash-list-item">
      <div class="ph-dash-list-main">
        <p class="ph-dash-list-title">${escapeHtml(getAppointmentPetLabel(appointment))} &middot; ${escapeHtml(displayValue(appointment.service_type, 'Service not recorded'))}</p>
        <p class="ph-dash-list-meta">${escapeHtml(formatTableDate(appointment.appointment_date, 'Date not set'))}, ${escapeHtml(getAppointmentTimeDisplay(appointment))} &middot; ${escapeHtml(getAppointmentOwnerLabel(appointment))}</p>
        ${note ? `<p class="ph-dash-list-meta">${escapeHtml(note)}</p>` : ''}
      </div>
      ${showStatus ? `<span class="${getStatusBadgeClass(status)}">${escapeHtml(status)}</span>` : ''}
    </li>
  `;
}

// Pending requests, soonest first (the ones to review first)
function renderOverviewPendingList() {
  const container = document.getElementById('overviewPendingList');
  if (!container) return;
  if (adminDashboardData.overviewError) {
    container.innerHTML = getAdminErrorBlock('Unable to load pending requests', 'appointments');
    return;
  }

  const today = getTodayDateKey();
  const pending = asArray(adminDashboardData.appointments)
    .filter(appointment => getAppointmentStatus(appointment.status) === 'Pending')
    .sort((a, b) => getAppointmentSortKey(a).localeCompare(getAppointmentSortKey(b)));

  if (!pending.length) {
    container.innerHTML = getAdminEmptyBlock('No pending requests', 'New bookings from pet owners appear here until they are approved or cancelled.');
    return;
  }

  container.innerHTML = `
    <ul class="ph-dash-list">
      ${pending.slice(0, OVERVIEW_LIST_LIMIT).map(appointment => getAppointmentListItemHtml(appointment, {
        showStatus: false,
        note: normalizeDashboardDateValue(appointment.appointment_date) < today ? 'This date has passed.' : ''
      })).join('')}
    </ul>
    ${pending.length > OVERVIEW_LIST_LIMIT ? `<p class="ph-dash-note mt-3">${pending.length - OVERVIEW_LIST_LIMIT} more in Appointment Management.</p>` : ''}
  `;
}

// Approved appointments from today on, soonest first
function renderOverviewUpcomingList() {
  const container = document.getElementById('overviewUpcomingList');
  if (!container) return;
  if (adminDashboardData.overviewError) {
    container.innerHTML = getAdminErrorBlock('Unable to load upcoming appointments', 'appointments');
    return;
  }

  const today = getTodayDateKey();
  const upcoming = asArray(adminDashboardData.appointments)
    .filter(appointment => getAppointmentStatus(appointment.status) === 'Approved' && normalizeDashboardDateValue(appointment.appointment_date) >= today)
    .sort((a, b) => getAppointmentSortKey(a).localeCompare(getAppointmentSortKey(b)));
  const todayCount = upcoming.filter(appointment => normalizeDashboardDateValue(appointment.appointment_date) === today).length;

  if (!upcoming.length) {
    container.innerHTML = getAdminEmptyBlock('No approved appointments from today on', 'Approved appointments appear here, soonest first.');
    return;
  }

  container.innerHTML = `
    <p class="ph-dash-note mb-3">${todayCount} today &middot; ${upcoming.length} approved from today on</p>
    <ul class="ph-dash-list">
      ${upcoming.slice(0, OVERVIEW_LIST_LIMIT).map(appointment => getAppointmentListItemHtml(appointment, {
        note: normalizeDashboardDateValue(appointment.appointment_date) === today ? 'Today' : ''
      })).join('')}
    </ul>
  `;
}

// Administrative activity: log entries made by an admin (they carry actor_id), newest first
function renderOverviewAdminActivity() {
  const container = document.getElementById('overviewAdminActivity');
  if (!container) return;
  if (adminDashboardData.activityLogsLoading && !adminDashboardData.activityLogsLoaded) {
    container.innerHTML = getDashboardSectionLoadingHtml('activity', 1);
    return;
  }
  if (adminDashboardData.activityLogsError) {
    container.innerHTML = getAdminErrorBlock('Unable to load activity', 'activity logs');
    return;
  }

  const adminLogs = asArray(adminDashboardData.activityLogs)
    .filter(log => hasRecordedValue(log.actor_id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, OVERVIEW_LIST_LIMIT);

  if (!adminLogs.length) {
    container.innerHTML = getAdminEmptyBlock('No administrative actions yet', 'Approvals, cancellations, records, role changes and messages marked as read appear here.');
    return;
  }

  container.innerHTML = `
    <ul class="ph-dash-list">
      ${adminLogs.map(log => `
        <li class="ph-dash-list-item">
          <div class="ph-dash-list-main">
            <p class="ph-dash-list-title">${escapeHtml(log.display_text || formatActivityMessage(log.action, log.details))}</p>
            <p class="ph-dash-list-meta">${escapeHtml(formatLogTimestamp(log.created_at))}</p>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

function formatLogTimestamp(value) {
  return value
    ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Time not recorded';
}

// Shortcut buttons and figures with data-admin-go="view" or "view:filter" (appointments:Pending, system:messages)
function goToAdminSection(target) {
  const [view, detail] = String(target || '').split(':');
  if (view === 'appointments') {
    const search = document.getElementById('appointmentSearchInput');
    const service = document.getElementById('appointmentServiceFilter');
    const date = document.getElementById('appointmentDateFilter');
    const status = document.getElementById('appointmentStatusFilter');
    if (search) search.value = '';
    if (service) service.value = 'all';
    if (date) date.value = '';
    if (status) {
      status.value = APPOINTMENT_STATUSES.includes(detail) ? detail : 'all';
      status.dataset.ready = 'true';
      setStoredAdminAppointmentStatusFilter(status.value);
    }
  }
  showAdminView(view, { systemTab: view === 'system' ? detail : undefined, focusHeading: true });
}

function showAdminStatus(type, message) {
  const statusElement = document.getElementById('adminDashboardStatus');
  if (!statusElement) return;

  if (adminStatusTimeoutId) {
    clearTimeout(adminStatusTimeoutId);
    adminStatusTimeoutId = null;
  }

  statusElement.classList.remove('hidden', 'bg-green-50', 'bg-orange-50', 'bg-red-50', 'border-green-200', 'border-orange-200', 'border-red-200', 'text-green-700', 'text-orange-700', 'text-red-700');
  statusElement.classList.add('is-visible');
  statusElement.setAttribute('role', type === 'error' ? 'alert' : 'status');
  statusElement.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

  const config = {
    success: ['bg-green-50', 'border-green-200', 'text-green-700'],
    info: ['bg-orange-50', 'border-orange-200', 'text-orange-700'],
    error: ['bg-red-50', 'border-red-200', 'text-red-700']
  };

  (config[type] || config.info).forEach(cls => statusElement.classList.add(cls));
  statusElement.textContent = message;

  if (type === 'success') {
    adminStatusTimeoutId = setTimeout(() => {
      statusElement.classList.add('hidden');
      statusElement.classList.remove('is-visible');
      adminStatusTimeoutId = null;
    }, 6000);
  }
}

function clearAdminStatus() {
  const statusElement = document.getElementById('adminDashboardStatus');
  if (!statusElement) return;
  if (adminStatusTimeoutId) {
    clearTimeout(adminStatusTimeoutId);
    adminStatusTimeoutId = null;
  }
  statusElement.classList.add('hidden');
  statusElement.classList.remove('is-visible');
  statusElement.removeAttribute('role');
  statusElement.removeAttribute('aria-live');
  statusElement.textContent = '';
}

function displayMedicalRecordsSection(records) {
  const recordsList = Array.isArray(records) ? [...records] : [];
  const sortedRecords = recordsList.sort((a, b) => getRecordDateTime(b) - getRecordDateTime(a));
  const summaryEl = document.getElementById('medicalRecordsSummary');
  const recordsContainer = document.getElementById('recentMedicalRecordsContainer');

  if (summaryEl) {
    summaryEl.textContent = adminDashboardData.overviewError
      ? 'Records unavailable'
      : `${sortedRecords.length} medical record${sortedRecords.length === 1 ? '' : 's'}`;
  }

  if (!recordsContainer) return;

  if (adminDashboardData.overviewError && !sortedRecords.length) {
    recordsContainer.innerHTML = getAdminErrorBlock('Unable to load medical records', 'medical records');
    return;
  }

  if (!sortedRecords.length) {
    recordsContainer.innerHTML = getAdminEmptyBlock('No medical records yet.', 'Official records will appear here after an administrator adds one for a completed appointment.');
    return;
  }

  const valueOrFallback = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return 'Not recorded';
    return String(value);
  };

  const rows = sortedRecords.map(record => {
    const dateRaw = record.record_date || record.created_at;
    const recordDate = dateRaw ? formatDate(dateRaw) : 'Not recorded';
    const weight = valueOrFallback(record.weight);
    const weightDisplay = weight === 'Not recorded' ? weight : `${weight} kg`;
    const recordedBy = getMedicalRecordRecorderLabel(record);

    return `
      <tr>
        <td><strong>${escapeHtml(getMedicalRecordPetLabel(record))}</strong></td>
        <td>${escapeHtml(recordDate)}</td>
        <td>${escapeHtml(weightDisplay)}</td>
        <td>${escapeHtml(valueOrFallback(record.vaccination_status))}</td>
        <td class="ph-dash-wrap">${escapeHtml(valueOrFallback(record.treatment))}</td>
        <td class="ph-dash-wrap">${escapeHtml(valueOrFallback(record.medical_notes))}</td>
        <td>${escapeHtml(recordedBy)}</td>
      </tr>
    `;
  }).join('');

  recordsContainer.innerHTML = `
    <div class="ph-dash-table-wrap">
      <table class="ph-dash-table">
        <thead>
          <tr>
            <th scope="col">Pet</th>
            <th scope="col">Record date</th>
            <th scope="col">Weight</th>
            <th scope="col">Vaccination status</th>
            <th scope="col">Treatment</th>
            <th scope="col">Medical notes</th>
            <th scope="col">Recorded by</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function setupAdminDashboardInteractions() {
  if (adminDashboardInteractionsBound) return;
  adminDashboardInteractionsBound = true;

  const refreshButton = document.getElementById('refreshDashboard');

  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      if (dashboardRefreshInProgress) return;
      dashboardRefreshInProgress = true;
      updateButtonState(refreshButton, true, 'Refreshing...', 'Refresh');
      try {
        await Promise.all([loadDashboardOverview(), loadServiceCatalog()]);
      } finally {
        dashboardRefreshInProgress = false;
        updateButtonState(refreshButton, false, 'Refreshing...', 'Refresh');
      }
    });
  }

  // Shortcuts and figures that open a section
  document.addEventListener('click', event => {
    const shortcut = event.target.closest('[data-admin-go]');
    if (!shortcut) return;
    markInteractionFeedback(shortcut);
    goToAdminSection(shortcut.dataset.adminGo);
  });

  const userSearchInput = document.getElementById('userSearchInput');
  const petSearchInput = document.getElementById('petSearchInput');
  if (userSearchInput) userSearchInput.addEventListener('input', debounce(applyUserSearch, 180));
  if (petSearchInput) petSearchInput.addEventListener('input', debounce(applyPetSearch, 180));

  const appointmentSearchInput = document.getElementById('appointmentSearchInput');
  if (appointmentSearchInput) appointmentSearchInput.addEventListener('input', debounce(applyAppointmentFilters, 180));
  ['appointmentStatusFilter', 'appointmentServiceFilter', 'appointmentDateFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyAppointmentFilters);
  });
  document.getElementById('appointmentFiltersClear')?.addEventListener('click', () => {
    ['appointmentSearchInput', 'appointmentDateFilter'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
    ['appointmentStatusFilter', 'appointmentServiceFilter'].forEach(id => {
      const select = document.getElementById(id);
      if (select) select.value = 'all';
    });
    applyAppointmentFilters();
  });

  // Row actions (event delegation: rows are re-rendered after every change)
  document.getElementById('appointmentsTable')?.addEventListener('click', event => {
    const statusButton = event.target.closest('[data-appointment-action]');
    if (statusButton) {
      updateAppointmentStatus(statusButton, statusButton.dataset.appointmentId, statusButton.dataset.appointmentAction);
      return;
    }
    const recordButton = event.target.closest('[data-record-appointment]');
    if (recordButton) openMedicalRecordForm(recordButton, recordButton.dataset.recordAppointment);
  });
  document.getElementById('petsTable')?.addEventListener('click', event => {
    const viewButton = event.target.closest('[data-pet-view]');
    if (viewButton) openAdminPetDetail(viewButton.dataset.petView);
  });
  document.getElementById('adminPetDetailContent')?.addEventListener('click', event => {
    const addButton = event.target.closest('[data-add-record]');
    if (!addButton) return;
    const select = document.getElementById('adminPetRecordAppointment');
    if (select && select.value) openMedicalRecordForm(addButton, select.value);
  });
  document.getElementById('adminPetDetailClose')?.addEventListener('click', () => {
    const petId = selectedAdminPetId;
    closeAdminPetDetail();
    document.querySelector(`#petsTable [data-pet-view="${CSS.escape(petId)}"]`)?.focus();
  });
  document.getElementById('usersTable')?.addEventListener('change', event => {
    const select = event.target.closest('select[data-user-id]');
    if (select) handleUserRoleChange(select);
  });
  document.getElementById('contactMessagesTable')?.addEventListener('click', event => {
    const button = event.target.closest('[data-message-id]');
    if (button) toggleContactMessageStatus(button, button.dataset.messageId, CONTACT_MESSAGE_READ_STATUS);
  });

  // System Management tabs: click, and arrow keys between tabs
  const tabs = Array.from(document.querySelectorAll('[data-system-tab]'));
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => switchSystemTab(tab.dataset.systemTab, { focus: false }));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      switchSystemTab(tabs[nextIndex].dataset.systemTab, { focus: true });
    });
  });
}

function switchSystemTab(tab, { focus = false, render = true } = {}) {
  setStoredSystemTab(tab);
  document.querySelectorAll('[data-system-tab]').forEach(button => {
    const isActive = button.dataset.systemTab === currentSystemTab;
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (panel) panel.hidden = !isActive;
    if (isActive && focus) button.focus();
  });
  if (render && currentAdminView === 'system') {
    if (currentSystemTab === 'users' && !isOverviewLoading()) applyUserSearch();
    if (currentSystemTab === 'messages') renderMessages();
    if (currentSystemTab === 'activity') renderSystemLogs();
    if (currentSystemTab === 'services') renderServiceCatalog();
  }
}

function debounce(fn, delay = 200) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function applyUserSearch() {
  const query = document.getElementById('userSearchInput')?.value.trim().toLowerCase() || '';
  const filtered = adminDashboardData.users.filter(user => {
    const fullname = (user.fullname || '').toLowerCase();
    const email = (user.email || '').toLowerCase();
    const role = (user.role || '').toLowerCase();
    const verified = user.is_verified ? 'verified yes' : 'unverified no';
    return fullname.includes(query) || email.includes(query) || role.includes(query) || verified.includes(query);
  });
  displayUsersTable(filtered);
}

function applyPetSearch() {
  const query = document.getElementById('petSearchInput')?.value.trim().toLowerCase() || '';
  const filtered = adminDashboardData.pets.filter(pet => {
    const name = (pet.name || '').toLowerCase();
    const species = (pet.species || '').toLowerCase();
    const breed = (pet.breed || '').toLowerCase();
    const ownerId = String(pet.user_id || '').toLowerCase();
    const ownerName = formatOwnerLabel(pet).toLowerCase();
    return name.includes(query) || species.includes(query) || breed.includes(query) || ownerId.includes(query) || ownerName.includes(query);
  });
  displayPetsTable(filtered);
}

// Service names for the filter: the catalog's nine services, then any other name found on appointments (earlier
// services such as "Checkup", kept with their saved duration)
function populateAppointmentServiceFilter() {
  const select = document.getElementById('appointmentServiceFilter');
  if (!select) return;
  const catalogNames = asArray(adminDashboardData.serviceCatalog).map(service => String(service.name || '')).filter(Boolean);
  const earlierNames = [...new Set(asArray(adminDashboardData.appointments)
    .map(appointment => String(appointment.service_type || '').trim())
    .filter(name => name && !catalogNames.includes(name)))].sort();
  const previous = select.value || 'all';
  select.innerHTML = [
    '<option value="all">All services</option>',
    ...catalogNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
    ...earlierNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)} (earlier service)</option>`)
  ].join('');
  select.value = [...select.options].some(option => option.value === previous) ? previous : 'all';
}

function isEarlierService(serviceType) {
  const catalog = asArray(adminDashboardData.serviceCatalog);
  if (!catalog.length || !hasRecordedValue(serviceType)) return false;
  return !catalog.some(service => service.name === String(serviceType).trim());
}

function applyAppointmentFilters() {
  const query = document.getElementById('appointmentSearchInput')?.value.trim().toLowerCase() || '';
  const status = document.getElementById('appointmentStatusFilter')?.value || 'all';
  const service = document.getElementById('appointmentServiceFilter')?.value || 'all';
  const date = document.getElementById('appointmentDateFilter')?.value || '';
  setStoredAdminAppointmentStatusFilter(status);

  const all = asArray(adminDashboardData.appointments);
  const filtered = all.filter(apt => {
    const text = [getAppointmentPetLabel(apt), getAppointmentOwnerLabel(apt), getAppointmentReference(apt), apt.service_type]
      .join(' ')
      .toLowerCase();
    return (!query || text.includes(query))
      && (status === 'all' || getAppointmentStatus(apt.status) === status)
      && (service === 'all' || String(apt.service_type || '').trim() === service)
      && (!date || normalizeDashboardDateValue(apt.appointment_date) === date);
  });

  const summary = document.getElementById('appointmentFilterSummary');
  if (summary) {
    summary.textContent = adminDashboardData.overviewError
      ? ''
      : `Showing ${filtered.length} of ${all.length} appointment${all.length === 1 ? '' : 's'}.`;
  }
  displayAppointmentsTable(filtered);
}

function showManagementLoadingStates() {
  const loaders = [
    ['usersTable', 5, 'users'],
    ['petsTable', 7, 'pets'],
    ['appointmentsTable', 9, 'appointments'],
    ['contactMessagesTable', 6, 'messages']
  ];
  loaders.forEach(([id, colspan, name]) => {
    const element = document.getElementById(id);
    if (element) element.innerHTML = getAdminTableLoadingRow(colspan, name);
  });
  const medicalRecordsContainer = document.getElementById('recentMedicalRecordsContainer');
  if (medicalRecordsContainer) medicalRecordsContainer.innerHTML = getDashboardSectionLoadingHtml('medical records', 2);
  const logsContainer = document.getElementById('systemLogsContainer');
  if (logsContainer) logsContainer.innerHTML = getDashboardSectionLoadingHtml('activity logs', 2);
}

function renderSystemLogs() {
  const logsContainer = document.getElementById('systemLogsContainer');
  renderOverviewAdminActivity();
  if (!logsContainer) return;

  if (adminDashboardData.activityLogsLoading || (!adminDashboardData.activityLogsLoaded && adminDashboardData.isLoading)) {
    logsContainer.innerHTML = getDashboardSectionLoadingHtml('activity logs', 2);
    return;
  }

  if (adminDashboardData.activityLogsError) {
    logsContainer.innerHTML = getAdminErrorBlock('Unable to load activity logs', 'activity logs');
    return;
  }

  if (!Array.isArray(adminDashboardData.activityLogs) || !adminDashboardData.activityLogs.length) {
    logsContainer.innerHTML = getAdminEmptyBlock('No activity logs yet.', 'System actions will appear here after users or admins make changes.');
    return;
  }

  const latestLogs = [...adminDashboardData.activityLogs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  logsContainer.innerHTML = `
    <p class="ph-dash-note">The ${latestLogs.length} most recent entries.</p>
    <ul class="ph-dash-list">
      ${latestLogs.map(log => {
        const action = log.action || (log.text ? String(log.text).split(' - ')[0] : '');
        const details = log.details || (log.text ? String(log.text).split(' - ').slice(1).join(' - ') : '');
        const message = log.display_text || formatActivityMessage(action, details);
        const metaItems = [];
        if (log.actor_name && !String(message).includes(log.actor_name)) {
          metaItems.push(`Actor: ${log.actor_name}`);
        }
        if (log.affected_user_name && log.affected_user_name !== log.actor_name && !String(message).includes(log.affected_user_name)) {
          metaItems.push(`User: ${log.affected_user_name}`);
        }

        return `
          <li class="ph-dash-list-item">
            <span class="ph-dash-stat-icon"><i class="${getActivityIcon(action).split(' ')[0]}" aria-hidden="true"></i></span>
            <div class="ph-dash-list-main">
              <p class="ph-dash-list-title">${escapeHtml(message)}</p>
              ${metaItems.length ? `<p class="ph-dash-list-meta">${escapeHtml(metaItems.join(' | '))}</p>` : ''}
              ${details ? `<p class="ph-dash-list-meta">${escapeHtml(details)}</p>` : ''}
              <p class="ph-dash-list-meta">${escapeHtml(formatLogTimestamp(log.created_at))}</p>
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getOverviewMessages(data) {
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.contactMessages)) return data.contactMessages;
  return [];
}

function getOverviewActivityLogs(data) {
  if (Array.isArray(data.activityLogs)) return data.activityLogs;
  if (Array.isArray(data.logs)) return data.logs;
  if (Array.isArray(data.systemLogs)) return data.systemLogs;
  return [];
}

function storeOverviewData(data) {
  const summary = data.summary || {};

  adminDashboardData.overviewError = '';
  adminDashboardData.users = asArray(data.users);
  adminDashboardData.pets = asArray(data.pets);
  adminDashboardData.appointments = asArray(data.appointments);
  adminDashboardData.medicalRecords = asArray(data.medicalRecords);
  adminDashboardData.messages = getOverviewMessages(data);
  adminDashboardData.activityLogs = getOverviewActivityLogs(data);
  adminDashboardData.stats = data.stats || {};
  refreshDerivedDashboardData(summary);
}

function clearDashboardData() {
  adminDashboardData.overviewError = '';
  adminDashboardData.users = [];
  adminDashboardData.pets = [];
  adminDashboardData.appointments = [];
  adminDashboardData.medicalRecords = [];
  adminDashboardData.messages = [];
  adminDashboardData.activityLogs = [];
  adminDashboardData.stats = {};
  adminDashboardData.summary = {};
  adminDashboardData.petTypes = { labels: [], values: [] };
  adminDashboardData.serviceUsage = { labels: [], values: [] };
  adminDashboardData.appointmentsTrend = { labels: [], values: [] };
}

async function loadDashboardOverview() {
  if (dashboardOverviewLoadPromise) {
    return dashboardOverviewLoadPromise;
  }

  dashboardOverviewLoadPromise = performDashboardOverviewLoad()
    .finally(() => {
      dashboardOverviewLoadPromise = null;
    });

  return dashboardOverviewLoadPromise;
}

async function performDashboardOverviewLoad() {
  clearAdminStatus();
  adminDashboardData.isLoading = true;
  adminDashboardData.isLoaded = false;
  adminDashboardData.messagesLoading = true;
  adminDashboardData.messagesLoaded = false;
  adminDashboardData.messagesError = '';
  adminDashboardData.activityLogsLoading = true;
  adminDashboardData.activityLogsLoaded = false;
  adminDashboardData.activityLogsError = '';
  adminDashboardData.overviewError = '';
  showAdminDashboardLoadingStates();
  showManagementLoadingStates();
  showAdminStatus('info', 'Loading dashboard data...');
  try {
    const userQuery = getAdminUserIdQuery();
    if (!userQuery) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const endpoint = `${window.API_BASE_URL}/admin/dashboard/overview${userQuery}`;
    const response = await fetchWithRetry(() => fetch(endpoint));
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load dashboard overview (${response.status})`);
    }

    const data = await response.json();

    if (data.success === false) {
      throw new Error(data.error || 'Failed to load dashboard overview');
    }

    storeOverviewData(data);

    const overviewHasMessages = Array.isArray(data.messages) || Array.isArray(data.contactMessages);
    const overviewHasActivityLogs = Array.isArray(data.activityLogs) || Array.isArray(data.logs) || Array.isArray(data.systemLogs);
    const supplementalLoads = [];

    if (!overviewHasActivityLogs) {
      supplementalLoads.push(loadSystemLogs(false));
    } else {
      adminDashboardData.activityLogsLoaded = true;
      adminDashboardData.activityLogsLoading = false;
      adminDashboardData.activityLogsError = '';
    }

    if (!overviewHasMessages) {
      supplementalLoads.push(loadContactMessages(false));
    } else {
      adminDashboardData.messagesLoaded = true;
      adminDashboardData.messagesLoading = false;
      adminDashboardData.messagesError = '';
    }

    await Promise.all(supplementalLoads);
    adminDashboardData.isLoading = false;
    adminDashboardData.isLoaded = true;

    renderCurrentAdminView();
    displayOverviewStats(adminDashboardData.summary);
    displayDashboardAlerts(adminDashboardData.summary);

    clearAdminStatus();
    return true;
  } catch (error) {
    console.error('Error loading dashboard overview:', error);
    clearDashboardData();
    adminDashboardData.overviewError = error.message || 'Unable to load dashboard overview.';

    showAdminStatus('error', 'Some dashboard records could not be loaded. Other sections will still load if available.');

    await Promise.allSettled([
      loadSystemLogs(false),
      loadContactMessages(false)
    ]);

    adminDashboardData.isLoading = false;
    adminDashboardData.isLoaded = true;

    renderCurrentAdminView();
    displayOverviewStats(adminDashboardData.summary);
    displayDashboardAlerts(adminDashboardData.summary);
    return false;
  }
}


function renderPetTypeChart(labels, values) {
  const canvas = document.getElementById('petTypeChart');
  const hasData = Array.isArray(values) && values.some(value => value > 0);
  const canRenderChart = Boolean(canvas) && hasData && typeof Chart !== 'undefined';
  showChartToggle(
    'petTypeChart',
    'petTypeNoData',
    canRenderChart,
    adminDashboardData.overviewError
      ? getFriendlyAdminErrorMessage('pet type data')
      : hasData ? 'Chart library unavailable. Pet type data could not be rendered.' : 'No pet data available.'
  );

  petTypeChart = destroyChart(petTypeChart);
  if (!canRenderChart) return;

  petTypeChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: ['#fb923c', '#f97316', '#fdba74', '#fbbf24', '#cbd5e1'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: getChartTextColor() }
        }
      }
    }
  });
}


function renderServiceUsageChart(labels, values) {
  const canvas = document.getElementById('serviceUsageChart');
  const hasData = Array.isArray(values) && values.some(value => value > 0);
  const canRenderChart = Boolean(canvas) && hasData && typeof Chart !== 'undefined';
  showChartToggle(
    'serviceUsageChart',
    'serviceUsageNoData',
    canRenderChart,
    adminDashboardData.overviewError
      ? getFriendlyAdminErrorMessage('service data')
      : hasData ? 'Chart library unavailable. Service data could not be rendered.' : 'No service data available.'
  );

  serviceUsageChart = destroyChart(serviceUsageChart);
  if (!canRenderChart) return;

  serviceUsageChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Service Requests',
        data: values,
        backgroundColor: '#fb923c',
        borderRadius: 8,
        maxBarThickness: 32
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: getChartTextColor() }, grid: { display: false } },
        y: { ticks: { color: getChartTextColor(), precision: 0 }, grid: { color: 'rgba(229,231,235,0.8)' }, beginAtZero: true }
      }
    }
  });
}


function renderAppointmentTrendChart(labels, values) {
  const canvas = document.getElementById('appointmentTrendChart');
  const hasData = Array.isArray(values) && values.some(value => value > 0);
  const canRenderChart = Boolean(canvas) && hasData && typeof Chart !== 'undefined';
  showChartToggle(
    'appointmentTrendChart',
    'appointmentTrendNoData',
    canRenderChart,
    adminDashboardData.overviewError
      ? getFriendlyAdminErrorMessage('appointment trend data')
      : hasData ? 'Chart library unavailable. Appointment trend data could not be rendered.' : 'No appointment trend data available.'
  );

  appointmentTrendChart = destroyChart(appointmentTrendChart);
  if (!canRenderChart) return;

  appointmentTrendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Bookings',
        data: values,
        borderColor: '#fb923c',
        backgroundColor: 'rgba(251,146,60,0.15)',
        fill: true,
        tension: 0.35,
        pointRadius: 4,
        pointBackgroundColor: '#fb923c'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: getChartTextColor() }, grid: { display: false } },
        y: { ticks: { color: getChartTextColor(), precision: 0 }, grid: { color: 'rgba(229,231,235,0.8)' }, beginAtZero: true }
      }
    }
  });
}

// Chart labels follow the theme (checked when a chart is drawn)
function getChartTextColor() {
  return document.body.classList.contains('dark-mode') ? '#d1d5db' : '#4b5563';
}

function displayAnalyticsInsights() {
  const petTypeEl = document.getElementById('insightPetType');
  const serviceEl = document.getElementById('insightService');
  const bookingsEl = document.getElementById('insightBookings');
  const completionEl = document.getElementById('insightCompletion');
  const setText = (element, text, isNumber) => {
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('is-muted', !isNumber);
  };

  if (adminDashboardData.overviewError) {
    [petTypeEl, serviceEl, bookingsEl, completionEl].forEach(element => setText(element, 'Unavailable', false));
    return;
  }

  const petType = getTopLabel(adminDashboardData.petTypes);
  const service = getTopLabel(adminDashboardData.serviceUsage);
  const summary = buildRealDashboardSummary(adminDashboardData.summary || {});
  const bookings = summary.upcomingBookings;
  const completion = summary.totalAppointments > 0 ? summary.completedAppointmentPercentage : null;

  setText(petTypeEl, petType || 'No data', false);
  setText(serviceEl, service || 'No data', false);
  setText(bookingsEl, bookings !== undefined && bookings !== null ? String(bookings) : 'No data', bookings !== undefined && bookings !== null);
  setText(completionEl, completion !== undefined && completion !== null ? `${completion}%` : 'No data', completion !== undefined && completion !== null);
}

function getTopLabel(dataset) {
  if (!dataset || !Array.isArray(dataset.labels) || !Array.isArray(dataset.values)) return 'No data';
  const labels = dataset.labels;
  const values = dataset.values;
  const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
  if (total === 0) return 'No data';
  let topIndex = 0;
  values.forEach((value, index) => {
    if (Number(value || 0) > Number(values[topIndex] || 0)) topIndex = index;
  });
  return labels[topIndex] || 'No data';
}

function destroyChart(chartInstance) {
  if (chartInstance && typeof chartInstance.destroy === 'function') {
    chartInstance.destroy();
  }
  return null;
}

function showChartToggle(chartId, messageId, hasData, message) {
  const chartEl = document.getElementById(chartId);
  const messageEl = document.getElementById(messageId);
  if (chartEl) chartEl.classList.toggle('hidden', !hasData);
  if (messageEl) {
    messageEl.classList.toggle('hidden', hasData);
    if (message) {
      messageEl.innerHTML = `<div class="flex h-full items-center justify-center text-center">${escapeHtml(message)}</div>`;
    }
  }
}

function displayValue(value, fallback = 'Not recorded') {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  return String(value);
}

function formatTableDate(dateString, fallback = 'Not recorded') {
  return dateString ? formatDate(dateString) : fallback;
}

function formatRoleLabel(role) {
  const normalizedRole = String(role || '').toLowerCase();
  if (normalizedRole === 'admin') return 'Admin';
  if (normalizedRole === 'user') return 'User';
  return 'Role not recorded';
}

function isSupportedUserRole(role) {
  return ['admin', 'user'].includes(String(role || '').toLowerCase());
}

function getAdminAccountLabel(userData) {
  if (hasRecordedValue(userData?.fullname)) return `Signed in as ${userData.fullname}`;
  if (hasRecordedValue(userData?.email)) return `Signed in as ${userData.email}`;
  if (hasRecordedValue(userData?.id)) return `Admin ID: ${userData.id}`;
  return 'Admin account unavailable';
}

function formatPetAge(age) {
  if (age === undefined || age === null || String(age).trim() === '') {
    return 'Not recorded';
  }

  return `${age} year${Number(age) === 1 ? '' : 's'}`;
}

function formatOwnerLabel(pet) {
  if (hasRecordedValue(pet?.owner_name) && pet.owner_name !== 'Unknown') return String(pet.owner_name);
  const ownerName = getUserNameById(pet?.user_id);
  if (ownerName) return ownerName;
  if (pet?.user_id) return `User ID: ${pet.user_id}`;
  return 'Owner not recorded';
}

function getUserVerificationStatus(user) {
  if (isVerifiedValue(user?.is_verified)) return 'Verified';
  if (user?.is_verified === false || user?.is_verified === 'false' || user?.is_verified === 0 || user?.is_verified === '0') {
    return 'Unverified';
  }
  return 'Verification not recorded';
}

function getUserVerificationBadgeClass(status) {
  if (status === 'Verified') return 'admin-status-success';
  if (status === 'Unverified') return 'admin-status-warning';
  return 'admin-status-neutral';
}

function renderUserRoleCell(user) {
  const role = String(user?.role || '').toLowerCase();
  if (!user?.id || !isSupportedUserRole(role)) {
    return `<span>${escapeHtml(formatRoleLabel(user?.role))}</span>`;
  }

  return `
    <label class="sr-only" for="role-${escapeHtml(String(user.id))}">Role for ${escapeHtml(displayValue(user.fullname, 'this user'))}</label>
    <select
      id="role-${escapeHtml(String(user.id))}"
      data-user-id="${escapeHtml(String(user.id))}"
      data-old-role="${escapeHtml(role)}"
      class="ph-input"
    >
      <option value="user"${role === 'user' ? ' selected' : ''}>User</option>
      <option value="admin"${role === 'admin' ? ' selected' : ''}>Admin</option>
    </select>
  `;
}

/**
 * Display users table
 */
function displayUsersTable(users) {
  const usersTable = document.getElementById('usersTable');
  if (!usersTable) return;

  const query = document.getElementById('userSearchInput')?.value.trim();
  const showMatchingMessage = Boolean(query) && (!users || users.length === 0);

  if (adminDashboardData.overviewError && (!users || users.length === 0)) {
    usersTable.innerHTML = getAdminTableErrorRow(5, 'Unable to load users', 'users');
    return;
  }

  if (!users || users.length === 0) {
    usersTable.innerHTML = getAdminTableEmptyRow(
      5,
      showMatchingMessage ? 'No matching users found.' : 'No user accounts found.',
      showMatchingMessage ? 'Adjust the search term to review more accounts.' : 'Registered PetHub accounts will appear here after users sign up.'
    );
    return;
  }

  usersTable.innerHTML = users.map(user => {
    const verificationStatus = getUserVerificationStatus(user);
    return `
      <tr>
        <td>${escapeHtml(displayValue(user.fullname, 'Name not provided'))}</td>
        <td>${escapeHtml(displayValue(user.email, 'Email not provided'))}</td>
        <td>${renderUserRoleCell(user)}</td>
        <td>
          <span class="admin-status-badge ${getUserVerificationBadgeClass(verificationStatus)}">
            ${escapeHtml(verificationStatus)}
          </span>
        </td>
        <td>${escapeHtml(formatTableDate(user.created_at))}</td>
      </tr>
    `;
  }).join('');
}

function clearRoleChangeConfirmation(select) {
  if (!select || !select.dataset) return;

  const timeoutId = Number(select.dataset.roleConfirmTimeoutId || 0);
  if (timeoutId) {
    window.clearTimeout(timeoutId);
  }

  delete select.dataset.pendingRole;
  delete select.dataset.pendingOldRole;
  delete select.dataset.roleConfirmTimeoutId;
}

function getRoleChangeConfirmationMessage(userId, oldRole, newRole) {
  const currentUser = getUser();
  if (currentUser && String(currentUser.id) === String(userId) && oldRole === 'admin' && newRole === 'user') {
    return 'Choose the role again to confirm changing your own role to user.';
  }

  return 'Choose the role again to confirm.';
}

function shouldWaitForRoleChangeConfirmation(select, userId, newRole, oldRole) {
  const isPendingConfirmation = select.dataset.pendingRole === newRole
    && select.dataset.pendingOldRole === oldRole;

  if (isPendingConfirmation) {
    clearRoleChangeConfirmation(select);
    return false;
  }

  clearRoleChangeConfirmation(select);
  select.dataset.pendingRole = newRole;
  select.dataset.pendingOldRole = oldRole;
  select.value = oldRole;
  showAdminStatus('info', getRoleChangeConfirmationMessage(userId, oldRole, newRole));

  const timeoutId = window.setTimeout(() => {
    if (select.dataset.pendingRole === newRole && select.dataset.pendingOldRole === oldRole) {
      clearRoleChangeConfirmation(select);
    }
  }, 5000);

  select.dataset.roleConfirmTimeoutId = String(timeoutId);
  return true;
}

// Role change: two selections -> PUT /admin/dashboard/user-role -> the server allows only "user" or "admin" and logs
// the change -> the dashboard reloads from the server before saying it worked
async function handleUserRoleChange(select) {
  if (!select || !select.dataset) return;

  const userId = select.dataset.userId;
  const newRole = select.value;
  const oldRole = select.dataset.oldRole || '';

  if (!userId) {
    showAdminStatus('error', 'Unable to determine which user to update.');
    select.value = oldRole;
    return;
  }

  if (newRole === oldRole) {
    clearRoleChangeConfirmation(select);
    return;
  }

  if (shouldWaitForRoleChangeConfirmation(select, userId, newRole, oldRole)) {
    return;
  }

  try {
    select.disabled = true;
    showAdminStatus('info', 'Updating user role...');
    const adminQuery = getAdminUserIdQuery();
    if (!adminQuery) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const response = await fetchWithRetry(() =>
      fetch(`${window.API_BASE_URL}/admin/dashboard/user-role${adminQuery}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: userId, role: newRole })
      })
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Failed to update role (${response.status})`);
    }

    if (!data.user) {
      throw new Error('User role update succeeded but no user returned');
    }

    select.dataset.oldRole = newRole;
    const refreshed = await loadDashboardOverview();
    if (refreshed) {
      showAdminStatus('success', 'User role updated successfully.');
    }
  } catch (error) {
    console.error('Error updating user role:', error);
    select.value = oldRole;
    showAdminStatus('error', 'Unable to update the user role right now. Please try again.');
  } finally {
    select.disabled = false;
  }
}

/**
 * Display pets table
 */
function displayPetsTable(pets) {
  const petsTable = document.getElementById('petsTable');
  if (!petsTable) return;

  const query = document.getElementById('petSearchInput')?.value.trim();
  const showMatchingMessage = Boolean(query) && (!pets || pets.length === 0);

  if (adminDashboardData.overviewError && (!pets || pets.length === 0)) {
    petsTable.innerHTML = getAdminTableErrorRow(7, 'Unable to load pets', 'pets');
    return;
  }

  if (!pets || pets.length === 0) {
    petsTable.innerHTML = getAdminTableEmptyRow(
      7,
      showMatchingMessage ? 'No matching pets found.' : 'No pet profiles found.',
      showMatchingMessage ? 'Adjust the search term to review more pet profiles.' : 'Pet profiles appear here once owners add them.'
    );
    return;
  }

  petsTable.innerHTML = pets.map(pet => {
    const records = getMedicalRecordsForPet(pet?.id);
    const latestRecordDateRaw = records[0]?.record_date || records[0]?.created_at || '';
    const id = escapeHtml(String(pet.id || ''));
    return `
    <tr>
      <td><strong>${escapeHtml(displayValue(pet.name, 'Unnamed pet'))}</strong></td>
      <td>${escapeHtml(displayValue(pet.species))}</td>
      <td>${escapeHtml(displayValue(pet.breed))}</td>
      <td>${escapeHtml(formatPetAge(pet.age))}</td>
      <td>${escapeHtml(formatOwnerLabel(pet))}</td>
      <td>
        ${records.length} record${records.length === 1 ? '' : 's'}
        ${latestRecordDateRaw ? `<p class="ph-dash-muted">Latest ${escapeHtml(formatDate(latestRecordDateRaw))}</p>` : ''}
      </td>
      <td>
        <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-pet-view="${id}" aria-controls="adminPetDetail">
          View records<span class="sr-only"> for ${escapeHtml(displayValue(pet.name, 'this pet'))}</span>
        </button>
      </td>
    </tr>
  `;
  }).join('');
}

// ==================== ONE PET: PROFILE, OFFICIAL RECORDS, ADDING A RECORD ====================

function openAdminPetDetail(petId) {
  if (!getPetById(petId)) return;
  selectedAdminPetId = String(petId);
  renderAdminPetDetail();
  const panel = document.getElementById('adminPetDetail');
  if (panel) {
    panel.hidden = false;
    panel.scrollIntoView({ block: 'start' });
  }
  document.getElementById('adminPetDetailTitle')?.focus();
}

function closeAdminPetDetail() {
  selectedAdminPetId = '';
  const panel = document.getElementById('adminPetDetail');
  if (panel) panel.hidden = true;
}

// Completed appointments of this pet that have no record yet: the only ones a record can be added for
function getRecordableAppointmentsForPet(petId) {
  return asArray(adminDashboardData.appointments)
    .filter(appointment => String(appointment.pet_id) === String(petId)
      && getAppointmentStatus(appointment.status) === 'Completed'
      && !appointmentHasMedicalRecord(appointment))
    .sort((a, b) => getAppointmentSortKey(b).localeCompare(getAppointmentSortKey(a)));
}

function renderAdminPetDetail() {
  const panel = document.getElementById('adminPetDetail');
  const content = document.getElementById('adminPetDetailContent');
  const pet = getPetById(selectedAdminPetId);
  if (!panel || !content) return;
  if (!pet) {
    if (selectedAdminPetId) closeAdminPetDetail();
    return;
  }

  const nameElement = document.getElementById('adminPetDetailName');
  if (nameElement) nameElement.textContent = displayValue(pet.name, 'Unnamed pet');

  const records = getMedicalRecordsForPet(pet.id);
  const recordable = getRecordableAppointmentsForPet(pet.id);
  const recordCards = records.length
    ? records.map(record => {
        const weight = hasRecordedValue(record.weight) ? `${record.weight} kg` : 'Not recorded';
        return `
          <article class="ph-dash-card">
            <div class="ph-dash-card-head">
              <p class="ph-dash-card-title">${escapeHtml(formatTableDate(record.record_date || record.created_at))}</p>
              <span class="ph-badge ph-badge-official">Official record</span>
            </div>
            <dl class="ph-dash-facts">
              <div><dt>Weight</dt> <dd>${escapeHtml(weight)}</dd></div>
              <div><dt>Vaccination status</dt> <dd>${escapeHtml(displayValue(record.vaccination_status))}</dd></div>
              <div><dt>Treatment</dt> <dd>${escapeHtml(displayValue(record.treatment))}</dd></div>
              <div><dt>Recorded by</dt> <dd>${escapeHtml(getMedicalRecordRecorderLabel(record))}</dd></div>
              <div class="is-wide"><dt>Medical notes</dt> <dd>${escapeHtml(displayValue(record.medical_notes))}</dd></div>
              <div class="is-wide"><dt>Saved</dt> <dd>${escapeHtml(record.created_at ? formatDateTime(record.created_at) : 'Not recorded')}</dd></div>
            </dl>
          </article>
        `;
      }).join('')
    : getAdminEmptyBlock('No medical records yet', 'Records for this pet appear here once an administrator adds one.');

  const addRecordHtml = recordable.length
    ? `
      <div class="ph-field">
        <label for="adminPetRecordAppointment" class="ph-label">Completed appointment</label>
        <select id="adminPetRecordAppointment" class="ph-input">
          ${recordable.map(appointment => `<option value="${escapeHtml(String(appointment.id))}">${escapeHtml(`${formatTableDate(appointment.appointment_date, 'Date not set')} - ${displayValue(appointment.service_type, 'Service not recorded')} - ${getAppointmentReference(appointment)}`)}</option>`).join('')}
        </select>
      </div>
      <div class="ph-dash-card-actions">
        <button type="button" class="ph-btn ph-btn-primary ph-btn-sm" data-add-record><i class="ri-add-line" aria-hidden="true"></i>Add medical record</button>
      </div>
    `
    : '<p class="ph-dash-note">A record is added for a completed appointment. This pet has no completed appointment without a record.</p>';

  content.innerHTML = `
    <div class="ph-dash-grid-side">
      <div>
        <h3 class="ph-dash-card-title">Pet profile</h3>
        <p class="ph-dash-note">Entered by the owner.</p>
        <dl class="ph-dash-facts">
          <div><dt>Owner</dt> <dd>${escapeHtml(formatOwnerLabel(pet))}</dd></div>
          <div><dt>Species</dt> <dd>${escapeHtml(displayValue(pet.species))}</dd></div>
          <div><dt>Breed</dt> <dd>${escapeHtml(displayValue(pet.breed))}</dd></div>
          <div><dt>Age</dt> <dd>${escapeHtml(formatPetAge(pet.age))}</dd></div>
          <div class="is-wide"><dt>Profile added</dt> <dd>${escapeHtml(formatTableDate(pet.created_at))}</dd></div>
        </dl>
        <h3 class="ph-dash-card-title mt-5">Add an official record</h3>
        ${addRecordHtml}
      </div>
      <div>
        <div class="ph-dash-card-head">
          <h3 class="ph-dash-card-title">Official medical records (${records.length})</h3>
          <span class="ph-badge ph-badge-official"><i class="ri-shield-check-line" aria-hidden="true"></i>Entered by administrators</span>
        </div>
        <div class="ph-dash-stack mt-3">${recordCards}</div>
      </div>
    </div>
  `;
}

/**
 * Display appointments table with action buttons
 */
function displayAppointmentsTable(appointments) {
  const appointmentsTable = document.getElementById('appointmentsTable');
  if (!appointmentsTable) return;

  const activeFilter = ['appointmentSearchInput', 'appointmentDateFilter'].some(id => document.getElementById(id)?.value.trim())
    || ['appointmentStatusFilter', 'appointmentServiceFilter'].some(id => (document.getElementById(id)?.value || 'all') !== 'all');
  const showMatchingMessage = activeFilter && (!appointments || appointments.length === 0);

  if (adminDashboardData.overviewError && (!appointments || appointments.length === 0)) {
    appointmentsTable.innerHTML = getAdminTableErrorRow(9, 'Unable to load appointments', 'appointments');
    return;
  }

  if (!appointments || appointments.length === 0) {
    appointmentsTable.innerHTML = getAdminTableEmptyRow(
      9,
      showMatchingMessage ? 'No matching appointments found.' : 'No appointments found.',
      showMatchingMessage ? 'Adjust the search or filters to review more bookings.' : 'Bookings appear here when pet owners submit them.'
    );
    return;
  }

  appointmentsTable.innerHTML = appointments.map(apt => {
    const handledBy = getHandledByLabel(apt);
    const status = getAppointmentStatus(apt.status);

    return `
    <tr>
      <td>${escapeHtml(getAppointmentReference(apt))}</td>
      <td>
        <strong>${escapeHtml(getAppointmentPetLabel(apt))}</strong>
        <p class="ph-dash-muted">${escapeHtml(getAppointmentOwnerLabel(apt))}</p>
      </td>
      <td>
        ${escapeHtml(displayValue(apt.service_type, 'N/A'))}
        ${isEarlierService(apt.service_type) ? '<p><span class="ph-badge ph-badge-warning">Earlier service</span></p>' : ''}
      </td>
      <td>${escapeHtml(formatTableDate(apt.appointment_date, 'N/A'))}</td>
      <td>${escapeHtml(getAppointmentTimeDisplay(apt))}</td>
      <td>${escapeHtml(getAppointmentDurationLabel(apt))}</td>
      <td><span class="${getStatusBadgeClass(status)}">${escapeHtml(status)}</span></td>
      <td>${handledBy ? escapeHtml(handledBy) : '<span class="ph-dash-muted">-</span>'}</td>
      <td><div class="admin-medical-record-action-cell">${renderAppointmentActions(status, apt)}</div></td>
    </tr>
  `;
  }).join('');
}

function getHandledByLabel(appointment) {
  if (!appointment || !appointment.handled_by) return '';
  return appointment.handled_by_name || getUserNameById(appointment.handled_by) || '';
}

function getAppointmentStatus(status) {
  if (!hasRecordedValue(status)) return 'Status not recorded';
  const normalizedStatus = String(status).toLowerCase();
  const statusMap = {
    pending: 'Pending',
    approved: 'Approved',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };
  return statusMap[normalizedStatus] || displayValue(status, 'Status not recorded');
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

function getAppointmentTimeDisplay(appointment) {
  const rawTime = String(appointment?.appointment_time || '').trim();
  const match = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const durationMinutes = getAppointmentDurationMinutes(appointment);

  if (!match || !Number.isFinite(durationMinutes)) {
    return 'N/A';
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return 'N/A';
  }

  const startTime = new Date(2000, 0, 1, hours, minutes, seconds, 0);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const formatOptions = { hour: 'numeric', minute: '2-digit' };

  return `${startTime.toLocaleTimeString('en-US', formatOptions)} - ${endTime.toLocaleTimeString('en-US', formatOptions)}`;
}

function hasMedicalRecordCreateContext(appointment) {
  if (!getCurrentAdminUserId()) return false;
  if (!appointment || !appointment.id || !appointment.user_id) return false;
  return getAppointmentOwnerPetsForMedicalRecord(appointment).length > 0;
}

function hasCompletedMedicalRecordFlag(appointment) {
  const positiveFlags = [
    appointment?.has_medical_record,
    appointment?.medical_record_action_completed,
    appointment?.medical_record_created,
    appointment?.medicalRecordCreated
  ].some(value => value === true || value === 'true' || value === 1 || value === '1');

  if (positiveFlags) return true;

  return [
    appointment?.medicalRecord?.id,
    appointment?.medical_record?.id,
    appointment?.medical_record_id,
    appointment?.medicalRecordId
  ].some(value => hasRecordedValue(value));
}

function getLinkedMedicalRecordAppointmentId(record) {
  return String(
    record?.appointment_id ||
    record?.appointmentId ||
    record?.appointment?.id ||
    ''
  ).trim();
}

function appointmentHasMedicalRecord(appointment) {
  const appointmentId = String(appointment?.id || '').trim();
  if (!appointmentId) return false;
  if (hasCompletedMedicalRecordFlag(appointment)) return true;

  return asArray(adminDashboardData.medicalRecords)
    .some(record => getLinkedMedicalRecordAppointmentId(record) === appointmentId);
}

function getMedicalRecordCompletedActionHtml() {
  return `
    <span class="admin-status-badge admin-status-success admin-medical-record-complete-badge" aria-label="Medical record already added" title="Medical record already added">
      <i class="ri-check-line" aria-hidden="true"></i>
      <span>Record added</span>
    </span>
  `;
}

function markAppointmentMedicalRecordCompleted(appointmentId, record = null) {
  const id = String(appointmentId || '').trim();
  if (!id) return;

  adminDashboardData.appointments = asArray(adminDashboardData.appointments).map(appointment => (
    String(appointment?.id || '').trim() === id
      ? {
          ...appointment,
          has_medical_record: true,
          medical_record_action_completed: true,
          medical_record_id: record?.id || appointment.medical_record_id || null
        }
      : appointment
  ));

  if (record?.id && !asArray(adminDashboardData.medicalRecords).some(item => String(item?.id) === String(record.id))) {
    adminDashboardData.medicalRecords = [
      { ...record, appointment_id: id },
      ...asArray(adminDashboardData.medicalRecords)
    ];
  }
}

function refreshMedicalRecordActionViews() {
  refreshDerivedDashboardData(adminDashboardData.summary);
  displayOverviewStats(adminDashboardData.summary);
  displayDashboardAlerts(adminDashboardData.summary);
  renderCurrentAdminView();
}

function isMedicalRecordAlreadyAddedError(error) {
  return /medical record has already been added/i.test(String(error?.message || error || ''));
}

// The actions a status allows (the same transitions the server enforces: Pending -> Approved or Cancelled,
// Approved -> Completed or Cancelled; Completed and Cancelled are final). "Cancel" on a Pending request is how a request
// is declined: the backend records it as Cancelled and emails the owner that it was cancelled.
function renderAppointmentActions(status, appointment) {
  const appointmentId = appointment?.id;
  if (!appointmentId) {
    return '<span class="ph-dash-muted">Action unavailable</span>';
  }

  const id = escapeHtml(String(appointmentId));
  const action = (newStatus, label, type) => `<button type="button" data-appointment-action="${newStatus}" data-appointment-id="${id}" class="${getAdminActionButtonClass(type)}">${label}</button>`;

  if (status === 'Pending') {
    return `
      <div class="flex flex-wrap gap-2">
        ${action('Approved', 'Approve', 'success')}
        ${action('Cancelled', 'Cancel', 'danger')}
      </div>
    `;
  }

  if (status === 'Approved') {
    return `
      <div class="flex flex-wrap gap-2">
        ${action('Completed', 'Complete', 'success')}
        ${action('Cancelled', 'Cancel', 'danger')}
      </div>
    `;
  }

  if (status === 'Completed' && appointmentHasMedicalRecord(appointment)) {
    return getMedicalRecordCompletedActionHtml();
  }

  if (status === 'Completed' && hasMedicalRecordCreateContext(appointment)) {
    return `
      <div class="flex flex-wrap gap-2">
        <button type="button" data-record-appointment="${id}" class="${getAdminActionButtonClass('neutral')}">Add Medical Record</button>
      </div>
    `;
  }

  return '<span class="ph-dash-muted">No action needed</span>';
}

function getMedicalRecordAppointment(appointmentId) {
  const id = String(appointmentId || '');
  return (adminDashboardData.appointments || []).find(appointment => String(appointment.id) === id) || null;
}

function getLocalDateInputValue() {
  const now = new Date();
  const timezoneOffsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

function getAppointmentOwnerPetsForMedicalRecord(appointment) {
  const ownerId = String(appointment?.user_id || '').trim();
  if (!ownerId) return [];

  return (adminDashboardData.pets || [])
    .filter(pet => String(pet?.user_id || '').trim() === ownerId);
}

function getConfirmedAppointmentPetId(appointment, ownerPets) {
  const appointmentPetId = String(appointment?.pet_id || '').trim();
  if (!appointmentPetId) return '';

  const confirmedPet = (Array.isArray(ownerPets) ? ownerPets : [])
    .find(pet => String(pet?.id || '').trim() === appointmentPetId);
  return confirmedPet ? appointmentPetId : '';
}

function getMedicalRecordPetOptionLabel(pet) {
  const parts = [
    pet?.name || 'Unnamed pet',
    pet?.species,
    pet?.breed
  ];

  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

function populateMedicalRecordPetSelect(select, ownerPets, selectedPetId = '') {
  if (!select) return;

  const pets = Array.isArray(ownerPets) ? ownerPets : [];
  const selectedId = String(selectedPetId || '').trim();
  const options = [
    '<option value="">Select pet</option>',
    ...pets.map(pet => {
      const id = String(pet?.id || '').trim();
      const selected = id && id === selectedId ? ' selected' : '';
      return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(getMedicalRecordPetOptionLabel(pet))}</option>`;
    })
  ];

  select.innerHTML = options.join('');
  select.disabled = pets.length === 0;
  select.value = pets.some(pet => String(pet?.id || '').trim() === selectedId) ? selectedId : '';
}

function updateMedicalRecordSaveState(form, syncError = true) {
  if (!form) return;

  const petId = String(form.elements?.pet_id?.value || '').trim();
  const recordDate = String(form.elements?.record_date?.value || '').trim();
  const adminId = getCurrentAdminUserId();
  const selectedPet = getPetById(petId);
  const saveButton = form.querySelector('button[type="submit"]');
  const canSave = Boolean(selectedPet && recordDate && adminId);

  if (saveButton) {
    saveButton.disabled = !canSave || isFormSubmitting(form);
    saveButton.classList.toggle('opacity-60', !canSave);
    saveButton.classList.toggle('cursor-not-allowed', !canSave);
  }

  if (syncError) {
    if (!petId || !selectedPet) {
      setMedicalRecordFormError('Select a valid pet before saving.');
    } else if (!recordDate) {
      setMedicalRecordFormError('Record date is required.');
    } else if (!adminId) {
      setMedicalRecordFormError('Admin user ID not found. Please log in again.');
    } else {
      setMedicalRecordFormError('');
    }
  }
}

// The "Add Medical Record" dialog (created once). Fields are the medical_records columns: record_date, weight,
// vaccination_status, treatment and medical_notes; created_by is the signed-in admin and is checked by the server.
function ensureMedicalRecordModal() {
  let modal = document.getElementById('adminMedicalRecordModal');
  if (modal) return modal;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="adminMedicalRecordModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-slate-950/40 px-4 py-6" role="dialog" aria-modal="true" aria-labelledby="adminMedicalRecordTitle">
      <div class="w-full max-w-lg max-h-full overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="adminMedicalRecordTitle" class="text-lg font-bold text-slate-900">Add Medical Record</h2>
            <p id="adminMedicalRecordContext" class="mt-1 text-sm text-slate-600"></p>
          </div>
          <button type="button" data-close-record-form class="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200" aria-label="Close medical record form">
            <i class="ri-close-line text-lg" aria-hidden="true"></i>
          </button>
        </div>

        <form id="adminMedicalRecordForm" class="ph-form">
          <p id="adminMedicalRecordError" class="hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert"></p>

          <div class="ph-field">
            <label for="adminMedicalRecordPetId" class="ph-label">Pet</label>
            <select id="adminMedicalRecordPetId" name="pet_id" required class="ph-input">
              <option value="">Select pet</option>
            </select>
            <p id="adminMedicalRecordRequestedPet" class="ph-help"></p>
          </div>

          <div class="ph-form-grid">
            <div class="ph-field">
              <label for="adminMedicalRecordWeight" class="ph-label">Weight (kg)</label>
              <input id="adminMedicalRecordWeight" name="weight" type="number" min="0" step="0.01" required class="ph-input">
            </div>
            <div class="ph-field">
              <label for="adminMedicalRecordVaccination" class="ph-label">Vaccination Status</label>
              <select id="adminMedicalRecordVaccination" name="vaccination_status" required class="ph-input">
                <option value="" disabled selected>Select status</option>
                <option value="Up to date">Up to date</option>
                <option value="Due soon">Due soon</option>
                <option value="Overdue">Overdue</option>
                <option value="Not applicable">Not applicable</option>
              </select>
            </div>
            <div class="ph-field">
              <label for="adminMedicalRecordDate" class="ph-label">Record Date</label>
              <input id="adminMedicalRecordDate" name="record_date" type="date" required class="ph-input">
            </div>
          </div>

          <div class="ph-field">
            <label for="adminMedicalRecordTreatment" class="ph-label">Treatment</label>
            <input id="adminMedicalRecordTreatment" name="treatment" type="text" required class="ph-input">
          </div>

          <div class="ph-field">
            <label for="adminMedicalRecordNotes" class="ph-label">Medical Notes</label>
            <textarea id="adminMedicalRecordNotes" name="medical_notes" rows="4" required class="ph-input"></textarea>
          </div>

          <div class="ph-form-actions justify-end">
            <button type="button" data-close-record-form class="ph-btn ph-btn-secondary">Cancel</button>
            <button type="submit" class="ph-btn ph-btn-primary">Save Record</button>
          </div>
        </form>
      </div>
    </div>
  `);

  modal = document.getElementById('adminMedicalRecordModal');
  const form = document.getElementById('adminMedicalRecordForm');
  if (form) {
    form.addEventListener('submit', submitMedicalRecordForm);
    form.elements.pet_id?.addEventListener('change', () => updateMedicalRecordSaveState(form));
    form.elements.record_date?.addEventListener('input', () => updateMedicalRecordSaveState(form));
  }

  modal?.addEventListener('click', event => {
    if (event.target === modal || event.target.closest('[data-close-record-form]')) {
      closeMedicalRecordForm();
    }
  });
  modal?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMedicalRecordForm();
  });

  return modal;
}

function setMedicalRecordFormError(message) {
  const errorElement = document.getElementById('adminMedicalRecordError');
  if (!errorElement) return;

  if (!message) {
    errorElement.textContent = '';
    errorElement.classList.add('hidden');
    return;
  }

  errorElement.textContent = message;
  errorElement.classList.remove('hidden');
}

function getMedicalRecordContextLabel(appointment) {
  const parts = [
    getAppointmentPetLabel(appointment),
    formatTableDate(appointment?.appointment_date, 'Date not set'),
    getAppointmentReference(appointment)
  ];
  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

let medicalRecordReturnFocus = null;

function openMedicalRecordForm(button, appointmentId) {
  if (button?.dataset?.loading === 'true') return;

  const appointment = getMedicalRecordAppointment(appointmentId);
  if (!appointment || getAppointmentStatus(appointment.status) !== 'Completed') {
    showAdminStatus('error', 'Medical records can only be added after an appointment is completed.');
    return;
  }

  if (appointmentHasMedicalRecord(appointment)) {
    markAppointmentMedicalRecordCompleted(appointmentId);
    refreshMedicalRecordActionViews();
    showAdminStatus('success', 'Medical record already added for this appointment.');
    return;
  }

  const modal = ensureMedicalRecordModal();
  const form = document.getElementById('adminMedicalRecordForm');
  const context = document.getElementById('adminMedicalRecordContext');
  const requestedPet = document.getElementById('adminMedicalRecordRequestedPet');
  const ownerPets = getAppointmentOwnerPetsForMedicalRecord(appointment);
  const selectedPetId = getConfirmedAppointmentPetId(appointment, ownerPets);
  const recordDate = getLocalDateInputValue();

  if (form) {
    form.reset();
    form.dataset.submitting = 'false';
    form.removeAttribute('aria-busy');
    populateMedicalRecordPetSelect(form.elements.pet_id, ownerPets, selectedPetId);
    form.elements.record_date.value = recordDate;
    updateMedicalRecordSaveState(form);
  }

  if (context) context.textContent = getMedicalRecordContextLabel(appointment);
  if (requestedPet) requestedPet.textContent = `Requested pet: ${getAppointmentPetLabel(appointment)}`;
  if (modal) {
    medicalRecordReturnFocus = button || null;
    modal.dataset.appointmentId = String(appointmentId || '');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    requestAnimationFrame(() => {
      const focusTarget = selectedPetId
        ? document.getElementById('adminMedicalRecordWeight')
        : document.getElementById('adminMedicalRecordPetId');
      focusTarget?.focus();
    });
  }
}

function closeMedicalRecordForm(force = false) {
  const modal = document.getElementById('adminMedicalRecordModal');
  const form = document.getElementById('adminMedicalRecordForm');
  if (!force && isFormSubmitting(form)) return;

  modal?.classList.add('hidden');
  modal?.classList.remove('flex');
  if (modal) delete modal.dataset.appointmentId;
  if (medicalRecordReturnFocus && document.body.contains(medicalRecordReturnFocus)) medicalRecordReturnFocus.focus();
  medicalRecordReturnFocus = null;
}

function getMedicalRecordFormPayload(form, appointmentId = '') {
  const formData = new FormData(form);
  const adminId = getCurrentAdminUserId();
  const payload = {
    user_id: adminId,
    pet_id: String(formData.get('pet_id') || '').trim(),
    record_date: String(formData.get('record_date') || '').trim(),
    created_by: adminId
  };

  ['weight', 'vaccination_status', 'treatment', 'medical_notes'].forEach(field => {
    const value = String(formData.get(field) || '').trim();
    if (value) payload[field] = value;
  });

  if (!payload.pet_id) {
    throw new Error('Select a valid pet before saving.');
  }

  if (!getPetById(payload.pet_id)) {
    throw new Error('Select a valid pet before saving.');
  }

  if (!payload.record_date) {
    throw new Error('Record date is required.');
  }

  if (!payload.user_id) {
    throw new Error('Admin user ID not found. Please log in again.');
  }

  if (appointmentId) {
    payload.appointment_id = String(appointmentId);
  }

  if (!payload.weight || !payload.vaccination_status || !payload.treatment || !payload.medical_notes) {
    throw new Error('Weight, vaccination status, treatment, and medical notes are required.');
  }

  const numericWeight = Number(payload.weight);
  if (!Number.isFinite(numericWeight) || numericWeight < 0) {
    throw new Error('Weight must be a valid non-negative number.');
  }

  return payload;
}

// Adding a record: the admin opens a completed appointment -> the form checks the required fields -> POST
// /admin/dashboard/medical-records/create -> the server verifies the admin, that the pet exists and belongs to the
// appointment's owner, that the appointment is Completed and has no record yet (409 otherwise), saves the record with
// created_by = this admin and logs it -> only then is the record shown, using the record the server returned.
async function submitMedicalRecordForm(event) {
  event.preventDefault();

  const form = event.currentTarget;
  if (isFormSubmitting(form)) return;

  const modal = document.getElementById('adminMedicalRecordModal');
  const appointmentId = modal?.dataset?.appointmentId;
  const appointment = getMedicalRecordAppointment(appointmentId);

  try {
    if (!appointment || getAppointmentStatus(appointment.status) !== 'Completed') {
      throw new Error('Medical records can only be added after an appointment is completed.');
    }

    if (appointmentHasMedicalRecord(appointment)) {
      throw new Error('A medical record has already been added for this appointment.');
    }

    const payload = getMedicalRecordFormPayload(form, appointmentId);
    const adminQuery = getAdminUserIdQuery();
    const adminId = getCurrentAdminUserId();
    if (!adminQuery || !adminId) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    setMedicalRecordFormError('');
    setFormSubmitting(form, true, 'Saving...', 'Save Record');

    const response = await fetchWithRetry(() =>
      fetch(`${window.API_BASE_URL}/admin/dashboard/medical-records/create${adminQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': adminId },
        body: JSON.stringify(payload)
      })
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || 'Could not create medical record.');
    }

    if (!data.record) {
      throw new Error('Medical record save succeeded but no record was returned.');
    }

    markAppointmentMedicalRecordCompleted(appointmentId, data.record);
    refreshMedicalRecordActionViews();
    closeMedicalRecordForm(true);
    showAdminStatus('success', 'Medical record added.');
  } catch (error) {
    console.error('Error creating medical record:', error);
    if (isMedicalRecordAlreadyAddedError(error)) {
      markAppointmentMedicalRecordCompleted(appointmentId);
      refreshMedicalRecordActionViews();
      closeMedicalRecordForm(true);
      showAdminStatus('success', 'Medical record already added for this appointment.');
      return;
    }
    setMedicalRecordFormError(error.message || 'Could not create medical record.');
  } finally {
    setFormSubmitting(form, false, 'Saving...', 'Save Record');
    updateMedicalRecordSaveState(form, false);
  }
}

/**
 * Load all contact messages
 */
async function loadContactMessages(shouldRender = true) {
  const messagesTable = document.getElementById('contactMessagesTable');
  adminDashboardData.messagesLoading = true;
  adminDashboardData.messagesError = '';
  if (shouldRender && messagesTable) {
    messagesTable.innerHTML = getAdminTableLoadingRow(6, 'messages');
  }

  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/dashboard/contact-messages${getAdminUserIdQuery()}`));
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load contact messages (${response.status})`);
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.error || 'Failed to load contact messages');
    }

    adminDashboardData.messages = asArray(data.messages);
    adminDashboardData.messagesLoaded = true;
    adminDashboardData.messagesError = '';
    if (shouldRender) displayContactMessagesTable(adminDashboardData.messages);
    return adminDashboardData.messages;
  } catch (error) {
    console.error('Error loading contact messages:', error);
    adminDashboardData.messages = [];
    adminDashboardData.messagesLoaded = true;
    adminDashboardData.messagesError = error.message || 'Unable to load contact messages.';
    if (shouldRender && messagesTable) {
      messagesTable.innerHTML = getAdminTableErrorRow(6, 'Unable to load messages', 'messages');
    }
    return [];
  } finally {
    adminDashboardData.messagesLoading = false;
  }
}

function renderMessages() {
  const messagesTable = document.getElementById('contactMessagesTable');
  if (adminDashboardData.messagesLoading || (!adminDashboardData.messagesLoaded && adminDashboardData.isLoading)) {
    if (messagesTable) {
      messagesTable.innerHTML = getAdminTableLoadingRow(6, 'messages');
    }
    return;
  }

  if (!adminDashboardData.messagesLoaded) {
    if (messagesTable) {
      messagesTable.innerHTML = getContactMessagesEmptyState();
    }
    return;
  }

  if (adminDashboardData.messagesError) {
    if (messagesTable) {
      messagesTable.innerHTML = getAdminTableErrorRow(6, 'Unable to load messages', 'messages');
    }
    return;
  }

  displayContactMessagesTable(adminDashboardData.messages);
}

function displayContactMessagesTable(messages) {
  const messagesTable = document.getElementById('contactMessagesTable');
  if (!messagesTable) return;

  if (!messages || messages.length === 0) {
    messagesTable.innerHTML = getContactMessagesEmptyState();
    return;
  }

  messagesTable.innerHTML = messages.map(msg => {
    const status = getContactMessageStatus(msg.status);

    return `
    <tr>
      <td>${escapeHtml(displayValue(msg.fullname, 'Name not provided'))}</td>
      <td>${escapeHtml(displayValue(msg.email, 'Email not provided'))}</td>
      <td class="ph-dash-wrap">${escapeHtml(displayValue(msg.message, 'No message text'))}</td>
      <td>
        <span class="${getContactStatusBadgeClass(status)}">
          ${escapeHtml(status)}
        </span>
      </td>
      <td>${escapeHtml(formatTableDate(msg.created_at, 'Date not recorded'))}</td>
      <td>
        ${renderContactMessageActions(status, msg.id)}
      </td>
    </tr>
  `;
  }).join('');
}

function getContactMessagesEmptyState() {
  return getAdminTableEmptyRow(6, 'No contact messages yet.', 'Public contact form submissions will appear here for admin review.');
}

function getContactMessageStatus(status) {
  if (!hasRecordedValue(status)) return 'Status not recorded';
  const normalizedStatus = String(status).toLowerCase();
  const statusMap = {
    unread: 'Unread',
    read: 'Read'
  };
  return statusMap[normalizedStatus] || displayValue(status, 'Status not recorded');
}

function getContactStatusBadgeClass(status) {
  if (status === 'Unread') {
    return 'admin-status-badge admin-status-warning';
  }
  if (status === 'Read') {
    return 'admin-status-badge admin-status-success';
  }
  return 'admin-status-badge admin-status-neutral';
}

function renderContactMessageActions(status, messageId) {
  if (status !== CONTACT_MESSAGE_ACTIONABLE_STATUS) {
    return '';
  }

  if (!messageId) {
    return '<span class="ph-dash-muted">Action unavailable</span>';
  }

  return `
    <div class="flex flex-wrap gap-2">
      <button type="button" data-message-id="${escapeHtml(String(messageId))}" class="${getAdminActionButtonClass('neutral')}">
        Mark as Read
      </button>
    </div>
  `;
}

async function toggleContactMessageStatus(button, messageId, newStatus) {
  if (!messageId || !newStatus) return;
  if (button?.dataset?.loading === 'true') return;
  if (newStatus !== CONTACT_MESSAGE_READ_STATUS) {
    showAdminStatus('error', 'Messages can only be marked as read.');
    return;
  }

  const originalText = button?.textContent?.trim() || 'Update';
  try {
    setActionButtonGroupLoading(button, true, 'Updating...', originalText);

    const adminQuery = getAdminUserIdQuery();
    if (!adminQuery) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const response = await fetchWithRetry(() =>
      fetch(`${window.API_BASE_URL}/admin/dashboard/contact-message-status${adminQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: messageId, status: newStatus })
      })
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Could not update message (${response.status})`);
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.error || 'Could not update message.');
    }

    if (!data.message) {
      throw new Error('Message status update succeeded but no message was returned');
    }

    await loadDashboardOverview();
    showAdminStatus('success', getContactMessageStatusFeedback(newStatus));
  } catch (error) {
    console.error('Error updating message status:', error);
    showAdminStatus('error', 'Unable to update the message right now. Please try again.');
  } finally {
    setActionButtonGroupLoading(button, false, 'Updating...', originalText);
  }
}

// ==================== SERVICES & BOOKING (System Management) ====================

function renderServiceCatalog() {
  const container = document.getElementById('servicesCatalogContainer');
  const summary = document.getElementById('bookingStatusSummary');
  if (!container) return;

  if (!adminDashboardData.serviceCatalogLoaded) {
    container.innerHTML = getDashboardSectionLoadingHtml('services', 1);
    if (summary) summary.textContent = '';
    return;
  }
  if (adminDashboardData.serviceCatalogError) {
    container.innerHTML = getAdminErrorBlock('Unable to load the service catalog', 'the service catalog');
    if (summary) summary.textContent = '';
    return;
  }

  const services = asArray(adminDashboardData.serviceCatalog);
  const bookableCount = services.filter(service => service.bookable === true).length;
  if (summary) {
    summary.textContent = bookableCount === 0
      ? `Online booking is closed: none of the ${services.length} services has a confirmed duration yet, so the server refuses new bookings and owners are asked to contact the clinic.`
      : `Online booking is open for ${bookableCount} of ${services.length} services.`;
  }

  if (!services.length) {
    container.innerHTML = getAdminEmptyBlock('No services listed', 'The server returned an empty service catalog.');
    return;
  }

  container.innerHTML = `
    <div class="ph-dash-table-wrap">
      <table class="ph-dash-table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Category</th>
            <th scope="col">For</th>
            <th scope="col">Confirmed duration</th>
            <th scope="col">Online booking</th>
          </tr>
        </thead>
        <tbody>
          ${services.map(service => `
            <tr>
              <td><strong>${escapeHtml(displayValue(service.name))}</strong><p class="ph-dash-muted ph-dash-wrap">${escapeHtml(displayValue(service.description, ''))}</p></td>
              <td>${escapeHtml(displayValue(service.category_label || service.category))}</td>
              <td>${escapeHtml(asArray(service.species).join(', ') || 'Not recorded')}</td>
              <td>${Number.isInteger(service.duration_minutes) && service.duration_minutes > 0 ? escapeHtml(`${service.duration_minutes} minutes`) : '<span class="ph-dash-muted">Not confirmed</span>'}</td>
              <td>${service.bookable === true
                ? '<span class="ph-status ph-status-completed px-2.5 py-1 text-xs">Open</span>'
                : '<span class="ph-status ph-status-other px-2.5 py-1 text-xs">Not open</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Get CSS class for status badge (the same readable colours the pet owner sees)
 */
function getStatusBadgeClass(status) {
  const classes = {
    'Pending': 'ph-status ph-status-pending',
    'Approved': 'ph-status ph-status-approved',
    'Completed': 'ph-status ph-status-completed',
    'Cancelled': 'ph-status ph-status-cancelled'
  };
  return `${classes[status] || 'ph-status ph-status-other'} px-2.5 py-1 text-xs`;
}

function formatSuggestedAppointmentTimeDisplay(timeValue) {
  const match = String(timeValue || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return '';
  }

  return new Date(2000, 0, 1, hours, minutes, seconds).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getAppointmentStatusUpdateErrorMessage(error) {
  const suggestedTime = formatSuggestedAppointmentTimeDisplay(error?.suggestedTime);
  if (suggestedTime) {
    return `Selected time is unavailable. Next available time: ${suggestedTime}.`;
  }
  return error?.message || 'Could not update appointment.';
}

/**
 * Approve, complete or cancel an appointment.
 * 1. The admin clicks an action on an appointment (Approve / Cancel on Pending, Complete / Cancel on Approved) and
 *    clicks again to confirm.
 * 2. The page checks it has the appointment id and the signed-in admin.
 * 3. PUT /admin/dashboard/appointment-status { id, status }.
 * 4. The server verifies the token and the admin role (routes/admin.js) and loads the appointment.
 * 5. It allows only Pending -> Approved/Cancelled and Approved -> Completed/Cancelled; an approval is refused with 409
 *    if it would overlap another approved or completed appointment (using each appointment's saved duration, which also
 *    covers earlier services such as "Checkup"), and a status changed meanwhile by another admin gives 409 too.
 * 6. On success the dashboard reloads everything from the server and only then says it worked; on failure it shows the
 *    server's message (with the next free time for a schedule conflict) and the appointment is unchanged.
 * 7. The owner sees the new status the next time their dashboard loads; approval and cancellation also email them.
 */
async function updateAppointmentStatus(button, appointmentId, newStatus) {
  if (button?.dataset?.loading === 'true') return;

  if (!requireSecondClick(button, {
    key: `appointment-status:${appointmentId}:${newStatus}`,
    message: 'Click again to confirm'
  })) {
    return;
  }

  const originalText = button?.textContent?.trim() || 'Update';
  try {
    setActionButtonGroupLoading(button, true, 'Updating...', originalText);

    if (!appointmentId) {
      throw new Error('Appointment ID is required.');
    }

    const adminQuery = getAdminUserIdQuery();
    if (!adminQuery) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const response = await fetchWithRetry(() =>
      fetch(`${window.API_BASE_URL}/admin/dashboard/appointment-status${adminQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: appointmentId,
          status: newStatus
        })
      })
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      const updateError = new Error(data.error || 'Could not update appointment.');
      updateError.suggestedTime = data.suggested_time;
      throw updateError;
    }

    if (!data.appointment) {
      throw new Error('Appointment update succeeded but no appointment was returned');
    }

    await loadDashboardOverview();
    showAdminStatus('success', getAppointmentStatusFeedback(newStatus));
  } catch (error) {
    console.error('Error updating appointment:', error);
    setActionButtonGroupLoading(button, false, 'Updating...', originalText);
    showAdminStatus('error', getAppointmentStatusUpdateErrorMessage(error));
  }
}

function getContactMessageStatusFeedback(status) {
  return status === CONTACT_MESSAGE_READ_STATUS ? 'Message marked read.' : 'Status updated.';
}

function getAppointmentStatusFeedback(status) {
  const messages = {
    Approved: 'Appointment approved.',
    Completed: 'Appointment completed.',
    Cancelled: 'Appointment cancelled.'
  };
  return messages[status] || 'Appointment updated.';
}

window.handleUserRoleChange = handleUserRoleChange;
window.toggleContactMessageStatus = toggleContactMessageStatus;
window.openMedicalRecordForm = openMedicalRecordForm;
window.closeMedicalRecordForm = closeMedicalRecordForm;
window.updateAppointmentStatus = updateAppointmentStatus;
