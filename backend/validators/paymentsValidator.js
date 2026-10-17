const { trimValue } = require('./commonValidator');

// Appointment ids are UUIDs; anything that is not id-shaped is rejected before it reaches a query
const APPOINTMENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function validateAppointmentIdValue(value) {
  const appointmentId = trimValue(value);
  if (!appointmentId) {
    return { error: { statusCode: 400, body: { error: 'appointment_id is required' } } };
  }

  if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
    return { error: { statusCode: 400, body: { error: 'Invalid appointment_id' } } };
  }

  return { appointmentId };
}

// POST /payments/checkout body: { appointment_id }. Any amount or status sent by the browser is ignored.
function validateCheckoutRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  return validateAppointmentIdValue(source.appointment_id);
}

// GET /payments/appointment/:appointmentId
function validatePaymentStatusRequest(params) {
  const source = params && typeof params === 'object' ? params : {};
  return validateAppointmentIdValue(source.appointmentId);
}

module.exports = {
  validateCheckoutRequest,
  validatePaymentStatusRequest
};
