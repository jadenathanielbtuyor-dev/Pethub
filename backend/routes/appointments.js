const express = require('express');
const router = express.Router();
const { createAppointment, getUserAppointments, getAllAppointments, updateStatus, cancelOwnAppointment } = require('../controllers/appointmentsController');
const { listServices } = require('../controllers/serviceCatalogController');
const { requireAuth } = require('../middleware/requireAuth');

// Service names and availability are public clinic information used by the public Services page and signed-in flows.
router.get('/services', listServices);

router.use(requireAuth);

router.post('/create', createAppointment);
router.get('/userAppointments', getUserAppointments);
router.post('/cancel/:id', cancelOwnAppointment);
router.get('/all', getAllAppointments);
router.put('/updateStatus', updateStatus);

module.exports = router;
