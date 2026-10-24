const express = require('express');
const router = express.Router();
const { createAppointment, getUserAppointments, getAllAppointments, updateStatus, cancelOwnAppointment } = require('../controllers/appointmentsController');
const { listServices } = require('../controllers/serviceCatalogController');
const { requireAuth } = require('../middleware/requireAuth');
const { rateLimit, byAuthUser } = require('../middleware/rateLimit');

// Service names and availability are public clinic information used by the public Services page and signed-in flows.
router.get('/services', listServices);

router.use(requireAuth);

// Pending requests hold their time slot, so one account cannot script requests across the calendar
router.post('/create', rateLimit('booking', { keyFor: byAuthUser }), createAppointment);
router.get('/userAppointments', getUserAppointments);
router.post('/cancel/:id', cancelOwnAppointment);
router.get('/all', getAllAppointments);
router.put('/updateStatus', updateStatus);

module.exports = router;
