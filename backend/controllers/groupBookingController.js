const groupBookingService = require('../services/groupBookingService');
const rescheduleService = require('../services/rescheduleService');
const { createControllerHandler } = require('../utils/controllerFactory');

module.exports = {
  createAppointmentGroup: createControllerHandler(groupBookingService.createAppointmentGroup, 'createAppointmentGroup', 'appointments'),
  cancelAppointmentGroup: createControllerHandler(groupBookingService.cancelAppointmentGroup, 'cancelAppointmentGroup', 'admin'),
  rescheduleAppointment: createControllerHandler(rescheduleService.rescheduleAppointment, 'rescheduleAppointment', 'admin')
};
