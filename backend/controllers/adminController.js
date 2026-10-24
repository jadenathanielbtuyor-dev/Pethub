const adminService = require('../services/adminService');
const contactService = require('../services/contactService');
const clinicSettingsService = require('../services/clinicSettingsService');
const emailRetryService = require('../services/emailRetryService');
const { createControllerHandler } = require('../utils/controllerFactory');

const getDashboardStats = createControllerHandler(adminService.getDashboardStats, 'getDashboardStats', 'admin');
const getDashboardOverview = createControllerHandler(adminService.getDashboardOverview, 'getDashboardOverview', 'admin');
const getAnalyticsSummary = createControllerHandler(adminService.getAnalyticsSummary, 'getAnalyticsSummary', 'admin');
const getAnalyticsPetTypes = createControllerHandler(adminService.getAnalyticsPetTypes, 'getAnalyticsPetTypes', 'admin');
const getAnalyticsServices = createControllerHandler(adminService.getAnalyticsServices, 'getAnalyticsServices', 'admin');
const getAnalyticsAppointmentsTrend = createControllerHandler(adminService.getAnalyticsAppointmentsTrend, 'getAnalyticsAppointmentsTrend', 'admin');
const getSystemLogs = createControllerHandler(adminService.getSystemLogs, 'getSystemLogs', 'admin');
const getContactMessages = createControllerHandler(contactService.getContactMessages, 'getContactMessages', 'admin');
const updateContactMessageStatus = createControllerHandler(contactService.updateContactMessageStatus, 'updateContactMessageStatus', 'admin');
const replyToContactMessage = createControllerHandler(contactService.replyToContactMessage, 'replyToContactMessage', 'admin');
const getClinicSettings = createControllerHandler(clinicSettingsService.getAdminClinicSettings, 'getClinicSettings', 'admin');
const updateClinicSettings = createControllerHandler(clinicSettingsService.updateClinicSettings, 'updateClinicSettings', 'admin');
const retryEmail = createControllerHandler(emailRetryService.retryEmail, 'retryEmail', 'admin');
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
  replyToContactMessage,
  getClinicSettings,
  updateClinicSettings,
  retryEmail,
  getAllUsers,
  getAllPets,
  getAllAppointments,
  createMedicalRecord,
  updateAppointmentStatus,
  updateUserRole
};
