const express = require('express');
const router = express.Router();
const { submitContactRequest } = require('../controllers/contactController');
const { optionalAuth } = require('../middleware/requireAuth');
const { rateLimit } = require('../middleware/rateLimit');

router.post('/', rateLimit('contact'), optionalAuth, submitContactRequest);

module.exports = router;
