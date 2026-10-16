// ==================== GLOBAL API CONFIGURATION ====================
// This file provides a single global API base URL to prevent conflicts
// All modules must use window.API_BASE_URL instead of declaring their own constants

// ALWAYS use https://pethub-production-f14d.up.railway.app for the backend API
// Backend CORS accepts pages served from the Vercel site, the backend itself, or a localhost URL
// (e.g. http://localhost:5500). Pages opened via 127.0.0.1 or directly from file:// are rejected.
const API_BASE_URL = 'https://pethub-production-f14d.up.railway.app';
window.API_BASE_URL = API_BASE_URL;

// Every PetHub API request carries the signed session token issued at login (sessionStorage 'authToken',
// managed in core/storage.js). A 401 means the session is missing or expired, so the user signs in again.
(function attachPetHubAuth() {
  const originalFetch = window.fetch.bind(window);

  function handleRejectedSession() {
    if (window.__pethubSessionRejected) return;
    window.__pethubSessionRejected = true;
    try {
      sessionStorage.removeItem('user');
      sessionStorage.removeItem('authToken');
    } catch (error) {
      // Storage unavailable; the redirect below still ends the session view.
    }
    if (typeof redirectToLogin === 'function') redirectToLogin();
  }

  window.fetch = function petHubFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input?.url || input || '');
    if (!url.startsWith(window.API_BASE_URL)) {
      return originalFetch(input, init);
    }

    let token = '';
    try {
      token = sessionStorage.getItem('authToken') || '';
    } catch (error) {
      token = '';
    }

    const options = { ...init };
    if (token) {
      const headers = new Headers(init.headers || {});
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      options.headers = headers;
    }

    return originalFetch(input, options).then(response => {
      const path = url.slice(window.API_BASE_URL.length);
      if (response.status === 401 && !/^\/auth\/(login|logout)\b/.test(path)) {
        handleRejectedSession();
      }
      return response;
    });
  };
})();
