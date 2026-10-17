const paymentsService = require('../services/paymentsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const createCheckout = createControllerHandler(paymentsService.createCheckout, 'createCheckout', 'payments');
const getAppointmentPaymentStatus = createControllerHandler(paymentsService.getAppointmentPaymentStatus, 'getAppointmentPaymentStatus', 'payments');
// An unexpected error becomes a 500, which PayMongo treats as "retry later"
const handleWebhook = createControllerHandler(paymentsService.handleWebhook, 'handlePaymentWebhook', 'payments');

module.exports = {
  createCheckout,
  getAppointmentPaymentStatus,
  handleWebhook
};
