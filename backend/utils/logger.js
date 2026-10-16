function buildLogPayload(level, event, details = {}) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  };
}

function write(level, event, details = {}) {
  const payload = buildLogPayload(level, event, details);
  const message = `[${payload.timestamp}] ${level.toUpperCase()} ${event}`;

  if (level === 'error') {
    console.error(message, details);
    return;
  }

  if (level === 'warn') {
    console.warn(message, details);
    return;
  }

  console.log(message, details);
}

function getRequestDetails(req) {
  return {
    method: req?.method,
    path: req?.originalUrl || req?.url,
    user_id: req?.headers?.['x-user-id'] || req?.query?.user_id || req?.body?.user_id || req?.body?.userId || null
  };
}

function info(event, details = {}) {
  write('info', event, details);
}

function warn(event, details = {}) {
  write('warn', event, details);
}

function error(event, details = {}) {
  write('error', event, details);
}

function authEvent(action, details = {}) {
  info(`auth.${action}`, details);
}

function appointmentEvent(action, details = {}) {
  info(`appointment.${action}`, details);
}

function adminAction(action, details = {}) {
  info(`admin.${action}`, details);
}

function failedRequest(req, errorDetails = {}) {
  warn('request.failed', {
    ...getRequestDetails(req),
    ...errorDetails
  });
}

module.exports = {
  info,
  warn,
  error,
  authEvent,
  appointmentEvent,
  adminAction,
  failedRequest,
  getRequestDetails
};
