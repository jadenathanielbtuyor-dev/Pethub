const adminService = require('../services/adminService');
const { createControllerHandler } = require('../utils/controllerFactory');

const getDashboardStats = createControllerHandler(adminService.getDashboardStats, 'getDashboardStats', 'admin');
const getDashboardOverview = createControllerHandler(adminService.getDashboardOverview, 'getDashboardOverview', 'admin');
const getAnalyticsSummary = createControllerHandler(adminService.getAnalyticsSummary, 'getAnalyticsSummary', 'admin');
const getAnalyticsPetTypes = createControllerHandler(adminService.getAnalyticsPetTypes, 'getAnalyticsPetTypes', 'admin');
const getAnalyticsServices = createControllerHandler(adminService.getAnalyticsServices, 'getAnalyticsServices', 'admin');
const getAnalyticsAppointmentsTrend = createControllerHandler(adminService.getAnalyticsAppointmentsTrend, 'getAnalyticsAppointmentsTrend', 'admin');
const getSystemLogs = createControllerHandler(adminService.getSystemLogs, 'getSystemLogs', 'admin');
const getContactMessages = createControllerHandler(adminService.getContactMessages, 'getContactMessages', 'admin');
const updateContactMessageStatus = createControllerHandler(adminService.updateContactMessageStatus, 'updateContactMessageStatus', 'admin');
const getAllUsers = createControllerHandler(adminService.getAllUsers, 'getAllUsers', 'admin');
const getAllPets = createControllerHandler(adminService.getAllPets, 'getAllPets', 'admin');
const getAllAppointments = createControllerHandler(adminService.getAllAppointments, 'getAllAppointments', 'admin');
const createMedicalRecord = createControllerHandler(adminService.createMedicalRecord, 'createMedicalRecord', 'admin');
const updateAppointmentStatus = createControllerHandler(adminService.updateAppointmentStatus, 'updateAppointmentStatus', 'admin');
const updateUserRole = createControllerHandler(adminService.updateUserRole, 'updateUserRole', 'admin');

module.exports = {
  getDashboardStats,
  getDashboardOverview,
  getAnalyticsSummary,
  getAnalyticsPetTypes,
  getAnalyticsServices,
  getAnalyticsAppointmentsTrend,
  getSystemLogs,
  getContactMessages,
  updateContactMessageStatus,
  getAllUsers,
  getAllPets,
  getAllAppointments,
  createMedicalRecord,
  updateAppointmentStatus,
  updateUserRole
};
