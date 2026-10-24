// Request limits for the endpoints that can be abused without an account (password guessing, code guessing, email and
// chatbot flooding), counted per client IP address in a fixed window (middleware/rateLimit.js). They are generous for a
// real customer and only stop scripted repetition. Signed-in profile updates and booking requests are counted per
// account instead.
// The counts live in the server's memory: they restart with the server and are not shared between server instances.

const RATE_LIMITS = Object.freeze({
  login: Object.freeze({ max: 20, windowMinutes: 15 }),
  register: Object.freeze({ max: 10, windowMinutes: 60 }),
  verifyEmail: Object.freeze({ max: 15, windowMinutes: 15 }),
  resendCode: Object.freeze({ max: 5, windowMinutes: 15 }),
  forgotPassword: Object.freeze({ max: 5, windowMinutes: 15 }),
  resetPassword: Object.freeze({ max: 10, windowMinutes: 15 }),
  profileUpdate: Object.freeze({ max: 20, windowMinutes: 15 }),
  booking: Object.freeze({ max: 20, windowMinutes: 15 }),
  contact: Object.freeze({ max: 5, windowMinutes: 60 }),
  aiChat: Object.freeze({ max: 20, windowMinutes: 5 })
});

module.exports = {
  RATE_LIMITS
};
