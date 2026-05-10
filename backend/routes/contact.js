const express = require('express');
const router = express.Router();
const { submitContactRequest } = require('../controllers/contactController');

router.post('/', submitContactRequest);

module.exports = router;
