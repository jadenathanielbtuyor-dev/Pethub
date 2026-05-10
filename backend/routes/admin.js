// ==================== ADMIN ROUTES ====================

const express = require('express');
const supabase = require('../config/supabase');
const adminController = require('../controllers/adminController');

const router = express.Router();

function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function isAdminVerified(userId) {
  if (!userId) return false;

  const { data: users, error } = await supabase
    .from('users')
    .select('role, is_verified')
    .eq('id', userId)
    .limit(1);

  if (error) {
    throw error;
  }

  if (!users || users.length === 0) return false;

  const user = users[0];
  if (String(user.role || '').toLowerCase() !== 'admin') return false;
  if (isVerifiedValue(user.is_verified)) return true;

  const { data: verifiedRows, error: verifiedError } = await supabase
    .from('email_verifications')
    .select('id')
    .eq('user_id', userId)
    .eq('is_verified', true)
    .limit(1);

  if (verifiedError) {
    throw verifiedError;
  }

  return Array.isArray(verifiedRows) && verifiedRows.length > 0;
}

async function validateAdminAccess(req, res, next) {
  const rawUserId = req.query.user_id || req.headers['x-user-id'];
  const userId = rawUserId ? String(rawUserId).trim() : '';
  if (!userId) {
    return res.status(400).json({ success: false, error: 'Admin user ID is required' });
  }

  try {
    const verified = await isAdminVerified(userId);
    if (!verified) {
      return res.status(403).json({ success: false, error: 'Admin access denied' });
    }
  } catch (error) {
    console.error('Admin access validation error:', error);
    return res.status(500).json({ success: false, error: 'Failed to validate admin access' });
  }

  next();
}

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
