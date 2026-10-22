const express = require('express');
const router = express.Router();
const { listServices, createAppointment, getUserAppointments, getAllAppointments, updateStatus, cancelOwnAppointment } = require('../controllers/appointmentsController');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);

router.get('/services', listServices);
router.post('/create', createAppointment);
router.get('/userAppointments', getUserAppointments);
router.post('/cancel/:id', cancelOwnAppointment);
router.get('/all', getAllAppointments);
router.put('/updateStatus', updateStatus);

module.exports = router;
