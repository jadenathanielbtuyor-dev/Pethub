const SERVICE_DURATIONS_MINUTES = Object.freeze({
  Checkup: 45,
  Vaccination: 30,
  Grooming: 240,
  'Dental Cleaning': 60,
  Surgery: 180,
  Other: 30
});

const INVALID_APPOINTMENT_DATE_MESSAGE = 'Enter a valid appointment date.';
const INVALID_APPOINTMENT_TIME_MESSAGE = 'Enter a valid appointment time.';
const PAST_APPOINTMENT_DATE_MESSAGE = 'Appointment date cannot be in the past.';
const PAST_APPOINTMENT_TIME_MESSAGE = 'Appointment time must be later than the current time when booking for today.';
const SCHEDULE_CONFLICT_MESSAGE = 'Selected time is unavailable.';
const APPOINTMENT_STATUS_CHANGED_MESSAGE = 'This appointment was just changed by someone else. Refresh the list and try again.';
const OCCUPIED_APPOINTMENT_STATUSES = new Set(['approved', 'completed']);
const VALID_APPOINTMENT_STATUSES = Object.freeze(['Pending', 'Approved', 'Completed', 'Cancelled']);

module.exports = {
  SERVICE_DURATIONS_MINUTES,
  INVALID_APPOINTMENT_DATE_MESSAGE,
  INVALID_APPOINTMENT_TIME_MESSAGE,
  PAST_APPOINTMENT_DATE_MESSAGE,
  PAST_APPOINTMENT_TIME_MESSAGE,
  SCHEDULE_CONFLICT_MESSAGE,
  APPOINTMENT_STATUS_CHANGED_MESSAGE,
  OCCUPIED_APPOINTMENT_STATUSES,
  VALID_APPOINTMENT_STATUSES
};
