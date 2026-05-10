// PetHub Main UI Logic

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

function initializeApp() {
  initializeDarkMode();
  
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
  const darkModeToggle = document.getElementById('darkModeToggle');
  
  // Apply saved preference
  if (isDarkMode()) {
    applyDarkMode();
  }
  
  if (darkModeToggle) {
    darkModeToggle.addEventListener('click', toggleDarkMode);
  }
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
  const btn = document.getElementById('darkModeToggle');
  if (btn) {
    btn.innerHTML = isDarkMode() 
      ? '<i class="ri-sun-line"></i>' 
      : '<i class="ri-moon-line"></i>';
  }
}

// Navigation Updates
function updateNavigationState() {
  const navLinks = document.querySelector('.nav-links');
  if (!navLinks) return;
  
  const user = getUser();
  
  if (user && isLoggedIn()) {
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
