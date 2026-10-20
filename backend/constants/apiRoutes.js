const API_PREFIXES = Object.freeze([
  '/auth',
  '/pets',
  '/appointments',
  '/ai',
  '/admin',
  '/contact'
]);

// APIs that were removed from PetHub (online deposit payments). Requests to them still get the JSON
// "API endpoint not found" 404 (middleware/apiNotFoundHandler.js) instead of the frontend page.
const RETIRED_API_PREFIXES = Object.freeze([
  '/payments'
]);

module.exports = {
  API_PREFIXES,
  RETIRED_API_PREFIXES
};
