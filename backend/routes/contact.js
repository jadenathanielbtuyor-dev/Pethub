const express = require('express');
const router = express.Router();
const { submitContactRequest } = require('../controllers/contactController');
const { optionalAuth } = require('../middleware/requireAuth');

router.post('/', optionalAuth, submitContactRequest);

module.exports = router;
