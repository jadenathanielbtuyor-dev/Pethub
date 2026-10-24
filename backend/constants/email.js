const VERIFICATION_CODE_TTL_MINUTES = 10;
const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
const VERIFICATION_EMAIL_SUBJECT = 'PetHub Verification Code';
const PASSWORD_RESET_CODE_TTL_MINUTES = 10;
const PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = 60;
const PASSWORD_RESET_MAX_ATTEMPTS = 3;
const PASSWORD_RESET_EMAIL_SUBJECT = 'PetHub Password Reset Code';
const APPOINTMENT_APPROVED_EMAIL_SUBJECT = 'PetHub — Appointment Approved';
const APPOINTMENT_CANCELLED_EMAIL_SUBJECT = 'PetHub — Appointment Cancelled';
// The confirmation an owner receives after cancelling their own appointment
const APPOINTMENT_OWNER_CANCELLED_EMAIL_SUBJECT = 'Your PetHub Appointment Has Been Cancelled';
// The clinic's answer to a contact message
const CONTACT_REPLY_EMAIL_SUBJECT = 'PetHub — The clinic replied to your message';
// The signed-in Contact page, linked from emails that invite the customer to write to the clinic
const CONTACT_PAGE_PATH = '/pages/public/contact.html';
// My Appointments page on the frontend (FRONTEND_URL), linked from appointment emails
const APPOINTMENTS_PAGE_PATH = '/pages/user/appointments.html';

module.exports = {
  VERIFICATION_CODE_TTL_MINUTES,
  VERIFICATION_RESEND_COOLDOWN_SECONDS,
  VERIFICATION_EMAIL_SUBJECT,
  PASSWORD_RESET_CODE_TTL_MINUTES,
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_EMAIL_SUBJECT,
  APPOINTMENT_APPROVED_EMAIL_SUBJECT,
  APPOINTMENT_CANCELLED_EMAIL_SUBJECT,
  APPOINTMENT_OWNER_CANCELLED_EMAIL_SUBJECT,
  CONTACT_REPLY_EMAIL_SUBJECT,
  APPOINTMENTS_PAGE_PATH,
  CONTACT_PAGE_PATH
};
