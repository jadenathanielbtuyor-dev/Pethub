const appointmentsService = require('../services/appointmentsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const listServices = createControllerHandler(appointmentsService.listServices, 'listServices', 'appointments');
const createAppointment = createControllerHandler(appointmentsService.createAppointment, 'createAppointment', 'appointments');
const getUserAppointments = createControllerHandler(appointmentsService.getUserAppointments, 'getUserAppointments', 'appointments');
const getAllAppointments = createControllerHandler(appointmentsService.getAllAppointments, 'getAllAppointments', 'appointments');
const cancelOwnAppointment = createControllerHandler(appointmentsService.cancelOwnAppointment, 'cancelOwnAppointment', 'appointments');

module.exports = {
  listServices,
  createAppointment,
  getUserAppointments,
  getAllAppointments,
  cancelOwnAppointment
};
