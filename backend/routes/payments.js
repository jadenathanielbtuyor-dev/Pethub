const express = require('express');
const router = express.Router();
const { createCheckout, getAppointmentPaymentStatus } = require('../controllers/paymentsController');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);

router.post('/checkout', createCheckout);
router.get('/appointment/:appointmentId', getAppointmentPaymentStatus);

module.exports = router;
