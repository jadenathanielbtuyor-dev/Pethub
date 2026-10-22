// The services, their species and their durations are in constants/services.js

const INVALID_APPOINTMENT_DATE_MESSAGE = 'Enter a valid appointment date.';
const INVALID_APPOINTMENT_TIME_MESSAGE = 'Enter a valid appointment time.';
const PAST_APPOINTMENT_DATE_MESSAGE = 'Appointment date cannot be in the past.';
const PAST_APPOINTMENT_TIME_MESSAGE = 'Appointment time must be later than the current time when booking for today.';
const SCHEDULE_CONFLICT_MESSAGE = 'Selected time is unavailable.';
const APPOINTMENT_STATUS_CHANGED_MESSAGE = 'This appointment was just changed by someone else. Refresh the list and try again.';
const CLINIC_TIME_ZONE = 'Asia/Manila';
const APPOINTMENT_CANCELLATION_CUTOFF_HOURS = 2;
const APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE = 'Appointments can only be cancelled at least 2 hours before their scheduled start time. Please contact the clinic for help.';
const OCCUPIED_APPOINTMENT_STATUSES = new Set(['approved', 'completed']);
const VALID_APPOINTMENT_STATUSES = Object.freeze(['Pending', 'Approved', 'Completed', 'Cancelled']);

module.exports = {
  INVALID_APPOINTMENT_DATE_MESSAGE,
  INVALID_APPOINTMENT_TIME_MESSAGE,
  PAST_APPOINTMENT_DATE_MESSAGE,
  PAST_APPOINTMENT_TIME_MESSAGE,
  SCHEDULE_CONFLICT_MESSAGE,
  APPOINTMENT_STATUS_CHANGED_MESSAGE,
  CLINIC_TIME_ZONE,
  APPOINTMENT_CANCELLATION_CUTOFF_HOURS,
  APPOINTMENT_CANCELLATION_CUTOFF_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  VALID_APPOINTMENT_STATUSES
};
