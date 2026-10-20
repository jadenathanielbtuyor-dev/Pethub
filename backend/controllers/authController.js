const authService = require('../services/authService');
const passwordResetService = require('../services/passwordResetService');
const { createControllerHandler } = require('../utils/controllerFactory');

const login = createControllerHandler(authService.login, 'login', 'auth');
const register = createControllerHandler(authService.register, 'register', 'auth');
const verifyEmail = createControllerHandler(authService.verifyEmail, 'verifyEmail', 'auth');
const resendVerificationCode = createControllerHandler(authService.resendVerificationCode, 'resendVerificationCode', 'auth');
const logout = createControllerHandler(authService.logout, 'logout', 'auth');
const getUserStatus = createControllerHandler(authService.getUserStatus, 'getUserStatus', 'auth');
const updateProfile = createControllerHandler(authService.updateProfile, 'updateProfile', 'auth');
const getActivityLogs = createControllerHandler(authService.getActivityLogs, 'getActivityLogs', 'auth');
const requestPasswordReset = createControllerHandler(passwordResetService.requestPasswordReset, 'requestPasswordReset', 'auth');
const resetPassword = createControllerHandler(passwordResetService.resetPassword, 'resetPassword', 'auth');

module.exports = {
  login,
  register,
  verifyEmail,
  resendVerificationCode,
  logout,
  getUserStatus,
  updateProfile,
  getActivityLogs,
  requestPasswordReset,
  resetPassword
};
