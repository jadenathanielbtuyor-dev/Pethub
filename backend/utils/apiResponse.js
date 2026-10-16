function send(res, statusCode = 200, body = {}) {
  return res.status(statusCode).json(body);
}

function success(res, body = {}, statusCode = 200) {
  return send(res, statusCode, body);
}

function error(res, message = 'Internal Server Error', statusCode = 500, extra = {}) {
  return send(res, statusCode, {
    success: false,
    error: message,
    ...extra
  });
}

function validationError(res, message, extra = {}) {
  return error(res, message, 400, extra);
}

function serverError(res, message = 'Server error') {
  return error(res, message, 500);
}

function fromServiceResult(res, result = {}) {
  const statusCode = result.statusCode || 200;
  return send(res, statusCode, result.body);
}

function serviceResult(statusCode, body) {
  return { statusCode, body };
}

module.exports = {
  send,
  success,
  error,
  validationError,
  serverError,
  fromServiceResult,
  serviceResult
};
