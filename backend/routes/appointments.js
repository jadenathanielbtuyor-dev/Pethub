const express = require('express');
const router = express.Router();
const { createAppointment, getUserAppointments, getAllAppointments, cancelOwnAppointment } = require('../controllers/appointmentsController');
const { listServices } = require('../controllers/serviceCatalogController');
const { createAppointmentGroup } = require('../controllers/groupBookingController');
const { requireAuth } = require('../middleware/requireAuth');
const { rateLimit, byAuthUser } = require('../middleware/rateLimit');

// Service names and availability are public clinic information used by the public Services page and signed-in flows.
router.get('/services', listServices);

router.use(requireAuth);

// Pending requests hold their time slot, so one account cannot script requests across the calendar
router.post('/create', rateLimit('booking', { keyFor: byAuthUser }), createAppointment);
// One booking for several of the owner's pets, saved completely or not at all (services/groupBookingService.js)
router.post('/group', rateLimit('booking', { keyFor: byAuthUser }), createAppointmentGroup);
router.get('/userAppointments', getUserAppointments);
router.post('/cancel/:id', cancelOwnAppointment);
router.get('/all', getAllAppointments);
// Appointment status changes are admin-only and live at PUT /admin/dashboard/appointment-status (routes/admin.js);
// the former PUT /appointments/updateStatus duplicate, which the frontend never called, was removed.

module.exports = router;
