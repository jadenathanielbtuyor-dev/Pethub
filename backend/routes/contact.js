const express = require('express');
const router = express.Router();
const { submitContactRequest, listMyMessages, getClinicInfo } = require('../controllers/contactController');
const { requireAuth } = require('../middleware/requireAuth');
const { rateLimit, byAuthUser } = require('../middleware/rateLimit');

// The clinic's published phone, email, address and hours (public, shown on the Contact page)
router.get('/clinic-info', getClinicInfo);

// Sending a message requires a signed-in account: the sender is the token's account, never a name or email in the body
router.post('/', requireAuth, rateLimit('contact', { keyFor: byAuthUser }), submitContactRequest);
router.get('/mine', requireAuth, listMyMessages);

module.exports = router;
