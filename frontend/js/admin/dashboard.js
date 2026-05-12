// ==================== ADMIN DASHBOARD ====================

// Connection retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY = 500; // milliseconds
const NEW_USER_WINDOW_DAYS = 7;
const CONTACT_MESSAGE_ACTIONABLE_STATUS = 'Unread';
const CONTACT_MESSAGE_READ_STATUS = 'Read';
const ADMIN_MANAGEMENT_TAB_STORAGE_KEY = 'pethubAdminDashboardManagementTab';
const ADMIN_APPOINTMENT_STATUS_STORAGE_KEY = 'pethubAdminDashboardAppointmentStatusFilter';

document.addEventListener('DOMContentLoaded', () => {
  initializeAdminDashboard();
});

let petTypeChart = null;
let serviceUsageChart = null;
let appointmentTrendChart = null;
let currentAdminView = 'overview';
let currentAdminManagementTab = 'users';
let dashboardOverviewLoadPromise = null;
let adminDashboardInteractionsBound = false;
let adminDashboardActionsBound = false;
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
  petTypes: { labels: [], values: [] },
  services: { labels: [], values: [] },
  appointmentsTrend: { labels: [], values: [] }
};

function getActivityIcon(action) {
  const iconMap = {
    user_logged_in: 'ri-login-circle-line text-blue-500',
    user_registered: 'ri-user-add-line text-green-500',
    email_verified: 'ri-mail-check-line text-teal-500',
    pet_created: 'ri-paw-line text-orange-500',
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
    redirectToLogin();
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
  setupAdminDashboardInteractions();
  setupAdminDashboardActions();

  const initialView = normalizeAdminViewName(window.location.hash.replace(/^#/, ''));
  showAdminView(initialView);
  window.addEventListener('hashchange', () => showAdminView(window.location.hash.replace(/^#/, '')));

  await loadDashboardOverview();
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
}

function normalizeAdminViewName(viewName) {
  const value = String(viewName || '').replace(/^#/, '').trim();
  const map = {
    dashboard: 'overview',
    dashboardOverview: 'overview',
    overview: 'overview',
    analytics: 'analytics',
    analyticsSummary: 'analytics',
    management: 'management',
    medicalRecords: 'medicalRecords',
    medicalRecordsSection: 'medicalRecords',
    activityLogs: 'activityLogs',
    systemLogs: 'activityLogs',
    messages: 'messages'
  };

  return map[value] || 'overview';
}

function normalizeAdminManagementTab(tab) {
  return ['users', 'pets', 'appointments'].includes(tab) ? tab : 'users';
}

function getStoredAdminManagementTab() {
  try {
    return normalizeAdminManagementTab(sessionStorage.getItem(ADMIN_MANAGEMENT_TAB_STORAGE_KEY));
  } catch (error) {
    return 'users';
  }
}

function setStoredAdminManagementTab(tab) {
  currentAdminManagementTab = normalizeAdminManagementTab(tab);
  try {
    sessionStorage.setItem(ADMIN_MANAGEMENT_TAB_STORAGE_KEY, currentAdminManagementTab);
  } catch (error) {
    // Ignore storage failures; the visible tab still updates for this page session.
  }
}

function getStoredAdminAppointmentStatusFilter() {
  try {
    const status = sessionStorage.getItem(ADMIN_APPOINTMENT_STATUS_STORAGE_KEY);
    return ['all', 'Pending', 'Approved', 'Completed', 'Cancelled'].includes(status) ? status : 'all';
  } catch (error) {
    return 'all';
  }
}

function setStoredAdminAppointmentStatusFilter(status) {
  const normalizedStatus = ['all', 'Pending', 'Approved', 'Completed', 'Cancelled'].includes(status) ? status : 'all';
  try {
    sessionStorage.setItem(ADMIN_APPOINTMENT_STATUS_STORAGE_KEY, normalizedStatus);
  } catch (error) {
    // Ignore storage failures; the selected filter still stays active in the DOM.
  }
}

function showAdminView(viewName) {
  const normalizedView = normalizeAdminViewName(viewName);
  currentAdminView = normalizedView;
  const views = {
    overview: document.getElementById('adminViewOverview'),
    analytics: document.getElementById('adminViewAnalytics'),
    management: document.getElementById('adminViewManagement'),
    medicalRecords: document.getElementById('adminViewMedicalRecords'),
    activityLogs: document.getElementById('adminViewActivityLogs'),
    messages: document.getElementById('adminViewMessages')
  };

  Object.values(views).forEach(view => {
    if (view) view.classList.add('hidden');
  });

  if (views[normalizedView]) {
    views[normalizedView].classList.remove('hidden');
  } else if (views.overview) {
    currentAdminView = 'overview';
    views.overview.classList.remove('hidden');
  }

  updateAdminSidebarActiveState(currentAdminView);
  renderCurrentAdminView();
  updateAdminViewHash(currentAdminView);
  resetAdminMobileNavigationState();
}

function resetAdminMobileNavigationState() {
  if (typeof window.closeAdminMobileSidebar === 'function') {
    window.closeAdminMobileSidebar();
    return;
  }

  if (!window.matchMedia('(max-width: 767px)').matches) {
    return;
  }

  const adminSidebar = document.getElementById('adminSidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const sidebarToggles = document.querySelectorAll('#sidebarToggle, [data-admin-sidebar-toggle]');

  adminSidebar?.classList.remove('is-open');
  adminSidebar?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('admin-sidebar-open');
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.add('hidden');
    sidebarBackdrop.hidden = true;
    sidebarBackdrop.setAttribute('aria-hidden', 'true');
  }
  sidebarToggles.forEach(toggle => {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('is-open');
  });
}

function updateAdminViewHash(viewName) {
  const currentHash = window.location.hash.replace(/^#/, '').trim();
  if (isAdminViewHashForView(currentHash, viewName)) {
    return;
  }
  history.replaceState(null, '', `#${viewName}`);
}

function isAdminViewHashForView(hash, viewName) {
  const value = String(hash || '').replace(/^#/, '').trim();
  const knownHashes = [
    'dashboard',
    'dashboardOverview',
    'overview',
    'analytics',
    'analyticsSummary',
    'management',
    'medicalRecords',
    'medicalRecordsSection',
    'activityLogs',
    'systemLogs',
    'messages'
  ];
  return knownHashes.includes(value) && normalizeAdminViewName(value) === viewName;
}

function updateAdminSidebarActiveState(activeView) {
  const sidebarLinks = document.querySelectorAll('a[data-admin-view]');
  sidebarLinks.forEach(link => {
    const view = link.getAttribute('data-admin-view');
    const isActive = view === activeView;
    link.classList.remove('is-activating');
    link.classList.toggle('is-active', isActive);
    link.classList.toggle('bg-orange-500', isActive);
    link.classList.toggle('text-white', isActive);
    link.classList.toggle('shadow-sm', isActive);
    link.classList.toggle('text-slate-600', !isActive);
    link.classList.toggle('hover:bg-orange-50', !isActive);
    link.classList.toggle('hover:text-orange-600', !isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
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
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">
      <p class="font-semibold">${escapeHtml(title)}</p>
      <p class="mt-1 text-sm">${escapeHtml(getFriendlyAdminErrorMessage(sectionName))}</p>
    </div>
  `;
}

function getAdminTableErrorRow(colspan, title, sectionName) {
  return `
    <tr>
      <td colspan="${colspan}" class="px-4 py-8 text-center text-red-700">
        <p class="font-semibold">${escapeHtml(title)}</p>
        <p class="mt-1 text-sm">${escapeHtml(getFriendlyAdminErrorMessage(sectionName))}</p>
      </td>
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
  ['insightPetType', 'insightService', 'insightBookings', 'insightCompletion'].forEach(id => {
    setElementLoading(id, 'Loading');
  });
}

function showAdminDashboardLoadingStates() {
  [
    'analyticsTotalUsers',
    'analyticsTotalPets',
    'analyticsTotalAppointments',
    'analyticsPendingAppointments',
    'alertPendingAppointments',
    'alertUnreadMessages',
    'alertNewUsers',
    'alertMedicalRecords',
    'sidebarTotalUsers',
    'sidebarTotalPets',
    'sidebarPendingAppointments',
    'sidebarContactMessages',
    'sidebarVerifiedUsers',
    'sidebarMedicalRecords'
  ].forEach(id => setElementLoading(id, 'Loading'));

  showAdminAnalyticsLoadingStates();
}

window.showAdminView = showAdminView;

function renderCurrentAdminView() {
  if (currentAdminView === 'overview') return renderOverview();
  if (currentAdminView === 'analytics') return renderAnalytics();
  if (currentAdminView === 'management') return renderManagement();
  if (currentAdminView === 'medicalRecords') return renderMedicalRecords();
  if (currentAdminView === 'activityLogs') return renderActivityLogs();
  if (currentAdminView === 'messages') return renderMessages();
  renderOverview();
}

function renderOverview() {
  if (adminDashboardData.isLoading && !adminDashboardData.isLoaded) {
    showAdminDashboardLoadingStates();
    return;
  }
  displayAnalyticsSummary(adminDashboardData.summary || {});
  displayAnalyticsExtras();
}

function renderAnalytics() {
  if (adminDashboardData.isLoading && !adminDashboardData.isLoaded) {
    showAdminDashboardLoadingStates();
    return;
  }
  displayAnalyticsSummary(adminDashboardData.summary || {});
  displayAnalyticsExtras();
  displayAnalyticsInsights();
  renderPetTypeChart(adminDashboardData.petTypes.labels, adminDashboardData.petTypes.values);
  renderServiceUsageChart(adminDashboardData.services.labels, adminDashboardData.services.values);
  renderAppointmentTrendChart(adminDashboardData.appointmentsTrend.labels, adminDashboardData.appointmentsTrend.values);
}

function renderManagement() {
  if (adminDashboardData.isLoading && !adminDashboardData.isLoaded) {
    showManagementLoadingStates();
    return;
  }
  displayUsersTable(adminDashboardData.users);
  displayPetsTable(adminDashboardData.pets);
  displayAppointmentsTable(adminDashboardData.appointments);
}

function renderMedicalRecords() {
  if (adminDashboardData.isLoading && !adminDashboardData.isLoaded) {
    const recordsContainer = document.getElementById('recentMedicalRecordsContainer');
    if (recordsContainer) {
      recordsContainer.innerHTML = getDashboardSectionLoadingHtml('medical records', 2);
    }
    return;
  }
  displayMedicalRecordsSection(adminDashboardData.medicalRecords);
}

function renderActivityLogs() {
  renderSystemLogs();
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
  const baseClasses = 'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold shadow-sm transition';
  const classes = {
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
    success: 'bg-green-50 text-green-700 hover:bg-green-100',
    neutral: 'bg-slate-100 text-slate-700 hover:bg-slate-200'
  };

  return `${baseClasses} ${classes[type] || classes.neutral}`;
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
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/system-logs${getAdminUserIdQuery()}`));
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

function getRecordDateTime(record) {
  const date = new Date(record?.record_date || record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getLatestMedicalRecordForPet(petId) {
  if (!hasRecordedValue(petId)) return null;
  const id = String(petId);
  return asArray(adminDashboardData.medicalRecords)
    .filter(record => String(record.pet_id) === id)
    .sort((a, b) => getRecordDateTime(b) - getRecordDateTime(a))[0] || null;
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

function countVaccinationsDueSoon() {
  const today = getTodayDateKey();
  return asArray(adminDashboardData.appointments).filter(appointment => {
    const service = String(appointment.service_type || '').toLowerCase();
    const dateKey = normalizeDashboardDateValue(appointment.appointment_date);
    return service.includes('vaccination') && dateKey && dateKey >= today && getAppointmentStatus(appointment.status) !== 'Cancelled';
  }).length;
}

function countVerifiedUsersFromRecords() {
  return asArray(adminDashboardData.users).filter(user => isVerifiedValue(user.is_verified)).length;
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

  return {
    ...summary,
    totalUsers: users.length,
    totalPets: pets.length,
    totalAppointments,
    pendingAppointments: countAppointmentsByStatus('Pending'),
    completedAppointments,
    vaccinationsDueSoon: countVaccinationsDueSoon(),
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
  adminDashboardData.services = buildServiceUsageDataset();
  adminDashboardData.appointmentsTrend = buildAppointmentTrendDataset();
}

function displayAnalyticsSummary(summary) {
  const totalUsers = document.getElementById('analyticsTotalUsers');
  const totalPets = document.getElementById('analyticsTotalPets');
  const totalAppointments = document.getElementById('analyticsTotalAppointments');
  const pendingAppointments = document.getElementById('analyticsPendingAppointments');
  const verifiedUsers = document.getElementById('analyticsVerifiedUsers');
  const activityLogs = document.getElementById('analyticsActivityLogs');
  const completedAppointments = document.getElementById('analyticsCompletedAppointments');
  const vaccinationsDue = document.getElementById('analyticsVaccinationsDue');
  const medicalRecords = document.getElementById('analyticsMedicalRecords');

  const summaryData = buildRealDashboardSummary(summary || {});
  const medicalRecordsCount = summaryData.totalMedicalRecords;
  const unavailable = Boolean(adminDashboardData.overviewError);

  if (totalUsers) totalUsers.textContent = formatDashboardDataValue(summaryData.totalUsers, unavailable);
  if (totalPets) totalPets.textContent = formatDashboardDataValue(summaryData.totalPets, unavailable);
  if (totalAppointments) totalAppointments.textContent = formatDashboardDataValue(summaryData.totalAppointments, unavailable);
  if (pendingAppointments) pendingAppointments.textContent = formatDashboardDataValue(summaryData.pendingAppointments, unavailable);
  if (verifiedUsers) verifiedUsers.textContent = formatDashboardDataValue(summaryData.verifiedUsers, unavailable);
  if (activityLogs) activityLogs.textContent = formatDashboardDataValue(summaryData.activityLogCount, unavailable);
  if (completedAppointments) completedAppointments.textContent = formatDashboardDataValue(summaryData.completedAppointments, unavailable);
  if (vaccinationsDue) vaccinationsDue.textContent = formatDashboardDataValue(summaryData.vaccinationsDueSoon, unavailable);
  if (medicalRecords) {
    const displayValue = formatDashboardDataValue(medicalRecordsCount, unavailable);
    medicalRecords.textContent = displayValue;
  }

  adminDashboardData.summary = summaryData;
  displaySidebarStats(summaryData);
  displayDashboardAlerts(summaryData);
}

function displaySidebarStats(summary) {
  const sidebarTotalUsers = document.getElementById('sidebarTotalUsers');
  const sidebarTotalPets = document.getElementById('sidebarTotalPets');
  const sidebarPendingAppointments = document.getElementById('sidebarPendingAppointments');
  const sidebarMedicalRecords = document.getElementById('sidebarMedicalRecords');

  const unavailable = Boolean(adminDashboardData.overviewError);

  if (sidebarTotalUsers) sidebarTotalUsers.textContent = formatDashboardDataValue(summary.totalUsers, unavailable);
  if (sidebarTotalPets) sidebarTotalPets.textContent = formatDashboardDataValue(summary.totalPets, unavailable);
  if (sidebarPendingAppointments) sidebarPendingAppointments.textContent = formatDashboardDataValue(summary.pendingAppointments, unavailable);
  if (sidebarMedicalRecords) sidebarMedicalRecords.textContent = formatDashboardDataValue(summary.totalMedicalRecords, unavailable);
  const sidebarContactMessages = document.getElementById('sidebarContactMessages');
  if (sidebarContactMessages) {
    if (adminDashboardData.messagesLoading && !adminDashboardData.messagesLoaded) {
      sidebarContactMessages.innerHTML = getDashboardInlineLoadingHtml('Loading');
    } else if (adminDashboardData.messagesError) {
      sidebarContactMessages.textContent = '-';
    } else {
      sidebarContactMessages.textContent = formatDashboardValue(adminDashboardData.messages.length);
    }
  }
  const sidebarVerifiedUsers = document.getElementById('sidebarVerifiedUsers');
  if (sidebarVerifiedUsers) sidebarVerifiedUsers.textContent = formatDashboardDataValue(summary.verifiedUsers, unavailable);
}

function getDashboardCount(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

function getPendingAppointmentsAlertCount(summary) {
  const summaryCount = getDashboardCount(summary?.pendingAppointments);
  if (summaryCount !== null) return summaryCount;
  if (adminDashboardData.overviewError && !adminDashboardData.appointments.length) return 'Unavailable';
  return adminDashboardData.appointments.filter(appointment => getAppointmentStatus(appointment.status) === 'Pending').length;
}

function getUnreadMessagesAlertValue() {
  if (adminDashboardData.messagesError) return 'Unavailable';
  if (!adminDashboardData.messagesLoaded && adminDashboardData.messagesLoading) return 'Loading...';

  const messages = Array.isArray(adminDashboardData.messages) ? adminDashboardData.messages : [];
  return messages.filter(message => String(message.status || '').toLowerCase() === 'unread').length;
}

function getMedicalRecordsAlertValue(summary) {
  const recordsCount = Array.isArray(adminDashboardData.medicalRecords)
    ? adminDashboardData.medicalRecords.length
    : getDashboardCount(summary?.totalMedicalRecords);

  if (adminDashboardData.overviewError && !adminDashboardData.medicalRecords.length) return 'Unavailable';
  if (recordsCount === null) return 'Unavailable';
  return String(recordsCount);
}

function getNewUsersAlertValue() {
  const users = Array.isArray(adminDashboardData.users) ? adminDashboardData.users : [];
  if (adminDashboardData.overviewError && !users.length) return 'Unavailable';
  const now = Date.now();
  const cutoff = now - (NEW_USER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return users.filter(user => {
    const createdAt = new Date(user.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now;
  }).length;
}

function getRecentActivityAlertValue(summary) {
  if (!adminDashboardData.activityLogsLoaded && adminDashboardData.activityLogsLoading) return 'Loading...';

  if (adminDashboardData.activityLogsLoaded && !adminDashboardData.activityLogsError) {
    return Array.isArray(adminDashboardData.activityLogs) ? String(adminDashboardData.activityLogs.length) : '0';
  }

  const summaryCount = getDashboardCount(summary?.activityLogCount);
  return summaryCount !== null ? String(summaryCount) : 'Unavailable';
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
  if (medicalRecords) medicalRecords.textContent = getMedicalRecordsAlertValue(summary);
}

function bindDashboardCardAction(elementId, handler) {
  const element = document.getElementById(elementId);
  if (!element) return;

  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.addEventListener('click', () => {
    markInteractionFeedback(element);
    handler();
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      markInteractionFeedback(element);
      handler();
    }
  });
}

function openAdminManagementTab(tab, statusFilter = null, message = '') {
  if (tab === 'users') {
    const userSearchInput = document.getElementById('userSearchInput');
    if (userSearchInput) userSearchInput.value = '';
  }

  if (tab === 'pets') {
    const petSearchInput = document.getElementById('petSearchInput');
    if (petSearchInput) petSearchInput.value = '';
  }

  if (tab === 'appointments') {
    const appointmentSearchInput = document.getElementById('appointmentSearchInput');
    if (appointmentSearchInput) appointmentSearchInput.value = '';
  }

  showAdminView('management');
  switchAdminTab(tab, statusFilter);
  if (message) showAdminStatus('success', message);
}

function bindDashboardButtonAction(elementId, handler) {
  const button = document.getElementById(elementId);
  if (!button) return;

  button.addEventListener('click', () => {
    markInteractionFeedback(button);
    handler();
  });
}

function setupAdminDashboardActions() {
  if (adminDashboardActionsBound) return;
  adminDashboardActionsBound = true;

  bindDashboardCardAction('cardTotalUsers', () => {
    openAdminManagementTab('users', null, 'Viewing user accounts');
  });

  bindDashboardCardAction('cardTotalPets', () => {
    openAdminManagementTab('pets', null, 'Viewing pet profiles');
  });

  bindDashboardCardAction('cardTotalAppointments', () => {
    openAdminManagementTab('appointments', null, 'Viewing all appointments');
  });

  bindDashboardCardAction('cardPendingAppointments', () => {
    openAdminManagementTab('appointments', 'Pending', 'Viewing pending appointment queue');
  });

  bindDashboardButtonAction('queuePendingAppointments', () => {
    openAdminManagementTab('appointments', 'Pending', 'Viewing pending appointment queue');
  });

  bindDashboardButtonAction('queueUnreadMessages', () => {
    showAdminView('messages');
    showAdminStatus('success', 'Viewing contact messages');
  });

  bindDashboardButtonAction('queueNewUsers', () => {
    openAdminManagementTab('users', null, 'Viewing user accounts');
  });

  bindDashboardButtonAction('queueMedicalRecords', () => {
    showAdminView('medicalRecords');
    showAdminStatus('success', 'Viewing medical records');
  });

}

function switchAdminTab(tab, statusFilter = null) {
  const activeTab = normalizeAdminManagementTab(tab);
  setStoredAdminManagementTab(activeTab);

  const panels = ['users', 'pets', 'appointments'];
  panels.forEach(name => {
    const panel = document.getElementById(`${name}TabPanel`);
    const button = document.getElementById(`tab${name.charAt(0).toUpperCase() + name.slice(1)}`);
    const isActive = name === activeTab;

    if (panel) {
      panel.classList.add('admin-tab-panel');
      if (isActive) {
        panel.classList.remove('hidden');
        window.requestAnimationFrame(() => panel.classList.add('is-active'));
      } else {
        panel.classList.remove('is-active');
        panel.classList.add('hidden');
      }
    }
    if (button) {
      button.classList.toggle('is-active', isActive);
      button.classList.toggle('bg-orange-500', isActive);
      button.classList.toggle('text-white', isActive);
      button.classList.toggle('bg-slate-100', !isActive);
      button.classList.toggle('text-slate-700', !isActive);
      button.setAttribute('aria-pressed', String(isActive));
      button.setAttribute('aria-selected', String(isActive));
    }
  });

  if (activeTab === 'appointments') {
    const statusSelect = document.getElementById('appointmentStatusFilter');
    if (statusSelect) {
      statusSelect.value = statusFilter || getStoredAdminAppointmentStatusFilter();
      setStoredAdminAppointmentStatusFilter(statusSelect.value);
    }
    if (adminDashboardData.isLoading && !adminDashboardData.isLoaded) {
      return;
    }
    applyAppointmentSearchFilter();
  }
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

function displayAnalyticsExtras() {
  const topUserEl = document.getElementById('analyticsTopUser');
  const topServiceEl = document.getElementById('analyticsTopService');
  const peakDayEl = document.getElementById('analyticsPeakDay');

  if (adminDashboardData.overviewError) {
    if (topUserEl) topUserEl.textContent = 'Unavailable';
    if (topServiceEl) topServiceEl.textContent = 'Unavailable';
    if (peakDayEl) peakDayEl.textContent = 'Unavailable';
    return;
  }

  if (topUserEl) topUserEl.textContent = getTopActiveUser() || 'No data available';
  if (topServiceEl) topServiceEl.textContent = getMostRequestedService() || 'No data available';
  if (peakDayEl) peakDayEl.textContent = getPeakBookingDay() || 'No data available';
}

function displayMedicalRecordsSection(records) {
  const recordsList = Array.isArray(records) ? [...records] : [];
  const getRecordTime = getRecordDateTime;
  const sortedRecords = recordsList.sort((a, b) => getRecordTime(b) - getRecordTime(a));
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
    recordsContainer.innerHTML = `
      <div class="rounded-2xl border border-gray-200 bg-white p-6 text-center text-slate-500">
        <p class="font-semibold text-slate-700">No medical records yet.</p>
        <p class="mt-1 text-sm text-slate-500">Official records will appear here after staff records completed pet services.</p>
      </div>
    `;
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
        <td class="px-4 py-4 align-top font-semibold text-slate-900">${escapeHtml(getMedicalRecordPetLabel(record))}</td>
        <td class="px-4 py-4 align-top text-slate-600">${escapeHtml(recordDate)}</td>
        <td class="px-4 py-4 align-top text-slate-700">${escapeHtml(weightDisplay)}</td>
        <td class="px-4 py-4 align-top text-slate-700">${escapeHtml(valueOrFallback(record.vaccination_status))}</td>
        <td class="max-w-xs break-words px-4 py-4 align-top text-slate-700">${escapeHtml(valueOrFallback(record.treatment))}</td>
        <td class="max-w-sm break-words px-4 py-4 align-top text-slate-700">${escapeHtml(valueOrFallback(record.medical_notes))}</td>
        <td class="px-4 py-4 align-top text-slate-700">${escapeHtml(`Recorded by: ${recordedBy}`)}</td>
      </tr>
    `;
  }).join('');

  recordsContainer.innerHTML = `
    <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
      <table class="min-w-full text-left text-sm">
        <thead class="border-b border-gray-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th class="px-4 py-3 font-semibold">Pet Name</th>
            <th class="px-4 py-3 font-semibold">Record Date</th>
            <th class="px-4 py-3 font-semibold">Weight</th>
            <th class="px-4 py-3 font-semibold">Vaccination Status</th>
            <th class="px-4 py-3 font-semibold">Treatment</th>
            <th class="px-4 py-3 font-semibold">Notes</th>
            <th class="px-4 py-3 font-semibold">Recorded By</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function getTopActiveUser() {
  const counts = {};

  if (adminDashboardData.appointments.length > 0) {
    adminDashboardData.appointments.forEach(apt => {
      const name = getUserNameById(apt.user_id).trim();
      if (name) counts[name] = (counts[name] || 0) + 1;
    });
  } else if (adminDashboardData.pets.length > 0) {
    adminDashboardData.pets.forEach(pet => {
      const owner = getUserNameById(pet.user_id).trim();
      if (owner) counts[owner] = (counts[owner] || 0) + 1;
    });
  }

  return getHighestLabel(counts);
}

function getMostRequestedService() {
  const counts = {};
  adminDashboardData.appointments.forEach(apt => {
    const service = (apt.service_type || '').trim();
    if (service) counts[service] = (counts[service] || 0) + 1;
  });
  return getHighestLabel(counts);
}

function getPeakBookingDay() {
  const counts = {};
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  adminDashboardData.appointments.forEach(apt => {
    if (!apt.appointment_date) return;
    const date = new Date(apt.appointment_date);
    if (Number.isNaN(date.getTime())) return;
    const day = dayNames[date.getDay()];
    counts[day] = (counts[day] || 0) + 1;
  });

  return getHighestLabel(counts);
}

function getHighestLabel(counts) {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
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
        await loadDashboardOverview();
      } finally {
        dashboardRefreshInProgress = false;
        updateButtonState(refreshButton, false, 'Refreshing...', 'Refresh');
      }
    });
  }

  const userSearchInput = document.getElementById('userSearchInput');
  const petSearchInput = document.getElementById('petSearchInput');
  const appointmentSearchInput = document.getElementById('appointmentSearchInput');
  const appointmentStatusFilter = document.getElementById('appointmentStatusFilter');
  const tabUsersButton = document.getElementById('tabUsers');
  const tabPetsButton = document.getElementById('tabPets');
  const tabAppointmentsButton = document.getElementById('tabAppointments');

  if (userSearchInput) userSearchInput.addEventListener('input', debounce(applyUserSearch, 180));
  if (petSearchInput) petSearchInput.addEventListener('input', debounce(applyPetSearch, 180));
  if (appointmentSearchInput) appointmentSearchInput.addEventListener('input', debounce(applyAppointmentSearchFilter, 180));
  if (appointmentStatusFilter) appointmentStatusFilter.addEventListener('change', applyAppointmentSearchFilter);

  if (tabUsersButton) tabUsersButton.addEventListener('click', () => switchAdminTab('users'));
  if (tabPetsButton) tabPetsButton.addEventListener('click', () => switchAdminTab('pets'));
  if (tabAppointmentsButton) tabAppointmentsButton.addEventListener('click', () => switchAdminTab('appointments'));

  switchAdminTab(getStoredAdminManagementTab(), getStoredAdminAppointmentStatusFilter());
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

function applyAppointmentSearchFilter() {
  const query = document.getElementById('appointmentSearchInput')?.value.trim().toLowerCase() || '';
  const status = document.getElementById('appointmentStatusFilter')?.value || 'all';
  setStoredAdminAppointmentStatusFilter(status);
  const filtered = adminDashboardData.appointments.filter(apt => {
    const petName = getAppointmentPetLabel(apt).toLowerCase();
    const service = (apt.service_type || '').toLowerCase();
    const appointmentDate = (apt.appointment_date || '').toLowerCase();
    const appointmentStatus = getAppointmentStatus(apt.status).toLowerCase();
    const matchesSearch = petName.includes(query) || service.includes(query) || appointmentDate.includes(query) || appointmentStatus.includes(query);
    const matchesStatus = status === 'all' || appointmentStatus === status.toLowerCase();
    return matchesSearch && matchesStatus;
  });
  displayAppointmentsTable(filtered);
}

function showManagementLoadingStates() {
  const usersTable = document.getElementById('usersTable');
  const petsTable = document.getElementById('petsTable');
  const appointmentsTable = document.getElementById('appointmentsTable');
  const medicalRecordsContainer = document.getElementById('recentMedicalRecordsContainer');
  const messagesTable = document.getElementById('contactMessagesTable');
  const logsContainer = document.getElementById('systemLogsContainer');

  if (usersTable) {
    usersTable.innerHTML = getAdminTableLoadingRow(5, 'users');
  }
  if (petsTable) {
    petsTable.innerHTML = getAdminTableLoadingRow(7, 'pets');
  }
  if (appointmentsTable) {
    appointmentsTable.innerHTML = getAdminTableLoadingRow(8, 'appointments');
  }
  if (medicalRecordsContainer) {
    medicalRecordsContainer.innerHTML = getDashboardSectionLoadingHtml('medical records', 2);
  }
  if (messagesTable) {
    messagesTable.innerHTML = getAdminTableLoadingRow(6, 'messages');
  }
  if (logsContainer) {
    logsContainer.innerHTML = getDashboardSectionLoadingHtml('activity logs', 2);
  }
}

function renderSystemLogs() {
  const logsContainer = document.getElementById('systemLogsContainer');
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
    logsContainer.innerHTML = `
      <div class="rounded-2xl border border-gray-200 bg-white p-6 text-center text-slate-500">
        <p class="font-semibold text-slate-700">No activity logs yet.</p>
        <p class="mt-1 text-sm text-slate-500">System actions will appear here after users or admins make changes.</p>
      </div>
    `;
    return;
  }

  const latestLogs = [...adminDashboardData.activityLogs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  logsContainer.innerHTML = latestLogs.map(log => {
    const action = log.action || (log.text ? String(log.text).split(' - ')[0] : '');
    const details = log.details || (log.text ? String(log.text).split(' - ').slice(1).join(' - ') : '');
    const detailsPart = details ? escapeHtml(details) : '';
    const icon = getActivityIcon(action);
    const message = log.display_text || formatActivityMessage(action, details);
    const metaItems = [];
    if (log.actor_name && !String(message).includes(log.actor_name)) {
      metaItems.push(`Actor: ${log.actor_name}`);
    }
    if (log.affected_user_name && log.affected_user_name !== log.actor_name && !String(message).includes(log.affected_user_name)) {
      metaItems.push(`User: ${log.affected_user_name}`);
    }
    const metaPart = metaItems.length ? escapeHtml(metaItems.join(' | ')) : '';
    const timestamp = log.created_at
      ? new Date(log.created_at).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : 'Time not recorded';

    return `
      <div class="flex items-start gap-4 rounded-xl bg-gray-50 p-4 border border-gray-100 hover:border-gray-200 transition-all">
        <div class="flex-shrink-0 rounded-lg bg-white p-3 border border-gray-100">
          <i class="${icon} text-xl"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-gray-900 font-medium">${escapeHtml(message)}</p>
          ${metaPart ? `<p class="text-sm text-slate-500 mt-1">${metaPart}</p>` : ''}
          ${detailsPart ? `<p class="text-sm text-gray-500 mt-1">${detailsPart}</p>` : ''}
          <p class="text-xs text-gray-400 mt-2">${timestamp}</p>
        </div>
      </div>
    `;
  }).join('');
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
  adminDashboardData.services = { labels: [], values: [] };
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

    displayAnalyticsSummary(adminDashboardData.summary);
    renderPetTypeChart(adminDashboardData.petTypes.labels, adminDashboardData.petTypes.values);
    renderServiceUsageChart(adminDashboardData.services.labels, adminDashboardData.services.values);
    renderAppointmentTrendChart(adminDashboardData.appointmentsTrend.labels, adminDashboardData.appointmentsTrend.values);
    displayAnalyticsInsights();
    displayAnalyticsExtras();
    displayMedicalRecordsSection(adminDashboardData.medicalRecords);
    renderCurrentAdminView();
    
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

    displayAnalyticsSummary(adminDashboardData.summary);
    renderPetTypeChart(adminDashboardData.petTypes.labels, adminDashboardData.petTypes.values);
    renderServiceUsageChart(adminDashboardData.services.labels, adminDashboardData.services.values);
    renderAppointmentTrendChart(adminDashboardData.appointmentsTrend.labels, adminDashboardData.appointmentsTrend.values);
    displayAnalyticsInsights();
    displayAnalyticsExtras();
    displayMedicalRecordsSection(adminDashboardData.medicalRecords);
    renderCurrentAdminView();
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
          labels: { color: '#4b5563' }
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
        x: { ticks: { color: '#6b7280' }, grid: { display: false } },
        y: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(229,231,235,0.8)' }, beginAtZero: true }
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
        x: { ticks: { color: '#6b7280' }, grid: { display: false } },
        y: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(229,231,235,0.8)' }, beginAtZero: true }
      }
    }
  });
}

function displayAnalyticsInsights() {
  const petTypeEl = document.getElementById('insightPetType');
  const serviceEl = document.getElementById('insightService');
  const bookingsEl = document.getElementById('insightBookings');
  const completionEl = document.getElementById('insightCompletion');

  if (adminDashboardData.overviewError) {
    if (petTypeEl) petTypeEl.textContent = 'Unavailable';
    if (serviceEl) serviceEl.textContent = 'Unavailable';
    if (bookingsEl) bookingsEl.textContent = 'Unavailable';
    if (completionEl) completionEl.textContent = 'Unavailable';
    return;
  }

  const petType = getTopLabel(adminDashboardData.petTypes);
  const service = getTopLabel(adminDashboardData.services);
  const summary = buildRealDashboardSummary(adminDashboardData.summary || {});
  const bookings = summary.upcomingBookings;
  const completion = summary.completedAppointmentPercentage;

  if (petTypeEl) petTypeEl.textContent = petType || 'No data';
  if (serviceEl) serviceEl.textContent = service || 'No data';
  if (bookingsEl) bookingsEl.textContent = bookings !== undefined && bookings !== null ? String(bookings) : 'No data';
  if (completionEl) completionEl.textContent = completion !== undefined && completion !== null ? `${completion}%` : 'No data';
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
      messageEl.innerHTML = `<div class="flex h-full items-center justify-center">${escapeHtml(message)}</div>`;
    }
  }
}

function escapeInlineHandlerValue(value) {
  return escapeHtml(String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n'));
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
    return `<span class="text-slate-700">${escapeHtml(formatRoleLabel(user?.role))}</span>`;
  }

  return `
    <select
      data-user-id="${escapeHtml(String(user.id))}"
      data-old-role="${escapeHtml(role)}"
      onchange="handleUserRoleChange(this)"
      class="w-full rounded-full border border-gray-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-orange-500 focus:outline-none dark-safe-select"
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
    usersTable.innerHTML = `
      <tr>
        <td colspan="5" class="px-4 py-8 text-center text-gray-500">
          <p class="font-semibold text-slate-700">${showMatchingMessage ? 'No matching users found.' : 'No user accounts found.'}</p>
          <p class="mt-1 text-sm text-slate-500">${showMatchingMessage ? 'Adjust the search term to review more accounts.' : 'Registered PetHub accounts will appear here after users sign up.'}</p>
        </td>
      </tr>
    `;
    return;
  }

  usersTable.innerHTML = users.map(user => {
    const verificationStatus = getUserVerificationStatus(user);
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3 text-sm text-gray-900">${escapeHtml(displayValue(user.fullname, 'Name not provided'))}</td>
        <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(displayValue(user.email, 'Email not provided'))}</td>
        <td class="px-4 py-3 text-sm">
          ${renderUserRoleCell(user)}
        </td>
        <td class="px-4 py-3 text-sm">
          <span class="admin-status-badge ${getUserVerificationBadgeClass(verificationStatus)}">
            ${escapeHtml(verificationStatus)}
          </span>
        </td>
        <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatTableDate(user.created_at))}</td>
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
    return 'Click again to confirm changing your own role to user.';
  }

  return 'Click again to confirm';
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
    petsTable.innerHTML = `
      <tr>
        <td colspan="7" class="px-4 py-8 text-center text-gray-500">
          <p class="font-semibold text-slate-700">${showMatchingMessage ? 'No matching pets found.' : 'No pet profiles found.'}</p>
          <p class="mt-1 text-sm text-slate-500">${showMatchingMessage ? 'Adjust the search term to review more pet profiles.' : 'User-created pet profiles will appear here once they are added.'}</p>
        </td>
      </tr>
    `;
    return;
  }

  petsTable.innerHTML = pets.map(pet => {
    const latestRecord = getLatestMedicalRecordText(pet);
    const latestRecordData = getLatestMedicalRecordForPet(pet?.id);
    const latestRecordDateRaw = latestRecordData?.record_date || latestRecordData?.created_at || '';
    const latestRecordDate = latestRecordDateRaw ? formatDate(latestRecordDateRaw) : '';
    return `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3 text-sm text-gray-900">${escapeHtml(displayValue(pet.name, 'Unnamed pet'))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(displayValue(pet.species))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(displayValue(pet.breed))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatPetAge(pet.age))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatOwnerLabel(pet))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">
        <p class="max-w-xs whitespace-normal break-words">${escapeHtml(latestRecord)}</p>
        ${latestRecordDate ? `<p class="mt-1 text-xs text-gray-500">${escapeHtml(latestRecordDate)}</p>` : ''}
      </td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatTableDate(pet.created_at))}</td>
    </tr>
  `;
  }).join('');
}

function getLatestMedicalRecordText(pet) {
  const latestRecord = getLatestMedicalRecordForPet(pet?.id);
  if (!latestRecord) return 'No medical records yet';

  if (hasRecordedValue(latestRecord.medical_notes)) return String(latestRecord.medical_notes);
  if (hasRecordedValue(latestRecord.treatment)) return `Treatment: ${latestRecord.treatment}`;
  if (hasRecordedValue(latestRecord.vaccination_status)) return `Vaccination: ${latestRecord.vaccination_status}`;
  return 'Medical record details not recorded';
}


/**
 * Display appointments table with action buttons
 */
function displayAppointmentsTable(appointments) {
  const appointmentsTable = document.getElementById('appointmentsTable');
  if (!appointmentsTable) return;

  const query = document.getElementById('appointmentSearchInput')?.value.trim();
  const statusFilter = document.getElementById('appointmentStatusFilter')?.value || 'all';
  const activeFilter = Boolean(query) || statusFilter !== 'all';
  const showMatchingMessage = activeFilter && (!appointments || appointments.length === 0);

  if (adminDashboardData.overviewError && (!appointments || appointments.length === 0)) {
    appointmentsTable.innerHTML = getAdminTableErrorRow(8, 'Unable to load appointments', 'appointments');
    return;
  }

  if (!appointments || appointments.length === 0) {
    appointmentsTable.innerHTML = `
      <tr>
        <td colspan="8" class="px-4 py-8 text-center text-gray-500">
          <p class="font-semibold text-slate-700">${showMatchingMessage ? 'No matching appointments found.' : 'No appointments found.'}</p>
          <p class="mt-1 text-sm text-slate-500">${showMatchingMessage ? 'Adjust the search or status filter to review more bookings.' : 'User bookings will appear here when appointments are submitted.'}</p>
        </td>
      </tr>
    `;
    return;
  }

  appointmentsTable.innerHTML = appointments.map(apt => {
    const handledBy = getHandledByLabel(apt);
    const status = getAppointmentStatus(apt.status);
    const actionButtons = renderAppointmentActions(status, apt);

    return `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3 text-sm text-gray-900">${escapeHtml(getAppointmentPetLabel(apt))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(displayValue(apt.service_type, 'N/A'))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(getAppointmentDurationLabel(apt))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatTableDate(apt.appointment_date, 'N/A'))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(getAppointmentTimeDisplay(apt))}</td>
      <td class="px-4 py-3 text-sm">
        <span class="${getStatusBadgeClass(status)}">
          ${escapeHtml(status)}
        </span>
      </td>
      <td class="px-4 py-3 text-sm text-gray-600">${handledBy ? escapeHtml(handledBy) : '<span class="text-slate-400">-</span>'}</td>
      <td class="px-4 py-3 text-sm">
        <div class="admin-medical-record-action-cell">${actionButtons}</div>
      </td>
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
  displayAnalyticsSummary(adminDashboardData.summary);
  displayAnalyticsExtras();
  displayMedicalRecordsSection(adminDashboardData.medicalRecords);

  if (currentAdminView === 'management') {
    applyUserSearch();
    applyPetSearch();
    applyAppointmentSearchFilter();
    return;
  }

  renderCurrentAdminView();
}

function isMedicalRecordAlreadyAddedError(error) {
  return /medical record has already been added/i.test(String(error?.message || error || ''));
}

function renderAppointmentActions(status, appointment) {
  const appointmentId = appointment?.id;
  if (!appointmentId) {
    return '<span class="text-xs text-gray-500">Action unavailable</span>';
  }

  const appointmentIdValue = escapeInlineHandlerValue(appointmentId);

  if (status === 'Pending') {
    return `
      <div class="flex flex-wrap gap-2">
        <button onclick="updateAppointmentStatus(this, '${appointmentIdValue}', 'Approved')" class="${getAdminActionButtonClass('success')}">Approve</button>
        <button onclick="updateAppointmentStatus(this, '${appointmentIdValue}', 'Cancelled')" class="${getAdminActionButtonClass('danger')}">Cancel</button>
      </div>
    `;
  }

  if (status === 'Approved') {
    return `
      <div class="flex flex-wrap gap-2">
        <button onclick="updateAppointmentStatus(this, '${appointmentIdValue}', 'Completed')" class="${getAdminActionButtonClass('success')}">Complete</button>
        <button onclick="updateAppointmentStatus(this, '${appointmentIdValue}', 'Cancelled')" class="${getAdminActionButtonClass('danger')}">Cancel</button>
      </div>
    `;
  }

  if (status === 'Completed' && appointmentHasMedicalRecord(appointment)) {
    return getMedicalRecordCompletedActionHtml();
  }

  if (status === 'Completed' && hasMedicalRecordCreateContext(appointment)) {
    return `
      <div class="flex flex-wrap gap-2">
        <button onclick="openMedicalRecordForm(this, '${appointmentIdValue}')" class="${getAdminActionButtonClass('success')}">Add Medical Record</button>
      </div>
    `;
  }

  return '<span class="text-xs text-gray-500">No action needed</span>';
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

function ensureMedicalRecordModal() {
  let modal = document.getElementById('adminMedicalRecordModal');
  if (modal) return modal;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="adminMedicalRecordModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-slate-950/40 px-4 py-6">
      <div class="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900">
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">Add Medical Record</h2>
            <p id="adminMedicalRecordContext" class="mt-1 text-sm text-slate-500 dark:text-slate-400"></p>
          </div>
          <button type="button" onclick="closeMedicalRecordForm()" class="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200" aria-label="Close medical record form">
            <i class="ri-close-line text-lg"></i>
          </button>
        </div>

        <form id="adminMedicalRecordForm" class="space-y-4">
          <p id="adminMedicalRecordError" class="hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"></p>

          <div>
            <label for="adminMedicalRecordPetId" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Pet</label>
            <select id="adminMedicalRecordPetId" name="pet_id" required class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-select">
              <option value="">Select pet</option>
            </select>
            <p id="adminMedicalRecordRequestedPet" class="mt-1 text-xs text-slate-500 dark:text-slate-400"></p>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label for="adminMedicalRecordWeight" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Weight</label>
              <input id="adminMedicalRecordWeight" name="weight" type="number" min="0" step="0.01" required class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-input">
            </div>
            <div>
              <label for="adminMedicalRecordVaccination" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Vaccination Status</label>
              <select id="adminMedicalRecordVaccination" name="vaccination_status" required class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-select">
                <option value="" disabled selected>Select status</option>
                <option value="Up to date">Up to date</option>
                <option value="Due soon">Due soon</option>
                <option value="Overdue">Overdue</option>
                <option value="Not applicable">Not applicable</option>
              </select>
            </div>
            <div>
              <label for="adminMedicalRecordDate" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Record Date</label>
              <input id="adminMedicalRecordDate" name="record_date" type="date" required class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-input">
            </div>
          </div>

          <div>
            <label for="adminMedicalRecordTreatment" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Treatment</label>
            <input id="adminMedicalRecordTreatment" name="treatment" type="text" required class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-input">
          </div>

          <div>
            <label for="adminMedicalRecordNotes" class="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">Medical Notes</label>
            <textarea id="adminMedicalRecordNotes" name="medical_notes" rows="4" required class="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none dark-safe-input"></textarea>
          </div>

          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onclick="closeMedicalRecordForm()" class="inline-flex items-center justify-center rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">Cancel</button>
            <button type="submit" class="inline-flex items-center justify-center rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600">Save Record</button>
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
    if (event.target === modal) {
      closeMedicalRecordForm();
    }
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
    formatTableDate(appointment?.appointment_date, 'Date not set')
  ];
  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

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
    displaySidebarStats(adminDashboardData.summary);
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
    <tr class="hover:bg-gray-50 align-top">
      <td class="px-4 py-3 text-sm text-gray-900">${escapeHtml(displayValue(msg.fullname, 'Name not provided'))}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(displayValue(msg.email, 'Email not provided'))}</td>
      <td class="px-4 py-3 text-sm text-gray-700 break-words max-w-xl">${escapeHtml(displayValue(msg.message, 'No message text'))}</td>
      <td class="px-4 py-3 text-sm">
        <span class="${getContactStatusBadgeClass(status)}">
          ${escapeHtml(status)}
        </span>
      </td>
      <td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(formatTableDate(msg.created_at, 'Date not recorded'))}</td>
      <td class="px-4 py-3 text-sm">
        ${renderContactMessageActions(status, msg.id)}
      </td>
    </tr>
  `;
  }).join('');
}

function getContactMessagesEmptyState() {
  return `
    <tr>
      <td colspan="6" class="px-4 py-8 text-center text-gray-500">
        <p class="font-semibold text-slate-700">No contact messages yet.</p>
        <p class="mt-1 text-sm text-slate-500">Public contact form submissions will appear here for admin review.</p>
      </td>
    </tr>
  `;
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
    return '<span class="text-xs text-gray-500">Action unavailable</span>';
  }

  const messageIdValue = escapeInlineHandlerValue(messageId);

  return `
    <div class="flex flex-wrap gap-2">
      <button onclick="toggleContactMessageStatus(this, '${messageIdValue}', '${CONTACT_MESSAGE_READ_STATUS}')" class="${getAdminActionButtonClass('neutral')}">
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

/**
 * Get CSS class for status badge
 */
function getStatusBadgeClass(status) {
  const classes = {
    'Pending': 'admin-status-badge admin-status-warning',
    'Approved': 'admin-status-badge admin-status-info',
    'Completed': 'admin-status-badge admin-status-success',
    'Cancelled': 'admin-status-badge admin-status-danger'
  };
  return classes[status] || 'admin-status-badge admin-status-neutral';
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
 * Update appointment status (required for appointment action buttons in dashboard)
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
