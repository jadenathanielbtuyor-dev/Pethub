const express = require('express');
const router = express.Router();
const {
  login,
  register,
  logout,
  verifyEmail,
  resendVerificationCode,
  getUserStatus,
  updateProfile,
  getActivityLogs,
  requestPasswordReset,
  resetPassword
} = require('../controllers/authController');
const { requireAuth } = require('../middleware/requireAuth');
const { rateLimit, byAuthUser } = require('../middleware/rateLimit');

router.post('/login', rateLimit('login'), login);
router.post('/register', rateLimit('register'), register);
router.post('/verify-email', rateLimit('verifyEmail'), verifyEmail);
router.post('/resend-code', rateLimit('resendCode'), resendVerificationCode);
router.post('/forgot-password', rateLimit('forgotPassword'), requestPasswordReset);
router.post('/reset-password', rateLimit('resetPassword'), resetPassword);
router.post('/logout', requireAuth, logout);
router.get('/user-status', requireAuth, getUserStatus);
router.put('/profile', requireAuth, rateLimit('profileUpdate', { keyFor: byAuthUser }), updateProfile);
router.get('/activity-logs', requireAuth, getActivityLogs);

module.exports = router;
