// Shared PetHub admin sidebar renderer
// This file creates a consistent admin sidebar for dashboard and management pages.

document.addEventListener('DOMContentLoaded', () => {
  if (window.__pethubAdminSidebarInitialized) return;
  window.__pethubAdminSidebarInitialized = true;

  // Initialize sidebar
  renderAdminSidebar();
  setupSidebarToggle();
  
  // Call main.js functions if available
  if (getCurrentAdminPage() !== 'dashboard.html' && typeof highlightSidebarLinks === 'function') {
    highlightSidebarLinks();
  }
  if (getCurrentAdminPage() !== 'dashboard.html' && typeof setupDashboardSectionLinks === 'function') {
    setupDashboardSectionLinks();
  }
});

/**
 * Setup sidebar toggle functionality for mobile
 */
function setupSidebarToggle() {
  const sidebarToggles = Array.from(new Set(document.querySelectorAll('#sidebarToggle, [data-admin-sidebar-toggle]')));
  const adminSidebarToggle = document.getElementById('adminSidebarToggle');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const adminSidebarRoot = document.getElementById('adminSidebarRoot');
  const adminSidebar = document.getElementById('adminSidebar');
  const isDashboardPage = getCurrentAdminPage() === 'dashboard.html';
  const desktopCollapsedStorageKey = 'adminSidebarCollapsed';
  const desktopMediaQuery = window.matchMedia('(min-width: 768px)');
  let isDesktopSidebarCollapsed = false;

  if (!adminSidebar) {
    return;
  }

  const isMobileSidebar = () => !desktopMediaQuery.matches;

  const setMobileToggleState = (isOpen) => {
    sidebarToggles.forEach((toggle) => {
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.classList.toggle('is-open', isOpen);
    });
  };

  const setSidebarOpen = (isOpen) => {
    const shouldOpen = Boolean(isOpen) && isMobileSidebar();

    adminSidebar.classList.toggle('is-open', shouldOpen);
    adminSidebar.setAttribute('aria-hidden', isMobileSidebar() ? String(!shouldOpen) : 'false');
    document.body.classList.toggle('admin-sidebar-open', shouldOpen);
    if (sidebarBackdrop) {
      sidebarBackdrop.classList.toggle('hidden', !shouldOpen);
      sidebarBackdrop.hidden = !shouldOpen;
      sidebarBackdrop.setAttribute('aria-hidden', String(!shouldOpen));
    }
    setMobileToggleState(shouldOpen);

    if (isMobileSidebar() && adminSidebarToggle) {
      adminSidebarToggle.setAttribute('aria-expanded', String(shouldOpen));
      adminSidebarToggle.setAttribute('aria-label', 'Close sidebar');
    }
  };

  const openSidebar = (e) => {
    e?.preventDefault?.();
    setSidebarOpen(true);
  };

  const closeSidebar = (e) => {
    e?.preventDefault?.();
    setSidebarOpen(false);
  };

  const getSavedDesktopCollapsed = () => {
    try {
      return localStorage.getItem(desktopCollapsedStorageKey) === 'true';
    } catch (error) {
      return false;
    }
  };

  const saveDesktopCollapsed = (isCollapsed) => {
    try {
      localStorage.setItem(desktopCollapsedStorageKey, String(isCollapsed));
    } catch (error) {
      // Ignore localStorage failures so the toggle still works for this session.
    }
  };

  const resetDesktopCollapseStyles = (clearTransition = true) => {
    document.body.classList.remove('admin-sidebar-collapsed');
    adminSidebar.style.transform = '';
    adminSidebar.style.boxShadow = '';
    adminSidebar.style.width = '';
    adminSidebar.style.overflowX = '';
    if (clearTransition) {
      adminSidebar.style.transition = '';
    }

    adminSidebar
      .querySelectorAll('.admin-nav-link span, .admin-sidebar-label, .admin-sidebar-stats, .admin-sidebar-header .flex-1')
      .forEach((element) => element.classList.remove('hidden'));

    if (adminSidebarRoot) {
      adminSidebarRoot.style.width = '';
      adminSidebarRoot.style.minWidth = '';
      adminSidebarRoot.style.flex = '';
      if (clearTransition) {
        adminSidebarRoot.style.transition = '';
      }
    }
  };

  const applyDesktopCollapsedState = (isCollapsed, shouldSave = true) => {
    isDesktopSidebarCollapsed = isCollapsed;
    document.body.classList.toggle('admin-sidebar-collapsed', isCollapsed && desktopMediaQuery.matches);

    if (shouldSave) {
      saveDesktopCollapsed(isCollapsed);
    }

    if (isMobileSidebar()) {
      resetDesktopCollapseStyles();
      setSidebarOpen(false);
      if (adminSidebarToggle) {
        adminSidebarToggle.setAttribute('aria-label', 'Close sidebar');
      }
      return;
    }

    setSidebarOpen(false);

    if (adminSidebarRoot) {
      adminSidebarRoot.style.transition = 'width 0.25s ease, min-width 0.25s ease, flex-basis 0.25s ease';
    }
    adminSidebar.style.transition = 'width 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease';

    if (isCollapsed) {
      adminSidebar.style.transform = '';
      adminSidebar.style.boxShadow = 'none';
      adminSidebar.style.width = '5.5rem';
      adminSidebar.style.overflowX = 'hidden';
      adminSidebar
        .querySelectorAll('.admin-nav-link span, .admin-sidebar-label, .admin-sidebar-stats, .admin-sidebar-header .flex-1')
        .forEach((element) => element.classList.add('hidden'));
      if (adminSidebarRoot) {
        adminSidebarRoot.style.width = '5.5rem';
        adminSidebarRoot.style.minWidth = '5.5rem';
        adminSidebarRoot.style.flex = '0 0 5.5rem';
      }
    } else {
      resetDesktopCollapseStyles(false);
    }

    if (adminSidebarToggle) {
      adminSidebarToggle.setAttribute('aria-expanded', String(!isCollapsed));
      adminSidebarToggle.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    }
  };

  const toggleAdminSidebar = (e) => {
    e?.preventDefault?.();

    if (isMobileSidebar()) {
      closeSidebar();
      return;
    }

    applyDesktopCollapsedState(!isDesktopSidebarCollapsed);
  };

  const markSidebarLinkActivating = (link) => {
    link.classList.add('is-activating');
    link.setAttribute('aria-busy', 'true');
    window.setTimeout(() => {
      link.classList.remove('is-activating');
      link.removeAttribute('aria-busy');
    }, 220);
  };

  // Attach event listeners safely
  sidebarToggles.forEach((toggle) => {
    toggle.addEventListener('click', openSidebar);
  });
  if (adminSidebarToggle) {
    adminSidebarToggle.addEventListener('click', toggleAdminSidebar);
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', closeSidebar);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMobileSidebar() && adminSidebar.classList.contains('is-open')) {
      closeSidebar(event);
    }
  });

  window.closeAdminMobileSidebar = () => setSidebarOpen(false);

  applyDesktopCollapsedState(getSavedDesktopCollapsed(), false);
  const handleDesktopBreakpointChange = () => {
    applyDesktopCollapsedState(getSavedDesktopCollapsed(), false);
  };

  if (typeof desktopMediaQuery.addEventListener === 'function') {
    desktopMediaQuery.addEventListener('change', handleDesktopBreakpointChange);
  } else if (typeof desktopMediaQuery.addListener === 'function') {
    desktopMediaQuery.addListener(handleDesktopBreakpointChange);
  }

  const sidebarLinks = adminSidebar.querySelectorAll('a[data-admin-view]');
  sidebarLinks.forEach(link => {
    link.addEventListener('click', (event) => {
      markSidebarLinkActivating(link);
      const targetView = link.dataset.adminView;
      const shouldCloseMobileSidebar = isMobileSidebar();
      if (shouldCloseMobileSidebar) {
        closeSidebar();
      }

      if (isDashboardPage && isDashboardAdminView(targetView)) {
        event.preventDefault();
        if (typeof window.showAdminView === 'function') {
          window.showAdminView(targetView);
        } else {
          window.location.hash = targetView;
        }
      }
    });
  });
}

/**
 * Render admin sidebar with navigation
 */
function renderAdminSidebar() {
  const root = document.getElementById('adminSidebarRoot');
  if (!root) {
    return;
  }

  const currentPage = getCurrentAdminPage();
  const isDashboardPage = currentPage === 'dashboard.html';
  const currentView = getSidebarAdminView();

  const mainNavItems = isDashboardPage
    ? [{ href: 'dashboard.html', icon: 'ri-dashboard-line', label: 'Dashboard', view: 'overview' }]
    : [{ href: 'dashboard.html', icon: 'ri-dashboard-line', label: 'Dashboard', view: 'dashboard' }];

  const managementItems = isDashboardPage
    ? [
        { href: 'dashboard.html#dashboardOverview', icon: 'ri-layout-grid-line', label: 'Overview', view: 'overview' },
        { href: 'dashboard.html#analyticsSummary', icon: 'ri-bar-chart-2-line', label: 'Analytics', view: 'analytics' },
        { href: 'dashboard.html#managementPanel', icon: 'ri-settings-4-line', label: 'Management', view: 'management' },
        { href: 'dashboard.html#medicalRecordsSection', icon: 'ri-file-medical-line', label: 'Medical Records', view: 'medicalRecords' }
      ]
    : [
        { href: 'dashboard.html', icon: 'ri-layout-grid-line', label: 'Dashboard', view: 'dashboard' },
        { href: 'users.html', icon: 'ri-team-line', label: 'Users', view: 'users' },
        { href: 'pets.html', icon: 'ri-paw-line', label: 'Pets', view: 'pets' },
        { href: 'appointments.html', icon: 'ri-calendar-event-line', label: 'Appointments', view: 'appointments' },
        { href: 'dashboard.html#medicalRecordsSection', icon: 'ri-file-medical-line', label: 'Medical Records', view: 'medicalRecords' }
      ];

  const systemItems = [
    { href: 'dashboard.html#messages', icon: 'ri-mail-line', label: 'Messages', view: 'messages' },
    { href: 'dashboard.html#activityLogs', icon: 'ri-history-line', label: 'Activity Logs', view: 'activityLogs' }
  ];

  const sidebarHTML = `
    <aside id="adminSidebar" class="admin-sidebar" aria-label="Admin sidebar">
      <div class="admin-sidebar-header">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-3">
              <div class="admin-sidebar-brand-icon">
                <i class="ri-shield-star-line text-lg"></i>
              </div>
              <div>
                <p class="text-xs font-bold uppercase tracking-widest text-orange-600">Admin</p>
                <p class="text-xs text-slate-500">Control Center</p>
              </div>
            </div>
          </div>
          <button id="adminSidebarToggle" class="admin-sidebar-close" aria-label="Collapse sidebar" aria-expanded="true">
            <i class="ri-close-line text-lg"></i>
          </button>
        </div>
      </div>

      <nav class="admin-sidebar-nav">
        <p class="admin-sidebar-label">MAIN</p>
        ${mainNavItems.map(item => createSidebarLink(item, currentView)).join('')}
      </nav>

      <nav class="admin-sidebar-nav">
        <p class="admin-sidebar-label">MANAGEMENT</p>
        ${managementItems.map(item => createSidebarLink(item, currentView)).join('')}
      </nav>

      <nav class="admin-sidebar-nav">
        <p class="admin-sidebar-label">SYSTEM</p>
        ${systemItems.map(item => createSidebarLink(item, currentView)).join('')}
      </nav>

      <div class="admin-sidebar-stats">
        <p class="admin-sidebar-label">QUICK STATS</p>
        <div class="admin-sidebar-stats-list">
          <div class="admin-sidebar-stat">
            <span>Total Users</span>
            <span id="sidebarTotalUsers" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
          <div class="admin-sidebar-stat">
            <span>Registered Pets</span>
            <span id="sidebarTotalPets" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
          <div class="admin-sidebar-stat">
            <span>Pending Appointments</span>
            <span id="sidebarPendingAppointments" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
          <div class="admin-sidebar-stat">
            <span>Contact Messages</span>
            <span id="sidebarContactMessages" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
          <div class="admin-sidebar-stat">
            <span>Verified Users</span>
            <span id="sidebarVerifiedUsers" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
          <div class="admin-sidebar-stat">
            <span>Medical Records</span>
            <span id="sidebarMedicalRecords" class="admin-sidebar-stat-value">${getAdminSidebarLoadingHtml()}</span>
          </div>
        </div>
      </div>
    </aside>

    <div id="sidebarBackdrop" class="admin-sidebar-backdrop hidden md:hidden" hidden aria-hidden="true"></div>
  `;

  root.innerHTML = sidebarHTML;
}

function getAdminSidebarLoadingHtml() {
  return `
    <span class="dashboard-inline-loading" role="status" aria-live="polite">
      <span class="dashboard-inline-spinner" aria-hidden="true"></span>
      <span>Loading</span>
    </span>
  `;
}

/**
 * Get current admin page name
 */
function getCurrentAdminPage() {
  const path = window.location.pathname.split('/').pop();
  return path || 'dashboard.html';
}

function isDashboardAdminView(viewName) {
  return ['overview', 'analytics', 'management', 'medicalRecords', 'activityLogs', 'messages'].includes(viewName);
}

function getSidebarAdminView() {
  const currentPage = getCurrentAdminPage();
  const currentHash = window.location.hash;

  if (currentPage === 'dashboard.html') {
    if (currentHash.includes('messages')) return 'messages';
    if (currentHash.includes('analytics') || currentHash.includes('analyticsSummary')) return 'analytics';
    if (currentHash.includes('management')) return 'management';
    if (currentHash.includes('medicalRecords') || currentHash.includes('medicalRecordsSection')) return 'medicalRecords';
    if (currentHash.includes('activityLogs') || currentHash.includes('systemLogs')) return 'activityLogs';
    return 'overview';
  }
  if (currentPage === 'users.html') return 'users';
  if (currentPage === 'pets.html') return 'pets';
  if (currentPage === 'appointments.html') return 'appointments';

  return 'dashboard';
}

/**
 * Create sidebar navigation link
 */
function createSidebarLink(item, currentView) {
  const isDashboardView = isDashboardAdminView(item.view) && getCurrentAdminPage() === 'dashboard.html';
  const isActive = item.view === currentView;
  const activeClass = isActive ? ' is-active' : '';
  const baseClass = 'admin-nav-link';
  const dataAttribute = item.view ? `data-admin-view="${item.view}"` : '';
  const hrefValue = isDashboardView ? `#${item.view}` : item.href;
  const ariaCurrent = isActive ? 'aria-current="page"' : '';

  return `
    <a href="${hrefValue}" ${dataAttribute} ${ariaCurrent} class="${baseClass}${activeClass}">
      <i class="${item.icon}"></i>
      <span class="truncate">${item.label}</span>
    </a>
  `;
}

