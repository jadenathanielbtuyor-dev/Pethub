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

  return apiResponse.error(res, message, statusCode);
}

module.exports = errorHandler;
