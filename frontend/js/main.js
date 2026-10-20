// PetHub Main UI Logic

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

function initializeApp() {
  initializeDarkMode();

  setupSiteNavigation();
  updateNavigationState();
  setupLogoutHandlers();

  const isAdminDashboard = document.body.classList.contains('admin-dashboard-page');
  if (!isAdminDashboard) {
    highlightSidebarLinks();
    setupDashboardSectionLinks();
    window.addEventListener('hashchange', highlightSidebarLinks);
  }
}

// Dark Mode
function initializeDarkMode() {
  const darkModeToggle = getDarkModeToggle();
  
  // Apply only the saved preference on page load.
  if (isDarkMode()) {
    applyDarkMode();
  } else {
    removeDarkMode();
  }
  
  if (darkModeToggle) {
    darkModeToggle.addEventListener('click', toggleDarkMode);
  }
}

function getDarkModeToggle() {
  const toggles = Array.from(document.querySelectorAll('#darkModeToggle'));
  if (!toggles.length) return null;

  const isAdminPage = document.body.classList.contains('admin-dashboard-page') || document.getElementById('adminSidebarRoot');
  if (!isAdminPage) return toggles[0];

  const isOldHiddenToggle = (toggle) => (
    toggle.classList.contains('hidden') ||
    toggle.getAttribute('aria-hidden') === 'true' ||
    toggle.getAttribute('tabindex') === '-1'
  );
  const validToggle = toggles.find(toggle => !isOldHiddenToggle(toggle)) || toggles[0];

  toggles.forEach(toggle => {
    if (toggle !== validToggle) {
      toggle.remove();
    }
  });

  validToggle.type = 'button';
  validToggle.className = 'dark-mode-toggle';
  validToggle.title = 'Toggle Dark Mode';
  validToggle.removeAttribute('aria-hidden');
  validToggle.removeAttribute('tabindex');

  return validToggle;
}

function toggleDarkMode() {
  if (isDarkMode()) {
    removeDarkMode();
  } else {
    applyDarkMode();
  }
}

function applyDarkMode() {
  document.body.classList.add('dark-mode');
  document.documentElement.classList.add('dark');
  setDarkMode(true);
  updateDarkModeIcon();
}

function removeDarkMode() {
  document.body.classList.remove('dark-mode');
  document.documentElement.classList.remove('dark');
  setDarkMode(false);
  updateDarkModeIcon();
}

function updateDarkModeIcon() {
  const btn = getDarkModeToggle();
  if (btn) {
    btn.innerHTML = isDarkMode() 
      ? '<i class="ri-sun-line" aria-hidden="true"></i>' 
      : '<i class="ri-moon-line" aria-hidden="true"></i>';
    // The button's title is its name once the icon is hidden; also expose whether dark mode is on
    btn.setAttribute('aria-pressed', String(isDarkMode()));
  }
}

// Public and sign-in pages (header .ph-nav): below 768px the links sit in a menu that the button opens and closes.
// Escape, choosing a link, clicking outside the header or moving keyboard focus out of it closes the menu.
function setupSiteNavigation() {
  document.querySelectorAll('[data-nav-toggle]').forEach(toggle => {
    const nav = toggle.closest('.ph-nav');
    const menu = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!nav || !menu || toggle.dataset.ready === 'true') return;
    toggle.dataset.ready = 'true';
    nav.classList.add('is-enhanced');

    const icon = toggle.querySelector('i');
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const setOpen = open => {
      menu.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (icon) icon.className = open ? 'ri-close-line' : 'ri-menu-line';
    };

    toggle.addEventListener('click', () => setOpen(!isOpen()));
    menu.addEventListener('click', event => {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener('click', event => {
      if (isOpen() && !nav.contains(event.target)) setOpen(false);
    });
    nav.addEventListener('focusout', event => {
      if (isOpen() && event.relatedTarget && !nav.contains(event.relatedTarget)) setOpen(false);
    });

    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    if (desktop.addEventListener) desktop.addEventListener('change', closeOnDesktop);
    else if (desktop.addListener) desktop.addListener(closeOnDesktop);
  });
}

// Navigation Updates
function updateNavigationState() {
  const user = getUser();
  const signedIn = Boolean(user && isLoggedIn());

  // Header .ph-nav: when signed in, "Log in" becomes "My dashboard" with a "Log out" link beside it, and customers'
  // booking links go straight to the booking page (keeping the service a Services page link names)
  if (signedIn) {
    const isAdmin = String(user.role || '').toLowerCase() === 'admin';
    document.querySelectorAll('[data-auth-link]').forEach(link => {
      link.textContent = 'My dashboard';
      link.href = isAdmin ? PATHS.adminDashboard : PATHS.userDashboard;
      if (!link.parentElement.querySelector('[data-logout-link]')) {
        const logoutLink = document.createElement('a');
        logoutLink.href = '#logout';
        logoutLink.className = 'ph-nav-login';
        logoutLink.dataset.logoutLink = 'true';
        logoutLink.textContent = 'Log out';
        link.insertAdjacentElement('afterend', logoutLink);
      }
    });
    if (!isAdmin) {
      document.querySelectorAll('a[data-book-link]').forEach(link => {
        const service = new URL(link.href, window.location.href).searchParams.get('service');
        link.href = service ? `${PATHS.userAppointments}?service=${encodeURIComponent(service)}` : PATHS.userAppointments;
      });
    }
  }

  // Older header markup (.nav-links): the Login link becomes Logout
  const navLinks = document.querySelector('.nav-links');
  if (!navLinks) return;

  if (signedIn) {
    // User is logged in - show Logout button
    const loginLink = navLinks.querySelector('.btn-login') || navLinks.querySelector('a[href*="login"]');
    
    if (loginLink) {
      loginLink.textContent = 'Logout';
      loginLink.href = '#logout';
      loginLink.className = 'btn-logout';
    }
  }
}

function getMainAdminView() {
  const currentPath = window.location.pathname.split('/').pop();
  const currentHash = window.location.hash;

  if (currentPath === 'dashboard.html') {
    if (currentHash.includes('messages')) return 'messages';
    if (currentHash.includes('analytics') || currentHash.includes('analyticsSummary')) return 'analytics';
    if (currentHash.includes('management')) return 'management';
    if (currentHash.includes('medicalRecords') || currentHash.includes('medicalRecordsSection')) return 'medicalRecords';
    if (currentHash.includes('activityLogs') || currentHash.includes('systemLogs')) return 'activityLogs';
    return 'overview';
  }
  if (currentPath === 'users.html') return 'users';
  if (currentPath === 'pets.html') return 'pets';
  if (currentPath === 'appointments.html') return 'appointments';
  return 'dashboard';
}

function highlightSidebarLinks() {
  const sidebarLinks = document.querySelectorAll('aside nav a[data-admin-view]');
  if (!sidebarLinks.length) return;

  const activeView = getMainAdminView();

  sidebarLinks.forEach(link => {
    const linkView = link.dataset.adminView;
    if (linkView === activeView) {
      link.classList.add('is-active');
      link.classList.add('bg-orange-500', 'text-white', 'shadow-sm');
      link.classList.remove('text-slate-600', 'hover:bg-orange-50', 'hover:text-orange-600');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('is-active');
      link.classList.remove('bg-orange-500', 'text-white', 'shadow-sm');
      link.classList.add('text-slate-600', 'hover:bg-orange-50', 'hover:text-orange-600');
      link.removeAttribute('aria-current');
    }
  });
}

function setupDashboardSectionLinks() {
  const currentPage = window.location.pathname.split('/').pop();
  const dashboardSectionLinks = Array.from(document.querySelectorAll('aside nav a'))
    .filter(link => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) return true;
      const [linkPath, linkHash] = href.split('#');
      return linkHash && linkPath.split('/').pop() === currentPage;
    });

  if (!dashboardSectionLinks.length) return;

  dashboardSectionLinks.forEach(link => {
    if (link.dataset.adminView) return;

    link.addEventListener('click', event => {
      const targetId = link.hash.slice(1);
      const target = document.getElementById(targetId);
      if (!target) return;

      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#${targetId}`);
      highlightSidebarLinks();
    });
  });
}

// Logout Handling
function setupLogoutHandlers() {
  if (window.__pethubLogoutHandlerInitialized) return;
  window.__pethubLogoutHandlerInitialized = true;

  document.addEventListener('click', (e) => {
    const target = e.target.closest('.btn-logout, a[href="#logout"]');
    if (target) {
      e.preventDefault();
      logout();
    }
  });
}
