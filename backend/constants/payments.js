// Appointment deposit rules (PayMongo Checkout, test mode only in this version).
// The amount is fixed here on the server; the browser never sends or chooses it.

const DEPOSIT_AMOUNT_PHP = 100;
const DEPOSIT_AMOUNT_CENTAVOS = DEPOSIT_AMOUNT_PHP * 100;
const DEPOSIT_CURRENCY = 'PHP';
const CHECKOUT_WINDOW_MINUTES = 30;

// Values stored in payments.payment_status
const PAYMENT_STATUSES = Object.freeze({
  PENDING: 'Pending',
  PAID: 'Paid',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
  REFUNDED: 'Refunded'
});

// Methods PetHub offers, in this order. Each checkout only requests the ones PayMongo reports as configured on the
// account (GET /v1/merchants/capabilities/payment_methods), so a method that is not activated yet is left out.
const CHECKOUT_PAYMENT_METHOD_TYPES = Object.freeze(['gcash', 'qrph', 'card']);
const PAYMENT_METHODS_CACHE_MS = 10 * 60 * 1000;
// After a failed capabilities lookup, the fallback list is reused for this long before PayMongo is asked again
const PAYMENT_METHODS_RETRY_MS = 60 * 1000;
const CHECKOUT_LINE_ITEM_NAME = 'Appointment deposit';
const CHECKOUT_DESCRIPTION = 'PetHub appointment deposit';
const CHECKOUT_RETURN_PATH = '/pages/user/appointments.html';

// Metadata keys PetHub writes on each checkout session (PayMongo stores metadata values as strings)
const CHECKOUT_METADATA_PAYMENT_ID = 'pethub_payment_id';
const CHECKOUT_METADATA_APPOINTMENT_ID = 'pethub_appointment_id';

const PAYMONGO_REQUEST_TIMEOUT_MS = 15 * 1000;
const PAYMENT_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const PAYMENT_EXPIRY_SWEEP_FIRST_RUN_MS = 30 * 1000;
const PAYMENT_EXPIRY_SWEEP_BATCH_SIZE = 20;
// A checkout URL is only returned after its session id is saved, so a Pending row still without one
// after this long never reached the customer and can be closed as Failed.
const UNLINKED_CHECKOUT_FAILURE_AFTER_MS = 2 * 60 * 1000;
// Status requests for the same payment ask PayMongo at most this often
const PROVIDER_RECHECK_INTERVAL_MS = 10 * 1000;
// A refund event for a payment PetHub has not linked yet is retried (non-2xx) for this long, then acknowledged
const UNMATCHED_REFUND_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
// A deposit confirmation email that could not be sent is retried by the expiry sweep for this long after payment
const RECEIPT_EMAIL_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECEIPT_EMAIL_RETRY_BATCH_SIZE = 10;

const PAYMENTS_UNAVAILABLE_MESSAGE = 'Online deposit payments are not available right now. Please try again later or contact the clinic.';
const DEPOSIT_BOOKING_UNAVAILABLE_MESSAGE = 'Bookings need a ₱100 deposit, and online payment is not available right now, so the booking was not made. Please try again later or contact the clinic.';
const DEPOSIT_STATUS_UNAVAILABLE_MESSAGE = 'The deposit status could not be checked. Please try again in a moment.';
const DEPOSIT_NOT_REQUIRED_MESSAGE = 'This appointment does not need a deposit.';
const DEPOSIT_ALREADY_PAID_MESSAGE = 'The deposit for this appointment is already paid.';
const DEPOSIT_APPOINTMENT_NOT_PENDING_MESSAGE = 'A deposit can only be paid while the appointment is pending.';
const DEPOSIT_APPOINTMENT_STARTED_MESSAGE = 'This appointment time has already passed.';
const DEPOSIT_SLOT_TAKEN_MESSAGE = 'This time slot is no longer available, so the deposit cannot be paid. Please book another time.';
const CHECKOUT_IN_PROGRESS_MESSAGE = 'A payment for this appointment is still being processed. Please check again in a few minutes.';
const CHECKOUT_BUSY_MESSAGE = 'A checkout for this appointment is already being prepared. Please try again in a moment.';
const PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE = 'The payment provider could not be reached. Please try again in a moment.';
const DEPOSIT_UNPAID_APPROVAL_MESSAGE = 'This appointment needs a paid ₱100 deposit before it can be approved.';
const DEPOSIT_REFUND_REQUIRED_MESSAGE = 'Its ₱100 deposit is already paid, so the deposit needs a refund: cancel the appointment, then refund the deposit in the PayMongo Dashboard.';

module.exports = {
  DEPOSIT_AMOUNT_PHP,
  DEPOSIT_AMOUNT_CENTAVOS,
  DEPOSIT_CURRENCY,
  CHECKOUT_WINDOW_MINUTES,
  PAYMENT_STATUSES,
  CHECKOUT_PAYMENT_METHOD_TYPES,
  PAYMENT_METHODS_CACHE_MS,
  PAYMENT_METHODS_RETRY_MS,
  CHECKOUT_LINE_ITEM_NAME,
  CHECKOUT_DESCRIPTION,
  CHECKOUT_RETURN_PATH,
  CHECKOUT_METADATA_PAYMENT_ID,
  CHECKOUT_METADATA_APPOINTMENT_ID,
  PAYMONGO_REQUEST_TIMEOUT_MS,
  PAYMENT_EXPIRY_SWEEP_INTERVAL_MS,
  PAYMENT_EXPIRY_SWEEP_FIRST_RUN_MS,
  PAYMENT_EXPIRY_SWEEP_BATCH_SIZE,
  UNLINKED_CHECKOUT_FAILURE_AFTER_MS,
  PROVIDER_RECHECK_INTERVAL_MS,
  UNMATCHED_REFUND_RETRY_WINDOW_MS,
  RECEIPT_EMAIL_RETRY_WINDOW_MS,
  RECEIPT_EMAIL_RETRY_BATCH_SIZE,
  PAYMENTS_UNAVAILABLE_MESSAGE,
  DEPOSIT_BOOKING_UNAVAILABLE_MESSAGE,
  DEPOSIT_STATUS_UNAVAILABLE_MESSAGE,
  DEPOSIT_NOT_REQUIRED_MESSAGE,
  DEPOSIT_ALREADY_PAID_MESSAGE,
  DEPOSIT_APPOINTMENT_NOT_PENDING_MESSAGE,
  DEPOSIT_APPOINTMENT_STARTED_MESSAGE,
  DEPOSIT_SLOT_TAKEN_MESSAGE,
  CHECKOUT_IN_PROGRESS_MESSAGE,
  CHECKOUT_BUSY_MESSAGE,
  PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE,
  DEPOSIT_UNPAID_APPROVAL_MESSAGE,
  DEPOSIT_REFUND_REQUIRED_MESSAGE
};
