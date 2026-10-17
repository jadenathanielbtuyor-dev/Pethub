const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/paymentsController');

// Mounted in server.js before express.json(): PayMongo signs the exact request bytes, so this route
// keeps the raw body as a Buffer. It has no PetHub login; the webhook signature is the authentication.
router.post('/webhook', express.raw({ type: () => true, limit: '256kb' }), handleWebhook);

module.exports = router;
