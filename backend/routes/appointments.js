const express = require('express');
const router = express.Router();
const { createAppointment, getUserAppointments, getAllAppointments, updateStatus } = require('../controllers/appointmentsController');

router.post('/create', createAppointment);
router.get('/userAppointments', getUserAppointments);
router.get('/all', getAllAppointments);
router.put('/updateStatus', updateStatus);

module.exports = router;
