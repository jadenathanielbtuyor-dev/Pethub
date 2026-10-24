const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { API_PREFIXES, RETIRED_API_PREFIXES } = require('../constants/apiRoutes');

const NOT_FOUND_PREFIXES = Object.freeze([...API_PREFIXES, ...RETIRED_API_PREFIXES]);

function apiNotFoundHandler(req, res, next) {
  // Whole path segments only: /admin and /admin/... are API paths, the /admin-dashboard.html page is not
  if (NOT_FOUND_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
    logger.failedRequest(req, {
      statusCode: 404,
      error: 'API endpoint not found'
    });
    return apiResponse.error(res, 'API endpoint not found', 404);
  }

  next();
}

module.exports = apiNotFoundHandler;
