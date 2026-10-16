const express = require('express');
const router = express.Router();
const {
  login,
  register,
  logout,
  verifyEmail,
  resendVerificationCode,
  getUserStatus,
  getActivityLogs
} = require('../controllers/authController');
const { requireAuth } = require('../middleware/requireAuth');

router.post('/login', login);
router.post('/register', register);
router.post('/verify-email', verifyEmail);
router.post('/resend-code', resendVerificationCode);
router.post('/logout', requireAuth, logout);
router.get('/user-status', requireAuth, getUserStatus);
router.get('/activity-logs', requireAuth, getActivityLogs);

module.exports = router;
