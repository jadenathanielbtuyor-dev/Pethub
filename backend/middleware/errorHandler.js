const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.failedRequest(req, {
    statusCode,
    error: message
  });

  // Internal details stay in the server log; the reply only says what the client can act on
  if (err.type === 'entity.parse.failed') {
    return apiResponse.error(res, 'The request body must be valid JSON.', 400);
  }
  if (statusCode >= 500) {
    return apiResponse.error(res, 'Internal Server Error', statusCode);
  }
  // A missing static file (e.g. a deployment without the frontend folder) must not reveal server paths
  if (err.code === 'ENOENT') {
    return apiResponse.error(res, 'Not found', 404);
  }

  return apiResponse.error(res, message, statusCode);
}

module.exports = errorHandler;
