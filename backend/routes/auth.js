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

router.post('/login', login);
router.post('/register', register);
router.post('/verify-email', verifyEmail);
router.post('/resend-code', resendVerificationCode);
router.post('/logout', logout);
router.get('/user-status', getUserStatus);
router.get('/activity-logs', getActivityLogs);

module.exports = router;
