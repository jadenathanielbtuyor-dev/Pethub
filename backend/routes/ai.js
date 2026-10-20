const express = require('express');
const router = express.Router();
const { chat } = require('../controllers/aiController');
const { rateLimit } = require('../middleware/rateLimit');

router.post('/chat', rateLimit('aiChat'), chat);

module.exports = router;
