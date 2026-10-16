const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { API_PREFIXES } = require('../constants/apiRoutes');

function apiNotFoundHandler(req, res, next) {
  if (API_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
    logger.failedRequest(req, {
      statusCode: 404,
      error: 'API endpoint not found'
    });
    return apiResponse.error(res, 'API endpoint not found', 404);
  }

  next();
}

module.exports = apiNotFoundHandler;
