const apiResponse = require('./apiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('./logger');

function getRequestContext(req) {
  return {
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
    headers: req.headers || {},
    authUserId: req.authUserId || ''
  };
}

function logDomainEvent(domain, actionName, req, result) {
  const statusCode = result?.statusCode || 200;
  if (statusCode < 400) return;

  const details = {
    ...logger.getRequestDetails(req),
    domain,
    action: actionName,
    statusCode,
    error: result?.body?.error || null
  };

  logger.failedRequest(req, details);

  if (domain === 'auth') {
    logger.authEvent(`${actionName}.failed`, details);
    return;
  }

  if (domain === 'appointments') {
    logger.appointmentEvent(`${actionName}.failed`, details);
    return;
  }

  if (domain === 'admin') {
    logger.adminAction(`${actionName}.failed`, details);
  }
}

function createControllerHandler(serviceHandler, actionName, domain = 'api') {
  return asyncHandler(async (req, res) => {
    try {
      const result = await serviceHandler(getRequestContext(req));
      logDomainEvent(domain, actionName, req, result);
      return apiResponse.fromServiceResult(res, result);
    } catch (error) {
      logger.failedRequest(req, {
        action: actionName,
        error: error.message || 'Unhandled controller error'
      });
      return apiResponse.serverError(res, 'Server error');
    }
  });
}

module.exports = {
  createControllerHandler,
  getRequestContext
};
