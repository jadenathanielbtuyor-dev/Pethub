// PetHub Local Storage Management
// STANDARD: Use ONLY 'user' for all authentication

// User Management
// Using sessionStorage for auth - clears when browser closes
function setUser(userData) {
  if (!userData) {
    sessionStorage.removeItem('user');
    return;
  }
  // Ensure id is always stored as a string
  const normalizedUser = {
    ...userData,
    id: String(userData.id || '0')
  };
  sessionStorage.setItem('user', JSON.stringify(normalizedUser));
}

function getUser() {
  const user = sessionStorage.getItem('user');
  if (!user) return null;
  try {
    const parsed = JSON.parse(user);
    // Ensure id is always a string
    if (parsed && parsed.id) {
      parsed.id = String(parsed.id);
    }
    return parsed;
  } catch (e) {
    console.error('Error parsing user data:', e);
    return null;
  }
}

function isLoggedIn() {
  return !!sessionStorage.getItem('user');
}

function getSiteRoot() {
  const pathname = window.location.pathname;
  const baseMatch = pathname.match(/^(.*?)(?:\/pages\/.*|\/index\.html)?$/);
  const basePath = baseMatch ? baseMatch[1] : '/';
  return `${window.location.origin}${basePath}`.replace(/\/+$|\/$/, '');
}

function getPath(relativePath) {
  const path = relativePath.replace(/^\/+/, '');
  return `${getSiteRoot()}/${path}`;
}

// Centralized path constants to avoid stale hardcoded strings
const PATHS = {
  login: getPath('pages/auth/login.html'),
  register: getPath('pages/auth/register.html'),
  verifyEmail: getPath('pages/auth/verify-email.html'),
  userDashboard: getPath('pages/user/dashboard.html'),
  adminDashboard: getPath('pages/admin/dashboard.html'),
  index: getPath('index.html')
};

// Redirect helpers
function redirectToLogin() {
  window.location.replace(PATHS.login);
}

function redirectToDashboardForRole(role) {
  const normalizedRole = String(role || 'user').toLowerCase();
  if (normalizedRole === 'admin') {
    window.location.replace(PATHS.adminDashboard);
  } else {
    window.location.replace(PATHS.userDashboard);
  }
}

async function logout() {
  if (window.__pethubLogoutInProgress) return;
  window.__pethubLogoutInProgress = true;

  const user = getUser();

  try {
    if (user?.id && window.API_BASE_URL && typeof fetch === 'function') {
      const response = await fetch(`${window.API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.warn('Logout endpoint returned an error:', data.error || response.statusText);
      }
    }
  } catch (error) {
    console.warn('Logout request failed; clearing local session:', error);
  } finally {
    sessionStorage.removeItem('user');
    window.location.replace(PATHS.login);
  }
}

function isVerified() {
  const user = getUser();
  if (!user || user.is_verified == null) return false;
  return user.is_verified === true || user.is_verified === 'true' || user.is_verified === 1 || user.is_verified === '1';
}

function redirectIfNotVerified() {
  if (isLoggedIn() && !isVerified()) {
    console.warn('User is not verified. Redirecting to login.');
    redirectToLogin();
  }
}

// Dark Mode
function isDarkMode() {
  return localStorage.getItem('darkMode') === 'true';
}

function setDarkMode(enabled) {
  localStorage.setItem('darkMode', enabled ? 'true' : 'false');
}
