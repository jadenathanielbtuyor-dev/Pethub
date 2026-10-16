const appointmentsService = require('../services/appointmentsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const createAppointment = createControllerHandler(appointmentsService.createAppointment, 'createAppointment', 'appointments');
const getUserAppointments = createControllerHandler(appointmentsService.getUserAppointments, 'getUserAppointments', 'appointments');
const getAllAppointments = createControllerHandler(appointmentsService.getAllAppointments, 'getAllAppointments', 'appointments');
const updateStatus = createControllerHandler(appointmentsService.updateStatus, 'updateStatus', 'appointments');

module.exports = {
  createAppointment,
  getUserAppointments,
  getAllAppointments,
  updateStatus
};
