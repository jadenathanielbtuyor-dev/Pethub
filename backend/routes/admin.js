// ==================== ADMIN ROUTES ====================

const express = require('express');
const adminController = require('../controllers/adminController');
const { isAdminVerified } = require('../utils/accountVerification');
const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

const validateAdminAccess = asyncHandler(async (req, res, next) => {
  const rawUserId = req.query.user_id || req.headers['x-user-id'];
  const userId = rawUserId ? String(rawUserId).trim() : '';
  if (!userId) {
    logger.adminAction('access.missing_user_id', logger.getRequestDetails(req));
    return apiResponse.error(res, 'Admin user ID is required', 400);
  }

  try {
    const verified = await isAdminVerified(userId);
    if (!verified) {
      logger.adminAction('access.denied', {
        ...logger.getRequestDetails(req),
        user_id: userId
      });
      return apiResponse.error(res, 'Admin access denied', 403);
    }
  } catch (error) {
    logger.error('admin.access.validation_error', {
      ...logger.getRequestDetails(req),
      error: error.message || 'Failed to validate admin access'
    });
    return apiResponse.error(res, 'Failed to validate admin access', 500);
  }

  next();
});

router.use(validateAdminAccess);

/**
 * GET /admin/dashboard/stats
 * Get dashboard statistics (total users, pets, appointments, pending)
 */
router.get('/dashboard/stats', adminController.getDashboardStats);

/**
 * GET /admin/dashboard/users
 * Get all users
 */
router.get('/dashboard/users', adminController.getAllUsers);

/**
 * GET /admin/dashboard/pets
 * Get all pets
 */
router.get('/dashboard/pets', adminController.getAllPets);

/**
 * GET /admin/dashboard/appointments
 * Get all appointments
 */
router.get('/dashboard/appointments', adminController.getAllAppointments);

/**
 * GET /admin/dashboard/contact-messages
 * Get all contact form messages
 */
router.get('/dashboard/contact-messages', adminController.getContactMessages);

/**
 * PUT /admin/dashboard/contact-message-status
 * Update contact message status
 * Body: { id, status }
 */
router.put('/dashboard/contact-message-status', adminController.updateContactMessageStatus);

/**
 * PUT /admin/dashboard/appointment-status
 * Update appointment status
 * Body: { id, status }
 */
router.put('/dashboard/appointment-status', adminController.updateAppointmentStatus);

/**
 * POST /admin/dashboard/medical-records/create
 * Create an official medical record for a selected pet
 * Body: { pet_id, record_date, user_id, created_by?, appointment_id?, weight?, vaccination_status?, treatment?, medical_notes? }
 */
router.post('/dashboard/medical-records/create', adminController.createMedicalRecord);

/**
 * PUT /admin/dashboard/user-role
 * Update a user's role
 * Body: { id, role }
 */
router.put('/dashboard/user-role', adminController.updateUserRole);

/**
 * GET /admin/dashboard/overview
 * Get full dashboard overview in a single request
 */
router.get('/dashboard/overview', adminController.getDashboardOverview);

/**
 * GET /admin/analytics/summary
 * Get analytics summary values for dashboard cards
 */
router.get('/analytics/summary', adminController.getAnalyticsSummary);

/**
 * GET /admin/analytics/pet-types
 * Get pet type distribution for charts
 */
router.get('/analytics/pet-types', adminController.getAnalyticsPetTypes);

/**
 * GET /admin/analytics/services
 * Get service usage totals for charts
 */
router.get('/analytics/services', adminController.getAnalyticsServices);

/**
 * GET /admin/analytics/appointments-trend
 * Get a recent appointment trend for charts
 */
router.get('/analytics/appointments-trend', adminController.getAnalyticsAppointmentsTrend);
router.get('/system-logs', adminController.getSystemLogs);

module.exports = router;
