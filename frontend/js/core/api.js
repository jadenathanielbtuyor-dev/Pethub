// ==================== GLOBAL API CONFIGURATION ====================
// This file provides a single global API base URL to prevent conflicts
// All modules must use window.API_BASE_URL instead of declaring their own constants

// ALWAYS use https://pethub-production-f14d.up.railway.app for the backend API
// Works for: direct file access, Live Server, localhost, any dev server
const API_BASE_URL = 'https://pethub-production-f14d.up.railway.app';
window.API_BASE_URL = API_BASE_URL;
